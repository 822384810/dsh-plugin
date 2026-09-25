/**
 * Hybrid retrieval: reciprocal-rank fusion over a lexical index and, when an embedding model
 * is available, a vector index.
 *
 * Fusion rather than a weighted sum keeps the two rankings comparable — their scores live on
 * unrelated scales — and keeps either half useful on its own when the other is unavailable.
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
  /** Fused rank score; higher is better. */
  readonly score: number
}

/** Ranking inputs: the in-memory chunk mirror plus the vectors. */
export interface SearchIndex {
  readonly chunks: ReadonlyMap<string, StoredChunk>
  readonly vectors: ReadonlyMap<string, Float32Array>
}

/** Ranking weight for a result at `position` (0-based). */
const RRF_K = 60

/**
 * Rank chunks against a query.
 * @param index - Chunk mirror and vectors for one library.
 * @param lexical - Lexical hits from the backend, best first.
 * @param queryVec - Query embedding, or null for lexical-only retrieval.
 * @param topK - Maximum number of hits.
 * @returns Fused hits, best first.
 */
export function hybridSearch(
  index: SearchIndex,
  lexical: ReadonlyArray<{ readonly uid: string; readonly score: number }>,
  queryVec: Float32Array | null,
  topK: number,
): SearchHit[] {
  const fused = new Map<string, { score: number; vectorDistance: number; lexicalScore: number }>()

  lexical.forEach((hit, position) => {
    const entry = fused.get(hit.uid) ?? { score: 0, vectorDistance: 1, lexicalScore: 0 }
    entry.score += 1 / (RRF_K + position + 1)
    entry.lexicalScore = hit.score
    fused.set(hit.uid, entry)
  })

  if (queryVec !== null) {
    const ranked = [...index.vectors.entries()]
      .map(([uid, vector]) => ({ uid, distance: cosineDistance(queryVec, vector) }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, Math.max(topK * 4, 20))
    ranked.forEach((hit, position) => {
      const entry = fused.get(hit.uid) ?? { score: 0, vectorDistance: 1, lexicalScore: 0 }
      entry.score += 1 / (RRF_K + position + 1)
      entry.vectorDistance = hit.distance
      fused.set(hit.uid, entry)
    })
  }

  return [...fused.entries()]
    .sort((left, right) => right[1].score - left[1].score)
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
      }
    })
    .filter(hit => hit.content !== '')
}
