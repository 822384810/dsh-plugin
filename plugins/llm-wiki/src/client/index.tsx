/**
 * Browser half: one entry in the global panel list and the panel it opens.
 *
 * The browser module table owns React and the slot registry, so this bundle imports them
 * through the loader's `require` instead of bundling a second copy. Data crosses the Host
 * half's authenticated `/api/llm-wiki` route.
 * @module llm-wiki/client
 */
import { createWikiActions } from './api.ts'
import { en, NS, zh } from './locales.ts'
import { WikiPanel } from './components/WikiPanel.tsx'
import { WikiPanelIcon } from './components/WikiPanelIcon.tsx'
import type { ClientContext } from '../types.ts'

/** Stable browser-half plugin name. */
export const name = 'llm-wiki-client'

/** Browser services this half needs: the slot registry and the locale service. */
export const inject = ['slots', 'locale']

/** Main-panel key; the sidebar entry's id must match it for the shell to dispatch here. */
const PANEL_ID = 'llm-wiki'

/**
 * Register the panel entry and its sidebar icon.
 * @param ctx - Browser context carrying the slot registry and locale service.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${name}: dictionaries`)
  const actions = createWikiActions()

  // The directory picker belongs to the web app, not to this plugin: take it when the running
  // client mounts one, so "New Knowledge Base" can browse for the root as well as type it.
  ctx.inject(['uiWorkspace'], workspaceCtx => {
    const workspace = workspaceCtx.uiWorkspace as { pickDirectory(): Promise<string | null> }
    workspaceCtx.effect(() => {
      const previous = actions.pickDirectory
      actions.pickDirectory = async () => await workspace.pickDirectory()
      return () => { actions.pickDirectory = previous }
    }, `${name}: directory picker`)
  })

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 100,
    label: () => zh['menu.title'],
    locale: NS,
  }, WikiPanelIcon))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => actions,
  }, WikiPanel))
}
