/** The knowledge-base panel: one tab per Karpathy layer. */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LibraryView, WikiActions } from '../api.ts'
import { useIngestFeed } from '../ingest-feed.ts'
import type { WikiKey } from '../locales.ts'
import { template, translator, type Translate } from '../translate.ts'
import { FONT_SIZE_BODY, FONT_SIZE_SMALL, LINE_HEIGHT_BODY } from '../typography.ts'
import { LibrarySwitcher } from './LibrarySwitcher.tsx'
import { ModelSwitcher } from './ModelSwitcher.tsx'
import { RawSourcesView } from './RawSourcesView.tsx'
import { WikiView } from './WikiView.tsx'
import { SchemaView } from './SchemaView.tsx'
import { IngestProgress } from './IngestProgress.tsx'

/** One tab of the panel. */
type Tab = 'raw' | 'wiki' | 'schema'

/** How long a transient message stays on screen. */
const TOAST_MS = 5000

/**
 * Bottom bar naming the library everything above belongs to.
 *
 * The progress panel and the file list are both scoped to one library, so the panel states which
 * one — including after a switch, when the two could otherwise be confused. The compile model sits
 * at the far end of the same bar, because it is a property of that one library too.
 * @param props - The active library, the model actions and copy.
 * @returns The bar.
 */
function LibraryBar({ library, t, activeId, modelCatalog, setCompileModel }: {
  readonly library: LibraryView | null
  readonly t: Translate
  readonly activeId: string | null
  readonly modelCatalog: WikiActions['modelCatalog']
  readonly setCompileModel: WikiActions['setCompileModel']
}): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderTop: '1px solid var(--dsw-alias-border-l2)',
        fontSize: FONT_SIZE_SMALL,
        color: 'var(--dsw-alias-label-secondary)',
      }}
    >
      <span style={{ flex: '0 0 auto', opacity: 0.7 }}>{t('menu.title')}</span>
      {library === null
        ? <span style={{ opacity: 0.6 }}>{t('library.none')}</span>
        : (
          <>
            <span
              style={{
                flex: '0 0 auto',
                maxWidth: 160,
                fontWeight: 600,
                color: 'var(--dsw-alias-label-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {library.name}
            </span>
            {library.createdAt !== '' && (
              <span style={{ flex: '0 0 auto', opacity: 0.55, whiteSpace: 'nowrap' }}>
                {template(t, 'library.createdAt', { time: library.createdAt })}
              </span>
            )}
            <span
              title={library.rootDir}
              style={{ flex: 1, minWidth: 0, opacity: 0.55, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {library.rootDir}
            </span>
          </>
        )}
      <span style={{ flex: '0 1 180px', minWidth: 80, marginLeft: 'auto', display: 'flex' }}>
        <ModelSwitcher
          modelCatalog={modelCatalog}
          setCompileModel={setCompileModel}
          t={t}
          activeId={activeId}
        />
      </span>
    </div>
  )
}

/** Props: the injected data access plus the framework's translator. */
export interface WikiPanelProps extends WikiActions {
  readonly t?: ((key: WikiKey) => string) | undefined
}

/**
 * Render the panel.
 * @param props - Data access injected by the browser plugin, and copy from the locale service.
 * @returns The panel.
 */
export function WikiPanel(props: WikiPanelProps): ReactElement {
  const { t: translate, ...actions } = props
  const t: Translate = translator(translate)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [libraries, setLibraries] = useState<readonly LibraryView[]>([])
  /** Whether the first `libraryList()` has answered: gates the library hint so it cannot flash. */
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState<Tab>('raw')
  /** Which tab the pointer rests on: DSH interactive rows answer a hover with a subtle wash. */
  const [hoverTab, setHoverTab] = useState<Tab | null>(null)

  const active = libraries.find(library => library.id === activeId) ?? null

  // Transient message shown under the header; surfaces raise it through `notify`.
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const notify = useCallback((message: string): void => {
    setToast(message)
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])
  useEffect(() => () => {
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
  }, [])

  // One poller for every ingest surface in the panel: the progress strip and the raw file list
  // render the same snapshot of the selected library, so the two always agree and the Host is asked
  // once per interval for one library's queue rather than every library's.
  const ingest = useIngestFeed(actions.ingestStates, activeId)

  // Select whatever library the Host considers active, so the panel opens on the right one.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await actions.libraryList()
        if (cancelled) return
        setLibraries(next)
        const active = next.find(library => library.isActive)
        if (active !== undefined) setActiveId(active.id)
      } catch {
        // No library yet: the status strip is the right answer.
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [actions.libraryList])

  const tabs: ReadonlyArray<readonly [Tab, string]> = [
    ['raw', t('panel.raw')],
    ['wiki', t('panel.wiki')],
    ['schema', t('panel.schema')],
  ]

  // Library-state hints share the transient-message strip, so the panel states its situation in one
  // place instead of scattering copy through the switcher row and the body.
  const hint = activeId === null && loaded
    ? (libraries.length === 0 ? t('library.empty') : t('library.none'))
    : null
  const message = toast ?? hint

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, lineHeight: LINE_HEIGHT_BODY }}>
      <LibrarySwitcher
        libraryList={actions.libraryList}
        libraryAdd={actions.libraryAdd}
        librarySwitch={actions.librarySwitch}
        libraryRemove={actions.libraryRemove}
        libraryRename={actions.libraryRename}
        t={t}
        activeId={activeId}
        onSwitch={setActiveId}
        onLibrariesChange={setLibraries}
        notify={notify}
        pickDirectory={actions.pickDirectory}
      />
      {message !== null && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '10px 12px',
            fontSize: FONT_SIZE_BODY,
            lineHeight: '20px',
            fontWeight: 500,
            whiteSpace: 'pre-line',
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-3)',
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
            borderLeft: '4px solid var(--dsw-alias-state-warning-primary)',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
          }}
        >
          <span
            aria-hidden="true"
            style={{ flex: '0 0 auto', display: 'flex', paddingTop: 2, color: 'var(--dsw-alias-state-warning-primary)' }}
          >
            <IconWarningOutlineRegular size={16} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
        </div>
      )}
      {activeId === null
        ? null
        : (
          <>
            <div role="tablist" aria-label={t('menu.title')} style={{ display: 'flex', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
              {tabs.map(([id, label]) => {
                const isActive = tab === id
                return (
                  <button
                    key={id}
                    id={`llm-wiki-tab-${id}`}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-controls="llm-wiki-tabpanel"
                    onClick={() => { setTab(id) }}
                    onMouseEnter={() => { setHoverTab(id) }}
                    onMouseLeave={() => { setHoverTab(current => (current === id ? null : current)) }}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: FONT_SIZE_BODY,
                      background: !isActive && hoverTab === id ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                      color: isActive ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                      borderBottom: isActive ? '2px solid var(--dsw-alias-state-business-primary)' : '2px solid transparent',
                      fontWeight: isActive ? 600 : 400,
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            {/* Content sits inside the same 8px gutters as the header, so the panel reads as one surface. */}
            <div id="llm-wiki-tabpanel" role="tabpanel" aria-labelledby={`llm-wiki-tab-${tab}`} style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '0 8px' }}>
              {tab === 'raw' && (
                <RawSourcesView
                  fsList={actions.fsList}
                  fsRead={actions.fsRead}
                  fsUpload={actions.fsUpload}
                  fsMkdir={actions.fsMkdir}
                  fsDelete={actions.fsDelete}
                  fsReingest={actions.fsReingest}
                  fsDownload={actions.fsDownload}
                  fsPreview={actions.fsPreview}
                  supportedTypes={actions.supportedTypes}
                  reindex={actions.reindex}
                  state={ingest.state}
                  refresh={ingest.refresh}
                  notify={notify}
                  t={t}
                  libId={activeId}
                />
              )}
              {tab === 'wiki' && (
                <WikiView
                  listPages={actions.listPages}
                  fsRead={actions.fsRead}
                  fsWrite={actions.fsWrite}
                  recompile={actions.recompile}
                  recompileAll={actions.recompileAll}
                  ingestStates={actions.ingestStates}
                  sourceDetail={actions.sourceDetail}
                  t={t}
                  libId={activeId}
                />
              )}
              {tab === 'schema' && (
                <SchemaView
                  schemaGet={actions.schemaGet}
                  schemaParse={actions.schemaParse}
                  schemaUpdate={actions.schemaUpdate}
                  fsWrite={actions.fsWrite}
                  t={t}
                  libId={activeId}
                />
              )}
            </div>
            <IngestProgress
              state={ingest.state}
              othersBusy={ingest.othersBusy}
              t={t}
              libId={activeId}
            />
            <LibraryBar
        library={active}
        t={t}
        activeId={activeId}
        modelCatalog={actions.modelCatalog}
        setCompileModel={actions.setCompileModel}
      />
          </>
        )}
    </div>
  )
}
