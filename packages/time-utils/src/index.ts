/**
 * Canonical clock for every DSH plugin.
 *
 * All plugins should read time through {@link now} (and format it here) instead of calling `Date`
 * directly, so the representation stays consistent across plugins and can later be redirected
 * (e.g. for deterministic tests) without editing every call site.
 *
 * Two renderings exist, and the choice is deliberate:
 * - {@link formatTimestamp} returns ISO-8601 **UTC** — use it for machine records that must stay
 *   comparable across machines and time zones.
 * - {@link localDate} / {@link localTimestamp} render in the machine's own zone — use them for
 *   anything a person reads, because UTC is a day off from the reader's calendar near midnight.
 */

/** A timestamp, persisted by plugins as epoch milliseconds. */
export type Timestamp = number

/**
 * Current time as epoch milliseconds.
 * @returns Milliseconds since `1970-01-01T00:00:00Z`.
 */
export function now(): Timestamp {
  return Date.now()
}

/**
 * Format a timestamp as an ISO-8601 UTC string. This is the canonical persisted
 * display format every plugin uses for human-readable times.
 * @param ts - Timestamp to format; defaults to {@link now}.
 * @returns ISO-8601 string, e.g. `2026-09-17T08:30:00.000Z`.
 */
export function formatTimestamp(ts: Timestamp = now()): string {
  return new Date(ts).toISOString()
}

/** Zero-pad one date or time field. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Local calendar date, as `YYYY-MM-DD`.
 *
 * This — not {@link formatTimestamp} — is the right form for a value a person reads: UTC is a day
 * off from the reader's calendar whenever they are east of midnight UTC.
 * @param ts - Timestamp to format; defaults to {@link now}.
 * @returns The date in the machine's own time zone.
 */
export function localDate(ts: Timestamp = now()): string {
  const date = new Date(ts)
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Local date and time, as `YYYY-MM-DD HH:mm:ss`.
 * @param ts - Timestamp to format; defaults to {@link now}.
 * @returns The moment in the machine's own time zone.
 */
export function localTimestamp(ts: Timestamp = now()): string {
  const date = new Date(ts)
  return `${localDate(ts)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
