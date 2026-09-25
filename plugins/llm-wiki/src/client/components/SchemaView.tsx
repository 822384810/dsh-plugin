/** Schema: the third layer — the rules the compiler maintains the Wiki by. */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Button, Checkbox, Input, MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconBrowseOutlineRegular, IconEditOutlineRegular, IconListPenOutlineRegular, IconCheckOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WikiActions } from '../api.ts'
import type { SchemaForm } from '../../shared/schema.ts'
import type { Translate } from '../translate.ts'
import { FONT_SIZE_BODY, FONT_SIZE_SMALL, FONT_CODE_FAMILY } from '../typography.ts'

/** View modes. */
type Mode = 'preview' | 'edit' | 'form'

/** Props: data access, copy and the active library. */
export interface SchemaViewProps extends Pick<WikiActions, 'schemaGet' | 'schemaParse' | 'schemaUpdate' | 'fsWrite'> {
  readonly t: Translate
  readonly libId: string | null
}

/**
 * Read and edit `schema.md` as raw text or as a form.
 * @param props - Data access, copy and the active library.
 * @returns The view.
 */
export function SchemaView({ schemaGet, schemaParse, schemaUpdate, fsWrite, t, libId }: SchemaViewProps): ReactElement {
  const [raw, setRaw] = useState('')
  const [form, setForm] = useState<SchemaForm | null>(null)
  const [mode, setMode] = useState<Mode>('preview')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])

  const load = useCallback(async () => {
    if (libId === null) return
    try {
      setRaw(await schemaGet(libId))
      setForm(await schemaParse(libId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [schemaGet, schemaParse, libId])

  useEffect(() => { void load() }, [load])

  const saveRaw = async (): Promise<void> => {
    if (libId === null) return
    try {
      await fsWrite(libId, 'wiki/schema.md', raw)
      setMessage(t('schema.saved'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const saveForm = async (): Promise<void> => {
    if (libId === null || form === null) return
    try {
      await schemaUpdate(libId, form)
      setRaw(await schemaGet(libId))
      setMode('preview')
      setMessage(t('schema.saved'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 6, padding: 8, borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
        {(['preview', 'edit', 'form'] as const).map(candidate => (
          <Button key={candidate} variant="ghost" size="sm" onClick={() => { setMode(candidate) }} style={{ fontWeight: mode === candidate ? 600 : 400 }} icon={candidate === 'preview' ? <IconBrowseOutlineRegular /> : candidate === 'edit' ? <IconEditOutlineRegular /> : <IconListPenOutlineRegular />}>
            {candidate === 'preview' ? t('schema.preview') : candidate === 'edit' ? t('schema.edit') : t('schema.form')}
          </Button>
        ))}
        {mode === 'edit' && <Button variant="primary" size="sm" onClick={() => { void saveRaw() }} icon={<IconCheckOutlineRegular />}>{t('wiki.save')}</Button>}
      </div>
      {(message !== null || error !== null) && (
        <div style={{ padding: '4px 12px', fontSize: FONT_SIZE_SMALL, color: error === null ? 'inherit' : 'var(--dsw-alias-state-error-primary)', opacity: error === null ? 0.7 : 1 }}>
          {error ?? message}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {mode === 'preview' && <MarkdownText text={raw} labels={labels} />}
        {mode === 'edit' && (
          <textarea
            value={raw}
            onChange={event => setRaw(event.target.value)}
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
        )}
        {mode === 'form' && form !== null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 420 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: FONT_SIZE_BODY }}>
              {t('schema.behavior')}
              <select
                value={form.conflictBehavior}
                onChange={event => setForm({ ...form, conflictBehavior: event.target.value as SchemaForm['conflictBehavior'] })}
                style={{ fontSize: FONT_SIZE_BODY, padding: '4px 6px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-specific-selector)', color: 'var(--dsw-alias-label-primary)' }}
              >
                <option value="mark">{t('schema.behavior.mark')}</option>
                <option value="reject">{t('schema.behavior.reject')}</option>
                <option value="overwrite">{t('schema.behavior.overwrite')}</option>
              </select>
            </label>
            <Checkbox
              checked={form.rawImmutability}
              onChange={next => setForm({ ...form, rawImmutability: next })}
              label={t('schema.immutable')}
            />
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: FONT_SIZE_BODY }}>
              {t('schema.pageTypes')}
              <Input
                value={form.pageTypes.join(',')}
                onChange={event => setForm({
                  ...form,
                  pageTypes: event.target.value.split(',').map(item => item.trim()).filter(item => item !== ''),
                })}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: FONT_SIZE_BODY }}>
              {t('schema.naming')}
              <Input value={form.namingConvention} onChange={event => setForm({ ...form, namingConvention: event.target.value })} />
            </label>
            <Button variant="primary" size="sm" onClick={() => { void saveForm() }} icon={<IconCheckOutlineRegular />}>{t('wiki.save')}</Button>
          </div>
        )}
      </div>
    </div>
  )
}
