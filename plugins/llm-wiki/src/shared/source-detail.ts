/**
 * Shapes returned when the panel inspects one source's indexed chunks and vectors.
 *
 * Both the host service and the browser half agree on these, so they live in `shared/` rather than
 * in either surface: the service builds them from the in-memory chunk/vector mirrors, the client
 * renders them. The preview and sample keep the payload small — a full page can hold hundreds of
 * chunks, and the browser only needs a taste of each.
 */

/** One indexed chunk of one source, as surfaced for inspection. */
export interface ChunkDetail {
  /** Stable id, derived from the file hash and the chunk ordinal. */
  readonly uid: string
  /** 0-based position of the chunk within its source. */
  readonly chunkIndex: number
  /** Characters of the chunk's content. */
  readonly contentLength: number
  /** First part of the content, for an at-a-glance read. */
  readonly preview: string
  /** Hash the chunk was built from. */
  readonly fileHash: string
  /** Whether a vector was embedded for this chunk (false when no model is loaded). */
  readonly hasVector: boolean
}

/** One embedding vector of a chunk, as surfaced for inspection. */
export interface VectorDetail {
  /** Chunk this vector belongs to. */
  readonly uid: string
  /** Vector width. */
  readonly dim: number
  /** L2 norm, the scale `cosineDistance` works against. */
  readonly magnitude: number
  /** First few components, enough to eyeball a vector. */
  readonly sample: readonly number[]
}

/** Chunks and vectors indexed under one source key. */
export interface SourceDetail {
  /** The source key the chunks are stored under. */
  readonly source: string
  readonly chunks: readonly ChunkDetail[]
  readonly vectors: readonly VectorDetail[]
}
