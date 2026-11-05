/**
 * Hybrid retrieval: reciprocal-rank fusion over a lexical index and, when an embedding model
 * is available, a vector index.
 *
 * Fusion rather than a weighted sum keeps the two rankings comparable — their scores live on
 * unrelated scales — and keeps either half useful on its own when the other is unavailable.
 *
 * Large libraries no longer pay for an exact cosine distance against every stored vector: a
 * cheap sum sketch shortlists candidates (always including the lexical hits), and exact cosine
 * then runs only on that shortlist. Libraries below `MIN_EXACT_SCAN` stay exact.
 */
import type { StoredChunk } from '../store/backend.ts'
import { cosineDistance } from './chunk.ts'

/** One hit, with both rankings' contributions preserved for display. */
export interface SearchHit {
  readonly uid: string
  readonly content: string
  readonly sourcePath: string
  /** 0 = identical, 1 = unrelated; only meaningful when a vector was used. */
  readonly vectorDistance: number
  readonly lexicalScore: number
  /** Fused RRF rank score; higher is better. Used for ranking, NOT a 0~1 relevance. */
  readonly score: number
  /** Cosine similarity (0~1) when a vector contributed to the hit; null for lexical-only retrieval. */
  readonly cosine: number | null
}

/** Ranking inputs: the in-memory chunk mirror plus the vectors. */
export interface SearchIndex {
  readonly chunks: ReadonlyMap<string, StoredChunk>
  readonly vectors: ReadonlyMap<string, Float32Array>
}

/** Ranking weight for a result at `position` (0-based). */
const RRF_K = 60

/** Number of buckets in the cheap sum sketch used to shortlist vectors. */
const SKETCH_DIM = 64

/** Shortlist is this many times wider than the vector recall width. */
const SHORTLIST_FACTOR = 16

/** Libraries no larger than this are scanned exactly; approximation only pays off at scale. */
const MIN_EXACT_SCAN = 512

/** Sketches per vector object; replacing a vector invalidates its cached sketch. */
const sketchCache = new WeakMap<Float32Array, Float32Array>()

/**
 * Sum each contiguous bucket of dimensions into one sketch coordinate.
 *
 * Unlike a random projection this costs a single pass over the vector (the same work as one exact
 * cosine), so building sketches for a large library stays cheap. It is only an unbiased coarse
 * ranking: the shortlist is always re-ranked with exact cosine afterwards.
 * @param vector - The source embedding.
 * @returns Its `SKETCH_DIM`-dimensional sketch.
 */
function sketchOf(vector: Float32Array): Float32Array {
  const cached = sketchCache.get(vector)
  if (cached !== undefined) return cached
  const out = new Float32Array(SKETCH_DIM)
  const bucket = Math.max(1, Math.ceil(vector.length / SKETCH_DIM))
  for (let index = 0; index < vector.length; index++) {
    const slot = Math.min(Math.floor(index / bucket), SKETCH_DIM - 1)
    out[slot] = (out[slot] ?? 0) + (vector[index] ?? 0)
  }
  sketchCache.set(vector, out)
  return out
}

/** A candidate kept by the coarse pass. */
interface SketchHit {
  readonly uid: string
  readonly vector: Float32Array
  readonly score: number
}

/**
 * Keep the `size` best vectors by sketch similarity, using a min-heap so the scan stays
 * `O(N log size)` instead of allocating and sorting N objects. Lexical hits are boosted so the
 * exact pass always sees the `FTS candidates ∪ nearest vectors` set.
 * @param index - Chunk mirror and vectors.
 * @param lexicalUids - Uids already returned by the lexical index.
 * @param queryVec - Query embedding.
 * @param size - Shortlist size.
 * @returns The shortlisted vectors, in no particular order.
 */
function shortlistVectors(
  index: SearchIndex,
  lexicalUids: ReadonlySet<string>,
  queryVec: Float32Array,
  size: number,
): SketchHit[] {
  const querySketch = sketchOf(queryVec)
  let queryNorm = 0
  for (const value of querySketch) queryNorm += value * value
  queryNorm = Math.sqrt(queryNorm) || 1
  const heap: SketchHit[] = []
  const swap = (left: number, right: number): void => {
    const a = heap[left]
    const b = heap[right]
    if (a === undefined || b === undefined) return
    heap[left] = b
    heap[right] = a
  }
  const siftUp = (from: number): void => {
    let position = from
    while (position > 0) {
      const parent = (position - 1) >> 1
      const child = heap[position]
      const above = heap[parent]
      if (child === undefined || above === undefined || child.score >= above.score) break
      swap(position, parent)
      position = parent
    }
  }
  const siftDown = (): void => {
    let position = 0
    for (;;) {
      const left = position * 2 + 1
      const right = left + 1
      let smallest = position
      const atLeft = heap[left]
      const atSmallest = heap[smallest]
      if (atLeft !== undefined && atSmallest !== undefined && atLeft.score < atSmallest.score) smallest = left
      const atRight = heap[right]
      const current = heap[smallest]
      if (atRight !== undefined && current !== undefined && atRight.score < current.score) smallest = right
      if (smallest === position) break
      swap(position, smallest)
      position = smallest
    }
  }
  for (const [uid, vector] of index.vectors) {
    const candidateSketch = sketchOf(vector)
    let dot = 0
    let norm = 0
    for (let i = 0; i < SKETCH_DIM; i++) {
      const value = candidateSketch[i] ?? 0
      dot += (querySketch[i] ?? 0) * value
      norm += value * value
    }
    const lexicalBoost = lexicalUids.has(uid) ? 2 : 0
    const score = dot / (queryNorm * (Math.sqrt(norm) || 1)) + lexicalBoost
    // Only candidates that actually make the shortlist need an object: allocating one per vector
    // would dominate the scan on a large library.
    if (heap.length < size) {
      heap.push({ uid, vector, score })
      siftUp(heap.length - 1)
      continue
    }
    const root = heap[0]
    if (root !== undefined && score > root.score) {
      heap[0] = { uid, vector, score }
      siftDown()
    }
  }
  return heap
}

/**
 * Rank the vector half of the fusion.
 * @param index - Chunk mirror and vectors.
 * @param lexicalUids - Uids already returned by the lexical index.
 * @param queryVec - Query embedding.
 * @param want - Number of nearest vectors to contribute to RRF.
 * @param approx - Whether to shortlist with the sketch before exact cosine.
 * @returns Nearest uids with exact cosine distances, best first.
 */
function vectorRanking(
  index: SearchIndex,
  lexicalUids: ReadonlySet<string>,
  queryVec: Float32Array,
  want: number,
  approx: boolean,
): Array<{ readonly uid: string; readonly distance: number }> {
  const shortlistSize = Math.max(want * SHORTLIST_FACTOR, 320)
  const candidates = approx && index.vectors.size > MIN_EXACT_SCAN
    ? shortlistVectors(index, lexicalUids, queryVec, shortlistSize)
    : [...index.vectors.entries()].map(([uid, vector]) => ({ uid, vector, score: 0 }))
  return candidates
    .map(item => ({ uid: item.uid, distance: cosineDistance(queryVec, item.vector) }))
    .sort((left, right) => left.distance - right.distance || left.uid.localeCompare(right.uid))
    .slice(0, want)
}

/**
 * Rank chunks against a query.
 * @param index - Chunk mirror and vectors for one library.
 * @param lexical - Lexical hits from the backend, best first.
 * @param queryVec - Query embedding, or null for lexical-only retrieval.
 * @param topK - Maximum number of hits.
 * @param approx - Shortlist vectors by sketch on large libraries; `false` keeps exact full scan.
 * @returns Fused hits, best first.
 */
export function hybridSearch(
  index: SearchIndex,
  lexical: ReadonlyArray<{ readonly uid: string; readonly score: number }>,
  queryVec: Float32Array | null,
  topK: number,
  approx = true,
): SearchHit[] {
  const fused = new Map<string, { score: number; vectorDistance: number; lexicalScore: number; vector: boolean }>()

  lexical.forEach((hit, position) => {
    const entry = fused.get(hit.uid) ?? { score: 0, vectorDistance: 1, lexicalScore: 0, vector: false }
    entry.score += 1 / (RRF_K + position + 1)
    entry.lexicalScore = hit.score
    fused.set(hit.uid, entry)
  })

  if (queryVec !== null) {
    const lexicalUids = new Set(lexical.map(hit => hit.uid))
    const ranked = vectorRanking(index, lexicalUids, queryVec, Math.max(topK * 4, 20), approx)
    ranked.forEach((hit, position) => {
      const entry = fused.get(hit.uid) ?? { score: 0, vectorDistance: 1, lexicalScore: 0, vector: false }
      entry.score += 1 / (RRF_K + position + 1)
      entry.vectorDistance = hit.distance
      entry.vector = true
      fused.set(hit.uid, entry)
    })
  }

  // Tie-break by uid so equal-fused hits keep a stable order across calls (matches harness).
  return [...fused.entries()]
    .sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0]))
    .slice(0, topK)
    .map(([uid, entry]) => {
      const chunk = index.chunks.get(uid)
      return {
        uid,
        content: chunk?.content ?? '',
        sourcePath: chunk?.sourcePath ?? '',
        vectorDistance: entry.vectorDistance,
        lexicalScore: entry.lexicalScore,
        score: entry.score,
        cosine: entry.vector ? 1 - entry.vectorDistance : null,
      }
    })
    .filter(hit => hit.content !== '')
}
