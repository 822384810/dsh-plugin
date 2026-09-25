/**
 * Optional `raw/` directory watching.
 *
 * Watching needs `chokidar`, which is optional: without it the library still ingests on
 * upload, on `/wiki-reindex` and on an explicit re-ingest, it simply does not notice files
 * dropped in behind its back.
 */
import { importOptional } from '../shared/optional.ts'

/**
 * Watch a directory and report added or changed files.
 * @param rawDir - Absolute directory to watch.
 * @param onFile - Called with the absolute path of each new or changed file.
 * @returns A stop function; a no-op when `chokidar` is unavailable.
 */
export async function startWatcher(rawDir: string, onFile: (path: string) => void): Promise<() => void> {
  const chokidar = await importOptional<typeof import('chokidar')>('chokidar')
  if (chokidar === null) return () => {}
  const watcher = chokidar.watch(rawDir, {
    ignored: /(^|[\\/])\../,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
  })
  watcher.on('add', onFile)
  watcher.on('change', onFile)
  return () => {
    void watcher.close()
  }
}
