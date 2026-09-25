/**
 * Where the model the Wiki compiler uses comes from.
 *
 * Each library may pick its own model. One that has not picked follows the deployment default
 * (`agentDefaultModel`), and the plugin's own `compileProvider` / `compileModel` config still
 * wins, so an existing deployment keeps the route it explicitly named.
 *
 * Both host services are optional and attached lazily: without `llm` there is nothing to stream
 * with, and the compiler falls back to its deterministic page rather than failing.
 */
import { randomUUID } from 'node:crypto'
import type { AgentDefaultModelService, LlmFinishReason, LlmMessage, LlmProviderInfo, LlmService } from '../types.ts'
import type { ModelCatalog, ModelFailure, ModelGroup, ModelRef } from '../shared/models.ts'

/** Holds the optional model runtime and default-selection services, and reads both. */
export class ModelDirectory {
  private llm: LlmService | null = null
  private defaults: AgentDefaultModelService | null = null

  /**
   * Bind the model runtime.
   * @param llm - The host's `llm` service.
   * @returns A disposer that detaches it.
   */
  attachLlm(llm: LlmService): () => void {
    this.llm = llm
    return () => { this.llm = null }
  }

  /**
   * Bind the deployment default-selection service.
   * @param service - The host's `agentDefaultModel` service.
   * @returns A disposer that detaches it.
   */
  attachDefaults(service: AgentDefaultModelService): () => void {
    this.defaults = service
    return () => { this.defaults = null }
  }

  /** Whether a model runtime is mounted, i.e. whether a completion can be attempted. */
  get ready(): boolean {
    return this.llm !== null
  }

  /**
   * The deployment's current default selection.
   * @returns The provider and model, or null when the service is absent or unusable.
   */
  defaultSelection(): ModelRef | null {
    try {
      const selection = this.defaults?.currentSelection()
      if (selection === undefined || selection.provider === '' || selection.model === '') return null
      return { provider: selection.provider, model: selection.model }
    } catch {
      // A host that exposes the service but rejects the read must not break the panel.
      return null
    }
  }

  /**
   * Every provider's selectable models, plus the deployment default.
   * @returns The catalog; empty groups when no runtime is mounted.
   */
  async catalog(): Promise<ModelCatalog> {
    const llm = this.llm
    const empty: ModelCatalog = { default: this.defaultSelection(), groups: [], failures: [] }
    if (llm === null) return empty
    let providers: readonly LlmProviderInfo[]
    try {
      providers = llm.listProviders()
    } catch {
      return empty
    }
    // Read every provider concurrently, then fold the results back in registration order so the
    // selector's group order does not depend on which provider answered first.
    const entries = await Promise.all(providers.map(async (provider): Promise<{ group: ModelGroup | null; failure: ModelFailure | null }> => {
      const label = provider.name === '' ? provider.id : provider.name
      try {
        const models = await llm.listModels(provider.id)
        return {
          group: {
            id: provider.id,
            name: label,
            models: models.map(model => ({ id: model.id, name: model.name === '' ? model.id : model.name })),
          },
          failure: null,
        }
      } catch (error) {
        return { group: null, failure: { id: provider.id, name: label, message: String(error) } }
      }
    }))
    const groups: ModelGroup[] = []
    const failures: ModelFailure[] = []
    for (const entry of entries) {
      if (entry.group !== null) groups.push(entry.group)
      if (entry.failure !== null) failures.push(entry.failure)
    }
    return { default: this.defaultSelection(), groups, failures }
  }

  /**
   * Stream one completion and assemble its text.
   * @param provider - Provider route.
   * @param model - Model id.
   * @param prompt - Prompt to send.
   * @param maxTokens - Output ceiling.
   * @returns The assembled text.
   * @throws when no runtime is mounted, or when the call ended on anything but a normal stop.
   */
  async complete(provider: string, model: string, prompt: string, maxTokens: number): Promise<string> {
    const llm = this.llm
    if (llm === null) throw new Error('no model runtime available')
    // Content is a block array, and every message carries an id and a source: that is the shape the
    // runtime walks and the adapters translate.
    const messages: LlmMessage[] = [{
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'llm-wiki' },
    }]
    let text = ''
    let finish: LlmFinishReason | null = null
    for await (const chunk of llm.stream({ provider, model, messages, maxTokens })) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason !== undefined) finish = chunk.reason
    }
    const failure = finishError(finish)
    if (failure !== null) throw failure
    return text
  }
}

/**
 * Translate a terminal finish reason into an error.
 *
 * Without this a failed call is reported one layer up as "the model returned no plan", which hides
 * the real cause — an auth or routing failure, an aborted call, or output cut off at `maxTokens`.
 * @param finish - The reason on the terminal chunk, when there was one.
 * @returns The error to throw, or null for a normal stop.
 */
function finishError(finish: LlmFinishReason | null): Error | null {
  if (finish === null) return null
  switch (finish.kind) {
    case 'stop': return null
    case 'tool-calls': return new Error('model returned a tool call instead of text')
    case 'max-tokens': return new Error('model output reached maxTokens and was truncated')
    case 'error':
    case 'aborted': return new Error(finish.failure?.message ?? `model call ${finish.kind}`)
    default: return new Error(`model call ended with "${finish.kind}"`)
  }
}
