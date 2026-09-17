/**
 * The minimal DSH surface this plugin uses. Kept local for the same reason as the workspace's
 * other plugins: harness packages are private to an installation, so importing their types
 * would make this package unbuildable outside a checkout.
 */

/** The model request the agent loop hands to a provider, as `llm/stream` observers see it. */
export interface LlmRequest {
  /** Provider id the request is dispatched to. */
  readonly provider?: string
  /** Model id the request is dispatched to. */
  readonly model?: string
  /** Session the request belongs to. */
  readonly sessionId?: string
  /** Assembled system prompt, when the loop produced one. */
  readonly system?: string
  /** Exact message list sent to the model. */
  readonly messages?: readonly unknown[]
  /** Tool schemas offered with this request. */
  readonly tools?: readonly unknown[]
  /** Other request fields; copied verbatim into the trace. */
  readonly [key: string]: unknown
}

/** Context handed to the plugin's `apply`. */
export interface PluginContext {
  effect(callback: () => (() => void) | void, label?: string): () => void
  /**
   * Observe one model request before dispatch. The listener must return `next()` to delegate;
   * returning anything else would short-circuit the provider call.
   */
  on(
    event: 'llm/stream',
    listener: (request: LlmRequest, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>,
  ): () => void
}
