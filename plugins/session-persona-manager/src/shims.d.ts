/**
 * Type shims for the harness packages this plugin imports at runtime.
 *
 * They resolve from the profile at run time (`$DSH_HOME/profiles/node_modules`), so the
 * package needs no install-time dependency on the harness checkout.
 */
/**
 * Minimum supported host release, injected by `packages/plugin-kit/build-plugin.mjs` from the
 * `@deepseek-ai/dsh` peer floor in `package.json`.
 */
declare const __MINIMUM_HOST_VERSION__: string

declare module '@deepseek-ai/dsh-home-paths' {
  /**
   * Join path segments under the Harness home (`$DSH_HOME`, default `~/.dsh`).
   * @param segments - Path segments below the home.
   * @returns The absolute path.
   */
  export function dshHomePath(...segments: string[]): string
}

/**
 * Minimal surface of `@deepseek-ai/dsh-client-ui-primitives` this plugin renders with.
 *
 * The package is a baseline platform module (resolved by the browser module table at run
 * time, not installed into this workspace), so only the props this plugin actually passes
 * are declared here. Styling comes entirely from the primitive's own `--dsw-*` tokens,
 * which is what keeps the persona control consistent with the rest of the UI.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, InputHTMLAttributes, ReactElement, ReactNode } from 'react'

  /** Button visual family; this plugin uses `toolbar` for header actions. */
  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

  /** One primary-menu entry: a selectable row, a separator, or a heading label. */
  export type MenuEntry =
    | { id: string; label: ReactNode; disabled?: boolean; icon?: ReactNode; danger?: boolean }
    | { type: 'separator'; id: string }
    | { type: 'label'; id: string; text: string }

  /** Token-styled button atom. */
  export function Button(
    props: ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: ButtonVariant
      size?: 'md' | 'sm'
      icon?: ReactNode
      className?: string | undefined
    },
  ): ReactElement

  /** Anchored dropdown menu, owner-controlled for open state and selection. */
  export function Menu(props: {
    open: boolean
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    selectedId?: string | undefined
    selectedIds?: readonly string[] | undefined
    onClose: () => void
    onSelect: (id: string) => void
    anchor: ReactNode
    items: readonly MenuEntry[]
    footer?: readonly MenuEntry[] | undefined
    className?: string | undefined
    /** Render the list into document.body with fixed positioning (escapes ancestor overflow/stacking). */
    portal?: boolean
  }): ReactElement

  /** Centered, body-portaled modal with a mask; used for the persona manager. */
  export function Modal(props: {
    open: boolean
    onClose: () => void
    title: string
    closeLabel: string
    description?: string | undefined
    children?: ReactNode
    footer?: ReactNode
    className?: string | undefined
    contentClassName?: string | undefined
  }): ReactElement

  /** Single-line text input atom (persona name). */
  export function Input(
    props: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode; className?: string | undefined },
  ): ReactElement

  /** Outline icon set used by the manager's add/edit/delete actions. */
  export const IconPlusOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconEditOutlineRegular: ComponentType<{ size?: number; className?: string }>
  export const IconTrashOutlineRegular: ComponentType<{ size?: number; className?: string }>
}
