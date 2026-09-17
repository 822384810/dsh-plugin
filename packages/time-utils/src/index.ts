/**
 * Canonical clock for every DSH plugin.
 *
 * All plugins should read time through {@link now} (and format it through
 * {@link formatTimestamp}) instead of calling `Date` directly, so the
 * representation stays consistent across plugins and can later be redirected
 * (e.g. for deterministic tests) without editing every call site.
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
