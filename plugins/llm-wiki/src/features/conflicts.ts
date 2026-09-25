/**
 * Conflict detection.
 *
 * Two halves: a numeric pre-check that compares extracted indicators by name and unit, and a
 * scan for the `潜在冲突` markers the compiler leaves in pages. The pre-check is what gives
 * the LLM something concrete to adjudicate instead of asking it to spot contradictions.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Indicator } from '../store/meta.ts'

/** How two numeric requirements relate. */
export type ConflictType = 'A更严格' | 'B更严格' | '相同' | '方向不同'

/** One numeric disagreement between two sources. */
export interface NumericConflict {
  readonly indicatorName: string
  readonly standardA: { readonly no: string; readonly clause: string; readonly value: number; readonly unit: string }
  readonly standardB: { readonly no: string; readonly clause: string; readonly value: number; readonly unit: string }
  readonly type: ConflictType
}

/** One page and the conflict markers found in it. */
export interface PageConflict {
  readonly file: string
  readonly count: number
  readonly blocks: readonly string[]
}

/** Marker the compiler is instructed to leave in a page when it finds a contradiction. */
const MARKER = '> ⚠️ **潜在冲突**'

/**
 * Compare two sets of numeric indicators.
 * @param incoming - Indicators extracted from the source being ingested.
 * @param existing - Indicators already in the library.
 * @returns One entry per same-name, same-unit pair.
 */
export function compareNumericIndicators(
  incoming: readonly Indicator[],
  existing: readonly Indicator[],
): NumericConflict[] {
  const conflicts: NumericConflict[] = []
  for (const left of incoming) {
    for (const right of existing) {
      if (left.indicatorName !== right.indicatorName) continue
      if (left.unit !== right.unit) continue
      if (!Number.isFinite(left.value) || !Number.isFinite(right.value)) continue
      conflicts.push({
        indicatorName: left.indicatorName,
        standardA: { no: left.standardNo, clause: left.clauseNo, value: left.value, unit: left.unit },
        standardB: { no: right.standardNo, clause: right.clauseNo, value: right.value, unit: right.unit },
        type: classify(left, right),
      })
    }
  }
  return conflicts
}

/** Decide which of two bounds is stricter, or that they cannot be compared. */
function classify(left: Indicator, right: Indicator): ConflictType {
  if (left.direction !== right.direction) return '方向不同'
  if (left.value === right.value) return '相同'
  if (left.direction === 'lower') return left.value > right.value ? 'A更严格' : 'B更严格'
  return left.value < right.value ? 'A更严格' : 'B更严格'
}

/**
 * Scan the Wiki for conflict markers.
 * @param wikiDir - Absolute Wiki directory.
 * @returns One entry per page that carries at least one marker.
 */
export async function collectConflicts(wikiDir: string): Promise<PageConflict[]> {
  const out: PageConflict[] = []
  await scan(wikiDir, wikiDir, async (full, rel) => {
    const content = await readFile(full, 'utf8')
    const blocks = content.match(/> ⚠️ \*\*潜在冲突\*\*[\s\S]*?(?=\n[^>]|$)/g)
    if (blocks === null || blocks.length === 0) return
    out.push({ file: rel, count: blocks.length, blocks: blocks.map(block => block.trim()) })
  })
  return out
}

/**
 * Render conflicts for a slash-command result.
 * @param conflicts - Conflicts to render.
 * @returns Markdown text.
 */
export function formatConflicts(conflicts: readonly PageConflict[]): string {
  if (conflicts.length === 0) return '未发现冲突标记。'
  const lines = [`共发现 ${String(conflicts.length)} 个文件包含冲突标记：`, '']
  for (const conflict of conflicts) {
    lines.push(`### ${conflict.file}（${String(conflict.count)} 处）`)
    lines.push(...conflict.blocks.map(block => `\n${block}`))
    lines.push('')
  }
  return lines.join('\n')
}

/** Whether a page body carries the conflict marker. */
export function hasConflictMarker(content: string): boolean {
  return content.includes(MARKER)
}

/**
 * Visit every Markdown page under a directory.
 *
 * Relative paths are measured from `rootDir`, not the directory being walked, so a page nested in
 * a sub-directory keeps its prefix instead of collapsing to a bare file name.
 * @param rootDir - The Wiki root every reported relative path is measured from.
 * @param dir - The directory currently being walked.
 * @param visit - Receives each page's absolute path and its POSIX path relative to `rootDir`.
 */
async function scan(
  rootDir: string,
  dir: string,
  visit: (full: string, rel: string) => Promise<void>,
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await scan(rootDir, full, visit)
      continue
    }
    if (entry.name.endsWith('.md')) await visit(full, path.relative(rootDir, full).split(path.sep).join('/'))
  }
}
