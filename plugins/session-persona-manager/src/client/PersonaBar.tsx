/** Session-header entry that binds a persona to the session it belongs to. */
import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { PersonaManager } from './PersonaManager.tsx'
import type { PersonaKey } from './locales.ts'

/** Sentinel menu id for the "manage personas" row; selecting it opens the manager modal. */
const MANAGE_ID = '__manage__'

/** One persona as the Host half projects it to the browser. */
export interface PersonaView {
  readonly id: string
  readonly name: string
  readonly content: string
}

/** Data access injected by the browser plugin; the component never talks to `fetch` itself. */
export interface PersonaBarInjected {
  list: () => Promise<PersonaView[]>
  current: (sessionId: string) => Promise<PersonaView | null>
  assign: (sessionId: string, personaId: string) => Promise<PersonaView | null>
  create: (name: string, content: string) => Promise<PersonaView>
  update: (id: string, name: string, content: string) => Promise<PersonaView>
  remove: (id: string) => Promise<void>
}

/** Props: session scope from the slot framework, copy from the locale namespace, data from the plugin. */
export interface PersonaBarProps extends PersonaBarInjected {
  readonly sessionId: string
  readonly t: (key: PersonaKey) => string
}

/** Render the persona trigger and its menu, styled through the shared UI primitives. */
export function PersonaBar({ sessionId, t, list, current, assign, create, update, remove }: PersonaBarProps) {
  const [open, setOpen] = useState(false)
  const [personas, setPersonas] = useState<readonly PersonaView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<PersonaView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manageOpen, setManageOpen] = useState(false)

  // Keep the trigger label correct as the active session changes (and on first mount),
  // independent of whether the menu is open. Without this, switching sessions leaves the
  // header showing the previous session's persona until the menu is opened again.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const active = await current(sessionId)
        if (cancelled) return
        setSelected(active)
        setError(null)
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => { cancelled = true }
  }, [sessionId, current])

  // Refresh the full list and the active selection together whenever the menu opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const [all, active] = await Promise.all([list(), current(sessionId)])
        if (cancelled) return
        setPersonas(all)
        setLoaded(true)
        setSelected(active)
        setError(null)
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => { cancelled = true }
  }, [open, sessionId, list, current])

  // Re-read the active persona after the catalog changes (e.g. the assigned persona was deleted).
  const refreshCurrent = useCallback(() => {
    void (async () => {
      try {
        setSelected(await current(sessionId))
      } catch {
        // The open-menu effect surfaces real errors on the next open; ignore a transient miss here.
      }
    })()
  }, [current, sessionId])

  const onSelect = useCallback((personaId: string) => {
    if (personaId === MANAGE_ID) {
      setManageOpen(true)
      setOpen(false)
      return
    }
    void (async () => {
      try {
        const bound = await assign(sessionId, personaId)
        setSelected(bound)
        setError(null)
        setOpen(false)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }, [assign, sessionId])

  const items: MenuEntry[] = [
    { type: 'label', id: 'current', text: `${t('panel.current')}: ${selected?.name ?? t('panel.default')}` },
  ]
  if (loaded && personas.length === 0) {
    items.push({ type: 'label', id: 'empty', text: t('panel.empty') })
  } else {
    for (const persona of personas) items.push({ id: persona.id, label: persona.name })
  }

  const footer: readonly MenuEntry[] | undefined = error !== null
    ? [{ type: 'label', id: 'error', text: `${t('panel.failed')}: ${error}` }]
    : [{ id: MANAGE_ID, label: t('panel.manage') }]

  return (
    <>
    <Menu
      open={open}
      align="start"
      side="bottom"
      portal
      selectedId={selected?.id}
      onClose={() => { setOpen(false) }}
      onSelect={onSelect}
      anchor={(
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('action.open')}
          title={selected?.name ?? t('panel.default')}
          onClick={() => { setOpen(value => !value) }}
          icon={<span aria-hidden="true">🎭</span>}
        >
          {selected?.name ?? t('action.open')}
        </Button>
      )}
      items={items}
      footer={footer}
    />
    <PersonaManager
      open={manageOpen}
      onClose={() => { setManageOpen(false) }}
      t={t}
      list={list}
      create={create}
      update={update}
      remove={remove}
      onCatalogChanged={refreshCurrent}
    />
    </>
  )
}
