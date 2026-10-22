/**
 * The model layer's vocabulary.
 *
 * **This is the second layer.** The first layer cloned the pinned target's
 * behaviour; this layer is our own product, and the specification it answers to
 * is [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md).
 *
 * Everything here is **data**. There is no code in this repository that asks
 * what a particular model id contains, and no code that knows how any endpoint
 * spells a reasoning effort: the spelling belongs to the catalogue, and the
 * catalogue is the entry below.
 *
 * The naming rule applies: where a *capability* is meant — an endpoint that
 * speaks one API shape or another — the capability is named, and no product or
 * company is named anywhere in this layer.
 */

/**
 * The API shape a provider speaks.
 *
 * The shape is a property of the provider's **path**, not of its name: a
 * provider that names a first-party shape may still be addressed as a
 * compatible one, with its own endpoint and its own credential.
 */
export type Dialect = 'chat' | 'messages' | 'responses';

/** The three shapes, in the order the specification names them. */
export const DIALECTS: readonly Dialect[] = Object.freeze(['chat', 'messages', 'responses']);

/** Whether a value names one of the three shapes. */
export function isDialect(value: unknown): value is Dialect {
  return typeof value === 'string' && (DIALECTS as readonly string[]).includes(value);
}

/**
 * A modality: what a model can take in, or give out.
 *
 * The names are the catalogue's own. A model that cannot take a modality
 * **refuses** it, in a form the user sees; it never silently drops it from the
 * request.
 */
export type Modality = 'text' | 'image' | 'audio' | 'pdf' | 'video';

/** What a model can do. */
export interface ModelCapabilities {
  /** The attachments the model takes. */
  readonly input: readonly Modality[];
  /** The attachments the model produces. */
  readonly output: readonly Modality[];
  /** Whether the model takes a temperature. */
  readonly temperature: boolean;
  /** Whether the model calls tools. */
  readonly tools: boolean;
}

/** The input and output prices. */
export interface ModelCost {
  readonly input: number;
  readonly output: number;
}

/** The context window and the output ceiling. */
export interface ModelLimits {
  readonly context?: number;
  readonly output?: number;
}

/**
 * How one overlay is spelled on one shape.
 *
 * The three channels are the overlay's whole contribution: the request
 * **fields** it sets, the **headers** it adds, and the **body** it adds.
 */
export interface OverlaySpelling {
  /** The request's top-level parameters this overlay sets. */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** The headers this overlay adds. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The body fragment this overlay adds. */
  readonly body?: Readonly<Record<string, unknown>>;
}

/** The members every overlay carries. */
export interface OverlayBase {
  /** The name the user selects. */
  readonly name: string;
  /**
   * The spelling, **per shape**.
   *
   * The spelling of an overlay belongs to the model *and* the shape together,
   * so the overlays are re-spelled whenever the effective shape changes. A
   * shape with no spelling here means the model does not offer the overlay on
   * that shape.
   */
  readonly spellings: Partial<Record<Dialect, OverlaySpelling>>;
}

/** An overlay that sets the effort a model should spend. */
export interface EffortOverlay extends OverlayBase {
  readonly kind: 'effort';
  /** The level this overlay sets. */
  readonly effort: string;
}

/** An overlay that turns a behaviour on or off — a thinking toggle. */
export interface ToggleOverlay extends OverlayBase {
  readonly kind: 'toggle';
  /** The state this overlay sets. */
  readonly enabled: boolean;
}

/** An overlay that caps the tokens a reasoning step may spend. */
export interface BudgetOverlay extends OverlayBase {
  readonly kind: 'budget_tokens';
  /** The cap this overlay sets. */
  readonly tokens: number;
}

/** An overlay the user defines, carrying any request fields, headers or body. */
export interface NamedOverlay extends OverlayBase {
  readonly kind: 'named';
}

/** The four overlay kinds. */
export type Overlay = EffortOverlay | ToggleOverlay | BudgetOverlay | NamedOverlay;

/** The effort ladder a model offers. */
export interface EffortSupport {
  readonly values: readonly string[];
}

/** The token budget a model offers. */
export interface BudgetSupport {
  readonly min?: number;
  readonly max?: number;
}

/**
 * The **support kinds** a model offers: an effort, a toggle, a token budget.
 *
 * This is the model's declaration of what it can do; the overlays below are
 * the concrete instances of those kinds.
 */
export interface ReasoningSupport {
  readonly effort?: EffortSupport;
  readonly toggle?: boolean;
  readonly budget?: BudgetSupport;
}

/**
 * One model, as the catalogue records it.
 *
 * The fields are the specification's: the identity, the owning provider, the
 * capabilities, the cost, the limits, the overlays and the reasoning support.
 */
export interface ModelEntry {
  /** The model's own name, as the provider writes it. */
  readonly id: string;
  /** The provider it belongs to. */
  readonly provider: string;
  /** What it can do. */
  readonly capabilities: ModelCapabilities;
  /** The input and output prices. */
  readonly cost?: ModelCost;
  /** Its context window and its output ceiling. */
  readonly limits?: ModelLimits;
  /** The named overlays this model offers. */
  readonly overlays: readonly Overlay[];
  /** The support kinds it offers. */
  readonly reasoning: ReasoningSupport;
  /**
   * Whether the model is offered at all.
   *
   * **Implementation choice.** The specification's table of the model entry's
   * fields does not carry this one, but a model must be able to become
   * *unavailable* — and "a model that has become unavailable" is one of the
   * failures this layer has to degrade with. A local override that turns a
   * model off sets this to `false`, and the model then stays in the catalogue
   * but is never selected.
   */
  readonly enabled: boolean;
}

/**
 * A reference to a secret. **Never the secret.**
 *
 * A provider names an *integration*, and the integration names the credential.
 * The provider record has no secret field, ever.
 */
export type CredentialReference =
  | { readonly kind: 'integration'; readonly integration: string }
  | { readonly kind: 'none' };

/**
 * One provider, as an entry of data.
 *
 * Adding a provider is adding an entry and a module. It is never editing a
 * registry, and never a branch in the engine: there is exactly one code path
 * per **shape**, and a provider's own quirks live in this entry.
 */
export interface ProviderEntry {
  /** The provider's own name, the one the user types. */
  readonly id: string;
  /** Which API shape it speaks. */
  readonly dialect: Dialect;
  /** The base URL, and the path shape. */
  readonly endpoint: string;
  /** A reference to a secret, never the secret. */
  readonly credential: CredentialReference;
  /** The extra headers the endpoint wants, if any. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The catalogue entries that belong to this provider. */
  readonly models: readonly ModelEntry[];
  /**
   * The provider whose whole definition this one aliases.
   *
   * An alias changes **only** the endpoint and the credential; its models,
   * capabilities, cost, limits and overlay spellings are the canonical
   * provider's.
   */
  readonly aliasOf?: string;
}

/** One provider's catalogue entry. */
export interface ProviderCatalogueEntry {
  readonly provider: string;
  readonly models: readonly ModelEntry[];
}

/** A catalogue document: the providers, and their models. */
export interface CatalogueDocument {
  readonly providers: readonly ProviderCatalogueEntry[];
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** One part of a message's content. */
export interface ContentPart {
  readonly type: Modality;
  /** The text, for a text part. */
  readonly text?: string;
  /** The payload, base64-encoded, for an attachment. */
  readonly data?: string;
  /** The media type, for an attachment. */
  readonly mediaType?: string;
}

/** The tool call a model made. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** One message of a turn. */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | readonly ContentPart[];
  /** The tool call this message answers. */
  readonly toolCallId?: string;
  /** The tool calls this message made. */
  readonly toolCalls?: readonly ToolCall[];
}

/** One tool the model may call. */
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  /** The tool's parameters, as a JSON schema. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** What a turn cost. */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** What a streamed turn produces. */
export type ModelStreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-call'; readonly call: ToolCall }
  | { readonly type: 'usage'; readonly usage: ModelUsage }
  | { readonly type: 'end'; readonly stopReason: string };
