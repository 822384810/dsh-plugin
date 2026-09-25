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
import { localDate } from '@dsh-plugins-xz/time-utils'
import { listWikiPages, refreshIndex, appendLog, writePage, isAllowedPagePath } from './pages.ts'
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
  readonly retrieve: (query: string, topK: number) => SearchHit[]
  /** Model completion, or null when no model is configured. */
  readonly complete: ((prompt: string, maxTokens: number) => Promise<string>) | null
  readonly log: Logger
  /** Characters of source text handed to the model per call. */
  readonly windowChars: number
  /** Upper bound on windows compiled for one source. */
  readonly maxWindows: number
  /** Output-token ceiling for one window's plan. */
  readonly maxTokens: number
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

  const ops = await planOperations(input, schema, pages, numeric)
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
 * together. `maxWindows` bounds what one pathologically large file may cost.
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
  // One date for the whole run, so every page the model writes carries the same `updated`.
  const today = localDate()
  const { windows, truncated } = windowsOf(input.sourceText, input.windowChars, input.maxWindows)
  if (truncated) {
    input.log.warn(`compile stopped after ${String(windows.length)} window(s) of ${input.sourceRelPath}; the rest of the file was not compiled`)
  }
  const collected: CompileOp[] = []
  let planned = 0
  for (const [index, window] of windows.entries()) {
    // Retrieval is per window, so a later part of the file still gets its own relevant context.
    const related = input.retrieve(window.slice(0, 800), 5)
    const position = { index: index + 1, total: windows.length }
    const prompt = buildPrompt({
      schema,
      pages,
      related,
      numeric,
      sourceRelPath: input.sourceRelPath,
      sourceText: window,
      window: position,
      today,
      indicators: input.indicators,
    })
    const ops = await planOnce(input, prompt, complete, position)
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
 * @returns The window's operations, or null when every attempt failed.
 */
async function planOnce(
  input: CompileInput,
  prompt: string,
  complete: (prompt: string, maxTokens: number) => Promise<string>,
  position: { readonly index: number; readonly total: number },
): Promise<CompileOp[] | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // The wait comes before a retry and never before the first attempt. The list is walked to its end
    // and then held there, so raising MAX_ATTEMPTS does not quietly stop spacing the later ones out.
    const pause = attempt > 1 ? RETRY_WAITS_MS[Math.min(attempt - 2, RETRY_WAITS_MS.length - 1)] ?? 0 : 0
    if (pause > 0) await wait(pause)
    let raw = ''
    try {
      raw = await complete(prompt, input.maxTokens)
      const parsed = parsePlan(raw)
      // The mirror belongs to ingestion; a compile only ever writes entity and concept pages.
      const ops = parsed.filter(op => isAllowedPagePath(op.path) && !op.path.startsWith('sources/'))
      if (parsed.length > 0 && ops.length === 0) {
        input.log.warn(`compile plan dropped every proposed page (paths outside entities/concepts); head: ${head(raw)}`)
      }
      return ops
    } catch (error) {
      // The raw output is the only way to tell prose from a truncated or empty answer; without it
      // the log just repeats "no JSON plan" and hides the cause.
      input.log.warn(
        `compile window ${String(position.index)}/${String(position.total)} attempt ${String(attempt)}/${String(MAX_ATTEMPTS)}`
        + ` failed: ${String(error)}${looksTruncated(raw)}; head: ${head(raw)}`,
      )
    }
  }
  return null
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
  return '; the answer stops mid-JSON, so compileMaxTokens may be too small'
}

/** Characters neighbouring windows share, so a sentence or table row is never cut in half. */
const WINDOW_OVERLAP = 200

/** Smallest window worth sending; a hand-edited setting below this is clamped up. */
const MIN_WINDOW_CHARS = 500

/**
 * Slice a source into the windows sent to the model.
 * @param text - Parsed source text.
 * @param windowChars - Target characters per window.
 * @param maxWindows - Upper bound on how many windows to produce.
 * @returns The windows in order, and whether the bound cut the source short.
 */
function windowsOf(text: string, windowChars: number, maxWindows: number): { windows: string[]; truncated: boolean } {
  const size = Math.max(Math.trunc(windowChars), MIN_WINDOW_CHARS)
  const limit = Math.max(Math.trunc(maxWindows), 1)
  if (text.length <= size) return { windows: [text], truncated: false }
  const stride = Math.max(size - WINDOW_OVERLAP, 1)
  const windows: string[] = []
  for (let start = 0; start < text.length; start += stride) {
    if (windows.length >= limit) return { windows, truncated: true }
    windows.push(text.slice(start, start + size))
    if (start + size >= text.length) return { windows, truncated: false }
  }
  return { windows, truncated: false }
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
  const pageList = args.pages.map(page => `- ${page.path} (${page.type}) ${page.title}`).join('\n') || '（暂无）'
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

# 已有 Wiki 页面
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
5. 不要输出除 JSON 之外的任何字符。`
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
