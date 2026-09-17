/**
 * Persona catalog manager: create / edit / delete every persona except the
 * reserved default. Opened from the session-header persona menu; renders through
 * the shared `Modal` so it layers above the rest of the UI.
 * @module session-persona-manager.client/PersonaManager
 */
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Button,
  IconEditOutline16,
  IconPlusOutline16,
  IconTrashOutline16,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PersonaView } from './PersonaBar.tsx'
import type { PersonaKey } from './locales.ts'

/** Reserved id that the catalog API refuses to edit or delete. */
const DEFAULT_PERSONA_ID = 'default'

/** Props: copy, transport, and an optional hook fired after the catalog changes. */
export interface PersonaManagerProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly t: (key: PersonaKey) => string
  readonly list: () => Promise<PersonaView[]>
  readonly create: (name: string, content: string) => Promise<PersonaView>
  readonly update: (id: string, name: string, content: string) => Promise<PersonaView>
  readonly remove: (id: string) => Promise<void>
  readonly onCatalogChanged?: () => void
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 10,
  border: '0.5px solid var(--dsw-alias-border-l2)',
}

const rowNameStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: '22px',
  color: 'var(--dsw-alias-label-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const rowContentStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const tagStyle: CSSProperties = {
  flex: 'none',
  alignSelf: 'center',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
  padding: '2px 8px',
  borderRadius: 999,
  border: '0.5px solid var(--dsw-alias-border-l2)',
}

const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }

const labelStyle: CSSProperties = { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }

/** 必填标记 `*`（红色）。 */
const requiredStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }

const textareaStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 480,
  resize: 'vertical',
  padding: '8px 10px',
  borderRadius: 10,
  border: '0.5px solid var(--dsw-alias-border-l3)',
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
}

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--dsw-alias-state-error-primary)',
}

/** Render the persona catalog manager inside a modal. */
export function PersonaManager({
  open, onClose, t, list, create, update, remove, onCatalogChanged,
}: PersonaManagerProps) {
  const [personas, setPersonas] = useState<readonly PersonaView[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [editing, setEditing] = useState<PersonaView | null>(null)
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const reload = useCallback(() => {
    void (async () => {
      try {
        setPersonas(await list())
        setLoadError(null)
      } catch (reason) {
        setLoadError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
  }, [list])

  useEffect(() => {
    if (open) {
      setMode('list')
      setConfirmingDelete(null)
      reload()
    }
  }, [open, reload])

  const openCreate = useCallback(() => {
    setEditing(null)
    setName('')
    setContent('')
    setFormError(null)
    setMode('form')
  }, [])

  const openEdit = useCallback((persona: PersonaView) => {
    setEditing(persona)
    setName(persona.name)
    setContent(persona.content)
    setFormError(null)
    setMode('form')
  }, [])

  const save = useCallback(() => {
    if (name.trim() === '') {
      setFormError(t('panel.nameRequired'))
      return
    }
    void (async () => {
      setSaving(true)
      try {
        if (editing === null) await create(name.trim(), content)
        else await update(editing.id, name.trim(), content)
        setMode('list')
        reload()
        onCatalogChanged?.()
      } catch (reason) {
        setFormError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setSaving(false)
      }
    })()
  }, [name, content, editing, create, update, reload, onCatalogChanged, t])

  const doDelete = useCallback((id: string) => {
    void (async () => {
      setBusyId(id)
      try {
        await remove(id)
        setConfirmingDelete(null)
        reload()
        onCatalogChanged?.()
      } catch (reason) {
        setLoadError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusyId(null)
      }
    })()
  }, [remove, reload, onCatalogChanged])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('panel.manage')}
      closeLabel={t('panel.close')}
      className="spm-dialog"
      footer={mode === 'list'
        ? <Button variant="ghost" size="sm" onClick={onClose}>{t('panel.done')}</Button>
        : (
          <>
            <Button variant="ghost" size="sm" onClick={() => { setMode('list') }} disabled={saving}>
              {t('panel.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={save} disabled={saving}>
              {t('panel.save')}
            </Button>
          </>
        )}
    >
      <style>{'.spm-dialog{width:min(560px,100%)!important}'}</style>
      {mode === 'list' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" icon={<IconPlusOutline16 />} onClick={openCreate}>
              {t('panel.add')}
            </Button>
          </div>
          {loadError !== null && <p style={errorStyle}>{`${t('panel.failed')}: ${loadError}`}</p>}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            maxHeight: 'min(50vh, 320px)',
            overflowY: 'auto',
            paddingRight: 4,
          }}
          >
            {personas.map((persona) => {
              const isDefault = persona.id === DEFAULT_PERSONA_ID
              return (
                <div key={persona.id} style={rowStyle}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={rowNameStyle}>{persona.name}</div>
                    {persona.content !== '' && <div style={rowContentStyle}>{persona.content}</div>}
                  </div>
                  {isDefault
                    ? <span style={tagStyle}>{t('panel.defaultTag')}</span>
                    : (
                      <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
                        {confirmingDelete === persona.id
                          ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busyId === persona.id}
                                onClick={() => { setConfirmingDelete(null) }}
                              >
                                {t('panel.cancel')}
                              </Button>
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={busyId === persona.id}
                                onClick={() => { doDelete(persona.id) }}
                              >
                                {t('panel.confirm')}
                              </Button>
                            </>
                          )
                          : (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                icon={<IconEditOutline16 />}
                                onClick={() => { openEdit(persona) }}
                              >
                                {t('panel.edit')}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                icon={<IconTrashOutline16 />}
                                onClick={() => { setConfirmingDelete(persona.id) }}
                              >
                                {t('panel.delete')}
                              </Button>
                            </>
                          )}
                      </div>
                    )}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('panel.name')}<span style={requiredStyle}> *</span></span>
            <Input
              value={name}
              onChange={(event) => { setName(event.target.value) }}
              placeholder={t('panel.namePlaceholder')}
            />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('panel.content')}</span>
            <textarea
              value={content}
              onChange={(event) => { setContent(event.target.value) }}
              placeholder={t('panel.contentPlaceholder')}
              style={textareaStyle}
            />
          </label>
          {formError !== null && <p style={errorStyle}>{formError}</p>}
        </div>
      )}
    </Modal>
  )
}
