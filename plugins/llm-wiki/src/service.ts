/**
 * The knowledge-base service: everything the tools, the slash commands, the RPC channel and
 * the system-prompt section do, in one place.
 *
 * Keeping it here means the four surfaces stay thin wrappers, and that every path — model,
 * browser, command line — enforces the same invariants: `raw/` is read-only, Wiki writes stay
 * inside `entities/ concepts/ sources/`, and no caller escapes the library root.
 */
import { mkdir, readdir, readFile, writeFile, unlink, access, stat, rm, rmdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { LibraryRegistry, LibraryRuntime, LibraryView } from './features/registry.ts'
import type { Embedder } from './features/embedder.ts'
import type { ModelDirectory } from './features/models.ts'
import type { IngestQueue, IngestOutcome } from './features/queue.ts'
import type { IngestLibraryState } from './store/ingest-state.ts'
import type { Settings } from './config.ts'
import type { Logger } from '@dsh-plugins-xz/log-utils'
import type { ModelCatalogView, ModelRef } from './shared/models.ts'
import type { SearchHit } from './shared/retrieval.ts'
import { hybridSearch } from './shared/retrieval.ts'
import type { SourceDetail, VectorDetail } from './shared/source-detail.ts'
import { ftsQuery } from './store/sqlite.ts'
import { safeResolve, sanitizeFileName, relativePosix, toPosix } from './shared/paths.ts'
import type { UploadResult } from './shared/upload.ts'
import { importOptional } from './shared/optional.ts'
import { parseFrontmatter, stripFrontmatter } from './shared/frontmatter.ts'
import { mergeSchema, parseSchema, type SchemaForm } from './shared/schema.ts'
import {
  appendLogNote,
  forgetWikiPage,
  listWikiPages,
  resolveWikiPageFile,
  resolveSourceOf,
  refreshIndex,
  renderSourcePage,
  sourcePagePath,
  type WikiPageSummary,
} from './features/pages.ts'
import { collectConflicts, formatConflicts, type PageConflict } from './features/conflicts.ts'
import { lintWiki } from './features/linter.ts'
import { detectStandardNo, extractIndicators } from './features/indicators.ts'
import { compileWiki } from './features/compiler.ts'
import { syncWikiIndex } from './features/wiki-index.ts'
import { isSupportedSource, supportedExtensions } from './features/parsers.ts'
import type { AmbientRecall } from './features/recall.ts'
import { decodeBuffer } from './shared/encoding.ts'

/** Prefixes a caller may read. */
const READABLE = ['raw/', 'wiki/'] as const

/** Prefixes a caller may write; `raw/` is deliberately absent. */
const WRITABLE = ['wiki/'] as const

/** One directory entry as listed for the browser. */
export interface FsEntry {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'folder'
  /** Files anywhere under a folder; absent for files. */
  readonly count?: number
}

/** Library statistics. */
export interface LibraryStats {
  readonly backend: string
  readonly chunks: number
  readonly sources: number
  readonly indicators: number
  readonly pages: number
  readonly vectors: number
}

/** What one read of the ingest queue returns to the browser. */
export interface IngestSnapshot {
  /** The asked-for library's queue state; empty when no library was named or known. */
  readonly state: IngestLibraryState
  /** How many other libraries still have work in flight, for the "N others" line. */
  readonly othersBusy: number
}

/** One Wiki page as the panel sees it: the file-derived fields plus its marker. */
export interface PageView extends WikiPageSummary {
  /** True once a human edited this page in the panel. */
  readonly edited: boolean
}

/** Everything the service needs, supplied by the plugin entry. */
export interface ServiceDeps {
  readonly registry: LibraryRegistry
  readonly embedder: Embedder
  readonly queue: IngestQueue
  readonly settings: Settings
  readonly log: Logger
  readonly ambient: AmbientRecall
  /** Model runtime plus deployment default, read to resolve each library's compile model. */
  readonly models: ModelDirectory
}

/** The knowledge base, as seen by tools, commands and the browser. */
export class WikiService {
  /**
   * @param deps - Registry, embedder, queue, settings and logger.
   */
  constructor(private readonly deps: ServiceDeps) {}

  /** Every registered library. */
  listLibraries(): LibraryView[] {
    return this.deps.registry.list()
  }

  /**
   * Register a library.
   * @param name - Display name.
   * @param rootDir - Directory that holds (or will hold) `raw/` and `wiki/`.
   * @returns The registered library.
   */
  async addLibrary(name: string, rootDir: string): Promise<LibraryView> {
    const library = await this.deps.registry.add({ name, rootDir })
    return {
      id: library.id,
      name: library.name,
      rootDir: library.rootDir,
      createdAt: library.createdAt,
      isActive: true,
    }
  }

  /**
   * Rename a library.
   * @param libId - Library id.
   * @param name - New display name.
   * @returns The updated library, as the browser reads it.
   */
  async renameLibrary(libId: string, name: string): Promise<LibraryView> {
    const library = await this.deps.registry.rename(libId, name)
    return {
      id: library.id,
      name: library.name,
      rootDir: library.rootDir,
      createdAt: library.createdAt,
      isActive: this.deps.registry.getActive()?.id === library.id,
    }
  }

  /**
   * Make a library active.
   * @param libId - Library id.
   */
  async switchLibrary(libId: string): Promise<string> {
    await this.deps.registry.setActive(libId)
    return this.deps.registry.get(libId)?.name ?? libId
  }

  /**
   * Forget a library; its files are left on disk.
   * @param libId - Library id.
   */
  async removeLibrary(libId: string): Promise<void> {
    await this.deps.registry.remove(libId)
  }

  /**
   * Resolve a library, falling back to the active one.
   * @param libId - Library id, or undefined for the active library.
   * @returns The library.
   * @throws when nothing is selected and none is given.
   */
  requireLibrary(libId?: string | undefined): LibraryRuntime {
    const library = libId === undefined || libId === ''
      ? this.deps.registry.getActive()
      : this.deps.registry.get(libId)
    if (library === undefined || library === null) {
      throw new Error(libId === undefined || libId === '' ? '没有活跃的知识库' : `未知知识库: ${libId}`)
    }
    return library
  }

  /**
   * List a directory under the library root.
   *
   * Each folder is told how many files sit anywhere under it, so the tree says what a folder holds
   * before it is opened — the same thing a type heading says about its pages.
   * @param libId - Library id.
   * @param relPath - POSIX path relative to the library root.
   * @returns Entries, folders first.
   */
  async listDir(libId: string, relPath: string): Promise<FsEntry[]> {
    const library = this.requireLibrary(libId)
    const target = relPath === '' || relPath === '.'
      ? path.resolve(library.rootDir)
      : safeResolve(library.rootDir, relPath, READABLE)
    const entries = await readdir(target, { withFileTypes: true })
    const counts = new Map(await Promise.all(entries
      .filter(entry => entry.isDirectory())
      .map(async entry => [entry.name, await countFiles(path.join(target, entry.name))] as const)))
    const out: FsEntry[] = entries.map(entry => {
      const entryPath = toPosix(path.posix.join(relPath === '' ? '' : relPath, entry.name))
      if (!entry.isDirectory()) return { name: entry.name, path: entryPath, type: 'file' as const }
      return { name: entry.name, path: entryPath, type: 'folder' as const, count: counts.get(entry.name) ?? 0 }
    })
    return out.sort((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'folder' ? -1 : 1))
  }

  /**
   * Read a file under the library root.
   * @param libId - Library id.
   * @param relPath - POSIX path relative to the library root.
   * @returns Decoded text.
   */
  async readFile(libId: string, relPath: string): Promise<string> {
    const library = this.requireLibrary(libId)
    const target = safeResolve(library.rootDir, relPath, READABLE)
    try {
      return await decodeBuffer(await readFile(target))
    } catch (reason) {
      // An inventory or client cache may reference a page by a stale path (e.g. `wiki/x.md`
      // while the file actually lives in `wiki/sources/x.md`). Resolve by file name before failing.
      if (relPath.startsWith('wiki/') && (reason as NodeJS.ErrnoException).code === 'ENOENT') {
        const healed = await resolveWikiPageFile(library.wikiDir, relPath.slice('wiki/'.length))
        if (healed !== null) return await decodeBuffer(await readFile(healed))
      }
      throw reason
    }
  }

  /**
   * Read a binary file under the library root as base64, for the browser to download.
   * @param libId - Library id.
   * @param relPath - POSIX path relative to the library root.
   * @returns Base64-encoded bytes.
   */
  async downloadFile(libId: string, relPath: string): Promise<string> {
    const library = this.requireLibrary(libId)
    const target = safeResolve(library.rootDir, relPath, READABLE)
    return (await readFile(target)).toString('base64')
  }

  /**
   * Produce an in-app preview of a binary raw source.
   * @param libId - Library id.
   * @param relPath - POSIX path relative to the library root.
   * @returns The preview MIME type and its payload (base64 for PDF, HTML for DOCX).
   * @throws when the type has no preview or its converter is missing.
   */
  async previewFile(libId: string, relPath: string): Promise<{ mime: string; data: string }> {
    const library = this.requireLibrary(libId)
    const target = safeResolve(library.rootDir, relPath, READABLE)
    const lower = relPath.toLowerCase()
    if (lower.endsWith('.pdf')) {
      return { mime: 'application/pdf', data: (await readFile(target)).toString('base64') }
    }
    if (lower.endsWith('.docx')) {
      const mammoth = await importOptional<typeof import('mammoth')>('mammoth')
      if (mammoth === null) throw new Error('previewing .docx needs the "mammoth" package')
      const buffer = await readFile(target)
      const result = await mammoth.convertToHtml({ buffer })
      return { mime: 'text/html', data: result.value }
    }
    throw new Error('该文件类型暂不支持预览')
  }

  /**
   * Write a file inside `wiki/`.
   * @param libId - Library id.
   * @param relPath - POSIX path relative to the library root.
   * @param content - Text to write.
   */
  async writeFile(libId: string, relPath: string, content: string): Promise<void> {
    const library = this.requireLibrary(libId)
    let target = safeResolve(library.rootDir, relPath, WRITABLE)
    // Keep a stale-but-known page reference (bare name from an old inventory) pointed at the real
    // file instead of spawning a duplicate at the Wiki root. A genuinely new page still writes
    // wherever the caller asked, since no existing page shares its name.
    if (relPath.startsWith('wiki/')) {
      const healed = await resolveWikiPageFile(library.wikiDir, relPath.slice('wiki/'.length))
      if (healed !== null) target = healed
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    forgetWikiPage(target)
    // A hand-edited page has to be searchable under its new content too, and the marker is what
    // tells the panel the page no longer came from a parse.
    if (relPath.startsWith('wiki/')) {
      library.meta.setPageEdited(relativePosix(library.wikiDir, target))
      await syncWikiIndex(library, this.deps.embedder, this.deps.log)
    }
  }

  /**
   * Store an uploaded file in `raw/` and ingest it.
   * @param libId - Library id.
   * @param fileName - Original file name, reduced to a safe segment.
   * @param base64 - Base64-encoded content.
   * @param dir - Optional POSIX folder under `raw/` to place the file in ('' for the root).
   * @returns The path it was stored under.
   * @throws when the file is too large or already exists.
   */
  async upload(libId: string, fileName: string, base64: string, dir = ''): Promise<UploadResult> {
    const library = this.requireLibrary(libId)
    const safeName = sanitizeFileName(fileName)
    // Refuse an unreadable type here rather than letting it into `raw/`: a file the parser cannot
    // read would only fail at ingest time, after the user believes it was accepted.
    if (!isSupportedSource(safeName, this.deps.settings.extraSourceExtensions)) {
      throw new Error(
        `不支持的文件类型；可用类型：${supportedExtensions(this.deps.settings.extraSourceExtensions).join(' ')}`,
      )
    }
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.byteLength > this.deps.settings.maxUploadBytes) {
      throw new Error(`文件超过 ${String(this.deps.settings.maxUploadBytes)} 字节上限`)
    }
    if (bytes.byteLength === 0) throw new Error('文件内容为空')
    const relDir = dir === '' ? 'raw' : path.posix.join('raw', sanitizeDirPath(dir))
    const rel = path.posix.join(relDir, safeName)
    let target = safeResolve(library.rootDir, rel, ['raw/'])
    const incomingHash = sha256(bytes)
    if (await fileExists(target)) {
      // Compare by content, not by name. Identical bytes mean a harmless re-upload; a different
      // body under the same name is a genuine second version, so we keep both by auto-renaming.
      let sameContent = false
      try {
        const existing = await readFile(target)
        sameContent = sha256(existing) === incomingHash
      } catch {
        sameContent = false
      }
      if (sameContent) {
        this.deps.log.info(`upload skipped, identical content already present: ${rel}`)
        return { status: 'duplicate', rel, renamedTo: null }
      }
      target = await this.findFreeTarget(library.rootDir, safeName, dir)
      const renamedTo = relativePosix(library.rootDir, target)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, bytes)
      this.deps.queue.enqueue(target, library.id)
      return { status: 'renamed', rel: renamedTo, renamedTo }
    }
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
    this.deps.queue.enqueue(target, library.id)
    return { status: 'created', rel, renamedTo: null }
  }

  /**
   * Create a folder under `raw/`, arbitrarily deep.
   * @param libId - Library id.
   * @param relPath - POSIX path of the new folder relative to the library root, e.g. `raw/a/b`.
   * @throws when the path escapes `raw/` or a segment is not a safe name.
   */
  async makeDir(libId: string, relPath: string): Promise<void> {
    const library = this.requireLibrary(libId)
    if (relPath === '' || relPath === 'raw') throw new Error('不能在 raw/ 根目录创建目录')
    const cleaned = sanitizeDirPath(relPath)
    const target = safeResolve(library.rootDir, cleaned, ['raw/'])
    await mkdir(target, { recursive: true })
  }

  /**
   * Find a free path under `raw/` for `safeName`, inserting ` (n)` before the extension when the
   * plain name is taken (e.g. `report (1).pdf`, `report (2).pdf`).
   * @param rootDir - Library root directory.
   * @param safeName - Sanitized file name including extension.
   * @param dir - POSIX folder under `raw/` the file lives in ('' for the root).
   * @returns A resolved, non-existing absolute path inside `raw/`.
   */
  private async findFreeTarget(rootDir: string, safeName: string, dir: string): Promise<string> {
    const ext = path.extname(safeName)
    const base = safeName.slice(0, safeName.length - ext.length)
    const relDir = dir === '' ? 'raw' : path.posix.join('raw', sanitizeDirPath(dir))
    for (let index = 1; ; index++) {
      const candidate = `${base} (${String(index)})${ext}`
      const candidateTarget = safeResolve(rootDir, path.posix.join(relDir, candidate), ['raw/'])
      if (!(await fileExists(candidateTarget))) return candidateTarget
    }
  }

  /**
   * Delete a path from `raw/`, drop its index entries, and remove the Wiki
   * source pages generated from what it held.
   *
   * A folder takes everything under it, subdirectories included. Only the `sources/`-resident pages
   * whose `source` frontmatter names a removed file are touched, and `index.md` is refreshed; no
   * entity/concept pages are deleted and nothing is recompiled.
   * @param libId - Library id.
   * @param relPath - POSIX path relative to the library root.
   * @returns How many files were removed.
   */
  async deleteFile(libId: string, relPath: string): Promise<number> {
    const library = this.requireLibrary(libId)
    const target = safeResolve(library.rootDir, relPath, ['raw/'])
    const info = await stat(target)
    const files = info.isDirectory() ? await collectFiles(target) : [target]
    const gone = new Set(files.map(file => relativePosix(library.rootDir, file)))
    // One recursive removal covers both cases: removing a file is the single `unlink` this used to
    // do, and removing a folder takes the folder itself with it.
    await rm(target, { recursive: true, force: true })
    for (const rel of gone) {
      library.store.deleteSource(rel)
      library.meta.removeSource(rel)
      library.ingest.remove(rel)
    }
    // One pass over the in-memory chunks, whatever the number of files that went.
    for (const [uid, chunk] of library.chunks) {
      if (!gone.has(chunk.sourcePath)) continue
      library.chunks.delete(uid)
      library.vectors.delete(uid)
    }
    // Remove the Wiki source pages (1:1 with their raw file) so the knowledge layer stays in sync.
    // Matched by `source` frontmatter to avoid any guesswork about the sanitized/hashed file name.
    const pages = await listWikiPages(library.wikiDir)
    const emptied = new Set<string>()
    let mirrors = 0
    for (const page of pages) {
      if (!page.path.startsWith('sources/') || !gone.has(page.source)) continue
      const file = path.join(library.wikiDir, page.path)
      try { await unlink(file) } catch { /* already absent */ }
      library.meta.clearPageEdited(page.path)
      // Mirrors reproduce the `raw/` tree, so a deleted folder leaves folders behind as well.
      emptied.add(path.dirname(file))
      mirrors += 1
    }
    for (const dir of emptied) await pruneEmptyDirs(library.wikiDir, dir)
    // A removal is invisible to the compile log, which only records runs a source produced, so it
    // leaves a note of its own: what went, and how much of the Wiki layer went with it.
    await appendLogNote(library.wikiDir, '删除来源', [
      `路径：${relPath}`,
      `删除文件：${String(gone.size)}`,
      `连带删除镜像页：${String(mirrors)}`,
    ])
    await refreshIndex(library.wikiDir)
    // The removed mirrors must stop being searchable.
    await syncWikiIndex(library, this.deps.embedder, this.deps.log)
    return gone.size
  }

  /**
   * Re-ingest a path: one file, or every file under a folder.
   *
   * A folder row promises the whole folder, so a subdirectory is never skipped. The run is queued
   * ahead of the ordinary backlog, since it was asked for by hand.
   * @param libId - Library id.
   * @param relPath - POSIX path relative to the library root.
   * @returns How many files were queued.
   */
  async reingest(libId: string, relPath: string): Promise<number> {
    const library = this.requireLibrary(libId)
    const target = safeResolve(library.rootDir, relPath, ['raw/'])
    const info = await stat(target)
    const files = info.isDirectory() ? await collectFiles(target) : [target]
    for (const file of files) this.deps.queue.enqueue(file, library.id, 10, true)
    return files.length
  }

  /**
   * Rebuild a library from `raw/`.
   *
   * This is meant to be the heavy hammer the label suggests: the search index, the metadata and the
   * Wiki layer the LLM maintains are emptied, so afterwards the panel shows only what this run
   * produced — no pages the model wrote in a previous life, no mirrors of files that are gone.
   *
   * `raw/` is never touched, being the source of truth, and neither are `schema.md` (the rules this
   * run is supposed to follow) or `log.md` (the audit trail, which gains an entry per run).
   * @param libId - Library id.
   * @returns Number of files queued.
   */
  async reindex(libId: string): Promise<number> {
    const library = this.requireLibrary(libId)
    library.store.clear()
    library.meta.clear()
    library.chunks.clear()
    library.vectors.clear()
    // Emptying the Wiki layer is what makes this a rebuild rather than a re-index: every source
    // mirror is rewritten from its source anyway, and every entity/concept page is what the compile
    // step of this run produces. A page kept here would be one this run did not produce — including
    // mirrors left at a stale path by an earlier layout.
    const pages = await listWikiPages(library.wikiDir)
    const emptied = new Set<string>()
    for (const page of pages) {
      const file = path.join(library.wikiDir, page.path)
      try { await unlink(file) } catch { /* already absent */ }
      emptied.add(path.dirname(file))
    }
    for (const dir of emptied) await pruneEmptyDirs(library.wikiDir, dir)
    const files = await collectFiles(library.rawDir)
    const liveSources = new Set(files.map(file => relativePosix(library.rootDir, file)))
    // The compile entries below each name one source; this one names the run that cleared the deck.
    await appendLogNote(library.wikiDir, '整库重建', [
      `清空页面：${String(pages.length)}`,
      `重新处理：${String(files.length)} 个文件`,
    ])
    // Drop queue entries whose source is gone, so the panel never counts a deleted file.
    for (const rel of Object.keys(library.ingest.jobs())) {
      if (!liveSources.has(rel)) library.ingest.remove(rel)
    }
    await refreshIndex(library.wikiDir)
    // The Wiki layer is empty now; index.md was just rewritten to say so, and nothing is live to
    // keep in the store. The raw pass below fills it back in one file at a time.
    await syncWikiIndex(library, this.deps.embedder, this.deps.log)
    for (const file of files) this.deps.queue.enqueue(file, library.id)
    return files.length
  }

  /** Wiki page inventory. */
  async listPages(libId: string): Promise<PageView[]> {
    const library = this.requireLibrary(libId)
    const marks = library.meta.pageMarks()
    const pages = await listWikiPages(library.wikiDir)
    return pages.map(page => ({ ...page, edited: marks[page.path]?.edited === true }))
  }

  /**
   * Materialize one source's mirror page and index it.
   *
   * This is the only writer of a `sources/` page: a fresh parse always wins, which is exactly what
   * clears an earlier hand correction. The mirror — not the raw bytes — is what the index stores,
   * so a source's text exists once in the index, and a binary source's text exists at all.
   * @param library - Owning library.
   * @param rel - POSIX path of the raw source relative to the library root.
   * @param text - Parsed source text.
   * @returns The number of chunks the mirror was indexed as.
   */
  async materializeMirror(library: LibraryRuntime, rel: string, text: string): Promise<number> {
    const pagePath = sourcePagePath(rel)
    const target = path.join(library.wikiDir, pagePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, renderSourcePage(rel, text), 'utf8')
    forgetWikiPage(target)
    await dropFlatMirror(library, rel, pagePath)
    library.meta.clearPageEdited(pagePath)
    await syncWikiIndex(library, this.deps.embedder, this.deps.log)
    return countChunks(library, rel)
  }

  /**
   * Hybrid retrieval.
   * @param libId - Library id; the active one when omitted.
   * @param query - Query text.
   * @param topK - Maximum hits.
   * @returns Ranked hits.
   */
  async search(libId: string | undefined, query: string, topK: number): Promise<SearchHit[]> {
    const library = this.requireLibrary(libId)
    const trimmed = query.trim()
    if (trimmed === '') return []
    const match = ftsQuery(trimmed)
    const lexical = library.store.lexical(trimmed, topK * 2)
    this.deps.log.debug(`[search] query=${JSON.stringify(trimmed)} fts=${JSON.stringify(match)} lexicalHits=${lexical.length}`)
    const vector = await this.queryVector(trimmed)
    const hits = hybridSearch({ chunks: library.chunks, vectors: library.vectors }, lexical, vector, topK)
    if (vector !== null) {
      const vectorHits = hits.filter(hit => hit.vectorDistance < 1).length
      this.deps.log.debug(
        `[search] fused=${hits.length} vectorHits=${vectorHits} lexicalHits=${lexical.length} ` +
        `vectorDim=${vector.length}`,
      )
    } else {
      this.deps.log.debug(`[search] fused=${hits.length} lexicalOnly lexicalHits=${lexical.length}`)
    }
    return hits
  }

  /**
   * Chunks and vectors indexed under one source key, for the inspector panel.
   *
   * Reads the in-memory mirrors rather than the store, so it reflects the live index a retrieval
   * would actually hit. A page maps to a chunk key through the same rule the indexer uses
   * (`sources/` pages by their `source` frontmatter, everything else by `wiki/<path>`), which the
   * caller works out before asking.
   * @param libId - Library id.
   * @param sourcePath - Chunk source key the page's chunks are stored under.
   * @returns The chunks and their vectors, ordered by chunk index.
   */
  async sourceDetail(libId: string, sourcePath: string): Promise<SourceDetail> {
    const library = this.requireLibrary(libId)
    const chunks = [...library.chunks.values()]
      .filter(chunk => chunk.sourcePath === sourcePath)
      .sort((left, right) => left.chunkIndex - right.chunkIndex)
    const details = chunks.map(chunk => ({
      uid: chunk.uid,
      chunkIndex: chunk.chunkIndex,
      contentLength: chunk.content.length,
      preview: chunk.content.slice(0, 240),
      fileHash: chunk.fileHash,
      hasVector: library.vectors.has(chunk.uid),
    }))
    const vectors: VectorDetail[] = []
    for (const chunk of chunks) {
      const vector = library.vectors.get(chunk.uid)
      if (vector === undefined) continue
      let squared = 0
      for (const value of vector) squared += value * value
      vectors.push({
        uid: chunk.uid,
        dim: vector.length,
        magnitude: Math.sqrt(squared),
        sample: Array.from(vector.slice(0, 8)),
      })
    }
    return { source: sourcePath, chunks: details, vectors }
  }

  /**
   * Lexical-only retrieval, for the synchronous system-prompt hook.
   * @param libId - Library id.
   * @param query - Query text.
   * @param topK - Maximum hits.
   */
  retrieveLexical(libId: string, query: string, topK: number): SearchHit[] {
    const library = this.deps.registry.get(libId)
    if (library === undefined) return []
    const lexical = library.store.lexical(query.trim(), topK * 2)
    return hybridSearch({ chunks: library.chunks, vectors: library.vectors }, lexical, null, topK)
  }

  /**
   * Recompile the source behind one Wiki page.
   * @param libId - Library id.
   * @param pagePath - POSIX path of the page relative to `wiki/`.
   * @returns What the compile did.
   * @throws when the page names no raw source.
   */
  async recompile(libId: string, pagePath: string): Promise<IngestOutcome> {
    const library = this.requireLibrary(libId)
    const source = await resolveSourceOf(library.wikiDir, pagePath)
    if (source === null) throw new Error('无法定位该页面对应的 raw 来源')
    // The mirror is the authoritative body — including any hand correction — so a recompile never
    // returns to the raw bytes, which for a binary source could not be compiled anyway.
    // A compile is one model call per window, so it can take minutes with nothing to show. Its
    // progress travels through the ingest state — the one channel the panel already polls. To match
    // the "重新入库" flow the source is registered as `queued` (0%) up front and, like a re-ingest,
    // its job is kept after the run: `done` 100% on success, `failed` 100% on error — never removed
    // or reverted to a prior state.
    library.ingest.setJob(source, 'queued', 0, null)
    try {
      const text = await readMirror(library, source)
      // Indicators are re-read from that same body: the numeric conflict pre-check is deterministic
      // and free, and a recompile that skipped it would be quietly weaker than an ordinary ingest.
      // Storing them keeps the metadata in step with what this run was told.
      const indicators = extractIndicators(text, source, detectStandardNo(text))
      library.meta.setIndicators(source, indicators)
      await syncWikiIndex(library, this.deps.embedder, this.deps.log)
      library.ingest.setJob(source, 'running', 0, null)
      const outcome = await this.compile(library, source, text, indicators, (done, total) => {
        // 99, not 100: the last percent belongs to the run finishing rather than to the last window.
        const percent = total === 0 ? 99 : Math.max(1, Math.round((done / total) * 99))
        library.ingest.setJob(source, 'running', percent, null)
      })
      library.ingest.setJob(source, 'done', 100, null)
      return outcome
    } catch (error) {
      library.ingest.setJob(source, 'failed', 100, String(error))
      throw error
    }
  }

  /**
   * Recompile every source from its mirror page.
   *
   * Unlike {@link reindex}, this starts from the `sources/` mirrors rather than `raw/`: the mirrors
   * are kept, `raw/` is never touched, and the run re-chunks every mirror as it stands on disk (so a
   * hand edit to a mirror reaches the search index) and re-runs the compiler to rebuild every entity
   * and concept page. The entity/concept pages are wiped first so a page a source no longer mentions
   * is gone; `schema.md` and `log.md` are kept.
   *
   * The synchronous part (wipe + clear the store) runs before the call returns; the per-source
   * compile is fire-and-forget so the RPC channel is not held open for what can be many model calls.
   * Its overall progress travels through the ingest state under {@link RECOMPILE_ALL_KEY}.
   * @param libId - Library id.
   * @returns The number of sources queued for recompile.
   */
  async recompileAll(libId: string): Promise<number> {
    const library = this.requireLibrary(libId)
    const pages = await listWikiPages(library.wikiDir)
    // Wipe entity and concept pages; mirrors are kept and rebuilt from, never deleted.
    const emptied = new Set<string>()
    let removed = 0
    for (const page of pages) {
      if (!page.path.startsWith('entities/') && !page.path.startsWith('concepts/')) continue
      const file = path.join(library.wikiDir, page.path)
      try { await unlink(file) } catch { /* already absent */ }
      library.meta.clearPageEdited(page.path)
      emptied.add(path.dirname(file))
      removed += 1
    }
    for (const dir of emptied) await pruneEmptyDirs(library.wikiDir, dir)
    // Rebuild the retrieval index from the (possibly hand-edited) mirrors: clearing the store then
    // re-syncing re-chunks every mirror as it stands on disk, so edits reach search.
    library.store.clear()
    library.chunks.clear()
    library.vectors.clear()
    await appendLogNote(library.wikiDir, '全部重新编译', [
      `删除实体/概念页：${String(removed)}`,
    ])
    await refreshIndex(library.wikiDir)
    const sources = pages.filter(page => page.path.startsWith('sources/') && page.source !== '')
    const total = sources.length
    void this.runRecompileAll(library, sources)
    return total
  }

  /**
   * Compile every source mirror, one after another, reporting progress through the ingest state.
   * @param library - Owning library.
   * @param sources - Mirror pages whose `source` names a raw file.
   * @param total - How many sources there are, for a percentage.
   */
  private async runRecompileAll(
    library: LibraryRuntime,
    sources: readonly WikiPageSummary[],
  ): Promise<void> {
    // A synthetic marker job lets the panel follow the whole run without mistaking it for a file;
    // the per-source jobs below are the entries the progress bar actually lists and counts.
    library.ingest.setJob('__recompile_all__', 'running', 0, null)
    // 与“全部重新入库”一致：先把所有来源一次性登记为排队（0%），让进度列表在开始时整体归零、
    // 总条目数从一开始就稳定——否则已完成的来源会一直显示 100%，且总数会随循环推进而变化。
    for (const { source } of sources) {
      library.ingest.setJob(source, 'queued', 0, null)
    }
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index].source
      library.ingest.setJob(source, 'running', 0, null)
      try {
        const text = await readMirror(library, source)
        const indicators = extractIndicators(text, source, detectStandardNo(text))
        library.meta.setIndicators(source, indicators)
        await this.compile(library, source, text, indicators, (done, jobTotal) => {
          // 99, not 100: the last percent belongs to the run finishing rather than to this file.
          const percent = jobTotal === 0 ? 99 : Math.max(1, Math.round((done / jobTotal) * 99))
          library.ingest.setJob(source, 'running', percent, null)
        })
        library.ingest.setJob(source, 'done', 100, null)
      } catch (error) {
        library.ingest.setJob(source, 'failed', 100, String(error))
        this.deps.log.error(`recompile-all failed for ${source}: ${String(error)}`)
      }
    }
    // The final sync folds the freshly written entity/concept pages back into the index.
    await syncWikiIndex(library, this.deps.embedder, this.deps.log)
    library.ingest.setJob('__recompile_all__', 'done', 100, null)
    library.ingest.remove('__recompile_all__')
  }

  /**
   * Compile one source into Wiki pages.
   * @param library - Owning library.
   * @param sourceRelPath - POSIX path relative to the library root.
   * @param text - Parsed source text.
   * @param indicators - Indicators extracted from the source.
   * @param onProgress - Called as windows finish, for a caller that shows progress.
   */
  async compile(
    library: LibraryRuntime,
    sourceRelPath: string,
    text: string,
    indicators: Parameters<typeof compileWiki>[0]['indicators'],
    onProgress?: (done: number, total: number) => void,
  ): Promise<IngestOutcome> {
    // No runtime, or no resolvable route, keeps the compiler on its deterministic fallback.
    const selected = this.resolveModel(library)
    const complete = selected === null || !this.deps.models.ready
      ? null
      : (prompt: string, maxTokens: number): Promise<string> =>
          this.deps.models.complete(selected.provider, selected.model, prompt, maxTokens)
    const result = await compileWiki({
      library,
      sourceRelPath,
      sourceText: text,
      indicators,
      retrieve: (query, topK) => this.retrieveLexical(library.id, query, topK),
      complete,
      log: this.deps.log,
      windowChars: this.deps.settings.compileWindowChars,
      maxWindows: this.deps.settings.compileMaxWindows,
      maxTokens: this.deps.settings.compileMaxTokens,
      onProgress,
    })
    // The compiler just wrote pages; make them searchable before the caller moves on.
    await syncWikiIndex(library, this.deps.embedder, this.deps.log)
    return {
      chunks: 0,
      created: result.created,
      updated: result.updated,
      conflicts: result.conflicts,
    }
  }

  /**
   * Which model compiles one library: its own choice, else the plugin's configured route, else
   * the deployment default.
   * @param library - Library to resolve for.
   * @returns The provider and model, or null when none of the three exists.
   */
  resolveModel(library: LibraryRuntime): ModelRef | null {
    const provider = library.compileProvider !== '' ? library.compileProvider : this.deps.settings.compileProvider
    const model = library.compileModel !== '' ? library.compileModel : this.deps.settings.compileModel
    if (provider !== '' && model !== '') return { provider, model }
    return this.deps.models.defaultSelection()
  }

  /**
   * Model choices for one library, plus what it compiles with today.
   * @param libId - Library id; the active one when empty.
   * @returns The catalog scoped to that library.
   */
  async modelCatalog(libId: string): Promise<ModelCatalogView> {
    const catalog = await this.deps.models.catalog()
    const library = libId === '' ? this.deps.registry.getActive() : this.deps.registry.get(libId)
    const selected = library === undefined || library === null ? catalog.default : this.resolveModel(library)
    return { ...catalog, selected }
  }

  /**
   * Persist which model one library compiles with.
   * @param libId - Library id; the active one when empty.
   * @param provider - Provider route; empty restores the deployment default.
   * @param model - Model id; empty restores the deployment default.
   */
  async setCompileModel(libId: string, provider: string, model: string): Promise<void> {
    await this.deps.registry.setCompileModel(this.requireLibrary(libId).id, provider, model)
  }

  /** Conflict markers in the Wiki. */
  async conflicts(libId: string): Promise<PageConflict[]> {
    return await collectConflicts(this.requireLibrary(libId).wikiDir)
  }

  /** Rendered conflict report. */
  async conflictReport(libId: string): Promise<string> {
    return formatConflicts(await this.conflicts(libId))
  }

  /** Health check report. */
  async lint(libId: string): Promise<string> {
    return await lintWiki(this.requireLibrary(libId).wikiDir)
  }

  /** Library statistics. */
  async stats(libId: string): Promise<LibraryStats> {
    const library = this.requireLibrary(libId)
    return {
      backend: library.store.name,
      chunks: library.chunks.size,
      sources: library.meta.sourceCount,
      indicators: library.meta.indicatorCount,
      pages: (await listWikiPages(library.wikiDir)).length,
      vectors: library.vectors.size,
    }
  }

  /**
   * File extensions this deployment accepts, including any added by configuration.
   * @returns Sorted, dot-prefixed extensions.
   */
  supportedTypes(): readonly string[] {
    return supportedExtensions(this.deps.settings.extraSourceExtensions)
  }

  /** Raw `schema.md`. */
  async schemaGet(libId: string): Promise<string> {
    return await readFile(path.join(this.requireLibrary(libId).wikiDir, 'schema.md'), 'utf8').catch(() => '')
  }

  /** Structured view of `schema.md`. */
  async schemaParse(libId: string): Promise<SchemaForm> {
    return parseSchema(await this.schemaGet(libId))
  }

  /**
   * Merge a form back into `schema.md`.
   * @param libId - Library id.
   * @param form - Fields to write.
   */
  async schemaUpdate(libId: string, form: SchemaForm): Promise<string> {
    const library = this.requireLibrary(libId)
    const target = path.join(library.wikiDir, 'schema.md')
    const merged = mergeSchema(await this.schemaGet(libId), form)
    await writeFile(target, merged, 'utf8')
    return merged
  }

  /**
   * The persisted ingest queue the panel is showing: what is waiting, and one state per file.
   *
   * This is the only thing the browser reads about ingestion, so the panel and the file list can
   * never disagree with what the worker is doing. Only the asked-for library crosses the wire: the
   * payload carries one entry per file that library has ever ingested, so sending every library to
   * a panel that shows one was pure waste. A count of the busy others rides along, because the
   * panel names them without needing their contents.
   * @param libId - Library to report; empty or unknown reports nothing.
   * @returns That library's queue state, plus how many other libraries still have work.
   */
  ingestStates(libId: string): IngestSnapshot {
    const target = libId === '' ? undefined : this.deps.registry.get(libId)
    let othersBusy = 0
    for (const library of this.deps.registry.list()) {
      if (library.id === target?.id) continue
      const runtime = this.deps.registry.get(library.id)
      if (runtime === undefined) continue
      const busy = runtime.ingest.pendingCount > 0
        || Object.values(runtime.ingest.jobs()).some(job => job.status === 'running' || job.status === 'queued')
      if (busy) othersBusy += 1
    }
    return {
      state: target === undefined
        ? { pending: [], jobs: {} }
        : { pending: [...target.ingest.pending()], jobs: { ...target.ingest.jobs() } },
      othersBusy,
    }
  }

  /**
   * Import the per-file status an older version kept in `meta.json`.
   *
   * Without this, every library indexed before the queue got its own document would look untouched
   * (`○ 尚未入库`) until it was indexed again.
   * @returns The number of files imported.
   */
  migrateLegacyIngestStatus(): number {
    let count = 0
    for (const library of this.deps.registry.list()) {
      const runtime = this.deps.registry.get(library.id)
      if (runtime === undefined) continue
      const legacy = runtime.meta.takeLegacyIngestStatus()
      if (legacy === null) continue
      const known = runtime.ingest.jobs()
      for (const [rel, old] of Object.entries(legacy)) {
        if (rel in known) continue
        // A `running` record from a previous process can never finish; report it as failed.
        if (old.status === 'running') runtime.ingest.setJob(rel, 'failed', 100, '入库被中断（进程重启）')
        else runtime.ingest.setJob(rel, old.status === 'failed' ? 'failed' : 'done', 100, old.error)
        count += 1
      }
    }
    return count
  }

  /**
   * Mark files left `running` by a previous process as failed.
   *
   * A file only stays `running` while its process is alive; after a restart that file is never going
   * to finish on its own, so it is reported as failed. Anything still `queued` is left for
   * {@link IngestQueue.resumeAll}.
   * @returns The number of files recovered.
   */
  recoverInterrupted(): number {
    let count = 0
    for (const library of this.deps.registry.list()) {
      const runtime = this.deps.registry.get(library.id)
      if (runtime === undefined) continue
      count += runtime.ingest.failRunning('入库被中断（进程重启）')
    }
    return count
  }

  /**
   * Build the system-prompt knowledge block.
   * @param query - Latest user text, when the surface exposes one.
   * @returns Markdown to inject, or an empty string when nothing is configured.
   */
  ambientContext(query: string): string {
    const library = this.deps.registry.getActive()
    if (library === null) return ''
    return this.deps.ambient.build(library.id, query)
  }

  /** Embed a query, or null when no model is loaded. */
  private async queryVector(query: string): Promise<Float32Array | null> {
    if (!this.deps.embedder.ready) {
      this.deps.log.debug('[search] vector retrieval skipped: embedder not ready (lexical-only)')
      return null
    }
    try {
      const vectors = await this.deps.embedder.embed([query])
      this.deps.log.debug(`[search] embedded query vector dim=${vectors?.[0]?.length ?? 0}`)
      return vectors?.[0] ?? null
    } catch (error) {
      this.deps.log.warn(`query embedding failed, continuing lexically: ${String(error)}`)
      return null
    }
  }
}

/**
 * Read one source's mirror text, without its frontmatter.
 * @param library - Owning library.
 * @param sourceRelPath - POSIX path of the raw source relative to the library root.
 * @returns The mirror body.
 * @throws when the source has no mirror yet.
 */
async function readMirror(library: LibraryRuntime, sourceRelPath: string): Promise<string> {
  try {
    const content = await readFile(path.join(library.wikiDir, sourcePagePath(sourceRelPath)), 'utf8')
    return stripFrontmatter(content).trim()
  } catch {
    throw new Error('该来源还没有原文镜像，请先重新入库')
  }
}

/**
 * Drop the flattened mirror an earlier version left behind for a nested source.
 *
 * Mirrors used to be written to `sources/<name>.md` whatever folder the source sat in, so a source
 * from a sub-directory can still be shadowed by such an old page. It is removed only when its own
 * frontmatter names this very raw file: the flat path may just as well hold the mirror of a
 * root-level file that happens to share the name, and that one is not ours to delete.
 * @param library - Owning library.
 * @param rel - POSIX path of the raw source relative to the library root.
 * @param pagePath - The mirror path this source now owns.
 */
async function dropFlatMirror(library: LibraryRuntime, rel: string, pagePath: string): Promise<void> {
  const flat = sourcePagePath(rel.split(/[\\/]/).pop() ?? '')
  if (flat === pagePath) return
  const target = path.join(library.wikiDir, flat)
  let content: string
  try {
    content = await readFile(target, 'utf8')
  } catch {
    return
  }
  if (parseFrontmatter(content)['source'] !== rel) return
  try { await unlink(target) } catch { /* already absent */ }
  library.meta.clearPageEdited(flat)
}

/** Chunks currently indexed under one source key. */
function countChunks(library: LibraryRuntime, key: string): number {
  let count = 0
  for (const chunk of library.chunks.values()) if (chunk.sourcePath === key) count += 1
  return count
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

/** SHA-256 of a buffer, hex-encoded. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Reduce a caller-supplied relative directory path to a chain of safe segments.
 *
 * Each `/`-separated segment is run through the same sanitizer as a file name, so a folder such as
 * `a/b` stays two nested folders and anything with a separator or illegal character is flattened to
 * a safe name. Empty segments (e.g. a leading or doubled slash, or one that sanitizes away) throw.
 * @param relPath - POSIX directory path relative to `raw/`.
 * @returns The sanitized path with `/` separators preserved.
 * @throws when any segment yields no usable name.
 */
function sanitizeDirPath(relPath: string): string {
  return relPath.split('/').map(segment => sanitizeFileName(segment)).join('/')
}

/**
 * Remove the directories a deleted page left empty, up to but never including `wiki/`.
 *
 * `rmdir` refuses a directory that still holds anything, which is the stopping rule: the walk up
 * ends at the first level still in use.
 * @param wikiDir - Absolute Wiki directory, which is never removed.
 * @param dir - Directory to try first.
 */
async function pruneEmptyDirs(wikiDir: string, dir: string): Promise<void> {
  const root = path.resolve(wikiDir)
  let current = path.resolve(dir)
  while (current !== root && current.startsWith(root + path.sep)) {
    try {
      await rmdir(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}

/**
 * How many files sit anywhere under one directory; 0 when it cannot be read.
 *
 * Folders are walked but not counted, and nothing is `stat`ed: a directory entry already says which
 * it is, so the whole cost of counting a library is one `readdir` per directory it contains.
 * @param dir - Absolute directory to count.
 * @returns The number of files in its subtree.
 */
async function countFiles(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    total += entry.isDirectory() ? await countFiles(path.join(dir, entry.name)) : 1
  }
  return total
}

/** Every file under a directory, recursively. */
async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await collectFiles(full))
    else if (!entry.name.startsWith('.')) out.push(full)
  }
  return out
}
