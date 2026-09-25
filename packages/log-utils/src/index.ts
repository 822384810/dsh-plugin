import { localTimestamp } from '@dsh-plugins-xz/time-utils'

/**
 * Canonical logging surface shared by every DSH plugin.
 *
 * One line format — `ts [L] name message` in Cordis style (matching the dsh host) — and three
 * destinations that compose:
 *
 *  - the terminal (stderr on the host, `console` in a browser), on by default;
 *  - an append-only file, defaulting to `$DSH_HOME/logs/<label>.log`, so output outlives the
 *    process;
 *  - the harness logger (`ctx.logger`), when the surface provides one, so the harness's own
 *    startup audit still sees warn/error.
 *
 * This package writes to the terminal and the file itself on purpose: the harness logger's
 * default exporter only buffers in memory, so relying on that sink alone leaves plugin output
 * invisible. Every write is guarded — emitting a diagnostic must never take down the operation
 * that emitted it.
 * @module @dsh-plugins-xz/log-utils
 */

/** Severity levels, matching the harness logger's own set. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** The slice of the harness logger this package forwards to; every level is optional. */
export interface LoggerSink {
  debug?(message: string, ...rest: readonly unknown[]): void
  info?(message: string, ...rest: readonly unknown[]): void
  warn?(message: string, ...rest: readonly unknown[]): void
  error?(message: string, ...rest: readonly unknown[]): void
}

/** Narrow logging surface a plugin hands to its collaborators. */
export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Where a plugin's lines go. */
export interface LoggerOptions {
  /** Harness logger to also forward to, when the surface provides one. */
  sink?: LoggerSink | undefined
  /** Write to the terminal (stderr on the host, `console` in a browser). Defaults to true. */
  console?: boolean
  /**
   * Append to this file, creating its directory on demand. Defaults to
   * `$DSH_HOME/logs/<label>.log`; pass `false` to disable. A browser bundle has no filesystem,
   * so the file destination is skipped there regardless.
   */
  file?: string | false
  /**
   * Prefix every line with an ISO timestamp and the level, e.g.
   * `2026-09-21T03:30:07.123Z [INFO] [label] message`. Defaults to true; pass `false` to keep
   * the bare `[label] message` format.
   */
  timestamp?: boolean
}

/**
 * The Node builtins this package needs.
 *
 * Typed structurally rather than through `node:*`, so the package stays dependency-free and the
 * same source can be bundled for the browser.
 */
interface NodeHost {
  readonly env: Record<string, string | undefined>
  appendFileSync(path: string, data: string): void
  mkdirSync(path: string, options: { recursive: boolean }): void
  dirname(path: string): string
  join(...parts: string[]): string
  resolve(path: string): string
  homedir(): string
}

let cachedHost: NodeHost | null | undefined

/**
 * Resolve the Node builtins through `process.getBuiltinModule`, so no static `node:` import
 * reaches a browser bundle (where the module must still load, just without a file sink).
 * @returns The resolved builtins, or `undefined` outside Node.
 */
function nodeHost(): NodeHost | undefined {
  if (cachedHost !== undefined) return cachedHost ?? undefined
  const proc = (globalThis as {
    process?: {
      env?: Record<string, string | undefined>
      getBuiltinModule?: (id: string) => unknown
    }
  }).process
  if (proc === undefined || typeof proc.getBuiltinModule !== 'function') {
    cachedHost = null
    return undefined
  }
  const fs = proc.getBuiltinModule('node:fs') as {
    appendFileSync: NodeHost['appendFileSync']
    mkdirSync: NodeHost['mkdirSync']
  }
  const path = proc.getBuiltinModule('node:path') as {
    dirname: NodeHost['dirname']
    join: NodeHost['join']
    resolve: NodeHost['resolve']
  }
  const os = proc.getBuiltinModule('node:os') as { homedir: NodeHost['homedir'] }
  cachedHost = {
    env: proc.env ?? {},
    appendFileSync: fs.appendFileSync,
    mkdirSync: fs.mkdirSync,
    dirname: path.dirname,
    join: path.join,
    resolve: path.resolve,
    homedir: os.homedir,
  }
  return cachedHost
}

/**
 * Default log file for one plugin.
 * @param name - Plugin identity, used as the file name.
 * @returns `$DSH_HOME/logs/<name>.log`, or `undefined` where there is no filesystem.
 */
export function dshLogFile(name: string): string | undefined {
  const host = nodeHost()
  if (host === undefined) return undefined
  const configured = host.env['DSH_HOME']
  const home = configured !== undefined && configured.trim() !== ''
    ? configured
    : host.join(host.homedir(), '.dsh')
  return host.join(host.resolve(home), 'logs', `${name}.log`)
}

/** Build an append-only line sink; the parent directory is created on first write. */
function fileSink(path: string): ((line: string) => void) | undefined {
  const host = nodeHost()
  if (host === undefined) return undefined
  let ready = false
  return line => {
    try {
      if (!ready) {
        host.mkdirSync(host.dirname(path), { recursive: true })
        ready = true
      }
      host.appendFileSync(path, line)
    } catch {
      // Retry — directory included — on the next line rather than losing the rest of the run.
      ready = false
    }
  }
}

/** Write to stderr on the host, or the matching `console` method in a browser. */
function writeTerminal(level: LogLevel, line: string): void {
  const proc = (globalThis as { process?: { stderr?: { write(chunk: string): unknown } } }).process
  if (proc?.stderr !== undefined) {
    try {
      proc.stderr.write(line)
      return
    } catch {
      // Fall through to `console` when stderr itself is unusable.
    }
  }
  const sink = (globalThis as { console?: Partial<Record<LogLevel, (message?: unknown) => void>> }).console
  try { sink?.[level]?.(line.trimEnd()) } catch { /* diagnostics must never throw */ }
}

/**
 * Build a plugin logger.
 * @param label - Plugin identity: the bare `name` in the `ts [L] name message` line, and the default log-file name.
 * @param options - Harness sink, terminal toggle, and log-file override.
 * @returns A logger that never throws.
 */
export function createLogger(label: string, options: LoggerOptions = {}): Logger {
  const levelCode: Record<LogLevel, string> = { debug: 'D', info: 'I', warn: 'W', error: 'E' }
  const filePath = options.file === false ? undefined : options.file ?? dshLogFile(label)
  const append = filePath === undefined ? undefined : fileSink(filePath)
  const toTerminal = options.console !== false
  const withTime = options.timestamp !== false
  const write = (level: LogLevel, message: string): void => {
    const stamp = withTime ? `${localTimestamp()} ` : ''
    const text = `${stamp}[${levelCode[level]}] ${label} ${message}`
    try {
      // Forward only the raw message: the harness (Cordis) adds its own `ts [L] name` prefix,
      // so re-sending the formatted line would double the prefix in the host stream.
      const forward = options.sink?.[level]
      if (typeof forward === 'function') forward.call(options.sink, message)
    } catch {
      // A broken harness sink must not drop the terminal and file copies below.
    }
    if (toTerminal) writeTerminal(level, `${text}\n`)
    append?.(`${text}\n`)
  }
  return {
    debug: message => write('debug', message),
    info: message => write('info', message),
    warn: message => write('warn', message),
    error: message => write('error', message),
  }
}
