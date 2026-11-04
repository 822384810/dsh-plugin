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
  const fused = new Map<string, { score: number; vectorDistance: number; lexicalScore: number; vector: boolean }>()

  lexical.forEach((hit, position) => {
    const entry = fused.get(hit.uid) ?? { score: 0, vectorDistance: 1, lexicalScore: 0, vector: false }
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
