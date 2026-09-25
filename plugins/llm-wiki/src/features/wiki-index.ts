/**
 * Indexing the Wiki layer for retrieval.
 *
 * Raw text is never indexed directly: a source is parsed once into its mirror page, and the mirror
 * is what the index stores. That keeps exactly one copy of a source's text in the index — no
 * duplicate between `raw/` and the Wiki layer — and lets a human-corrected mirror be what gets
 * searched. The mirror is keyed by its raw source path, so a hit names the file the user uploaded;
 * entity and concept pages keep a `wiki/`-prefixed key of their own.
 */
import { access, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { LibraryRuntime } from './registry.ts'
import type { Embedder } from './embedder.ts'
import type { StoredChunk } from '../store/backend.ts'
import type { Logger } from '@dsh-plugins-xz/log-utils'
import { scanWikiPages, type WikiPageSummary } from './pages.ts'
import { chunkText } from '../shared/chunk.ts'

/** Prefix marking a stored chunk as coming from the Wiki layer rather than `raw/`. */
const WIKI_PREFIX = 'wiki/'

/**
 * Bring the retrieval index in line with what is on disk under `wiki/`.
 *
 * A page whose content hash already matches is left alone, so an ordinary compile only pays to
 * re-chunk the pages it actually wrote. Pages that disappeared are dropped, so a deleted or
 * renamed page never stays searchable.
 * @param library - Library whose Wiki layer to index.
 * @param embedder - Optional embedding model; without it the new chunks are lexical only.
 * @param log - Diagnostics sink.
 */
export async function syncWikiIndex(library: LibraryRuntime, embedder: Embedder, log: Logger): Promise<void> {
  const indexed = hashBySource(library)
  const live = new Set<string>()
  for (const { summary: page, digest } of await scanWikiPages(library.wikiDir)) {
    const key = keyForPage(page)
    live.add(key)
    // An empty page has nothing to index; the scan reports it as an empty digest.
    if (digest === '') {
      dropSource(library, key)
      continue
    }
    // Unchanged pages are decided from the digest alone, so a run over a large library only reads
    // the pages that actually moved.
    if (indexed.get(key) === digest) continue
    let content: string
    try {
      content = await readFile(path.join(library.wikiDir, page.path), 'utf8')
    } catch {
      // A page that vanished mid-walk is handled by the sweep below.
      continue
    }
    try {
      await writeSource(library, embedder, key, content.trim(), digest, log)
    } catch (error) {
      // One unreadable page must not abort indexing the rest.
      log.warn(`indexing wiki page ${page.path} failed: ${String(error)}`)
    }
  }
  for (const key of indexed.keys()) {
    if (live.has(key)) continue
    // A raw-path key whose file is still on disk belongs to a source ingested before it had a
    // mirror. Keep it: an upgrade must not empty the index for files that are simply not
    // re-ingested yet. A key with no live file is genuinely stale and can go.
    if (await isLiveRawSource(library, key)) continue
    dropSource(library, key)
  }
}

/**
 * Whether an index key names a raw file that still exists on disk.
 * @param library - Owning library.
 * @param key - Chunk source path.
 * @returns True when the key is a raw path whose file is present.
 */
async function isLiveRawSource(library: LibraryRuntime, key: string): Promise<boolean> {
  if (key.startsWith(WIKI_PREFIX)) return false
  try {
    await access(path.join(library.rootDir, key))
    return true
  } catch {
    return false
  }
}

/**
 * The name a chunk's breadcrumb can give for its document.
 *
 * A mirror is keyed by its raw path, and for the standards in a library like this the uploaded file's
 * name is the standard's number — the words a question about it will use — so it is repeated in every
 * chunk of that file. A Wiki page names itself in its own first heading, so a `wiki/` key adds nothing.
 * @param key - Index key of the source being chunked.
 * @returns The document's name, or `''` when the key names no single file.
 */
function titleOf(key: string): string {
  if (key.startsWith(WIKI_PREFIX)) return ''
  // An upload that collided with an existing name is stored with a short digest appended; that is
  // bookkeeping rather than part of the name.
  return path.basename(key).replace(/\.[^.]+$/, '').replace(/_[0-9A-F]{8}$/, '')
}

/** Chunk, embed and store one page, replacing whatever was stored for it before. */
async function writeSource(
  library: LibraryRuntime,
  embedder: Embedder,
  key: string,
  text: string,
  hash: string,
  log: Logger,
): Promise<void> {
  const pieces = chunkText(text, library.chunkSize, library.chunkOverlap, titleOf(key))
  const vectors = await embedOrNull(embedder, pieces)
  if (vectors === null) {
    log.debug(`[ingest] ${key}: embeddings skipped (embedder not ready) -> ${pieces.length} lexical-only chunks`)
  } else {
    log.debug(`[ingest] ${key}: embedded ${vectors.length} chunks, dim=${vectors[0]?.length ?? 0}`)
  }
  // A tag derived from the key keeps two sources that happen to hold identical text from colliding
  // on the chunk primary key.
  const tag = createHash('sha256').update(key).digest('hex').slice(0, 12)
  const rows: StoredChunk[] = pieces.map((content, index) => ({
    uid: `${tag}_${String(index)}`,
    content,
    sourcePath: key,
    chunkIndex: index,
    fileHash: hash,
  }))
  const vectorMap = new Map<string, Float32Array>()
  rows.forEach((row, index) => {
    const vector = vectors?.[index]
    if (vector !== undefined) vectorMap.set(row.uid, vector)
  })
  dropSource(library, key)
  library.store.replaceSource(key, rows, vectorMap)
  for (const row of rows) library.chunks.set(row.uid, row)
  for (const [uid, vector] of vectorMap) library.vectors.set(uid, vector)
}

/** Embed a batch, tolerating a missing or failing model. */
async function embedOrNull(embedder: Embedder, pieces: readonly string[]): Promise<Float32Array[] | null> {
  if (!embedder.ready || pieces.length === 0) return null
  try {
    return await embedder.embed(pieces)
  } catch {
    return null
  }
}

/** Drop one source from both the store and the in-memory mirrors. */
function dropSource(library: LibraryRuntime, key: string): void {
  library.store.deleteSource(key)
  for (const [uid, chunk] of library.chunks) {
    if (chunk.sourcePath !== key) continue
    library.chunks.delete(uid)
    library.vectors.delete(uid)
  }
}

/**
 * Content hash already indexed for each stored source.
 *
 * Every chunk in the store is Wiki-derived — raw text is never indexed directly — so the whole
 * mirror can be scanned without filtering by prefix.
 */
function hashBySource(library: LibraryRuntime): Map<string, string> {
  const out = new Map<string, string>()
  for (const chunk of library.chunks.values()) out.set(chunk.sourcePath, chunk.fileHash)
  return out
}

/**
 * The index key one page's chunks are stored under.
 *
 * A mirror is stored under its raw source path, so a retrieval hit names the file the user
 * uploaded and opening it shows the original rather than the mirror, whose formatting is only
 * approximate. Every other page keeps a `wiki/` key of its own.
 * @param page - One Wiki page.
 * @returns The key its chunks are stored under.
 */
function keyForPage(page: WikiPageSummary): string {
  if (page.path.startsWith('sources/') && page.source !== '') return page.source
  return `${WIKI_PREFIX}${page.path}`
}
