/**
 * Shared build for the plugins in this workspace.
 *
 *   src/index.ts         → lib/index.js   (Host half, ESM, Node) — always
 *   src/client/index.tsx → lib/client.js  (browser half) — only when the manifest declares dsh.client
 *
 * Harness-provided packages stay external on purpose: bundling them would give the process a
 * second Cordis instance, since the profile resolves them to the running dsh.
 *
 * The package manifest is the single source of truth for the supported host floor: the
 * `@deepseek-ai/dsh` peer must be an open-ended `>=` range (a pinned or upper-bounded
 * range would force a plugin release for every host bump), and its floor is compiled into the
 * build as `__MINIMUM_HOST_VERSION__`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/** Peer that carries the supported host floor. */
const HOST_PEER = '@deepseek-ai/dsh'

/** Packages the browser module table owns; bundling them breaks shared identity. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * Build one plugin package's faces.
 * @param options - Plugin root directory, defaulting to the working directory.
 * @returns The build paths written.
 */
export async function buildPlugin({ root = process.cwd() } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const packageName = manifest.name
  if (typeof packageName !== 'string' || packageName === '') {
    throw new Error(`${root}/package.json must declare a name`)
  }

  const hostPeer = manifest.peerDependencies?.[HOST_PEER]
  const minimumHostVersion = typeof hostPeer === 'string' && hostPeer.startsWith('>=')
    ? hostPeer.slice(2).trim()
    : undefined
  if (minimumHostVersion === undefined || minimumHostVersion === '') {
    throw new Error(
      `${packageName}: package.json peer "${HOST_PEER}" must be an open-ended floor such as `
      + `">=0.1.7-rc.1", got ${JSON.stringify(hostPeer)}`,
    )
  }

  /** Compiled into both faces so the manifest stays the single source of truth. */
  const define = { __MINIMUM_HOST_VERSION__: JSON.stringify(minimumHostVersion) }
  const written = [join(root, 'lib', 'index.js')]

  await build({
    entryPoints: [join(root, 'src', 'index.ts')],
    outfile: written[0],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    sourcemap: false,
    logLevel: 'warning',
    external: ['@deepseek-ai/*'],
    define,
  })

  if (manifest.dsh?.client !== undefined) {
    const clientOut = join(root, 'lib', 'client.js')
    await build({
      entryPoints: [join(root, 'src', 'client', 'index.tsx')],
      outfile: clientOut,
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      sourcemap: false,
      logLevel: 'warning',
      external: CLIENT_EXTERNALS,
      define,
      // The loader's lazy-CJS registration wrapper; the id must match the package name.
      banner: {
        js: [
          `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {`,
          'var module = { exports: {} }; var exports = module.exports;',
        ].join('\n'),
      },
      footer: { js: 'return module.exports; } });' },
    })
    written.push(clientOut)
  }

  return { packageName, minimumHostVersion, written }
}

const invoked = process.argv[1]
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  // `pnpm run build` spawns the script with the package directory as its working directory.
  const result = await buildPlugin()
  console.log(`built ${result.packageName} (host floor >=${result.minimumHostVersion}): ${result.written.join(', ')}`)
}
