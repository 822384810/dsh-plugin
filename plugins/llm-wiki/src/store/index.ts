/**
 * Backend selection.
 *
 * SQLite is preferred; the JSON document is a fallback, not an error path — a library opened
 * on a host without `node:sqlite` still ingests, searches and compiles.
 */
import type { ChunkBackend } from './backend.ts'
import { JsonBackend } from './json.ts'
import { SqliteBackend, loadSqlite } from './sqlite.ts'

/**
 * Open the chunk store for one library.
 * @param indexPath - Absolute path without extension; the extension is chosen per backend.
 * @returns The opened backend.
 */
export function openStore(indexPath: string): ChunkBackend {
  const ctor = loadSqlite()
  if (ctor !== null) {
    try {
      return new SqliteBackend(`${indexPath}.sqlite`, ctor)
    } catch {
      // A locked or unwritable SQLite file must not make the library unusable.
    }
  }
  return new JsonBackend(`${indexPath}.json`)
}
