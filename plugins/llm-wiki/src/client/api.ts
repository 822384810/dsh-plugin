/**
 * Transport for the browser half.
 *
 * Every call goes over Connection's authenticated `/api` Fetch channel, so the browser never
 * talks to a self-registered route and the host's trust fence applies unchanged.
 */
import type { ModelCatalogView } from '../shared/models.ts'
import type { SchemaForm } from '../shared/schema.ts'
import type { UploadResult } from '../shared/upload.ts'
import type { SourceDetail } from '../shared/source-detail.ts'
import { unwrap } from '@dsh-plugins-xz/result-utils'

/** Route owned by the Host half, below Connection's authenticated `/api`. */
const ROUTE = '/api/llm-wiki'

/** One registered library, as the Host projects it. */
export interface LibraryView {
  readonly id: string
  readonly name: string
  readonly rootDir: string
  /** Registration time, local `YYYY-MM-DD HH:mm:ss`; '' when unknown. */
  readonly createdAt: string
  readonly isActive: boolean
}

/** One directory entry. */
export interface FsEntry {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'folder'
  /** Entries directly inside a folder; absent for files, and on levels too wide to count. */
  readonly count?: number
}

/** A binary file rendered for in-app preview. */
export interface FilePreview {
  readonly mime: string
  readonly data: string
}

/** One Wiki page. */
export interface WikiPage {
  readonly path: string
  readonly title: string
  readonly type: string
  readonly updated: string
  readonly source: string
  /** True once a human edited the page in the panel. */
  readonly edited: boolean
}

/** One retrieval hit. */
export interface SearchHitView {
  readonly uid: string
  readonly content: string
  readonly sourcePath: string
  readonly score: number
}

/** Where one file is in the pipeline. */
export type IngestState = 'queued' | 'running' | 'done' | 'failed'

/** The one state a source file carries; mirrored from the persisted queue. */
export interface IngestJobState {
  readonly status: IngestState
  readonly progress: number
  readonly error: string | null
  readonly updatedAt: number
  readonly fileName: string
  readonly force: boolean
}

/** One library's persisted ingest queue, as the browser reads it. */
export interface IngestLibraryState {
  readonly pending: readonly string[]
  readonly jobs: Readonly<Record<string, IngestJobState>>
}

/** What one read of the ingest queue returns: the asked-for library, plus a count of busy others. */
export interface IngestSnapshot {
  /** The asked-for library's queue state; empty when no library was named or known. */
  readonly state: IngestLibraryState
  /** How many other libraries still have work in flight. */
  readonly othersBusy: number
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

/** One page carrying conflict markers. */
export interface PageConflict {
  readonly file: string
  readonly count: number
  readonly blocks: readonly string[]
}

/** Data access the components use; the components never call RPC themselves. */
export interface WikiActions {
  libraryList(): Promise<LibraryView[]>
  libraryAdd(name: string, rootDir: string): Promise<LibraryView>
  librarySwitch(libId: string): Promise<void>
  /** Rename a library; resolves with the updated projection. */
  libraryRename(libId: string, name: string): Promise<LibraryView>
  libraryRemove(libId: string): Promise<void>

  fsList(libId: string, path: string): Promise<FsEntry[]>
  fsRead(libId: string, path: string): Promise<string>
  fsDownload(libId: string, path: string): Promise<string>
  fsPreview(libId: string, path: string): Promise<FilePreview>
  fsWrite(libId: string, path: string, content: string): Promise<void>
  fsUpload(libId: string, fileName: string, base64: string, dir?: string): Promise<UploadResult>
  fsMkdir(libId: string, dir: string): Promise<void>
  /** Delete a file, or a folder with every file under it; reports how many files went. */
  fsDelete(libId: string, path: string): Promise<number>
  /** Re-ingest a file, or a folder with every file under it; reports how many were queued. */
  fsReingest(libId: string, path: string): Promise<number>

  listPages(libId: string): Promise<WikiPage[]>
  search(libId: string, query: string, topK: number): Promise<SearchHitView[]>
  recompile(libId: string, path: string): Promise<void>
  reindex(libId: string): Promise<number>
  recompileAll(libId: string): Promise<number>
  conflicts(libId: string): Promise<PageConflict[]>
  lint(libId: string): Promise<string>
  stats(libId: string): Promise<LibraryStats>
  /** Chunks and vectors indexed under one source key, for the inspector panel. */
  sourceDetail(libId: string, sourcePath: string): Promise<SourceDetail>
  /** File extensions this deployment accepts, for the upload picker and drop filter. */
  supportedTypes(): Promise<readonly string[]>

  schemaGet(libId: string): Promise<string>
  schemaParse(libId: string): Promise<SchemaForm>
  schemaUpdate(libId: string, form: SchemaForm): Promise<void>

  modelCatalog(libId: string): Promise<ModelCatalogView>
  setCompileModel(libId: string, provider: string, model: string): Promise<void>

  /** One library's queue state; pass no id and the Host reports nothing. */
  ingestStates(libId?: string): Promise<IngestSnapshot>
  /**
   * Open the web app's directory picker for a library root.
   *
   * Resolves `null` when the operator cancels, and equally when the deployment mounts no picker:
   * the dialog then stays a typed-path form instead of failing.
   */
  pickDirectory(): Promise<string | null>
}

/** One request call, unwrapped. */
type Call = (endpoint: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * Build the data access layer over the Host half's authenticated Fetch route.
 * @returns The actions the components consume.
 */
export function createWikiActions(): WikiActions {
  const call: Call = async (endpoint, args = {}) => {
    return await unwrap<unknown>(await fetch(ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, args }),
    }))
  }

  return {
    libraryList: async () => await call('library_list') as LibraryView[],
    libraryAdd: async (name, rootDir) => await call('library_add', { name, rootDir }) as LibraryView,
    librarySwitch: async libId => { await call('library_switch', { libId }) },
    libraryRename: async (libId, name) => await call('library_rename', { libId, name }) as LibraryView,
    libraryRemove: async libId => { await call('library_remove', { libId }) },

    fsList: async (libId, path) => await call('fs_list', { libId, path }) as FsEntry[],
    fsRead: async (libId, path) => String(await call('fs_read', { libId, path }) ?? ''),
    fsDownload: async (libId, path) => String(await call('fs_download', { libId, path }) ?? ''),
    fsPreview: async (libId, path) => (await call('fs_preview', { libId, path })) as FilePreview,
    fsWrite: async (libId, path, content) => { await call('fs_write', { libId, path, content }) },
    fsUpload: async (libId, fileName, base64, dir = '') => await call('fs_upload', { libId, fileName, base64, dir }) as UploadResult,
    fsMkdir: async (libId, dir) => { await call('fs_mkdir', { libId, dir }) },
    fsDelete: async (libId, path) => Number((await call('fs_delete', { libId, path }) as { removed?: number }).removed ?? 0),
    fsReingest: async (libId, path) => Number((await call('fs_reingest', { libId, path }) as { queued?: number }).queued ?? 0),

    listPages: async libId => await call('list_pages', { libId }) as WikiPage[],
    search: async (libId, query, topK) => await call('search', { libId, query, topK }) as SearchHitView[],
    recompile: async (libId, path) => { await call('recompile', { libId, path }) },
    reindex: async libId => Number((await call('reindex', { libId }) as { queued?: number }).queued ?? 0),
    recompileAll: async libId => Number((await call('recompile_all', { libId }) as { queued?: number }).queued ?? 0),
    conflicts: async libId => await call('conflicts', { libId }) as PageConflict[],
    lint: async libId => String((await call('lint', { libId }) as { report?: string }).report ?? ''),
    stats: async libId => await call('stats', { libId }) as LibraryStats,
    sourceDetail: async (libId, sourcePath) => await call('source_detail', { libId, sourcePath }) as SourceDetail,
    supportedTypes: async () => await call('supported_types') as readonly string[],

    schemaGet: async libId => String((await call('schema_get', { libId }) as { content?: string }).content ?? ''),
    schemaParse: async libId => await call('schema_parse', { libId }) as SchemaForm,
    schemaUpdate: async (libId, form) => { await call('schema_update', { libId, form }) },

    modelCatalog: async libId => await call('model_catalog', { libId }) as ModelCatalogView,
    setCompileModel: async (libId, provider, model) => { await call('model_set', { libId, provider, model }) },

    ingestStates: async (libId = '') => await call('ingest_state', { libId }) as IngestSnapshot,
    // `client/index.tsx` attaches the web app's picker when the running client mounts one; until
    // then — and in a client that mounts none — a pick simply reads as cancelled.
    pickDirectory: async () => null,
  }
}
