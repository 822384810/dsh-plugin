/**
 * Wiki compilation: turning one ingested source into entity and concept pages.
 *
 * This is the step that makes the middle layer a Wiki rather than a set of summaries — a single
 * source typically touches many pages, updating concepts, creating entities, and marking
 * contradictions against what is already there.
 *
 * The `sources/` mirror is not written here: it belongs to ingestion, which materializes the parsed
 * text once and is its only writer, so a hand-corrected mirror is never overwritten by a compile.
 * Without a model nothing is compiled at all, and the source stays fully searchable through its
 * mirror.
 */
import { readFile, access } from 'node:fs/promises'
import path from 'node:path'
import type { LibraryRuntime } from './registry.ts'
import type { Indicator } from '../store/meta.ts'
import type { SearchHit } from '../shared/retrieval.ts'
import type { Logger } from '@dsh-plugins-xz/log-utils'
import { parseSchema, type ConflictBehavior } from '../shared/schema.ts'
import { parseFrontmatter } from '../shared/frontmatter.ts'
import { MIN_COMPILE_TOKENS } from '../config.ts'
import { LlmCallError, briefLlmDiagnostics } from './models.ts'
import { localDate } from '@dsh-plugins-xz/time-utils'
import { listWikiPages, refreshIndex, appendLog, writePage, isAllowedPagePath, type WikiPageSummary } from './pages.ts'
import { compareNumericIndicators, hasConflictMarker } from './conflicts.ts'

/** One page operation proposed by the model. */
interface CompileOp {
  readonly kind: 'create' | 'update'
  readonly path: string
  readonly content: string
}

/** What a compile run did. */
export interface CompileResult {
  readonly created: readonly string[]
  readonly updated: readonly string[]
  readonly conflicts: number
  /** Which compiler ran: the model, or the deterministic fallback. */
  readonly mode: 'llm' | 'deterministic'
}

/** Everything the compiler needs. */
export interface CompileInput {
  readonly library: LibraryRuntime
  /** POSIX path of the source relative to the library root. */
  readonly sourceRelPath: string
  readonly sourceText: string
  readonly indicators: readonly Indicator[]
  readonly retrieve: (query: string, topK: number) => Promise<SearchHit[]>
  /** Model completion, or null when no model is configured. */
  readonly complete: ((prompt: string, maxTokens: number) => Promise<string>) | null
  readonly log: Logger
  /** Characters of source text handed to the model per call. */
  readonly windowChars: number
  /** Upper bound on windows compiled for one source. */
  readonly maxWindows: number
  /** Starting output budget for one window's plan. */
  readonly maxTokens: number
  /** Highest output budget a truncated answer may be retried with. */
  readonly maxOutputTokens: number
  /** Model context window in tokens; prompt plus output must fit inside it. */
  readonly contextTokens: number
  /** Characters per token used to size source windows against the context window. */
  readonly charsPerToken: number
  /**
   * Called as windows finish, for a progress display.
   *
   * A window is one model call, and nothing observable happens inside it until it answers, so
   * windows are the only unit a caller can be told about.
   */
  readonly onProgress?: ((done: number, total: number) => void) | undefined
}

/** Attempts made before falling back to the deterministic compiler. */
const MAX_ATTEMPTS = 3

/**
 * How long to wait before the second attempt, the third, and any after them.
 *
 * The failures this retries are transport ones in practice — a dropped connection, a stream that
 * ended without its terminal event — and calls fired back to back land in the same moment of trouble
 * and come away with the same nothing. A pause gives a provider that is briefly overwhelmed room to
 * recover, while staying short enough that a real failure is still reported promptly.
 */
const RETRY_WAITS_MS = [1000, 4000]

/**
 * Tokens reserved for prompt scaffolding that is not source text: schema, the 40-page list,
 * related excerpts, indicator/conflict candidates and the output rules. The exact figure depends on
 * the schema, so the compiler also measures the assembled prompt before each call.
 */
const PROMPT_OVERHEAD_TOKENS = 12000

/** Smallest window a split is worth attempting on; halving a tiny window cannot rescue a plan. */
const MIN_SPLIT_WINDOW_CHARS = 2000

/** At most two halvings (1 -> 2 -> 4 pieces), so a pathological source cannot explode the calls. */
const MAX_SPLIT_DEPTH = 2

/** Budgets derived once per compile from the resolved settings. */
interface CompileBudget {
  /** Starting output budget for an ordinary window. */
  readonly floor: number
  /** Highest output budget a truncated answer may be retried with. */
  readonly ceiling: number
  /** Largest source window whose prompt is expected to fit the model context. */
  readonly windowCap: number
}

/** Outcome of planning one window. */
interface PlanAttempt {
  /** Operations, or null when every attempt failed. */
  readonly ops: readonly CompileOp[] | null
  /** Whether at least one attempt ran out of output budget. */
  readonly outputLimited: boolean
}

/** Window position plus a label identifying a split piece in logs. */
interface WindowPosition {
  readonly index: number
  readonly total: number
  readonly label: string
}

/**
 * Derive output budgets and the source-window cap from the model's context window.
 *
 * The ceiling is reserved in full even for a window starting at the floor, because a truncated
 * answer doubles up to it. What remains after the ceiling and prompt overhead is the input budget
 * for source text; the 20200-character hard cap still applies. With a 128k context and the default
 * 32768 ceiling this leaves ~83k characters, so the ~4M-character coverage is unchanged.
 */
function budgetOf(input: CompileInput): CompileBudget {
  const ceiling = Math.max(input.maxOutputTokens, MIN_COMPILE_TOKENS)
  const floor = Math.min(Math.max(input.maxTokens, MIN_COMPILE_TOKENS), ceiling)
  const ratio = input.charsPerToken > 0 ? input.charsPerToken : 1
  const inputTokens = Math.max(input.contextTokens - ceiling - PROMPT_OVERHEAD_TOKENS, 0)
  const windowCap = Math.max(
    MIN_WINDOW_CHARS,
    Math.min(MAX_WINDOW_CHARS, Math.floor(inputTokens * ratio)),
  )
  return { floor, ceiling, windowCap }
}

/**
 * Compile one source into the Wiki.
 * @param input - Library, source, retrieval and optional model.
 * @returns What the run did.
 */
export async function compileWiki(input: CompileInput): Promise<CompileResult> {
  const { library, sourceRelPath, log } = input
  const schema = await readFile(path.join(library.wikiDir, 'schema.md'), 'utf8').catch(() => '')
  const behavior = parseSchema(schema).conflictBehavior
  const pages = await listWikiPages(library.wikiDir)
  const numeric = compareNumericIndicators(input.indicators, library.meta.indicators(sourceRelPath))

  // A prompt can only list the most relevant pages, so a model may propose a new slug for a page
  // that already exists under another name. Rewrite those creates into updates before merging.
  const ops = mergeOps(dedupOps(
    await planOperations(input, schema, pages, numeric),
    buildDedupIndex(pages),
    log,
  ))
  const created: string[] = []
  const updated: string[] = []
  let conflicts = 0

  for (const op of ops) {
    if (!isAllowedPagePath(op.path)) {
      log.warn(`compile refused a page outside entities/concepts/sources: ${op.path}`)
      continue
    }
    const exists = await fileExists(path.join(library.wikiDir, op.path))
    if (exists && op.kind === 'create' && behavior === 'reject') continue
    await writePage(library.wikiDir, op.path, op.content)
    if (exists) updated.push(op.path)
    else created.push(op.path)
    if (hasConflictMarker(op.content)) conflicts++
  }

  await refreshIndex(library.wikiDir)
  await appendLog(library.wikiDir, { source: sourceRelPath, created, updated, conflicts })
  return { created, updated, conflicts, mode: input.complete === null ? 'deterministic' : 'llm' }
}

/**
 * Ask the model for a page plan, window by window, or fall back to the deterministic one.
 *
 * A long source is compiled in windows so the model actually reads all of it: each call only sees
 * `windowChars` characters, but every window is compiled and the resulting plans are folded
 * together. `maxWindows` bounds the number of calls; for a source too long for that many small
 * windows, `windowsOf` enlarges the windows instead of dropping the tail, up to the 4M budget.
 * @returns Operations to apply.
 */
async function planOperations(
  input: CompileInput,
  schema: string,
  pages: Awaited<ReturnType<typeof listWikiPages>>,
  numeric: ReturnType<typeof compareNumericIndicators>,
): Promise<CompileOp[]> {
  const complete = input.complete
  // With no model there is nothing to compile; the mirror is already searchable.
  if (complete === null) return []
  // A hoisted inner function does not retain the null check above, so hand it a non-null alias.
  const callModel: (prompt: string, maxTokens: number) => Promise<string> = complete
  const budget = budgetOf(input)
  // One date for the whole run, so every page the model writes carries the same `updated`.
  const today = localDate()
  const plan = windowsOf(input.sourceText, input.windowChars, input.maxWindows, budget.windowCap)
  const windows = plan.windows
  if (plan.windowChars > input.windowChars) {
    input.log.info(
      `compile ${input.sourceRelPath}: ${String(input.sourceText.length)} chars; window size raised from`
      + ` ${String(input.windowChars)} to ${String(plan.windowChars)} so ${String(windows.length)} window(s) cover the file`,
    )
  }
  if (plan.truncated) {
    input.log.warn(
      `compile stopped after ${String(windows.length)} window(s) of ${String(plan.windowChars)} chars for`
      + ` ${input.sourceRelPath}; the ~4M-character / maxWindows / context-window budget was reached, the rest was not compiled`,
    )
  }
  // An enlarged window asks for far more page JSON than a 2000-character one, so it starts at the
  // ceiling instead of wasting a first call on a near-certain truncation.
  const atCeiling = plan.windowChars > input.windowChars * 2
    || plan.windowChars > budget.ceiling / 2
  input.log.debug(
    `[compile-plan] source=${input.sourceRelPath} windows=${String(windows.length)}`
    + ` windowChars=${String(plan.windowChars)} atCeiling=${String(atCeiling)}`
    + ` output=${String(budget.floor)}..${String(budget.ceiling)}`
    + ` context=${String(input.contextTokens)}`,
  )

  /**
   * Plan one piece of source, splitting it when a context overflow is predicted or when the answer
   * ran out of output budget at the ceiling. Two smaller prompts each need roughly half the output
   * and start again at the floor, which restores room to double on a later retry.
   */
  async function planWindow(
    text: string,
    position: WindowPosition,
    startAtCeiling: boolean,
    depth: number,
  ): Promise<readonly CompileOp[] | null> {
    const canSplit = depth < MAX_SPLIT_DEPTH && text.length >= MIN_SPLIT_WINDOW_CHARS
    // Retrieval is per piece, so a later part of the file still gets its own relevant context.
    const related = await input.retrieve(text.slice(0, 800), 5)
    const prompt = buildPrompt({
      schema,
      pages,
      related,
      numeric,
      sourceRelPath: input.sourceRelPath,
      sourceText: text,
      window: { index: position.index, total: position.total },
      today,
      indicators: input.indicators,
    })
    // Measure the assembled prompt rather than trusting the fixed overhead estimate: a long custom
    // schema can exceed it. The ceiling is reserved in full because a retry may double up to it.
    const ratio = input.charsPerToken > 0 ? input.charsPerToken : 1
    const promptTokens = Math.ceil(prompt.length / ratio)
    const overflow = promptTokens + budget.ceiling > input.contextTokens
    if (overflow && canSplit) {
      input.log.warn(
        `compile window ${String(position.index)}/${String(position.total)}${position.label}`
        + ` needs ~${String(promptTokens)} input + ${String(budget.ceiling)} output tokens`
        + ` over a ${String(input.contextTokens)}-token context; splitting it`,
      )
      return planSplit(text, position, depth)
    }
    if (overflow) {
      input.log.warn(
        `compile window ${String(position.index)}/${String(position.total)}${position.label}`
        + ` may exceed the ${String(input.contextTokens)}-token context; it is already too small to split`,
      )
    }
    const attempt = await planOnce(input, prompt, callModel, position, budget, {
      atCeiling: startAtCeiling,
      canSplit,
    })
    if (attempt.ops !== null) return attempt.ops
    if (canSplit && attempt.outputLimited) {
      input.log.warn(
        `compile window ${String(position.index)}/${String(position.total)}${position.label}`
        + ` exhausted its output budget; splitting it into two smaller windows`,
      )
      return planSplit(text, position, depth)
    }
    return null
  }

  /** Halve a window with a shared overlap, then plan both halves at the lower starting budget. */
  async function planSplit(
    text: string,
    position: WindowPosition,
    depth: number,
  ): Promise<readonly CompileOp[] | null> {
    const mid = Math.floor(text.length / 2)
    const halves = [
      text.slice(0, mid + WINDOW_OVERLAP),
      text.slice(Math.max(mid - WINDOW_OVERLAP, 0)),
    ]
    const pieces: CompileOp[] = []
    let plannedAny = false
    for (const [index, half] of halves.entries()) {
      const part = await planWindow(half, {
        ...position,
        label: `${position.label} part ${String(index + 1)}/2`,
      }, false, depth + 1)
      if (part === null) continue
      plannedAny = true
      pieces.push(...part)
    }
    return plannedAny ? pieces : null
  }

  const collected: CompileOp[] = []
  let planned = 0
  for (const [index, window] of windows.entries()) {
    const position: WindowPosition = { index: index + 1, total: windows.length, label: '' }
    const ops = await planWindow(window, position, atCeiling, 0)
    // Reported whether or not the window produced a plan: the work is done either way, and a
    // progress bar that stalls on a failed window would look like a hung run.
    input.onProgress?.(index + 1, windows.length)
    if (ops === null) continue
    planned++
    collected.push(...ops)
  }
  if (planned === 0) {
    input.log.error(`compile failed for every window of ${input.sourceRelPath}; its mirror stays searchable`)
    return []
  }
  if (planned < windows.length) {
    input.log.warn(`compile planned ${String(planned)} of ${String(windows.length)} window(s) of ${input.sourceRelPath}`)
  }
  // An empty result is legitimate: every window may simply hold nothing worth a page.
  return mergeOps(collected)
}

/**
 * Plan one window, retrying the way a whole-source compile used to.
 *
 * A plan that parses but names no page is a success, not a failure: a window holding nothing worth
 * extracting is a legitimate answer, and retrying it would only burn tokens. Only output that
 * carries no plan at all is retried.
 * @param input - Library, source and settings of this compile.
 * @param prompt - The prompt for this window.
 * @param complete - Model call.
 * @param position - Which window this is, so a failure can be told from its neighbours'.
 * @param budget - Floor and ceiling output budgets derived from the model context.
 * @param options - Start at the ceiling, and whether a caller can still split this window.
 * @returns The operations and whether output budget caused a failure.
 */
async function planOnce(
  input: CompileInput,
  prompt: string,
  complete: (prompt: string, maxTokens: number) => Promise<string>,
  position: WindowPosition,
  budget: CompileBudget,
  options: { readonly atCeiling: boolean; readonly canSplit: boolean },
): Promise<PlanAttempt> {
  // An enlarged window starts at the ceiling because the floor would certainly truncate it. Once at
  // the ceiling there is no doubling room, so a truncation goes back to the caller for a split
  // instead of burning two more identical calls. max_tokens is only a ceiling — usage is billed.
  let maxTokens = options.atCeiling ? budget.ceiling : budget.floor
  const label = `${String(position.index)}/${String(position.total)}${position.label}`
  let outputLimited = false
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // The wait comes before a retry and never before the first attempt. The list is walked to its end
    // and then held there, so raising MAX_ATTEMPTS does not quietly stop spacing the later ones out.
    const pause = attempt > 1 ? RETRY_WAITS_MS[Math.min(attempt - 2, RETRY_WAITS_MS.length - 1)] ?? 0 : 0
    if (pause > 0) await wait(pause)
    // The first attempt also carries the one-off window facts; later rows stay short.
    input.log.debug(
      `compile window ${label} #${String(attempt)}/${String(MAX_ATTEMPTS)} max_tokens=${String(maxTokens)}`
      + (attempt === 1
        ? ` atCeiling=${String(options.atCeiling)} promptChars=${String(prompt.length)} canSplit=${String(options.canSplit)}`
        : ''),
    )
    let raw = ''
    try {
      raw = await complete(prompt, maxTokens)
      const parsed = parsePlan(raw)
      // The mirror belongs to ingestion; a compile only ever writes entity and concept pages.
      const ops = parsed.filter(op => isAllowedPagePath(op.path) && !op.path.startsWith('sources/'))
      if (parsed.length > 0 && ops.length === 0) {
        input.log.warn(`compile plan dropped every proposed page (paths outside entities/concepts); head: ${head(raw)}`)
      }
      return { ops, outputLimited: false }
    } catch (error) {
      // `complete` reports a max-tokens finish as an error, but its partial text may still end in
      // `}`/`]` and fool `looksTruncated`. Trust the finish reason too.
      const hitCeiling = looksTruncated(raw) !== '' || String(error).includes('maxTokens')
      // The full stream diagnosis is already one `[llm]` line; the warning carries only a summary.
      const call = error instanceof LlmCallError
        ? briefLlmDiagnostics(error.diagnostics)
        : 'no-stream-diagnostics'
      input.log.warn(
        `compile window ${label} #${String(attempt)}/${String(MAX_ATTEMPTS)} failed: ${String(error)}`
        + `; hitCeiling=${String(hitCeiling)}; [llm] ${call}`,
      )
      if (!hitCeiling) continue
      outputLimited = true
      if (maxTokens >= budget.ceiling) {
        if (options.canSplit) {
          input.log.warn(
            `compile window ${label} reached the ${String(budget.ceiling)} output ceiling;`
            + ' handing it back to be split into smaller windows',
          )
          return { ops: null, outputLimited: true }
        }
        // Nothing left to raise, and no split available: keep the remaining retries for transport
        // hiccups rather than silently giving up on the window.
        continue
      }
      const next = Math.min(maxTokens * 2, budget.ceiling)
      input.log.warn(
        `compile window ${label} output was truncated;`
        + ` retrying with max_tokens ${String(next)} instead of ${String(maxTokens)}`,
      )
      maxTokens = next
    }
  }
  return { ops: null, outputLimited }
}

/**
 * Wait for a while, leaving the loop free to keep serving everything else.
 * @param ms - Milliseconds to wait.
 * @returns A promise that settles when the wait is over.
 */
function wait(ms: number): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

/**
 * A hint for a answer that stops mid-structure, which is what running out of output tokens looks
 * like from here — the parse error alone never says so.
 * @param raw - Raw model answer.
 * @returns A clause to append to the log line, or an empty string.
 */
function looksTruncated(raw: string): string {
  const trimmed = raw.trimEnd()
  if (trimmed === '' || trimmed.endsWith('}') || trimmed.endsWith(']')) return ''
  return '; the answer stops mid-JSON, so compileMaxTokens/compileMaxOutputTokens may be too small'
}

/** Characters neighbouring windows share, so a sentence or table row is never cut in half. */
const WINDOW_OVERLAP = 200

/** Smallest window worth sending; a hand-edited setting below this is clamped up. */
const MIN_WINDOW_CHARS = 500

/** Total characters one compile may cover — the original 20000 × 200 ≈ 4M budget. */
const MAX_COMPILE_CHARS = 4_000_000

/** Ceiling for auto-enlarging a window; 200 windows of this size cover ~4M characters. */
const MAX_WINDOW_CHARS = 20200

/**
 * Slice a source into the windows sent to the model.
 *
 * Ordinary sources keep `windowChars` (2000 by default), so each call uses the small aligned
 * context. A source too long for `maxWindows` such slices is NOT left half-compiled: the window
 * size is raised just enough to read it end to end within the same number of calls, capped at
 * `MAX_WINDOW_CHARS` and at the context-derived `windowCap`. Only beyond `MAX_COMPILE_CHARS`, or
 * when the smaller cap forces more than `maxWindows` windows, is the tail reported and dropped.
 * @param text - Parsed source text.
 * @param windowChars - Target characters per window.
 * @param maxWindows - Upper bound on how many windows to produce.
 * @param windowCap - Largest window the model context can hold alongside the output budget.
 * @returns The windows in order, the size actually used, and whether a budget cut the source short.
 */
function windowsOf(
  text: string,
  windowChars: number,
  maxWindows: number,
  windowCap: number,
): { windows: string[]; truncated: boolean; windowChars: number } {
  const cap = Math.max(MIN_WINDOW_CHARS, Math.min(windowCap, MAX_WINDOW_CHARS))
  const floor = Math.min(Math.max(Math.trunc(windowChars), MIN_WINDOW_CHARS), cap)
  const limit = Math.max(Math.trunc(maxWindows), 1)
  if (text.length <= floor) return { windows: [text], truncated: false, windowChars: floor }
  const budget = Math.min(text.length, MAX_COMPILE_CHARS)
  // n windows of `size` sharing `overlap` cover (n-1)*(size-overlap)+size; solve that for size.
  const needed = Math.ceil((budget + (limit - 1) * WINDOW_OVERLAP) / limit)
  const size = Math.max(floor, Math.min(needed, cap))
  const stride = Math.max(size - WINDOW_OVERLAP, 1)
  const windows: string[] = []
  for (let start = 0; start < budget; start += stride) {
    if (windows.length >= limit) return { windows, truncated: true, windowChars: size }
    windows.push(text.slice(start, Math.min(start + size, budget)))
    if (start + size >= budget) {
      return { windows, truncated: budget < text.length, windowChars: size }
    }
  }
  return { windows, truncated: budget < text.length, windowChars: size }
}

/**
 * Fold each window's plan into one plan.
 *
 * The same page commonly appears in several windows. Rather than letting the last window overwrite
 * the others, the first occurrence keeps its frontmatter and every later occurrence contributes its
 * body, so a page accumulates everything the source said about it.
 * @param ops - Operations in window order.
 * @returns One operation per path, first-seen order preserved.
 */
function mergeOps(ops: readonly CompileOp[]): CompileOp[] {
  const merged = new Map<string, CompileOp>()
  for (const op of ops) {
    const existing = merged.get(op.path)
    if (existing === undefined) {
      merged.set(op.path, op)
      continue
    }
    const body = withoutFrontmatter(op.content).trim()
    if (body === '' || existing.content.includes(body)) continue
    merged.set(op.path, { ...existing, content: `${existing.content.trimEnd()}\n\n${body}\n` })
  }
  return [...merged.values()]
}

/** Normalize a page identity, so "the same entity under a different spelling" compares equal. */
function dedupKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-—–·.,，。:：;；!！?？()（）\[\]【】{}"'“”‘’`\/\\|]+/g, '')
}

/**
 * Index of existing pages by normalized slug/title → path.
 *
 * When one key already matches several pages, prefer the ASCII slug (the project's canonical
 * naming); if that is still ambiguous, drop the match rather than merging into an unrelated page.
 */
function buildDedupIndex(pages: readonly WikiPageSummary[]): Map<string, string> {
  const byKey = new Map<string, string[]>()
  for (const page of pages) {
    if (!page.path.startsWith('entities/') && !page.path.startsWith('concepts/')) continue
    for (const raw of [path.posix.basename(page.path, '.md'), page.title]) {
      const key = dedupKey(raw)
      if (key.length < 2) continue
      const paths = byKey.get(key) ?? []
      if (!paths.includes(page.path)) paths.push(page.path)
      byKey.set(key, paths)
    }
  }
  const index = new Map<string, string>()
  for (const [key, paths] of byKey) {
    const only = paths[0]
    if (paths.length === 1) {
      if (only !== undefined) index.set(key, only)
      continue
    }
    const ascii = paths.filter(candidate => /^[\x20-\x7E]+$/.test(path.posix.basename(candidate, '.md')))
    const onlyAscii = ascii[0]
    if (ascii.length === 1 && onlyAscii !== undefined) index.set(key, onlyAscii)
  }
  return index
}

/** Whether a `create` actually points at an existing page, by slug or frontmatter title. */
function existingTarget(index: Map<string, string>, op: CompileOp): string | null {
  const pathKey = dedupKey(path.posix.basename(op.path, '.md'))
  const fromPath = pathKey.length >= 2 ? index.get(pathKey) : undefined
  if (fromPath !== undefined) return fromPath
  const titleKey = dedupKey(parseFrontmatter(op.content)['title'] ?? '')
  const fromTitle = titleKey.length >= 2 ? index.get(titleKey) : undefined
  return fromTitle ?? null
}

/**
 * Rewrite a `create` that names an already-existing page under a different slug into an update.
 * The prompt can only list the most relevant pages, so the model may not know the old name.
 */
function dedupOps(ops: readonly CompileOp[], index: Map<string, string>, log: Logger): CompileOp[] {
  return ops.map((op): CompileOp => {
    if (op.kind !== 'create') return op
    const target = existingTarget(index, op)
    if (target === null || target === op.path) return op
    log.info(`compile dedup: ${op.path} matches existing page ${target}; rewritten as update`)
    return { ...op, kind: 'update', path: target }
  })
}

/**
 * Page content with a leading YAML frontmatter block removed.
 * @param content - Full page content.
 * @returns The body, or the content unchanged when it carries no frontmatter.
 */
function withoutFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content)
  return match === null ? content : content.slice(match[0].length)
}

/**
 * First characters of a model response, flattened onto one line for logging.
 * @param text - Raw model output.
 * @param limit - Maximum characters to keep.
 * @returns A single-line excerpt, or a marker when the response was empty.
 */
function head(text: string, limit = 300): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened === '') return '（空响应）'
  return flattened.length > limit ? `${flattened.slice(0, limit)}…` : flattened
}

/** Hard cap on pages listed in a prompt: the relevant subset must not grow with the library. */
const MAX_PROMPT_PAGES = 40

/**
 * Pick the pages most relevant to this window, so a large library cannot blow up the prompt.
 * Retrieval hits rank first, then titles/slugs that literally occur in the window text.
 */
function promptPages(
  pages: readonly WikiPageSummary[],
  related: readonly SearchHit[],
  sourceText: string,
): { listed: WikiPageSummary[]; total: number } {
  const writable = pages.filter(page => page.path.startsWith('entities/') || page.path.startsWith('concepts/'))
  const byPath = new Map(writable.map(page => [page.path, page]))
  const scores = new Map<string, number>()
  const bump = (page: WikiPageSummary, score: number): void => {
    scores.set(page.path, (scores.get(page.path) ?? 0) + score)
  }
  for (const hit of related) {
    const page = byPath.get(hit.sourcePath.replace(/^wiki\//, ''))
    if (page !== undefined) bump(page, 1000)
  }
  const haystack = dedupKey(sourceText)
  for (const page of writable) {
    const titleKey = dedupKey(page.title)
    if (titleKey.length >= 2 && haystack.includes(titleKey)) bump(page, titleKey.length * 10)
    const baseKey = dedupKey(path.posix.basename(page.path, '.md'))
    if (baseKey.length >= 2 && haystack.includes(baseKey)) bump(page, baseKey.length)
  }
  const listed = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_PROMPT_PAGES)
    .map(([pagePath]) => byPath.get(pagePath))
    .filter((page): page is WikiPageSummary => page !== undefined)
  return { listed, total: writable.length }
}

/** Prompt asking the model how one window of a new source changes the Wiki. */
function buildPrompt(args: {
  schema: string
  pages: Awaited<ReturnType<typeof listWikiPages>>
  related: readonly SearchHit[]
  numeric: ReturnType<typeof compareNumericIndicators>
  sourceRelPath: string
  sourceText: string
  window: { index: number; total: number }
  today: string
  indicators: readonly Indicator[]
}): string {
  // A full page list grows with the library and eventually blows up the prompt; only the pages
  // relevant to this window are listed. dedupOps covers the rest before anything is written.
  const { listed, total } = promptPages(args.pages, args.related, args.sourceText)
  const pageList = listed.length === 0
    ? '（本段未匹配到已有页面）'
    : listed
        .map(page => {
          const base = path.posix.basename(page.path, '.md')
          return page.title !== '' && page.title !== base ? `- ${page.path} — ${page.title}` : `- ${page.path}`
        })
        .join('\n')
  const context = args.related
    .map((hit, index) => `[${String(index + 1)}] 来源:${hit.sourcePath}\n${hit.content.slice(0, 400)}`)
    .join('\n\n') || '（无相关页面）'
  const indicatorText = args.indicators.length > 0
    ? JSON.stringify(args.indicators.slice(0, 30), undefined, 2)
    : '（未抽取到指标）'
  const numericText = args.numeric.length > 0
    ? JSON.stringify(args.numeric.slice(0, 20), undefined, 2)
    : '（算法未发现数值冲突候选）'
  return `你是知识库维护者。请根据 Schema 规则，决定如何把新来源编译进 Wiki。

# Schema
${args.schema}

# 已有 Wiki 页面（共 ${String(total)} 页，本段仅列最相关的 ${String(listed.length)} 页）
${pageList}

# 与新来源相关的已有片段
${context}

# 新来源
路径：${args.sourceRelPath}
本段：第 ${String(args.window.index)} / ${String(args.window.total)} 段（同一文件分段送入，每段单独处理）
结构化指标：
${indicatorText}

算法预检的数值冲突候选：
${numericText}

本段正文：
${args.sourceText}

# 输出要求
严格输出 JSON，不要任何解释文字或 markdown 代码围栏：
{
  "operations": [
    {
      "kind": "create" | "update",
      "path": "entities/GB_50016-2014.md",
      "content": "完整 markdown 文件内容，含 YAML frontmatter，符合 Schema"
    }
  ]
}

规则：
1. 路径只能是 entities/、concepts/ 之下的 .md 文件。不要生成 sources/ 页面，该页由系统维护。
2. 每个页面的 frontmatter 必须含 title/type/updated，updated 一律写 ${args.today}。
3. 若本段与已有内容存在指标宽严不一、条款互斥或术语矛盾，在相关页面插入
   > ⚠️ **潜在冲突** [严重度：高|中|低]
   > - 类型：...
   > - 标准 A：...
   > - 标准 B：...
   > - 判定：...
   > - 建议：...
   请优先采纳算法预检的候选冲突。
4. 只处理本段出现的内容，不要臆测其它段落。
5. 页面清单只列与本段相关的页；未列出的页面可能已存在。新建页面请用规范的 ASCII slug，系统会与已有页面去重。
6. 不要输出除 JSON 之外的任何字符。`
}

/**
 * Parse the model's plan, tolerating a code fence around it.
 * @param raw - Raw model output.
 * @returns The proposed operations.
 * @throws when the output carries no usable JSON plan.
 */
export function parsePlan(raw: string): CompileOp[] {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
  // The prompt asks for `{"operations": [...]}`; a model may answer with the bare array instead, and
  // prose around either. `"operations"` settles the shape when it is there, a leading `[` when it
  // is not — so a near miss costs one bracket rather than a whole window's plan. Reading the wrong
  // pair is what turns a bare array into "unexpected character after JSON".
  const bareArray = !text.includes('"operations"')
    && text.indexOf('[') >= 0
    && (text.indexOf('{') < 0 || text.indexOf('[') < text.indexOf('{'))
  const slice = bracketSlice(text, bareArray ? '[' : '{', bareArray ? ']' : '}')
  if (slice === null) throw new Error('model returned no JSON plan')
  const parsed = JSON.parse(slice) as unknown
  const list = Array.isArray(parsed) ? parsed : (parsed as { operations?: unknown }).operations
  if (!Array.isArray(list)) throw new Error('plan has no operations array')
  return list.flatMap((entry): CompileOp[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const op = entry as Record<string, unknown>
    const kind = op['kind'] === 'update' ? 'update' : 'create'
    const pagePath = typeof op['path'] === 'string' ? op['path'] : ''
    const content = typeof op['content'] === 'string' ? op['content'] : ''
    if (pagePath === '' || content === '') return []
    return [{ kind, path: pagePath, content }]
  })
}

/**
 * The outermost `open`…`close` slice of a model answer, prose and code fences included.
 * @param text - The answer, already stripped of its fences.
 * @param open - Opening bracket to look for.
 * @param close - Matching closing bracket.
 * @returns The slice, or null when the answer holds no such pair.
 */
function bracketSlice(text: string, open: string, close: string): string | null {
  const begin = text.indexOf(open)
  const end = text.lastIndexOf(close)
  return begin < 0 || end <= begin ? null : text.slice(begin, end + 1)
}

/** Whether a path exists. */
async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/** Re-exported so callers can log the policy they applied. */
export type { ConflictBehavior }
