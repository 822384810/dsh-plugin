/**
 * Wiki page inventory and the two generated files that keep it navigable.
 *
 * `index.md` and `log.md` are the Wiki's own table of contents and audit trail; both are
 * regenerated here rather than by the LLM, so they stay accurate even when a compile fails.
 */
import { readdir, readFile, writeFile, appendFile, mkdir, access, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { parseFrontmatter, renderFrontmatter } from '../shared/frontmatter.ts'
import { localDate, localTimestamp } from '@dsh-plugins-xz/time-utils'

/** Sub-directories a page may be written into; anything else is refused. */
export const ALLOWED_PAGE_PREFIXES: readonly string[] = ['entities/', 'concepts/', 'sources/']

/** Files in `wiki/` that are not pages. */
const NON_PAGES = new Set(['index.md', 'log.md', 'schema.md'])

/** One Wiki page as listed. */
export interface WikiPageSummary {
  /** POSIX path relative to `wiki/`. */
  readonly path: string
  readonly title: string
  readonly type: string
  readonly updated: string
  readonly source: string
}

/** One page as a scan found it: the summary, plus a digest of the text behind it. */
export interface WikiPageRecord {
  readonly summary: WikiPageSummary
  /**
   * SHA-256 of the page's trimmed content — the same value the retrieval index stores as its
   * `fileHash` — or an empty string when the page holds no text at all. An empty page has nothing
   * to index, which is why the digest doubles as that flag.
   */
  readonly digest: string
}

/** What one file yielded the last time it was read. */
interface CachedPage {
  readonly size: number
  readonly mtimeMs: number
  readonly digest: string
  readonly summary: WikiPageSummary
}

/**
 * Page facts by absolute file path, kept between scans.
 *
 * Almost everything this plugin does starts by walking the Wiki: the panel lists it, the compiler
 * reads it for its prompt, and indexing re-hashes it after every single write. Reading every page
 * each time makes one ingest cost a full pass over the library, so a file whose size and
 * modification time are unchanged keeps the facts it already gave up and only pays for its `stat`.
 */
const PAGE_CACHE = new Map<string, CachedPage>()

/** One compile run, as appended to `log.md`. */
export interface WikiLogEntry {
  readonly source: string
  readonly created: readonly string[]
  readonly updated: readonly string[]
  readonly conflicts: number
}

/**
 * Walk `wiki/` and summarize every page.
 *
 * Files that have not changed since the previous scan are not read again — see {@link PAGE_CACHE} —
 * so repeated scans over a large library stay cheap. Writers inside this plugin call
 * {@link forgetWikiPage} so a same-millisecond, same-size rewrite can never be missed.
 * @param wikiDir - Absolute Wiki directory.
 * @returns One record per page, sorted by path.
 */
export async function scanWikiPages(wikiDir: string): Promise<WikiPageRecord[]> {
  const root = path.resolve(wikiDir)
  const out: WikiPageRecord[] = []
  const seen = new Set<string>()
  await walk(root, root, async (full, rel) => {
    seen.add(full)
    let size: number
    let mtimeMs: number
    try {
      const info = await stat(full)
      size = info.size
      mtimeMs = info.mtimeMs
    } catch {
      // A page that vanished mid-walk is simply not part of the inventory.
      return
    }
    const cached = PAGE_CACHE.get(full)
    if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs) {
      out.push({ summary: cached.summary, digest: cached.digest })
      return
    }
    let content: string
    try {
      content = await readFile(full, 'utf8')
    } catch {
      // A page that vanished or is unreadable must not blank the whole inventory.
      return
    }
    const front = parseFrontmatter(content)
    const summary: WikiPageSummary = {
      path: rel,
      title: front['title'] ?? path.basename(rel, '.md'),
      type: front['type'] ?? 'unknown',
      updated: front['updated'] ?? '',
      source: front['source'] ?? '',
    }
    const text = content.trim()
    const digest = text === '' ? '' : createHash('sha256').update(text).digest('hex')
    PAGE_CACHE.set(full, { size, mtimeMs, digest, summary })
    out.push({ summary, digest })
  })
  // Files that are gone (or no longer pages) stop being remembered, so the cache tracks the Wiki
  // rather than growing forever. Only this directory's entries are considered.
  for (const file of PAGE_CACHE.keys()) {
    if (file.startsWith(root + path.sep) && !seen.has(file)) PAGE_CACHE.delete(file)
  }
  return out.sort((left, right) => left.summary.path.localeCompare(right.summary.path))
}

/**
 * Walk `wiki/` and summarize every page.
 * @param wikiDir - Absolute Wiki directory.
 * @returns One summary per page, sorted by path.
 */
export async function listWikiPages(wikiDir: string): Promise<WikiPageSummary[]> {
  return (await scanWikiPages(wikiDir)).map(record => record.summary)
}

/**
 * Forget one page's cached facts.
 *
 * Writers call this after writing a file: a rewrite that happens to produce the same byte count
 * within the same millisecond as the version already cached would otherwise be invisible.
 * @param file - Absolute path of the page file.
 */
export function forgetWikiPage(file: string): void {
  PAGE_CACHE.delete(path.resolve(file))
}

/**
 * Rewrite `index.md` from the current page inventory.
 * @param wikiDir - Absolute Wiki directory.
 */
export async function refreshIndex(wikiDir: string): Promise<void> {
  const pages = await listWikiPages(wikiDir)
  const byType = new Map<string, WikiPageSummary[]>()
  for (const page of pages) {
    const bucket = byType.get(page.type)
    if (bucket === undefined) byType.set(page.type, [page])
    else bucket.push(page)
  }
  const lines = ['# Wiki Index', '']
  for (const [type, group] of [...byType].sort((left, right) => left[0].localeCompare(right[0]))) {
    lines.push(`## ${type}`, '')
    for (const page of group.sort((left, right) => left.title.localeCompare(right.title))) {
      lines.push(`- [[${page.title}]] \`${page.path}\``)
    }
    lines.push('')
  }
  await writeFile(path.join(wikiDir, 'index.md'), lines.join('\n'), 'utf8')
}

/**
 * Append one compile run to `log.md`.
 * @param wikiDir - Absolute Wiki directory.
 * @param entry - What the run did.
 */
export async function appendLog(wikiDir: string, entry: WikiLogEntry): Promise<void> {
  await appendBlock(wikiDir, [
    `## ${localTimestamp()}`,
    `- 来源：${entry.source}`,
    `- 新建：${entry.created.length > 0 ? entry.created.join(', ') : '无'}`,
    `- 更新：${entry.updated.length > 0 ? entry.updated.join(', ') : '无'}`,
    `- 冲突：${String(entry.conflicts)}`,
    '',
  ].join('\n'))
}

/**
 * Append one non-compile event to `log.md`: a deletion, a rebuild — anything that changed the Wiki
 * layer without being a compile run.
 *
 * These entries are shaped differently from compile runs on purpose: a reader scanning the log for
 * `来源` is looking for what a source produced, not for what was taken away.
 * @param wikiDir - Absolute Wiki directory.
 * @param action - Short label for what happened.
 * @param details - One line per fact worth keeping.
 */
export async function appendLogNote(wikiDir: string, action: string, details: readonly string[]): Promise<void> {
  await appendBlock(wikiDir, [
    `## ${localTimestamp()}`,
    `- 操作：${action}`,
    ...details.map(detail => `- ${detail}`),
    '',
  ].join('\n'))
}

/**
 * Append one block to `log.md`, creating the file (and its heading) when the library has none yet.
 * @param wikiDir - Absolute Wiki directory.
 * @param block - Text to append, newline-terminated by the caller.
 */
async function appendBlock(wikiDir: string, block: string): Promise<void> {
  const logPath = path.join(wikiDir, 'log.md')
  try {
    await appendFile(logPath, block, 'utf8')
  } catch {
    await writeFile(logPath, `# Wiki Log\n\n${block}`, 'utf8')
  }
}

/**
 * Resolve a Wiki page to an absolute path, tolerating stale inventories.
 *
 * A page normally sits in one of the `entities/`, `concepts/` or `sources/` sub-directories, so
 * its canonical reference is e.g. `sources/note.md`. Older inventories or client caches may still
 * hold a bare file name (`note.md`). When the literal path is missing we fall back to the unique
 * inventory entry with the same file name, so such references still resolve to the real file.
 * @param wikiDir - Absolute Wiki directory.
 * @param pagePath - POSIX path (or bare name) of the page relative to `wiki/`.
 * @returns The absolute path, or null when it cannot be resolved.
 */
export async function resolveWikiPageFile(wikiDir: string, pagePath: string): Promise<string | null> {
  const root = path.resolve(wikiDir)
  const direct = path.resolve(root, pagePath)
  if ((direct === root || direct.startsWith(root + path.sep)) && await existsFile(direct)) return direct
  const name = path.basename(pagePath)
  if (name === '') return null
  const match = (await listWikiPages(root)).find(page => path.basename(page.path) === name)
  return match === undefined ? null : path.join(root, match.path)
}

/**
 * Resolve the raw source a Wiki page was compiled from.
 * @param wikiDir - Absolute Wiki directory.
 * @param pagePath - POSIX path of the page relative to `wiki/`.
 * @returns The raw relative path, or null when the page does not name one.
 */
export async function resolveSourceOf(wikiDir: string, pagePath: string): Promise<string | null> {
  const target = await resolveWikiPageFile(wikiDir, pagePath)
  if (target === null) return null
  let content: string
  try {
    content = await readFile(target, 'utf8')
  } catch {
    return null
  }
  const source = parseFrontmatter(content)['source']
  return source === undefined || source === '' ? null : source
}

/**
 * Check that a compiler-proposed page path is one this plugin will write.
 * @param pagePath - Proposed POSIX path relative to `wiki/`.
 * @returns true when the path is inside an allowed sub-directory.
 */
export function isAllowedPagePath(pagePath: string): boolean {
  const normalized = pagePath.split(path.sep).join('/')
  if (normalized.startsWith('..') || normalized.startsWith('/')) return false
  return ALLOWED_PAGE_PREFIXES.some(prefix => normalized.startsWith(prefix)) && normalized.endsWith('.md')
}

/**
 * The Wiki page one raw source is mirrored into.
 *
 * The mirror keeps the folders the source has under `raw/`, so `raw/a/report.pdf` becomes
 * `sources/a/report.pdf.md` rather than being flattened into `sources/`. Two consequences worth
 * knowing: a folder of sources reads the same way in the Wiki as it does in `raw/`, and two files
 * that merely share a name in different folders stay two pages instead of overwriting each other.
 * @param sourceRelPath - POSIX path of the source relative to the library root.
 * @returns The page path relative to `wiki/`.
 */
export function sourcePagePath(sourceRelPath: string): string {
  const segments = sourceRelPath.split(/[\\/]/).filter(segment => segment !== '' && segment !== '.' && segment !== '..')
  // Measure the mirror from `raw/`: everything below it is the folder tree the mirror reproduces.
  if (segments[0] === 'raw') segments.shift()
  const fileName = segments.pop() ?? ''
  // A Markdown source keeps its own name; every other extension stays in the page name, so `a.md`
  // and `a.pdf` remain two pages rather than colliding on one.
  return ['sources', ...segments, `${fileName.replace(/\.md$/i, '')}.md`].join('/')
}

/**
 * Render the mirror of a source, without involving a model.
 *
 * The page is the parsed text in full: for a binary source it is the only readable copy anywhere,
 * and it is what the retrieval index stores, so truncating it would silently lose the tail.
 * @param sourceRelPath - POSIX path of the source relative to the library root.
 * @param text - Parsed source text.
 * @returns Page content with frontmatter.
 */
export function renderSourcePage(sourceRelPath: string, text: string): string {
  const name = path.basename(sourceRelPath).replace(/\.md$/i, '')
  const frontmatter = renderFrontmatter([
    ['title', name],
    ['type', 'source'],
    ['updated', localDate()],
    ['source', sourceRelPath],
  ])
  return `${frontmatter}\n\n# ${name}\n\n${text}\n`
}

/**
 * Write a page, creating its directory when needed.
 * @param wikiDir - Absolute Wiki directory.
 * @param pagePath - POSIX path relative to `wiki/`.
 * @param content - Full page content.
 */
export async function writePage(wikiDir: string, pagePath: string, content: string): Promise<void> {
  const target = path.resolve(wikiDir, pagePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
  forgetWikiPage(target)
}

/** Whether a path exists and is a readable file. */
async function existsFile(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Visit every Markdown page under a directory.
 *
 * Relative paths are always measured from `rootDir`, never from the directory currently being
 * walked — otherwise a page nested in `sources/` would be reported by its bare file name and the
 * inventory would not match the path the reader later opens.
 * @param rootDir - The Wiki root every reported relative path is measured from.
 * @param dir - The directory currently being walked.
 * @param visit - Receives each page's absolute path and its POSIX path relative to `rootDir`.
 */
async function walk(
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
      await walk(rootDir, full, visit)
      continue
    }
    if (!entry.name.endsWith('.md') || NON_PAGES.has(entry.name)) continue
    await visit(full, path.relative(rootDir, full).split(path.sep).join('/'))
  }
}
