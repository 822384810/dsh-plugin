/**
 * Translation helper.
 *
 * The slot framework passes a `t` built from the registered dictionaries, but a plugin must
 * not depend on a host that hands one over: when it is missing the Chinese dictionary is used
 * directly, so the panel is never a wall of raw keys.
 */
import { zh, type WikiKey } from './locales.ts'

/** Render one translation key. */
export type Translate = (key: WikiKey) => string

/**
 * Wrap the framework's translator, falling back to the bundled dictionary.
 * @param t - Translator supplied by the slot framework, when present.
 * @returns A translator that always yields text.
 */
export function translator(t: ((key: WikiKey) => string) | undefined): Translate {
  return (key: WikiKey): string => {
    try {
      const value = t?.(key)
      if (typeof value === 'string' && value !== '') return value
    } catch {
      // A missing namespace or key must not break the render.
    }
    return zh[key]
  }
}

/**
 * Substitute `{n}` placeholders.
 * @param t - Translator.
 * @param key - Key with placeholders.
 * @param values - Replacement values.
 * @returns The rendered string.
 */
export function template(t: Translate, key: WikiKey, values: Readonly<Record<string, string | number>>): string {
  return t(key).replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match))
}
