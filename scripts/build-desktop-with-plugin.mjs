#!/usr/bin/env node
/**
 * Build the Electron Desktop with an out-of-tree DSH plugin embedded into its runtime.
 *
 * The Desktop activates only the bundles its installer ships, and that list is a code
 * constant in the harness, so embedding a plugin needs a source change in the harness
 * checkout. This script keeps that change out of the harness repository: it applies
 * `patches/desktop-embed-plugin.patch`, runs the packaging command, then reverts the
 * patch — also when the build fails or is interrupted.
 *
 * Prerequisites:
 *   - the plugin is published to the registry the harness resolves (the patch pins a
 *     semver range in `DESKTOP_EMBEDDED_BUNDLES`);
 *   - the harness checkout is clean and its desktop toolchain is set up.
 *
 * Regenerating the patch after changing which plugin/version to embed:
 *   1. make the same two-file edit in the harness checkout
 *      (`apps/desktop/src/core-package-set.ts`, `apps/desktop/src/project-manager.ts`);
 *   2. from the harness checkout run
 *      `git diff --output=<dsh-plugin>/patches/desktop-embed-plugin.patch -- apps/desktop/src/core-package-set.ts apps/desktop/src/project-manager.ts`;
 *   3. `git checkout -- apps/desktop/src/core-package-set.ts apps/desktop/src/project-manager.ts`.
 *
 * Usage: node scripts/build-desktop-with-plugin.mjs [options] [-- <extra pnpm args>]
 *
 * Options:
 *   --harness <dir>   Harness checkout to patch (default: ../deepseek-harness, or $DSH_HARNESS_ROOT)
 *   --patch <file>    Patch to apply (default: ../patches/desktop-embed-plugin.patch)
 *   --script <name>   Desktop package script to run (default: package:win:x64:unsigned)
 *   --filter <name>   Workspace package to run it in (default: @deepseek-ai/dsh-desktop)
 *   --dry-run         Apply, verify, revert, and exit without building
 *   --keep            Leave the patch applied afterwards; debugging only
 *   --help            Show this message
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(SCRIPT_DIR, '..')

const HELP = `Build the Electron Desktop with an out-of-tree DSH plugin embedded.

Usage: node scripts/build-desktop-with-plugin.mjs [options] [-- <extra pnpm args>]

Options:
  --harness <dir>   Harness checkout to patch (default: ../deepseek-harness, or $DSH_HARNESS_ROOT)
  --patch <file>    Patch to apply (default: ../patches/desktop-embed-plugin.patch)
  --script <name>   Desktop package script to run (default: package:desktop:win:x64:unsigned)
  --filter <name>   Workspace package to run it in (default: @deepseek-ai/dsh-desktop)
  --dry-run         Apply, verify, revert, and exit without building
  --keep            Leave the patch applied afterwards; debugging only
  --help, -h        Show this message
`

/**
 * Parse the documented command line.
 * @param {readonly string[]} argv - Arguments after the script entry point.
 * @returns {{harness?: string, patch?: string, script?: string, filter?: string,
 *   dryRun: boolean, keep: boolean, help: boolean, passthrough: string[]}}
 */
function parseArguments(argv) {
  const options = { dryRun: false, keep: false, help: false, passthrough: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') {
      options.passthrough = argv.slice(index + 1)
      break
    }
    if (argument === '--keep') { options.keep = true; continue }
    if (argument === '--dry-run') { options.dryRun = true; continue }
    if (argument === '--help' || argument === '-h') { options.help = true; continue }
    const match = /^--(harness|patch|script|filter)(?:=(.*))?$/u.exec(argument)
    if (match === null) throw new Error(`unknown argument ${argument}; try --help`)
    const inline = match[2]
    const value = inline ?? argv[index + 1]
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw new Error(`--${match[1]} requires a value`)
    }
    if (inline === undefined) index += 1
    options[match[1]] = value
  }
  return options
}

/**
 * Run git in the harness checkout.
 * @param {string} harness - Harness repository path.
 * @param {readonly string[]} args - Git arguments.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function git(harness, args) {
  const result = spawnSync('git', args, { cwd: harness, encoding: 'utf8' })
  if (result.error !== undefined && result.error !== null) throw result.error
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Read the repository-relative paths a unified diff writes.
 * @param {string} body - Patch text.
 * @returns {string[]} Sorted unique `a/`-relative paths.
 */
function patchedPaths(body) {
  const paths = new Set()
  for (const line of body.split('\n')) {
    const match = /^\+\+\+ b\/(.+)$/u.exec(line)
    if (match !== null) paths.add(match[1])
  }
  if (paths.size === 0) throw new Error('patch names no target files')
  return [...paths].sort()
}

/**
 * Apply the patch, run the desktop build, and always restore the harness afterwards.
 * @returns {Promise<number>} Process exit code.
 */
async function embed() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  const harness = resolve(options.harness ?? process.env.DSH_HARNESS_ROOT ?? resolve(PLUGIN_ROOT, '..', 'deepseek-harness'))
  const patch = resolve(options.patch ?? join(PLUGIN_ROOT, 'patches', 'desktop-embed-plugin.patch'))
  const script = options.script ?? 'package:win:x64:unsigned'
  const filter = options.filter ?? '@deepseek-ai/dsh-desktop'

  if (!existsSync(join(harness, '.git'))) throw new Error(`not a git checkout: ${harness}`)
  if (!existsSync(patch)) throw new Error(`missing patch: ${patch}`)
  const body = readFileSync(patch, 'utf8')
  const paths = patchedPaths(body)

  // Never discard work: the patch owns these files, so they must be committed and clean.
  const dirty = git(harness, ['status', '--porcelain', '--', ...paths])
  if (dirty.status !== 0) throw new Error(`git status failed: ${dirty.stderr.trim()}`)
  if (dirty.stdout.trim() !== '') {
    throw new Error(`refusing to patch; commit or stash these files first:\n${dirty.stdout.trim()}`)
  }
  const check = git(harness, ['apply', '--check', patch])
  if (check.status !== 0) {
    throw new Error(`patch does not apply to ${harness}; regenerate it after harness changes:\n${check.stderr.trim()}`)
  }

  const applied = git(harness, ['apply', patch])
  if (applied.status !== 0) throw new Error(`failed to apply patch:\n${applied.stderr.trim()}`)
  console.log(`[embed] applied ${patch}`)

  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    const reverse = git(harness, ['apply', '--reverse', patch])
    if (reverse.status !== 0) {
      console.warn(`[embed] reverse apply failed, restoring from HEAD: ${reverse.stderr.trim()}`)
      git(harness, ['checkout', '--', ...paths])
    }
    const after = git(harness, ['status', '--porcelain', '--', ...paths])
    if (after.stdout.trim() !== '') console.warn(`[embed] WARNING: harness still modified:\n${after.stdout.trim()}`)
    else console.log('[embed] harness restored to HEAD')
  }

  if (options.dryRun) {
    restore()
    console.log('[embed] --dry-run: patch validated and reverted, nothing was built')
    return 0
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      restore()
      process.exit(130)
    })
  }

  const args = ['--filter', filter, 'run', script, ...options.passthrough]
  console.log(`[embed] pnpm ${args.join(' ')}\n[embed] cwd ${harness}`)
  const exitCode = await new Promise((resolvePromise) => {
    const child = spawn('pnpm', args, {
      cwd: harness,
      stdio: 'inherit',
      // Windows resolves the pnpm shim through the shell.
      shell: process.platform === 'win32',
    })
    child.once('error', (error) => {
      console.error(`[embed] failed to start pnpm: ${error.message}`)
      resolvePromise(1)
    })
    child.once('exit', (code) => resolvePromise(code ?? 1))
  })

  if (options.keep) console.log('[embed] --keep: the patch is still applied')
  else restore()
  return exitCode
}

embed()
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    console.error(`[embed] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
