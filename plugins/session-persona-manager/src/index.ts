/**
 * Host half: the persona catalog, the model-facing tool, the per-session system-prompt
 * section, and the authenticated `/api` routes the browser half reads.
 *
 * Everything the browser half sends or receives crosses Connection's Fetch routes, so
 * the browser-trust fence and the session cookie apply exactly as they do for the
 * shipped Web plugins. Registering `/api/...` on `ctx.webServer` instead would bypass
 * that fence, which is why this plugin never touches the raw webserver.
 * @module session-persona-manager
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { PersonaStore, type Persona } from './store.ts'
import type { PluginContext, ToolDefinition } from './types.ts'
import { createLogger, type Logger } from '@dsh-plugins-xz/log-utils'
import { ResultCode, reply } from '@dsh-plugins-xz/result-utils'

/** Stable Cordis plugin name; also the row id in `cordis.patch.yml`. */
export const name = 'session-persona-manager'

/** Only the tool registry is required: the Web channel attaches when `connection` exists. */
export const inject = ['tools']

/**
 * Minimum host release this build supports. Injected at build time from the
 * `@deepseek-ai/dsh` peer floor in `package.json`, which keeps one source of truth:
 * raising the floor is a manifest edit, and a newer host needs no plugin change at all.
 */
export const MINIMUM_HOST_VERSION = __MINIMUM_HOST_VERSION__

/** Route prefix owned by this plugin, below Connection's authenticated `/api`. */
const ROUTE_PREFIX = '/api/session-persona-manager'

/** Prompt section this plugin owns for one agent. */
const SECTION_NAME = 'session-persona-manager:persona'

/** Personas this plugin may seed when no document exists yet. */
const PERSONA_TOOL = 'manage_session_persona'

/** JSON body accepted by the session-assignment route. */
interface AssignBody {
  sessionId?: unknown
  personaId?: unknown
}

/** Project a persona to the browser-visible view. */
function view(persona: Persona): { id: string; name: string; content: string } {
  return { id: persona.id, name: persona.name, content: persona.content }
}

/** Numeric release line of a version, or undefined when it is not `major.minor.patch`. */
function releaseLine(version: string): readonly [number, number, number] | undefined {
  const core = version.split('-', 1)[0] ?? ''
  const parts = core.split('.').map(part => Number(part))
  const [major, minor, patch] = parts
  if (parts.length < 3 || major === undefined || minor === undefined || patch === undefined) return undefined
  if (![major, minor, patch].every(part => Number.isInteger(part) && part >= 0)) return undefined
  return [major, minor, patch]
}

/** Compare two release lines; negative when `left` precedes `right`. */
function compareReleases(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return (left[0] - right[0]) || (left[1] - right[1]) || (left[2] - right[2])
}

/** Read the host's own dsh version, or undefined when this installation exposes it nowhere. */
function hostVersion(): string | undefined {
  const probes = [
    (): string => createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'),
    (): string => dshHomePath('profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  for (const probe of probes) {
    try {
      const manifest = JSON.parse(readFileSync(probe(), 'utf8')) as { version?: unknown }
      if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
    } catch {
      // Probe miss: try the next location rather than failing the whole activation.
    }
  }
  return undefined
}

/**
 * Refuse to activate on a host older than the supported floor.
 *
 * A profile installs plugins with `autoInstallPeers: false` and links them by path, so an
 * unmet `peerDependencies` range is never reported by the package manager — the only place a
 * too-old host can be caught is here. Newer hosts are accepted without a plugin change: the
 * check compares release lines and rejects only a host below {@link MINIMUM_HOST_VERSION}.
 * @param log - Diagnostics sink for the unreadable-version notice.
 * @throws when the host reports a release line older than the supported floor.
 */
function assertHostVersion(log: Logger): void {
  const actual = hostVersion()
  if (actual === undefined) {
    log.warn(`host dsh version unreadable; this build requires dsh >= ${MINIMUM_HOST_VERSION}`)
    return
  }
  const host = releaseLine(actual)
  const floor = releaseLine(MINIMUM_HOST_VERSION)
  if (host === undefined || floor === undefined || compareReleases(host, floor) >= 0) return
  throw new Error(
    `${name}: host dsh ${actual} is older than the supported ${MINIMUM_HOST_VERSION}; `
    + 'upgrade the host, or install a plugin build for that host',
  )
}

/**
 * Build the model-facing tool over one store.
 * @param store - Persona catalog backing the tool.
 * @returns The tool definition `ctx.tools.register` accepts.
 */
function personaTool(store: PersonaStore): ToolDefinition {
  return {
    name: PERSONA_TOOL,
    description: 'Inspect or change the persona bound to the current session. '
      + 'Actions: "list" returns every defined persona, "get" returns the current session persona, '
      + '"set" binds one persona to the current session by id. Changing the persona does not '
      + 'rewrite the prompt of the running turn; it applies from the next request.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'list'],
          description: 'Operation to perform.',
        },
        personaId: {
          type: 'string',
          description: 'Persona id to bind; required for action "set".',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec): Promise<string> {
      const input = args as { action?: string; personaId?: string }
      if (input.action === 'list') {
        return store.list().map(persona => `- [${persona.id}] ${persona.name}`).join('\n')
      }
      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) {
        throw new Error(`${PERSONA_TOOL} requires an owning agent session`)
      }
      if (input.action === 'set') {
        const personaId = input.personaId
        if (personaId === undefined) throw new Error(`${PERSONA_TOOL} action "set" requires personaId`)
        const bound = store.assign(sessionId, personaId)
        return bound === undefined
          ? `Unknown persona ${JSON.stringify(personaId)}. Use action "list" to see the defined ids.`
          : `Session persona set to ${bound.name} (${bound.id}); it applies from the next request.`
      }
      const current = store.forSession(sessionId)
      return current === undefined
        ? 'This session uses the default persona.'
        : `This session uses persona ${current.name} (${current.id}).`
    },
  }
}

/**
 * Register the persona tool, the per-agent prompt section, and the browser routes.
 * @param ctx - Host context carrying the tool registry, and `connection` on Web surfaces.
 */
export function apply(ctx: PluginContext): void {
  const log: Logger = createLogger(name, { sink: ctx.logger })
  assertHostVersion(log)
  const store = new PersonaStore()

  ctx.effect(() => ctx.tools.register(personaTool(store)), `${name}: ${PERSONA_TOOL}`)

  ctx.on('agent/created', ({ agent }) => {
    // Registered through the agent's own context: the agent owns the section's lifetime, so it
    // disappears with that agent instead of leaking into the process-wide prompt. The text is a
    // live reader, so a persona bound mid-session reaches the next assembly of this agent's
    // prompt; an empty string while nothing is bound keeps the section out of that prompt.
    agent.ctx.systemPrompt.section({
      name: SECTION_NAME,
      // A fixed order keeps this section after the tool guidance the harness owns; an
      // out-of-tree plugin cannot address the harness's internal order table.
      order: 40,
      text: () => store.forSession(agent.session.id)?.content ?? '',
    })
  })

  ctx.inject(['connection'], (webCtx) => {
    webCtx.effect(() => webCtx.connection.fetch.register({
      path: `${ROUTE_PREFIX}/personas`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'POST') {
          return reply(ResultCode.OK, 'ok', store.list().map(view))
        }
        const body = await request.json() as {
          op?: unknown
          id?: unknown
          name?: unknown
          content?: unknown
        }
        switch (body.op) {
          case 'create': {
            if (typeof body.name !== 'string' || typeof body.content !== 'string') {
              return reply(ResultCode.PARAM_ERR, 'name and content are required')
            }
            try {
              return reply(ResultCode.OK, 'ok', view(store.create(body.name, body.content)))
            } catch (reason) {
              return reply(ResultCode.EXCEPTION, reason instanceof Error ? reason.message : String(reason))
            }
          }
          case 'update': {
            if (typeof body.id !== 'string' || typeof body.name !== 'string' || typeof body.content !== 'string') {
              return reply(ResultCode.PARAM_ERR, 'id, name and content are required')
            }
            const updated = store.update(body.id, body.name, body.content)
            return updated === undefined
              ? reply(ResultCode.FAIL, `unknown or reserved persona: ${body.id}`)
              : reply(ResultCode.OK, 'ok', view(updated))
          }
          case 'delete': {
            if (typeof body.id !== 'string') {
              return reply(ResultCode.PARAM_ERR, 'id is required')
            }
            const ok = store.remove(body.id)
            return ok
              ? reply(ResultCode.OK, 'ok')
              : reply(ResultCode.FAIL, `unknown or reserved persona: ${body.id}`)
          }
          default:
            return reply(ResultCode.PARAM_ERR, 'unknown op')
        }
      },
    }), `${name}: GET|POST ${ROUTE_PREFIX}/personas`)

    webCtx.effect(() => webCtx.connection.fetch.register({
      path: `${ROUTE_PREFIX}/session`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const url = new URL(request.url)
        const body = request.method === 'POST'
          ? await request.json() as AssignBody
          : {} as AssignBody
        const sessionId = request.method === 'POST' ? body.sessionId : url.searchParams.get('sessionId')
        if (typeof sessionId !== 'string' || sessionId === '') {
          return reply(ResultCode.PARAM_ERR, 'sessionId is required')
        }
        if (request.method === 'GET') {
          const current = store.forSession(sessionId)
          return reply(ResultCode.OK, 'ok', current === undefined ? null : view(current))
        }
        if (typeof body.personaId !== 'string' || body.personaId === '') {
          return reply(ResultCode.PARAM_ERR, 'personaId is required')
        }
        const bound = store.assign(sessionId, body.personaId)
        return bound === undefined
          ? reply(ResultCode.FAIL, `unknown persona: ${body.personaId}`)
          : reply(ResultCode.OK, 'ok', view(bound))
      },
    }), `${name}: GET|POST ${ROUTE_PREFIX}/session`)
  })
}
