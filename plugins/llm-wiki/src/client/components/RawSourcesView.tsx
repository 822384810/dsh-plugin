/** Raw sources: the immutable first layer — upload, browse, read, re-ingest, delete. */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { Button, Modal, MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconDatabaseOutlineRegular, IconTrashOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular, IconPlusOutlineRegular, IconDownloadOutlineRegular, IconPaperclipOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FsEntry, FilePreview, IngestJobState, IngestLibraryState, WikiActions } from '../api.ts'
import type { UploadResult } from '../../shared/upload.ts'
import type { Translate } from '../translate.ts'
import { template } from '../translate.ts'
import { FONT_FAMILY, FONT_SIZE_BODY, FONT_SIZE_SMALL, ROW_PADDING } from '../typography.ts'

/** Left padding of a top-level tree row, and the extra step added for each level below it. */
const TREE_INDENT_BASE = 8
const TREE_INDENT_STEP = 12

/** How many entries of one folder are rendered before it offers to render the next batch. */
const DIR_BATCH = 100

/**
 * Horizontal padding for the two icon-only actions on a file row.
 *
 * `Button`'s compact size pads 10px a side, which adds up to a 24px gap between the icons — wider
 * than the file name's own gutter, so the pair reads as two loose controls instead of one group.
 * 6px keeps each target at 28px, the width the harness gives an icon-only button.
 */
const ROW_ACTION_STYLE: CSSProperties = { padding: '0 6px' }

/** The trailing action also absorbs the row's 4px gap, bringing the pair 12px apart. */
const TRAILING_ACTION_STYLE: CSSProperties = { padding: '0 6px', marginLeft: -4 }

/** Props: data access, copy and the active library. */
export interface RawSourcesViewProps extends Pick<
  WikiActions,
  | 'fsList' | 'fsRead' | 'fsUpload' | 'fsMkdir' | 'fsDelete' | 'fsReingest' | 'fsDownload' | 'fsPreview'
  | 'supportedTypes' | 'reindex'
> {
  readonly t: Translate
  readonly libId: string | null
  /** The selected library's queue state, from the panel's single poller. */
  readonly state: IngestLibraryState
  /** Ask that poller to read again now, so a fresh upload's badge shows without waiting. */
  readonly refresh: () => void
  /** Raise a transient message at the top of the panel. */
  readonly notify?: ((message: string) => void) | undefined
}

/** Per-file badge, rendered straight from the persisted queue state. */
function IngestBadge({ job, t }: { readonly job: IngestJobState | undefined; readonly t: Translate }): ReactElement {
  if (job === undefined) {
    return (
      <span style={{ flex: '0 0 auto', fontSize: FONT_SIZE_SMALL, opacity: 0.45 }} title={t('raw.ingestNone')}>○</span>
    )
  }
  if (job.status === 'queued') {
    return (
      <span style={{ flex: '0 0 auto', fontSize: FONT_SIZE_SMALL, opacity: 0.6 }} title={t('raw.ingestQueued')}>⋯</span>
    )
  }
  if (job.status === 'running') {
    return (
      <span
        style={{ flex: '0 0 auto', fontSize: FONT_SIZE_SMALL, color: 'var(--dsw-alias-state-business-primary)', minWidth: 28, textAlign: 'right' }}
        title={t('raw.ingesting')}
      >
        {`${String(job.progress)}%`}
      </span>
    )
  }
  if (job.status === 'done') {
    return (
      <span style={{ flex: '0 0 auto', fontSize: FONT_SIZE_SMALL, color: 'var(--dsw-alias-state-success-primary)' }} title={t('raw.ingestDone')}>✓</span>
    )
  }
  return (
    <span
      style={{ flex: '0 0 auto', fontSize: FONT_SIZE_SMALL, color: 'var(--dsw-alias-state-error-primary)', cursor: 'help' }}
      title={job.error ?? t('raw.ingestFailed')}
    >✗</span>
  )
}

/** Whether a file name carries one of the accepted extensions. */
function supports(fileName: string, extensions: readonly string[]): boolean {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 && extensions.includes(fileName.slice(dot).toLowerCase())
}

/** Whether a directory entry answers a lower-cased filter query. */
function matchesRaw(entry: FsEntry, needle: string): boolean {
  return entry.name.toLowerCase().includes(needle)
    || entry.path.toLowerCase().includes(needle)
    || entry.type.toLowerCase().includes(needle)
}

/** Read a `File` as base64 without the data-URL prefix. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result)
      resolve(text.slice(text.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** Extensions whose bytes are not text and must not be decoded for preview. */
const BINARY_EXTENSIONS = new Set(['.pdf', '.docx'])

/** Extensions that hold Markdown source and should be rendered by the Markdown reader. */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd'])

/** Extensions that hold JSON source and should be rendered by the JSON reader. */
const JSON_EXTENSIONS = new Set(['.json'])

/** Extensions that hold CSV source and should be rendered by the table reader. */
const CSV_EXTENSIONS = new Set(['.csv'])

/** Extensions that hold HTML source and should be rendered as a sandboxed web page. */
const HTML_EXTENSIONS = new Set(['.html', '.htm'])

/** Extensions that hold XML source and should be rendered with syntax highlighting. */
const XML_EXTENSIONS = new Set(['.xml'])

/** Extensions that hold YAML source and should be rendered with syntax highlighting. */
const YAML_EXTENSIONS = new Set(['.yaml', '.yml'])

/** Whether a raw source path points at a binary document that cannot be shown as text. */
function isBinary(sourcePath: string): boolean {
  const dot = sourcePath.lastIndexOf('.')
  return dot >= 0 && BINARY_EXTENSIONS.has(sourcePath.slice(dot).toLowerCase())
}

/** Whether a raw source path holds Markdown and should be rendered by the reader rather than as plain text. */
function isMarkdown(sourcePath: string): boolean {
  const dot = sourcePath.lastIndexOf('.')
  return dot >= 0 && MARKDOWN_EXTENSIONS.has(sourcePath.slice(dot).toLowerCase())
}

/** Whether a raw source path holds JSON and should be rendered by the reader. */
function isJson(sourcePath: string): boolean {
  const dot = sourcePath.lastIndexOf('.')
  return dot >= 0 && JSON_EXTENSIONS.has(sourcePath.slice(dot).toLowerCase())
}

/** Whether a raw source path holds CSV and should be rendered by the table reader. */
function isCsv(sourcePath: string): boolean {
  const dot = sourcePath.lastIndexOf('.')
  return dot >= 0 && CSV_EXTENSIONS.has(sourcePath.slice(dot).toLowerCase())
}

/** Whether a raw source path holds HTML and should be rendered as a sandboxed web page. */
function isHtml(sourcePath: string): boolean {
  const dot = sourcePath.lastIndexOf('.')
  return dot >= 0 && HTML_EXTENSIONS.has(sourcePath.slice(dot).toLowerCase())
}

/** Build a human-readable line for one upload outcome. */
function describeUpload(t: Translate, outcome: UploadResult): string {
  switch (outcome.status) {
    case 'created': return template(t, 'raw.uploadCreated', { rel: outcome.rel })
    case 'duplicate': return template(t, 'raw.uploadDuplicate', { rel: outcome.rel })
    case 'renamed': return template(t, 'raw.uploadRenamed', { rel: outcome.rel, renamedTo: outcome.renamedTo ?? outcome.rel })
    default: return outcome.rel
  }
}

/** Whether a raw source path holds XML and should be rendered with syntax highlighting. */
function isXml(sourcePath: string): boolean {
  const dot = sourcePath.lastIndexOf('.')
  return dot >= 0 && XML_EXTENSIONS.has(sourcePath.slice(dot).toLowerCase())
}

/** Whether a raw source path holds YAML and should be rendered with syntax highlighting. */
function isYaml(sourcePath: string): boolean {
  const dot = sourcePath.lastIndexOf('.')
  return dot >= 0 && YAML_EXTENSIONS.has(sourcePath.slice(dot).toLowerCase())
}

/** Token colours shared by the XML and YAML highlighters. */
const CODE_COLORS = {
  tag: '#c026d3',
  attr: '#3b82f6',
  string: '#16a34a',
  comment: '#6b7280',
  number: '#d97706',
  literal: '#db2777',
} as const

/** Highlight XML: tags, attribute names, attribute values and comments. */
function highlightXml(source: string): ReactElement[] {
  const nodes: ReactElement[] = []
  const regex =
    /(<!--[\s\S]*?-->)|(<!\[CDATA\[[\s\S]*?\]\]>)|(<\/?[A-Za-z][\w:.-]*)|(\/?>)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_][\w:.-]*(?=\s*=))/g
  let last = 0
  let serial = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(source)) !== null) {
    if (match.index > last) nodes.push(<span key={serial++}>{source.slice(last, match.index)}</span>)
    if (match[1] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.comment }}>{match[1]}</span>)
    } else if (match[2] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.string }}>{match[2]}</span>)
    } else if (match[3] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.tag }}>{match[3]}</span>)
    } else if (match[4] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.tag }}>{match[4]}</span>)
    } else if (match[5] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.string }}>{match[5]}</span>)
    } else if (match[6] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.attr }}>{match[6]}</span>)
    }
    last = regex.lastIndex
  }
  if (last < source.length) nodes.push(<span key={serial++}>{source.slice(last)}</span>)
  return nodes
}

/** Highlight YAML: keys, strings, numbers, booleans/null, list markers and comments. */
function highlightYaml(source: string): ReactElement[] {
  const nodes: ReactElement[] = []
  const regex =
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#[^\n]*)|(\b(?:true|false|null|yes|no|~)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(^\s*-\s)|([A-Za-z_][\w.-]*:(?=\s|$))/gm
  let last = 0
  let serial = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(source)) !== null) {
    if (match.index > last) nodes.push(<span key={serial++}>{source.slice(last, match.index)}</span>)
    if (match[1] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.string }}>{match[1]}</span>)
    } else if (match[2] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.comment }}>{match[2]}</span>)
    } else if (match[3] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.literal }}>{match[3]}</span>)
    } else if (match[4] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.number }}>{match[4]}</span>)
    } else if (match[5] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.tag }}>{match[5]}</span>)
    } else if (match[6] !== undefined) {
      nodes.push(<span key={serial++} style={{ color: CODE_COLORS.attr }}>{match[6]}</span>)
    }
    last = regex.lastIndex
  }
  if (last < source.length) nodes.push(<span key={serial++}>{source.slice(last)}</span>)
  return nodes
}

/** Render source with language-specific token highlighting. */
function CodeView({
  text,
  highlight,
}: {
  text: string
  highlight: (source: string) => ReactElement[]
}): ReactElement {
  return (
    <pre
      style={{
        margin: 0,
        fontSize: FONT_SIZE_BODY,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-primary)',
      }}
    >
      {highlight(text)}
    </pre>
  )
}

/** Parse CSV text into rows, honouring quotes, escaped quotes and embedded newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let index = 0
  const length = text.length
  while (index < length) {
    const char = text[index]
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"') {
      inQuotes = true
      index += 1
    } else if (char === ',') {
      row.push(field)
      field = ''
      index += 1
    } else if (char === '\r') {
      index += 1
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      index += 1
    } else {
      field += char
      index += 1
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Render CSV as a scrollable table with a sticky header row. */
function CsvView({ text }: { text: string }): ReactElement {
  const rows = parseCsv(text)
  if (rows.length === 0) {
    return (
      <pre
        style={{
          margin: 0,
          fontSize: FONT_SIZE_BODY,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--dsw-alias-label-primary)',
        }}
      >
        {text}
      </pre>
    )
  }
  const [header, ...body] = rows
  const cellStyle: CSSProperties = {
    border: '1px solid var(--dsw-alias-border-l2)',
    padding: '4px 8px',
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    verticalAlign: 'top',
  }
  return (
    <div style={{ overflow: 'auto', maxHeight: '100%' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: FONT_SIZE_BODY, width: '100%' }}>
        <thead>
          <tr>
            {header.map((cell, column) => (
              <th
                key={column}
                style={{
                  ...cellStyle,
                  position: 'sticky',
                  top: 0,
                  background: 'var(--dsw-alias-interactive-bg-active)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontWeight: 600,
                }}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((record, recordIndex) => (
            <tr key={recordIndex}>
              {record.map((cell, column) => (
                <td key={column} style={{ ...cellStyle, color: 'var(--dsw-alias-label-primary)' }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Render pretty-printed JSON with lightweight token highlighting. */
function JsonView({ text, t }: { text: string; t: Translate }): ReactElement {
  let pretty = text
  let invalid: string | null = null
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2)
  } catch (reason) {
    invalid = reason instanceof Error ? reason.message : String(reason)
  }
  return (
    <div>
      {invalid !== null && (
        <div style={{ fontSize: FONT_SIZE_SMALL, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 8 }}>
          {t('raw.jsonInvalid')}: {invalid}
        </div>
      )}
      <pre
        style={{
          margin: 0,
          fontSize: FONT_SIZE_BODY,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: 'var(--dsw-alias-label-primary)',
        }}
      >
        {highlightJson(pretty)}
      </pre>
    </div>
  )
}

/** Token colours for the JSON highlighter, readable on both light and dark themes. */
const JSON_TOKEN_COLORS = {
  key: '#3b82f6',
  string: '#16a34a',
  number: '#d97706',
  literal: '#db2777',
} as const

/** Classify JSON tokens so keys, strings, numbers and literals get distinct colours. */
function highlightJson(source: string): ReactElement[] {
  const nodes: ReactElement[] = []
  const regex = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g
  let last = 0
  let serial = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(source)) !== null) {
    if (match.index > last) nodes.push(<span key={serial++}>{source.slice(last, match.index)}</span>)
    const full = match[0]
    const quote = match[1]
    const colon = match[2]
    const literal = match[3]
    const number = match[4]
    if (quote !== undefined) {
      if (colon !== undefined) {
        nodes.push(<span key={serial++} style={{ color: JSON_TOKEN_COLORS.key }}>{quote}</span>)
        nodes.push(<span key={serial++}>{colon}</span>)
      } else {
        nodes.push(<span key={serial++} style={{ color: JSON_TOKEN_COLORS.string }}>{quote}</span>)
      }
    } else if (literal !== undefined) {
      nodes.push(<span key={serial++} style={{ color: JSON_TOKEN_COLORS.literal }}>{literal}</span>)
    } else if (number !== undefined) {
      nodes.push(<span key={serial++} style={{ color: JSON_TOKEN_COLORS.number }}>{number}</span>)
    } else {
      nodes.push(<span key={serial++}>{full}</span>)
    }
    last = regex.lastIndex
  }
  if (last < source.length) nodes.push(<span key={serial++}>{source.slice(last)}</span>)
  return nodes
}

/**
 * Browse and feed `raw/`.
 * @param props - Data access, copy and the active library.
 * @returns The view.
 */
export function RawSourcesView({
  fsList, fsRead, fsUpload, fsMkdir, fsDelete, fsReingest, fsDownload, fsPreview, supportedTypes, reindex,
  t, libId, state, refresh, notify,
}: RawSourcesViewProps): ReactElement {
  // The badges come straight from the panel's shared snapshot: this list and the progress panel are
  // two views of one read rather than two readers of one document.
  const jobs = state.jobs
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [supported, setSupported] = useState<readonly string[]>([])

  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  // The path awaiting a delete confirmation, plus the file count when it is a folder.
  const [pendingDelete, setPendingDelete] = useState<{ path: string; files: number | null } | null>(null)

  // The folder new uploads and new directories land in, as a POSIX path relative to the library
  // root. It follows whichever folder row was clicked last and is named by the "upload to" line, so
  // the target is never implicit; it starts at `raw/`, the upload root.
  const [currentDir, setCurrentDir] = useState('raw')
  // Which folders are open, and what each one holds. Children are fetched when a folder is first
  // opened, so a large `raw/` tree costs nothing until it is actually browsed.
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(() => new Set<string>(['raw']))
  const [children, setChildren] = useState<Readonly<Record<string, readonly FsEntry[]>>>({})
  const [loadingDirs, setLoadingDirs] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [hoverDir, setHoverDir] = useState<string | null>(null)
  // How many rows each folder has been allowed to render so far, raised a batch at a time.
  const [dirLimits, setDirLimits] = useState<Readonly<Record<string, number>>>({})
  const [pendingNewDir, setPendingNewDir] = useState(false)
  const [newDirName, setNewDirName] = useState('')
  // The whole-library rebuild asks for confirmation, because it clears the Wiki layer and re-ingests
  // every file under raw/ — a heavy, irreversible step.
  const [pendingReindex, setPendingReindex] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  // Which folder (if any) a drag is currently hovering over, for the drop highlight.
  const [dragDir, setDragDir] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  /** Free-text filter over name, type and path; a large `raw/` tree is searched rather than scrolled. */
  const [query, setQuery] = useState('')
  /** Lower-cased filter text; empty unless the user is searching. */
  const needle = query.trim().toLowerCase()
  /** Whether a filter query is active. */
  const searching = needle !== ''

  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])

  /** The POSIX folder under `raw/` that new uploads land in ('' for the root). */
  const uploadDir = currentDir === 'raw' ? '' : currentDir.slice('raw/'.length)
  /** Display form of the upload target: the `raw` root is shown as the localized "根目录". */
  const uploadDirLabel = uploadDir === '' ? t('raw.rootLabel') : `${t('raw.rootLabel')}/${uploadDir}`

  /** Fetch one folder's entries into the tree. */
  const loadDir = useCallback(async (dir: string): Promise<void> => {
    if (libId === null) return
    setLoadingDirs(current => new Set(current).add(dir))
    try {
      const list = await fsList(libId, dir)
      setChildren(current => ({ ...current, [dir]: list }))
      setError(null)
    } catch (reason) {
      setChildren(current => ({ ...current, [dir]: [] }))
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoadingDirs(current => {
        const next = new Set(current)
        next.delete(dir)
        return next
      })
    }
  }, [fsList, libId])

  /**
   * Reload every folder the tree is currently showing.
   *
   * Uploads, new folders and deletions all change what a folder holds. Caches of folders that were
   * closed in the meantime are dropped rather than refreshed, so re-opening one always re-reads it.
   */
  const reload = useCallback(async (): Promise<void> => {
    const dirs = ['raw', ...openDirs]
    setChildren(current => {
      const next: Record<string, readonly FsEntry[]> = {}
      for (const dir of dirs) {
        const list = current[dir]
        if (list !== undefined) next[dir] = list
      }
      return next
    })
    await Promise.all(dirs.map(dir => loadDir(dir)))
  }, [loadDir, openDirs])

  /** Open or close a folder; opening one also makes it the upload target. */
  const toggleDir = useCallback((dir: string): void => {
    setCurrentDir(dir)
    setOpenDirs(current => {
      const next = new Set(current)
      if (next.delete(dir)) return next
      next.add(dir)
      return next
    })
    if (children[dir] === undefined) void loadDir(dir)
  }, [children, loadDir])

  /** Render one more batch of a folder that was cut short. */
  const revealEntries = useCallback((dir: string): void => {
    setDirLimits(current => ({ ...current, [dir]: (current[dir] ?? DIR_BATCH) + DIR_BATCH }))
  }, [])

  // The tree starts folded, so it only ever loads what it shows: the root first, then a folder when
  // it is opened. A different library is a different tree and starts over.
  useEffect(() => {
    setOpenDirs(new Set<string>(['raw']))
    setChildren({})
    setDirLimits({})
    setCurrentDir('raw')
    setSelected(null)
    setContent('')
    setPreview(null)
    setQuery('')
    void loadDir('raw')
  }, [loadDir])

  useEffect(() => {
    if (libId === null || selected === null || isBinary(selected)) {
      setContent('')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const text = await fsRead(libId, selected)
        if (!cancelled) setContent(text)
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => { cancelled = true }
  }, [fsRead, libId, selected])

  useEffect(() => {
    if (libId === null || selected === null || !isBinary(selected)) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        setPreviewError(null)
        const next = await fsPreview(libId, selected)
        if (!cancelled) setPreview(next)
      } catch (reason) {
        if (!cancelled) setPreviewError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => { cancelled = true }
  }, [fsPreview, libId, selected])

  const pdfUrl = useMemo(() => {
    if (preview?.mime !== 'application/pdf') return null
    const binary = atob(preview.data)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  }, [preview])
  useEffect(() => () => { if (pdfUrl !== null) URL.revokeObjectURL(pdfUrl) }, [pdfUrl])

  // The accepted types belong to the deployment rather than the library, so they are read once.
  // Until they arrive the picker simply does not filter, and the Host still refuses anything it
  // cannot read.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await supportedTypes()
        if (!cancelled) setSupported(list)
      } catch {
        // Server-side validation remains the backstop.
      }
    })()
    return () => { cancelled = true }
  }, [supportedTypes])

  const upload = async (files: FileList | null, dir: string): Promise<void> => {
    if (libId === null || files === null || files.length === 0) return
    const chosen = Array.from(files)
    // A drop bypasses the picker's `accept` filter, so the same check runs here. Rejected files are
    // named rather than aborting the whole drop.
    const rejected = supported.length === 0 ? [] : chosen.filter(file => !supports(file.name, supported))
    const accepted = chosen.filter(file => !rejected.includes(file))
    if (rejected.length > 0) {
      notify?.(template(t, 'raw.unsupported', { names: rejected.map(file => file.name).join('、') }))
    }
    if (accepted.length === 0) return
    setBusy(true)
    setError(null)
    const results: UploadResult[] = []
    const failures: string[] = []
    try {
      for (const file of accepted) {
        try {
          results.push(await fsUpload(libId, file.name, await toBase64(file), dir))
        } catch (reason) {
          // One refused file must not abandon the rest of the drop.
          failures.push(`${file.name}: ${reason instanceof Error ? reason.message : String(reason)}`)
        }
      }
      await reload()
      // A plain upload needs no explaining — the file shows up in the list. Duplicates, renames and
      // refusals do, so those are raised as a transient message at the top of the panel.
      const flagged = results.filter(result => result.status !== 'created')
      const lines = [...flagged.map(result => describeUpload(t, result)), ...failures]
      if (lines.length > 0) notify?.(lines.join('\n'))
    } finally {
      setBusy(false)
    }
  }

  /** Create a folder inside the current directory. */
  const confirmNewDir = async (): Promise<void> => {
    if (libId === null) return
    const name = newDirName.trim().replace(/[\/\\]/g, '_')
    setPendingNewDir(false)
    setNewDirName('')
    if (name === '') return
    try {
      await fsMkdir(libId, [currentDir, name].join('/'))
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /**
   * Queue a path for re-ingest.
   * @param path - File or folder, relative to the library root.
   * @param files - The folder's file count, or null when a single file was asked for.
   */
  const reingest = async (path: string, files: number | null): Promise<void> => {
    if (libId === null) return
    try {
      const queued = await fsReingest(libId, path)
      // A folder's files mostly live in subfolders whose badges are not on screen, so say how many
      // were taken. A single file answers on its own row and needs no message.
      if (files !== null) notify?.(template(t, 'raw.reingested', { n: queued }))
      // Read again at once, so the files visibly flip to queued/running instead of waiting out the
      // current interval — a small file can finish inside one.
      refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /**
   * Ask before deleting a path.
   * @param path - File or folder, relative to the library root.
   * @param files - The folder's file count, or null for a single file.
   */
  const drop = (path: string, files: number | null): void => {
    if (libId === null) return
    setPendingDelete({ path, files })
  }

  const confirmDrop = async (): Promise<void> => {
    if (libId === null || pendingDelete === null) return
    const { path } = pendingDelete
    setPendingDelete(null)
    try {
      await fsDelete(libId, path)
      setSelected(null)
      await reload()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  // Rebuild the whole library from raw/: clears the Wiki layer and re-ingests every file. The confirm
  // modal gates it; the live run shows in the shared progress strip.
  const reindexAll = async (): Promise<void> => {
    if (libId === null) return
    setPendingReindex(false)
    setReindexing(true)
    try {
      const queued = await reindex(libId)
      notify?.(template(t, 'raw.reindexedAll', { n: queued }))
    } catch (reason) {
      notify?.(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setReindexing(false)
    }
  }

  const download = async (): Promise<void> => {
    if (libId === null || selected === null) return
    try {
      const base64 = await fsDownload(libId, selected)
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
      const blob = new Blob([bytes])
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = selected.slice(selected.lastIndexOf('/') + 1)
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /**
   * Whether any entry under `dir` matches the active filter, recursing into folders.
   * @param dir - POSIX path of the folder to test.
   * @returns True when `dir` holds a matching file or a folder that does.
   */
  const subtreeHasMatch = (dir: string): boolean => {
    const list = children[dir]
    if (list === undefined) return false
    for (const entry of list) {
      if (entry.type === 'folder') {
        if (matchesRaw(entry, needle) || subtreeHasMatch(entry.path)) return true
      } else if (matchesRaw(entry, needle)) {
        return true
      }
    }
    return false
  }

  /** Files matching the filter across the whole loaded tree. */
  const matchedFiles = useMemo(() => {
    if (!searching) return 0
    let total = 0
    const walk = (d: string): void => {
      const list = children[d]
      if (list === undefined) return
      for (const entry of list) {
        if (entry.type === 'folder') walk(entry.path)
        else if (matchesRaw(entry, needle)) total += 1
      }
    }
    walk('raw')
    return total
  }, [searching, children, needle])

  /** Every file in the loaded tree, used as the denominator of the filter count. */
  const totalFiles = useMemo(() => {
    let total = 0
    const walk = (d: string): void => {
      const list = children[d]
      if (list === undefined) return
      for (const entry of list) {
        if (entry.type === 'folder') walk(entry.path)
        else total += 1
      }
    }
    walk('raw')
    return total
  }, [children])

  /**
   * Load every folder under `raw/` into the tree at once, so a filter can reach
   * files nested in folders the user has not opened yet.
   */
  const loadTree = useCallback(async (): Promise<void> => {
    if (libId === null) return
    const collected: Record<string, readonly FsEntry[]> = {}
    const stack: string[] = ['raw']
    while (stack.length > 0) {
      const dir = stack.pop() as string
      try {
        const list = await fsList(libId, dir)
        collected[dir] = list
        for (const entry of list) {
          if (entry.type === 'folder') stack.push(entry.path)
        }
      } catch {
        collected[dir] = []
      }
    }
    setChildren(collected)
  }, [fsList, libId])

  // Load the whole raw/ tree when the view opens and whenever the library changes, so the
  // file count shown at the top is the true total rather than only what has been opened or searched.
  useEffect(() => {
    void loadTree()
  }, [loadTree])

  // A filter is meant to span folders, not just the ones on screen, so when one is
  // active the whole tree is loaded up front.
  useEffect(() => {
    if (searching) void loadTree()
  }, [searching, loadTree])

  /**
   * Render the contents of one folder of the tree.
   *
   * Folders open in place rather than being navigated into, so the whole `raw/` layout stays on
   * screen and every drop target is reachable at once; depth is expressed as indentation alone.
   * @param dir - POSIX path of the folder to render.
   * @param depth - Levels below the root, used for indentation.
   * @returns The rows of that folder.
   */
  const renderEntries = (dir: string, depth: number): ReactElement[] => {
    const all = children[dir] ?? []
    // While filtering, keep only entries that match themselves or hold a matching
    // descendant; the tree is fully loaded, so every match is reachable.
    const list = searching
      ? all.filter(entry => entry.type === 'folder'
        ? (matchesRaw(entry, needle) || subtreeHasMatch(entry.path))
        : matchesRaw(entry, needle))
      : all
    const indent = TREE_INDENT_BASE + depth * TREE_INDENT_STEP
    if (list.length === 0) {
      // A folder that is still being read would otherwise flash "(empty)"; only a real empty
      // folder says so.
      if (loadingDirs.has(dir)) return []
      return [
        <div key={`${dir}/`} style={{ padding: ROW_PADDING, paddingLeft: indent, fontSize: FONT_SIZE_SMALL, opacity: 0.6 }}>
          {searching ? t('raw.filterEmpty') : t('raw.empty')}
        </div>,
      ]
    }
    // A folder holding thousands of entries renders a batch, not the lot: one row is one DOM
    // subtree, and nobody reads past the first screenful before typing in the filter.
    const shown = list.slice(0, dirLimits[dir] ?? DIR_BATCH)
    const rows = shown.map(entry => {
      if (entry.type === 'folder') {
        // While filtering, a folder stands open so its matches show without the user
        // re-opening each one they had closed before.
        const open = searching || openDirs.has(entry.path)
        return (
          <div key={entry.path}>
            {/*
             * The row is its own flex line, and the opened children are its siblings rather than
             * its items — otherwise they would lay out beside the row instead of below it. The
             * disclosure button and the two folder actions are siblings too: a button cannot hold
             * buttons, and clicking an action must not also toggle the folder.
             */}
            <div
              onMouseEnter={() => { setHoverDir(entry.path) }}
              onMouseLeave={() => { setHoverDir(current => (current === entry.path ? null : current)) }}
              onDragOver={event => {
                event.preventDefault()
                event.stopPropagation()
                setDragDir(entry.path)
              }}
              onDragLeave={() => { if (dragDir === entry.path) setDragDir(null) }}
              onDrop={event => {
                event.preventDefault()
                event.stopPropagation()
                setDragActive(false)
                setDragDir(null)
                // A drop onto a folder uploads into that folder, matching the upload picker's rule.
                void upload(event.dataTransfer.files, entry.path.slice('raw/'.length))
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                paddingRight: TREE_INDENT_BASE,
                color: dragDir === entry.path ? '#fff' : 'inherit',
                background: dragDir === entry.path
                  ? 'var(--dsw-alias-state-business-primary)'
                  : currentDir === entry.path
                    ? 'var(--dsw-alias-interactive-bg-active)'
                    : hoverDir === entry.path
                      ? 'var(--dsw-alias-interactive-bg-hover)'
                      : 'transparent',
              }}
            >
              <button
                type="button"
                aria-expanded={open}
                onClick={() => { toggleDir(entry.path) }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  flex: 1,
                  minWidth: 0,
                  boxSizing: 'border-box',
                  padding: ROW_PADDING,
                  paddingLeft: indent,
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  fontFamily: FONT_FAMILY,
                  fontSize: FONT_SIZE_BODY,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span style={{ flex: '0 0 auto', display: 'flex', opacity: 0.7 }}>
                  {open ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
                </span>
                <span
                  title={`[dir] ${entry.path}`}
                  style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {entry.name}
                </span>
                {/* How many files the folder holds, so its size is known before it is opened. */}
                {entry.count !== undefined && (
                  <span
                    title={template(t, 'raw.folderCount', { n: entry.count })}
                    style={{ flex: '0 0 auto', fontSize: FONT_SIZE_SMALL, opacity: 0.6 }}
                  >
                    {entry.count}
                  </span>
                )}
              </button>
              {/* Both actions take the whole folder, subfolders included — that is what the count
                  beside the name promises. */}
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('raw.reingestDir')}
                title={t('raw.reingestDir')}
                style={ROW_ACTION_STYLE}
                onClick={() => { void reingest(entry.path, entry.count ?? 0) }}
                icon={<IconDatabaseOutlineRegular />}
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('raw.deleteDir')}
                title={t('raw.deleteDir')}
                style={TRAILING_ACTION_STYLE}
                onClick={() => { drop(entry.path, entry.count ?? 0) }}
                icon={<IconTrashOutlineRegular />}
              />
            </div>
            {open && renderEntries(entry.path, depth + 1)}
          </div>
        )
      }
      return (
        <div
          key={entry.path}
          onClick={() => { setSelected(entry.path) }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: ROW_PADDING,
            paddingLeft: indent,
            fontSize: FONT_SIZE_BODY,
            cursor: 'pointer',
            background: selected === entry.path ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
          }}
        >
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.name}>
            {entry.name}
          </span>
          <IngestBadge job={jobs[entry.path]} t={t} />
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('raw.reingest')}
            title={t('raw.reingest')}
            style={ROW_ACTION_STYLE}
            onClick={event => { event.stopPropagation(); void reingest(entry.path, null) }}
            icon={<IconDatabaseOutlineRegular />}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('raw.delete')}
            title={t('raw.delete')}
            style={TRAILING_ACTION_STYLE}
            onClick={event => { event.stopPropagation(); drop(entry.path, null) }}
            icon={<IconTrashOutlineRegular />}
          />
        </div>
      )
    })
    const hidden = list.length - shown.length
    if (hidden > 0) {
      rows.push(
        <div key={`${dir}/more`} style={{ paddingLeft: indent, paddingBottom: 6 }}>
          <Button variant="ghost" size="sm" onClick={() => { revealEntries(dir) }}>
            {template(t, 'raw.showMore', { n: hidden })}
          </Button>
        </div>,
      )
    }
    return rows
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div
        onDragOver={event => { event.preventDefault(); setDragActive(true) }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDragActive(false); setDragDir(null) } }}
        onDrop={event => {
          event.preventDefault()
          setDragActive(false)
          setDragDir(null)
          // A drop on the panel background (not on a folder row) uploads into the current directory.
          void upload(event.dataTransfer.files, uploadDir)
        }}
        style={{
          width: 280,
          flex: '0 0 auto',
          borderRight: '1px solid var(--dsw-alias-border-l2)',
          display: 'flex',
          flexDirection: 'column',
          outline: dragActive ? '2px dashed var(--dsw-alias-state-business-primary)' : '2px dashed transparent',
          outlineOffset: -2,
        }}
      >
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{ padding: 8, border: '1px dashed var(--dsw-alias-border-l3)', borderRadius: 10, fontSize: FONT_SIZE_SMALL, textAlign: 'center', opacity: 0.8 }}
          >
            {busy ? t('raw.uploading') : t('raw.upload')}
            {' '}
            <label style={{ cursor: 'pointer', textDecoration: 'underline', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <IconPaperclipOutlineRegular size={16} />
              {t('raw.choose')}
              <input
                type="file"
                multiple
                hidden
                accept={supported.length === 0 ? undefined : supported.join(',')}
                onChange={event => { void upload(event.target.files, uploadDir) }}
              />
            </label>
            <div style={{ marginTop: 4, opacity: 0.65 }}>{t('raw.dropHint')}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: FONT_SIZE_SMALL }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.7 }} title={uploadDirLabel}>
              {template(t, 'raw.uploadTarget', { dir: uploadDirLabel })}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', flex: '0 0 auto' }}>
              {/* Closing every folder is not a way back to the root, so the target gets its own
                  control — and only while there is something to go back to. */}
              {currentDir !== 'raw' && (
                <Button variant="ghost" size="sm" title={t('raw.uploadRoot')} onClick={() => { setCurrentDir('raw') }}>
                  {t('raw.rootLabel')}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => { setNewDirName(''); setPendingNewDir(true) }} title={t('raw.newDir')} icon={<IconPlusOutlineRegular />}>
                {t('raw.newDir')}
              </Button>
            </div>
          </div>
          <input
            type="search"
            value={query}
            aria-label={t('raw.filter')}
            placeholder={t('raw.filter')}
            onChange={event => { setQuery(event.target.value) }}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '4px 8px',
              fontSize: FONT_SIZE_SMALL,
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l3)',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-primary)',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: FONT_SIZE_SMALL, opacity: 0.6 }}>
              {searching
                ? template(t, 'raw.filterCount', { n: matchedFiles, total: totalFiles })
                : template(t, 'raw.count', { n: totalFiles })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={reindexing}
              title={t('raw.reindexAll')}
              onClick={() => { setPendingReindex(true) }}
              icon={<IconDatabaseOutlineRegular />}
            />
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 4 }}>
          {renderEntries('raw', 0)}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 12 }}>
        {error !== null && <div style={{ fontSize: FONT_SIZE_SMALL, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 8 }}>{error}</div>}
        {selected === null
          ? <div style={{ fontSize: FONT_SIZE_BODY, opacity: 0.6 }}>{t('raw.select')}</div>
          : isBinary(selected)
            ? (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: FONT_SIZE_SMALL, opacity: 0.6, marginBottom: 8 }}>
                  <span
                    title={selected}
                    style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {selected} · {t('raw.readOnly')}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => { void download() }} icon={<IconDownloadOutlineRegular />}>{t('raw.download')}</Button>
                </div>
                {previewError !== null
                  ? <div style={{ fontSize: FONT_SIZE_SMALL, color: 'var(--dsw-alias-state-error-primary)' }}>{previewError}</div>
                  : preview === null
                    ? <div style={{ fontSize: FONT_SIZE_BODY, opacity: 0.6 }}>{t('raw.loading')}</div>
                    : preview.mime === 'application/pdf'
                      ? <iframe src={pdfUrl ?? ''} title={selected} style={{ flex: 1, minHeight: 0, border: 'none', width: '100%', background: '#fff' }} />
                      : <iframe srcDoc={preview.data} sandbox="" title={selected} style={{ flex: 1, minHeight: 0, border: 'none', width: '100%', background: '#fff' }} />}
              </div>
            )
            : isHtml(selected)
              ? (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: FONT_SIZE_SMALL, opacity: 0.6, marginBottom: 8 }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {selected} · {t('raw.readOnly')}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => { void download() }} icon={<IconDownloadOutlineRegular />}>{t('raw.download')}</Button>
                  </div>
                  <iframe
                    srcDoc={content}
                    sandbox=""
                    title={selected}
                    style={{ flex: 1, minHeight: 0, border: 'none', width: '100%', background: '#fff' }}
                  />
                </div>
              )
              : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: FONT_SIZE_SMALL, opacity: 0.6, marginBottom: 8 }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {selected} · {t('raw.readOnly')}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => { void download() }} icon={<IconDownloadOutlineRegular />}>{t('raw.download')}</Button>
                  </div>
                  {isMarkdown(selected)
                    ? <MarkdownText text={content} labels={labels} />
                    : isJson(selected)
                      ? <JsonView text={content} t={t} />
                      : isCsv(selected)
                        ? <CsvView text={content} />
                        : isXml(selected)
                          ? <CodeView text={content} highlight={highlightXml} />
                          : isYaml(selected)
                            ? <CodeView text={content} highlight={highlightYaml} />
                            : <pre style={{ margin: 0, fontSize: FONT_SIZE_BODY, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--dsw-alias-label-primary)' }}>{content}</pre>}
                </>
              )}
      </div>
      <Modal
        open={pendingDelete !== null}
        title={t('raw.delete')}
        closeLabel={t('common.close')}
        onClose={() => { setPendingDelete(null) }}
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => { setPendingDelete(null) }}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={() => { void confirmDrop() }}>{t('common.confirm')}</Button>
          </div>
        )}
      >
        <div style={{ fontSize: FONT_SIZE_BODY, minWidth: 320 }}>
          <div style={{ marginBottom: 8 }}>
            {pendingDelete !== null && pendingDelete.files !== null
              ? t('raw.confirmDeleteDir')
              : t('raw.confirmDelete')}
          </div>
          <code style={{ display: 'block', wordBreak: 'break-all', fontSize: FONT_SIZE_SMALL, opacity: 0.8 }}>{pendingDelete?.path}</code>
          {/* A folder delete is the one that can take a few hundred files by surprise, so it says
              how many it is about to take. */}
          {pendingDelete !== null && pendingDelete.files !== null && (
            <div style={{ marginTop: 6, fontSize: FONT_SIZE_SMALL, opacity: 0.7 }}>
              {template(t, 'raw.folderCount', { n: pendingDelete.files })}
            </div>
          )}
        </div>
      </Modal>
      <Modal
        open={pendingNewDir}
        title={t('raw.newDir')}
        closeLabel={t('common.close')}
        onClose={() => { setPendingNewDir(false); setNewDirName('') }}
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => { setPendingNewDir(false); setNewDirName('') }}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={() => { void confirmNewDir() }}>{t('common.confirm')}</Button>
          </div>
        )}
      >
        <div style={{ fontSize: FONT_SIZE_BODY, minWidth: 320, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: FONT_SIZE_SMALL, color: 'var(--dsw-alias-label-secondary)' }}>
            {t('raw.newDirName')}
            <input
              type="text"
              autoFocus
              value={newDirName}
              placeholder={t('raw.newDirPlaceholder')}
              onChange={event => { setNewDirName(event.target.value) }}
              onKeyDown={event => { if (event.key === 'Enter') void confirmNewDir() }}
              style={{ marginTop: 4, width: '100%', padding: '6px 8px', fontSize: FONT_SIZE_BODY, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' }}
            />
          </label>
          <div style={{ fontSize: FONT_SIZE_SMALL, opacity: 0.6 }}>{template(t, 'raw.uploadTarget', { dir: uploadDirLabel })}</div>
        </div>
      </Modal>
      <Modal
        open={pendingReindex}
        title={t('raw.reindexAll')}
        closeLabel={t('common.close')}
        onClose={() => { setPendingReindex(false) }}
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => { setPendingReindex(false) }}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={reindexing} onClick={() => { void reindexAll() }}>{t('common.confirm')}</Button>
          </div>
        )}
      >
        <div style={{ fontSize: FONT_SIZE_BODY, minWidth: 320 }}>
          <span>{t('library.confirmRebuild')}</span>
        </div>
      </Modal>
    </div>
  )
}
