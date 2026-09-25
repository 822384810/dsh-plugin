/**
 * The multi-library registry.
 *
 * A library is a directory: `raw/` holds the immutable sources, `wiki/` holds what the LLM
 * maintains, and `.llm-wiki/` holds the index and sidecar metadata this plugin owns. The
 * registry itself is one JSON document listing the libraries and which one is active, so the
 * set survives restarts and can be edited by hand.
 */
import { mkdir, readFile, writeFile, access, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChunkBackend, StoredChunk } from '../store/backend.ts'
import { openStore } from '../store/index.ts'
import { MetaStore } from '../store/meta.ts'
import { IngestStateStore } from '../store/ingest-state.ts'
import { DEFAULT_SCHEMA } from '../shared/schema.ts'
import type { Logger } from '@dsh-plugins-xz/log-utils'
import { localTimestamp } from '@dsh-plugins-xz/time-utils'

/** Directory this plugin owns inside a library root. */
const OWN_DIR = '.llm-wiki'

/** Sub-directories the Wiki layer is organised into. */
const WIKI_SUBDIRS = ['entities', 'concepts', 'sources'] as const

/** Defaults applied to libraries that do not spell out their own. */
export interface LibraryDefaults {
  readonly chunkSize: number
  readonly chunkOverlap: number
  readonly topK: number
  readonly watch: boolean
}

/** One library as persisted. */
export interface LibraryRecord {
  readonly id: string
  /** Display name; mutable, because the panel can rename a registered library. */
  name: string
  readonly rootDir: string
  readonly chunkSize: number
  readonly chunkOverlap: number
  readonly topK: number
  readonly watch: boolean
  /** Provider route this library compiles with; empty follows the plugin config then the default. */
  compileProvider: string
  /** Model this library compiles with; empty follows the plugin config then the default. */
  compileModel: string
  /** Registration time, local `YYYY-MM-DD HH:mm:ss`; '' when a legacy record carried none. */
  createdAt: string
}

/** A library plus everything opened for it. */
export interface LibraryRuntime extends LibraryRecord {
  readonly rawDir: string
  readonly wikiDir: string
  readonly store: ChunkBackend
  readonly meta: MetaStore
  /** Persisted ingest queue: the single source of truth for ingest progress. */
  readonly ingest: IngestStateStore
  /** In-memory mirror of the indexed chunks, keyed by chunk uid. */
  readonly chunks: Map<string, StoredChunk>
  /** In-memory vectors, keyed by chunk uid; empty when no embedding model is loaded. */
  readonly vectors: Map<string, Float32Array>
}

/** The library list the browser and the model see. */
export interface LibraryView {
  readonly id: string
  readonly name: string
  readonly rootDir: string
  /** Registration time, local `YYYY-MM-DD HH:mm:ss`; '' when unknown. */
  readonly createdAt: string
  readonly isActive: boolean
}

/** The persisted registry document. */
interface RegistryDoc {
  activeLibraryId: string | null
  libraries: LibraryRecord[]
}

/** Per-library defaults and paths used when (re)creating a library. */
export class LibraryRegistry {
  private readonly libraries = new Map<string, LibraryRuntime>()
  private activeId: string | null = null

  /**
   * @param registryPath - Absolute path of the registry document.
   * @param defaults - Chunking and retrieval defaults for new libraries.
   * @param log - Where to report problems.
   */
  constructor(
    private readonly registryPath: string,
    private readonly defaults: LibraryDefaults,
    private readonly log: Logger,
  ) {}

  /** Every library, in registry order. */
  list(): LibraryView[] {
    return [...this.libraries.values()].map(library => ({
      id: library.id,
      name: library.name,
      rootDir: library.rootDir,
      createdAt: library.createdAt,
      isActive: library.id === this.activeId,
    }))
  }

  /** One opened library. */
  get(id: string): LibraryRuntime | undefined {
    return this.libraries.get(id)
  }

  /** The active library, or null when none is selected. */
  getActive(): LibraryRuntime | null {
    return this.activeId === null ? null : this.libraries.get(this.activeId) ?? null
  }

  /** Load the registry document and open every library it names. */
  async load(): Promise<void> {
    let doc: RegistryDoc
    try {
      doc = JSON.parse(await readFile(this.registryPath, 'utf8')) as RegistryDoc
    } catch {
      return
    }
    for (const record of doc.libraries ?? []) {
      try {
        await this.open(record)
      } catch (error) {
        this.log.error(`library ${record.id} failed to open: ${String(error)}`)
      }
    }
    this.activeId = typeof doc.activeLibraryId === 'string' && this.libraries.has(doc.activeLibraryId)
      ? doc.activeLibraryId
      : null
  }

  /**
   * Create and register a library.
   * @param input - Name and root directory; an id is generated when omitted.
   * @returns The opened library.
   */
  async add(input: { readonly id?: string; readonly name: string; readonly rootDir: string }): Promise<LibraryRuntime> {
    const rootDir = path.resolve(input.rootDir)
    const record: LibraryRecord = {
      id: input.id ?? `lib_${randomUUID()}`,
      name: input.name.trim() === '' ? path.basename(rootDir) : input.name,
      rootDir,
      chunkSize: this.defaults.chunkSize,
      chunkOverlap: this.defaults.chunkOverlap,
      topK: this.defaults.topK,
      watch: this.defaults.watch,
      // A fresh library follows the deployment default until the panel picks one.
      compileProvider: '',
      compileModel: '',
      createdAt: localTimestamp(),
    }
    const library = await this.open(record)
    if (this.activeId === null) this.activeId = library.id
    await this.persist()
    return library
  }

  /**
   * Record the model one library compiles with.
   * @param id - Library id.
   * @param provider - Provider route; empty clears back to the deployment default.
   * @param model - Model id; empty clears back to the deployment default.
   * @returns The updated library.
   * @throws when the library is unknown.
   */
  async setCompileModel(id: string, provider: string, model: string): Promise<LibraryRuntime> {
    const library = this.libraries.get(id)
    if (library === undefined) throw new Error(`unknown library: ${id}`)
    library.compileProvider = provider
    library.compileModel = model
    await this.persist()
    return library
  }

  /**
   * Rename one library. Its root directory — and every file inside it — is untouched.
   * @param id - Library id.
   * @param name - New display name; blank falls back to the root directory's last segment.
   * @returns The updated library.
   * @throws when the library is unknown.
   */
  async rename(id: string, name: string): Promise<LibraryRuntime> {
    const library = this.libraries.get(id)
    if (library === undefined) throw new Error(`unknown library: ${id}`)
    library.name = name.trim() === '' ? path.basename(library.rootDir) : name.trim()
    await this.persist()
    return library
  }

  /**
   * Make one library active.
   * @param id - Library id.
   */
  async setActive(id: string): Promise<void> {
    if (!this.libraries.has(id)) throw new Error(`unknown library: ${id}`)
    this.activeId = id
    await this.persist()
  }

  /**
   * Forget a library. Files on disk are left alone — only the registration is dropped.
   * @param id - Library id.
   */
  async remove(id: string): Promise<void> {
    const library = this.libraries.get(id)
    if (library === undefined) return
    library.store.close()
    this.libraries.delete(id)
    if (this.activeId === id) this.activeId = null
    await this.persist()
  }

  /** Close every open store. */
  closeAll(): void {
    for (const library of this.libraries.values()) library.store.close()
    this.libraries.clear()
    this.activeId = null
  }

  /** Open one library: create its directories, open its store, load its index. */
  private async open(record: LibraryRecord): Promise<LibraryRuntime> {
    const rawDir = path.join(record.rootDir, 'raw')
    const wikiDir = path.join(record.rootDir, 'wiki')
    const ownDir = path.join(record.rootDir, OWN_DIR)
    await mkdir(rawDir, { recursive: true })
    await mkdir(wikiDir, { recursive: true })
    await mkdir(ownDir, { recursive: true })
    for (const sub of WIKI_SUBDIRS) await mkdir(path.join(wikiDir, sub), { recursive: true })
    await ensureFile(path.join(wikiDir, 'schema.md'), DEFAULT_SCHEMA)

    const store = openStore(path.join(ownDir, 'index'))
    const meta = new MetaStore(path.join(ownDir, 'meta.json'))
    const ingest = new IngestStateStore(path.join(ownDir, 'ingest.json'))
    const snapshot = store.load()
    const runtime: LibraryRuntime = {
      ...record,
      // A registry written before per-library models or creation times existed has neither.
      compileProvider: typeof record.compileProvider === 'string' ? record.compileProvider : '',
      compileModel: typeof record.compileModel === 'string' ? record.compileModel : '',
      createdAt: typeof record.createdAt === 'string' && record.createdAt !== ''
        ? record.createdAt
        : await createdAtOf(ownDir),
      rawDir,
      wikiDir,
      store,
      meta,
      ingest,
      chunks: new Map(snapshot.chunks.map(chunk => [chunk.uid, chunk])),
      vectors: new Map(snapshot.vectors),
    }
    this.libraries.set(record.id, runtime)
    return runtime
  }

  /** Write the registry document back. */
  private async persist(): Promise<void> {
    const doc: RegistryDoc = {
      activeLibraryId: this.activeId,
      libraries: [...this.libraries.values()].map(library => ({
        id: library.id,
        name: library.name,
        rootDir: library.rootDir,
        chunkSize: library.chunkSize,
        chunkOverlap: library.chunkOverlap,
        topK: library.topK,
        watch: library.watch,
        compileProvider: library.compileProvider,
        compileModel: library.compileModel,
        createdAt: library.createdAt,
      })),
    }
    await mkdir(path.dirname(this.registryPath), { recursive: true })
    await writeFile(this.registryPath, `${JSON.stringify(doc, undefined, 2)}\n`, 'utf8')
  }
}

/** Create a file with default content, leaving an existing one untouched. */
async function ensureFile(filePath: string, content: string): Promise<void> {
  try {
    await access(filePath)
  } catch {
    await writeFile(filePath, content, 'utf8')
  }
}

/**
 * Registration time for a library whose record predates the field.
 *
 * The plugin's own directory inside the root carries the closest honest answer; a filesystem that
 * does not report a birth time leaves the value unknown rather than invented.
 * @param ownDir - Absolute path of the library's `.llm-wiki/` directory.
 * @returns A local timestamp, or '' when none is available.
 */
async function createdAtOf(ownDir: string): Promise<string> {
  try {
    // A filesystem that cannot report a birth time reads back as the epoch — the same "unknown".
    const created = (await stat(ownDir)).birthtime.getTime()
    return created > 0 ? localTimestamp(created) : ''
  } catch {
    return ''
  }
}
