/**
 * The model layer — our own multi-provider model layer.
 *
 * The specification is [`docs/protocol/MODEL-LAYER.md`](../docs/protocol/MODEL-LAYER.md);
 * the conformance document is
 * [`docs/compatibility/model-surface.md`](../docs/compatibility/model-surface.md).
 *
 * **The naming rule applies.** Where a *capability* is meant — an endpoint
 * that speaks one API shape or another — the capability is named, and no
 * product or company is named anywhere in this layer.
 */

export {
  DIALECTS,
  isDialect,
  type CatalogueDocument,
  type ContentPart,
  type CredentialReference,
  type Dialect,
  type EffortOverlay,
  type ModelCapabilities,
  type ModelCost,
  type ModelEntry,
  type ModelLimits,
  type ModelMessage,
  type ModelStreamEvent,
  type ModelTool,
  type ModelUsage,
  type Modality,
  type NamedOverlay,
  type Overlay,
  type OverlayBase,
  type OverlaySpelling,
  type ProviderCatalogueEntry,
  type ProviderEntry,
  type ReasoningSupport,
  type ToggleOverlay,
  type ToolCall,
  type BudgetOverlay,
} from './types.js';

export {
  DEFAULT_OVERLAY_NAME,
  applyOverlay,
  emptyOverlayTarget,
  findOverlay,
  overlayNames,
  resolveOverlay,
  withOverlay,
  type OverlayResolution,
  type OverlayTarget,
} from './overlays.js';

export { parseCataloguePayload, parseModelEntry, parseModelList } from './entries.js';

export {
  ProviderTable,
  aliasProvider,
  resolveProvider,
  type ProviderRegistry,
} from './provider.js';

export {
  ModelCatalogue,
  mergeCatalogues,
  type CatalogueChange,
  type CatalogueFetcher,
  type CatalogueRefresh,
  type CatalogueSources,
  type ModelCatalogueOptions,
} from './catalogue.js';

export {
  MemoryCredentialStore,
  connectionIdentity,
  createEncryptedFileSecretStore,
  createKeychainSecretStore,
  createSecretStore,
  deriveConnections,
  resolveProviderCredential,
  type Connection,
  type CredentialKind,
  type CredentialResolution,
  type CredentialStore,
  type Integration,
  type KeychainBackend,
  type OAuthGrant,
  type SecretSource,
  type SecretStore,
  type StoredCredential,
} from './credentials.js';

export {
  providerAvailability,
  type Availability,
  type AvailabilityOptions,
} from './availability.js';

export {
  canHoldText,
  formatModelRef,
  modelSatisfies,
  parseModelRef,
  selectModel,
  type ModelRef,
  type ModelRequirements,
  type SelectionOptions,
  type SelectionResult,
  type SelectionSource,
  type SelectionSources,
} from './selection.js';

export {
  DurableModelChoice,
  EMPTY_PREFERENCES,
  ModelPreferenceStore,
  RECENT_LIMIT,
  createFileSessionRecordCarrier,
  type ModelPreferences,
  type SessionRecordCarrier,
} from './preferences.js';

export {
  chatDialect,
  createModelListFetcher,
  createSseReader,
  dialectFor,
  joinEndpoint,
  messagesDialect,
  responsesDialect,
  type DialectRequest,
  type DialectRequestInput,
  type SseEvent,
  type SseReader,
  type StreamParser,
} from './dialects/index.js';

export {
  ModelEngine,
  ModelLayerError,
  type ModelEngineOptions,
  type ModelTurnRequest,
} from './engine.js';
