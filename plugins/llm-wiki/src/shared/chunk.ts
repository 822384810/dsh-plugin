/**
 * Chunking and vector helpers shared by ingestion and retrieval.
 *
 * Chunks are cut at the document's own structure — its paragraphs and its tables — rather than every
 * fixed number of characters, and each one opens with the section it came from. What retrieval does
 * with a chunk is why: a lexical hit returns that chunk and nothing else, so a fragment beginning in
 * the middle of a sentence and holding a table without its caption answers nothing, and a run of bare
 * numbers with no clause number above it cannot be found at all. Text is still split by code point, so
 * a surrogate pair is never cut in half.
 */

/** Control characters that carry no meaning in extracted document text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

/** Most of a chunk a breadcrumb may take, before it is trimmed to a share of the chunk instead. */
const TRAIL_RESERVE = 140

/** Longest one part of a breadcrumb may be; a runaway heading must not eat the chunk. */
const TRAIL_PART_MAX = 60

/**
 * Lines that open a section: a Markdown heading, or a clause number such as `5.1.1`.
 *
 * No part of a clause number is longer than three digits, which is what keeps a sentence that merely
 * begins with a year — `1989 年 , 原国家质基技术监督局…` — from passing for a heading.
 */
const SECTION_LINE = /^(?:#{1,6}\s+\S|\d{1,3}(?:\.\d{1,3}){0,3}[.、]?\s+\S)/

/** Longest a clause line may be and still be read as a heading rather than as prose. */
const SECTION_MAX_CHARS = 50

/** Lines that caption a table or a figure. */
const CAPTION_LINE = /^(?:表|图|Table|Figure)\s*\d+/i

/** The section a stretch of text sits in, as read from the headings above it. */
interface Trail {
  readonly clause: string
  readonly caption: string
}

/** Nothing seen yet. */
const NO_TRAIL: Trail = { clause: '', caption: '' }

/** Length in code points, so a surrogate pair counts as the single character a reader sees. */
function codePoints(text: string): number {
  return Array.from(text).length
}

/** A heading as a breadcrumb can carry it: no hash marks, no double spaces, and not unbounded. */
function headingText(line: string): string {
  const trimmed = line.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim()
  return trimmed.length > TRAIL_PART_MAX ? `${trimmed.slice(0, TRAIL_PART_MAX - 1)}…` : trimmed
}

/**
 * Read a block for the headings it opens.
 *
 * A clause line replaces what came before and clears any caption, because a caption belongs to the
 * table under it rather than to the section that follows it.
 * @param block - One paragraph or table of the document.
 * @param trail - The trail as of the block before this one.
 * @returns The trail as read at the end of this block.
 */
function readTrail(block: string, trail: Trail): Trail {
  let clause = trail.clause
  let caption = trail.caption
  for (const line of block.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    if (CAPTION_LINE.test(text)) {
      caption = headingText(text)
      continue
    }
    if (SECTION_LINE.test(text) && text.length <= SECTION_MAX_CHARS) {
      clause = headingText(text)
      caption = ''
    }
  }
  return { clause, caption }
}

/**
 * The line a chunk opens with, naming where it came from.
 * @param title - The document's name, empty when it has none to give.
 * @param trail - The section the chunk sits in.
 * @param budget - Most characters the line may take.
 * @returns The breadcrumb, or `''` when nothing at all is known about the chunk's place.
 */
function breadcrumb(title: string, trail: Trail, budget: number): string {
  const parts = [headingText(title), trail.clause, trail.caption].filter(part => part !== '')
  if (parts.length === 0 || budget < 4) return ''
  const line = `[${parts.join(' · ')}]`
  return line.length <= budget ? line : `${line.slice(0, Math.max(budget - 2, 1))}…]`
}

/**
 * The two lines a Markdown table must keep to stay readable once it is cut.
 * @param lines - The lines of one block.
 * @returns The header row and its separator, or `''` when the block is not a table.
 */
function tableHeader(lines: readonly string[]): string {
  const head = lines[0] ?? ''
  const rule = (lines[1] ?? '').trim()
  return head.startsWith('|') && /^\|[\s:|-]+\|$/.test(rule) ? `${head}\n${rule}` : ''
}

/**
 * Cut a document into the blocks a chunk boundary may fall on.
 *
 * A block is a paragraph or a table — anything a blank line separates — and is never cut, unless it is
 * longer than a chunk can hold. Such a block is cut at its own line breaks, and a single line longer
 * than that is cut by characters, because a wall of text still has to be chunkable.
 * @param text - Normalized source text.
 * @param cap - Longest block that is guaranteed to fit in a chunk.
 * @returns The blocks, in reading order.
 */
function atomicBlocks(text: string, cap: number): string[] {
  const blocks: string[] = []
  let current = ''
  const flush = (): void => {
    if (current === '') return
    blocks.push(current)
    current = ''
  }
  for (const part of text.split(/\n{2,}/)) {
    const block = part.trim()
    if (block === '') continue
    const lines = block.split('\n')
    // A table long enough to be cut is cut between its rows, and every piece then repeats the header,
    // the way a printed table repeats it on each page: rows without their column names answer nothing.
    const header = tableHeader(lines)
    for (const line of lines) {
      if (codePoints(line) > cap) {
        flush()
        const chars = Array.from(line)
        for (let at = 0; at < chars.length; at += cap) blocks.push(chars.slice(at, at + cap).join(''))
        continue
      }
      const step = current === '' ? line : `${current}\n${line}`
      if (codePoints(step) <= cap) current = step
      else {
        flush()
        current = header !== '' && codePoints(`${header}\n${line}`) <= cap ? `${header}\n${line}` : line
      }
    }
    // A blank line would have split the block, so it is closed here.
    flush()
  }
  return blocks
}

/**
 * Where the next chunk reopens.
 *
 * The tail of the chunk just written is carried over while it fits inside the overlap — but never all
 * of it, because a chunk that carried itself would repeat for ever.
 * @param start - Index of the first block of the chunk just written.
 * @param next - Index of the block after it.
 * @param blocks - Every block of the document.
 * @param overlap - Characters a chunk may repeat from the one before it.
 * @returns The index the next chunk starts at.
 */
function seamStart(start: number, next: number, blocks: readonly string[], overlap: number): number {
  let carried = 0
  let index = next
  while (index - 1 > start) {
    const length = codePoints(blocks[index - 1] ?? '')
    if (carried + length > overlap) break
    carried += length
    index--
  }
  return index
}

/**
 * Split text into the chunks retrieval stores, each cut at the document's own structure.
 *
 * A chunk never begins or ends inside a paragraph or a table, and it opens with the section it belongs
 * to: the clause and the table caption above it, plus the document's own name. Under the lexical
 * lookup this library uses those words are what makes a chunk findable in the first place — a table
 * body of nothing but numbers matches no query about the indicator it holds until the caption above it
 * travels with it.
 * @param text - Normalized source text.
 * @param size - Upper bound on characters per chunk, breadcrumb included.
 * @param overlap - Characters a chunk may repeat from the one before it; must be smaller than `size`.
 * @param title - Name to put in the breadcrumb, e.g. the uploaded file's name.
 * @returns The chunks, in order.
 * @throws when the size is not positive or the overlap does not fit under it.
 */
export function chunkText(text: string, size: number, overlap: number, title = ''): string[] {
  if (!Number.isFinite(size) || size <= 0) throw new Error('chunkSize must be positive')
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= size) {
    throw new Error(`chunkOverlap(${overlap}) must be >= 0 and < chunkSize(${size})`)
  }
  if (text.trim() === '') return []
  // The breadcrumb is bounded before anything is cut, so the line that labels a chunk can never push
  // its own opening block out — and a small `size` still yields a chunk worth having.
  const budget = Math.min(TRAIL_RESERVE, Math.floor(size / 3))
  const blocks = atomicBlocks(text, Math.max(size - budget, 1))
  const chunks: string[] = []
  let trail = NO_TRAIL
  let start = 0
  while (start < blocks.length) {
    // The trail is read from the chunk's own opening block, so a chunk that begins at a clause is
    // labelled with that clause rather than with the one before it.
    trail = readTrail(blocks[start] ?? '', trail)
    const label = breadcrumb(title, trail, budget)
    const limit = Math.max(size - codePoints(label), 1)
    const picked: string[] = [blocks[start] ?? '']
    let used = codePoints(blocks[start] ?? '')
    let next = start + 1
    while (next < blocks.length) {
      const block = blocks[next] ?? ''
      const length = codePoints(block)
      if (used + 2 + length > limit) break
      trail = readTrail(block, trail)
      picked.push(block)
      used += 2 + length
      next++
    }
    chunks.push(label === '' ? picked.join('\n\n') : `${label}\n${picked.join('\n\n')}`)
    if (next >= blocks.length) break
    start = seamStart(start, next, blocks, overlap)
  }
  return chunks
}

/**
 * Tidy text after parsing so that chunk boundaries and search hits read cleanly.
 * @param text - Raw parsed text.
 * @returns Text with control characters removed and runs of blank lines collapsed.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Trim a chunk to a display budget.
 * @param text - Chunk content.
 * @param maxChars - Maximum length.
 * @returns The possibly truncated text.
 */
export function excerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(maxChars - 1, 1)).trimEnd()}…`
}

/** Cosine distance (1 - cosine similarity) between two vectors. */
export function cosineDistance(left: Float32Array, right: Float32Array): number {
  const width = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < width; i++) {
    const a = left[i] as number
    const b = right[i] as number
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 1
  return 1 - dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

/**
 * Copy a Float32Array view into a standalone buffer.
 *
 * A vector read back from SQLite is a view onto a shared buffer; handing that view to a BLOB
 * parameter would write the whole backing buffer instead of just the vector.
 * @param vector - Vector to copy.
 * @returns An exact-sized copy.
 */
export function toExactFloat32(vector: Float32Array): Float32Array {
  return new Float32Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}
