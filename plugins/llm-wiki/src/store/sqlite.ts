/**
 * SQLite-backed chunk store.
 *
 * `node:sqlite` ships with Node 22.5+ and carries FTS5, so the usual case needs no native
 * dependency at all. Trigram tokenization is what makes Chinese usable without a word
 * segmenter: it matches on three-character runs, so no jieba dictionary is required. When
 * FTS5 is unavailable the backend degrades to `LIKE` scanning; retrieval gets weaker, not
 * broken.
 *
 * Vectors are stored as BLOBs and compared in JS rather than through `sqlite-vec`, which
 * would add a native dependency for an approximate search this plugin does not need at
 * library scale.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
import type { ChunkBackend, LexicalHit, Snapshot, StoredChunk } from './backend.ts'

/** The slice of a SQLite statement this plugin uses. */
interface SqliteStatement {
  run(...params: readonly unknown[]): unknown
  all(...params: readonly unknown[]): unknown[]
}

/** The slice of a SQLite database this plugin uses. */
interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

/** Constructor shape of `node:sqlite`'s `DatabaseSync`. */
type SqliteCtor = new (path: string) => SqliteDatabase

/**
 * Load the built-in SQLite driver when the running Node provides it.
 * @returns The database constructor, or null when unavailable.
 */
export function loadSqlite(): SqliteCtor | null {
  try {
    const required = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: unknown }
    return typeof required.DatabaseSync === 'function' ? required.DatabaseSync as SqliteCtor : null
  } catch {
    return null
  }
}

/** Chunk table plus its FTS5 shadow and the vector side table. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  uid         TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  source_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  file_hash   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_path);
CREATE TABLE IF NOT EXISTS chunk_vectors (
  uid  TEXT PRIMARY KEY,
  dim  INTEGER NOT NULL,
  data BLOB NOT NULL
);
`

/** External-content FTS5 index in trigram (CJK-friendly) form. */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content, source_path,
  content='chunks', content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, source_path)
  VALUES (new.rowid, new.content, new.source_path);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, source_path)
  VALUES ('delete', old.rowid, old.content, old.source_path);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, source_path)
  VALUES ('delete', old.rowid, old.content, old.source_path);
  INSERT INTO chunks_fts(rowid, content, source_path)
  VALUES (new.rowid, new.content, new.source_path);
END;
`

/** Chunk store backed by SQLite. */
export class SqliteBackend implements ChunkBackend {
  readonly name = 'sqlite'

  private readonly db: SqliteDatabase
  private readonly fts: boolean

  /**
   * Open (or create) the store.
   * @param dbPath - Absolute path of the SQLite file.
   * @param ctor - Database constructor from {@link loadSqlite}.
   * @throws when the file cannot be opened or the schema cannot be created.
   */
  constructor(dbPath: string, ctor: SqliteCtor) {
    mkdirSync(dirname(dbPath), { recursive: true })
    const db = new ctor(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(SCHEMA)
    let fts = false
    try {
      db.exec(FTS_SCHEMA)
      fts = true
    } catch {
      fts = false
    }
    this.db = db
    this.fts = fts
  }

  /** Whether full-text search is available on this installation. */
  get hasFts(): boolean {
    return this.fts
  }

  load(): Snapshot {
    const chunkRows = this.db.prepare(
      'SELECT uid, content, source_path, chunk_index, file_hash FROM chunks',
    ).all() as Array<Record<string, unknown>>
    const vectorRows = this.db.prepare('SELECT uid, data FROM chunk_vectors').all() as Array<Record<string, unknown>>
    const vectors = new Map<string, Float32Array>()
    for (const row of vectorRows) {
      const data = row['data']
      const uid = typeof row['uid'] === 'string' ? row['uid'] : ''
      if (uid === '' || !(data instanceof Uint8Array)) continue
      vectors.set(uid, new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)))
    }
    return { chunks: chunkRows.map(row => toChunk(row)), vectors }
  }

  replaceSource(
    sourcePath: string,
    chunks: readonly StoredChunk[],
    vectors: ReadonlyMap<string, Float32Array>,
  ): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare(
        'DELETE FROM chunk_vectors WHERE uid IN (SELECT uid FROM chunks WHERE source_path = ?)',
      ).run(sourcePath)
      this.db.prepare('DELETE FROM chunks WHERE source_path = ?').run(sourcePath)
      const insertChunk = this.db.prepare(
        'INSERT INTO chunks (uid, content, source_path, chunk_index, file_hash) VALUES (?, ?, ?, ?, ?)',
      )
      const insertVector = this.db.prepare('INSERT INTO chunk_vectors (uid, dim, data) VALUES (?, ?, ?)')
      for (const chunk of chunks) {
        insertChunk.run(chunk.uid, chunk.content, chunk.sourcePath, chunk.chunkIndex, chunk.fileHash)
        const vector = vectors.get(chunk.uid)
        if (vector !== undefined) {
          insertVector.run(chunk.uid, vector.length, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength))
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  deleteSource(sourcePath: string): number {
    this.db.exec('BEGIN')
    try {
      this.db.prepare(
        'DELETE FROM chunk_vectors WHERE uid IN (SELECT uid FROM chunks WHERE source_path = ?)',
      ).run(sourcePath)
      this.db.prepare('DELETE FROM chunks WHERE source_path = ?').run(sourcePath)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    const row = this.db.prepare('SELECT changes() AS n').all()[0] as { n?: unknown } | undefined
    return typeof row?.n === 'number' ? row.n : 0
  }

  clear(): void {
    this.db.exec('DELETE FROM chunk_vectors')
    this.db.exec('DELETE FROM chunks')
  }

  lexical(query: string, limit: number): LexicalHit[] {
    if (this.fts && Array.from(query.trim()).length >= 3) {
      try {
        const rows = this.db.prepare(
          `SELECT c.uid AS uid, -bm25(chunks_fts) AS score
           FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
           WHERE chunks_fts MATCH ? ORDER BY score DESC LIMIT ?`,
        ).all(ftsQuery(query), limit) as Array<Record<string, unknown>>
        return rows.map(row => ({ uid: String(row['uid'] ?? ''), score: Number(row['score'] ?? 0) }))
      } catch {
        // A malformed MATCH expression must not take retrieval down with it.
      }
    }
    const rows = this.db.prepare(
      'SELECT uid, 1 AS score FROM chunks WHERE content LIKE ? LIMIT ?',
    ).all(`%${likeQuery(query)}%`, limit) as Array<Record<string, unknown>>
    return rows.map(row => ({ uid: String(row['uid'] ?? ''), score: Number(row['score'] ?? 0) }))
  }

  close(): void {
    this.db.close()
  }
}

/** Coerce a raw row into a stored chunk. */
function toChunk(row: Record<string, unknown>): StoredChunk {
  return {
    uid: String(row['uid'] ?? ''),
    content: String(row['content'] ?? ''),
    sourcePath: String(row['source_path'] ?? ''),
    chunkIndex: Number(row['chunk_index'] ?? 0),
    fileHash: String(row['file_hash'] ?? ''),
  }
}

/**
 * Turn a user query into an FTS5 MATCH expression.
 *
 * The whole query is no longer wrapped in a single pair of quotes: that made a multi-word query a
 * single positional phrase (every term had to appear, in order, contiguously), which almost never
 * matched and is what made `wiki_search` return nothing for natural-language questions. Instead we
 * split on whitespace and OR the terms, so "电子政务数据元 设计方法" matches any chunk containing
 * either term. trigram ignores terms shorter than three characters, so short English words are simply
 * skipped rather than erroring. A single term keeps the original phrase behaviour.
 *
 * @param query - Raw query text from the model.
 * @returns An FTS5 MATCH expression.
 */
export function ftsQuery(query: string): string {
  const terms = query.replace(/["*()^:{}]/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (terms.length <= 1) return `"${terms.join(' ')}"`
  return terms.map(term => `"${term}"`).join(' OR ')
}

/** Strip LIKE wildcards so a user query can only match literally. */
function likeQuery(query: string): string {
  return query.replace(/[%_]/g, ' ').trim()
}
