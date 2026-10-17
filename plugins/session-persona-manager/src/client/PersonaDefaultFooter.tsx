/**
 * Sidebar footer action: pick the persona every new session starts with.
 *
 * Lives in `sidebar.footer.action` (root scope, always visible), so it needs no
 * active session — unlike the per-session header picker. The Host half applies the
 * chosen default when a fresh session's agent is created, so the first message
 * already carries the persona. Selecting "默认（无人格）" clears it.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PersonaView } from './PersonaBar.tsx'
import type { PersonaKey } from './locales.ts'

/** Reserved id meaning "no persona" — must match the Host half's DEFAULT_PERSONA_ID. */
const NO_PERSONA_ID = 'default'

/** Data access injected by the browser plugin; the component never talks to `fetch` itself. */
export interface PersonaDefaultInjected {
  list: () => Promise<PersonaView[]>
  /** Read the persona applied to new sessions, or null when it is "no persona". */
  getDefault: () => Promise<PersonaView | null>
  /** Set the persona applied to new sessions ('default' clears to no persona). */
  setDefault: (personaId: string) => Promise<PersonaView | null>
}

/** Props: column width from the slot owner, copy from the locale namespace, data from the plugin. */
export interface PersonaDefaultFooterProps extends PersonaDefaultInjected {
  readonly wide: boolean
  readonly t: (key: PersonaKey) => string
}

/** Render the default-persona trigger and its menu in the sidebar foot. */
export function PersonaDefaultFooter({ wide, t, list, getDefault, setDefault }: PersonaDefaultFooterProps) {
  const [open, setOpen] = useState(false)
  const [personas, setPersonas] = useState<readonly PersonaView[]>([])
  const [selected, setSelected] = useState<PersonaView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Refresh the catalog and the current default together whenever the menu opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const [all, current] = await Promise.all([list(), getDefault()])
        if (cancelled) return
        setPersonas(all)
        setLoaded(true)
        setSelected(current)
        setError(null)
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => { cancelled = true }
  }, [open, list, getDefault])

  const onSelect = useCallback((personaId: string) => {
    void (async () => {
      try {
        const bound = await setDefault(personaId)
        setSelected(bound)
        setError(null)
        setOpen(false)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }, [setDefault])

  // The reserved "default" persona (id must equal NO_PERSONA_ID) is the data's "no persona"
  // choice: it is already returned by `list()`, so the menu simply lists the catalog and lets
  // that row act as the clear option, instead of adding a separate "默认（无人格）" entry.
  const defaultName = personas.find(persona => persona.id === NO_PERSONA_ID)?.name
  const items: MenuEntry[] = [
    { type: 'label', id: 'current', text: `${t('footer.current')}: ${selected?.name ?? defaultName ?? t('footer.none')}` },
  ]
  if (loaded && personas.length === 0) {
    items.push({ type: 'label', id: 'empty', text: t('panel.empty') })
  } else {
    for (const persona of personas) items.push({ id: persona.id, label: persona.name })
  }

  const footer: readonly MenuEntry[] | undefined = error !== null
    ? [{ type: 'label', id: 'error', text: `${t('panel.failed')}: ${error}` }]
    : undefined

  return (
    <Menu
      open={open}
      align="start"
      side="top"
      portal
      selectedId={selected?.id ?? NO_PERSONA_ID}
      onClose={() => { setOpen(false) }}
      onSelect={onSelect}
      anchor={(
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('footer.open')}
          title={selected?.name ?? t('footer.open')}
          onClick={() => { setOpen(value => !value) }}
          icon={<span aria-hidden="true">🎭</span>}
        >
          {wide ? (selected?.name ?? t('footer.open')) : null}
        </Button>
      )}
      items={items}
      footer={footer}
    />
  )
}
