/**
 * Per-library sidecar metadata: source hashes and extracted indicators.
 *
 * Both are small, read-modify-write records that outlive the chunk store's schema, so they
 * live in one JSON document rather than in the backend — no backend has to model them.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { localTimestamp } from '@dsh-plugins-xz/time-utils'

/** Direction a numeric limit runs in; `range` means the value is a span, not a bound. */
export type IndicatorDirection = 'upper' | 'lower' | 'range'

/** One numeric requirement extracted from a source document. */
export interface Indicator {
  readonly standardNo: string
  readonly clauseNo: string
  readonly indicatorName: string
  readonly value: number
  readonly unit: string
  readonly direction: IndicatorDirection
  readonly condition: string
  readonly level: string
  readonly sourcePath: string
}

/** What is known about one ingested source. */
export interface SourceMeta {
  readonly hash: string
  readonly name: string
  readonly standardNo: string
  readonly updatedAt: string
}

/** A marker this plugin keeps about one Wiki page, outside the page itself. */
export interface PageMarkState {
  /** True once a human edited the page in the panel; a fresh parse of the source clears it. */
  readonly edited: boolean
  readonly updatedAt: string
}

/** The persisted document. */
interface MetaDoc {
  sources: Record<string, SourceMeta>
  indicators: Indicator[]
  pages: Record<string, PageMarkState>
}

/** Shape of the per-file status block written before the ingest queue got its own document. */
export interface LegacyIngestStatus {
  readonly status: string
  readonly error: string | null
  readonly updatedAt: number
  readonly fileName: string
}

/** Read/write the metadata document for one library. */
export class MetaStore {
  private readonly path: string
  private doc: MetaDoc

  /**
   * Load the document, starting empty when it is missing or unreadable.
   * @param path - Absolute path of the JSON document.
   */
  constructor(path: string) {
    this.path = path
    this.doc = this.read()
  }

  /**
   * Look up the hash recorded for a source.
   * @param sourcePath - POSIX path relative to the library root.
   * @returns The hash, or undefined when the source has never been ingested.
   */
  hashOf(sourcePath: string): string | undefined {
    return this.doc.sources[sourcePath]?.hash
  }

  /** Record a source and the hash its chunks were built from. */
  setSource(sourcePath: string, meta: SourceMeta): void {
    this.doc.sources[sourcePath] = meta
    this.flush()
  }

  /** Forget a source and everything extracted from it. */
  removeSource(sourcePath: string): void {
    delete this.doc.sources[sourcePath]
    this.doc.indicators = this.doc.indicators.filter(item => item.sourcePath !== sourcePath)
    this.flush()
  }

  /** The marker recorded for one page, if any. */
  pageMark(pagePath: string): PageMarkState | undefined {
    return this.doc.pages[pagePath]
  }

  /** Every page marker, keyed by page path. */
  pageMarks(): Readonly<Record<string, PageMarkState>> {
    return this.doc.pages
  }

  /** Record that a human edited one page in the panel. */
  setPageEdited(pagePath: string): void {
    this.doc.pages[pagePath] = { edited: true, updatedAt: localTimestamp() }
    this.flush()
  }

  /** Forget a page's marker; a fresh parse of its source supersedes manual edits. */
  clearPageEdited(pagePath: string): void {
    if (this.doc.pages[pagePath] === undefined) return
    delete this.doc.pages[pagePath]
    this.flush()
  }

  /** Replace the indicators extracted from one source. */
  setIndicators(sourcePath: string, indicators: readonly Indicator[]): void {
    this.doc.indicators = [
      ...this.doc.indicators.filter(item => item.sourcePath !== sourcePath),
      ...indicators,
    ]
    this.flush()
  }

  /**
   * Read every indicator, optionally excluding one source.
   * @param exclude - Source path to omit; used when comparing a new source against the rest.
   * @returns The indicators.
   */
  indicators(exclude?: string): readonly Indicator[] {
    return exclude === undefined
      ? this.doc.indicators
      : this.doc.indicators.filter(item => item.sourcePath !== exclude)
  }

  /** Every known source, keyed by relative path. */
  sources(): Readonly<Record<string, SourceMeta>> {
    return this.doc.sources
  }

  /** Number of known sources. */
  get sourceCount(): number {
    return Object.keys(this.doc.sources).length
  }

  /** Number of stored indicators. */
  get indicatorCount(): number {
    return this.doc.indicators.length
  }

  /**
   * Read the per-file status block an older version of the plugin left here.
   *
   * That block now lives in the ingest queue document; the metadata doc no longer carries it, so
   * the caller can import it there once and this document stops carrying it at the next write.
   * @returns The legacy records, or null when this document never had any.
   */
  takeLegacyIngestStatus(): Record<string, LegacyIngestStatus> | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { ingestStatus?: unknown }
      if (parsed.ingestStatus === null || typeof parsed.ingestStatus !== 'object') return null
      return parsed.ingestStatus as Record<string, LegacyIngestStatus>
    } catch {
      return null
    }
  }

  /** Drop everything. */
  clear(): void {
    this.doc = { sources: {}, indicators: [], pages: {} }
    this.flush()
  }

  private read(): MetaDoc {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<MetaDoc>
      return {
        sources: parsed.sources ?? {},
        indicators: Array.isArray(parsed.indicators) ? parsed.indicators : [],
        pages: parsed.pages ?? {},
      }
    } catch {
      return { sources: {}, indicators: [], pages: {} }
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, `${JSON.stringify(this.doc, undefined, 2)}\n`, 'utf8')
  }
}

/**
 * Build the metadata record for a freshly ingested source.
 * @param hash - Content hash the chunks were built from.
 * @param name - Display name, usually the base name.
 * @param standardNo - Standard number carried by the extracted indicators, when any.
 * @returns The record.
 */
export function sourceMeta(hash: string, name: string, standardNo: string): SourceMeta {
  return { hash, name, standardNo, updatedAt: localTimestamp() }
}
