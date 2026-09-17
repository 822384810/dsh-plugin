/**
 * The minimal DSH surface this plugin uses.
 *
 * The plugin does not import harness packages for its types: those packages are private
 * to an installation, so importing them would make this package unbuildable outside a
 * checkout. The shapes below mirror the contracts documented by the harness; runtime
 * identity still comes from the profile, which resolves peers to the running dsh.
 */

/** JSON Schema subset accepted for tool parameters and tool output. */
export type JsonSchema = Record<string, unknown>

/** The second `execute` argument: the calling agent plus cancellation. */
export interface ToolRunContext {
  readonly agent?: Agent | undefined
  readonly signal: AbortSignal
}

/** One text block a tool render returns to the model. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Model-visible tool definition, in the compiled (JSON Schema) form `ctx.tools.register` accepts. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly output: {
    readonly schema: JsonSchema
    readonly render: (args: unknown, value: unknown) => readonly TextBlock[]
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

/** One system-prompt section; `text` may be computed per assembly scope. */
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: { readonly scope?: unknown }) => string)
}

/** The live agent face this plugin reads: its session id and its scoped services. */
export interface Agent {
  readonly session: { readonly id: string }
  readonly ctx: {
    readonly systemPrompt: { section(section: PromptSection): () => void }
  }
}

/** An exact Fetch route registered inside Connection's authenticated `/api` fence. */
export interface FetchRoute {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}

/** Connection's Fetch-route registry, present only where the web surface is composed. */
export interface ConnectionService {
  readonly fetch: { register(route: FetchRoute): () => void }
}

/** Context handed to the Host half's `apply`. */
export interface PluginContext {
  readonly tools: { register(definition: ToolDefinition): () => void }
  effect(callback: () => (() => void) | void, label?: string): () => void
  on(event: 'agent/created', listener: (payload: { readonly agent: Agent }) => unknown): () => void
  inject(
    services: readonly string[],
    callback: (ctx: PluginContext & { readonly connection: ConnectionService }) => unknown,
  ): { dispose(): Promise<void> }
}

/** Options one slot registration carries. */
export interface SlotOptions {
  readonly name: string
  readonly id: string
  readonly order: number
  readonly locale: string
  readonly inject: () => unknown
}

/** Context handed to the browser half's `apply`. */
export interface ClientContext {
  effect(callback: () => (() => void) | void, label?: string): () => void
  readonly locale: {
    register(namespace: string, dictionaries: { readonly zh: Record<string, string>; readonly en: Record<string, string> }): () => void
  }
  readonly slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: SlotOptions, component: unknown): () => void
  }
}
