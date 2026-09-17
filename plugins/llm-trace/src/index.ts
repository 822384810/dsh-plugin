/**
 * Host half only: one readable JSON file per model request, so the assembled system prompt and
 * the exact message list can be inspected without a debugger — which is how persona, prompt
 * sections, and tool schemas are verified to actually reach the model.
 *
 * The trace hangs off the `llm/stream` waterfall, which every provider call passes through
 * before dispatch. It observes the frozen request and then delegates with `next()`, so it can
 * neither change what the model sees nor swallow the response stream. A trace failure is
 * reported on stderr and never propagates into the call it observes.
 * @module llm-trace
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { LlmRequest, PluginContext } from './types.ts'

/** Stable Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = 'llm-trace'

/** Nothing is injected: the waterfall event is visible on the root context. */
export const inject = []

/** Settings a deployment changes from `cordis.patch.yml`. */
export interface Config {
  /** stderr detail per request; the JSON file is written independently of this. */
  print?: 'summary' | 'full' | 'off'
  /** Write one pretty-printed JSON file per request under `$DSH_HOME/logs/llm-trace/`. */
  file?: boolean
}

/** Settings with defaults applied. */
interface Settings {
  print: 'summary' | 'full' | 'off'
  file: boolean
}

/** Print detail used when the config names an unknown mode. */
const DEFAULT_PRINT: Settings['print'] = 'summary'

/** Requests observed by this process, so dumped files sort in dispatch order. */
let sequence = 0

function settingsOf(config: Config): Settings {
  const print = config.print
  return {
    print: print === 'full' || print === 'off' ? print : DEFAULT_PRINT,
    file: config.file ?? true,
  }
}

/**
 * Serializable view of one request: `signal` and other non-JSON internals are dropped, every
 * other field (provider, model, system, messages, tools, …) is copied verbatim.
 */
function snapshot(request: LlmRequest): Record<string, unknown> {
  const { signal: _signal, ...rest } = request
  return { time: new Date().toISOString(), ...rest }
}

/** One file per request, named so that a directory listing reads in dispatch order. */
function fileFor(request: LlmRequest, index: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const session = request.sessionId ?? 'no-session'
  const label = `${String(index).padStart(3, '0')}-${stamp}-${session}`.replace(/[^A-Za-z0-9\-_]/gu, '_')
  return dshHomePath('logs', 'llm-trace', `${label}.json`)
}

/** Total characters one message contributes as text. */
function textLengthOf(message: unknown): number {
  const content = (message as { content?: unknown })?.content
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce<number>((total, part) => {
    const text = (part as { text?: unknown })?.text
    return total + (typeof text === 'string' ? text.length : 0)
  }, 0)
}

/**
 * One stderr line describing the observed request. The system prompt is reported from both
 * carriers on purpose: the agent loop puts the assembled prompt in a `system`-role message,
 * while utility calls (session naming and similar) pass it as the `system` field.
 */
function summarise(request: LlmRequest, file: string | undefined): string {
  const systemField = typeof request.system === 'string' ? request.system.length : 0
  const systemMessage = (request.messages ?? [])
    .filter(message => (message as { role?: unknown })?.role === 'system')
    .reduce<number>((total, message) => total + textLengthOf(message), 0)
  return `${name}: ${request.provider ?? '?'}/${request.model ?? '?'} session=${request.sessionId ?? '?'}`
    + ` messages=${String(request.messages?.length ?? 0)}`
    + ` systemField=${systemField === 0 ? 'absent' : String(systemField)}`
    + ` systemMessage=${String(systemMessage)}`
    + ` tools=${String(request.tools?.length ?? 0)}${file === undefined ? '' : ` -> ${file}`}`
}

/**
 * Register the trace.
 * @param ctx - Host context receiving the model-request waterfall.
 * @param config - Settings from the bundle patch.
 */
export function apply(ctx: PluginContext, config: Config = {}): void {
  const settings = settingsOf(config)
  ctx.on('llm/stream', (request, next) => {
    try {
      sequence += 1
      const observed = snapshot(request)
      let file: string | undefined
      if (settings.file) {
        file = fileFor(request, sequence)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${JSON.stringify(observed, undefined, 2)}\n`)
      }
      if (settings.print === 'full') process.stderr.write(`${JSON.stringify(observed, undefined, 2)}\n`)
      else if (settings.print === 'summary') process.stderr.write(`${summarise(request, file)}\n`)
    } catch (error) {
      // The trace is an observer: a full disk or an unserializable field must not fail the call.
      process.stderr.write(`${name}: trace failed: ${String(error)}\n`)
    }
    return next()
  })
}
