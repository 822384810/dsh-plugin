/**
 * The chunk store contract.
 *
 * One implementation per storage technology; the rest of the plugin only ever sees this
 * interface, so a library keeps working when the platform cannot provide SQLite.
 */

/** One indexed chunk of one source file. */
export interface StoredChunk {
  /** Stable id, derived from the file hash and the chunk ordinal. */
  readonly uid: string
  readonly content: string
  /** POSIX path relative to the library root. */
  readonly sourcePath: string
  readonly chunkIndex: number
  readonly fileHash: string
}

/** One lexical hit; higher scores rank better. */
export interface LexicalHit {
  readonly uid: string
  readonly score: number
}

/** Everything loaded at open time: the chunks plus their optional vectors. */
export interface Snapshot {
  readonly chunks: readonly StoredChunk[]
  readonly vectors: ReadonlyMap<string, Float32Array>
}

/** Storage for chunks and vectors, scoped to one library. */
export interface ChunkBackend {
  /** Human-readable backend name, surfaced in `stats`. */
  readonly name: string
  /** Read the whole store; vectors are held in memory for the lifetime of the library. */
  load(): Snapshot
  /** Drop every chunk of one source and write the supplied ones in their place. */
  replaceSource(sourcePath: string, chunks: readonly StoredChunk[], vectors: ReadonlyMap<string, Float32Array>): void
  /** Drop every chunk of one source. */
  deleteSource(sourcePath: string): number
  /** Drop everything. */
  clear(): void
  /** Rank chunks by lexical relevance. */
  lexical(query: string, limit: number): LexicalHit[]
  close(): void
}
