/**
 * Browser half: one entry in the session header that binds a persona to this session.
 *
 * The browser module table owns React and the UI slot registry, so this bundle imports
 * them through the loader's `require` instead of bundling a second copy. Data crosses
 * the Host half's authenticated `/api/session-persona-manager` routes.
 * @module session-persona-manager/client
 */
import { PersonaBar, type PersonaBarInjected, type PersonaView } from './PersonaBar.tsx'
import { en, NS, zh } from './locales.ts'
import type { ClientContext } from '../types.ts'
import { unwrap } from '@dsh-plugins-xz/result-utils'

/** Stable browser-half plugin name. */
export const name = 'session-persona-manager-client'

/** Browser services this half needs: the slot registry and the locale service. */
export const inject = ['slots', 'locale']

/** Route prefix owned by the Host half. */
const ROUTE_PREFIX = '/api/session-persona-manager'

/** Slot this half fills: a list entry in the session header, scoped to one session. */
const SLOT = 'conversation.session.header.actions'

/** Transport for the persona panel; created once so component props stay referentially stable. */
function personaActions(): PersonaBarInjected {
  return {
    async list(): Promise<PersonaView[]> {
      return (await unwrap<PersonaView[]>(await fetch(`${ROUTE_PREFIX}/personas`))) ?? []
    },
    async current(sessionId: string): Promise<PersonaView | null> {
      const query = new URLSearchParams({ sessionId })
      return (await unwrap<PersonaView | null>(await fetch(`${ROUTE_PREFIX}/session?${query.toString()}`))) ?? null
    },
    async assign(sessionId: string, personaId: string): Promise<PersonaView | null> {
      return (await unwrap<PersonaView | null>(await fetch(`${ROUTE_PREFIX}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, personaId }),
      }))) ?? null
    },
    async create(name: string, content: string): Promise<PersonaView> {
      const persona = await unwrap<PersonaView>(await fetch(`${ROUTE_PREFIX}/personas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'create', name, content }),
      }))
      if (persona === null) throw new Error('create failed')
      return persona
    },
    async update(id: string, name: string, content: string): Promise<PersonaView> {
      const persona = await unwrap<PersonaView>(await fetch(`${ROUTE_PREFIX}/personas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'update', id, name, content }),
      }))
      if (persona === null) throw new Error('update failed')
      return persona
    },
    async remove(id: string): Promise<void> {
      await unwrap<null>(await fetch(`${ROUTE_PREFIX}/personas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'delete', id }),
      }))
    },
  }
}

/**
 * Register the persona entry.
 * @param ctx - Browser context carrying the slot registry and locale service.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${name}: dictionaries`)
  const actions = personaActions()
  ctx.slots.inject(SLOT, () => ctx.slots.register({
    name: SLOT,
    id: 'session-persona-manager',
    order: 30,
    locale: NS,
    inject: () => actions,
  }, PersonaBar))
}
