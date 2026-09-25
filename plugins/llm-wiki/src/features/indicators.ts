/**
 * Heuristic numeric-indicator extraction.
 *
 * Standard documents state requirements in a small number of fixed shapes ("不大于 0.5 mg/m³",
 * "不低于 30 min"), which is enough to pull out candidate indicators without a model. They are
 * candidates: they exist to feed the numeric conflict pre-check, and the compiler is told to
 * prefer its own judgement when it adjudicates a conflict.
 */
import type { Indicator, IndicatorDirection } from '../store/meta.ts'

/** Keywords that make a number an upper bound. */
const UPPER_WORDS = [
  '不得大于', '不得高于', '不应大于', '应不大于', '不得超过',
  '不大于', '不超过', '小于等于', '不高于', '最高', '最大', '上限', '≤',
]

/** Keywords that make a number a lower bound. */
const LOWER_WORDS = [
  '不得小于', '不得低于', '不应低于', '应不小于',
  '不小于', '不低于', '大于等于', '不少于', '至少', '最低', '最小', '下限', '≥',
]

/**
 * A bound keyword, an optional gap, then a number and its unit.
 *
 * Longer spellings come first so that `不得大于` is never read as a bare `大于`.
 */
const BOUND = new RegExp(
  `(不得大于|不得高于|不得小于|不得低于|不应大于|不应低于|应不大于|应不小于|不得超过`
  + `|大于等于|小于等于|不大于|不小于|不超过|不低于|不少于|最高|最大|上限|最低|最小|下限|至少|≤|≥)`
  + `\\s*([0-9]+(?:\\.[0-9]+)?)\\s*([^\\s，。；、（）()：:]{0,6})`,
  'g',
)

/** Name characters: anything up to the bound that is not punctuation or whitespace. */
const NAME_TAIL = /([^\s，。；、（）()：:]{2,20})$/

/** Upper bound on how many indicators one file contributes. */
const MAX_PER_FILE = 200

/**
 * Extract candidate numeric requirements from a document.
 * @param text - Parsed source text.
 * @param sourcePath - POSIX path recorded on every indicator.
 * @param standardNo - Standard number to attribute them to, when known.
 * @returns De-duplicated candidates.
 */
export function extractIndicators(text: string, sourcePath: string, standardNo = ''): Indicator[] {
  const out: Indicator[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (out.length >= MAX_PER_FILE) break
    for (const match of line.matchAll(BOUND)) {
      const keyword = match[1] ?? ''
      const value = Number(match[2] ?? '')
      if (!Number.isFinite(value)) continue
      const unit = cleanUnit(match[3] ?? '')
      const name = namedBefore(line.slice(0, match.index ?? 0))
      if (name === '') continue
      const key = `${name}|${String(value)}|${unit}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        standardNo,
        clauseNo: clauseOf(line),
        indicatorName: name,
        value,
        unit,
        direction: directionOf(keyword),
        condition: line.trim().slice(0, 120),
        level: /宜|推荐|宜符合/.test(line) ? '推荐' : '强制',
        sourcePath,
      })
      if (out.length >= MAX_PER_FILE) break
    }
  }
  return out
}

/** Standard-number shapes worth attributing indicators to. */
const STANDARD_NO = /(GB\/T|GBZ|GB|JGJ|JTG|CJJ|DL\/T|SH\/T|QB\/T|YB\/T|HG\/T|T\/[A-Z]{2,})[\s/]*[0-9]+(?:[.-][0-9A-Za-z]+)*/i

/**
 * Find the standard number a document belongs to, when it states one.
 * @param text - Parsed source text.
 * @returns The number, or an empty string when none is found.
 */
export function detectStandardNo(text: string): string {
  return STANDARD_NO.exec(text)?.[0]?.replace(/\s+/g, '') ?? ''
}

/** Classify a bound keyword. */
function directionOf(keyword: string): IndicatorDirection {
  if (LOWER_WORDS.includes(keyword)) return 'lower'
  if (UPPER_WORDS.includes(keyword)) return 'upper'
  return 'upper'
}

/** Take the indicator name from the text immediately before the bound. */
function namedBefore(prefix: string): string {
  const match = NAME_TAIL.exec(prefix)
  const name = match?.[1] ?? ''
  return name.replace(/^[的是应为须需符合]+/, '').trim()
}

/** Pull a clause number out of the line when one is present. */
function clauseOf(line: string): string {
  return /(\d+(?:\.\d+)*)\s/.exec(line)?.[1] ?? ''
}

/** Keep only plausible unit characters, dropping trailing punctuation. */
function cleanUnit(raw: string): string {
  return raw.replace(/[^\w%/·℃°³²µμ]/g, '')
}
