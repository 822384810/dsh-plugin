/**
 * Result of uploading one file to `raw/`.
 *
 * The outcome is decided by comparing content hashes, never by name alone:
 *  - `created`   — the file did not exist and was written.
 *  - `duplicate` — a file with the same name already existed and had identical bytes, so nothing changed.
 *  - `renamed`   — a file with the same name existed but different bytes; the new upload was stored
 *                  under `renamedTo` so both versions survive.
 */
export interface UploadResult {
  /** What happened. */
  readonly status: 'created' | 'duplicate' | 'renamed'
  /** The path the upload resolves to (the existing one for `duplicate`, the new one for `renamed`). */
  readonly rel: string
  /** For `renamed`: the new free path the content was actually stored under. */
  readonly renamedTo: string | null
}
