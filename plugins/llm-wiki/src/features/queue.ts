/**
 * The ingest queue.
 *
 * Ingestion is the slow, failure-prone half of the plugin — parsing, embedding and compiling can
 * each fail for one file without affecting the next — so work runs off a queue that is persisted per
 * library. The queue file is the single source of truth: the worker writes it, the browser reads it,
 * and nothing is held only in memory, so a restart neither loses the run nor shows a stale picture.
 *
 * Each library has its own queue and drains it independently, so libraries never block each other.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { LibraryRegistry, LibraryRuntime } from './registry.ts'
import type { Settings } from '../config.ts'
import type { Logger } from '@dsh-plugins-xz/log-utils'
import type { IngestState } from '../store/ingest-state.ts'
import { normalizeText } from '../shared/chunk.ts'
import { relativePosix } from '../shared/paths.ts'
import { sourceMeta } from '../store/meta.ts'
import { parseSource } from './parsers.ts'
import { extractIndicators, detectStandardNo } from './indicators.ts'

/** Progress steps one file passes through; everything before `done` is `running` to the browser. */
export type IngestStatus = 'parsing' | 'indexing' | 'extracting' | 'compiling' | 'done'

/** Percentage reported at each step. Failures are recorded directly, not as a step. */
const STEP_PROGRESS: Record<IngestStatus, number> = {
  parsing: 10,
  indexing: 40,
  extracting: 60,
  compiling: 80,
  done: 100,
}

/** What one file produced. */
export interface IngestOutcome {
  readonly chunks: number
  readonly created: readonly string[]
  readonly updated: readonly string[]
  readonly conflicts: number
}

/** Work the queue cannot do itself. */
export interface IngestDeps {
  readonly registry: LibraryRegistry
  readonly settings: Settings
  readonly log: Logger
  /**
   * Write the source's mirror page and bring the retrieval index in line with it.
   * @returns The number of chunks the mirror was indexed as.
   */
  readonly materialize: (library: LibraryRuntime, rel: string, text: string) => Promise<number>
  /** Compile the source into Wiki pages. */
  readonly compile: (
    library: LibraryRuntime,
    sourceRelPath: string,
    text: string,
    indicators: ReturnType<typeof extractIndicators>,
  ) => Promise<IngestOutcome>
}

/** Empty result used when a file has nothing to do. */
const NOTHING: IngestOutcome = { chunks: 0, created: [], updated: [], conflicts: 0 }

/** Drains the persisted queue of every library. */
export class IngestQueue {
  /** Libraries whose queue is currently being drained. */
  private readonly draining = new Set<string>()

  /** @param deps - Registry, embedder, settings, logger and the compile hook. */
  constructor(private readonly deps: IngestDeps) {}

  /**
   * Queue one file.
   * @param absPath - Absolute path of the source.
   * @param libId - Owning library.
   * @param priority - Higher jumps the queue.
   * @param force - Re-process even when the file hash is unchanged.
   */
  enqueue(absPath: string, libId: string, priority = 0, force = false): void {
    const library = this.deps.registry.get(libId)
    if (library === undefined) return
    const rel = relativePosix(library.rootDir, absPath)
    // Re-queueing replaces the file's state, which is how a single re-ingest overrides the old one.
    library.ingest.enqueue(rel, path.basename(rel), force, priority > 0)
    void this.drain(libId)
  }

  /**
   * Restart whatever was left queued when the process last stopped.
   * @returns The number of libraries resumed.
   */
  resumeAll(): number {
    let count = 0
    for (const library of this.deps.registry.list()) {
      const runtime = this.deps.registry.get(library.id)
      if (runtime === undefined || runtime.ingest.pendingCount === 0) continue
      void this.drain(library.id)
      count += 1
    }
    return count
  }

  /**
   * Ingest one file end to end.
   * @param library - Owning library.
   * @param rel - POSIX path relative to the library root.
   * @param force - Re-process even when the file hash is unchanged.
   * @returns What the file produced.
   * @throws when a step fails.
   */
  private async ingestFile(library: LibraryRuntime, rel: string, force: boolean): Promise<IngestOutcome> {
    const absPath = path.join(library.rootDir, rel)
    this.step(library, rel, 'parsing')
    const buffer = await readFile(absPath)
    const hash = createHash('sha256').update(buffer).digest('hex')
    if (!force && library.meta.hashOf(rel) === hash) {
      this.step(library, rel, 'done')
      return NOTHING
    }

    const parsed = await parseSource(
      absPath,
      {
        engine: this.deps.settings.ocrEngine,
        modelDir: this.deps.settings.ocrModelDir,
        languages: this.deps.settings.ocrLanguages,
        langPath: this.deps.settings.ocrLangPath,
        renderScale: this.deps.settings.ocrRenderScale,
      },
      this.deps.settings.extraSourceExtensions,
      this.deps.log,
    )
    const text = normalizeText(parsed.text)
    if (text === '') {
      this.fail(library, rel, '文件没有可索引的文本内容')
      return NOTHING
    }

    this.step(library, rel, 'indexing')
    // The parsed text is materialized as the source's mirror page, and the mirror — not the raw
    // bytes — is what the index stores, so exactly one copy of the text is searchable.
    const chunks = await this.deps.materialize(library, rel, text)

    this.step(library, rel, 'extracting')
    const standardNo = detectStandardNo(text)
    const indicators = extractIndicators(text, rel, standardNo)
    library.meta.setIndicators(rel, indicators)
    library.meta.setSource(rel, sourceMeta(hash, path.basename(absPath), standardNo))

    this.step(library, rel, 'compiling')
    let outcome: IngestOutcome
    try {
      outcome = await this.deps.compile(library, rel, text, indicators)
    } catch (error) {
      this.deps.log.error(`compile failed for ${rel}: ${String(error)}`)
      outcome = { chunks, created: [], updated: [], conflicts: 0 }
    }
    this.step(library, rel, 'done')
    return { ...outcome, chunks }
  }

  /**
   * Drain one library's queue, one file at a time. Libraries run independently of each other.
   * @param libId - Library whose queue to drain.
   */
  private async drain(libId: string): Promise<void> {
    if (this.draining.has(libId)) return
    const library = this.deps.registry.get(libId)
    if (library === undefined) return
    this.draining.add(libId)
    try {
      for (;;) {
        const next = library.ingest.dequeue()
        if (next === undefined) break
        try {
          await this.ingestFile(library, next.rel, next.force)
        } catch (error) {
          this.deps.log.error(`ingest failed for ${next.rel}: ${String(error)}`)
          this.fail(library, next.rel, String(error))
        }
      }
    } finally {
      this.draining.delete(libId)
    }
  }

  /** Record a progress step; anything before `done` shows as running. */
  private step(library: LibraryRuntime, rel: string, status: IngestStatus): void {
    library.ingest.setJob(rel, toState(status), STEP_PROGRESS[status], null)
  }

  /** Record a failure. */
  private fail(library: LibraryRuntime, rel: string, error: string): void {
    library.ingest.setJob(rel, 'failed', 100, error)
  }
}

/** Collapse the internal steps onto the states the browser sees. */
function toState(status: IngestStatus): IngestState {
  return status === 'done' ? 'done' : 'running'
}
