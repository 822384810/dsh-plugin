/** Wiki pages: the LLM-maintained second layer — browse, read, correct by hand, recompile. */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Button, Modal, MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconEditOutlineRegular, IconCheckOutlineRegular, IconThinkOutlineRegular, IconCloseOutlineRegular,
  IconListPenOutlineRegular, IconLinkOutlineRegular,
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WikiActions, WikiPage } from '../api.ts'
import type { SourceDetail } from '../../shared/source-detail.ts'
import type { WikiKey } from '../locales.ts'
import type { Translate } from '../translate.ts'
import { template } from '../translate.ts'
import { FONT_FAMILY, FONT_SIZE_BODY, FONT_SIZE_SMALL, FONT_CODE_FAMILY, ROW_PADDING, ROW_PADDING_X12 } from '../typography.ts'

/** Props: data access, copy and the active library. */
export interface WikiViewProps extends Pick<WikiActions, 'listPages' | 'fsRead' | 'fsWrite' | 'recompile' | 'recompileAll' | 'ingestStates' | 'sourceDetail'> {
  readonly t: Translate
  readonly libId: string | null
}

/** How often a running recompile's progress is read; only while one runs. */
const RECOMPILE_POLL_MS = 1000

/**
 * Locale keys naming the page types the compiler writes by default.
 *
 * `type` is read from each page's frontmatter, so it is data rather than a fixed union: a library
 * may declare types of its own in `schema.md`. The known ones get a translated heading; anything
 * else falls back to the raw value, which stays honest about what the page actually says.
 */
const TYPE_KEYS: Readonly<Record<string, WikiKey>> = {
  source: 'wiki.type.source',
  'source-summary': 'wiki.type.source-summary',
  entity: 'wiki.type.entity',
  concept: 'wiki.type.concept',
  comparison: 'wiki.type.comparison',
  synthesis: 'wiki.type.synthesis',
  unknown: 'wiki.type.unknown',
}

/**
 * Translated name of one page type.
 * @param t - Translator.
 * @param type - Page type as written in the frontmatter.
 * @returns The localized name, or the raw type when it is not one we know.
 */
function typeName(t: Translate, type: string): string {
  const key = TYPE_KEYS[type]
  return key === undefined ? type : t(key)
}

/** One type heading and the pages filed under it. */
interface TypeGroup {
  readonly type: string
  readonly pages: readonly WikiPage[]
}

/** Indentation of a page row under its type heading. */
const PAGE_ROW_INDENT = 24

/** Extra indentation per folder level inside a group. */
const TREE_INDENT_STEP = 12

/**
 * Directories a page may live in, each named after the layer it holds.
 *
 * The tree starts below them, so a mirror of `raw/a/b.pdf` shows as the folder `a` holding `b.pdf`
 * instead of repeating `sources` on every row.
 */
const LAYER_DIRS = new Set(['entities', 'concepts', 'sources'])

/** One row of a group's tree: a folder to open, or a page to select. */
interface TreeNode {
  /** Row label: a folder name, or a page's file name without its `.md` suffix. */
  readonly name: string
  /** Stable identity — the folder's path, or the page's path for a leaf. */
  readonly id: string
  /** The page a leaf opens; null on a folder. */
  readonly page: WikiPage | null
  readonly children: readonly TreeNode[]
}

/** A row while the tree is still being collected. */
interface TreeDraft {
  readonly name: string
  readonly id: string
  page: WikiPage | null
  readonly children: Map<string, TreeDraft>
}

/**
 * Fold one group's pages into the folder tree their paths describe.
 *
 * Source pages mirror `raw/` folder by folder, so this is what makes a folder of uploads readable
 * as a folder. Types whose pages are flat (`entities/<name>.md`) simply produce a flat list, which
 * is exactly what they had before.
 * @param pages - Pages of a single type.
 * @returns The top level of the tree.
 */
function buildTree(pages: readonly WikiPage[]): readonly TreeNode[] {
  const root = new Map<string, TreeDraft>()
  for (const page of pages) {
    const segments = page.path.split('/')
    const offset = LAYER_DIRS.has(segments[0] ?? '') ? 1 : 0
    const parts = segments.slice(offset)
    if (parts.length === 0) continue
    let level = root
    parts.forEach((segment, index) => {
      const leaf = index === parts.length - 1
      let node = level.get(segment)
      if (node === undefined) {
        node = {
          name: leaf ? segment.replace(/\.md$/i, '') : segment,
          id: segments.slice(0, offset + index + 1).join('/'),
          page: null,
          children: new Map(),
        }
        level.set(segment, node)
      }
      if (leaf) node.page = page
      level = node.children
    })
  }
  return sorted(root)
}

/** Turn collected rows into immutable ones: folders first, then pages, each in name order. */
function sorted(level: ReadonlyMap<string, TreeDraft>): readonly TreeNode[] {
  return [...level.values()]
    .sort((left, right) => {
      const folders = Number(right.children.size > 0) - Number(left.children.size > 0)
      return folders !== 0 ? folders : left.name.localeCompare(right.name)
    })
    .map(node => ({ name: node.name, id: node.id, page: node.page, children: sorted(node.children) }))
}

/** How many rows one group renders before it offers to render the next batch. */
const ROW_BATCH = 100

/** Whether a page answers a lower-cased filter query. */
function matchesQuery(t: Translate, page: WikiPage, needle: string): boolean {
  return page.title.toLowerCase().includes(needle)
    || page.path.toLowerCase().includes(needle)
    || page.type.toLowerCase().includes(needle)
    || typeName(t, page.type).toLowerCase().includes(needle)
}

/** Pages under one node, its own row excluded. */
function pagesIn(node: TreeNode): number {
  if (node.page !== null) return 1
  let total = 0
  for (const child of node.children) total += pagesIn(child)
  return total
}

/**
 * Keep only the first `limit` rows of a tree.
 *
 * Opening a group is what puts rows into the DOM, so the rows are what the budget is spent on: a
 * folder header costs one, a page costs one. Whatever does not fit is counted instead of rendered
 * — the caller offers to reveal it — which keeps a ten-thousand-page library responsive.
 * @param nodes - Rows to clip.
 * @param budget - Row budget, spent as rows are kept.
 * @returns The rows to render, and how many pages were left out.
 */
function clipTree(nodes: readonly TreeNode[], budget: { left: number }): { nodes: TreeNode[]; dropped: number } {
  const kept: TreeNode[] = []
  let dropped = 0
  for (const node of nodes) {
    if (budget.left <= 0) {
      dropped += pagesIn(node)
      continue
    }
    budget.left -= 1
    if (node.page !== null) {
      kept.push(node)
      continue
    }
    const inner = clipTree(node.children, budget)
    dropped += inner.dropped
    kept.push({ name: node.name, id: node.id, page: null, children: inner.nodes })
  }
  return { nodes: kept, dropped }
}

/**
 * Read and correct the Wiki.
 * @param props - Data access, copy and the active library.
 * @returns The view.
 */
export function WikiView({ listPages, fsRead, fsWrite, recompile, recompileAll, ingestStates, sourceDetail, t, libId }: WikiViewProps): ReactElement {
  const [pages, setPages] = useState<readonly WikiPage[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState(false)
  const [recompilingSources, setRecompilingSources] = useState<ReadonlySet<string>>(new Set())
  /** Percentage of the running recompile; 0 when nothing runs. */
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Inspector result for the active page's chunks/vectors; null until fetched. */
  const [detail, setDetail] = useState<SourceDetail | null>(null)
  /** Which inspector view is open; null shows the page content. */
  const [detailMode, setDetailMode] = useState<'chunks' | 'vectors' | null>(null)
  const [recompilingAll, setRecompilingAll] = useState(false)
  const [pendingRecompileAll, setPendingRecompileAll] = useState(false)

  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])

  // Which type headings and which folders are open. Both start empty: the headings are the
  // overview and a folder lists its contents only once asked, so a library with hundreds of files
  // still opens on something readable.
  const [openTypes, setOpenTypes] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [hoverType, setHoverType] = useState<string | null>(null)
  const [hoverDir, setHoverDir] = useState<string | null>(null)
  // Free-text filter over title, type and path. A large library is meant to be searched rather than
  // scrolled, and a match is shown even when its group and folders were never opened.
  const [query, setQuery] = useState('')
  // How many rows each group has been allowed to render so far, raised a batch at a time.
  const [limits, setLimits] = useState<Readonly<Record<string, number>>>({})

  const needle = query.trim().toLowerCase()
  const searching = needle !== ''

  // Pages are filed by the `type` their frontmatter declares, so a library holding hundreds of
  // entities reads as a handful of headings instead of one endless column.
  const groups = useMemo<readonly TypeGroup[]>(() => {
    const matched = needle === '' ? pages : pages.filter(page => matchesQuery(t, page, needle))
    const byType = new Map<string, WikiPage[]>()
    for (const page of matched) {
      const bucket = byType.get(page.type)
      if (bucket === undefined) byType.set(page.type, [page])
      else bucket.push(page)
    }
    return [...byType]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, items]) => ({ type, pages: items }))
  }, [needle, pages, t])

  /** How many pages survived the filter. */
  const matched = useMemo(
    () => groups.reduce((total, group) => total + group.pages.length, 0),
    [groups],
  )

  /** Each group's pages as the folder tree their paths describe. */
  const trees = useMemo(
    () => new Map(groups.map(group => [group.type, buildTree(group.pages)])),
    [groups],
  )

  // A different library is a different set of types and folders, so it starts collapsed again.
  useEffect(() => {
    setOpenTypes(new Set<string>())
    setOpenDirs(new Set<string>())
  }, [libId])

  // A fresh query gets a fresh first batch, otherwise a group revealed earlier would flood the list
  // with exactly the rows the batch limit exists to hold back.
  useEffect(() => { setLimits({}) }, [needle])

  const toggleType = useCallback((type: string): void => {
    setOpenTypes(current => {
      const next = new Set(current)
      if (!next.delete(type)) next.add(type)
      return next
    })
  }, [])

  const toggleDir = useCallback((id: string): void => {
    setOpenDirs(current => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const revealMore = useCallback((type: string): void => {
    setLimits(current => ({ ...current, [type]: (current[type] ?? ROW_BATCH) + ROW_BATCH }))
  }, [])

  /** Render one level of a group's tree, indented one step deeper than the level above. */
  const renderTree = (nodes: readonly TreeNode[], depth: number): ReactElement[] => nodes.map(node => {
    const indent = PAGE_ROW_INDENT + depth * TREE_INDENT_STEP
    const page = node.page
    if (page === null) {
      // While filtering, a folder stands open: the user asked for every match, not for the folders
      // they had happened to open before.
      const open = searching || openDirs.has(node.id)
      return (
        <div key={node.id}>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => { toggleDir(node.id) }}
            onMouseEnter={() => { setHoverDir(node.id) }}
            onMouseLeave={() => { setHoverDir(current => (current === node.id ? null : current)) }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              width: '100%',
              boxSizing: 'border-box',
              padding: ROW_PADDING,
              paddingLeft: indent,
              border: 'none',
              background: hoverDir === node.id ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              fontFamily: FONT_FAMILY,
              fontSize: FONT_SIZE_BODY,
              fontWeight: 500,
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <span style={{ flex: '0 0 auto', display: 'flex', opacity: 0.7 }}>
              {open ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
          </button>
          {open && renderTree(node.children, depth + 1)}
        </div>
      )
    }
    return (
      <div
        key={page.path}
        onClick={() => { setSelected(page.path); setEditing(false); setDetailMode(null); setDetail(null) }}
        style={{
          padding: ROW_PADDING,
          paddingLeft: indent,
          cursor: 'pointer',
          fontSize: FONT_SIZE_BODY,
          background: selected === page.path ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
        }}
      >
        <div title={page.title} style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{page.title}</div>
        <div style={{ fontSize: FONT_SIZE_SMALL, opacity: 0.6 }}>
          {typeName(t, page.type)}{page.updated === '' ? '' : ` · ${page.updated}`}
          {page.edited && (
            <span style={{ marginLeft: 6, color: 'var(--dsw-alias-state-warning-primary)' }}>{t('wiki.edited')}</span>
          )}
        </div>
      </div>
    )
  })

  const load = useCallback(async () => {
    if (libId === null) return
    try {
      setPages(await listPages(libId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [listPages, libId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (libId === null || selected === null) {
      setContent('')
      setDetail(null)
      setDetailMode(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const text = await fsRead(libId, `wiki/${selected}`)
        if (!cancelled) setContent(text)
      } catch (reason) {
        if (cancelled) return
        const message = reason instanceof Error ? reason.message : String(reason)
        // A page listed but since removed (or a stale path after a reorganisation) leaves a
        // dead entry; say so, drop the selection so we don't keep retrying it, and refresh.
        if (message.includes('ENOENT')) {
          setError(t('wiki.pageMissing'))
          setSelected(null)
          void load()
        } else {
          setError(message)
        }
      }
    })()
    return () => { cancelled = true }
  }, [fsRead, libId, selected, load])

  const save = async (): Promise<void> => {
    if (libId === null || selected === null) return
    try {
      await fsWrite(libId, `wiki/${selected}`, content)
      setEditing(false)
      setMessage(t('wiki.save'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** The selected page, kept so its source and chunk key can be derived once. */
  const selectedPage = useMemo(
    () => pages.find(page => page.path === selected) ?? null,
    [pages, selected],
  )
  /** The raw source the selected page was compiled from, which is what a recompile reports under. */
  const sourceOf = selectedPage?.source ?? ''
  /** Chunk source key the page's chunks are stored under (mirrors the indexer's `keyForPage`). */
  const sourceKey = selectedPage === null
    ? ''
    : (selectedPage.path.startsWith('sources/') && selectedPage.source !== ''
      ? selectedPage.source
      : `wiki/${selectedPage.path}`)
  /** Whether the selected page is the one currently being recompiled (its button shows busy). */
  const recompilingThis = recompilingSources.has(sourceOf)

  // Follow a running recompile through the ingest state — the same channel the progress panel
  // reads — but only for the source of the page on screen, so switching files does not stall the
  // poll or mislabel another file. It keeps its own faster cadence and asks for this library alone.
  useEffect(() => {
    if (libId === null || sourceOf === '' || !recompilingSources.has(sourceOf)) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        const snapshot = await ingestStates(libId)
        if (!cancelled) setProgress(snapshot.state.jobs[sourceOf]?.progress ?? 0)
      } catch {
        // A failed read only means the bar stops moving; the call itself reports the real outcome.
      }
      if (!cancelled) timer = setTimeout(() => { void tick() }, RECOMPILE_POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [recompilingSources, ingestStates, libId, sourceOf])

  // Poll the ingest state while the all-sources recompile runs: it reports its overall progress under
  // a synthetic key, so the panel can follow the run without a dedicated channel.
  useEffect(() => {
    if (!recompilingAll || libId === null) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        const snapshot = await ingestStates(libId)
        if (cancelled) return
        // The run removes its synthetic job when finished; only then do we refresh and stand down.
        if (snapshot.state.jobs['__recompile_all__'] === undefined) {
          setRecompilingAll(false)
          await load()
          return
        }
      } catch {
        // A failed read only means the bar stops moving; the run itself reports the real outcome.
      }
      if (!cancelled) timer = setTimeout(tick, 1000)
    }
    tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [recompilingAll, ingestStates, libId, load])

  const runRecompile = async (): Promise<void> => {
    if (libId === null || selected === null) return
    // The call does not return until the model has answered every window, which can take minutes;
    // without this the button looks dead and can be pressed again while the first run is in flight.
    // 记录正在编译的具体来源，而非整页一个全局标志：切到别的文件时，只有真正在跑的那个
    // 文件按钮保持禁用并显示“重新编译中”，其它文件立即可用，进度条也只跟踪当前来源。
    const target = sourceOf
    setRecompilingSources(prev => new Set(prev).add(target))
    setProgress(0)
    try {
      await recompile(libId, selected)
      setMessage(t('wiki.recompiled'))
      await load()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setRecompilingSources(prev => {
        const next = new Set(prev)
        next.delete(target)
        return next
      })
    }
  }

  const runRecompileAll = async (): Promise<void> => {
    if (libId === null) return
    setPendingRecompileAll(false)
    setRecompilingAll(true)
    // The call returns as soon as the run is queued; the per-source compile then proceeds
    // asynchronously and reports progress through the ingest state (see the effect above).
    try {
      const queued = await recompileAll(libId)
      setMessage(template(t, 'wiki.recompiledAll', { n: queued }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setRecompilingAll(false)
    }
  }

  /** Open the chunk or vector inspector for the active page; clicking the open view closes it. */
  const showDetail = useCallback(async (mode: 'chunks' | 'vectors'): Promise<void> => {
    if (detailMode === mode) {
      setDetailMode(null)
      setDetail(null)
      return
    }
    if (libId === null || sourceKey === '') return
    setDetailMode(mode)
    setDetail(null)
    try {
      setDetail(await sourceDetail(libId, sourceKey))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setDetailMode(null)
    }
  }, [sourceDetail, libId, sourceKey, detailMode])

  /** Render the chunk or vector inspector for the active page. */
  const renderDetail = (): ReactElement => {
    if (detail === null) {
      return <div style={{ fontSize: FONT_SIZE_SMALL, opacity: 0.6 }}>{t('wiki.detailLoading')}</div>
    }
    if (detail.chunks.length === 0) {
      return <div style={{ fontSize: FONT_SIZE_SMALL, opacity: 0.6 }}>{t('wiki.detailEmpty')}</div>
    }
    if (detailMode === 'vectors') {
      return (
        <div style={{ fontFamily: FONT_CODE_FAMILY, fontSize: FONT_SIZE_SMALL }}>
          <div style={{ marginBottom: 8, opacity: 0.8 }}>
            {template(t, 'wiki.vectorCount', { n: detail.vectors.length, m: detail.vectors[0]?.dim ?? 0 })} · {t('wiki.detailSource')}: {detail.source}
          </div>
          {detail.vectors.length === 0
            ? <div style={{ opacity: 0.7 }}>{t('wiki.noVector')}</div>
            : detail.vectors.map(vector => (
              <div key={vector.uid} style={{ padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
                <span style={{ opacity: 0.7 }}>uid </span>{vector.uid.slice(0, 16)}
                <span style={{ marginLeft: 12, opacity: 0.7 }}>{t('wiki.magnitude')} </span>{vector.magnitude.toFixed(4)}
                <span style={{ marginLeft: 12, opacity: 0.7 }}>{t('wiki.firstDims')} </span>[{vector.sample.map(value => value.toFixed(3)).join(', ')}]
              </div>
            ))}
        </div>
      )
    }
    return (
      <div style={{ fontFamily: FONT_CODE_FAMILY, fontSize: FONT_SIZE_SMALL }}>
        <div style={{ marginBottom: 8, opacity: 0.8 }}>
          {template(t, 'wiki.chunkCount', { n: detail.chunks.length })} · {t('wiki.detailSource')}: {detail.source}
        </div>
        {detail.chunks.map(chunk => (
          <div key={chunk.uid} style={{ padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
            <div style={{ opacity: 0.8, marginBottom: 4 }}>
              {template(t, 'wiki.chunkOf', { i: chunk.chunkIndex + 1, n: detail.chunks.length })}
              <span style={{ marginLeft: 8 }}>{template(t, 'wiki.chars', { n: chunk.contentLength })}</span>
              <span style={{ marginLeft: 8 }}>{chunk.hasVector ? t('wiki.withVector') : t('wiki.noVectorShort')}</span>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit', fontSize: 'inherit' }}>
              {chunk.preview}{chunk.contentLength > 240 ? '…' : ''}
            </pre>
            <div style={{ opacity: 0.5, marginTop: 4 }}>uid {chunk.uid} · hash {chunk.fileHash.slice(0, 16)}</div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ width: 280, flex: '0 0 auto', borderRight: '1px solid var(--dsw-alias-border-l2)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input
            type="search"
            value={query}
            aria-label={t('wiki.filter')}
            placeholder={t('wiki.filter')}
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
                ? template(t, 'wiki.filterCount', { n: matched, total: pages.length })
                : template(t, 'wiki.count', { n: pages.length })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={recompilingAll}
              title={t('wiki.recompileAll')}
              onClick={() => { setPendingRecompileAll(true) }}
              icon={<IconThinkOutlineRegular />}
            />
          </div>
          {recompilingAll && (
            <div style={{ fontSize: FONT_SIZE_SMALL, opacity: 0.7, marginTop: 2 }}>{t('wiki.recompilingAll')}</div>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {searching && groups.length === 0 && (
            <div style={{ padding: 8, fontSize: FONT_SIZE_SMALL, opacity: 0.6 }}>{t('wiki.filterEmpty')}</div>
          )}
          {groups.map(group => {
            const open = openTypes.has(group.type)
            const label = typeName(t, group.type)
            // Only an open group is worth clipping: a closed one renders nothing either way.
            const clipped = open
              ? clipTree(trees.get(group.type) ?? [], { left: limits[group.type] ?? ROW_BATCH })
              : undefined
            return (
              <div key={group.type}>
                <button
                  type="button"
                  aria-expanded={open}
                  title={open ? t('wiki.group.collapse') : t('wiki.group.expand')}
                  onClick={() => { toggleType(group.type) }}
                  onMouseEnter={() => { setHoverType(group.type) }}
                  onMouseLeave={() => { setHoverType(current => (current === group.type ? null : current)) }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: ROW_PADDING,
                    border: 'none',
                    background: hoverType === group.type ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                    color: 'var(--dsw-alias-label-primary)',
                    fontFamily: FONT_FAMILY,
                    fontSize: FONT_SIZE_BODY,
                    fontWeight: 600,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ flex: '0 0 auto', display: 'flex', opacity: 0.7 }}>
                    {open ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
                  </span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                  <span style={{ flex: '0 0 auto', fontSize: FONT_SIZE_SMALL, opacity: 0.6 }}>{group.pages.length}</span>
                </button>
                {clipped !== undefined && renderTree(clipped.nodes, 0)}
                {clipped !== undefined && clipped.dropped > 0 && (
                  <div style={{ paddingLeft: PAGE_ROW_INDENT, paddingBottom: 6 }}>
                    <Button variant="ghost" size="sm" onClick={() => { revealMore(group.type) }}>
                      {template(t, 'wiki.showMore', { n: clipped.dropped })}
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selected === null
          ? <div style={{ padding: 12, fontSize: FONT_SIZE_BODY, opacity: 0.6 }}>{t('wiki.select')}</div>
          : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: ROW_PADDING_X12, borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
                <span style={{ fontSize: FONT_SIZE_SMALL, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected}</span>
                <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                  <Button variant="ghost" size="sm" onClick={() => { void showDetail('chunks') }} icon={<IconListPenOutlineRegular />} style={{ fontWeight: detailMode === 'chunks' ? 600 : 400 }}>
                    {t('wiki.chunks')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { void showDetail('vectors') }} icon={<IconLinkOutlineRegular />} style={{ fontWeight: detailMode === 'vectors' ? 600 : 400 }}>
                    {t('wiki.vectors')}
                  </Button>
                  <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--dsw-alias-border-l2)', margin: '2px 0' }} />
                  <Button variant="ghost" size="sm" onClick={() => { setEditing(!editing); setDetailMode(null); setDetail(null) }} icon={editing ? <IconCloseOutlineRegular /> : <IconEditOutlineRegular />}>
                    {editing ? t('wiki.cancel') : t('wiki.edit')}
                  </Button>
                  {editing && <Button variant="primary" size="sm" onClick={() => { void save() }} icon={<IconCheckOutlineRegular />}>{t('wiki.save')}</Button>}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={recompilingThis}
                    onClick={() => { void runRecompile() }}
                    icon={<IconThinkOutlineRegular />}
                  >
                    {recompilingThis ? t('wiki.recompiling') : t('wiki.recompile')}
                  </Button>
                </div>
              </div>
              {/* One window is one model call, so the bar moves once per window and holds still
                  inside one. It sits on the header it belongs to rather than taking a row of its own. */}
              {recompilingThis && (
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                  style={{ height: 2, flex: '0 0 auto', background: 'var(--dsw-alias-border-l2)' }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${String(progress)}%`,
                      background: 'var(--dsw-alias-state-business-primary)',
                      transition: 'width 400ms ease-out',
                    }}
                  />
                </div>
              )}
              {(message !== null || error !== null) && (
                <div style={{ padding: '4px 12px', fontSize: FONT_SIZE_SMALL, color: error === null ? 'inherit' : 'var(--dsw-alias-state-error-primary)', opacity: error === null ? 0.7 : 1 }}>
                  {error ?? message}
                </div>
              )}
              <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
                {detailMode === null
                  ? (editing
                    ? (
                      <textarea
                        value={content}
                        onChange={event => setContent(event.target.value)}
                        style={{
                          width: '100%',
                          height: '100%',
                          boxSizing: 'border-box',
                          fontFamily: FONT_CODE_FAMILY,
                          fontSize: FONT_SIZE_BODY,
                          color: 'var(--dsw-alias-label-primary)',
                          background: 'var(--dsw-alias-bg-layer-3)',
                          border: '0.5px solid var(--dsw-alias-border-l3)',
                          borderRadius: 10,
                          padding: '8px 10px',
                          resize: 'none',
                        }}
                      />
                    )
                    : <MarkdownText text={content} labels={labels} />)
                  : renderDetail()}
              </div>
            </>
          )}
      </div>
      <Modal
        open={pendingRecompileAll}
        title={t('wiki.recompileAll')}
        closeLabel={t('common.close')}
        onClose={() => { setPendingRecompileAll(false) }}
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => { setPendingRecompileAll(false) }}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={recompilingAll} onClick={() => { void runRecompileAll() }}>{t('common.confirm')}</Button>
          </div>
        )}
      >
        <div style={{ fontSize: FONT_SIZE_BODY, minWidth: 320 }}>
          <span>{t('wiki.confirmRecompileAll')}</span>
        </div>
      </Modal>
    </div>
  )
}
