/**
 * Model-selection vocabulary shared by both halves.
 *
 * The panel picks the model that compiles one library's Wiki, so the Host has to describe what
 * is selectable and the browser has to render exactly that description; keeping the shapes in one
 * module is what stops the two drifts apart.
 */

/** One provider and model pair, in the form the model runtime is called with. */
export interface ModelRef {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** One selectable model. */
export interface ModelOption {
  readonly id: string
  readonly name: string
}

/** Models grouped under one provider route. */
export interface ModelGroup {
  /** Provider route key. */
  readonly id: string
  /** Display name for the group. */
  readonly name: string
  readonly models: readonly ModelOption[]
}

/** A provider whose model list could not be read. */
export interface ModelFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/** Everything the panel needs to render the selector. */
export interface ModelCatalog {
  /** The deployment's current default selection, when one is available. */
  readonly default: ModelRef | null
  /** Selectable models, grouped by provider, in registration order. */
  readonly groups: readonly ModelGroup[]
  /** Providers that could not be listed, so a failure is never silently hidden. */
  readonly failures: readonly ModelFailure[]
}

/** A catalog scoped to one library: also says what that library compiles with today. */
export interface ModelCatalogView extends ModelCatalog {
  /** The model in effect for the scoped library; null when nothing is resolvable. */
  readonly selected: ModelRef | null
}
