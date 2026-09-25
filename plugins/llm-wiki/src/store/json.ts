/**
 * JSON-backed chunk store: the fallback for platforms without `node:sqlite`.
 *
 * It holds everything in memory and rewrites one file per mutation, which is fine for the
 * library sizes a fallback exists to serve and keeps the behaviour identical to the SQLite
 * backend from the caller's point of view.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChunkBackend, LexicalHit, Snapshot, StoredChunk } from './backend.ts'

/** On-disk shape: vectors are plain arrays so the file stays readable. */
interface JsonDoc {
  chunks: StoredChunk[]
  vectors: Record<string, number[]>
}

/** Chunk store backed by one JSON document. */
export class JsonBackend implements ChunkBackend {
  readonly name = 'json'

  private readonly path: string
  private chunks: StoredChunk[] = []
  private vectors = new Map<string, Float32Array>()

  /**
   * Load the document, starting empty when it is missing or unreadable.
   * @param path - Absolute path of the JSON document.
   */
  constructor(path: string) {
    this.path = path
    this.read()
  }

  load(): Snapshot {
    return { chunks: [...this.chunks], vectors: new Map(this.vectors) }
  }

  replaceSource(
    sourcePath: string,
    chunks: readonly StoredChunk[],
    vectors: ReadonlyMap<string, Float32Array>,
  ): void {
    this.chunks = this.chunks.filter(chunk => chunk.sourcePath !== sourcePath)
    this.chunks.push(...chunks)
    for (const chunk of chunks) {
      const vector = vectors.get(chunk.uid)
      if (vector === undefined) this.vectors.delete(chunk.uid)
      else this.vectors.set(chunk.uid, vector)
    }
    this.flush()
  }

  deleteSource(sourcePath: string): number {
    const before = this.chunks.length
    for (const chunk of this.chunks) {
      if (chunk.sourcePath === sourcePath) this.vectors.delete(chunk.uid)
    }
    this.chunks = this.chunks.filter(chunk => chunk.sourcePath !== sourcePath)
    this.flush()
    return before - this.chunks.length
  }

  clear(): void {
    this.chunks = []
    this.vectors.clear()
    this.flush()
  }

  lexical(query: string, limit: number): LexicalHit[] {
    const needles = query.toLowerCase().split(/\s+/).filter(part => part !== '')
    if (needles.length === 0) return []
    const hits: LexicalHit[] = []
    for (const chunk of this.chunks) {
      const haystack = chunk.content.toLowerCase()
      let score = 0
      for (const needle of needles) {
        let at = haystack.indexOf(needle)
        while (at !== -1) {
          score += needle.length
          at = haystack.indexOf(needle, at + needle.length)
        }
      }
      if (score > 0) hits.push({ uid: chunk.uid, score })
    }
    return hits.sort((left, right) => right.score - left.score).slice(0, limit)
  }

  close(): void {
    this.flush()
  }

  private read(): void {
    try {
      const doc = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<JsonDoc>
      this.chunks = Array.isArray(doc.chunks) ? doc.chunks : []
      this.vectors = new Map()
      for (const [uid, values] of Object.entries(doc.vectors ?? {})) {
        if (Array.isArray(values)) this.vectors.set(uid, new Float32Array(values))
      }
    } catch {
      this.chunks = []
      this.vectors = new Map()
    }
  }

  private flush(): void {
    const doc: JsonDoc = {
      chunks: this.chunks,
      vectors: Object.fromEntries([...this.vectors].map(([uid, vector]) => [uid, [...vector]])),
    }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, `${JSON.stringify(doc)}\n`, 'utf8')
  }
}
