/**
 * The minimal DSH surface this plugin uses.
 *
 * The plugin does not import harness packages for its types: those packages are private
 * to an installation, so importing them would make this package unbuildable outside a
 * checkout. The shapes below mirror the contracts documented by the harness; runtime
 * identity still comes from the profile, which resolves peers to the running dsh.
 */

import type { LoggerSink } from '@dsh-plugins-xz/log-utils'

/** JSON Schema subset accepted for tool parameters and tool output. */
export type JsonSchema = Record<string, unknown>

/** One text block a tool render returns to the model. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * The live agent face this plugin reads.
 *
 * `session` hangs off the agent, not off the context: the harness publishes no `session` service, and
 * reading one throws `cannot get property "session" without inject` — during prompt assembly, so it
 * fails the user's turn rather than the plugin's load. `ctx` is the agent's own context, which is the
 * only context a per-agent prompt section can be registered through.
 */
export interface Agent {
  readonly session: { readonly id: string }
  readonly ctx?: { readonly systemPrompt: SystemPromptService } | undefined
}

/** The second `execute` argument: the calling agent plus cancellation. */
export interface ToolRunContext {
  readonly agent?: Agent | undefined
  readonly signal: AbortSignal
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

/** What a slash-command handler receives. */
export interface CommandInvocation {
  readonly rawInput: string
  readonly agent?: Agent | undefined
  readonly signal: AbortSignal
}

/** What a slash-command handler returns; rendered by the adapter, never fed back to the model. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** One slash command registration. */
export interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** The slash-command registry. */
export interface CommandsService {
  register(definition: CommandDefinition): () => void
}

/** One system-prompt section; `text` may be computed per assembly. */
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
}

/** The system-prompt registry. */
export interface SystemPromptService {
  section(section: PromptSection): () => void
}

/**
 * Terminal reason a completed stream reports.
 *
 * The harness normalizes an adapter failure into a terminal `finish` chunk instead of throwing, so
 * a consumer that reads only text deltas would otherwise mistake a failed call for an empty answer.
 */
export interface LlmFinishReason {
  readonly kind: string
  /** Present only for `error` and `aborted`. */
  readonly failure?: { readonly message: string; readonly code: string }
}

/** One chunk of a streamed model response; only the fields this plugin reads are declared. */
export interface LlmStreamChunk {
  readonly type: string
  readonly text?: string
  /** Present on the terminal `finish` chunk. */
  readonly reason?: LlmFinishReason
}

/** Display metadata for one registered provider route. */
export interface LlmProviderInfo {
  readonly id: string
  readonly name: string
}

/** One model a provider advertises. */
export interface LlmModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
}

/** One visible text block; the only content block this plugin ever sends. */
export interface LlmTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Who produced a message; `plugin` is the only form this plugin sends. */
export interface LlmMessageSource {
  readonly kind: string
  readonly plugin?: string
}

/**
 * One model-facing message.
 *
 * The harness represents message content as blocks, never a bare string: the runtime walks the
 * array (and a `string` there fails at `content.some`), so the shape has to mirror it exactly.
 */
export interface LlmMessage {
  /** Stable identity; the runtime expects every message to carry one. */
  readonly id: string
  readonly role: string
  readonly content: readonly LlmTextBlock[]
  readonly source: LlmMessageSource
}

/** The model runtime, used for the optional LLM-assisted Wiki compile. */
export interface LlmService {
  stream(options: {
    readonly provider: string
    readonly model: string
    readonly messages: ReadonlyArray<LlmMessage>
    readonly maxTokens?: number
    readonly signal?: AbortSignal
  }): AsyncIterable<LlmStreamChunk>
  /** Registered provider routes, in registration order. */
  listProviders(): readonly LlmProviderInfo[]
  /** Models one provider advertises; may legitimately be empty. */
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
}

/** The deployment-wide default model selection this plugin reads. */
export interface AgentDefaultModelService {
  currentSelection(): { readonly provider: string; readonly model: string }
}

/** Context handed to the Host half's `apply`. */
export interface PluginContext {
  readonly tools: { register(definition: ToolDefinition): () => void }
  readonly logger?: LoggerSink | undefined
  effect(callback: () => (() => void) | void, label?: string): () => void
  /**
   * Register an event listener.
   *
   * `global` lifts the context filter, which session events need when they are observed from a
   * composition-level plugin rather than from the session's own context.
   */
  on(
    event: string,
    listener: (...args: any[]) => unknown,
    options?: { readonly global?: boolean },
  ): () => void
  emit(event: string, payload?: unknown): void
  inject(services: readonly string[], callback: (ctx: any) => unknown): { dispose(): Promise<void> }
}

/** Options one slot registration carries; `id` for list slots, `key` for keyed slots. */
export interface SlotOptions {
  readonly name: string
  readonly id?: string
  readonly key?: string
  readonly order?: number
  readonly label?: string | (() => string)
  readonly locale?: string
  readonly inject?: () => unknown
}

/** Context handed to the browser half's `apply`. */
export interface ClientContext {
  effect(callback: () => (() => void) | void, label?: string): () => void
  /**
   * Run `callback` against a context that carries the named client services, once they exist.
   *
   * The browser half takes the web app's directory picker this way: the service lives in the
   * running client, so this package must not import it from a harness package to name it.
   */
  inject(services: readonly string[], callback: (ctx: any) => (() => void) | void): { dispose(): Promise<void> }
  readonly locale: {
    register(
      namespace: string,
      dictionaries: { readonly zh: Record<string, string>; readonly en: Record<string, string> },
    ): () => void
  }
  readonly slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: SlotOptions, component: unknown): () => void
  }
}
