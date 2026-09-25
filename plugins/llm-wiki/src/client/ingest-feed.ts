/**
 * The one ingest-state poller the panel runs.
 *
 * The progress panel and the raw file list render the same persisted queue, and they used to ask
 * for it on their own identical schedules: two requests per interval, each carrying every library's
 * jobs — a payload that grows with every file a library has ever ingested. Owing the loop once
 * halves that traffic, asks only for the library on screen, and means the two surfaces can never
 * show different moments of the same run.
 * @module llm-wiki/ingest-feed
 */
import { useCallback, useEffect, useState } from 'react'
import type { WikiActions, IngestSnapshot } from './api.ts'

/**
 * How often the queue is read while nothing is happening.
 *
 * An idle queue reports the same thing every time, so the idle interval is deliberately slow:
 * nothing changes between two reads, and a large library should not pay for a payload nobody is
 * reading. Work started from any surface still shows up within one interval.
 */
const POLL_IDLE_MS = 15000

/** How often it is read while work is in flight, so short runs are actually visible. */
const POLL_BUSY_MS = 3000

/** The picture before any read answers, and while a newly selected library's first read is in flight. */
const EMPTY: IngestSnapshot = { state: { pending: [], jobs: {} }, othersBusy: 0 }

/** What a consumer of the feed gets back. */
export interface IngestFeed {
  /** The selected library's queue state; empty while nothing is selected or read yet. */
  readonly state: IngestSnapshot['state']
  /** How many other libraries still have work in flight. */
  readonly othersBusy: number
  /** Read again now instead of waiting out the current interval. */
  refresh(): void
}

/**
 * Poll the persisted ingest queue of the selected library.
 * @param load - The Host action; its identity must be stable or the loop restarts every render.
 * @param libId - Library to report, or null for none.
 * @returns The latest snapshot of that library, and a way to ask for the next read immediately.
 */
export function useIngestFeed(load: WikiActions['ingestStates'], libId: string | null): IngestFeed {
  // The snapshot carries the library it belongs to, so switching selection shows the new library's
  // (still empty) queue at once instead of the previous one's rows while its read is in flight.
  const [snapshot, setSnapshot] = useState<{ readonly libId: string | null; readonly value: IngestSnapshot }>({
    libId: null,
    value: EMPTY,
  })
  // Bumping this changes the loop's dependencies, which reads again at once.
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async (): Promise<void> => {
      let busy = false
      try {
        const next = await load(libId ?? '')
        if (cancelled) return
        setSnapshot({ libId, value: next })
        // Poll fast while work is in flight so short runs are not missed between slow polls; a
        // busy *other* library counts, because the panel reports it too.
        busy = next.othersBusy > 0 || next.state.pending.length > 0
          || Object.values(next.state.jobs).some(job => job.status === 'running' || job.status === 'queued')
      } catch {
        // Keep the last known picture rather than blanking the panel.
      }
      if (cancelled) return
      timer = setTimeout(() => { void run() }, busy ? POLL_BUSY_MS : POLL_IDLE_MS)
    }
    void run()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [load, libId, tick])

  const refresh = useCallback((): void => { setTick(value => value + 1) }, [])
  const current = snapshot.libId === libId ? snapshot.value : EMPTY
  return { state: current.state, othersBusy: current.othersBusy, refresh }
}
