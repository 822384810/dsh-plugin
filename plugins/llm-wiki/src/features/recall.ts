/**
 * Ambient recall: the knowledge context injected into the system prompt.
 *
 * The harness assembles the prompt synchronously, so this cannot wait on an embedding call.
 * It therefore recalls lexically — which is also the right default, since a block injected
 * into every turn should be cheap and predictable — and leaves semantic retrieval to the
 * `wiki_search` tool the prompt points the model at.
 */
import type { SearchHit } from '../shared/retrieval.ts'
import { excerpt } from '../shared/chunk.ts'
import { now } from '@dsh-plugins-xz/time-utils'

/** Ambient recall tuning. */
export interface AmbientOptions {
  readonly topK: number
  readonly maxChars: number
  /** Chunks scoring at or below this are not worth the tokens. */
  readonly minScore: number
  /** How long an identical query keeps its cached answer. */
  readonly cacheTtlMs: number
}

/** Retrieval hook, supplied by the service that owns the library. */
export type AmbientRetrieve = (query: string, topK: number) => SearchHit[]

/** Default tuning: five candidates, each capped at 2000 chars, but only ~2 fit the budget. */
const DEFAULTS: AmbientOptions = {
  topK: 5,
  maxChars: 4000,
  minScore: 0,
  cacheTtlMs: 3000,
}

/**
 * Build the ambient knowledge block.
 *
 * Results are cached per (library, query) so that a prompt assembled several times inside one
 * turn does not re-run retrieval.
 */
export class AmbientRecall {
  private lastKey = ''
  private lastAt = 0
  private lastValue = ''
  private readonly options: AmbientOptions

  /**
   * @param retrieve - Lexical retrieval over the active library.
   * @param options - Tuning overrides.
   */
  constructor(
    private readonly retrieve: AmbientRetrieve,
    options: Partial<AmbientOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options }
  }

  /**
   * Build the block for one query.
   * @param libraryId - Active library id, part of the cache key.
   * @param query - User text to recall against.
   * @returns Markdown to inject, or an empty string when nothing is relevant.
   */
  build(libraryId: string, query: string): string {
    const trimmed = query.trim()
    if (libraryId === '' || trimmed.length < 2) return ''
    const key = `${libraryId}::${trimmed}`
    const stamp = now()
    if (key === this.lastKey && stamp - this.lastAt < this.options.cacheTtlMs) return this.lastValue

    const hits = this.retrieve(trimmed, this.options.topK).filter(hit => hit.score > this.options.minScore)
    let text = ''
    for (const hit of hits) {
      const remaining = this.options.maxChars - text.length - (text === '' ? 0 : 2)
      if (remaining <= 0) break
      // Each hit keeps up to 2000 characters (the harness knowledge channel's per-node cap);
      // the last one is trimmed to the remaining budget instead of being dropped wholesale.
      let block = `[知识库片段] 来源：${hit.sourcePath}\n${excerpt(hit.content, 2000)}`
      if (block.length > remaining) block = block.slice(0, remaining).trimEnd()
      if (block === '') break
      text += text === '' ? block : `\n\n${block}`
    }
    this.lastKey = key
    this.lastAt = stamp
    this.lastValue = text
    return text
  }
}
