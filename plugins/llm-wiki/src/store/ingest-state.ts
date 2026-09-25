/**
 * Per-library ingest queue, persisted.
 *
 * This is the single source of truth for ingest progress: the background queue writes it, and every
 * front-end surface (the progress panel and the file list) reads it and nothing else. Keeping the
 * pending list and each file's state in one document means the browser always sees the same picture
 * as the worker, before and after a restart, and libraries never mix.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { now } from '@dsh-plugins-xz/time-utils'

/** Where one file is in the pipeline. */
export type IngestState = 'queued' | 'running' | 'done' | 'failed'

/** The state of one file. There is exactly one record per file, rewritten in place. */
export interface IngestJobState {
  readonly status: IngestState
  /** Percentage, 0-100; meaningful while `running`. */
  readonly progress: number
  readonly error: string | null
  /** Epoch milliseconds when this state was recorded. */
  readonly updatedAt: number
  readonly fileName: string
  /** Re-process even when the file hash is unchanged. */
  readonly force: boolean
}

/** What the browser needs to render one library. */
export interface IngestLibraryState {
  /** Relative paths still waiting to be processed. */
  readonly pending: readonly string[]
  /** One state per file, keyed by relative path. */
  readonly jobs: Readonly<Record<string, IngestJobState>>
}

/** One dequeued item. */
export interface QueuedJob {
  readonly rel: string
  readonly force: boolean
}

/** The persisted document. */
interface IngestStateDoc {
  pending: string[]
  jobs: Record<string, IngestJobState>
}

/**
 * Read/write one library's ingest queue.
 *
 * Writes are synchronous and whole-file, matching the metadata store: the documents are small and
 * this keeps the on-disk state readable and never half-written.
 */
export class IngestStateStore {
  private readonly path: string
  private doc: IngestStateDoc

  /**
   * Load the document, starting empty when it is missing or unreadable.
   * @param path - Absolute path of the JSON document.
   */
  constructor(path: string) {
    this.path = path
    this.doc = this.read()
  }

  /** Every file's state, keyed by relative path. */
  jobs(): Readonly<Record<string, IngestJobState>> {
    return this.doc.jobs
  }

  /** Relative paths still waiting to be processed, in queue order. */
  pending(): readonly string[] {
    return this.doc.pending
  }

  /** Number of files waiting to be processed. */
  get pendingCount(): number {
    return this.doc.pending.length
  }

  /**
   * Add a file to the queue.
   *
   * Re-queueing a file that is already waiting replaces its entry instead of duplicating it, and
   * always resets its previous state — that is how a single re-ingest overrides the old result.
   * @param rel - POSIX path relative to the library root.
   * @param fileName - Display name.
   * @param force - Re-process even when the hash is unchanged.
   * @param front - Jump the queue instead of waiting behind everything else.
   */
  enqueue(rel: string, fileName: string, force: boolean, front = false): void {
    if (!this.doc.pending.includes(rel)) {
      if (front) this.doc.pending.unshift(rel)
      else this.doc.pending.push(rel)
    }
    this.doc.jobs[rel] = { status: 'queued', progress: 0, error: null, updatedAt: now(), fileName, force }
    this.flush()
  }

  /**
   * Take the next file off the queue.
   * @returns The file to process, or undefined when the queue is empty.
   */
  dequeue(): QueuedJob | undefined {
    const rel = this.doc.pending.shift()
    if (rel === undefined) return undefined
    this.flush()
    const job = this.doc.jobs[rel]
    return { rel, force: job?.force ?? false }
  }

  /**
   * Update one file's state, overwriting whatever it was before.
   * @param rel - POSIX path relative to the library root.
   * @param status - New pipeline state.
   * @param progress - Percentage, 0-100.
   * @param error - Failure reason, when any.
   */
  setJob(rel: string, status: IngestState, progress: number, error: string | null): void {
    const previous = this.doc.jobs[rel]
    this.doc.jobs[rel] = {
      status,
      progress,
      error,
      updatedAt: now(),
      fileName: previous?.fileName ?? rel.slice(rel.lastIndexOf('/') + 1),
      force: previous?.force ?? false,
    }
    this.flush()
  }

  /**
   * Turn leftover `running` entries into failures.
   *
   * `running` only means something inside the process that wrote it: after a restart that file is
   * never going to finish on its own, so it is reported as failed (its `queued` siblings stay put
   * and are picked up again).
   * @param error - Why the run stopped.
   * @returns The number of files recovered.
   */
  failRunning(error: string): number {
    let count = 0
    for (const [rel, job] of Object.entries(this.doc.jobs)) {
      if (job.status !== 'running') continue
      this.doc.jobs[rel] = { ...job, status: 'failed', error, updatedAt: now() }
      count += 1
    }
    if (count > 0) this.flush()
    return count
  }

  /** Forget one file entirely; used when its source is deleted. */
  remove(rel: string): void {
    delete this.doc.jobs[rel]
    this.doc.pending = this.doc.pending.filter(item => item !== rel)
    this.flush()
  }

  /** Read the document, starting empty when it is missing or unreadable. */
  private read(): IngestStateDoc {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<IngestStateDoc>
      return {
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        jobs: parsed.jobs ?? {},
      }
    } catch {
      return { pending: [], jobs: {} }
    }
  }

  /** Write the document back. */
  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, `${JSON.stringify(this.doc, undefined, 2)}\n`, 'utf8')
  }
}
