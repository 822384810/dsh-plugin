/** Multi-library selection, presented as one row of book-like cards. */
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconCheckOutlineRegular,
  IconEditOutlineRegular,
  IconPlusOutlineRegular,
  IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LibraryView, WikiActions } from '../api.ts'
import type { Translate } from '../translate.ts'
import { FONT_FAMILY, FONT_SIZE_BODY, FONT_SIZE_SMALL, LINE_HEIGHT_BODY, LINE_HEIGHT_SMALL } from '../typography.ts'
import { WikiPanelIcon } from './WikiPanelIcon.tsx'

/**
 * Fixed card size, portrait: a card reads as a closed book standing on a shelf, and the strip
 * stays exactly one card tall whatever the library count.
 */
const CARD_HEIGHT = 136
const CARD_WIDTH = 112

/** Frame shared by the add card and every library card. */
const CARD_FRAME = {
  flex: `0 0 ${String(CARD_WIDTH)}px`,
  width: CARD_WIDTH,
  height: CARD_HEIGHT,
  boxSizing: 'border-box',
} as const

/**
 * Split a stored `YYYY-MM-DD HH:mm:ss` into its date and minute-precision clock, so the narrow
 * card can stack them instead of clipping one long line.
 * @param stamp - The stored local timestamp; '' when unknown.
 * @returns The date and the `HH:mm` clock, each '' when the stamp carried none.
 */
function splitCreatedAt(stamp: string): readonly [string, string] {
  const [date = '', clock = ''] = stamp.split(' ')
  return [date, clock.slice(0, 5)]
}

/** Props: the data access used, the copy, and the selection the panel owns. */
export interface LibrarySwitcherProps extends Pick<
  WikiActions,
  | 'libraryList' | 'libraryAdd' | 'librarySwitch' | 'libraryRename'   | 'libraryRemove'
  | 'pickDirectory'
> {
  readonly t: Translate
  readonly activeId: string | null
  /** Reported selection; null means no library is selected any more. */
  readonly onSwitch: (id: string | null) => void
  /** Called whenever the list changes, so the panel can name the active library elsewhere. */
  readonly onLibrariesChange?: ((libraries: readonly LibraryView[]) => void) | undefined
  /** Raises a message in the panel's shared status strip. */
  readonly notify: (message: string) => void
}

/**
 * One icon-only card action.
 *
 * The click stops at the button: the card underneath selects a library, and an edit must not also
 * switch the current one.
 * @param props - Label, disabled state, handler and the icon.
 * @returns The button.
 */
function CardAction({ label, disabled, onClick, children }: {
  readonly label: string
  readonly disabled?: boolean | undefined
  readonly onClick: () => void
  readonly children: ReactNode
}): ReactElement {
  const [hover, setHover] = useState(false)
  const off = disabled === true
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={off}
      onClick={event => { event.stopPropagation(); onClick() }}
      onMouseEnter={() => { setHover(true) }}
      onMouseLeave={() => { setHover(false) }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        padding: 0,
        border: 'none',
        borderRadius: 6,
        background: hover && !off ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: off ? 'default' : 'pointer',
        opacity: off ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  )
}

/**
 * Choose, create, rename or forget a knowledge base.
 *
 * The row is one card tall whatever the library count: extra libraries scroll sideways, so the
 * panel's vertical budget belongs to the file views rather than to the switcher.
 * @param props - Data access, copy and selection state.
 * @returns The card strip and its dialogs.
 */
export function LibrarySwitcher({
  libraryList,
  libraryAdd,
  librarySwitch,
  libraryRename,
  libraryRemove,
  t,
  activeId,
  onSwitch,
  onLibrariesChange,
  notify,
  pickDirectory,
}: LibrarySwitcherProps): ReactElement {
  const [libraries, setLibraries] = useState<readonly LibraryView[]>([])
  const [adding, setAdding] = useState(false)
  // Each destructive action carries the card it applies to: cards switch on click, so "the active
  // one" could have moved between opening the dialog and confirming it.
  const [editing, setEditing] = useState<LibraryView | null>(null)
  const [removing, setRemoving] = useState<LibraryView | null>(null)
  const [addName, setAddName] = useState('')
  const [addRootDir, setAddRootDir] = useState('')
  const [editName, setEditName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await libraryList()
      setLibraries(next)
      onLibrariesChange?.(next)
      if (activeId === null) {
        const active = next.find(library => library.isActive)
        if (active !== undefined) onSwitch(active.id)
      }
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason))
    }
  }, [libraryList, activeId, onSwitch, onLibrariesChange, notify])

  useEffect(() => { void refresh() }, [refresh])

  const create = async (): Promise<void> => {
    try {
      setError(null)
      const created = await libraryAdd(addName.trim() === '' ? addRootDir : addName, addRootDir)
      setAdding(false)
      setAddName('')
      setAddRootDir('')
      onSwitch(created.id)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const saveEdit = async (): Promise<void> => {
    const target = editing
    if (target === null) return
    setBusy(true)
    setError(null)
    try {
      await libraryRename(target.id, editName.trim())
      setEditing(null)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    const target = removing
    if (target === null) return
    setRemoving(null)
    try {
      await libraryRemove(target.id)
      // The removed card is gone; if it was the current one nothing is selected, and `''` would
      // read as a real id further down and be sent to the Host as one.
      if (target.id === activeId) onSwitch(null)
      await refresh()
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const switchTo = async (id: string): Promise<void> => {
    onSwitch(id)
    try {
      await librarySwitch(id)
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason))
    }
  }

  // Fill the root from the web app's directory picker; a typed path stays equally valid.
  const browse = async (): Promise<void> => {
    try {
      setError(null)
      const picked = await pickDirectory()
      if (picked !== null && picked !== '') setAddRootDir(picked)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <div style={{ borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
      {/* Panel title: tells the user which surface they are on. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 8px 6px' }}>
        <span style={{ display: 'flex', alignItems: 'center', color: 'var(--dsw-alias-state-business-primary)' }}>
          <WikiPanelIcon size={18} />
        </span>
        <span
          style={{
            flex: '0 0 auto',
            fontSize: 15,
            fontWeight: 600,
            lineHeight: '22px',
            fontFamily: FONT_FAMILY,
            color: 'var(--dsw-alias-label-primary)',
          }}
        >
          {t('menu.title')}
        </span>
      </div>
      {/* One row of cards; extra libraries scroll sideways rather than wrapping. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '8px 8px 12px',
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'thin',
        }}
      >
        <button
          type="button"
          aria-label={t('library.add')}
          title={t('library.add')}
          onClick={() => { setError(null); setAdding(true) }}
          style={{
            ...CARD_FRAME,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '0 12px',
            border: '1px dashed var(--dsw-alias-border-l3)',
            borderRadius: 8,
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
            fontSize: FONT_SIZE_SMALL,
            lineHeight: LINE_HEIGHT_SMALL,
            textAlign: 'center',
          }}
        >
          <IconPlusOutlineRegular size={18} />
          {t('library.add')}
        </button>
        {libraries.map(library => {
          const current = library.id === activeId
          const [createdDate, createdClock] = splitCreatedAt(library.createdAt)
          return (
            <div
              key={library.id}
              role="button"
              tabIndex={current ? -1 : 0}
              aria-current={current}
              aria-label={current ? library.name : `${t('library.setCurrent')}: ${library.name}`}
              title={current ? undefined : t('library.setCurrent')}
              onClick={() => { if (!current) void switchTo(library.id) }}
              onKeyDown={event => {
                if (current) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  void switchTo(library.id)
                }
              }}
              style={{
                ...CARD_FRAME,
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                padding: '12px 10px 10px 16px',
                borderRadius: 8,
                border: `1px solid ${current ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'}`,
                background: current ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-bg-layer-1)',
                cursor: current ? 'default' : 'pointer',
                overflow: 'hidden',
              }}
            >
              {/* Closed cover: a spine down the left edge and nothing that suggests opened pages. */}
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 5,
                  background: current ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l3)',
                }}
              />
              {current && (
                <span
                  title={t('library.current')}
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    display: 'flex',
                    color: 'var(--dsw-alias-state-business-primary)',
                  }}
                >
                  <IconCheckOutlineRegular size={13} />
                </span>
              )}
              <span
                title={library.name}
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  paddingRight: 16,
                  fontSize: FONT_SIZE_BODY,
                  lineHeight: LINE_HEIGHT_SMALL,
                  fontWeight: 600,
                  color: 'var(--dsw-alias-label-primary)',
                  wordBreak: 'break-word',
                }}
              >
                {library.name}
              </span>
              <div
                title={library.rootDir}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  // Push the meta and the actions to the foot of the cover, so a short title leaves
                  // its silence in the middle instead of a gap between two pinned blocks.
                  marginTop: 'auto',
                  minHeight: LINE_HEIGHT_SMALL,
                  fontSize: FONT_SIZE_SMALL,
                  lineHeight: LINE_HEIGHT_SMALL,
                  color: 'var(--dsw-alias-label-tertiary)',
                }}
              >
                {createdDate !== '' && <span>{createdDate}</span>}
                {createdClock !== '' && <span>{createdClock}</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
                <CardAction
                  label={t('library.edit')}
                  onClick={() => { setError(null); setEditing(library); setEditName(library.name) }}
                >
                  <IconEditOutlineRegular size={14} />
                </CardAction>
                <CardAction label={t('library.remove')} onClick={() => { setRemoving(library) }}>
                  <IconTrashOutlineRegular size={14} />
                </CardAction>
              </div>
            </div>
          )
        })}
      </div>
      <Modal
        open={adding}
        title={t('library.add')}
        closeLabel={t('common.close')}
        onClose={() => { setAdding(false) }}
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => { setAdding(false) }}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={addRootDir.trim() === ''} onClick={() => { void create() }}>{t('common.confirm')}</Button>
          </div>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 320, lineHeight: LINE_HEIGHT_BODY }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: FONT_SIZE_BODY }}>
            {t('library.name')}
            <Input value={addName} onChange={event => setAddName(event.target.value)} placeholder={t('library.name')} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: FONT_SIZE_BODY }}>
            {t('library.rootDir')}
            {/* Grid, not flex: a grid item stretches to its column, so the field keeps the full
                width while the button sits beside it. */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
              <Input value={addRootDir} onChange={event => setAddRootDir(event.target.value)} placeholder="D:/standards" />
              <Button variant="ghost" size="sm" onClick={() => { void browse() }}>{t('library.browse')}</Button>
            </div>
          </label>
          {error !== null && <span style={{ fontSize: FONT_SIZE_SMALL, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</span>}
        </div>
      </Modal>
      <Modal
        open={editing !== null}
        title={t('library.edit')}
        closeLabel={t('common.close')}
        onClose={() => { setEditing(null) }}
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(null) }}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || editName.trim() === ''}
              onClick={() => { void saveEdit() }}
            >
              {t('common.confirm')}
            </Button>
          </div>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 320, lineHeight: LINE_HEIGHT_BODY }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: FONT_SIZE_BODY }}>
            {t('library.name')}
            <Input value={editName} onChange={event => setEditName(event.target.value)} placeholder={t('library.name')} />
          </label>
          {/* The root directory is the library's identity on disk, so it is shown, not edited. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: FONT_SIZE_SMALL, color: 'var(--dsw-alias-label-secondary)' }}>{t('library.rootDir')}</span>
            <span style={{ fontSize: FONT_SIZE_SMALL, color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' }}>
              {editing?.rootDir ?? ''}
            </span>
          </div>
          {error !== null && <span style={{ fontSize: FONT_SIZE_SMALL, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</span>}
        </div>
      </Modal>
      <Modal
        open={removing !== null}
        title={t('library.remove')}
        closeLabel={t('common.close')}
        onClose={() => { setRemoving(null) }}
        footer={(
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => { setRemoving(null) }}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={() => { void remove() }}>{t('common.confirm')}</Button>
          </div>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: FONT_SIZE_BODY, minWidth: 320, lineHeight: LINE_HEIGHT_BODY }}>
          <span style={{ fontWeight: 600, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' }}>
            {removing?.name ?? ''}
          </span>
          <span>{t('library.confirmRemove')}</span>
        </div>
      </Modal>
    </div>
  )
}
