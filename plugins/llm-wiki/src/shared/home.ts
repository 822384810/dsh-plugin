/**
 * DeepSeek Harness home paths.
 *
 * This mirrors `@deepseek-ai/dsh-home-paths` instead of importing it. That package is a peer
 * resolved at run time, and when the plugin is developed through a `link:` symlink Node resolves
 * peers against the linked source tree rather than the profile; a miss there throws at module
 * load and silently drops the whole host half (tools, commands, and the `/wiki` RPC channel all
 * disappear). The helper is a few pure lines over `node:path`, so inlining it removes a fragile
 * runtime peer without changing behaviour.
 * @module llm-wiki/shared/home
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment variable that overrides the default Harness home. */
const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name for the default Harness home under the OS home. */
const DSH_HOME_DIR_NAME = '.dsh'

/** Expand supported tilde prefixes against the operating-system home. */
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the single-root Harness home.
 *
 * Precedence matches the harness: `$DSH_HOME` when it is set and non-blank, otherwise `~/.dsh`.
 * A blank override is treated as unset so it never resolves the home to the working directory.
 * @param env - Environment mapping read for `$DSH_HOME`.
 * @returns The normalized absolute Harness home.
 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0
    ? fromEnv
    : join(homedir(), DSH_HOME_DIR_NAME)
  return resolve(expandHomePath(selected))
}

/**
 * Join path segments onto the resolved Harness home.
 * @param segments - Segments appended to the Harness home; none returns the home itself.
 * @returns The normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}
