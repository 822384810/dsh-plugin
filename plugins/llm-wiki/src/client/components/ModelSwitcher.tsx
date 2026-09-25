/** Per-library choice of the model that compiles the Wiki. */
import { useEffect, useState, type ReactElement } from 'react'
import type { ModelCatalogView } from '../../shared/models.ts'
import type { WikiActions } from '../api.ts'
import type { Translate } from '../translate.ts'
import { FONT_SIZE_BODY } from '../typography.ts'

/** Props: the model actions, copy, and the library being configured. */
export interface ModelSwitcherProps extends Pick<WikiActions, 'modelCatalog' | 'setCompileModel'> {
  readonly t: Translate
  readonly activeId: string | null
}

/** Encode a provider and model as one `<option>` value. */
function encode(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/** Decode an `<option>` value back into its provider and model. */
function decode(value: string): { provider: string; model: string } {
  const separator = value.indexOf('\u0000')
  if (separator < 0) return { provider: value, model: '' }
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) }
}

/**
 * Pick the model one library compiles with.
 *
 * The control defaults to whatever the library compiles with today — its own choice, the plugin's
 * configured route, or the deployment default — so it always reflects reality instead of opening
 * empty.
 * @param props - Model actions, copy and the active library.
 * @returns The selector, styled like the library switcher beside it.
 */
export function ModelSwitcher({ modelCatalog, setCompileModel, t, activeId }: ModelSwitcherProps): ReactElement {
  const libId = activeId === null || activeId === '' ? null : activeId
  const [catalog, setCatalog] = useState<ModelCatalogView | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (libId === null) {
      setCatalog(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const next = await modelCatalog(libId)
        if (!cancelled) setCatalog(next)
      } catch (reason) {
        if (!cancelled) {
          setCatalog(null)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [libId, modelCatalog])

  const choose = async (value: string): Promise<void> => {
    if (libId === null || value === '') return
    const selection = decode(value)
    if (selection.model === '') return
    setBusy(true)
    setError(null)
    try {
      await setCompileModel(libId, selection.provider, selection.model)
      setCatalog(current => (current === null ? current : { ...current, selected: selection }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const groups = catalog?.groups ?? []
  const selected = catalog?.selected ?? null
  const value = selected === null ? '' : encode(selected.provider, selected.model)
  // A route the catalog no longer advertises (a provider that stopped listing it, or one that
  // failed discovery) still has to be visible — otherwise the control looks unset even though
  // compilation uses it.
  const advertised = new Set(groups.flatMap(group => group.models.map(model => encode(group.id, model.id))))
  const orphan = selected !== null && !advertised.has(value) ? selected : null
  const disabled = libId === null || loading || busy || groups.length === 0
  const title = error ?? (groups.length === 0 && !loading ? t('model.unavailable') : t('model.title'))

  return (
    <select
      aria-label={t('model.label')}
      title={title}
      value={value}
      disabled={disabled}
      onChange={event => { void choose(event.target.value) }}
      style={{
        flex: '1 1 160px',
        minWidth: 0,
        maxWidth: 300,
        fontSize: FONT_SIZE_BODY,
        padding: '4px 6px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-specific-selector)',
        color: error === null ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-state-error-primary)',
        opacity: disabled && !loading ? 0.6 : 1,
      }}
    >
      {value === '' && <option value="">{loading ? t('model.loading') : t('model.select')}</option>}
      {orphan !== null && <option value={value}>{`${orphan.provider} / ${orphan.model}`}</option>}
      {groups.map(group => (
        <optgroup key={group.id} label={group.name}>
          {group.models.map(model => (
            <option key={encode(group.id, model.id)} value={encode(group.id, model.id)}>{model.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
