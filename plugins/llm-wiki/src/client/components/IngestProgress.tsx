/**
 * Ingest progress for one library.
 *
 * The browser reads the persisted queue and nothing else, so it can never disagree with the worker:
 * the same document is the worker's to-do list and the panel's picture. The snapshot arrives from
 * the panel's single poller rather than one of its own, so this and the raw file list always show
 * the same moment. Libraries are reported separately, so this shows the active one and only
 * mentions the others when they are busy too.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IngestJobState, IngestLibraryState } from '../api.ts'
import type { Translate } from '../translate.ts'
import { template } from '../translate.ts'
import { FONT_SIZE_BODY, FONT_SIZE_SMALL, ROW_PADDING } from '../typography.ts'

/** How many rows the expanded list renders before it offers the next batch. */
const ROW_BATCH = 20

/** Props: the shared ingest snapshot, the library to show, and copy. */
export interface IngestProgressProps {
  readonly t: Translate
  /** Library whose queue is shown; read to reset the batch when the selection moves. */
  readonly libId: string | null
  /** The selected library's queue state, from the panel's single poller. */
  readonly state: IngestLibraryState
  /** How many other libraries still have work in flight. */
  readonly othersBusy: number
}

export function IngestProgress({ state, othersBusy, t, libId }: IngestProgressProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  /** How many rows the expanded list may render so far; raised a batch at a time. */
  const [limit, setLimit] = useState(ROW_BATCH)

  // A different library is a different list, so it starts from the first batch again.
  useEffect(() => { setLimit(ROW_BATCH) }, [libId])

  const rows = useMemo(
    () => Object.entries(state.jobs)
      // Drop synthetic system jobs (keys starting with `__`): they drive the panel's own state
      // machine but are not files, so listing them as files would be misleading.
      .filter(([rel]) => !rel.startsWith('__'))
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt),
    [state],
  )

  if (rows.length === 0) return null

  const total = rows.length
  const failed = rows.filter(([, job]) => job.status === 'failed').length
  const settled = rows.filter(([, job]) => job.status === 'done' || job.status === 'failed').length
  const active = total - settled
  const percent = Math.round((settled / total) * 100)
  const lastAt = Math.max(...rows.map(([, job]) => job.updatedAt))
  // `active` already covers queued and running: every queued file has a job record.
  const inFlight = active > 0

  // The bar is always shown: it fills as files settle and stays full once everything is done, so
  // completion reads as a finished bar rather than as text alone.
  const barColor = inFlight
    ? 'var(--dsw-alias-state-business-primary)'
    : failed > 0
      ? 'var(--dsw-alias-state-error-primary)'
      : 'var(--dsw-alias-state-success-primary)'

  const headline = (
    <>
      <span
        style={{
          fontSize: inFlight ? FONT_SIZE_SMALL : FONT_SIZE_BODY,
          opacity: inFlight ? 0.6 : 1,
          color: inFlight
            ? undefined
            : failed > 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
          flex: '0 0 auto',
        }}
      >
        {inFlight ? t('progress.title') : failed > 0 ? `✗ ${t('progress.doneWithFail')}` : `✓ ${t('progress.done')}`}
      </span>
      <div style={{ flex: 1, minWidth: 40, height: 6, background: 'var(--dsw-alias-bg-mask-2)', borderRadius: 3 }}>
        <div style={{
          width: `${String(percent)}%`,
          height: '100%',
          borderRadius: 3,
          background: barColor,
          transition: 'width 0.3s ease',
        }}
        />
      </div>
      <span style={{ flex: '0 0 auto', fontSize: FONT_SIZE_SMALL, opacity: 0.7, whiteSpace: 'nowrap' }}>
        {`${String(settled)} / ${String(total)}`}
      </span>
    </>
  )

  return (
    <div style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', padding: 8 }}>
      <div
        onClick={() => setExpanded(value => !value)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}
      >
        {headline}
        <span style={{ flex: '0 0 auto', fontSize: FONT_SIZE_SMALL, opacity: 0.7 }}>{expanded ? '▾' : '▸'}</span>
      </div>
      {(!inFlight || othersBusy > 0) && (
        <div style={{ fontSize: FONT_SIZE_SMALL, opacity: 0.6, marginTop: 2 }}>
          {[
            inFlight ? '' : `${template(t, 'progress.doneDetail', { total: String(total), failed: String(failed) })} · ${new Date(lastAt).toLocaleString()}`,
            othersBusy > 0 ? template(t, 'progress.otherLibraries', { n: String(othersBusy) }) : '',
          ].filter(part => part !== '').join(' · ')}
        </div>
      )}
      {expanded && (
        <>
          <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 6 }}>
            {rows.slice(0, limit).map(([rel, job]) => (
              <Row key={rel} rel={rel} job={job} t={t} />
            ))}
          </div>
          {/* Outside the scroller, so the next batch is one click away instead of one scroll away. */}
          {total > limit && (
            <div style={{ padding: '6px 0 0' }}>
              <Button variant="ghost" size="sm" onClick={() => { setLimit(current => current + ROW_BATCH) }}>
                {template(t, 'progress.showMore', { n: total - limit })}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Bar width and colour for one file's own progress bar. */
function barOf(job: IngestJobState): { percent: number; color: string } {
  if (job.status === 'done') return { percent: 100, color: 'var(--dsw-alias-state-success-primary)' }
  if (job.status === 'failed') return { percent: 100, color: 'var(--dsw-alias-state-error-primary)' }
  if (job.status === 'running') return { percent: job.progress, color: 'var(--dsw-alias-state-business-primary)' }
  return { percent: 0, color: 'var(--dsw-alias-state-business-primary)' }
}

/** One file row: its own progress bar and its state. Re-ingest lives in the file list. */
function Row(
  { rel, job, t }: {
    readonly rel: string
    readonly job: IngestJobState
    readonly t: Translate
  },
): ReactElement {
  const bar = barOf(job)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: FONT_SIZE_BODY, padding: ROW_PADDING }}>
      {/* Fixed-width name column so every bar starts at the same x and has the same length. */}
      <span
        title={rel}
        style={{ flex: '0 0 260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {job.fileName}
      </span>
      <div style={{ flex: 1, minWidth: 40, height: 4, background: 'var(--dsw-alias-bg-mask-2)', borderRadius: 2 }}>
        <div style={{
          width: `${String(bar.percent)}%`,
          height: '100%',
          borderRadius: 2,
          background: bar.color,
          transition: 'width 0.3s ease',
        }}
        />
      </div>
      {/* Fixed-width status column so every bar ends at the same x too. */}
      <span
        style={{
          flex: '0 0 52px',
          fontSize: FONT_SIZE_SMALL,
          textAlign: 'right',
          opacity: job.status === 'queued' ? 0.6 : 1,
          color: job.status === 'running'
            ? 'var(--dsw-alias-state-business-primary)'
            : job.status === 'done'
              ? 'var(--dsw-alias-state-success-primary)'
              : job.status === 'failed'
                ? 'var(--dsw-alias-state-error-primary)'
                : undefined,
        }}
      >
        {job.status === 'queued'
          ? t('raw.ingestQueued')
          : job.status === 'running'
            ? `${String(job.progress)}%`
            : job.status === 'done'
              ? '✓'
              : (
                <>
                  ✗
                  {job.error !== null && (
                    <span style={{ cursor: 'help' }} title={job.error}>!</span>
                  )}
                </>
              )}
      </span>
    </div>
  )
}
