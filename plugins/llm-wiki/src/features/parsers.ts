/**
 * Source parsing.
 *
 * Every parser beyond plain text is an optional package. A missing one fails that file with
 * an actionable message rather than the whole ingest run, so a library still builds from the
 * formats the host can actually read.
 */
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeBuffer } from '../shared/encoding.ts'
import { normalizeText } from '../shared/chunk.ts'
import { importOptional } from '../shared/optional.ts'
import type { Logger } from '@dsh-plugins-xz/log-utils'
import { PpOcrEngine } from './ocr-ppocr.ts'

/** One parsed source. */
export interface ParsedDocument {
  readonly text: string
  /** Parser that produced the text, recorded so failures are explainable. */
  readonly parser: string
  readonly pages: number
}

/** Extensions read as plain text, after encoding detection. */
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.yaml', '.yml', '.xml', '.log', '.ini', '.cfg'])

/** Extensions with a dedicated parser of their own. */
const BINARY_EXTENSIONS = new Set(['.pdf', '.docx', '.html', '.htm'])

/** Every extension this plugin can turn into text on its own. */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([...TEXT_EXTENSIONS, ...BINARY_EXTENSIONS])

/**
 * Extensions this plugin accepts, including any a deployment added.
 * @param extra - Additional extensions the deployment opted into.
 * @returns Sorted, dot-prefixed extensions.
 */
export function supportedExtensions(extra: readonly string[] = []): readonly string[] {
  return [...new Set([...SUPPORTED_EXTENSIONS, ...extra])].sort()
}

/**
 * Whether a file is a source this plugin knows how to parse.
 *
 * An extension outside the list is refused rather than decoded as text: a PDF the parser cannot
 * read, a spreadsheet or an image decoded as UTF-8 is mojibake, and indexing it would poison both
 * retrieval and every compile that reads the index.
 * @param fileName - File name or path; only its extension is read.
 * @param extra - Additional extensions the deployment opted into.
 * @returns True when the extension is supported.
 */
export function isSupportedSource(fileName: string, extra: readonly string[] = []): boolean {
  const ext = path.extname(fileName).toLowerCase()
  return SUPPORTED_EXTENSIONS.has(ext) || extra.includes(ext)
}

/** Which OCR engine a scanned PDF is read with. */
export type OcrEngine = 'auto' | 'ppocr' | 'tesseract'

/** OCR settings threaded from the deployment config into the PDF parser. */
export interface OcrOptions {
  /** Engine choice; `auto` prefers PP-OCR when its models are present, else Tesseract. */
  readonly engine: OcrEngine
  /** PP-OCR model directory override; empty uses the models bundled under the package's `models/ppocr/`. */
  readonly modelDir: string
  /** Tesseract languages, used only on the Tesseract path. */
  readonly languages: string
  /** Tesseract language-data directory or URL; empty uses the bundled data. */
  readonly langPath: string
  /** Rasterization scale for the PP-OCR path; higher keeps small print legible. */
  readonly renderScale: number
}

/**
 * Read a source file into text.
 * @param absPath - Absolute path of the file.
 * @param ocr - OCR engine settings for scanned or corrupt-text PDFs.
 * @param extraExtensions - Additional extensions the deployment opted into, read as text.
 * @returns The parsed document.
 * @throws when the extension is unsupported, the format needs a package that is not installed, or
 * the file is unreadable.
 */
export async function parseSource(
  absPath: string,
  ocr: OcrOptions,
  extraExtensions: readonly string[] = [],
  log?: Logger,
): Promise<ParsedDocument> {
  const ext = path.extname(absPath).toLowerCase()
  if (ext === '.pdf') return await parsePdf(absPath, ocr, log)
  if (ext === '.docx') return await parseDocx(absPath)
  if (ext === '.html' || ext === '.htm') return await parseHtml(absPath)
  if (TEXT_EXTENSIONS.has(ext) || extraExtensions.includes(ext)) return await parseText(absPath)
  // Anything else is either a format with no parser or an opaque binary; decoding it as text would
  // index mojibake, so it is refused here instead of silently poisoning the library.
  throw new Error(
    `不支持的文件类型 ${ext === '' ? '(无扩展名)' : `"${ext}"`}；可用类型：${supportedExtensions(extraExtensions).join(' ')}`,
  )
}

/** Decode a text file, detecting legacy encodings. */
async function parseText(absPath: string): Promise<ParsedDocument> {
  const buffer = await readFile(absPath)
  return { text: normalizeText(await decodeBuffer(buffer)), parser: 'text', pages: 0 }
}

/** Decode and de-tag an HTML file. */
async function parseHtml(absPath: string): Promise<ParsedDocument> {
  const buffer = await readFile(absPath)
  const html = await decodeBuffer(buffer)
  return { text: normalizeText(htmlToMarkdown(html)), parser: 'html', pages: 0 }
}

/** Extract DOCX text through `mammoth`, keeping tables as Markdown tables. */
async function parseDocx(absPath: string): Promise<ParsedDocument> {
  const mammoth = await importOptional<typeof import('mammoth')>('mammoth')
  if (mammoth === null) throw new Error('reading .docx needs the optional "mammoth" package')
  const buffer = await readFile(absPath)
  // Node's mammoth accepts `path` or `buffer`; passing `arrayBuffer` (the browser
  // shape) falls through to its "Could not find file in options" error.
  const result = await mammoth.convertToHtml(
    { buffer },
    { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
  )
  return { text: normalizeText(htmlToMarkdown(result.value)), parser: 'docx', pages: 0 }
}

/**
 * Extract PDF text through pdf.js, restoring reading order and paragraph shape from the text layer.
 * @param absPath - Absolute path of the PDF.
 * @param ocr - OCR engine settings, used only when the page has no (or a corrupt) text layer.
 */
async function parsePdf(absPath: string, ocr: OcrOptions, log?: Logger): Promise<ParsedDocument> {
  const pdfjs = await importOptional<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>(
    'pdfjs-dist/legacy/build/pdf.mjs',
  )
  if (pdfjs === null) throw new Error('reading .pdf needs the optional "pdfjs-dist" package')
  const buffer = await readFile(absPath)
  // verbosity 0 = errors only; keeps noisy font warnings (e.g. Type 1 charstring)
  // out of the host log while real failures still surface.
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 })
  const doc = await loadingTask.promise
  try {
    const pages: string[] = []
    let textless = 0
    for (let index = 1; index <= doc.numPages; index++) {
      const page = await doc.getPage(index)
      const content = await page.getTextContent()
      const text = pageToMarkdown(pageLines(content.items))
      if (text.trim().length < 50) textless++
      pages.push(text)
    }
    const pageCount = doc.numPages
    const combined = assemblePages(pages)
    // A PDF can carry a text layer that is present but corrupt — Chinese standards
    // PDFs often ship a broken ToUnicode map or encoding, so extraction yields
    // Private-Use-Area code points / replacement characters instead of real glyphs.
    // Such garbage must be rasterized and OCR'd rather than indexed as-is.
    const scanned = pageCount > 0 && textless / pageCount > 0.5
    if (scanned || (pageCount > 0 && looksGarbled(combined))) {
      const result = await ocrPdf(doc, ocr, log)
      return { text: normalizeText(assemblePages(result.pages)), parser: result.parser, pages: pageCount }
    }
    return { text: normalizeText(combined), parser: 'pdf', pages: pageCount }
  } finally {
    await loadingTask.destroy()
  }
}

/** How many lines at either end of a page a running head or foot can occupy. */
const RUNNING_SLOTS = 2

/** Longest a line may be and still count as a running head. */
const RUNNING_MAX_CHARS = 40

/**
 * Join one document's pages, minus the line a printed document repeats on every one of them.
 * @param pages - One entry per page, in reading order.
 * @returns The document's text.
 */
function assemblePages(pages: readonly string[]): string {
  return dropRunningHeads(pages)
    .map(page => page.trim())
    .filter(page => page !== '')
    .join('\n\n')
}

/**
 * Normalize a line for comparison across pages.
 *
 * Whitespace is collapsed and digits are masked, so `第 12 页` and `第 13 页` compare equal while real
 * sentences stay distinct. A line too long to be a running head returns empty and never matches.
 * @param line - One line of a page.
 * @returns The comparison key, or `''` when the line cannot be a running head.
 */
function runningKey(line: string): string {
  const trimmed = line.replace(/\s+/g, ' ').trim()
  if (trimmed === '' || trimmed.length > RUNNING_MAX_CHARS) return ''
  return trimmed.replace(/\d/g, '#')
}

/**
 * Whether two candidates are the same line as the scanner saw it.
 *
 * A running head comes back as `GB 11767—2003` from one page and `GB 11767 一 2003` from the next —
 * the dash is read as an em dash, a space or the character 一. Comparing them exactly would file the
 * same line under several shapes and drop none of them, so they are matched instead.
 * @param left - One normalized candidate.
 * @param right - The other.
 * @returns True when the two differ by no more than a couple of characters.
 */
function sameShape(left: string, right: string): boolean {
  if (left === right) return true
  // Digits are already masked, so what is left to differ is recognition noise: a quarter of the
  // characters is enough to absorb a misread dash without letting two different sentences match.
  const limit = Math.min(6, Math.max(2, Math.ceil(Math.max(left.length, right.length) * 0.3)))
  if (Math.abs(left.length - right.length) > limit) return false
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row++) {
    const current: number[] = [row]
    for (let column = 1; column <= right.length; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      current.push(Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost,
      ))
    }
    previous = current
  }
  return (previous[right.length] ?? 0) <= limit
}

/**
 * Drop the lines a printed document repeats at the top and the foot of every page.
 *
 * A standard prints its number at the head and the page number at the foot of all hundred pages, so
 * the same two lines reach the mirror two hundred times: they match nearly every query, crowd real
 * text out of a chunk, and tell a reader nothing — the source's own path already carries the
 * document number. Only the first and last two lines of a page are candidates, and only a shape that
 * most pages share is removed, so a sentence repeated inside the body is left alone.
 * @param pages - One entry per page, in reading order.
 * @returns The pages without their running heads and feet.
 */
function dropRunningHeads(pages: readonly string[]): string[] {
  if (pages.length < 3) return [...pages]
  const slots = pages.map(page => {
    const lines = page.split('\n')
    const indices: number[] = []
    for (let index = 0; index < lines.length && indices.length < RUNNING_SLOTS; index++) {
      if ((lines[index] ?? '').trim() !== '') indices.push(index)
    }
    for (let index = lines.length - 1; index >= 0 && indices.length < RUNNING_SLOTS * 2; index--) {
      if ((lines[index] ?? '').trim() !== '') indices.push(index)
    }
    return indices
  })
  // Candidates are gathered into shapes, each remembering which pages it came from.
  const shapes: { readonly key: string; readonly pages: Set<number> }[] = []
  slots.forEach((indices, page) => {
    const lines = pages[page]?.split('\n') ?? []
    for (const index of new Set(indices)) {
      const key = runningKey(lines[index] ?? '')
      if (key === '') continue
      const shape = shapes.find(candidate => sameShape(candidate.key, key))
      if (shape === undefined) shapes.push({ key, pages: new Set([page]) })
      else shape.pages.add(page)
    }
  })
  const shared = shapes
    .filter(shape => shape.pages.size >= Math.max(3, Math.ceil(pages.length * 0.6)))
    .map(shape => shape.key)
  if (shared.length === 0) return [...pages]
  return pages.map((page, index) => {
    const candidates = new Set(slots[index] ?? [])
    return page
      .split('\n')
      .filter((line, position) => {
        if (!candidates.has(position)) return true
        const key = runningKey(line)
        return key === '' || !shared.some(shape => sameShape(shape, key))
      })
      .join('\n')
  })
}

/**
 * Median of a list of numbers.
 * @param values - The numbers to measure.
 * @returns The median, or 0 when there is nothing to measure.
 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** One line rebuilt from a PDF page, with the signals its shape is derived from. */
interface PdfLine {
  readonly text: string
  /** Baseline y; lower on the page means a smaller value. */
  readonly y: number
  /** Font size of the tallest run on the line. */
  readonly size: number
}

/** A text run as pdf.js reports it, described structurally so the optional import stays loose. */
interface PdfTextItem {
  readonly str: string
  readonly transform: readonly number[]
  readonly height?: number
}

/** One line while its runs are still being collected. */
interface LineDraft {
  readonly y: number
  size: number
  readonly parts: { x: number; str: string }[]
}

/** Whether an entry of `TextContent.items` is a text run rather than a layout marker. */
function isTextItem(item: unknown): item is PdfTextItem {
  const candidate = item as { str?: unknown; transform?: unknown }
  return typeof candidate.str === 'string' && Array.isArray(candidate.transform)
}

/**
 * Rebuild one page's lines from the runs `getTextContent()` returns.
 *
 * Runs are split wherever the font, the direction or the position changes — not at line ends — so
 * they are clustered by baseline first and then read left to right. Clustering within a fraction of
 * the line height keeps runs whose baselines differ by a hair on the line they belong to, which
 * rounding them all to whole points could not do.
 * @param items - `TextContent.items` of a single page.
 * @returns The page's lines, top to bottom.
 */
function pageLines(items: readonly unknown[]): PdfLine[] {
  const runs: { readonly str: string; readonly x: number; readonly y: number; readonly size: number }[] = []
  for (const item of items) {
    if (!isTextItem(item) || item.str === '') continue
    const transform = item.transform
    runs.push({
      str: item.str,
      x: transform[4] ?? 0,
      y: transform[5] ?? 0,
      size: item.height ?? Math.abs(transform[3] ?? 0),
    })
  }
  if (runs.length === 0) return []
  const sizes = runs.map(run => run.size).sort((left, right) => left - right)
  const tolerance = Math.max(0.5, (sizes[Math.floor(sizes.length / 2)] ?? 0) * 0.35)
  const ordered = [...runs].sort((left, right) => right.y - left.y || left.x - right.x)
  const lines: PdfLine[] = []
  let draft: LineDraft | null = null
  for (const run of ordered) {
    if (draft === null || Math.abs(run.y - draft.y) > tolerance) {
      if (draft !== null) lines.push(finishLine(draft))
      draft = { y: run.y, size: run.size, parts: [{ x: run.x, str: run.str }] }
      continue
    }
    draft.parts.push({ x: run.x, str: run.str })
    draft.size = Math.max(draft.size, run.size)
  }
  if (draft !== null) lines.push(finishLine(draft))
  return lines
}

/** Order one line's runs and glue them into text. */
function finishLine(draft: LineDraft): PdfLine {
  const parts = [...draft.parts].sort((left, right) => left.x - right.x)
  let text = ''
  for (const part of parts) {
    text += `${text === '' ? '' : separatorBetween(text, part.str)}${part.str}`
  }
  return { text: removeCjkSpacing(text.trim()), y: draft.y, size: draft.size }
}

/**
 * The separator two adjacent runs need.
 *
 * A run boundary is a font change or a reposition, not a word boundary, so Latin runs need a space
 * put back between them while two CJK runs must not get one: `不` + `得大于` has to read `不得大于`.
 * Restoring that is what makes clause text matchable again.
 * @param previous - Text collected so far on the line.
 * @param next - The run being appended.
 * @returns `''` or a single space.
 */
function separatorBetween(previous: string, next: string): string {
  const left = previous.slice(-1)
  const right = next.slice(0, 1)
  if (left === '' || right === '') return ''
  if (/\s/.test(left) || /\s/.test(right)) return ''
  return isCjk(left) && isCjk(right) ? '' : ' '
}

/** Whether a character is CJK — an ideograph, kana, or CJK/full-width punctuation. */
function isCjk(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return (code >= 0x2E80 && code <= 0x9FFF)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0x2000 && code <= 0x206F)
    || (code >= 0x3000 && code <= 0x303F)
    || (code >= 0xFE30 && code <= 0xFE4F)
    || (code >= 0xFF00 && code <= 0xFFEF)
}

/**
 * A space with CJK text on both sides — never the document's, always the layout's.
 *
 * The ranges are the ones `isCjk` accepts. Only horizontal spaces are matched, so a line break
 * between two characters — which carries structure — is left alone.
 */
const CJK_GAP = /([\u2E80-\u9FFF\uF900-\uFAFF\u2000-\u206F\u3000-\u303F\uFE30-\uFE4F\uFF00-\uFFEF])[ \t\u00A0]+(?=[\u2E80-\u9FFF\uF900-\uFAFF\u2000-\u206F\u3000-\u303F\uFE30-\uFE4F\uFF00-\uFFEF])/g

/**
 * Drop the spaces that were put between CJK characters rather than written on the page.
 *
 * Two sources produce them: a PDF whose text layer emits one run per glyph, and Tesseract, whose
 * Chinese models segment every character and separate them with spaces. Neither language spaces its
 * characters, so a space with CJK on both sides cannot be the document's — and it is not harmless,
 * because `不 得 大 于` no longer matches the clause it was extracted from. A space next to Latin text
 * is left as it is, which keeps `DVR 图像质量` readable.
 * @param text - Text as parsed or recognized.
 * @returns The text with those spaces removed.
 */
function removeCjkSpacing(text: string): string {
  // Each match consumes its left character and the spaces after it, so a run of them is closed up in
  // a single pass without needing to repeat.
  return text.replace(CJK_GAP, '$1')
}

/**
 * Render one page's lines as Markdown.
 *
 * Line breaks are kept — they are what the text layer actually knows — and blank lines are put back
 * where the page itself separates: at a heading, right after one, at a font-size change, and wherever
 * the leading widens past the page's usual pitch. That is the difference between forty unrelated
 * lines and the paragraphs a reader sees.
 * @param lines - The page's lines, top to bottom.
 * @returns Markdown for that page.
 */
function pageToMarkdown(lines: readonly PdfLine[]): string {
  const body = bodySize(lines)
  const pitch = medianPitch(lines)
  const out: string[] = []
  let previous: PdfLine | null = null
  let previousLevel = 0
  for (const line of lines) {
    if (line.text === '') continue
    const level = headingLevel(line, body)
    const breaks = out.length > 0 && (
      previousLevel > 0
      || level > 0
      || (previous !== null && line.size / body >= 1.12)
      || (previous !== null && pitch > 0 && previous.y - line.y > pitch * 1.45)
    )
    if (breaks) out.push('')
    out.push(level === 0 ? line.text : `${'#'.repeat(level)} ${line.text}`)
    previous = line
    previousLevel = level
  }
  return mergeHyphenated(out.join('\n'))
}

/**
 * The font size most of the page is set in.
 *
 * A page is body text with a few larger headings, so the size carrying the most characters wins —
 * measuring by lines instead would let a run of big titles or a table of small print pass for the
 * body. Sizes are bucketed to half points so near-identical values still group.
 * @param lines - The page's lines.
 * @returns The body font size, never zero.
 */
function bodySize(lines: readonly PdfLine[]): number {
  const weight = new Map<number, number>()
  for (const line of lines) {
    const bucket = Math.round(line.size * 2) / 2
    weight.set(bucket, (weight.get(bucket) ?? 0) + line.text.length)
  }
  let body = 0
  let best = -1
  for (const [size, count] of weight) {
    if (count > best) {
      best = count
      body = size
    }
  }
  return body > 0 ? body : 1
}

/**
 * Median distance between consecutive baselines — the page's usual leading.
 *
 * The median ignores the outliers (a paragraph gap, a table row, the page number at the foot), which
 * is exactly what makes it usable as the value the gaps are compared against.
 * @param lines - The page's lines, top to bottom.
 * @returns The median pitch, or 0 when the lines give no positive distance.
 */
function medianPitch(lines: readonly PdfLine[]): number {
  const pitches: number[] = []
  for (let index = 1; index < lines.length; index++) {
    const gap = (lines[index - 1]?.y ?? 0) - (lines[index]?.y ?? 0)
    if (gap > 0) pitches.push(gap)
  }
  return median(pitches)
}

/**
 * Heading level of one line, 0 when it is body text.
 *
 * Font size is the only structure a bare text layer carries: a short line set noticeably larger than
 * the body is a title. Two tiers tell a chapter from a clause without guessing at numbering schemes,
 * and a trailing comma rules out the large-print fragments a table leaves behind.
 * @param line - The line to judge.
 * @param body - The page's body font size.
 * @returns 2 or 3 for a heading, 0 for body text.
 */
function headingLevel(line: PdfLine, body: number): number {
  if (line.text.length > 60 || /[，,、；;]$/.test(line.text)) return 0
  const ratio = line.size / body
  if (ratio >= 1.45) return 2
  if (ratio >= 1.12) return 3
  return 0
}

/**
 * Join a word that was split across a line break: `informa-` + `tion` reads `information`.
 * @param text - Text whose lines are already grouped into paragraphs.
 * @returns The same text with wrapped words closed up.
 */
function mergeHyphenated(text: string): string {
  // Only within a paragraph: a hyphen ending a line that a lowercase letter continues is a wrapped
  // word, never a new sentence — and a blank line between them rules that out anyway.
  return text.replace(/([A-Za-z])-\n(?=[a-z])/g, '$1')
}

/**
 * Detect a PDF whose embedded text layer is present but unusable — a common failure
 * with Chinese standards PDFs whose ToUnicode map or encoding is corrupt. Such layers
 * extract as Private-Use-Area code points or replacement characters instead of real
 * glyphs, so the text is gibberish. When detected we rasterize and OCR the page.
 * @param text - The text extracted from the whole document.
 * @returns True when the text layer looks like garbage.
 */
function looksGarbled(text: string): boolean {
  if (text.length < 200) return false
  let pua = 0
  let meaningful = 0
  let total = 0
  let cjk = 0
  let alpha = 0
  let digit = 0
  let symbol = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    total++
    // Private Use Area and the Unicode replacement character are the tell-tale signs
    // of a broken text layer.
    if (code >= 0xE000 && code <= 0xF8FF) { pua++; continue }
    if (code === 0xFFFD) { pua++; continue }
    if (code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D) { meaningful++; continue }
    // CJK ideographs, CJK punctuation and general punctuation.
    if (
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFF00 && code <= 0xFFEF) ||
      (code >= 0x2000 && code <= 0x206F)
    ) { meaningful++; cjk++; continue }
    // ASCII printable and common Latin letters.
    if (code >= 0x21 && code <= 0x7E) {
      meaningful++
      if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) alpha++
      else if (code >= 0x30 && code <= 0x39) digit++
      else symbol++
      continue
    }
    if ((code >= 0x00C0 && code <= 0x024F) || (code >= 0x1E00 && code <= 0x1EFF)) { meaningful++; continue }
  }
  if (total === 0) return false
  // A text layer that is present but encoded wrongly — common with Chinese standards
  // whose ToUnicode map or font encoding is corrupt — extracts as ASCII punctuation and
  // symbol noise with almost no CJK and no real words. The PUA check above misses it
  // because the bytes decode to ordinary symbols, so catch the case where a long extract
  // is symbol-dominated yet carries almost no CJK (a Chinese document should be rich in
  // CJK) and route it to OCR instead of indexing the garbage.
  const wordlike = alpha + digit + cjk
  const symbolRatio = symbol / Math.max(wordlike + symbol, 1)
  const cjkDensity = cjk / total
  const wrongEncoding = total >= 300 && cjkDensity < 0.05 && symbolRatio > 0.35
  return pua / total > 0.05 || meaningful / total < 0.5 || wrongEncoding
}

/** Rasterization scale for OCR; 2× keeps small CJK glyphs legible to Tesseract. */
const OCR_RENDER_SCALE = 2

/** Rasterization scale for a page that carries a table; 3× keeps the print inside cells legible. */
const OCR_TABLE_RENDER_SCALE = 3

/** Ink darker than this counts as printed. */
const RULE_INK = 160

/** Share of the page a run of dark pixels must cross to be a rule rather than a stroke. */
const RULE_RUN = 0.08

/** Pixels within which two rules are the same thick line rather than two lines. */
const RULE_THICKNESS = 4

/** The page result of `recognize`, named for how it is used here. */
type OcrPage = import('tesseract.js').TesseractPage
type OcrLine = import('tesseract.js').TesseractLine
type OcrWord = import('tesseract.js').TesseractWord

/** A rule drawn on a page: where it lies and how far it reaches, in image pixels. */
interface Rule {
  readonly position: number
  readonly from: number
  readonly to: number
}

/** The rules a page carries. */
interface PageGrid {
  readonly horizontal: readonly Rule[]
  readonly vertical: readonly Rule[]
}

/** A table's frame: the y of its row rules and the x of its column rules, in reading order. */
interface TableFrame {
  readonly rows: readonly number[]
  readonly columns: readonly number[]
}

/** One rasterized page: the pixels handed to the recognizer and the surface they came from. */
interface PageShot {
  readonly surface: import('@napi-rs/canvas').Canvas
}

/** Cached PP-OCR engine, keyed by the directory it loaded from: sessions are per-process. */
let ppocrCache: { dir: string; engine: PpOcrEngine } | null = null

/**
 * Locate a directory the package ships beside its code.
 *
 * The built plugin runs from `lib/` and a source run from `src/features/`, so the same data sits one
 * or two levels up depending on how this was started. Both depths are tried, because a source run that
 * missed the bundled data did not fail loudly: PP-OCR falls back to the other recognizer — silently,
 * under `auto` — and the Tesseract path reaches for the network and caches the download into whatever
 * directory the process happened to start in.
 * @param name - Directory as written under the package root, e.g. `tessdata` or `models/ppocr`.
 * @returns The directory, or `''` when neither depth has it.
 */
async function bundledDir(name: string): Promise<string> {
  for (const depth of [`../${name}/`, `../../${name}/`]) {
    try {
      const dir = fileURLToPath(new URL(depth, import.meta.url))
      await access(dir)
      return dir
    } catch {
      // Try the other depth.
    }
  }
  return ''
}

/**
 * Where the PP-OCR models live: the `ocrModelDir` setting when configured, otherwise the
 * package's own `models/ppocr/` directory — the official PP-OCRv6 ONNX files the pack script
 * fetches into the tarball — so an install needs no configuration at all.
 * @param override - `ocrModelDir` setting, empty when unset.
 * @returns A directory to probe, empty when it cannot be found.
 */
async function resolvePpModelDir(override: string): Promise<string> {
  if (override !== '') return override
  return await bundledDir('models/ppocr')
}

/** Whether a PP-OCR model directory holds the minimum files the pipeline needs. */
async function hasPpModels(modelDir: string): Promise<boolean> {
  if (modelDir === '') return false
  try {
    await Promise.all([
      access(path.join(modelDir, 'det.onnx')),
      access(path.join(modelDir, 'rec.onnx')),
      access(path.join(modelDir, 'rec.dict.txt')),
    ])
    return true
  } catch {
    return false
  }
}

/** Load (once per directory) the PP-OCR engine, or null when its models or runtime are absent. */
async function loadPpEngine(modelDir: string): Promise<PpOcrEngine | null> {
  if (ppocrCache !== null && ppocrCache.dir === modelDir) return ppocrCache.engine
  const engine = new PpOcrEngine(modelDir)
  if (!await engine.load()) return null
  ppocrCache = { dir: modelDir, engine }
  return engine
}

/**
 * OCR a scanned PDF, choosing the engine from {@link OcrOptions.engine}.
 *
 * `auto` prefers PP-OCR when a model directory — the configured one or the models bundled in
 * the package — resolves, and silently falls back to Tesseract otherwise, so an install whose
 * bundled models are missing behaves exactly like the old Tesseract-only build. Both engines
 * rasterize through pdf.js and share the table-rule geometry; only the recognizer differs.
 * @param doc - The open pdf.js document.
 * @param ocr - Engine choice, model directory override, fallback languages and render scale.
 * @returns The per-page Markdown and the parser label that produced it.
 * @throws when the requested engine's packages or models are unavailable.
 */
async function ocrPdf(
  doc: import('pdfjs-dist/legacy/build/pdf.mjs').PdfDocument,
  ocr: OcrOptions,
  log?: Logger,
): Promise<{ pages: string[]; parser: string }> {
  const modelDir = await resolvePpModelDir(ocr.modelDir)
  const wantPpocr = ocr.engine === 'ppocr'
    || (ocr.engine === 'auto' && await hasPpModels(modelDir))
  log?.debug(`[ocr] engine=${ocr.engine} resolvedPpDir=${modelDir || '(none)'} wantPpocr=${wantPpocr}`)
  if (wantPpocr) {
    const engine = await loadPpEngine(modelDir)
    if (engine !== null) {
      try {
        log?.debug(`[ocr] using PP-OCR (pdf-ppocr), modelDir=${modelDir}`)
        return { pages: await ocrPdfPpocr(doc, engine, ocr.renderScale), parser: 'pdf-ppocr' }
      } catch (error) {
        // An explicit 'ppocr' request must surface its failure; 'auto' degrades to Tesseract.
        if (ocr.engine === 'ppocr') throw error
      }
    } else if (ocr.engine === 'ppocr') {
      throw new Error(`PP-OCR requested but no usable models found in ${JSON.stringify(modelDir)}`)
    }
    log?.debug('[ocr] PP-OCR unavailable, falling back to Tesseract')
  }
  log?.debug(`[ocr] using Tesseract (pdf-ocr), languages=${ocr.languages}`)
  return { pages: await ocrPdfTesseract(doc, ocr.languages, ocr.langPath), parser: 'pdf-ocr' }
}

/**
 * Tesseract path: rasterize, erase the table rules, recognize, then rebuild the page as Markdown.
 * @param doc - The open pdf.js document.
 * @param languages - Tesseract language codes, e.g. `chi_sim+eng`.
 * @param ocrLangPath - Tesseract language-data directory or URL; empty uses the bundled data.
 */
async function ocrPdfTesseract(
  doc: import('pdfjs-dist/legacy/build/pdf.mjs').PdfDocument,
  languages: string,
  ocrLangPath: string,
): Promise<string[]> {
  const canvas = await loadCanvas()
  const tesseract = await importOptional<typeof import('tesseract.js')>('tesseract.js')
  if (canvas === null || tesseract === null) {
    throw new Error(
      'this PDF is scanned (no text layer); OCR needs the optional "@napi-rs/canvas" and '
      + `"tesseract.js" packages with "${languages}" language data`,
    )
  }
  let worker: import('tesseract.js').TesseractWorker | null = null
  try {
    worker = await tesseract.createWorker(languages, undefined, await tessdataOptions(ocrLangPath))
    const pages: string[] = []
    for (let index = 1; index <= doc.numPages; index++) {
      const page = await doc.getPage(index)
      const first = await rasterize(canvas, page, OCR_RENDER_SCALE)
      const probe = tableFrames(eraseRules(first.surface))
      // A page drawn with a table is read again at a higher scale: erasing the rules is what recovers
      // the cells, but the small print inside them needs the extra pixels to survive the second pass.
      const shot = probe.length === 0 ? first : await rasterize(canvas, page, OCR_TABLE_RENDER_SCALE)
      const frames = probe.length === 0 ? [] : tableFrames(eraseRules(shot.surface))
      // The image is encoded here, once the rules are gone; encoding it when the page was drawn would
      // hand the recognizer the grid again and lose exactly what the erasure bought.
      const { data } = await worker.recognize(shot.surface.toBuffer('image/png'), {}, { text: true, blocks: true })
      pages.push(ocrPageMarkdown(data, frames))
    }
    return pages
  } finally {
    if (worker !== null) await worker.terminate()
  }
}

/**
 * PP-OCR path: the same rasterize-and-erase, but the page is read by PP-OCR's own text boxes.
 *
 * Erasing the rules both clears the grid out of the detector's view and yields the geometry the
 * table is rebuilt from; PP-OCR then reads the page with its own text boxes.
 * @param doc - The open pdf.js document.
 * @param engine - A loaded PP-OCR engine.
 * @param scale - Rasterization scale for this path.
 */
async function ocrPdfPpocr(
  doc: import('pdfjs-dist/legacy/build/pdf.mjs').PdfDocument,
  engine: PpOcrEngine,
  scale: number,
): Promise<string[]> {
  const canvas = await loadCanvas()
  if (canvas === null) throw new Error('PP-OCR needs the optional "@napi-rs/canvas" package')
  const pages: string[] = []
  for (let index = 1; index <= doc.numPages; index++) {
    const page = await doc.getPage(index)
    const shot = await rasterize(canvas, page, scale)
    const frames = tableFrames(eraseRules(shot.surface))
    const data = await recognizePpPage(engine, shot.surface)
    pages.push(ocrPageMarkdown(data, frames))
  }
  return pages
}

/**
 * Run PP-OCR over a rule-erased page and shape the result like a Tesseract page.
 *
 * The page rebuilder (`ocrPageMarkdown`) reads block/paragraph/line structure and per-word boxes,
 * so the fragments PP-OCR returns are clustered into lines by vertical centre — each fragment keeps
 * its own box so a table cell can still be attributed by geometry.
 * @param engine - A loaded PP-OCR engine.
 * @param surface - The rasterized, rule-erased page.
 */
async function recognizePpPage(
  engine: PpOcrEngine,
  surface: import('@napi-rs/canvas').Canvas,
): Promise<OcrPage> {
  const context = surface.getContext('2d')
  const { width, height } = surface
  const image = context.getImageData(0, 0, width, height)
  const rects = await engine.recognize(image.data, width, height)
  const lines: OcrLine[] = []
  let bucket: typeof rects = []
  let baseline = 0
  const flush = (): void => {
    if (bucket.length === 0) return
    const words: OcrWord[] = [...bucket]
      .sort((left, right) => left.x0 - right.x0)
      .map(rect => ({
        text: rect.text,
        bbox: { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 },
      }))
    lines.push({ text: joinWords(words), words })
    bucket = []
  }
  for (const rect of rects) {
    const centre = (rect.y0 + rect.y1) / 2
    const boxHeight = Math.max(1, rect.y1 - rect.y0)
    if (bucket.length > 0 && Math.abs(centre - baseline) > boxHeight * 0.7) flush()
    if (bucket.length === 0) baseline = centre
    bucket.push(rect)
  }
  flush()
  const paragraphs = lines.length === 0 ? [] : [{ lines }]
  const blocks = lines.length === 0 ? [] : [{ paragraphs }]
  return { text: lines.map(line => line.text).join('\n'), blocks }
}

/**
 * Rasterize one page.
 * @param canvas - The canvas backend.
 * @param page - The pdf.js page.
 * @param scale - Rasterization scale.
 * @returns The rendered page.
 */
async function rasterize(
  canvas: typeof import('@napi-rs/canvas'),
  page: import('pdfjs-dist/legacy/build/pdf.mjs').PdfPage,
  scale: number,
): Promise<PageShot> {
  const viewport = page.getViewport({ scale })
  const surface = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  await page.render({ canvasContext: surface.getContext('2d'), viewport }).promise
  return { surface }
}

/**
 * The runs of ink along one axis that are long enough to be a printed rule.
 * @param dark - Whether the pixel at an index holds ink.
 * @param start - Index of the first pixel of the first line.
 * @param count - Pixels to walk.
 * @param stride - Distance between two neighbours along the walk.
 * @param minimum - Shortest run that counts as a rule.
 * @returns One entry per run, as offsets along the walk.
 */
function inkRuns(
  dark: (index: number) => boolean,
  start: number,
  count: number,
  stride: number,
  minimum: number,
): { readonly from: number; readonly to: number }[] {
  const runs: { from: number; to: number }[] = []
  let run = 0
  for (let step = 0; step <= count; step++) {
    if (step < count && dark(start + step * stride)) {
      run++
      continue
    }
    if (run >= minimum) runs.push({ from: step - run, to: step })
    run = 0
  }
  return runs
}

/**
 * Find and erase the rules a page is drawn with.
 *
 * Tesseract reads a table's grid as glyphs and answers with a line of nonsense where the cells are —
 * `EREIIOEEIITIRIDO` for a four-column indicator table, the content lost. Erasing the rules first is
 * what recovers that content, and the rules are worth keeping: they are the exact geometry of the
 * rows and columns, which is what the table is rebuilt from afterwards.
 *
 * Both axes are measured before either is erased. A row rule crosses every column rule it meets, so
 * erasing the rows first would cut each column rule into the short pieces between two rows — pieces
 * too short to be recognized as rules at all, which left the tables with nothing to be rebuilt from.
 * @param surface - The rendered page.
 * @returns The rules that were found and erased.
 */
function eraseRules(surface: import('@napi-rs/canvas').Canvas): PageGrid {
  const context = surface.getContext('2d')
  const { width, height } = surface
  const image = context.getImageData(0, 0, width, height)
  const pixels = image.data
  const dark = (index: number): boolean =>
    ((pixels[index] ?? 255) + (pixels[index + 1] ?? 255) + (pixels[index + 2] ?? 255)) / 3 < RULE_INK
  // A glyph's stroke cannot cross a tenth of the page, so a longer run of ink is a printed rule.
  const across = Math.max(40, Math.round(width * RULE_RUN))
  const down = Math.max(60, Math.round(height * RULE_RUN / 2))
  const horizontal: Rule[] = []
  for (let y = 0; y < height; y++) {
    for (const run of inkRuns(dark, y * width * 4, width, 4, across)) {
      horizontal.push({ position: y, from: run.from, to: run.to })
    }
  }
  const vertical: Rule[] = []
  for (let x = 0; x < width; x++) {
    for (const run of inkRuns(dark, x * 4, height, width * 4, down)) {
      vertical.push({ position: x, from: run.from, to: run.to })
    }
  }
  const erase = (index: number): void => {
    pixels[index] = 255
    pixels[index + 1] = 255
    pixels[index + 2] = 255
  }
  for (const rule of horizontal) {
    for (let x = rule.from; x < rule.to; x++) erase((rule.position * width + x) * 4)
  }
  for (const rule of vertical) {
    for (let y = rule.from; y < rule.to; y++) erase((y * width + rule.position) * 4)
  }
  context.putImageData(image, 0, 0)
  return { horizontal, vertical }
}

/**
 * Distinct positions of a set of rules, collapsing the few pixels one thick rule covers.
 *
 * A rule is printed two or three pixels deep, so every pixel row of it would otherwise become a row
 * boundary of its own and leave a table made of slivers.
 * @param rules - Rules lying on one axis.
 * @returns Their positions, ascending.
 */
function ruleLines(rules: readonly Rule[]): number[] {
  const positions: number[] = []
  for (const position of rules.map(rule => rule.position).sort((left, right) => left - right)) {
    const last = positions[positions.length - 1]
    if (last === undefined || position - last > RULE_THICKNESS) positions.push(position)
  }
  return positions
}

/**
 * Group a page's rules into the tables they draw.
 *
 * A table is a stack of rules set at a steady rhythm — one row apart — so its rows are followed along
 * that rhythm and the band breaks where the page opens a gap far wider than a row. Columns are the
 * vertical rules that cover a good share of a table's height — a share, not the whole, because a header
 * that merges several columns leaves no rule crossing the full height, and the old full-height test
 * fragmented exactly those tables back into loose lines. A frame needs three row rules and three column
 * rules to be rebuilt; a two-rule stretch is a page border or a stray box, not a table.
 * @param grid - The rules found on the page.
 * @returns One frame per table found.
 */
function tableFrames(grid: PageGrid): TableFrame[] {
  const rows = ruleLines(grid.horizontal)
  if (rows.length < 3) return []
  // The rhythm of the table is its row pitch: the median distance between consecutive row rules, which
  // ignores the one or two wide gaps (a caption, the space after the header) that would skew an average.
  const gaps: number[] = []
  for (let index = 1; index < rows.length; index++) gaps.push((rows[index] ?? 0) - (rows[index - 1] ?? 0))
  const pitch = median(gaps)
  // A vertical rule that bridges two consecutive row rules ties them into one table; where none does,
  // the page lifted its pencil between two structures (a caption, the next stacked table), so the band
  // breaks there even before the gap grows wide. Rhythm alone merged stacked tables into one tall band
  // whose no vertical line then covered enough of its height; this separates them without leaning on
  // the pitch, and a merged cell still keeps the two border rules that bridge every interior row.
  const bridged = (top: number, bottom: number): boolean =>
    grid.vertical.some(rule => rule.from <= top + RULE_THICKNESS && rule.to >= bottom - RULE_THICKNESS)
  const bands: number[][] = []
  let band: number[] = [rows[0] ?? 0]
  for (let index = 1; index < rows.length; index++) {
    const previous = band[band.length - 1] ?? 0
    const current = rows[index] ?? 0
    if (pitch > 0 && (current - previous > pitch * 2.5 || !bridged(previous, current))) {
      bands.push(band)
      band = []
    }
    band.push(current)
  }
  bands.push(band)
  const frames: TableFrame[] = []
  for (const group of bands) {
    if (group.length < 3) continue
    const top = group[0] ?? 0
    const bottom = group[group.length - 1] ?? 0
    const height = bottom - top
    if (height <= 0) continue
    // A column is a vertical rule reaching across a good share of the table, so the separators under a
    // merged header still count even though nothing runs the whole height.
    const spans = grid.vertical.filter(rule => Math.min(rule.to, bottom) - Math.max(rule.from, top) >= height * 0.4)
    const columns = ruleLines(spans)
    if (columns.length < 3) continue
    frames.push({ rows: group, columns })
  }
  return frames
}

/** Every word the recognizer reported on a page, whatever block it filed it under. */
function pageWords(page: OcrPage): readonly OcrWord[] {
  const words: OcrWord[] = []
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) words.push(...line.words)
    }
  }
  return words
}

/** Which row band of a frame a word sits in, or -1 when it is not in the frame at all. */
function rowOf(word: OcrWord, frame: TableFrame): number {
  const centre = (word.bbox.y0 + word.bbox.y1) / 2
  for (let index = 0; index + 1 < frame.rows.length; index++) {
    if (centre >= (frame.rows[index] ?? 0) && centre < (frame.rows[index + 1] ?? 0)) return index
  }
  return -1
}

/** Which column band of a frame a word sits in, or -1 when it is not in the frame at all. */
function columnOf(word: OcrWord, frame: TableFrame): number {
  const centre = (word.bbox.x0 + word.bbox.x1) / 2
  for (let index = 0; index + 1 < frame.columns.length; index++) {
    if (centre >= (frame.columns[index] ?? 0) && centre < (frame.columns[index + 1] ?? 0)) return index
  }
  return -1
}

/** Whether a word falls inside a frame's cells, i.e. is accounted for by the table. */
function insideFrame(word: OcrWord, frame: TableFrame): boolean {
  return rowOf(word, frame) >= 0 && columnOf(word, frame) >= 0
}

/** Middle of a word's box vertically — the line it sits on, whatever its glyphs are worth. */
function centreY(word: OcrWord): number {
  return (word.bbox.y0 + word.bbox.y1) / 2
}

/**
 * Split the words of one row band into the text lines inside it.
 *
 * A drawn frame can leave several data rows inside a single band — a table that rules only its header
 * and its outline does exactly that — so the band is measured again by the lines of text in it.
 * Words are gathered by their middle, and only then read left to right: a taller glyph such as one
 * inside brackets starts higher up than its neighbours, and ordering by the top of the box would
 * pull it to the front of the cell, turning `品种纯度 /(%)` into `%品种纯度 /( )`.
 * @param words - The words inside the band.
 * @returns One array of words per line, top to bottom, each in reading order.
 */
function rowsOfWords(words: readonly OcrWord[]): readonly (readonly OcrWord[])[] {
  const ordered = [...words].sort((left, right) => centreY(left) - centreY(right))
  const lines: OcrWord[][] = []
  let current: OcrWord[] = []
  let baseline = 0
  for (const word of ordered) {
    const centre = centreY(word)
    // Runs on one line share a middle to within about half a line, which is what tells them from
    // the row below.
    if (current.length > 0 && Math.abs(centre - baseline) > Math.max(4, (word.bbox.y1 - word.bbox.y0) * 0.6)) {
      lines.push(current)
      current = []
    }
    if (current.length === 0) baseline = centre
    current.push(word)
  }
  if (current.length > 0) lines.push(current)
  return lines.map(line => [...line].sort((left, right) => left.bbox.x0 - right.bbox.x0))
}

/** A recognized line reduced to the geometry its structure is read from, plus its text. */
interface LineBox {
  readonly y: number
  readonly bottom: number
  readonly left: number
  readonly right: number
  readonly height: number
  readonly text: string
}

/**
 * The box a run of recognized words occupies.
 *
 * The line's own shape is the only structure a scan carries: its height says whether it is a title or
 * body text, its left edge whether the paragraph is indented, and its right edge whether the line ran
 * to the margin (a hard wrap) or stopped short (a real paragraph end). None of that survives in the
 * text alone, so it is measured back from the words.
 * @param words - The words on the line, each carrying its bounding box.
 * @returns The box, or a zeroed one when there are no words.
 */
function groupBox(words: readonly OcrWord[]): Omit<LineBox, 'text'> {
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  for (const word of words) {
    top = Math.min(top, word.bbox.y0)
    bottom = Math.max(bottom, word.bbox.y1)
    left = Math.min(left, word.bbox.x0)
    right = Math.max(right, word.bbox.x1)
  }
  if (!Number.isFinite(top)) return { y: 0, bottom: 0, left: 0, right: 0, height: 0 }
  return { y: top, bottom, left, right, height: bottom - top }
}

/** A line opening with a section number, a chapter/part label, or an annex tag — the titles standards use. */
const CLAUSE_TITLE = /^(?:\d{1,3}(?:[.．]\d{1,3})*\s*|第[0-9一二三四五六七八九十百]{1,4}\s*[章节部分篇]|附\s*录\s*[A-Z]|[A-Z][.．]\d{1,2}\s*)/

/** A line that opens a new numbered clause — a paragraph break even when it is not a heading. */
const SECTION_START = /^\d{1,3}(?:[.．]\d{1,3})*\s*[\u4e00-\u9fff(（ -]/

/** A line that begins a list item — `(1)`, `a）`, `1.`, a bullet — rather than continuing prose. */
const LIST_MARKER = /^(?:[-•·◦‣*]|[（(]?\d{1,3}[)）、]|[a-zA-Z][)）、])\s?/

/**
 * Heading level of one recognized line, 0 when it is body text.
 *
 * A scan carries two reliable signals. A line set much taller than the body is a chapter title, and a
 * short line opening with a section number is a clause title — Chinese standards set clause titles at
 * body size, so numbering is what identifies them. Everything else stays body: a taller box is not a
 * title when the line ends in sentence punctuation or is a `表N`/`图N` caption, which label content
 * rather than head a section. Only these two signals count, because trusting a mid-sized box alone
 * turned the sparse labels of a certificate form into headings.
 * @param line - The line to judge.
 * @param body - The page's median line height.
 * @returns 2 or 3 for a heading, 0 for body text.
 */
function ocrHeadingLevel(line: LineBox, body: number): number {
  const text = line.text
  if (text.length === 0 || text.length > 30) return 0
  if (/^[\d\s.．、]+$/.test(text)) return 0 // a bare page number or rule, not a title
  if (/[。…]/.test(text) || /[，,、；;：:！!？?.]$/.test(text)) return 0
  if (/^[表图]\s*\d/.test(text)) return 0
  if (body > 0 && line.height / body >= 1.5) return 2
  // A numeric clause title is Chinese prose, so it carries an ideograph; a bare number leading a Latin
  // unit or symbol (`5.0 MHz`, `1F`) is a table fragment, not a heading, and stays body text.
  if (text.length <= 24 && CLAUSE_TITLE.test(text) && /[\u4e00-\u9fff]/.test(text)) return 3
  return 0
}

/**
 * Glue recognized words into one line of text.
 *
 * Word boundaries are where the recognizer found a gap, so Latin words need a space put back between
 * them while CJK characters, which it also splits, must not get one: `不 得 大 于` has to read
 * `不得大于`, or the clause it came from can no longer be found.
 * @param words - The words, in reading order.
 * @returns The line's text.
 */
function joinWords(words: readonly OcrWord[]): string {
  let text = ''
  for (const word of words) {
    if (word.text === '') continue
    text += `${text === '' ? '' : separatorBetween(text, word.text)}${word.text}`
  }
  return removeCjkSpacing(text.trim())
}

/** Longest a lone cell has to be to count as the tail of the row above rather than a row of its own. */
const FRAGMENT_MAX_CHARS = 3

/**
 * Fold a fragment row into the row above it.
 *
 * A header cell whose text wraps — `穗条长度` printed on two lines — reaches the frame as two lines of
 * text, the second holding only the tail of one cell. Left alone that becomes a row of its own with a
 * couple of characters adrift in it, which reads as data the table does not have.
 * @param rows - The frame's rows, top to bottom.
 * @returns The rows, with those fragments joined onto the cell above them.
 */
function mergeFragments(rows: readonly (readonly string[])[]): string[][] {
  const merged: string[][] = []
  for (const row of rows) {
    const only = row.findIndex(cell => cell !== '')
    const previous = merged[merged.length - 1]
    const tail = row[only] ?? ''
    if (
      row.filter(cell => cell !== '').length === 1
      && only >= 0
      && tail.length <= FRAGMENT_MAX_CHARS
      && previous !== undefined
      && previous.filter(cell => cell !== '').length >= 2
      && (previous[only] ?? '') !== ''
    ) {
      previous[only] = `${previous[only] ?? ''} ${tail}`.trim()
      continue
    }
    merged.push([...row])
  }
  return merged
}

/**
 * Rebuild one table from the words inside its frame.
 *
 * The frame is the authority: the row rules cut the rows and the column rules cut the columns, so a
 * cell is nothing more than the words whose centres fall inside it, read left to right. That is why
 * the geometry is taken from the image rather than guessed at from text — the recognizer's own idea
 * of a line runs straight through a table.
 * @param words - Every word recognized on the page.
 * @param frame - The table's frame.
 * @returns A Markdown pipe table, or `''` when the frame holds too little to be worth one.
 */
function renderTable(words: readonly OcrWord[], frame: TableFrame): string {
  const columns = frame.columns.length - 1
  const rows: string[][] = []
  for (let band = 0; band + 1 < frame.rows.length; band++) {
    const top = frame.rows[band] ?? 0
    const bottom = frame.rows[band + 1] ?? 0
    const inside = words.filter(word => {
      const centre = (word.bbox.y0 + word.bbox.y1) / 2
      return centre >= top && centre < bottom
    })
    for (const line of rowsOfWords(inside)) {
      const cells = Array<string>(columns).fill('')
      for (const word of line) {
        const column = columnOf(word, frame)
        if (column < 0) continue
        const cell = cells[column] ?? ''
        cells[column] = `${cell}${cell === '' ? '' : separatorBetween(cell, word.text)}${word.text}`
      }
      // A pipe would end the cell as far as Markdown is concerned; the rest is spacing the recognizer
      // put between characters rather than between cells.
      rows.push(cells.map(cell => removeCjkSpacing(cell.trim()).replace(/\|/g, '\\|')))
    }
  }
  const filled = mergeFragments(rows).filter(row => row.some(cell => cell !== ''))
  // One row is a heading with nothing under it, which tells a reader less than the lines would.
  if (filled.length < 2) return ''
  const [header, ...body] = filled
  return [
    `| ${(header ?? []).join(' | ')} |`,
    `| ${(header ?? []).map(() => '---').join(' | ')} |`,
    ...body.map(row => `| ${row.join(' | ')} |`),
  ].join('\n')
}

/**
 * One recognized page as Markdown.
 *
 * The tables drawn with rules are rebuilt from their frames and their words pulled out of the flow;
 * the rest is read line by line — headings recognized, hard-wrapped paragraphs closed up — and the
 * two are laid back down in reading order, so a table lands where it sits on the page, under its own caption.
 * @param page - One page of a `recognize` result.
 * @param frames - The frames found on that page.
 * @returns The page's Markdown.
 */
function ocrPageMarkdown(page: OcrPage, frames: readonly TableFrame[]): string {
  const words = pageWords(page)
  const claimed: TableFrame[] = []
  const tables: { readonly y: number; readonly text: string }[] = []
  for (const frame of frames) {
    const table = renderTable(words, frame)
    if (table === '') continue
    claimed.push(frame)
    tables.push({ y: frame.rows[0] ?? 0, text: table })
  }
  const blocks = page.blocks
  if (blocks === null || blocks === undefined || blocks.length === 0) {
    if (tables.length > 0) return tables.sort((left, right) => left.y - right.y).map(table => table.text).join('\n\n')
    return removeCjkSpacing(page.text)
  }
  const lines: LineBox[] = []
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const rest = line.words.filter(word => !claimed.some(frame => insideFrame(word, frame)))
        const text = joinWords(rest)
        if (text === '') continue
        lines.push({ ...groupBox(rest), text })
      }
    }
  }
  const units: { readonly y: number; readonly text: string; readonly box: LineBox | null }[] = [
    ...tables.map(table => ({ y: table.y, text: table.text, box: null })),
    ...lines.map(line => ({ y: line.y, text: line.text, box: line })),
  ].sort((left, right) => left.y - right.y)

  const body = median(lines.map(line => line.height))
  const margin = lines.length > 0 ? Math.min(...lines.map(line => line.left)) : 0
  const foot = lines.length > 0 ? Math.max(...lines.map(line => line.right)) : 0
  const width = Math.max(1, foot - margin)

  const out: string[] = []
  let current = ''
  let previous: LineBox | null = null
  const flush = (): void => {
    if (current !== '') {
      out.push(current)
      current = ''
    }
  }
  for (const unit of units) {
    if (unit.box === null) {
      flush()
      previous = null
      out.push(unit.text)
      continue
    }
    const box = unit.box
    const level = ocrHeadingLevel(box, body)
    if (level > 0) {
      flush()
      out.push(`${'#'.repeat(level)} ${box.text}`)
      previous = box
      continue
    }
    const list = LIST_MARKER.test(box.text)
    // A line opens a new paragraph when the one before it stopped short of the right margin (a real
    // paragraph end, not a wrap), when it begins a new numbered clause or list item, when it is itself
    // indented, or when the page leaves a gap above it taller than a body line. A line that merely ran
    // to the margin closes up with the next, undoing the recognizer's visual wrap.
    const gap = previous === null ? Number.POSITIVE_INFINITY : box.y - previous.bottom
    const shortBefore = previous !== null && previous.right < margin + width * 0.88
    const indented = body > 0 && box.left > margin + body * 1.2
    if (list || SECTION_START.test(box.text) || previous === null || shortBefore || indented || gap > body * 1.6) flush()
    current += (current === '' ? '' : separatorBetween(current, box.text)) + box.text
    if (list) flush()
    previous = box
  }
  flush()
  return out.join('\n\n')
}

/**
 * Load a canvas backend for PDF rasterization.
 *
 * `@napi-rs/canvas` is not a direct dependency, but pdf.js declares it as an optional
 * one, so it is installed alongside pdf.js. When the bare import does not resolve we
 * anchor a `require` at pdf.js's own location to reach the instance it ships with.
 * @returns The module, or null when no canvas backend is available.
 */
async function loadCanvas(): Promise<typeof import('@napi-rs/canvas') | null> {
  const direct = await importOptional<typeof import('@napi-rs/canvas')>('@napi-rs/canvas')
  if (direct !== null) return direct
  try {
    const { createRequire } = await import('node:module')
    const anchor = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')
    return createRequire(anchor)('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
  } catch {
    return null
  }
}

/**
 * Tesseract options for locating the language data.
 *
 * Precedence: an explicit `ocrLangPath` setting (a directory or URL), then the
 * `<lang>.traineddata.gz` files shipped in the package's `tessdata/` directory (so
 * OCR works offline), then nothing — letting Tesseract fall back to its default CDN.
 * `cacheMethod: 'none'` skips Tesseract's on-disk cache: the data is already local,
 * and caching would only copy it into the working directory.
 * @param override - `ocrLangPath` setting, empty when unset.
 * @returns Options for `createWorker`, empty when nothing is configured.
 */
async function tessdataOptions(override: string): Promise<Record<string, unknown>> {
  if (override !== '') return { langPath: override, cacheMethod: 'none' }
  const dir = await bundledDir('tessdata')
  if (dir === '') return {}
  return { langPath: dir, cacheMethod: 'none' }
}

/**
 * Marks a line break that has to survive the tag stripping around it.
 *
 * A `<br>` cannot simply become a newline: the block converter collapses whitespace, and a pipe
 * table has no room for one. So it is parked on a control character — one that cannot occur in the
 * markup itself — and mapped to the right form once the block it sits in is known.
 */
const LINE_BREAK = '\u0001'

/**
 * Convert the HTML that `mammoth` and saved web pages produce into Markdown.
 *
 * Structure is what makes the result usable later: headings, list levels and table rows are how a
 * reader — and the compiler — finds a clause again. Each is therefore translated rather than
 * flattened: `h1`–`h6` to ATX headings, `ol`/`ul` to numbered and bulleted lists at their real
 * depth, tables to pipe tables, `strong`/`em` to emphasis and `a` to links. Prose is not re-wrapped.
 * @param html - The document's markup.
 * @returns Markdown.
 */
export function htmlToMarkdown(html: string): string {
  // Script and style bodies are markup, not content: their innards would otherwise be read as text
  // once the tags around them are gone.
  let markdown = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
  // Tables and lists go first: each consumes markup the later rules would otherwise mangle — a list
  // item's own text, for instance, has to be taken before its `<li>` tags are rewritten.
  markdown = markdown.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_match, body: string) => `\n\n${tableToMarkdown(body)}\n\n`)
  markdown = listsToMarkdown(markdown)
  markdown = markdown.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, text: string) => `\n\n${'#'.repeat(Number(level))} ${oneLine(renderInline(text, ' '))}\n\n`)
  markdown = markdown.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, text: string) => `\n\n${renderInline(text, '\n')}\n\n`)
  // An item outside any list is still an item; keeping it beats dropping the line along with its tags.
  markdown = markdown.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, text: string) => `- ${oneLine(renderInline(text, ' '))}\n`)
  markdown = markdown.replace(/<br\s*\/?>/gi, LINE_BREAK)
  markdown = markdown.replace(/<img[^>]*>/gi, '')
  markdown = strip(markdown)
  return markdown.replace(/\n{3,}/g, '\n\n').trim().replaceAll(LINE_BREAK, ' ')
}

/** Collapse text onto a single line, for the blocks that cannot span lines. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * Format the inline content of one block.
 * @param html - The block's inner markup.
 * @param breakText - What a `<br>` becomes: a newline in a paragraph, a space in a heading or item.
 * @returns The block's text, with emphasis, links and entities translated.
 */
function renderInline(html: string, breakText: string): string {
  return inlineFormat(html.replace(/<br\s*\/?>/gi, LINE_BREAK)).replaceAll(LINE_BREAK, breakText)
}

/**
 * Translate inline markup and drop the layout tags around it.
 *
 * Emphasis is kept because it is often the only mark a document puts on a defined term or a
 * threshold; links are kept because a saved page or a cited `.docx` is worth little without its
 * target. Only runs of spaces and tabs are collapsed — a newline left inside a block is a soft break
 * in Markdown, so the shape the converter produced survives.
 * @param value - Markup that may hold nested tags.
 * @returns One block's text.
 */
function inlineFormat(value: string): string {
  const marked = value
    .replace(/<a\b[^>]*href\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<\s*(?:strong|b)\b[^>]*>/gi, '**')
    .replace(/<\s*\/\s*(?:strong|b)\s*>/gi, '**')
    .replace(/<\s*(?:em|i)\b[^>]*>/gi, '*')
    .replace(/<\s*\/\s*(?:em|i)\s*>/gi, '*')
    .replace(/<\s*code\b[^>]*>/gi, '`')
    .replace(/<\s*\/\s*code\s*>/gi, '`')
  return strip(marked).replace(/[ \t]{2,}/g, ' ')
}

/**
 * Replace every top-level `<ul>`/`<ol>` with its Markdown list.
 *
 * Matching opens against closes is what makes nesting measurable; a flat pattern over `<li>` is what
 * lost the levels. A list that malformed markup never closes is left alone, and its items are then
 * picked up by the plain `<li>` rule.
 * @param html - Markup whose lists have not been converted.
 * @returns Markup with each list block replaced by Markdown.
 */
function listsToMarkdown(html: string): string {
  const tag = /<\/?(?:ul|ol)\b[^>]*>/gi
  let depth = 0
  let start = -1
  let cursor = 0
  let result = ''
  let match: RegExpExecArray | null
  while ((match = tag.exec(html)) !== null) {
    if (!match[0].startsWith('</')) {
      if (depth === 0) start = match.index
      depth++
      continue
    }
    depth = Math.max(depth - 1, 0)
    if (depth === 0 && start >= 0) {
      result += `${html.slice(cursor, start)}\n\n${renderList(html.slice(start, tag.lastIndex))}`
      cursor = tag.lastIndex
      start = -1
    }
  }
  return result + html.slice(cursor)
}

/** One list item, held until the markup that follows tells us where its own text ends. */
interface ListItem {
  readonly start: number
  /** Column the item's text starts in, which is how Markdown reads nesting. */
  readonly indent: number
  readonly marker: string
}

/** A list that is currently open. */
interface OpenList {
  readonly ordered: boolean
  next: number
  readonly indent: number
}

/**
 * Width of the marker a list puts before its next item: `- ` is 2 columns, `10. ` is 4.
 * @param list - The list in question.
 * @returns The marker's width in columns.
 */
function markerWidth(list: OpenList): number {
  return list.ordered ? String(list.next).length + 2 : 2
}

/**
 * Render one list block, the lists nested inside it included.
 *
 * Ordered items keep their numbers: in a standard the clause number *is* the reference, and `- `
 * throws away the only handle a reader has on it. Nesting is expressed as indentation measured from
 * the parent's own marker, because Markdown reads a sub-list by the column its items start in — two
 * spaces under `1. ` would come out as a sibling list rather than a sub-clause.
 * @param block - A complete `<ul>`/`<ol>` element.
 * @returns Its Markdown, one line per item.
 */
function renderList(block: string): string {
  const tag = /<\/?(?:ul|ol|li)\b[^>]*>/gi
  const stack: OpenList[] = []
  const out: string[] = []
  let item: ListItem | null = null
  let match: RegExpExecArray | null
  while ((match = tag.exec(block)) !== null) {
    // An item's own text ends where the next list tag begins — its nested list, its `</li>`, the item
    // after it — so each one is written out as soon as that tag shows up.
    if (item !== null) {
      out.push(itemLine(block.slice(item.start, match.index), item))
      item = null
    }
    const name = (/^<\/?\s*([a-z0-9]+)/i.exec(match[0])?.[1] ?? '').toLowerCase()
    if (name !== 'li') {
      if (match[0].startsWith('</')) stack.pop()
      else {
        const parent = stack[stack.length - 1]
        stack.push({
          ordered: name === 'ol',
          next: 1,
          indent: parent === undefined ? 0 : parent.indent + markerWidth(parent),
        })
      }
      continue
    }
    if (match[0].startsWith('</')) continue
    const parent = stack[stack.length - 1]
    const marker = parent !== undefined && parent.ordered ? `${parent.next++}. ` : '- '
    item = { start: tag.lastIndex, indent: parent?.indent ?? 0, marker }
  }
  // Markup that ends without closing its last item still has one; only its text is left to take.
  if (item !== null) out.push(itemLine(block.slice(item.start), item))
  return out.join('')
}

/**
 * One rendered list item: its indentation, its marker and its text.
 * @param html - The item's inner markup.
 * @param item - The item's indent and the marker to write.
 * @returns The Markdown line.
 */
function itemLine(html: string, item: ListItem): string {
  // A break inside an item continues on the next line, indented past the marker so it stays part of
  // the item instead of becoming a sibling of it.
  const text = renderInline(html, `\n${' '.repeat(item.indent + 2)}`).trim()
  return `${' '.repeat(item.indent)}${item.marker}${text}\n`
}

/**
 * Render one HTML table as a Markdown table.
 *
 * A pipe table has no room for paragraphs, so a cell is flattened — but its breaks are kept as
 * ` / ` rather than silently joined, and a `colspan` cell is padded to the width it spans so the
 * rows below it stay aligned.
 * @param body - The table's inner markup.
 * @returns A Markdown pipe table.
 */
function tableToMarkdown(body: string): string {
  const rows: string[][] = []
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let row: RegExpExecArray | null
  while ((row = rowPattern.exec(body)) !== null) {
    const cells: string[] = []
    const cellPattern = /<t([hd])([^>]*)>([\s\S]*?)<\/t\1>/gi
    let cell: RegExpExecArray | null
    while ((cell = cellPattern.exec(row[1] ?? '')) !== null) {
      cells.push(cellText(cell[3] ?? ''))
      const span = Number(/\bcolspan\s*=\s*["']?(\d+)/i.exec(cell[2] ?? '')?.[1] ?? 1)
      for (let extra = 1; extra < span; extra++) cells.push('')
    }
    rows.push(cells)
  }
  if (rows.length === 0) return ''
  const width = rows.reduce((max, current) => Math.max(max, current.length), 0)
  const lines: string[] = []
  rows.forEach((cells, index) => {
    const padded = [...cells, ...Array<string>(Math.max(width - cells.length, 0)).fill('')]
    lines.push(`| ${padded.join(' | ')} |`)
    if (index === 0) lines.push(`| ${padded.map(() => '---').join(' | ')} |`)
  })
  return lines.join('\n')
}

/**
 * One cell's text: inline markup translated, breaks marked, pipes escaped.
 * @param html - The cell's inner markup.
 * @returns The cell's text on a single line.
 */
function cellText(html: string): string {
  return renderInline(html, ' / ')
    .replace(/\s*\n\s*/g, ' / ')
    .replace(/\|/g, '\\|')
    .trim()
}

/** Drop tags and decode the entities that survive them. */
function strip(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim()
}
