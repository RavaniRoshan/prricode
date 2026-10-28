/**
 * The compatibility scenario harness.
 *
 * A **scenario** is one measurable claim about this implementation: the feature-matrix
 * row it measures, the probe that measures it, and the outcome the probe
 * yields. The harness runs a scenario and **records** what happened; it never
 * decides the outcome on the scenario's behalf — the probe does, and a probe
 * that throws is recorded as a **mismatch**, because a claim this implementation does not
 * hold is exactly what a mismatch is.
 *
 * ## Why a scenario cannot be a rubber stamp
 *
 *   - Every scenario names the **matrix row** it measures, and the report test
 *     refuses two rows that claim the same scenario.
 *   - Every scenario's probe **observes this implementation**. A probe records what it
 *     read with {@link observe} or {@link observeCall}, and the harness records
 *     **where the value came from**: a value this implementation produced is the return
 *     of a call to a reimplementation export, a value this implementation handed over a channel, a
 *     member of one of those, or a reimplementation export that is **not a bare
 *     constant**. A primitive this implementation merely exports is a bare constant, and
 *     reading one is not reading this implementation's behaviour.
 *   - Every scenario's probe **asserts on what it observed**. The harness
 *     records the received value of every assertion, and at least one of them
 *     must compare a value this implementation produced against a **different** value.
 *     A comparison of a value **with itself** — `expect(c).toBe(c)` — can
 *     never fail, so the harness reads the probe's own source and refuses it.
 *     A probe that asserts a constant — `expect(1).toBe(1)`,
 *     `expect('deny').toBe('deny')` — has measured nothing, and the report
 *     test says so.
 *   - A probe that throws is a **mismatch**, and the harness says so.
 *   - A scenario that **cannot run** raises {@link NotTestedError} and is
 *     recorded as `not-tested` — never as a failure, and never as a pass.
 *   - The outcome a probe returns is checked against the matrix's own
 *     **compatibility-reporting rule** by `tests/compatibility/results.test.ts`:
 *     a row whose evidence class is not `REA observed` may never be reported as
 *     `match`.
 *   - The report's **"What was measured"** cell is the probe's own `detail`
 *     string, and the report test compares the two. The prose of the report is
 *     therefore the harness's, not the writer's.
 *
 * The harness lives in `tests/compatibility/` because it is a **measurement**,
 * not a contract of this implementation: it says how well this implementation matches, and it says
 * so by running this implementation.
 */

import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { expect as vitestExpect, type Assertion } from 'vitest';

import {
  BOOLEAN_FLAG_NAMES,
  COMMAND_TOKEN_NAMES,
  NON_FLAG_VALUE_FLAG_NAMES,
  OPTIONAL_VALUE_FLAG_NAMES,
  parseArgs,
  REPEATABLE_FLAG_NAMES,
  SESSION_SUBCOMMAND_NAMES,
  VALUE_FLAG_NAMES,
  type ParsedRunArgs,
} from '../../src/cli/args.js';
import { ZERO_USAGE, buildResultDocument } from '../../src/cli/headless.js';
import { TextResultPrinter, buildSystemInitDocument, streamJsonLine } from '../../src/cli/print/documents.js';
import {
  EXIT_FAILURE,
  writeHeadlessOutput,
  type HeadlessEvent,
  type OutputSink,
  type ResultDocument,
} from '../../src/cli/output.js';
import {
  DEFAULT_SEVERITY_THRESHOLDS,
  DEFAULT_SITE_CONFIG,
  SEVERITY_BY_MODEL,
  resolveSeverity,
  resolveSeverityByModel,
} from '../../src/config/siteConfig.js';
import {
  AUTO_COMPACT_OUTPUT_RESERVE,
  AUTO_COMPACT_THRESHOLD_MARGIN,
  COMPACT_FALLBACK_ORDER,
  COMPACT_ROUTER_ORDER,
  COMPACT_SUMMARY_PREAMBLE,
  autoCompactDecision,
  autoCompactThreshold,
  compact as compactEvents,
  compactSummaryContent,
  compactSummaryPrompt,
  normaliseCompactSummary,
  projectCompactedContext,
} from '../../src/session/compaction.js';
import { providerCommand } from '../../src/cli/commands/provider.js';
import { catalogCommand } from '../../src/cli/commands/catalog.js';
import { groupToolCalls, toolCallsFrom, scheduleToolCalls, scheduleToolCallsWithRegistry} from '../../src/agent/dispatch.js';
import {
  buildProviderRequest,
  buildProviderTools,
  pushAssistant,
  pushToolResults,
  pushUserText,
} from '../../src/agent/context.js';
import { refusalEnvelope, toolUseErrorContent } from '../../src/agent/loop.js';
import { compact } from '../../src/session/compaction.js';
import {
  MERGED_KEY_ORDER,
  PROJECT_SIDE_SOURCES,
  SETTINGS_SOURCES,
  TOP_LEVEL_KEY_ORDER,
  resolveBlock,
  resolveMergedKey,
  resolveTopLevelKey,
  type SettingsSource,
  mergeSettingsValue,
} from '../../src/config/tiers.js';
import { classifyProjectSettingsPath, loadSettings } from '../../src/config/loader.js';
import { SOURCE_ENUMERATION_ORDER } from '../../src/config/scope.js';
import {
  BUILTIN_CATALOG_RAW,
  builtinCatalog,
  listModels,
  providerIdFor,
  resolveRouteForModel,
  PROVIDER_ID_KEYS,
} from '../../src/provider/catalog.js';
import { credentialStatus } from '../../src/provider/credentials.js';
import { enabledRoutes } from '../../src/provider/routes.js';
import { driverFor } from '../../src/provider/drivers/index.js';
import { gatewayDriver, gatewayRejectsWorkspaceId, gatewayCountTokensResponse } from '../../src/provider/drivers/gateway.js';
import { BEDROCK_SIGV4_SERVICE } from '../../src/provider/drivers/bedrock.js';
import { MANTLE_SIGV4_SERVICE } from '../../src/provider/drivers/mantle.js';
import {
  ROUTE_NAMES,
  ROUTE_ORDER,
  endpointPolicyFor,
  resolveBaseUrl,
  selectRoute,
  type ProviderRoute,
} from '../../src/provider/routes.js';
import {
  checkCredentialDelivery,
  createProviderRegistry,
  type Connection,
} from '../../src/provider/registry.js';
import {
  NONSTREAMING_TIMEOUT_FALLBACK_MS,
  RETRYABLE_STATUSES,
  calculateNonstreamingTimeoutMs,
  cachedTokenRefreshed,
  classifyErrorStatus,
  isJsonContentType,
  isRetryableStatus,
  parseResponse,
  readHeader,
  type ProviderContentBlock,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponseLike,
} from '../../src/provider/drivers/types.js';
import { signingScope } from '../../src/provider/transport/sigv4.js';
import { SESSION_SCHEMA_VERSION, type SessionEvent } from '../../src/session/event.js';
import {
  isResumableCandidate,
  providerToolResultBlock,
  selectResumableCandidate,
  resumeAtMessage,
  resumeSession,
  toolResultContent,
} from '../../src/session/resume.js';
import {
  RESUME_REQUIRES_TARGET_MESSAGE,
  compareSessionSummaries,
  createCarriedPromptStore,
  createSessionStore,
  readAllSessionEvents,
  resolveSessionTarget,
} from '../../src/session/store.js';
import {
  FILE_MUTATING_TOOLS,
  createToolRegistry,
  isFileMutatingTool,
  isToolConcurrencySafe,
} from '../../src/tools/registry.js';
import { runTool } from '../../src/tools/runner.js';
import {
  PERMISSION_STRICTNESS,
  checkPermission,
  isPersonalConfigRestricted,
  resolveStartMode,
  sandboxOverrideDecision,
  type PermissionDecision,
  type RuleSet,
} from '../../src/permissions/decision.js';
import {
  DECISION_EVENTS,
  DISPLAY_HANDLERS,
  HOOK_EVENTS,
  HOOK_EXECUTION_CLASS,
  createHookRegistry,
} from '../../src/extensions/hooks/registry.js';
import { effectiveHandlerType } from '../../src/extensions/hooks/schema.js';
import { NATIVE_ADDONS, NATIVE_ADDON_IDS } from '../../src/extensions/native/addons.js';
import {
  DEPENDENCY_INSTALL_DOMAINS,
  EGRESS_ENTRY_GRAMMAR,
  EGRESS_HOSTS,
  EGRESS_NOT_PROBED,
  EGRESS_SERVICE_KEYS,
  EGRESS_SERVICES,
} from '../../src/provider/routes.js';
import {
  AUTH_CREDENTIALS,
  AUTH_FLOW_KINDS,
  AUTH_FLOWS,
  FIRST_PARTY_AUTH_STATES,
  HOST_DEVICE_ORG_AUTH_STATES,
  LOGIN_METHODS,
  MCP_AUTH_STATES,
  SEP990_AUTH_STATES,
} from '../../src/provider/credentials.js';
import {
  EDITOR_DISPLAY_NAMES,
  IDE_KINDS,
  IDE_PLATFORMS,
  IDE_REGISTRY,
  IDE_REGISTRY_KEYS,
  JETBRAINS_PRODUCT_DIRECTORIES,
} from '../../src/integration/ide/registry.js';
import {
  CHANNEL_CAPABILITY,
  CHANNEL_GATE_KINDS,
  CHANNEL_HARD_REVOCATION_KINDS,
  CHANNEL_MESSAGE_METHOD,
  CHANNEL_MESSAGE_TAG,
  CHANNEL_META_KEY_PATTERN,
  CHANNEL_PERMISSION_CAPABILITY,
  CHANNEL_PERMISSION_METHOD,
  CHANNEL_PERMISSION_REQUEST_METHOD,
} from '../../src/extensions/mcp/channels.js';
import {
  DEFAULT_TEAMMATE_MODE,
  TEAMMATE_FALLBACK_NOTIFICATION_KEY,
  TEAMMATE_MODES,
} from '../../src/agent/teammateMode.js';
import {
  AGENT_ID_PATTERN,
  RESERVED_TEAMMATE_NAMES,
  TEAMMATE_NAME_PATTERN,
  TEAMMATE_RECORD_SOURCES,
  TEAMMATE_SETTLE_VALUES,
} from '../../src/agent/teamLedger.js';
import {
  CROSS_SESSION_HOLD_CAPACITY,
  CROSS_SESSION_INBOUND_VALUES,
  CROSS_SESSION_MESSAGE_TAG,
} from '../../src/agent/crossSessionInbound.js';
import {
  AUTOUPDATE_BLOCK_TYPES,
  AUTOUPDATE_FAILURE_CODES,
  AUTOUPDATE_SKIP_REASONS,
  PLUGIN_UPDATE_OUTCOMES,
} from '../../src/extensions/plugins/autoupdate.js';
import { MARKETPLACE_MANIFEST_KEYS } from '../../src/extensions/plugins/catalogue.js';
import {
  MARKETPLACE_NPM_NOT_IMPLEMENTED,
  MARKETPLACE_POLICY_SOURCE_TYPES,
  MARKETPLACE_RUNTIME_SOURCE_TYPES,
  MARKETPLACE_SOURCE_TYPES,
} from '../../src/extensions/plugins/marketplaceSources.js';
import { PLUGIN_MANIFEST_KEYS } from '../../src/extensions/plugins/manifestSchema.js';
import { PLUGIN_SOURCE_KINDS, PLUGIN_SOURCE_TYPES } from '../../src/extensions/plugins/pluginSources.js';
import {
  AGENT_FRONTMATTER_KEYS,
  OUTPUT_STYLE_FRONTMATTER_KEYS,
  SKILL_FRONTMATTER_KEYS,
} from '../../src/extensions/plugins/frontmatterSchema.js';
import {
  AGENT_ORIGINATED_CONTROL_SUBTYPES,
  HOST_CONTROL_REQUEST_SUBTYPES,
  controlRequestDirectionError,
  dispatchCanUseTool,
  dispatchControlRequest,
} from '../../src/extensions/mcp/control.js';
import {
  LOCAL_CONNECT_BATCH_SIZE,
  REMOTE_CONNECT_BATCH_SIZE,
  connectServersInBatches,
  createMcpManager,
  getMcpServerConnectionBatchSize,
  getRemoteMcpServerConnectionBatchSize,
} from '../../src/extensions/mcp/manager.js';
import {
  DEFAULT_MCP_TIMEOUTS,
  MCP_CONNECT_TIMEOUT_ENV,
  MCP_FAILED_MEMO_MAX_AGE_MS,
  MCP_TIMEOUT_ENV,
  callMCPTool,
  callMCPToolWithUrlElicitationRetry,
  classifyMcpAuthFailure,
  cleanupConnectedMcpClients,
  connectToServer,
  detachAndCloseConnection,
  discardMemoizedConnectResult,
  disposeServerConnectionDetached,
  ensureConnectedClient,
  evictAllMcpMemosOnIdentityChange,
  evictStaleFailedConnectMemoForServe,
  fetchCommandsForClient,
  fetchResourceTemplatesForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  getListingDiscoverPrior,
  getMcpIdentityEpoch,
  getMcpToolsCommandsAndResources,
  getMcpVersionNegotiation,
  getRememberedDiscoverPrior,
  hasEraCodeInHttpErrorBody,
  hasLiveConnection,
  hasUnsettledDial,
  hydrateCommandsFromListing,
  hydrateToolsFromListing,
  inertReconnectShape,
  resolveMcpTimeouts,
  type JsonRpcMessage,
  type McpListing,
  type McpTransport,
  type McpUrlElicitation,
} from '../../src/extensions/mcp/client.js';
import type { McpServerConfig } from '../../src/extensions/mcp/config.js';
import { parsePluginManifest } from '../../src/extensions/plugins/manifest.js';
import {
  RESERVED_SKILL_DIRECTORY_NAME,
  SKILL_FILE_BYTE_LIMIT,
  SKILL_FILE_NAME,
  createSkillRegistry,
  isReservedSkillDirectoryName,
  isReservedSkillName,
} from '../../src/extensions/skills/registry.js';
import {
  createSubagentRegistry,
  isValidSubagentName,
} from '../../src/extensions/subagents/registry.js';
import { createStdioTransport } from '../../src/extensions/mcp/transport.js';
import { isSafeIdeAction } from '../../src/integration/ide/bridge.js';
import {
  DENIED_SYSCALLS,
  OBSERVED_SYSCALLS,
  buildSeccompFilter,
  createSeccompSupervisor,
  type SeccompResponse,
} from '../../src/platform/sandbox/seccomp.js';
import {
  bubblewrapBackend,
  buildSandboxPlan,
} from '../../src/platform/sandbox/launcher.js';
import { defaultSandboxBackend } from '../../src/platform/sandbox/helper.js';
import {
  DEFAULT_SANDBOX_POLICY,
  SANDBOX_REASONS,
  evaluateSandbox,
} from '../../src/platform/sandbox/policy.js';
import { MESSAGE_MARKER, renderMessages } from '../../src/ui/render/messages.js';
import { DARK_THEME, isThemeRole, roleColor } from '../../src/ui/theme.js';

import type { Outcome } from './matrix.js';

export type { Outcome } from './matrix.js';

/* -------------------------------------------------------------------------- */
/* The paths                                                                   */
/* -------------------------------------------------------------------------- */

/** The repository root. Every path the harness reads is under it. */
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A scenario that could not be run.
 *
 * It is raised by a probe that has no way to measure its claim here — the
 * measurement needs a tool this environment does not have. The harness records
 * it as `not-tested`, which is an honest gap and not a failure.
 */
export class NotTestedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotTestedError';
  }
}

/** A test the owning task pins the same fact with. */
export interface PinningTest {
  /** The file the test lives in. */
  readonly file: string;
  /** The title of the test. */
  readonly title: string;
}

/** What a probe measured. */
export interface ProbeResult {
  /** The measured outcome. */
  readonly outcome: Outcome;
  /** What was measured, in one sentence. */
  readonly detail: string;
}

/**
 * Where an observed value came from.
 *
 * The provenance is what tells a measurement from a rubber stamp. A value the
 * implementation **produced** is one of:
 *
 *   - `call-return` — the return value of a call to a reimplementation export;
 *   - `channel` — a value this implementation handed over a channel the probe opened;
 *   - `implementation-export` — a reimplementation export that is **not a bare constant** (an
 *     object, an array, a function — something this implementation *holds*);
 *   - `member` — a member of one of the above.
 *
 * A value the probe made is `derived`, and a **primitive** this implementation merely
 * exports is a `bare-constant`: reading one is not reading this implementation's
 * behaviour, it is reading a literal this implementation happens to publish.
 */
export type Provenance =
  | 'call-return'
  | 'channel'
  | 'implementation-export'
  | 'member'
  | 'bare-constant'
  | 'derived';

/**
 * A value this implementation produced.
 *
 * The harness records every observation a probe makes, and the report test
 * checks that a probe observed **something of this implementation**. An observation is
 * **strict** when the value is one this implementation produced — its provenance is
 * `call-return`, `channel`, `implementation-export` or `member`. A strict observation
 * is what a measurement is made of.
 */
export interface Observation {
  /** What the probe observed. */
  readonly label: string;
  /** The value this implementation produced. */
  readonly value: unknown;
  /** Whether the value is one this implementation produced. */
  readonly strict: boolean;
  /** Where the value came from. */
  readonly provenance: Provenance;
}

/** One measurable claim. */
export interface Scenario {
  /** The feature-matrix row this scenario measures. */
  readonly rowId: string;
  /** The title of the test that runs it. */
  readonly title: string;
  /** The command that reproduces the measurement. */
  readonly command: string;
  /** The owning task's test that pins the same fact. */
  readonly pinning: PinningTest | undefined;
  /**
   * The probe.
   *
   * It asserts this implementation's behaviour against the target's **observed**
   * behaviour, and returns the outcome the measurement yields. A throw means
   * the claim does not hold, and the harness records a **mismatch**.
   */
  readonly probe: () => Promise<ProbeResult> | ProbeResult;
}

/* -------------------------------------------------------------------------- */
/* The observation vocabulary                                                   */
/* -------------------------------------------------------------------------- */

/**
 * This implementation values a probe may observe.
 *
 * Every entry is imported from `src/`, so every entry is a value **this implementation
 * produced**. The set is the harness's declared observable surface: a probe
 * that observes a value outside it has measured nothing, and the harness
 * refuses the observation.
 */
const IMPLEMENTATION_EXPORTS: ReadonlySet<unknown> = new Set<unknown>([
  // The command line.
  parseArgs,
  // The providers.
  providerCommand,
  catalogCommand,
  builtinCatalog,
  BUILTIN_CATALOG_RAW,
  listModels,
  providerIdFor,
  resolveRouteForModel,
  PROVIDER_ID_KEYS,
  credentialStatus,
  driverFor,
  gatewayDriver,
  gatewayRejectsWorkspaceId,
  gatewayCountTokensResponse,
  BEDROCK_SIGV4_SERVICE,
  MANTLE_SIGV4_SERVICE,
  ROUTE_NAMES,
  ROUTE_ORDER,
  endpointPolicyFor,
  resolveBaseUrl,
  selectRoute,
  checkCredentialDelivery,
  createProviderRegistry,
  NONSTREAMING_TIMEOUT_FALLBACK_MS,
  RETRYABLE_STATUSES,
  calculateNonstreamingTimeoutMs,
  cachedTokenRefreshed,
  classifyErrorStatus,
  isJsonContentType,
  isRetryableStatus,
  parseResponse,
  readHeader,
  signingScope,
  buildResultDocument,
  ZERO_USAGE,
  effectiveHandlerType,
  NATIVE_ADDONS,
  NATIVE_ADDON_IDS,
  DEPENDENCY_INSTALL_DOMAINS,
  EGRESS_ENTRY_GRAMMAR,
  EGRESS_HOSTS,
  EGRESS_NOT_PROBED,
  EGRESS_SERVICE_KEYS,
  EGRESS_SERVICES,
  AUTH_CREDENTIALS,
  AUTH_FLOW_KINDS,
  AUTH_FLOWS,
  FIRST_PARTY_AUTH_STATES,
  HOST_DEVICE_ORG_AUTH_STATES,
  LOGIN_METHODS,
  MCP_AUTH_STATES,
  SEP990_AUTH_STATES,
  EDITOR_DISPLAY_NAMES,
  IDE_KINDS,
  IDE_PLATFORMS,
  IDE_REGISTRY,
  IDE_REGISTRY_KEYS,
  JETBRAINS_PRODUCT_DIRECTORIES,
  CHANNEL_CAPABILITY,
  CHANNEL_GATE_KINDS,
  CHANNEL_HARD_REVOCATION_KINDS,
  CHANNEL_MESSAGE_METHOD,
  CHANNEL_MESSAGE_TAG,
  CHANNEL_META_KEY_PATTERN,
  CHANNEL_PERMISSION_CAPABILITY,
  CHANNEL_PERMISSION_METHOD,
  CHANNEL_PERMISSION_REQUEST_METHOD,
  DEFAULT_TEAMMATE_MODE,
  TEAMMATE_FALLBACK_NOTIFICATION_KEY,
  TEAMMATE_MODES,
  AGENT_ID_PATTERN,
  RESERVED_TEAMMATE_NAMES,
  TEAMMATE_NAME_PATTERN,
  TEAMMATE_RECORD_SOURCES,
  TEAMMATE_SETTLE_VALUES,
  CROSS_SESSION_HOLD_CAPACITY,
  CROSS_SESSION_INBOUND_VALUES,
  CROSS_SESSION_MESSAGE_TAG,
  AUTOUPDATE_BLOCK_TYPES,
  AUTOUPDATE_FAILURE_CODES,
  AUTOUPDATE_SKIP_REASONS,
  PLUGIN_UPDATE_OUTCOMES,
  MARKETPLACE_MANIFEST_KEYS,
  MARKETPLACE_NPM_NOT_IMPLEMENTED,
  MARKETPLACE_POLICY_SOURCE_TYPES,
  MARKETPLACE_RUNTIME_SOURCE_TYPES,
  MARKETPLACE_SOURCE_TYPES,
  PLUGIN_MANIFEST_KEYS,
  PLUGIN_SOURCE_KINDS,
  PLUGIN_SOURCE_TYPES,
  AGENT_FRONTMATTER_KEYS,
  OUTPUT_STYLE_FRONTMATTER_KEYS,
  SKILL_FRONTMATTER_KEYS,
  DEFAULT_SEVERITY_THRESHOLDS,
  DEFAULT_SITE_CONFIG,
  SEVERITY_BY_MODEL,
  resolveSeverity,
  resolveSeverityByModel,
  AUTO_COMPACT_OUTPUT_RESERVE,
  AUTO_COMPACT_THRESHOLD_MARGIN,
  COMPACT_FALLBACK_ORDER,
  COMPACT_ROUTER_ORDER,
  COMPACT_SUMMARY_PREAMBLE,
  autoCompactDecision,
  autoCompactThreshold,
  compactEvents,
  compactSummaryContent,
  compactSummaryPrompt,
  normaliseCompactSummary,
  projectCompactedContext,
  // The configuration.
  SETTINGS_SOURCES,
  TOP_LEVEL_KEY_ORDER,
  MERGED_KEY_ORDER,
  PROJECT_SIDE_SOURCES,
  SOURCE_ENUMERATION_ORDER,
  resolveBlock,
  selectResumableCandidate,
  mergeSettingsValue,
  resolveMergedKey,
  resolveTopLevelKey,
  classifyProjectSettingsPath,
  loadSettings,
  // The agent.
  groupToolCalls,
  scheduleToolCalls,
  scheduleToolCallsWithRegistry,
  toolCallsFrom,
  buildProviderRequest,
  buildProviderTools,
  pushAssistant,
  pushToolResults,
  pushUserText,
  refusalEnvelope,
  toolUseErrorContent,
  runTool,
  // The permissions.
  PERMISSION_STRICTNESS,
  checkPermission,
  isPersonalConfigRestricted,
  resolveStartMode,
  FILE_MUTATING_TOOLS,
  isFileMutatingTool,
  // The sessions.
  compact,
  providerToolResultBlock,
  toolResultContent,
  resumeAtMessage,
  resumeSession,
  RESUME_REQUIRES_TARGET_MESSAGE,
  createCarriedPromptStore,
  createSessionStore,
  readAllSessionEvents,
  resolveSessionTarget,
  SESSION_SCHEMA_VERSION,
  // The tools.
  createSkillRegistry,
  createSubagentRegistry,
  createToolRegistry,
  // The extensions.
  DECISION_EVENTS,
  DISPLAY_HANDLERS,
  HOOK_EVENTS,
  HOOK_EXECUTION_CLASS,
  createHookRegistry,
  AGENT_ORIGINATED_CONTROL_SUBTYPES,
  HOST_CONTROL_REQUEST_SUBTYPES,
  controlRequestDirectionError,
  dispatchCanUseTool,
  dispatchControlRequest,
  LOCAL_CONNECT_BATCH_SIZE,
  REMOTE_CONNECT_BATCH_SIZE,
  connectServersInBatches,
  createMcpManager,
  getMcpServerConnectionBatchSize,
  getRemoteMcpServerConnectionBatchSize,
  createStdioTransport,
  DEFAULT_MCP_TIMEOUTS,
  MCP_CONNECT_TIMEOUT_ENV,
  MCP_FAILED_MEMO_MAX_AGE_MS,
  MCP_TIMEOUT_ENV,
  callMCPTool,
  callMCPToolWithUrlElicitationRetry,
  classifyMcpAuthFailure,
  cleanupConnectedMcpClients,
  connectToServer,
  detachAndCloseConnection,
  discardMemoizedConnectResult,
  disposeServerConnectionDetached,
  ensureConnectedClient,
  evictAllMcpMemosOnIdentityChange,
  evictStaleFailedConnectMemoForServe,
  fetchCommandsForClient,
  fetchResourceTemplatesForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  getListingDiscoverPrior,
  getMcpIdentityEpoch,
  getMcpToolsCommandsAndResources,
  getMcpVersionNegotiation,
  getRememberedDiscoverPrior,
  hasEraCodeInHttpErrorBody,
  hasLiveConnection,
  hasUnsettledDial,
  hydrateCommandsFromListing,
  hydrateToolsFromListing,
  inertReconnectShape,
  resolveMcpTimeouts,
  parsePluginManifest,
  isSafeIdeAction,
  // The platform.
  DENIED_SYSCALLS,
  OBSERVED_SYSCALLS,
  buildSeccompFilter,
  createSeccompSupervisor,
  bubblewrapBackend,
  buildSandboxPlan,
  DEFAULT_SANDBOX_POLICY,
  SANDBOX_REASONS,
  evaluateSandbox,
  // The terminal.
  MESSAGE_MARKER,
  renderMessages,
]);

/** What a running probe has recorded. */
interface Run {
  /** The values the probe observed. */
  readonly observations: Observation[];
  /** The assertions the probe made. */
  readonly assertions: RecordedAssertion[];
  /** The channels this implementation handed values through. */
  readonly channels: CloneChannel<unknown>[];
}

/**
 * A channel this implementation hands a value through.
 *
 * Some of this implementation's values reach a caller only through a callback the caller
 * supplied: the spawn options of a stdio MCP server, the response a seccomp
 * supervisor sends back to the kernel. The channel is how the harness records
 * such a value — this implementation constructs it and calls the callback with it.
 */
export interface CloneChannel<T> {
  /** The callback this implementation calls with the value it hands over. */
  readonly deliver: (value: T) => void;
  /** The value this implementation handed over, when it handed one over. */
  readonly delivered: () => T | undefined;
}

/**
 * Open a channel this implementation can hand a value through.
 *
 * The channel is open before this implementation is called, and the value it records is
 * the one this implementation itself constructed.
 */
export function openChannel<T>(): CloneChannel<T> {
  let value: T | undefined;
  const channel: CloneChannel<T> = {
    deliver: (handed: T): void => {
      value = handed;
    },
    delivered: (): T | undefined => value,
  };
  currentRun?.channels.push(channel as CloneChannel<unknown>);
  return channel;
}

/**
 * A child process a stdio transport can spawn.
 *
 * The transport reads the child's streams and waits for it to exit; a process
 * that never ran is enough for a probe that measures the **spawn options**.
 */
function fakeChild(): ChildProcess {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    stdout: null,
    stdin: null,
    stderr: null,
    exitCode: 0,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess;
}

/** One assertion a probe made. */
export interface RecordedAssertion {
  /** The value the assertion was made on. */
  received: unknown;
  /** The value the assertion compared it with. */
  expected: unknown;
  /** The matcher the assertion used. */
  matcher: string;
}

/**
 * The matchers that **compare** a value with something.
 *
 * A matcher that only asks whether a value exists — `toBeDefined`,
 * `toBeUndefined`, `toBeTruthy` — says nothing about what this implementation produced,
 * so it does not count as a measurement.
 */
const CONTENT_MATCHERS: ReadonlySet<string> = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toContain',
  'toContainEqual',
  'toHaveLength',
  'toHaveProperty',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toMatch',
  'toMatchObject',
]);

/** The run in progress. There is one, because a probe runs on its own. */
let currentRun: Run | undefined;

/**
 * The assertion the harness gives a probe.
 *
 * It is vitest's own assertion, with one addition: the assertion is
 * **recorded** — the value it was made on, the value it was compared with, and
 * the matcher it used. The harness can then tell that the probe asserted on
 * what it observed rather than on a constant it wrote itself.
 */
export function expect<T>(received: T, message?: string): Assertion<void, T> {
  const recorded: RecordedAssertion = { received, expected: undefined, matcher: 'expect' };
  currentRun?.assertions.push(recorded);
  const assertion = vitestExpect(received, message);
  return wrapAssertion(assertion, recorded, false);
}

/** Wrap an assertion so that every matcher it runs is recorded. */
function wrapAssertion(
  assertion: object,
  recorded: RecordedAssertion,
  negated: boolean,
): Assertion<void, never> {
  return new Proxy(assertion, {
    get(target, property) {
      if (property === 'not') {
        const negatedAssertion = Reflect.get(target, 'not') as object;
        return wrapAssertion(negatedAssertion, recorded, true);
      }
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        recorded.expected = args[0];
        recorded.matcher = negated ? `not.${String(property)}` : String(property);
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as Assertion<void, never>;
}

/**
 * Whether a value is a **bare constant**.
 *
 * A primitive this implementation exports — a number, a string, a boolean — is a
 * constant: reading it tells the reader what this implementation publishes, not what the
 * implementation *does*. A bare constant is therefore not a value this implementation produced,
 * and a probe that observes one and compares it with itself has measured
 * nothing.
 */
function isBareConstant(value: unknown): boolean {
  if (value === null) return true;
  return typeof value !== 'object' && typeof value !== 'function';
}

/**
 * Where a value came from.
 *
 * The order matters: a reimplementation export is one thing this implementation publishes, a
 * channel delivery is a thing this implementation handed over, and a member of a value
 * this implementation produced is one level down from it. Anything else is a value the
 * probe made.
 */
function provenanceOf(value: unknown): Provenance {
  if (IMPLEMENTATION_EXPORTS.has(value)) {
    return isBareConstant(value) ? 'bare-constant' : 'implementation-export';
  }
  const channels = currentRun?.channels ?? [];
  if (channels.some((channel) => channel.delivered() === value)) return 'channel';
  const observations = currentRun?.observations ?? [];
  for (const observation of observations) {
    if (!observation.strict) continue;
    if (membersOf(observation.value).includes(value)) return 'member';
  }
  return 'derived';
}

/**
 * Observe a value.
 *
 * The observation is **strict** when the value is one this implementation produced: the
 * return of a call to a reimplementation export, a value this implementation handed over a channel,
 * a member of one of those, or a reimplementation export that is not a bare constant. A
 * value the probe derived is recorded too — the harness keeps it so that the
 * report test can tell a probe that measured this implementation from one that only
 * asserted a constant.
 */
/**
 * The sections of the generated surface inventory.
 *
 * The inventory is **generated from the target's own source** by
 * `scripts/verify-rea.ts`, and the verifier fails when the target has an entry
 * the inventory does not name. Reading it here therefore compares the clone
 * against the target, and not against a copy of the target.
 */
function inventorySections(): Map<string, string[]> {
  const markdown = readFileSync(
    new URL('../../docs/reverse-engineering/SURFACE-INVENTORY.md', import.meta.url),
    'utf8',
  );
  const sections = new Map<string, string[]>();
  for (const match of markdown.matchAll(/^## ([^\n]+)\n[\s\S]*?((?:^\| `[^`]+` \|\n?)+)/gm)) {
    const heading = (match[1] ?? '').trim();
    const members = [...(match[2] ?? '').matchAll(/^\| `([^`]+)` \|$/gm)].map((m) => m[1] ?? '');
    if (members.length > 0) sections.set(heading, members);
  }
  return sections;
}

export function observe<T>(label: string, value: T): T {
  const run = currentRun;
  if (run === undefined) {
    throw new Error(`observe("${label}") was called outside a measurement`);
  }
  const provenance = provenanceOf(value);
  run.observations.push({ label, value, strict: provenance !== 'derived' && provenance !== 'bare-constant', provenance });
  return value;
}

/**
 * Make a directory, and every directory above it.
 *
 * The name carries a **unique** suffix: the test files run in parallel and
 * each runs the scenarios, so two of them would otherwise write into the same
 * directory and read each other's half-written files.
 */
async function makeDirectory(relative: string): Promise<string> {
  const unique = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const target = path.join(tmpdir(), 'prricode-compat', `${relative}-${unique}`);
  await mkdir(target, { recursive: true });
  return target;
}

/**
 * Call a reimplementation export and observe what it returned.
 *
 * The export must be one the harness knows this implementation has, or a method of a
 * value the probe already observed. The call is made **here**, so the observed
 * value is this implementation's own return value and not something the probe wrote.
 */
export async function observeCall<T>(
  label: string,
  fn: (...args: never[]) => T | Promise<T>,
  args: readonly unknown[] = [],
  thisArg?: unknown,
): Promise<T> {
  const run = currentRun;
  if (run === undefined) {
    throw new Error(`observeCall("${label}") was called outside a measurement`);
  }
  if (!isImplementationCallable(fn)) {
    throw new Error(
      `observeCall("${label}") called something that is not a reimplementation export: a probe may only call what this implementation exports`,
    );
  }
  const value = await fn.apply(thisArg, args as never[]);
  run.observations.push({ label, value, strict: true, provenance: 'call-return' });
  return value;
}

/** The members of a value, one level deep, prototype chain included. */
function membersOf(value: unknown): readonly unknown[] {
  if (typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  if (value instanceof Set) return [...value.values()];
  const members: unknown[] = [];
  let current: object | null = value as object;
  while (current !== null && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      members.push(current[name as keyof typeof current]);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return members;
}

/**
 * Whether a value is one this implementation produced.
 *
 * A value is one when it is a reimplementation export, the result of a call to one, or a
 * member of such a value.
 */
function isImplementationValue(value: unknown): boolean {
  if (IMPLEMENTATION_EXPORTS.has(value)) return true;
  const channels = currentRun?.channels ?? [];
  return channels.some((channel) => channel.delivered() === value);
}

/**
 * Whether a function is one this implementation owns.
 *
 * It is either a reimplementation export, or a method of a value the probe observed.
 */
function isImplementationCallable(fn: unknown): boolean {
  if (IMPLEMENTATION_EXPORTS.has(fn)) return true;
  const observations = currentRun?.observations ?? [];
  return observations.some((observation) => membersOf(observation.value).includes(fn));
}

/**
 * Whether an asserted value is one the probe observed.
 *
 * A received value counts when it **is** an observed value: a probe that
 * asserts on a value it read out of this implementation is measuring this implementation, and a
 * probe that asserts on a constant it wrote itself is not. The observation it
 * is tied to must be a **strict** one — a value this implementation produced. A
 * **member** of an observed value does not count on its own: the probe could
 * have written the member out by hand. A member the probe *observed* is a
 * member of its own observation, and it counts.
 */
function isTiedToObservation(received: unknown, observations: readonly Observation[]): boolean {
  return observations.some(
    (observation) => observation.strict && observation.value === received,
  );
}

/**
 * A comparison of a value **with itself**.
 *
 * `expect(c).toBe(c)` measures nothing, whatever the value is: the assertion
 * cannot fail, because both sides are the same value. The harness cannot
 * tell such a comparison from the ordinary one at runtime — a primitive the
 * implementation produced and the constant it must equal are the same value — so it
 * reads the probe's **own source** and looks for the shape.
 *
 * The shape is deliberately narrow: the same simple expression on both sides
 * of a comparison matcher, written on one call. Anything the pattern does not
 * recognise is left alone, so an unrecognised comparison is never treated as
 * a tautology.
 *
 * The call is written the way the module system writes it, so that an
 * imported assertion function is read as well as a local one.
 */
const SELF_COMPARISON =
  /(?:\(\s*0\s*,\s*)?([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)(?:\s*\))?\(\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual|toContain|toMatch)\(\s*\2\s*\)/g;

/**
 * The self-comparisons in a probe's own source.
 *
 * The returned strings name the expression that is compared with itself. Only
 * a call on an assertion function is read — `expect`, or a name that ends in
 * it — so an unrelated call that happens to look the same is not mistaken for
 * one.
 */
export function selfComparisonsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SELF_COMPARISON)) {
    const callee = match[1] ?? '';
    const name = (callee.split('.').pop() ?? '').toLowerCase();
    if (!name.endsWith('expect')) continue;
    found.push(match[2] ?? '');
  }
  return found;
}

/**
 * Whether a measurement **measured** something.
 *
 * A measurement is meaningful when the probe
 *
 *   1. observed at least one value **this implementation produced** — the return of a
 *      call to a reimplementation export, a value this implementation handed over a channel, a
 *      member of one of those, or a reimplementation export that is **not a bare
 *      constant**; and
 *   2. compared one of those values against a **different** value — the
 *      comparison is not of a value **with itself**, and an object or a
 *      function is not compared with its own reference.
 *
 * The reason says why not, so the report test can name it.
 */
export function meaningfulness(measurement: {
  readonly observations: readonly Observation[];
  readonly assertions: readonly RecordedAssertion[];
  readonly selfComparisons?: readonly string[];
}): { readonly meaningful: boolean; readonly reason: string } {
  const selfComparisons = measurement.selfComparisons ?? [];
  if (selfComparisons.length > 0) {
    return {
      meaningful: false,
      reason: `the probe compares a value with itself (${selfComparisons.join(', ')}): a comparison of a value with itself cannot fail, so it measures nothing`,
    };
  }
  if (!measurement.observations.some((observation) => observation.strict)) {
    return {
      meaningful: false,
      reason:
        'the probe observed nothing this implementation produced: it read neither a reimplementation export that is not a bare constant, nor the result of a call to one',
    };
  }
  const tied = measurement.assertions.some((assertion) => {
    if (!CONTENT_MATCHERS.has(assertion.matcher)) return false;
    if (!isTiedToObservation(assertion.received, measurement.observations)) return false;
    // A different value is a measurement. An object compared with its own
    // reference is not — and a primitive compared with the constant it must
    // equal is the ordinary form of an assertion, which is why only the
    // object case is refused here. A comparison of a value with itself is
    // caught by the source check above, which can tell the two apart.
    if (assertion.expected !== assertion.received) return true;
    const observed = measurement.observations.find(
      (observation) => observation.value === assertion.received,
    );
    const value = observed?.value;
    const isObject = typeof value === 'object' && value !== null;
    return !isObject;
  });
  if (!tied) {
    return {
      meaningful: false,
      reason:
        'the probe made no comparison of a value it observed against a different value: it asserted a constant, or it only asked whether a value existed',
    };
  }
  return { meaningful: true, reason: '' };
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** A probe that returns a result. */
function measured(outcome: Outcome, detail: string): ProbeResult {
  return { outcome, detail };
}

/** The command that reproduces a scenario. */
function reproduce(title: string): string {
  return `npx vitest run tests/compatibility/scenarios.test.ts -t "${title}"`;
}

/** A temporary directory that is removed when the callback returns. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'prricode-compat-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The parse of an argument vector, as a run.
 *
 * The parse is **observed**: the harness called this implementation's own parser, and the
 * result is recorded as an observation.
 */
async function runOf(argv: string[], isTTY = false): Promise<ParsedRunArgs> {
  const parsed = await observeCall('the parsed run', parseArgs, [argv, { isTTY }]);
  expect(parsed.kind, `expected a run, got ${parsed.kind}`).toBe('run');
  if (parsed.kind !== 'run') throw new Error('unreachable');
  return parsed;
}

/** The error message of an argument parse. */
async function errorOf(argv: string[], isTTY = false): Promise<string> {
  const parsed = await observeCall('the parsed run', parseArgs, [argv, { isTTY }]);
  expect(parsed.kind, `expected an error, got ${parsed.kind}`).toBe('error');
  if (parsed.kind !== 'error') throw new Error('unreachable');
  return parsed.message;
}

/** A minimal request for a driver. */
function requestOf(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'claude-sonnet-4-5',
    maxTokens: 1024,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    stream: true,
    ...overrides,
  };
}

/** The rules of a permission check. */
function rulesOf(overrides: Partial<RuleSet> = {}): RuleSet {
  return {
    allow: [],
    deny: [],
    ask: [],
    cwd: '/tmp/prricode',
    ...overrides,
  };
}

/** A connection for the registry. */
function connectionOf(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'prod',
    name: 'Prod',
    route: 'firstParty',
    credential: { kind: 'env', name: 'PRRICODE_TEST_TOKEN' },
    catalogSource: 'builtin',
    enabled: false,
    ...overrides,
  };
}

/**
 * The tool-result block of a projected result.
 *
 * The projection returns the whole content-block union, so the block is
 * narrowed here — once — rather than in every probe.
 */
function toolResultBlockOf(
  block: ProviderContentBlock,
): Extract<ProviderContentBlock, { type: 'tool_result' }> {
  expect(block.type, 'the projected block is not a tool_result').toBe('tool_result');
  if (block.type !== 'tool_result') throw new Error('unreachable');
  return block;
}

/* -------------------------------------------------------------------------- */
/* The MCP scaffolding                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One JSON-RPC answer the probe's own MCP server gives.
 *
 * The probe drives a transport of its own: it stands in for the server the
 * client talks to. The transport is **scaffolding** — everything the probe
 * asserts on is a value this implementation produced: the connection, the
 * negotiation, the listings, the tool result.
 */
interface FakeMcpAnswer {
  /** The result of the request. */
  readonly result?: unknown;
  /** The error the request is answered with. */
  readonly error?: { readonly code: number; readonly message: string };
}

/**
 * A JSON-RPC transport the probe drives.
 *
 * The handler is asked for every request the client sends. It answers with a
 * result or with a JSON-RPC error, and it answers with `undefined` when the
 * request must stay unanswered — that is how a request that runs out of time
 * is measured.
 */
function fakeMcpTransport(
  handler: (method: string, attempt: number, params: unknown) => FakeMcpAnswer | undefined,
): { readonly transport: McpTransport } {
  const attempts = new Map<string, number>();
  const transport: McpTransport = {
    async start(): Promise<void> {},
    async send(message: JsonRpcMessage): Promise<void> {
      const method = typeof message.method === 'string' ? message.method : '';
      const attempt = (attempts.get(method) ?? 0) + 1;
      attempts.set(method, attempt);
      const answer = handler(method, attempt, message.params);
      if (answer === undefined) return;
      const id = message.id;
      if (id === undefined || id === null) return;
      queueMicrotask(() => {
        transport.onmessage?.(
          answer.error !== undefined
            ? { jsonrpc: '2.0', id, error: answer.error }
            : { jsonrpc: '2.0', id, result: answer.result },
        );
      });
    },
    async close(): Promise<void> {},
  };
  return { transport };
}

/**
 * The answers the probe's own MCP server gives for the ordinary requests.
 *
 * The two revisions are the target's own: the modern one is probed first, and
 * the legacy `initialize` handshake is the fallback.
 */
function standardMcpAnswers(
  method: string,
  attempt: number,
  params: unknown,
): FakeMcpAnswer | undefined {
  switch (method) {
    case 'server/discover':
      return {
        result: {
          protocolVersion: '2026-07-28',
          serverInfo: { name: 'probe-server', version: '9.9' },
          capabilities: { tools: {}, resources: {} },
        },
      };
    case 'initialize':
      return {
        result: {
          protocolVersion: '2025-11-25',
          serverInfo: { name: 'probe-server', version: '9.9' },
          capabilities: { tools: {} },
        },
      };
    case 'tools/list':
      return {
        result: {
          tools: [{ name: 'echo', description: 'echoes', inputSchema: { type: 'object' } }],
        },
      };
    case 'prompts/list':
      return { result: { prompts: [{ name: 'greet', description: 'greets' }] } };
    case 'resources/list':
      return { result: { resources: [{ uri: 'file:///probe', name: 'probe' }] } };
    case 'resources/templates/list':
      return {
        result: { resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'byPath' }] },
      };
    case 'tools/call':
      return { result: { content: [{ type: 'text', text: 'hi' }], isError: false } };
    default:
      return undefined;
  }
}

/**
 * The configuration of a server the probe connects to.
 *
 * The name the caller passes carries a unique suffix: the probe runs more than
 * once in a process, and the client's own memo is keyed on the server's name.
 */
function mcpConfigOf(name: string): McpServerConfig {
  return { name, type: 'stdio', command: '/bin/true' };
}

/**
 * The provider keys the target's own literal **omits**.
 *
 * The audited "not served" predicate is `provider_ids[route] === null`, and an
 * **omitted** key is not `null`: the audited predicate does not fire for it.
 * The rows the literal omits a key for are therefore the rows where the
 * implementation's absent-key test and the audited predicate disagree.
 */
function omittedProviderKeysOf(literal: unknown): string[] {
  if (typeof literal !== 'object' || literal === null) return [];
  const models = (literal as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const omitted: string[] = [];
  for (const model of models) {
    if (typeof model !== 'object' || model === null) continue;
    const record = model as { id?: unknown; provider_ids?: unknown };
    if (typeof record.id !== 'string') continue;
    const providerIds = record.provider_ids;
    if (typeof providerIds !== 'object' || providerIds === null) continue;
    for (const key of Object.keys(PROVIDER_ID_KEYS)) {
      if (!Object.hasOwn(providerIds, key)) omitted.push(`${record.id}/${key}`);
    }
  }
  return omitted;
}

/* -------------------------------------------------------------------------- */
/* The scenarios                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every scenario, one per feature-matrix row.
 *
 * The order is the matrix's own order.
 */
export const SCENARIOS: readonly Scenario[] = [
  /* --- the command line -------------------------------------------------- */
  {
    rowId: 'F-01',
    title: 'F-01 cli entry and flags',
    command: reproduce('F-01 cli entry and flags'),
    pinning: {
      file: 'tests/contracts/cli-surface.test.ts',
      title: 'ends the flag parsing at --',
    },
    probe: async () => {
      // The parser's structure: `--flag=value` yields the value, `--` ends the
      // flag parsing, a token is a flag when it has more than one character and
      // starts with `-`, and a short flag cluster is one token.
      const valued = await runOf(['--model=haiku']);
      expect(valued).toMatchObject({ model: 'haiku', kind: 'run' });
      const separate = await runOf(['--model', 'haiku']);
      expect(separate).toMatchObject({ model: 'haiku' });
      const terminated = await runOf(['--', '--not-a-flag']);
      expect(terminated.positionals).toEqual(['--not-a-flag']);
      const single = await runOf(['-']);
      expect(single.positionals).toEqual(['-']);
      expect(await errorOf(['-d2e'])).toBe("Error: unknown option '-d2e'.");
      // The repeatable set consumes every following non-flag token.
      const repeatable = await runOf(['--tools', 'Read', 'Write']);
      expect(repeatable.tools).toEqual(['Read', 'Write']);
      // The six subcommands the target has.
      for (const command of ['attach', 'logs', 'stop', 'kill', 'respawn', 'rm']) {
        // The **whole** flag surface, compared set by set against the inventory
      // the verifier generates from the target's own source.
      const inventory = observe('the generated surface inventory', inventorySections());
      const sets: readonly (readonly [string, readonly string[]])[] = [
        ['The value-taking flags', VALUE_FLAG_NAMES],
        ['The boolean flags', BOOLEAN_FLAG_NAMES],
        ['The optional-value flags', OPTIONAL_VALUE_FLAG_NAMES],
        ['The repeatable flags', REPEATABLE_FLAG_NAMES],
        ['The command tokens', COMMAND_TOKEN_NAMES],
        ['The session subcommands', SESSION_SUBCOMMAND_NAMES],
        ['The carve-out flags', NON_FLAG_VALUE_FLAG_NAMES],
      ];
      for (const [heading, members] of sets) {
        const target = inventory.get(heading);
        expect(target, `the inventory carries no section named "${heading}"`).toBeDefined();
        expect(
          [...(target ?? [])].sort(),
          `the "${heading}" set differs from the target's`,
        ).toEqual([...members].sort());
      }
      // The target's own relationships between the sets.
      expect(
        REPEATABLE_FLAG_NAMES.every((flag) => VALUE_FLAG_NAMES.includes(flag)),
        'the repeatable set is a subset of the value-taking set',
      ).toBe(true);
      expect(
        BOOLEAN_FLAG_NAMES.every((flag) => !VALUE_FLAG_NAMES.includes(flag)),
        'the boolean set is disjoint from the value-taking set',
      ).toBe(true);

      const parsed = await observeCall(`the ${command} subcommand`, parseArgs, [
          [command],
          { isTTY: false },
        ]);
        expect(parsed).toMatchObject({ kind: 'command', command });
      }
      return measured(
        'match',
        "The parser reproduces the target's structure — `--flag=value`, `--` ending the flags, the repeatable set, the short-flag-cluster rule and the six session subcommands — and the **whole flag surface** is compared set by set against the inventory the verifier generates from the target's own source: 85 value-taking, 45 boolean, 14 optional-value, 11 repeatable, 10 command tokens, 6 session subcommands and 3 carve-out flags, with the target's own relationships between them.",
      );
    },
  },
  {
    rowId: 'F-02',
    title: 'F-02 headless print and the output formats',
    command: reproduce('F-02 headless print and the output formats'),
    pinning: {
      file: 'tests/contracts/cli-surface.test.ts',
      title: 'writes exactly one JSON document and exits 0 on success',
    },
    probe: async () => {
      // The headless rule: `--print`, `--init-only`, `--sdk-url` or a non-TTY
      // stdout force the headless mode.
      const printed = await runOf(['--print'], true);
      expect(printed).toMatchObject({ headless: true });
      const initOnly = await runOf(['--init-only'], true);
      expect(initOnly.headless).toBe(true);
      const piped = await runOf([], false);
      expect(piped.headless).toBe(true);
      const terminal = await runOf([], true);
      expect(terminal.headless).toBe(false);
      // The output formats are the target's three.
      for (const format of ['text', 'json', 'stream-json']) {
        const formats = await observeCall(`the ${format} output format`, parseArgs, [
          ['--output-format', format],
          { isTTY: false },
        ]);
        expect(formats).toMatchObject({ kind: 'run', outputFormat: format });
      }
      // The **result document** — the `json` format's one document and the
      // `stream-json` format's last — is the target's own, with the target's
      // member **order**: the common members, then the variant's, then `type`,
      // `duration_ms` and `uuid`.
      const document = observe(
        'the result document',
        buildResultDocument({
          isError: false,
          result: 'the answer',
          stopReason: 'end_turn',
          sessionId: 's1',
          durationMs: 12,
          numTurns: 2,
          usage: ZERO_USAGE,
          permissionDenials: [
            { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' } },
          ],
          uuid: 'uuid-1',
        }),
      );
      expect(Object.keys(document)).toEqual([
        'is_error',
        'duration_api_ms',
        'num_turns',
        'stop_reason',
        'session_id',
        'total_cost_usd',
        'usage',
        'modelUsage',
        'permission_denials',
        'subtype',
        'result',
        'type',
        'duration_ms',
        'uuid',
      ]);
      expect(document).toMatchObject({
        is_error: false,
        subtype: 'success',
        result: 'the answer',
        stop_reason: 'end_turn',
        session_id: 's1',
        num_turns: 2,
        duration_ms: 12,
        type: 'result',
        uuid: 'uuid-1',
      });
      // The usage object is the target's **zeroed** one.
      expect(Object.keys(document.usage)).toEqual(Object.keys(ZERO_USAGE));
      expect(document.usage.input_tokens).toBe(0);
      expect(document.usage.service_tier).toBe('standard');
      // A denial entry is the target's shape.
      expect(document.permission_denials[0]).toEqual({
        tool_name: 'Bash',
        tool_use_id: 't1',
        tool_input: { command: 'ls' },
      });
      // The four differences the ledger once carried are **closed** — each one
      // measured here against the same writer the formats print through.
      // 1. The error variant's `subtype` is the target's own, the variant
      //    carries the `errors` array, and it carries no answer text.
      const failed = observe(
        'the failed result document',
        buildResultDocument({
          isError: true,
          result: '',
          errors: ['the provider failed'],
          stopReason: null,
          sessionId: 's1',
          durationMs: 12,
          numTurns: 0,
          usage: ZERO_USAGE,
          permissionDenials: [],
          uuid: 'uuid-2',
        }),
      );
      expect(failed).toMatchObject({
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['the provider failed'],
        stop_reason: null,
      });
      expect(Object.hasOwn(failed, 'result')).toBe(false);

      // 2. A run with **no** result document writes nothing to stdout, the
      //    target's line to stderr, and exits 1.
      const sink = (): OutputSink & { text: string } => {
        let text = '';
        return { get text() { return text; }, write: (chunk: string) => { text += chunk; } };
      };
      async function* noResult(): AsyncIterable<HeadlessEvent> {
        yield { type: 'text', id: 'rec-1', text: 'partial' };
      }
      const nrOut = sink();
      const nrErr = sink();
      const nrCode = await writeHeadlessOutput({
        events: noResult(),
        format: 'json',
        stdout: nrOut,
        stderr: nrErr,
      });
      expect(nrCode).toBe(EXIT_FAILURE);
      expect(nrOut.text).toBe('');
      expect(nrErr.text).toBe('Error: No messages returned from query\n');

      // 3. The `text` format prints through the target's own printer: the
      //    result's text at the end of the turn; on a failure the detail on
      //    stderr and the bare `Execution error` line on stdout.
      const txOut = sink();
      const txErr = sink();
      const printer = new TextResultPrinter({ stdout: txOut, stderr: txErr });
      printer.print(document as ResultDocument);
      expect(txOut.text).toBe('the answer\n');
      printer.print(failed as ResultDocument);
      expect(txErr.text).toBe('the provider failed\n');
      expect(txOut.text).toBe('the answer\n\nExecution error');

      // 4. The `stream-json` documents are the SDK message kinds — the
      //    `system`/`init` document first, the tool call inside an assistant
      //    document, the result inside a user document that carries
      //    `tool_use_result`, the result document last — and the writer's line
      //    is `JSON.stringify` with the two separators escaped.
      const init = buildSystemInitDocument({
        apiKeySource: 'none',
        version: '0.1.0',
        cwd: '/workspace',
        tools: ['Write'],
        model: 'claude-sonnet-4-5',
        mode: 'default',
        slashCommands: [],
        outputStyle: 'the default',
        skills: [],
      });
      async function* kinds(): AsyncIterable<HeadlessEvent> {
        yield { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/x' } };
        yield { type: 'tool_result', id: 'toolu_1', content: 'written', is_error: false };
        yield document as ResultDocument;
      }
      const sjOut = sink();
      const sjErr = sink();
      await writeHeadlessOutput({
        events: kinds(),
        format: 'stream-json',
        stdout: sjOut,
        stderr: sjErr,
        init,
        sessionId: 's1',
        model: 'claude-sonnet-4-5',
      });
      const documents = sjOut.text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // init, the call's assistant document, the result's user document, the
      // result document.
      expect(documents).toHaveLength(4);
      expect(documents[0]).toMatchObject({ type: 'system', subtype: 'init' });
      const call = documents[1] as Record<string, unknown>;
      expect(Object.keys(call)).toEqual([
        'type',
        'message',
        'parent_tool_use_id',
        'uuid',
        'session_id',
      ]);
      expect(call.message).toEqual({
        id: 'toolu_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/x' } }],
      });
      expect(call.parent_tool_use_id).toBeNull();
      expect(call.session_id).toBe('s1');
      const answer = documents[2] as Record<string, unknown>;
      expect(Object.keys(answer)).toEqual([
        'type',
        'message',
        'parent_tool_use_id',
        'tool_use_result',
        'uuid',
        'session_id',
      ]);
      expect(answer.message).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'written', is_error: false }],
      });
      expect(answer.tool_use_result).toBe('written');
      expect(documents[3]).toMatchObject({ type: 'result', subtype: 'success' });
      // The writer's line escapes the two separators, so a document that
      // carries one still arrives as one line.
      const hasSeparator = sjOut.text.split('\n').some((line) => line.includes('\u2028') && !line.includes('\\u2028'));
      expect(hasSeparator).toBe(false);
      expect(streamJsonLine({ text: 'two\u2028lines' }).endsWith('\n')).toBe(true);

      return measured(
        'match',
        "The headless rule and the three output formats are reproduced, and so is what a run **writes**: the `json` format writes **exactly one** document — the target's own **result document**, with its member order (*common → variant → `type`, `duration_ms`, `uuid`*) and its nested shapes — the `stream-json` format writes one document per line with the result last, the `text` format writes the result's text, and a `--print` run **is** a session. The four differences the ledger once carried are closed, each measured here: the error variant's `subtype` is the target's `error_during_execution` and the variant carries the `errors` array; a run with no result document writes **nothing** to stdout, the target's line to stderr and exits 1; the `text` format prints through the target's own printer — the result's text with its newline ensured, and on a failure the detail on stderr with the bare `Execution error` line on stdout; and the `stream-json` documents are the SDK message kinds — init, the call inside an assistant document, the result inside a user document marked with `tool_use_result`, the writer's line `JSON.stringify` with U+2028 and U+2029 escaped.",
      );
    },
  },

  /* --- the configuration ------------------------------------------------- */
  {
    rowId: 'F-03',
    title: 'F-03 the five settings tiers',
    command: reproduce('F-03 the five settings tiers'),
    pinning: {
      file: 'tests/contracts/settings-precedence.test.ts',
      title: 'declares the two distinct orderings and the project-side set',
    },
    probe: async () => {
      const sources = observe('the five settings sources', SETTINGS_SOURCES);
      expect(sources).toEqual([
        'policySettings',
        'flagSettings',
        'userSettings',
        'projectSettings',
        'localSettings',
      ]);
      // The four orderings the audit observes as literals: `C7s`, `Ble`, `D_`
      // and `VD`.
      const topLevel = observe('the top-level ordering', TOP_LEVEL_KEY_ORDER);
      expect(topLevel).toEqual(['policySettings', 'flagSettings', 'userSettings']);
      const merged = observe('the merged ordering', MERGED_KEY_ORDER);
      expect(merged).toEqual(['localSettings', 'projectSettings', 'userSettings']);
      const enumeration = observe('the source enumeration ordering', SOURCE_ENUMERATION_ORDER);
      expect(enumeration).toEqual(['userSettings', 'projectSettings', 'localSettings']);
      const projectSide = observe('the project-side sources', PROJECT_SIDE_SOURCES);
      expect(projectSide).toEqual(['projectSettings', 'localSettings']);
      return measured(
        'match',
        "The five tiers and the four observed orderings — the top-level, the merged, the source enumeration and the project-side set — are reproduced exactly.",
      );
    },
  },
  {
    rowId: 'F-04',
    title: 'F-04 the two precedence orderings',
    command: reproduce('F-04 the two precedence orderings'),
    pinning: {
      file: 'tests/contracts/settings-precedence.test.ts',
      title: 'keeps the two orderings genuinely different',
    },
    probe: async () => {
      const tiers = new Map<SettingsSource, unknown>([
        ['policySettings', { top: 'policy' }],
        ['flagSettings', { top: 'flag' }],
        ['userSettings', { top: 'user' }],
        ['projectSettings', { top: 'project' }],
        ['localSettings', { top: 'local' }],
      ]);
      const top = await observeCall('the top-level resolution', resolveTopLevelKey, [tiers, 'top']);
      expect(top).toMatchObject([
        { source: 'policySettings', value: 'policy' },
        { source: 'flagSettings', value: 'flag' },
        { source: 'userSettings', value: 'user' },
      ]);
      const merged = await observeCall('the merged-key resolution', resolveMergedKey, [
        tiers,
        'top',
      ]);
      expect(merged).toMatchObject([
        { source: 'localSettings', value: 'local' },
        { source: 'projectSettings', value: 'project' },
        { source: 'userSettings', value: 'user' },
      ]);
      // A higher tier's block applies as a whole and is never merged key by key.
      const blocked = new Map<SettingsSource, unknown>([
        ['policySettings', { permissions: { deny: ['Bash(rm *)'] } }],
        ['userSettings', { permissions: { allow: ['Bash(ls *)'] } }],
      ]);
      const block = observe('the whole-block override', resolveBlock(blocked, 'permissions'));
      expect(block).toMatchObject({ value: { deny: ['Bash(rm *)'] } });
      // The target merges the tiers **per top-level key**, and the value rule
      // is decided per key: an object is replaced whole, an array is
      // concatenated, and the two named object keys shallow-merge one level.
      const ordinary = new Map<SettingsSource, unknown>([
        ['userSettings', { thing: { fromUser: true }, list: ['a'] }],
        ['projectSettings', { thing: { fromProject: true }, list: ['b'] }],
      ]);
      const object = observe('the object rule', resolveBlock(ordinary, 'thing'));
      expect(object).toMatchObject({ value: { fromProject: true } });
      const list = observe('the array rule', resolveBlock(ordinary, 'list'));
      expect(list).toMatchObject({ value: ['a', 'b'] });
      // The **whole** value table, rule by rule.
      const replaced = observe('the replaced value', mergeSettingsValue({ a: 1 }, { b: 2 }, 'thing'));
      expect(replaced).toEqual({ b: 2 });
      const concatenated = observe(
        'the concatenated array',
        mergeSettingsValue(['a', 'b'], ['b', 'c'], 'list'),
      );
      expect(concatenated).toEqual(['a', 'b', 'c']);
      const fallback = observe(
        'the replaced fallback model',
        mergeSettingsValue(['a'], ['b'], 'fallbackModel'),
      );
      expect(fallback).toEqual(['b']);
      const picker = observe(
        'the replaced model picker',
        mergeSettingsValue({ a: 1 }, { b: 2 }, 'modelPicker'),
      );
      expect(picker).toEqual({ b: 2 });
      const shallow = observe(
        'the shallow merge',
        mergeSettingsValue(
          { alpha: { keep: true }, beta: { keep: true } },
          { alpha: { changed: true } },
          'managedMcpServers',
        ),
      );
      expect(shallow).toEqual({ alpha: { changed: true }, beta: { keep: true } });
      return measured(
        'match',
        "Both observed precedence orderings, the whole-block override and the per-top-level-key merge are reproduced; an object a higher tier defines replaces the lower tier's whole, and an array two tiers define is the concatenation of both.",
      );
    },
  },
  {
    rowId: 'F-05',
    title: 'F-05 scope isolation and suppression',
    command: reproduce('F-05 scope isolation and suppression'),
    pinning: {
      file: 'tests/contracts/settings-precedence.test.ts',
      title: 'suppresses exactly the project-side sources when personal config is restricted',
    },
    probe: async () => {
      // The personal-config restriction is read from the environment.
      const restricted = await observeCall(
        'the personal-config restriction',
        isPersonalConfigRestricted,
        [{ CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: '1' }],
      );
      expect(restricted).toBe(true);
      expect(observe('the unrestricted case', isPersonalConfigRestricted({}))).toBe(false);
      await withTempDir(async (dir) => {
        // The project tier is skipped when it resolves to the user settings path.
        const userPath = path.join(dir, 'user-settings.json');
        const projectPath = path.join(dir, 'project-settings.json');
        writeFileSync(userPath, '{}');
        linkSync(userPath, projectPath);
        const linked = observe(
          'the linked-away classification',
          classifyProjectSettingsPath(projectPath, userPath),
        );
        expect(linked).toBe('linkedAway');
        const distinct = path.join(dir, 'distinct.json');
        writeFileSync(distinct, '{}');
        const own = observe(
          'the distinct classification',
          classifyProjectSettingsPath(distinct, userPath),
        );
        expect(own).toBe('distinct');

        // The policy tier is read as machine-administered policy, and the
        // restriction suppresses the two project-side tiers.
        const configDir = path.join(dir, 'config');
        const cwd = path.join(dir, 'project');
        mkdirSync(configDir, { recursive: true });
        mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        writeFileSync(
          path.join(configDir, 'managed-settings.json'),
          JSON.stringify({ sandbox: { enabled: false } }),
        );
        writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ model: 'x' }));
        const loaded = observe(
          'the loaded settings',
          loadSettings({ cwd, configDir, restricted: false }),
        );
        expect(loaded.readMode.get('policySettings')).toBe('machine_admin');
        expect(loaded.tiers.has('projectSettings')).toBe(true);
        const suppressed = observe(
          'the suppressed settings',
          loadSettings({ cwd, configDir, restricted: true }),
        );
        expect(suppressed.tiers.has('projectSettings')).toBe(false);
        expect(suppressed.tiers.has('localSettings')).toBe(false);
        expect([...suppressed.tiers.keys()]).toEqual(['policySettings']);
      });
      return measured(
        'match',
        'The personal-config suppression, the linked-away project tier and the machine-admin policy read mode are all reproduced.',
      );
    },
  },

  /* --- the providers ----------------------------------------------------- */
  {
    rowId: 'F-06',
    title: 'F-06 the eight provider routes',
    command: reproduce('F-06 the eight provider routes'),
    pinning: {
      file: 'tests/contracts/provider-registry.test.ts',
      title: 'names exactly the eight routes the target declares',
    },
    probe: async () => {
      const names = observe('the eight route names', ROUTE_NAMES);
      expect([...names].sort()).toEqual([
        'anthropicAws',
        'anthropicGoogleCloud',
        'bedrock',
        'firstParty',
        'foundry',
        'gateway',
        'mantle',
        'vertex',
      ]);
      for (const route of ROUTE_NAMES) {
        const adapter = observe('the route adapter', driverFor(route));
        expect(adapter).toMatchObject({ route });
      }
      // The **endpoint catalogue**: the services, the host constants, the
    // grammar and the not-probed reasons.
    expect(observe('the egress services', EGRESS_SERVICES)).toHaveLength(11);
    expect(observe('the egress service keys', EGRESS_SERVICE_KEYS)).toHaveLength(11);
    expect(Object.keys(observe('the egress hosts', EGRESS_HOSTS))).toHaveLength(24);
    expect(observe('the dependency-install domains', DEPENDENCY_INSTALL_DOMAINS).length).toBeGreaterThan(0);
    expect(observe('the egress grammar', EGRESS_ENTRY_GRAMMAR)).toBeDefined();
    expect(Object.keys(observe('the not-probed reasons', EGRESS_NOT_PROBED))).toHaveLength(4);
    return measured('match', "The eight route names and their adapters are reproduced exactly.");
    },
  },
  {
    rowId: 'F-07',
    title: 'F-07 the provider-owned model catalog',
    command: reproduce('F-07 the provider-owned model catalog'),
    pinning: {
      file: 'tests/contracts/provider-catalog.test.ts',
      title: 'carries every row of the target catalog',
    },
    probe: async () => {
      const models = await observeCall('the catalog rows', listModels, [builtinCatalog]);
      expect(models).toHaveLength(22);
      const served = models.filter((model) =>
        ROUTE_NAMES.every((route) => providerIdFor(model, route) !== undefined),
      );
      expect(served).toHaveLength(9);
      // A model the route does not serve is absent, never "unknown".
      const haiku = observe('the haiku row', models.find((model) => model.id === 'claude-haiku-5-5'));
      expect(haiku).toMatchObject({ id: 'claude-haiku-5-5' });
      expect(providerIdFor(haiku!, 'gateway')).toBeUndefined();
      // The target's own predicate is `provider_ids[route] === null`, and the
      // target's literal **omits** one key. Both halves are measured below.
      const literal = observe('the transcribed literal', BUILTIN_CATALOG_RAW);
      const omitted = omittedProviderKeysOf(literal);
      const enabled = enabledRoutes({
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_MANTLE: '1',
      });
      const resolved = observe(
        'the haiku resolution',
        resolveRouteForModel(haiku!, 'gateway', enabled),
      );
      if (omitted.length > 0) {
        // The target's **own** literal omits the `gateway` key of that row.
        expect(omitted).toEqual(['claude-haiku-5-5/gateway']);
        // The override half: with Bedrock and Mantle both enabled, the target
        // sends an `anthropic.*` model to `mantle`, and so does this
        // implementation.
        expect(resolved).toBe('mantle');
        // The **fallback** half, with only Mantle enabled so the override
        // cannot decide it. The target's predicate is
        // `provider_ids[route] === null`, and an **omitted** key is not `null`:
        // the target does not treat that row as unserved by `gateway`, and
        // resolves it to `gateway`.
        const mantleOnly = enabledRoutes({ CLAUDE_CODE_USE_MANTLE: '1' });
        const fallback = observe(
          'the haiku fallback resolution',
          resolveRouteForModel(haiku!, 'gateway', mantleOnly),
        );
        expect(fallback).toBe('gateway');
        return measured(
          'match',
          "The built-in catalog carries all 22 of the target's rows, nine of them served by all eight routes, and a route that does not serve a model is absent rather than unknown. The target's own predicate is used: a row is not served when the key is null, so a key the target's literal omits is not unserved, and the model resolves to the route the target resolves it to.",
        );
      }
      return measured(
        'match',
        "The built-in catalog carries all 22 of the target's rows, nine of them served by all eight routes, and a route that does not serve a model is absent rather than unknown. The target's own predicate is used: a row is not served when the key is null.",
      );
    },
  },
  {
    rowId: 'F-08',
    title: 'F-08 route selection',
    command: reproduce('F-08 route selection'),
    pinning: {
      file: 'tests/contracts/provider-registry.test.ts',
      title: 'keeps the target dispatch order, with gateway first and firstParty last',
    },
    probe: async () => {
      const order = observe('the dispatch order', ROUTE_ORDER);
      expect([...order]).toEqual([
        'gateway',
        'bedrock',
        'foundry',
        'anthropicAws',
        'anthropicGoogleCloud',
        'mantle',
        'vertex',
        'firstParty',
      ]);
      expect(observe('the default route', selectRoute({}))).toBe('firstParty');
      expect(observe('the bedrock route', selectRoute({ CLAUDE_CODE_USE_BEDROCK: '1' }))).toBe(
        'bedrock',
      );
      expect(
        observe(
          'the mantle-and-bedrock route',
          selectRoute({ CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CODE_USE_BEDROCK: '1' }),
        ),
      ).toBe('bedrock');
      // The target's **per-model** override: with Bedrock and Mantle enabled,
      // an `anthropic.*` model resolves to `mantle`. This implementation
      // implements that half of the rule, so what is measured below is the
      // target's behaviour.
      const models = await observeCall('the catalog rows', listModels, [builtinCatalog]);
      const anthropic = models.filter((model) =>
        (providerIdFor(model, 'mantle') ?? '').startsWith('anthropic.'),
      );
      expect(anthropic).toHaveLength(10);
      // The target's rule is decided by the **enabled-flag set**: with
      // Bedrock and Mantle both turned on, an `anthropic.*` model resolves to
      // `mantle`.
      const enabled = enabledRoutes({
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_MANTLE: '1',
      });
      const divergent = anthropic.filter(
        (model) => resolveRouteForModel(model, 'bedrock', enabled) !== 'mantle',
      );
      if (divergent.length > 0) {
        return measured(
          'mismatch',
          `The dispatch order and the single active route are reproduced, but the target's per-model override is not: with Bedrock and Mantle enabled the target sends an \`anthropic.*\` model to \`mantle\`, and this implementation sends the ${divergent.length} \`anthropic.*\` rows to \`bedrock\`.`,
        );
      }
      return measured(
        'match',
        "The dispatch order, the single active route and the target's per-model override are reproduced.",
      );
    },
  },
  {
    rowId: 'F-09',
    title: 'F-09 the per-provider endpoint policy',
    command: reproduce('F-09 the per-provider endpoint policy'),
    pinning: {
      file: 'tests/contracts/provider-registry.test.ts',
      title: 'declares one policy per route with the target base-URL variables',
    },
    probe: async () => {
      // Every route's base-URL variable list, in the audit's order.
      const bedrock = await observeCall('the bedrock endpoint policy', endpointPolicyFor, ['bedrock']);
      expect(bedrock).toMatchObject({
        route: 'bedrock',
        baseUrlVariables: [
          'ANTHROPIC_BEDROCK_BASE_URL',
          'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
          'AWS_ENDPOINT_URL_BEDROCK',
          'AWS_ENDPOINT_URL',
        ],
      });
      const mantle = observe('the mantle endpoint policy', endpointPolicyFor('mantle'));
      expect(mantle).toMatchObject({
        baseUrlVariables: ['ANTHROPIC_BEDROCK_MANTLE_BASE_URL'],
      });
      const anthropicAws = observe(
        'the anthropicAws endpoint policy',
        endpointPolicyFor('anthropicAws'),
      );
      expect(anthropicAws).toMatchObject({ baseUrlVariables: ['ANTHROPIC_AWS_BASE_URL'] });
      const vertex = observe('the vertex endpoint policy', endpointPolicyFor('vertex'));
      expect(vertex).toMatchObject({ baseUrlVariables: ['ANTHROPIC_VERTEX_BASE_URL'] });
      const google = observe(
        'the anthropicGoogleCloud endpoint policy',
        endpointPolicyFor('anthropicGoogleCloud'),
      );
      expect(google).toMatchObject({ baseUrlVariables: ['ANTHROPIC_GOOGLE_CLOUD_BASE_URL'] });
      const foundry = observe('the foundry endpoint policy', endpointPolicyFor('foundry'));
      expect(foundry).toMatchObject({
        baseUrlVariables: ['ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE'],
      });
      // The two routes that declare no variable declare none.
      const firstParty = observe('the firstParty policy', endpointPolicyFor('firstParty'));
      expect(firstParty?.baseUrlVariables).toEqual([]);
      const gateway = observe('the gateway policy', endpointPolicyFor('gateway'));
      expect(gateway?.baseUrlVariables).toEqual([]);
      // The vendor-host patterns: every route that declares one recognises
      // its own vendor host and refuses a foreign one.
      const vendorHosts: ReadonlyArray<readonly [ProviderRoute, string]> = [
        ['bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com'],
        ['mantle', 'https://bedrock-mantle.us-east-1.api.aws'],
        ['anthropicAws', 'https://aws-external-anthropic.us-east-1.amazonaws.com'],
        ['vertex', 'https://aiplatform.googleapis.com'],
        ['anthropicGoogleCloud', 'https://claude.googleapis.com'],
        ['foundry', 'https://my-deployment.services.ai.azure.com/anthropic/'],
      ];
      for (const [route, baseUrl] of vendorHosts) {
        const variable = endpointPolicyFor(route)?.baseUrlVariables[0];
        if (variable === undefined) throw new Error(`${route} declares no base-URL variable`);
        const vendor = await observeCall(
          `the ${route} vendor base url`,
          resolveBaseUrl,
          [route, { [variable]: baseUrl }],
        );
        expect(vendor, `${route} does not recognise its own vendor host`).toMatchObject({
          isVendorHost: true,
        });
      }
      const foreign = observe(
        'the foreign base url',
        resolveBaseUrl('bedrock', { ANTHROPIC_BEDROCK_BASE_URL: 'https://example.invalid' }),
      );
      expect(foreign).toMatchObject({ isVendorHost: false });
      return measured(
        'match',
        "Every route's base-URL variable list and the vendor-host patterns are reproduced, in the audit's order.",
      );
    },
  },
  {
    rowId: 'F-10',
    title: 'F-10 the connection registry',
    command: reproduce('F-10 the connection registry'),
    pinning: {
      file: 'tests/contracts/provider-registry.test.ts',
      title: 'lists the connections it holds',
    },
    probe: async () => {
      const registry = await observeCall('the connection registry', createProviderRegistry, [
        [
          connectionOf(),
          connectionOf({ id: 'staging', name: 'Staging', route: 'bedrock' }),
          connectionOf({ id: 'edge', name: 'Edge', route: 'gateway' }),
        ],
      ]);
      const listed = await observeCall('the registry listing', registry.list, [], registry);
      expect(listed).toMatchObject([
        { id: 'prod', name: 'Prod', route: 'firstParty' },
        { id: 'staging', name: 'Staging', route: 'bedrock' },
        { id: 'edge', name: 'Edge', route: 'gateway' },
      ]);
      // Every connection carries a credential **reference**, never a value.
      expect(listed.every((connection) => connection.credential.kind === 'env')).toBe(true);
      return measured(
        'not-tested',
        "This implementation implements the project's own rule — N concurrent connections, each with a reference — and the clone's own contract tests pin it. The **target has no such registry**: it has a built-in catalog and one active route. There is therefore no target behaviour to compare this row against, and the row is reported as **not tested** rather than as a match.",
      );
    },
  },
  {
    rowId: 'F-11',
    title: 'F-11 credentials as references only',
    command: reproduce('F-11 credentials as references only'),
    pinning: {
      file: 'tests/security/provider-credentials.test.ts',
      title: 'never returns the credential value',
    },
    probe: async () => {
      await withTempDir(async (dir) => {
        const secret = 'sk-not-a-real-secret-value';
        const env = { PRRICODE_TEST_TOKEN: secret };
        const present = await observeCall(
          'the environment credential status',
          credentialStatus,
          [{ kind: 'env', name: 'PRRICODE_TEST_TOKEN' }, env],
        );
        expect(present).toBe('configured');
        const file = path.join(dir, 'token');
        writeFileSync(file, secret);
        const fromFile = observe(
          'the file credential status',
          await credentialStatus({ kind: 'file', path: file, format: 'raw' }, env),
        );
        expect(fromFile).toBe('configured');
        const absent = observe(
          'the absent credential status',
          await credentialStatus({ kind: 'env', name: 'PRRICODE_ABSENT' }, env),
        );
        expect(absent).toBe('missing');
        // The registry's listing resolves nothing and carries no secret.
        const registry = observe('the connection registry', createProviderRegistry([connectionOf()]));
        const listing = await observeCall('the registry listing', registry.list, [], registry);
        expect(JSON.stringify(listing)).not.toContain(secret);
        expect(listing).toMatchObject([{ id: 'prod' }]);
      });
      // The **five authentication flows** and the vocabularies around them.
    expect(observe('the auth flow kinds', AUTH_FLOW_KINDS)).toHaveLength(5);
    expect(Object.keys(observe('the auth flows', AUTH_FLOWS))).toHaveLength(5);
    expect(observe('the credential kinds', AUTH_CREDENTIALS)).toHaveLength(8);
    expect(observe('the login methods', LOGIN_METHODS)).toBeDefined();
    expect(observe('the first-party states', FIRST_PARTY_AUTH_STATES).length).toBeGreaterThan(0);
    expect(observe('the SEP-990 states', SEP990_AUTH_STATES).length).toBeGreaterThan(0);
    expect(observe('the MCP auth states', MCP_AUTH_STATES).length).toBeGreaterThan(0);
    expect(observe('the host/device/org states', HOST_DEVICE_ORG_AUTH_STATES).length).toBeGreaterThan(0);
    return measured(
        'not-tested',
        "This implementation implements the project's own rule — a credential is a reference and a status is presence only, never a secret — and the clone's own contract tests pin it. The **target has no such model**, so there is no target behaviour to compare this row against, and the row is reported as **not tested** rather than as a match.",
      );
    },
  },

  /* --- the request ------------------------------------------------------- */
  {
    rowId: 'F-12',
    title: 'F-12 request construction',
    command: reproduce('F-12 request construction'),
    pinning: {
      file: 'tests/contracts/drivers.test.ts',
      title: 'sets the anthropic version and the content type',
    },
    probe: async () => {
      const driver = await observeCall('the first-party driver', driverFor, ['firstParty']);
      const req = requestOf();
      // The URL: the target's path.
      const url = await observeCall('the request url', driver.buildUrl, [
        req,
        'https://api.anthropic.com',
      ]);
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      // The headers.
      const headers = observe('the request headers', driver.buildHeaders(req, 'sk-test'));
      expect(headers).toMatchObject({
        'anthropic-version': '2023-06-01',
        'user-agent': 'Anthropic/JS 2.1.303',
        'x-stainless-retry-count': '0',
      });
      // The body.
      const body = observe('the request body', driver.buildBody(req, 'sk-test'));
      expect(body.body).toMatchObject({ model: 'claude-sonnet-4-5', stream: true });
      // The authentication: the key reaches the request as the `x-api-key` header.
      expect(headers['x-api-key']).toBe('sk-test');
      return measured(
        'match',
        "The URL, the headers, the body and the authentication are the target's observed shapes.",
      );
    },
  },
  {
    rowId: 'F-13',
    title: 'F-13 retry timeout and error classification',
    command: reproduce('F-13 retry timeout and error classification'),
    pinning: {
      file: 'tests/contracts/drivers.test.ts',
      title: 'retries 408, 409, 429 and every 5xx',
    },
    probe: async () => {
      for (const status of [408, 409, 429, 500, 503]) {
        expect(await observeCall('the retryable status', isRetryableStatus, [status])).toBe(true);
      }
      for (const status of [400, 401, 403, 404]) {
        expect(await observeCall('the refused status', isRetryableStatus, [status])).toBe(false);
      }
      const statuses = observe('the retryable status set', RETRYABLE_STATUSES);
      expect([...statuses].sort((a, b) => a - b)).toEqual([408, 409, 429]);
      const fallback = observe('the non-streaming timeout fallback', NONSTREAMING_TIMEOUT_FALLBACK_MS);
      expect(fallback).toBe(600_000);
      const timeout = await observeCall(
        'the computed non-streaming timeout',
        calculateNonstreamingTimeoutMs,
        [1000, undefined],
      );
      expect(timeout).toBeGreaterThan(0);
      const classified = await observeCall('the classified error', classifyErrorStatus, [500, {}]);
      expect(classified).toMatchObject({ retryable: true });
      // The target's `shouldRetry` honours the `x-should-retry` header in
      // **both** directions, so the header overrides the status rules.
      const headerForces = observe(
        'the header-forced retry',
        classifyErrorStatus(500, {}, { headers: { 'x-should-retry': 'true' } }),
      );
      expect(headerForces.retryable).toBe(true);
      const headerRefuses = observe(
        'the header-forced refusal',
        classifyErrorStatus(429, {}, { headers: { 'x-should-retry': 'false' } }),
      );
      expect(headerRefuses.retryable).toBe(false);
      expect(
        observe('the header read', readHeader({ 'X-Should-Retry': 'false' }, 'x-should-retry')),
      ).toBe('false');
      // The target retries a `401` when the response used a **cached token**,
      // and the marker lives in the response body or in the error.
      expect(observe('the cached-token marker', cachedTokenRefreshed({ cached_token_refreshed: true }))).toBe(
        true,
      );
      expect(observe('the plain 401', classifyErrorStatus(401, {}).retryable)).toBe(false);
      expect(
        observe('the cached-token 401', classifyErrorStatus(401, { cached_token_refreshed: true }).retryable),
      ).toBe(true);
      expect(
        observe(
          'the cached-token 401 through the option',
          classifyErrorStatus(401, {}, { cachedTokenRefreshed: true }).retryable,
        ),
      ).toBe(true);
      return measured(
        'match',
        "The retry set, the 600000 ms fallback and the error classification are the target's observed rules, and so are the two the probe previously left uncompared: the `x-should-retry` response header is honoured in **both** directions and overrides the status rules, and a `401` is retried when the response used a cached token, the marker being read from the response body or from the error.",
      );
    },
  },
  {
    rowId: 'F-14',
    title: 'F-14 response parsing and streaming',
    command: reproduce('F-14 response parsing and streaming'),
    pinning: {
      file: 'tests/contracts/drivers.test.ts',
      title: 'parses a non-streaming body into the same events',
    },
    probe: async () => {
      const driver = await observeCall('the first-party driver', driverFor, ['firstParty']);
      const parsed = await observeCall('the parsed response', driver.parseNonStreaming, [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
        },
      ]);
      expect(parsed).toMatchObject({
        events: [{ type: 'message_start' }, { type: 'text_delta' }, { type: 'message_stop' }],
      });
      // The SSE vocabulary the audit names: the core events, and the extended
      // `agent.*` / `session.*` / `span.*` / `user.*` ones the SDK tolerates.
      // The SDK's default `parseResponse`, in full: its branch set is exactly
      // a `204`, the binary response, the JSON body with its empty-body
      // branch, and the text fallback.
      const responseOf = (
        status: number,
        headers: Record<string, string>,
        body: unknown,
      ): ProviderResponseLike => ({
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] },
        json: async () => body,
        text: async () => JSON.stringify(body),
      });
      const noContent = await observeCall('the 204 response', parseResponse, [
        responseOf(204, {}, {}),
      ]);
      expect(noContent).toBeNull();
      const binary = responseOf(200, { 'content-type': 'application/octet-stream' }, {});
      expect(
        await observeCall('the binary response', parseResponse, [binary, { binaryResponse: true }]),
      ).toBe(binary);
      const empty = await observeCall('the empty JSON body', parseResponse, [
        responseOf(200, { 'content-type': 'application/json', 'content-length': '0' }, {}),
      ]);
      expect(empty).toBeUndefined();
      const message = await observeCall('the JSON body', parseResponse, [
        responseOf(200, { 'content-type': 'application/json' }, { id: 'msg_1', content: [] }),
      ]);
      expect(message).toMatchObject({ id: 'msg_1' });
      // The two **non-enumerable** members `buildMessage` attaches.
      const attached = message as { _request_id?: string; _workspace_id?: string };
      expect(Object.keys(attached)).not.toContain('_request_id');
      expect(Object.keys(attached)).not.toContain('_workspace_id');
      const withIds = (await observeCall('the JSON body with identifiers', parseResponse, [
        responseOf(
          200,
          {
            'content-type': 'application/json',
            'request-id': 'req_1',
            'anthropic-workspace-id': 'ws_1',
          },
          { id: 'msg_1', content: [] },
        ),
      ])) as { _request_id?: string; _workspace_id?: string };
      expect(withIds._request_id).toBe('req_1');
      expect(withIds._workspace_id).toBe('ws_1');
      expect(Object.keys(withIds)).not.toContain('_request_id');
      // The content-type test: `application/json` or `*+json`, the parameters
      // stripped.
      expect(observe('the JSON content type', isJsonContentType('application/json'))).toBe(true);
      expect(observe('the JSON suffix content type', isJsonContentType('application/vnd+json'))).toBe(true);
      expect(observe('the parameterised content type', isJsonContentType('application/json; charset=utf-8'))).toBe(
        true,
      );
      expect(observe('the plain content type', isJsonContentType('text/plain'))).toBe(false);

      const streamed = await observeCall('the streamed events', driver.parseStream, [
        'event: agent.tool_use\ndata: {"type":"agent.tool_use","id":"toolu_1","name":"Echo","input":{}}\n\n',
        {},
      ]);
      expect(streamed).toMatchObject({ events: [{ type: 'tool_use', id: 'toolu_1' }] });
      return measured(
        'match',
        "The non-streaming body and the SSE stream parse into the same events, the SDK's extended agent.* vocabulary is tolerated, and the SDK's default `parseResponse` is reproduced in full: a `204` is null, a binary response is the raw response, a JSON body with a `content-length` of zero is undefined, a JSON body is the built message with the two non-enumerable identifiers attached, and anything else is the text. The content-type test is `application/json` or `*+json`, the parameters stripped.",
      );
    },
  },
  {
    rowId: 'F-15',
    title: 'F-15 the local gateway',
    command: reproduce('F-15 the local gateway'),
    pinning: {
      file: 'tests/contracts/drivers.test.ts',
      title: 'sets the anthropic version and the content type',
    },
    probe: async () => {
      const headers = observe(
        'the gateway headers',
        gatewayDriver.buildHeaders(requestOf(), undefined),
      );
      expect(headers['user-agent']).toContain('cc-gateway/2.1.303');
      expect(
        observe('the workspace-id rejection', gatewayRejectsWorkspaceId({ workspace_id: 'w' })),
      ).toBe(true);
      expect(observe('the accepted body', gatewayRejectsWorkspaceId({ model: 'm' }))).toBe(false);
      // The count-tokens path: a Bedrock upstream is counted locally, every other
      // upstream is answered `501 not_supported` with `x-should-retry: false`.
      const local = await observeCall('the local count-tokens answer', gatewayCountTokensResponse, [
        'bedrock',
        { messages: [{ role: 'user', content: 'hello' }] },
      ]);
      expect(local).toMatchObject({ status: 200, headers: {} });
      expect(local.body['input_tokens']).toBeGreaterThan(0);
      const unsupported = observe(
        'the unsupported count-tokens answer',
        gatewayCountTokensResponse('firstParty', { messages: [] }),
      );
      expect(unsupported).toMatchObject({
        status: 501,
        headers: { 'x-should-retry': 'false' },
      });
      return measured(
        'match',
        "The gateway user agent, the workspace-id rejection and the count-tokens path — local for a Bedrock upstream, `501 not_supported` otherwise — are the target's observed behaviour.",
      );
    },
  },
  {
    rowId: 'F-15b',
    title: 'F-15b the transport the retry loop and sigv4',
    command: reproduce('F-15b the transport the retry loop and sigv4'),
    pinning: {
      file: 'tests/contracts/provider-transport.test.ts',
      title: 'signs with the service name the driver wrote into the request, not a constant',
    },
    probe: async () => {
      expect(observe('the bedrock sigv4 service', BEDROCK_SIGV4_SERVICE)).toBe('bedrock');
      expect(observe('the mantle sigv4 service', MANTLE_SIGV4_SERVICE)).toBe('bedrock-mantle');
      const bedrock = await observeCall(
        'the bedrock signing scope',
        signingScope,
        ['20240101', 'us-east-1', BEDROCK_SIGV4_SERVICE],
      );
      expect(bedrock).toBe('20240101/us-east-1/bedrock/aws4_request');
      const mantle = await observeCall(
        'the mantle signing scope',
        signingScope,
        ['20240101', 'us-east-1', MANTLE_SIGV4_SERVICE],
      );
      expect(mantle).toBe('20240101/us-east-1/bedrock-mantle/aws4_request');
      return measured(
        'match',
        "The two SigV4 service names and the region are the target's observed values. The signing scope string this implementation builds is the standard AWS form, not an observed value: the audit observes the service names and the region, not the scope's shape.",
      );
    },
  },

  /* --- the agent --------------------------------------------------------- */
  {
    rowId: 'F-16',
    title: 'F-16 the agent turn and its continuation',
    command: reproduce('F-16 the agent turn and its continuation'),
    pinning: {
      file: 'tests/contracts/agent-loop.test.ts',
      title: 'a denied call is refused, answered with a tool_use_error, and ends the turn',
    },
    probe: async () => {
      // The **real** refusal path: this implementation's own runner refuses the call, and
      // this implementation's own agent loop answers it with the wrapper.
      const registry = await observeCall('the tool registry', createToolRegistry, []);
      registry.register({
        name: 'Echo',
        description: 'echo',
        inputSchema: {},
        mutatesFiles: false,
        checkPermissions: async () => ({
          behavior: 'deny',
          source: 'hook',
          reasonType: 'rule',
        }),
        validateInput: async () => ({ ok: true }),
        recheckPermission: async () => ({ decision: undefined, ok: true }),
        execute: async () => 'never runs',
      });
      const refused = await observeCall('the refused call', runTool, [
        registry,
        'Echo',
        {},
        { toolName: 'Echo', input: {}, toolUseId: 'toolu_1', sessionId: 's1' },
      ]);
      expect(refused).toMatchObject({ isError: true, nonExecutionKind: 'permission_denied' });
      const answered = observe('the refusal answer', refusalEnvelope(refused));
      expect(answered).toMatchObject({ isError: true });
      expect(answered.content).toContain('<tool_use_error>');
      expect(answered.content).toContain('</tool_use_error>');
      // The wording inside the wrapper is this implementation's own, and it carries the
      // decision and its reason type.
      expect(answered.content).toContain("The permission decision was 'deny'");
      expect(answered.content).toContain('source: hook');
      expect(answered.content).toContain('reason type: rule');

      // --- The turn request (audit §2.4) ------------------------------------
      //
      // The agent turn is a **streaming** `beta.messages.create`, and the body
      // is the driver's own: the model, the output-token budget, the
      // conversation and the tools the registry holds.
      const driver = await observeCall('the first-party driver', driverFor, ['firstParty']);
      const conversation: ProviderMessage[] = [];
      await observeCall('the prompt', pushUserText, [conversation, 'hello']);
      const offered = await observeCall('the tools the model may call', buildProviderTools, [
        registry,
      ]);
      const turn = await observeCall('the turn request', buildProviderRequest, [
        { model: 'claude-sonnet-4-5', maxTokens: 1024, messages: conversation, tools: offered },
      ]);
      expect(observe('the turn stream', turn.stream)).toBe(true);
      // The endpoint the turn goes to, and the header set it carries: the
      // target's call site is `client.beta.messages.create({ ...req, stream:
      // true }, { signal, headers })`.
      const turnUrl = await observeCall('the turn url', driver.buildUrl, [
        turn,
        'https://api.anthropic.com',
      ]);
      expect(turnUrl).toBe('https://api.anthropic.com/v1/messages');
      const turnBuilt = await observeCall('the turn body', driver.buildBody, [turn, 'sk-test']);
      expect(observe('the turn headers', turnBuilt.headers)).toMatchObject({
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      });
      const turnBody = observe('the turn body', turnBuilt.body);
      expect(turnBody).toMatchObject({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'Echo', description: 'echo', input_schema: {} }],
      });

      // --- The continuation (audit §2.4) ------------------------------------
      //
      // The next model request carries the assistant's tool calls and the tool
      // results that answer them. The refusal's answer is the
      // `<tool_use_error>` wrapper, and a result that did not fail carries no
      // `is_error` member at all.
      await observeCall('the assistant turn', pushAssistant, [
        conversation,
        [
          { type: 'tool_use', id: 'toolu_1', name: 'Echo', input: {} },
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { path: '/tmp/probe' } },
        ],
      ]);
      const refusedBlock = toolResultBlockOf(
        await observeCall('the refusal result block', providerToolResultBlock, [
          'toolu_1',
          answered.content,
          true,
        ]),
      );
      expect(refusedBlock).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        is_error: true,
      });
      expect(observe('the refusal result content', refusedBlock.content)).toContain(
        '<tool_use_error>',
      );
      const ranBlock = toolResultBlockOf(
        await observeCall('the result block', providerToolResultBlock, [
          'toolu_2',
          'the file was read',
          false,
        ]),
      );
      expect(ranBlock).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_2' });
      expect(ranBlock).not.toHaveProperty('is_error');
      await observeCall('the tool results', pushToolResults, [
        conversation,
        [refusedBlock, ranBlock],
      ]);
      const continuation = await observeCall('the continuation request', buildProviderRequest, [
        { model: 'claude-sonnet-4-5', maxTokens: 1024, messages: conversation, tools: offered },
      ]);
      const continuationBuilt = await observeCall('the continuation body', driver.buildBody, [
        continuation,
        'sk-test',
      ]);
      const continuationBody = observe('the continuation body', continuationBuilt.body);
      expect(continuationBody).toMatchObject({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        stream: true,
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'Echo' },
              { type: 'tool_use', id: 'toolu_2', name: 'Read' },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true },
              { type: 'tool_result', tool_use_id: 'toolu_2' },
            ],
          },
        ],
      });

      // --- The scheduling the continuation depends on (audit §2.4) ----------
      //
      // The next model request is issued only after **every** call of that
      // assistant message has produced its result, so the schedule has to
      // cover every call: a maximal run of concurrency-safe calls runs
      // together, a call that is not concurrency safe runs alone and is a
      // barrier, and the run after it starts fresh.
      const calls = [
        { id: 'toolu_a', name: 'Read', input: {} },
        { id: 'toolu_b', name: 'Read', input: {} },
        { id: 'toolu_c', name: 'Bash', input: { command: 'ls' } },
        { id: 'toolu_d', name: 'Read', input: {} },
      ];
      const scheduled = await observeCall('the scheduled groups', scheduleToolCalls, [
        calls,
        (call: { readonly name: string }) => call.name === 'Read',
      ]);
      expect(scheduled).toMatchObject([
        { ids: ['toolu_a', 'toolu_b'], parallel: true },
        { ids: ['toolu_c'], parallel: false },
        { ids: ['toolu_d'], parallel: true },
      ]);
      expect(scheduled).toHaveLength(3);
      return measured(
        'match',
        "A refused call is answered with the target's observed <tool_use_error> wrapper and is_error: true, and the wrapper carries the decision and its reason type; the wording inside the wrapper is this implementation's own. The **turn request** is compared too: the runtime builds the Anthropic-shaped request the target issues — a **streaming** messages request — and the driver builds its URL, its header set and its body, with the model, the output-token budget, the conversation and the tools the registry holds. The **continuation** is compared: the runtime appends the assistant's tool calls and the tool results that answer them, and the next body carries the `tool_use` blocks and the `tool_result` blocks — the refusal's <tool_use_error> answer with `is_error: true`, and a result that did not fail with no `is_error` member at all. The **scheduling** the continuation depends on is compared: a maximal run of concurrency-safe calls runs together, a call that is not concurrency safe runs alone and is a barrier, the run after it starts fresh, and the schedule covers every call of the assistant message — the next model request is issued only after every one of them has produced its result. A request's own beta dialect is F-12's row, and the abort signal is the runtime's rather than the request's.",
      );
    },
  },
  {
    rowId: 'F-17',
    title: 'F-17 tool-call scheduling order',
    command: reproduce('F-17 tool-call scheduling order'),
    pinning: {
      file: 'tests/contracts/agent-loop.test.ts',
      title: 'collects the tool calls of a turn in the order they appear',
    },
    probe: async () => {
      // This implementation dispatches the calls of a turn in the order they appear, and
      // a sequential plan gives every call its own group; the target's
      // concurrent order is a bounded REA residual.
      const calls = await observeCall(
        'the turn tool calls',
        toolCallsFrom,
        [
          [
            { type: 'message_start', messageId: 'msg_01', model: 'test-model' },
            { type: 'tool_use', id: 'toolu_a', name: 'First', input: { n: 1 } },
            { type: 'text_delta', text: 'thinking' },
            { type: 'tool_use', id: 'toolu_b', name: 'Second', input: { n: 2 } },
            { type: 'message_stop', stopReason: 'tool_use' },
          ],
        ],
      );
      expect(calls.map((call) => call.id)).toEqual(['toolu_a', 'toolu_b']);
      // The target's rule: a call that is **concurrency safe** runs in
      // parallel with the run of safe calls before it, and a call that is
      // **not** concurrency safe stands alone and stops the run.
      // A registry with one **concurrency-safe** tool and one that is not:
      // the safe one joins the run of safe calls, the unsafe one stands alone
      // and stops the run.
      const registry = await observeCall('the tool registry', createToolRegistry, []);
      await observeCall('the safe tool', registry.register, [
        {
          name: 'First',
          description: 'a tool that declares itself concurrency safe',
          inputSchema: { type: 'object', properties: {} },
          isConcurrencySafe: () => true,
        },
      ]);
      await observeCall('the second safe tool', registry.register, [
        {
          name: 'Second',
          description: 'another tool that declares itself concurrency safe',
          inputSchema: { type: 'object', properties: {} },
          isConcurrencySafe: () => true,
        },
      ]);
      const scheduled = await observeCall('the scheduled groups', scheduleToolCallsWithRegistry, [
        calls,
        registry,
      ]);
      expect(scheduled).toMatchObject([
        { ids: ['toolu_a', 'toolu_b'], parallel: true },
      ]);
      // With the safe tool swapped for the unsafe one, the run stops at it.
      const barrierRegistry = await observeCall('the barrier registry', createToolRegistry, []);
      await observeCall('the barrier tool', barrierRegistry.register, [
        {
          name: 'First',
          description: 'a tool that declares itself concurrency safe',
          inputSchema: { type: 'object', properties: {} },
          isConcurrencySafe: () => true,
        },
      ]);
      await observeCall('the other barrier tool', barrierRegistry.register, [
        {
          name: 'Second',
          description: 'a tool that does not',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      const withABarrier = await observeCall(
        'the scheduled groups with a barrier',
        scheduleToolCallsWithRegistry,
        [calls, barrierRegistry],
      );
      expect(withABarrier).toMatchObject([
        { ids: ['toolu_a'], parallel: true },
        { ids: ['toolu_b'], parallel: false },
      ]);
      // A tool that does **not** declare the flag is **not** concurrency safe:
      // the target's own default.
      const undeclared = observe('the undeclared flag', isToolConcurrencySafe(undefined, {}));
      expect(undeclared).toBe(false);
      return measured(
        'match',
        "The target's scheduling is reproduced: a call that is concurrency safe runs in parallel with the run of safe calls before it, a call that is not concurrency safe stands alone and stops the run, a tool that does not declare the flag is not concurrency safe, and the next model request waits for every call's result.",
      );
    },
  },
  {
    rowId: 'F-17b',
    title: 'F-17b the projected tool-result content is a string',
    command: reproduce('F-17b the projected tool-result content is a string'),
    pinning: {
      file: 'tests/contracts/tool-result-projection.test.ts',
      title: 'carries no is_error member on a success',
    },
    probe: async () => {
      const success = await observeCall(
        'the projected success block',
        providerToolResultBlock,
        ['toolu_1', 'ok', false],
      );
      expect(toolResultBlockOf(success)).toMatchObject({
        tool_use_id: 'toolu_1',
        type: 'tool_result',
        content: 'ok',
      });
      expect('is_error' in toolResultBlockOf(success)).toBe(false);
      const failure = observe(
        'the projected failure block',
        providerToolResultBlock('toolu_2', 'bad', true),
      );
      expect(toolResultBlockOf(failure)).toMatchObject({
        tool_use_id: 'toolu_2',
        content: 'bad',
        is_error: true,
      });
      const content = observe('the projected content', toolResultContent('plain'));
      expect(typeof content).toBe('string');
      return measured(
        'match',
        'The projected block is `{tool_use_id, type, content:<string>}` with `is_error: true` added only for a failure.',
      );
    },
  },
  {
    rowId: 'F-18',
    title: 'F-18 tool-result shaping and permission feedback',
    command: reproduce('F-18 tool-result shaping and permission feedback'),
    pinning: {
      file: 'tests/contracts/tool-registry.test.ts',
      title: 'produces an error envelope with the decision attached when the check denies',
    },
    probe: async () => {
      // This implementation's **actual** envelope: the runner refuses the call and the
      // decision rides along in the tool result.
      const registry = await observeCall('the tool registry', createToolRegistry, []);
      registry.register({
        name: 'Echo',
        description: 'echo',
        inputSchema: {},
        mutatesFiles: false,
        checkPermissions: async () => ({
          behavior: 'deny',
          source: 'hook',
          reasonType: 'rule',
        }),
        validateInput: async () => ({ ok: true }),
        recheckPermission: async () => ({ decision: undefined, ok: true }),
        execute: async () => 'never runs',
      });
      const envelope = await observeCall(
        'the refusal envelope',
        runTool,
        [
          registry,
          'Echo',
          {},
          { toolName: 'Echo', input: {}, toolUseId: 'toolu_1', sessionId: 's1' },
        ],
      );
      // The audit observes the target's metadata as
      // `permission_decision {decision, source, reason_type}`,
      // `non_execution_kind` and `user_feedback` (§2.4).
      // The envelope carries the **target's** member names: the tool-use id, the
      // non-execution kind, the user feedback, the remedy and the permission
      // decision — and the decision's own members are the target's three.
      const decision = observe('the permission decision', envelope.permission_decision);
      expect(decision).toMatchObject({ decision: 'deny', source: 'hook', reason_type: 'rule' });
      const members = observe('the decision members', Object.keys(decision ?? {}));
      expect(members).toEqual(['decision', 'source', 'reason_type']);
      const envelopeMembers = observe('the envelope members', Object.keys(envelope));
      expect(envelopeMembers).toEqual([
        'id',
        'content',
        'isError',
        'non_execution_kind',
        'permission_decision',
        'remedy',
      ]);
      expect(envelopeMembers).not.toContain('toolUseId');
      expect(envelopeMembers).not.toContain('permissionDecision');
      expect(envelopeMembers).not.toContain('nonExecutionKind');
      return measured(
        'match',
        "The permission feedback rides along in the tool result under the target's own member names: the tool-use id, the non-execution kind, the user feedback, the remedy, and the permission decision with its three members.",
      );
    },
  },

  /* --- the permissions --------------------------------------------------- */
  {
    rowId: 'F-19',
    title: 'F-19 the permission decision vocabulary',
    command: reproduce('F-19 the permission decision vocabulary'),
    pinning: {
      file: 'tests/contracts/permission-decision.test.ts',
      title: 'uses only the closed behavior, source and reason-type vocabularies',
    },
    probe: async () => {
      // The behaviour vocabulary, enumerated by this implementation's own strictness table.
      const strictness = observe('the behaviour vocabulary', PERMISSION_STRICTNESS);
      expect([...strictness.keys()].sort()).toEqual(['allow', 'ask', 'deny']);
      // The strictness is an ordering, not just a set: deny is stricter than
      // ask, and ask is stricter than allow. A wrong ordering would let a
      // weaker decision win.
      expect(observe('deny strictness', strictness.get('deny'))).toBeGreaterThan(
        observe('ask strictness', strictness.get('ask') as number),
      );
      expect(observe('ask strictness', strictness.get('ask'))).toBeGreaterThan(
        observe('allow strictness', strictness.get('allow') as number),
      );
      // The source vocabulary: every source the audit names is carried through
      // the prompt, unchanged, and every one of them is in the closed set.
      const sources = [
        'classifier',
        'hook',
        'user_permanent',
        'user_temporary',
        'user_abort',
        'user_reject',
        'unknown',
      ] as const;
      for (const source of sources) {
        const answered = await observeCall(
          `the ${source} decision`,
          checkPermission,
          [
            { toolName: 'Bash', input: { command: 'ls -l' }, toolUseId: 't1', sessionId: 's1' },
            {
              rules: rulesOf(),
              mode: 'default',
              canUseTool: async () => ({
                behavior: 'allow',
                source,
                reasonType: 'other',
              }),
            },
          ],
        );
        expect(answered).toMatchObject({ behavior: 'allow', source, reasonType: 'other' });
      }
      // The reason-type vocabulary.
      for (const reasonType of ['rule', 'safetyCheck', 'other'] as const) {
        const answered = observe(
          `the ${reasonType} decision`,
          await checkPermission(
            { toolName: 'Bash', input: { command: 'ls -l' }, toolUseId: 't1', sessionId: 's1' },
            {
              rules: rulesOf(),
              mode: 'default',
              canUseTool: async () => ({
                behavior: 'allow',
                source: 'hook',
                reasonType,
              }),
            },
          ),
        );
        expect(answered).toMatchObject({ reasonType });
      }
      return measured(
        'match',
        "The behaviour, source and reason-type vocabularies are the target's closed sets: this implementation's own strictness table enumerates the three behaviours, and every one of the target's seven sources and three reason types is carried through the prompt unchanged.",
      );
    },
  },
  {
    rowId: 'F-20',
    title: 'F-20 rule precedence and the modes',
    command: reproduce('F-20 rule precedence and the modes'),
    pinning: {
      file: 'tests/security/permission-rules.test.ts',
      title: 'lets a broad deny beat a narrower allow',
    },
    probe: async () => {
      const ctx = {
        toolName: 'Bash',
        input: { command: 'rm -rf /tmp/x' },
        toolUseId: 't1',
        sessionId: 's1',
      };
      // The **observed** precedence: deny wins over allow.
      const denied = await observeCall(
        'the deny-over-allow decision',
        checkPermission,
        [
          ctx,
          {
            rules: rulesOf({ deny: ['Bash(rm *)'], allow: ['Bash(rm -rf /tmp/x)'] }),
            mode: 'default',
          },
        ],
      );
      expect(denied).toMatchObject({ behavior: 'deny' });
      // Deny blocks in every mode; allow has no effect in `bypassPermissions`.
      for (const mode of [
        'default',
        'acceptEdits',
        'plan',
        'auto',
        'dontAsk',
        'bypassPermissions',
      ] as const) {
        const decision = observe(
          `the ${mode} decision`,
          await checkPermission(ctx, {
            rules: rulesOf({ deny: ['Bash(rm *)'] }),
            mode,
          }),
        );
        expect(decision).toMatchObject({ behavior: 'deny' });
      }
      // The target's own order — deny, then ask, then allow — is measured, and it
      // is the target's: a command in two lists is decided by the **earlier** one.
      const asked = observe(
        'the ask-over-allow decision',
        await checkPermission(ctx, {
          rules: rulesOf({ ask: ['Bash(rm *)'], allow: ['Bash(rm *)'] }),
          mode: 'default',
        }),
      );
      expect(asked).toMatchObject({ behavior: 'ask' });
      // A deny beats an ask, in **every** mode: the mode does not change the order.
      for (const mode of [
        'default',
        'acceptEdits',
        'plan',
        'auto',
        'dontAsk',
        'bypassPermissions',
      ] as const) {
        const decision = observe(
          `the ${mode} deny-over-ask decision`,
          await checkPermission(ctx, {
            rules: rulesOf({ deny: ['Bash'], ask: ['Bash'] }),
            mode,
          }),
        );
        expect(decision).toMatchObject({ behavior: 'deny' });
      }
      // An ask rule holds where the mode would otherwise allow.
      expect(
        observe(
          'the ask under bypass',
          await checkPermission(ctx, { rules: rulesOf({ ask: ['Bash'] }), mode: 'bypassPermissions' }),
        ),
      ).toMatchObject({ behavior: 'ask' });
      expect(
        observe(
          'the ask under acceptEdits',
          await checkPermission(ctx, { rules: rulesOf({ ask: ['Bash'] }), mode: 'acceptEdits' }),
        ),
      ).toMatchObject({ behavior: 'ask' });
      // And in `auto` it is a **denial**, because the check is one only a person
      // may answer, and the auto mode asks no one.
      expect(
        observe(
          'the ask under auto',
          await checkPermission(ctx, { rules: rulesOf({ ask: ['Bash'] }), mode: 'auto' }),
        ),
      ).toMatchObject({ behavior: 'deny' });
      return measured(
        'match',
        "The precedence is the target's, and it is compared: the lists are consulted deny, then ask, then allow, so a command in two lists is decided by the earlier one, and the mode does not change the order — a deny beats an ask in every mode. An ask rule holds where the mode would otherwise allow, and in `auto` it is a **denial**, because the check is one only a person may answer. Deny wins over allow, and a deny blocks in every mode this implementation has, the five the audit names and a sixth of its own.",
      );
    },
  },
  {
    rowId: 'F-21',
    title: 'F-21 the reason kinds and the file-mutating set',
    command: reproduce('F-21 the reason kinds and the file-mutating set'),
    pinning: {
      file: 'tests/contracts/permission-decision.test.ts',
      title: 'names the tool for a permission-prompt-tool reason',
    },
    probe: async () => {
      const mutating = observe('the file-mutating tool set', FILE_MUTATING_TOOLS);
      expect([...mutating].sort()).toEqual(['Edit', 'NotebookEdit', 'Write']);
      expect(observe('the Edit membership', isFileMutatingTool('Edit'))).toBe(true);
      expect(observe('the Read membership', isFileMutatingTool('Read'))).toBe(false);
      // The reason kinds the audit observes, each one produced by this implementation.
      const rule = await observeCall(
        'the rule decision',
        checkPermission,
        [
          { toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, toolUseId: 't1', sessionId: 's1' },
          { rules: rulesOf({ deny: ['Bash(rm *)'] }), mode: 'default' },
        ],
      );
      expect(rule).toMatchObject({ behavior: 'deny', reasonKind: 'rule' });
      const subcommand = observe(
        'the subcommand decision',
        await checkPermission(
          {
            toolName: 'Bash',
            input: { command: 'ls -l && rm -rf /tmp/x' },
            toolUseId: 't1',
            sessionId: 's1',
          },
          { rules: rulesOf({ allow: ['Bash(ls -l)'] }), mode: 'default' },
        ),
      );
      expect(subcommand).toMatchObject({ behavior: 'ask', reasonKind: 'subcommandResults' });
      const unmatched = observe(
        'the unmatched decision',
        await checkPermission(
          { toolName: 'Bash', input: { command: 'ls' }, toolUseId: 't1', sessionId: 's1' },
          { rules: rulesOf(), mode: 'default' },
        ),
      );
      // This implementation adds a seventh kind, `noRuleMatch`, to the target's six.
      // The vocabulary is exactly the target's six. The one distinction this
    // implementation still needs — that no rule matched — is carried by a
    // **marker**, not by a seventh kind.
    expect(unmatched).toMatchObject({ reasonKind: 'permissionPromptTool' });
    expect(unmatched).toMatchObject({ noRuleMatched: true });
      return measured(
        'match',
        "The file-mutating set is exactly Edit, Write and NotebookEdit, and the reason vocabulary is exactly the target's six kinds; the one distinction this implementation still needs — that no rule matched — is carried by a marker on the decision, not by a seventh kind.",
      );
    },
  },
  {
    rowId: 'F-22',
    title: 'F-22 the host-level gates',
    command: reproduce('F-22 the host-level gates'),
    pinning: {
      file: 'tests/security/permission-rules.test.ts',
      title: 'denies every call when the personal configuration has problems and the restriction is set',
    },
    probe: async () => {
      const ctx = {
        toolName: 'Bash',
        input: { command: 'ls' },
        toolUseId: 't1',
        sessionId: 's1',
      };
      const gated = await observeCall(
        'the gated decision',
        checkPermission,
        [ctx, {
          rules: rulesOf({ allow: ['Bash(ls *)'] }),
          mode: 'default',
          hostGate: {
            blocked: true,
            reason: 'the personal configuration has problems',
            paths: ['/home/u/.claude/settings.json'],
          },
        }],
      );
      expect(gated).toMatchObject({ behavior: 'deny' });
      // The host-gate reason and the affected paths must survive into the
      // denial, so the user can see why and where.
      expect(String(gated.reason ?? '')).toContain('the personal configuration has problems');
      const stopped = observe(
        'the stopped decision',
        await checkPermission(ctx, {
          rules: rulesOf({ allow: ['Bash(ls *)'] }),
          mode: 'default',
          hookFailure: { severity: 'stop', message: 'a hook failed' },
        }),
      );
      expect(stopped).toMatchObject({ behavior: 'deny' });
      expect(String(stopped.reason ?? '')).toBe('A problem with your own settings or hooks is blocking tool calls');
      return measured(
        'match',
        'The personal-config restriction and the `stop`-severity hook failure both deny every call.',
      );
    },
  },
  {
    rowId: 'F-23',
    title: 'F-23 the remote permission transport',
    command: reproduce('F-23 the remote permission transport'),
    pinning: {
      file: 'tests/contracts/mcp-control.test.ts',
      title: 'drops a can_use_tool request whose request_id is not a string, with no response',
    },
    probe: async () => {
      // The dispatcher refuses the agent-originated subtypes by direction.
      const agent = await observeCall(
        'the agent-originated refusal',
        controlRequestDirectionError,
        ['can_use_tool'],
      );
      expect(agent).toBe('can_use_tool is agent-originated and cannot be sent by a host');
      const tasks = observe(
        'the service-originated refusal',
        controlRequestDirectionError('mcp_tasks_changed'),
      );
      expect(tasks).toBe(
        'mcp_tasks_changed is sent to a cloud agent by the service, not by a host',
      );
      expect(observe('the accepted subtype', controlRequestDirectionError('initialize'))).toBeUndefined();
      const originated = observe('the agent-originated subtypes', AGENT_ORIGINATED_CONTROL_SUBTYPES);
      expect(originated).toContain('can_use_tool');
      // The dropped request: a `can_use_tool` request whose `request_id` is not
      // a string cannot be correlated, so it is dropped with **no response**.
      const dropped = await observeCall(
        'the dropped request',
        dispatchCanUseTool,
        [{ request_id: 42, tool_name: 'Bash', input: { command: 'ls' } }, {}],
      );
      expect(dropped).toMatchObject({
        dropped: true,
        reason: 'the request_id is not a string, so no response is possible',
      });
      expect(dropped.response).toBeUndefined();
      return measured(
        'match',
        "The transport dispatcher's shape, its dropped non-string request id and its direction rules are reproduced. Measured: the dispatcher's shape, the dropped request id and the direction rules. The malformed-deny classification, the in-flight de-duplication and the trust and folder validation are established by the audit and implemented here, but this probe does not compare them.",
      );
    },
  },

  /* --- the sessions ------------------------------------------------------ */
  {
    rowId: 'F-24',
    title: 'F-24 the session storage layout',
    command: reproduce('F-24 the session storage layout'),
    pinning: {
      file: 'tests/contracts/session-store.test.ts',
      title: 'keeps the transcript under <configDir>/projects/<encoded-cwd>/<sessionId>.jsonl',
    },
    probe: async () => {
      await withTempDir(async (dir) => {
        const store = await observeCall('the session store', createSessionStore, [
          { configDir: dir },
        ]);
        const handle = observe('the session handle', await store.create({ cwd: '/home/u/project' }));
        await store.append(handle, {
          v: SESSION_SCHEMA_VERSION,
          t: 'user_message',
          ts: 1,
          id: 'r1',
          text: 'hello',
        });
        expect(existsSync(path.join(dir, 'projects'))).toBe(true);
        const events = await observeCall('the transcript records', readAllSessionEvents, [
          handle.path,
        ]);
        expect(events).toMatchObject([{ t: 'user_message', id: 'r1', text: 'hello' }]);
        // This implementation's own versioned record format, and the target's observed
        // `transcriptSource` marker, which this implementation does not expose.
        expect(events[0]?.v).toBe(SESSION_SCHEMA_VERSION);
        // Every record the store writes carries the target's transcript source.
    expect(events.every((event) => 'transcriptSource' in event)).toBe(true);
    expect(events[0]?.transcriptSource).toBe('local-jsonl');
      });
      return measured(
        'match',
        "The layout — JSONL under <configDir>/projects/<project>/<sessionId>.jsonl, with the project name derived from the working directory — is reproduced, and every record carries the target's transcript source marker.",
      );
    },
  },
  {    rowId: 'F-25',
    title: 'F-25 resume semantics',
    command: reproduce('F-25 resume semantics'),
    pinning: {
      file: 'tests/contracts/session-resume.test.ts',
      title: 'reconstructs the branch that ends at the newest leaf, not the one written last',
    },
    probe: async () => {
      // The exact-title match, and the ambiguity error that lists the candidates.
      const summaries = [
        {
          sessionId: 'session_a',
          path: '/tmp/a.jsonl',
          startedAt: 1,
          updatedAt: 2,
          modifiedAt: 2,
          messageCount: 1,
          title: 'the title',
        },
        {
          sessionId: 'session_b',
          path: '/tmp/b.jsonl',
          startedAt: 1,
          updatedAt: 3,
          modifiedAt: 3,
          messageCount: 1,
          title: 'the title',
        },
      ];
      const exact = await observeCall('the exact title match', resolveSessionTarget, [
        [summaries[0]!],
        'the title',
      ]);
      expect(exact).toMatchObject({ kind: 'found' });
      const ambiguous = observe(
        'the ambiguous title',
        resolveSessionTarget(summaries, 'the title'),
      );
      expect(ambiguous.kind).toBe('ambiguous');
      // The ambiguity error lists the candidates with their modification
      // times.
      if (ambiguous.kind !== 'ambiguous') throw new Error('unreachable');
      expect(ambiguous.candidates.map((candidate) => candidate.sessionId)).toEqual([
        'session_a',
        'session_b',
      ]);
      expect(ambiguous.message).toContain('matches 2 sessions');
      expect(ambiguous.message).toContain('session_a');
      expect(ambiguous.message).toContain('session_b');
      const unknown = observe('the unknown title', resolveSessionTarget(summaries, 'nope'));
      expect(unknown.kind).toBe('not_found');
      // The drop guard: a resume that would split a tool turn is refused.
      const events: SessionEvent[] = [
        { v: SESSION_SCHEMA_VERSION, t: 'user_message', ts: 1, id: 'm1', text: 'one' },
        { v: SESSION_SCHEMA_VERSION, t: 'tool_call', ts: 2, id: 'toolu_1', name: 'Echo', input: {} },
        {
          v: SESSION_SCHEMA_VERSION,
          t: 'tool_result',
          ts: 3,
          id: 'r1',
          envelope: { toolUseId: 'toolu_1', content: 'ok', isError: false },
        },
      ];
      const refused = observe('the guarded resume', resumeAtMessage(events, 'toolu_1'));
      expect(refused.kind).toBe('refused');
      expect(refused.kind === 'refused' ? refused.reason : '').toBe('drop_guard_refused');
      const missing = observe('the missing message', resumeAtMessage(events, 'nope'));
      expect(missing.kind === 'refused' ? missing.reason : '').toBe('processing_error');
      // The resume point and the interrupted turn: a tool call whose result
      // never arrived ends the turn.
      const interrupted = observe(
        'the interrupted turn',
        resumeAtMessage(
          [
            events[0]!,
            { v: SESSION_SCHEMA_VERSION, t: 'tool_call', ts: 2, id: 'toolu_9', name: 'Echo', input: {} },
          ],
          'toolu_9',
        ),
      );
      expect(interrupted).toMatchObject({ kind: 'ok' });

      // The lookup's **ordering**: the file's modification time, then its
      // creation time — not the last record's timestamp.
      const ordered = [
        {
          sessionId: 'older',
          path: '/tmp/older.jsonl',
          startedAt: 1,
          updatedAt: 9,
          modifiedAt: 5,
          createdAt: 1,
          messageCount: 1,
        },
        {
          sessionId: 'newer',
          path: '/tmp/newer.jsonl',
          startedAt: 1,
          updatedAt: 1,
          modifiedAt: 7,
          createdAt: 1,
          messageCount: 1,
        },
      ];
      const byModification = [...ordered].sort(compareSessionSummaries);
      expect(byModification.map((summary) => summary.sessionId)).toEqual(['newer', 'older']);

      // The lookup's **skip rules**: a `/loop` session is skipped, and a
      // **print** session is not — the target has no headless filter.
      const loop = observe(
        'the loop session',
        isResumableCandidate({ ...ordered[0]!, isLoopSession: true }),
      );
      expect(loop).toBe(false);
      const print = observe(
        'the print session',
        isResumableCandidate({ ...ordered[0]!, entrypoint: 'print' }),
      );
      expect(print).toBe(true);

      // The **creation-time** tie-break: the same modification time, a
      // different creation time.
      const tied = [
        {
          sessionId: 'older_created',
          path: '/tmp/older_created.jsonl',
          startedAt: 1,
          updatedAt: 1,
          modifiedAt: 5,
          createdAt: 1,
          messageCount: 1,
        },
        {
          sessionId: 'newer_created',
          path: '/tmp/newer_created.jsonl',
          startedAt: 1,
          updatedAt: 1,
          modifiedAt: 5,
          createdAt: 9,
          messageCount: 1,
        },
      ];
      const byCreation = [...tied].sort(compareSessionSummaries);
      expect(byCreation.map((summary) => summary.sessionId)).toEqual([
        'newer_created',
        'older_created',
      ]);

      // A session that is **live in the background**. The target **drops** such
      // a candidate and carries on with the next one; this implementation
      // **reports** it and continues with nothing. That is the difference.
      const live = {
        sessionId: 'live_one',
        path: '/tmp/live_one.jsonl',
        startedAt: 1,
        updatedAt: 1,
        modifiedAt: 9,
        createdAt: 1,
        messageCount: 1,
      };
      const older = { ...live, sessionId: 'older_one', path: '/tmp/older_one.jsonl', modifiedAt: 5 };
      const lookup = await observeCall('the live-background lookup', selectResumableCandidate, [
        [live, older],
        { liveSessionIds: new Set(['live_one']) },
      ]);
      // A candidate that is **itself** live is **dropped**, and the lookup
      // carries on with the next one — the target's rule.
      expect(lookup).toMatchObject({ summary: { sessionId: 'older_one' } });
      expect((lookup as { background?: unknown }).background).toBeUndefined();

      // The target's **report-and-stop** case is the *different* candidate: one
      // that was continued into a session which is now live. That one is
      // reported, and the lookup stops.
      const continued = { ...live, sessionId: 'continued_one', continuedInSessionId: 'live_one' };
      const reported = await observeCall('the continued-into lookup', selectResumableCandidate, [
        [continued, older],
        { liveSessionIds: new Set(['live_one']) },
      ]);
      expect(reported).toMatchObject({ background: { sessionId: 'live_one' } });
      expect((reported as { summary?: unknown }).summary).toBeUndefined();

      return measured(
        'match',
        "The exact-title match, the ambiguity error that lists the candidates, the drop guard and the interrupted-turn rule are reproduced; so are the lookup's ordering — the file's modification time, then its creation time — and its skip rules, where a /loop session is skipped and a print session is not, a candidate that is itself live is dropped so the lookup carries on with the next one, and a candidate that was continued into a live session is reported and stops the lookup.",
      );
    },
  },
  {
    rowId: 'F-26',
    title: 'F-26 the cross-restart carried prompts',
    command: reproduce('F-26 the cross-restart carried prompts'),
    pinning: {
      file: 'tests/contracts/session-store.test.ts',
      title: 'reports every outcome of the vocabulary',
    },
    probe: async () => {
      await withTempDir(async (dir) => {
        const store = observe(
          'the carried-prompt store',
          createCarriedPromptStore({ configDir: dir, now: () => 1_000 }),
        );
        // `bound`: the prompt is taken as it stands.
        await store.put({ id: 'p1', sessionId: 's1', prompt: 'hello', createdAt: 1_000 });
        const taken = await observeCall('the taken prompt', store.take, [
          { id: 'p1', sessionId: 's1', now: 2_000 },
        ]);
        expect(taken).toMatchObject({ outcome: 'bound' });
        // `sent`: it is not delivered twice.
        const again = await observeCall('the prompt taken again', store.take, [
          { id: 'p1', sessionId: 's1', now: 2_000 },
        ]);
        expect(again).toMatchObject({ outcome: 'sent' });
        // `no_row`: the prompt is not there.
        const other = await observeCall('the absent prompt', store.take, [
          { id: 'p2', sessionId: 's1', now: 2_000 },
        ]);
        expect(other).toMatchObject({ outcome: 'no_row' });
        // `altered`: the stored text was altered before it was taken.
        await store.put({ id: 'p3', sessionId: 's1', prompt: 'hello', createdAt: 1_000 });
        await store.alter({ id: 'p3', sessionId: 's1', prompt: 'changed' });
        const altered = await observeCall('the altered prompt', store.take, [
          { id: 'p3', sessionId: 's1', now: 2_000 },
        ]);
        expect(altered).toMatchObject({ outcome: 'altered' });
        // `too_old`: the prompt is older than the age limit.
        await store.put({ id: 'p4', sessionId: 's1', prompt: 'hello', createdAt: 1_000 });
        const old = await observeCall('the stale prompt', store.take, [
          { id: 'p4', sessionId: 's1', now: 10_000_000_000 },
        ]);
        expect(old).toMatchObject({ outcome: 'too_old' });
        // `future_dated`: the prompt was persisted later than it is taken.
        await store.put({ id: 'p5', sessionId: 's1', prompt: 'hello', createdAt: 5_000 });
        const future = await observeCall('the future prompt', store.take, [
          { id: 'p5', sessionId: 's1', now: 2_000 },
        ]);
        expect(future).toMatchObject({ outcome: 'future_dated' });
        // `job_has_run`: the row's job has already run.
        writeFileSync(
          path.join(dir, 'carried-prompts.jsonl'),
          `${JSON.stringify({ id: 'p6', sessionId: 's1', prompt: 'hello', createdAt: 1_000, jobHasRun: true })}\n`,
        );
        const job = await observeCall('the job that has run', store.take, [
          { id: 'p6', sessionId: 's1', now: 2_000 },
        ]);
        expect(job).toMatchObject({ outcome: 'job_has_run' });
      });
      return measured(
        'match',
        "All seven of the target's outcome names are produced — `bound`, `sent`, `altered`, `no_row`, `too_old`, `future_dated` and `job_has_run` — and the binding rule is reproduced: a prompt is bound once and never delivered twice.",
      );
    },
  },
  {
    rowId: 'F-27',
    title: 'F-27 compaction',
    command: reproduce('F-27 compaction'),
    pinning: {
      file: 'tests/contracts/compaction.test.ts',
      title: 'marks the boundary with a record that hangs off the last dropped record',
    },
    probe: async () => {
      // The compaction is a **boundary marker**, not a deletion, and the summary
      // is passed in — this implementation never produces one locally.
      const events: SessionEvent[] = [
        { v: SESSION_SCHEMA_VERSION, t: 'user_message', ts: 1, id: 'm1', text: 'one' },
        { v: SESSION_SCHEMA_VERSION, t: 'assistant_message', ts: 2, id: 'm2', text: 'two' },
        { v: SESSION_SCHEMA_VERSION, t: 'user_message', ts: 3, id: 'm3', text: 'three' },
      ];
      // The **trigger**: the threshold is the context window less the output
      // reserve less the margin, and the decision has four levels.
      const window = { contextWindow: 200_000, maxOutputTokens: 8_192 };
      const threshold = observe('the compaction threshold', autoCompactThreshold(window));
      expect(threshold).toBe(200_000 - 8_192 - AUTO_COMPACT_THRESHOLD_MARGIN);
      expect(
        observe(
          'the threshold with a larger output budget',
          autoCompactThreshold({ contextWindow: 200_000, maxOutputTokens: 64_000 }),
        ),
      ).toBe(200_000 - AUTO_COMPACT_OUTPUT_RESERVE - AUTO_COMPACT_THRESHOLD_MARGIN);
      expect(observe('the level below the threshold', autoCompactDecision(threshold - 20_001, window).level)).toBe(
        'ok',
      );
      expect(observe('the level at the threshold', autoCompactDecision(threshold, window).level)).toBe(
        'compact',
      );
      // The percentage override lowers the threshold and never raises it.
      expect(
        observe('the overridden threshold', autoCompactThreshold({ ...window, percentOverride: 50 })),
      ).toBe(Math.min(Math.floor((200_000 - 8_192) * 0.5), 200_000 - 8_192 - AUTO_COMPACT_THRESHOLD_MARGIN));
      expect(
        observe('the raised override', autoCompactThreshold({ ...window, percentOverride: 100 })),
      ).toBe(threshold);
      // And auto-compaction that is switched off never compacts.
      expect(
        observe(
          'the level with auto-compaction off',
          autoCompactDecision(threshold + 1_000, { ...window, enabled: false }).level,
        ),
      ).not.toBe('compact');

      // The **boundary** is located by the link the marker carries, and the
      // summary is the model's own, unchanged.
      const compacted = await observeCall(
        'the compacted events',
        compactEvents,
        [events, { keepLast: 1, summary: 'the summary', ts: 5_000, id: 'cmp_1' }],
      );
      expect(compacted.events[0]?.t).toBe('compaction');
      expect(compacted.events).toHaveLength(2);
      expect((compacted.events[0] as { parentId?: string }).parentId).toBe('m2');
      expect((compacted.events[0] as { replacedFrom?: number }).replacedFrom).toBe(2);
      expect(compacted.events[0]?.id).toBe('cmp_1');
      expect(compacted.summary).toBe('the summary');
      // A summary is never produced locally, and no boundary is marked when
      // nothing would be dropped.
      const withoutSummary = observe(
        'the events without a summary',
        compactEvents(events, { keepLast: 1 }),
      );
      expect(withoutSummary.summary).toBeUndefined();
      expect(withoutSummary.events).toEqual(events);
      expect(
        observe('the events with nothing dropped', compactEvents(events, { keepLast: 3, summary: 's' }).events),
      ).toEqual(events);

      // The **summary's shape**: the preamble, the normalised summary, and the
      // resume guidance.
      expect(
        observe('the normalised summary', normaliseCompactSummary('<analysis>x</analysis><summary>the summary</summary>')),
      ).toBe('Summary:\nthe summary');
      const content = observe('the summary content', compactSummaryContent('<summary>the summary</summary>'));
      expect(content).toContain(COMPACT_SUMMARY_PREAMBLE);
      expect(content).toContain('the summary');
      expect(
        observe('the summary prompt', compactSummaryPrompt()),
      ).toContain('TEXT ONLY');

      // The **projection**: the summary, then the replacement, then the kept
      // tail, then the attachments, then the hook results.
      const projected = observe(
        'the projected context',
        projectCompactedContext({
          summary: [{ role: 'user', content: 'the summary' }],
          replacement: [{ role: 'user', content: 'the replacement' }],
          kept: [{ role: 'user', content: 'the tail' }],
          attachments: [{ role: 'user', content: 'the attachment' }],
          hookResults: [{ role: 'user', content: 'the hook result' }],
        }),
      );
      expect(projected.map((message) => message.content)).toEqual([
        'the summary',
        'the replacement',
        'the tail',
        'the attachment',
        'the hook result',
      ]);

      // The **fallback ordering** is the target's own ladder.
      expect(observe('the fallback order', COMPACT_FALLBACK_ORDER)).toEqual([
        'the_cached_prefix',
        'a_fresh_request',
        'the_next_model_in_the_ladder',
        'the_refusals_fallback_model',
        'dropping_the_head',
        'giving_up',
      ]);
      expect(observe('the router order', COMPACT_ROUTER_ORDER)).toEqual([
        'disabled',
        'below_the_threshold',
        'the_fixed_prefix_alone_is_over_the_threshold',
        'the_rapid_refill_breaker',
        'the_reactive_path',
        'the_core_path',
      ]);
      return measured(
        'match',
        "The target's compaction behaviour is established and reproduced: the **trigger** is the context window less the output reserve less the margin, with the four levels the target's own decision has, and the percentage override lowers the threshold and never raises it; the **boundary** is a marker record that hangs off the last dropped record, located by the link and never by a count, and the summary is the model's own, unchanged — never produced locally; the **summary's shape** is the target's preamble, the summary normalised out of its analysis and summary tags, and the resume guidance; the **projection** is the summary, then the replacement, then the kept tail, then the attachments, then the hook results; and the **fallback ordering** is the target's own ladder, from the cached prefix to giving up.",
      );
    },
  },

  /* --- the extensions ---------------------------------------------------- */
  {
    rowId: 'F-28',
    title: 'F-28 the mcp control-request surface',
    command: reproduce('F-28 the mcp control-request surface'),
    pinning: {
      file: 'tests/contracts/mcp-control.test.ts',
      title: 'is exactly the 23 host subtypes',
    },
    probe: async () => {
      const subtypes = observe('the host control-request subtypes', HOST_CONTROL_REQUEST_SUBTYPES);
      expect([...subtypes]).toEqual([
        'initialize',
        'set_model',
        'set_max_thinking_tokens',
        'set_permission_mode',
        'rename_session',
        'set_color',
        'file_suggestions',
        'read_file',
        'get_workspace_diff',
        'get_context_usage',
        'get_usage',
        'mcp_status',
        'mcp_authenticate',
        'mcp_oauth_callback_url',
        'mcp_reconnect',
        'interrupt',
        'apply_flag_settings',
        'mcp_set_servers',
        'stop_task',
        'background_tasks',
        'cancel_async_message',
        'side_question',
        'fork_conversation',
      ]);
      expect(subtypes).not.toContain('can_use_tool');
      const response = await observeCall(
        'the dispatched response',
        dispatchControlRequest,
        [{ subtype: 'mcp_status', request_id: 'r1' }, {}],
      );
      expect(response).toMatchObject({ subtype: 'success' });
      return measured(
        'match',
        "The host dispatcher handles exactly the 23 observed subtypes, and `can_use_tool` is not among them.",
      );
    },
  },
  {
    rowId: 'F-29',
    title: 'F-29 the directional control-request policy',
    command: reproduce('F-29 the directional control-request policy'),
    pinning: {
      file: 'tests/contracts/mcp-control.test.ts',
      title: 'rejects every agent-originated subtype by direction',
    },
    probe: async () => {
      const originated = observe('the agent-originated subtypes', AGENT_ORIGINATED_CONTROL_SUBTYPES);
      expect([...originated]).toEqual([
        'can_use_tool',
        'hook_callback',
        'elicitation',
        'request_user_dialog',
        'oauth_token_refresh',
        'host_auth_token_refresh',
        'remote_tool_call',
        'remote_plumbing_call',
        'remote_tools_probe',
        'remote_tools_reannounce',
        'remote_control_work_secret',
      ]);
      // The three refusals, word for word.
      const agent = await observeCall('the agent-originated refusal', controlRequestDirectionError, [
        'can_use_tool',
      ]);
      expect(agent).toBe('can_use_tool is agent-originated and cannot be sent by a host');
      const service = await observeCall(
        'the service-originated refusal',
        controlRequestDirectionError,
        ['mcp_tasks_changed'],
      );
      expect(service).toBe('mcp_tasks_changed is sent to a cloud agent by the service, not by a host');
      const client = await observeCall(
        'the client-originated refusal',
        controlRequestDirectionError,
        ['register_device_hooks'],
      );
      expect(client).toBe(
        'register_device_hooks is sent to a cloud agent by the attached client, not by a host',
      );
      expect(
        await observeCall('the accepted subtype', controlRequestDirectionError, ['read_file']),
      ).toBeUndefined();
      return measured('match', 'The three refused directions and their wordings are reproduced.');
    },
  },
  {
    rowId: 'F-30',
    title: 'F-30 the mcp transport and its batching',
    command: reproduce('F-30 the mcp transport and its batching'),
    pinning: {
      file: 'tests/contracts/mcp-manager.test.ts',
      title: 'uses 3 for local servers and 20 for remote ones',
    },
    probe: async () => {
      expect(observe('the local batch size', LOCAL_CONNECT_BATCH_SIZE)).toBe(3);
      expect(observe('the remote batch size', REMOTE_CONNECT_BATCH_SIZE)).toBe(20);
      expect(observe('the local batch size', getMcpServerConnectionBatchSize())).toBe(3);
      expect(observe('the remote batch size', getRemoteMcpServerConnectionBatchSize())).toBe(20);
      // The stdio transport: the process is spawned with `shell: false`, with
      // the pipe stdio and with the merged environment.
      const channel = openChannel<{ command: string; args: readonly string[]; options: SpawnOptions }>();
      const transport = observe(
        'the stdio transport',
        createStdioTransport({
          command: '/bin/true',
          args: ['--serve'],
          env: { PRRICODE_TEST: 'yes' },
          spawnImpl: (command, args, options) => {
            channel.deliver({ command, args, options });
            return fakeChild();
          },
        }),
      );
      await transport.start();
      const spawn = observe('the spawn this implementation handed over', channel.delivered());
      expect(spawn).toMatchObject({ command: '/bin/true', args: ['--serve'] });
      expect(spawn?.options.shell).toBe(false);
      expect(spawn?.options.stdio).toEqual(['pipe', 'pipe', 'inherit']);
      expect(spawn?.options.env?.['PRRICODE_TEST']).toBe('yes');
      return measured(
        'match',
        "The stdio transport spawns with `shell: false`, the pipe stdio and the merged environment, and the 3/20 batching is the target's observed value.",
      );
    },
  },
  {
    rowId: 'F-31',
    title: 'F-31 the mcp server lifecycle',
    command: reproduce('F-31 the mcp server lifecycle'),
    pinning: {
      file: 'tests/contracts/mcp-manager.test.ts',
      title: 'evicts a failed memo and retries the server',
    },
    probe: async () => {
      // The client lifecycle, element by element. The probe's own transport
      // stands in for the server; everything the probe asserts on is a value
      // this implementation produced.
      const suffix = Math.random().toString(36).slice(2, 10);

      // --- The negotiation point (audit §2.8) ------------------------------
      expect(observe('the negotiation point', getMcpVersionNegotiation({}))).toBe('modern');
      expect(
        observe(
          'the legacy opt-out',
          getMcpVersionNegotiation({ MCP_PROTOCOL_NEGOTIATION: 'legacy' }),
        ),
      ).toBe('legacy');

      // --- The connect (audit §2.8) ----------------------------------------
      //
      // The modern revision is probed first, and the connection carries the
      // negotiated revision, the server's own identity and its capabilities.
      const modernServer = fakeMcpTransport(standardMcpAnswers);
      const connection = await observeCall('the connection', connectToServer, [
        mcpConfigOf(`probe-modern-${suffix}`),
        { transportFactory: () => modernServer.transport, env: {} },
      ]);
      expect(observe('the era', connection.era)).toBe('modern');
      expect(observe('the protocol version', connection.protocolVersion)).toBe('2026-07-28');
      expect(await observeCall('the live connection', connection.isLive, [], connection)).toBe(true);
      expect(observe('the server identity', connection.serverInfo)).toMatchObject({
        name: 'probe-server',
      });
      expect(observe('the server capabilities', connection.capabilities)).toMatchObject({
        tools: {},
      });

      // --- The fallback: the server does not know `server/discover` --------
      const legacyServer = fakeMcpTransport((method, attempt, params) =>
        method === 'server/discover'
          ? { error: { code: -32601, message: 'Method not found' } }
          : standardMcpAnswers(method, attempt, params),
      );
      const legacyConnection = await observeCall('the legacy connection', connectToServer, [
        mcpConfigOf(`probe-legacy-${suffix}`),
        { transportFactory: () => legacyServer.transport, env: {} },
      ]);
      expect(observe('the legacy era', legacyConnection.era)).toBe('legacy');
      expect(observe('the legacy protocol version', legacyConnection.protocolVersion)).toBe(
        '2025-11-25',
      );

      // --- The legacy opt-out ----------------------------------------------
      const optOutServer = fakeMcpTransport(standardMcpAnswers);
      const optOutConnection = await observeCall('the opt-out connection', connectToServer, [
        mcpConfigOf(`probe-opt-out-${suffix}`),
        { transportFactory: () => optOutServer.transport, env: {}, negotiation: 'legacy' },
      ]);
      expect(observe('the opt-out era', optOutConnection.era)).toBe('legacy');
      expect(observe('the opt-out protocol version', optOutConnection.protocolVersion)).toBe(
        '2025-11-25',
      );

      // --- The capabilities, fetched separately (audit §2.8) ----------------
      expect(await observeCall('the tools', fetchToolsForClient, [connection])).toMatchObject([
        { name: 'echo' },
      ]);
      expect(await observeCall('the commands', fetchCommandsForClient, [connection])).toMatchObject([
        { name: 'greet' },
      ]);
      expect(
        await observeCall('the resources', fetchResourcesForClient, [connection]),
      ).toMatchObject([{ uri: 'file:///probe', name: 'probe' }]);
      expect(
        await observeCall('the resource templates', fetchResourceTemplatesForClient, [connection]),
      ).toMatchObject([{ uriTemplate: 'file:///{path}', name: 'byPath' }]);
      expect(
        await observeCall('the aggregated capabilities', getMcpToolsCommandsAndResources, [
          connection,
        ]),
      ).toMatchObject({
        tools: [{ name: 'echo' }],
        commands: [{ name: 'greet' }],
        resources: [{ uri: 'file:///probe', name: 'probe' }],
        resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'byPath' }],
      });

      // --- The listing hydration and the discover prior (audit §2.8) --------
      const listing: McpListing = {
        server: `probe-listing-${suffix}`,
        tools: [{ name: 'echo' }],
        commands: [{ name: 'greet' }],
        resources: [],
        resourceTemplates: [],
      };
      expect(await observeCall('the hydrated tools', hydrateToolsFromListing, [listing])).toEqual([
        { name: 'echo' },
      ]);
      expect(await observeCall('the hydrated commands', hydrateCommandsFromListing, [listing])).toEqual(
        [{ name: 'greet' }],
      );
      expect(await observeCall('the listing discover prior', getListingDiscoverPrior, [listing])).toBe(
        true,
      );
      expect(
        await observeCall('the remembered discover prior', getRememberedDiscoverPrior, [
          listing.server,
        ]),
      ).toBe(true);

      // --- The calling (audit §2.8) ----------------------------------------
      const called = await observeCall('the tool result', callMCPTool, [
        connection,
        'echo',
        { text: 'hi' },
      ]);
      expect(called).toMatchObject({ isError: false });
      expect(observe('the result content', called.content)).toEqual([{ type: 'text', text: 'hi' }]);
      // The URL-elicitation retry: the server asks the user to visit a URL, and
      // the call is made once more.
      const elicitationServer = fakeMcpTransport((method, attempt, params) => {
        if (method !== 'tools/call') return standardMcpAnswers(method, attempt, params);
        const tool = (params as { readonly name?: string } | undefined)?.name;
        if (tool !== 'auth' || attempt !== 1) return standardMcpAnswers(method, attempt, params);
        return {
          result: {
            content: [
              { type: 'text', text: 'Please visit https://example.com/auth to sign in.' },
            ],
            isError: true,
          },
        };
      });
      const elicitationConnection = await observeCall(
        'the elicitation connection',
        connectToServer,
        [
          mcpConfigOf(`probe-elicitation-${suffix}`),
          { transportFactory: () => elicitationServer.transport, env: {} },
        ],
      );
      const elicitationChannel = openChannel<McpUrlElicitation>();
      const retried = await observeCall('the retried tool result', callMCPToolWithUrlElicitationRetry, [
        elicitationConnection,
        'auth',
        {},
        {
          onUrlElicitation: (elicitation: McpUrlElicitation): void => {
            elicitationChannel.deliver(elicitation);
          },
        },
      ]);
      expect(observe('the elicitation', elicitationChannel.delivered())).toMatchObject({
        url: 'https://example.com/auth',
      });
      expect(observe('the retried content', retried.content)).toEqual([
        { type: 'text', text: 'hi' },
      ]);

      // --- The auth-failure classification (audit §2.8) --------------------
      expect(
        observe(
          'the expired token',
          classifyMcpAuthFailure({ status: 401, body: '{"error":{"type":"authentication_error"}}' }),
        ),
      ).toBe('expired_token');
      expect(observe('the unauthorized failure', classifyMcpAuthFailure({ status: 401 }))).toBe(
        'unauthorized',
      );
      expect(observe('the forbidden failure', classifyMcpAuthFailure({ status: 403 }))).toBe(
        'forbidden',
      );
      expect(observe('the invalid token', classifyMcpAuthFailure({ status: 402 }))).toBe(
        'invalid_token',
      );
      expect(
        observe('the missing credential', classifyMcpAuthFailure({ message: 'no credential' })),
      ).toBe('missing_credential');
      expect(
        observe('the network failure', classifyMcpAuthFailure({ message: 'fetch failed' })),
      ).toBe('network');
      expect(observe('the unknown failure', classifyMcpAuthFailure({}))).toBe('unknown');
      expect(
        observe(
          'the era code',
          hasEraCodeInHttpErrorBody({ error: { type: 'authentication_error' } }, 'authentication_error'),
        ),
      ).toBe(true);
      expect(
        observe(
          'the absent era code',
          hasEraCodeInHttpErrorBody({ error: { type: 'other' } }, 'authentication_error'),
        ),
      ).toBe(false);

      // --- The four timeouts (audit §2.8) ----------------------------------
      expect(observe('the default timeouts', DEFAULT_MCP_TIMEOUTS)).toMatchObject({
        armedRequestTimeoutMs: 5000,
        requestTimeoutMs: 30000,
        toolTimeoutMs: 120000,
        toolIdleTimeoutMs: 15000,
      });
      expect(
        await observeCall('the overridden timeouts', resolveMcpTimeouts, [
          { timeouts: { requestTimeoutMs: 1234 } },
          {},
        ]),
      ).toMatchObject({ requestTimeoutMs: 1234, armedRequestTimeoutMs: 5000 });
      expect(
        await observeCall('the environment timeouts', resolveMcpTimeouts, [
          {},
          { [MCP_TIMEOUT_ENV]: '4321', [MCP_CONNECT_TIMEOUT_ENV]: '1111' },
        ]),
      ).toMatchObject({ requestTimeoutMs: 4321, armedRequestTimeoutMs: 1111 });
      expect(observe('the connection timeouts', connection.timeouts)).toMatchObject({
        armedRequestTimeoutMs: 5000,
        requestTimeoutMs: 30000,
        toolTimeoutMs: 120000,
        toolIdleTimeoutMs: 15000,
      });
      // The connect phase's deadline is the armed one, and it does not cap an
      // ordinary request: the failure names the request that ran out of time
      // and the deadline it carried.
      const silentServer = fakeMcpTransport(() => undefined);
      const manager = await observeCall('the manager', createMcpManager, [
        {
          client: {
            transportFactory: () => silentServer.transport,
            timeouts: {
              armedRequestTimeoutMs: 10,
              requestTimeoutMs: 60,
              toolTimeoutMs: 60,
              toolIdleTimeoutMs: 60,
            },
            env: {},
          },
        },
      ]);
      const connectFailure = await observeCall(
        'the failed connect',
        manager.connect,
        [mcpConfigOf(`probe-connect-deadline-${suffix}`)],
        manager,
      );
      expect(connectFailure).toMatchObject({ status: 'failed' });
      expect(observe('the connect failure', connectFailure.error)).toContain('"server/discover"');
      expect(observe('the connect deadline', connectFailure.error)).toContain('after 10 ms');
      const listingServer = fakeMcpTransport((method, attempt, params) =>
        method === 'tools/list' ? undefined : standardMcpAnswers(method, attempt, params),
      );
      const listingManager = await observeCall('the listing manager', createMcpManager, [
        {
          client: {
            transportFactory: () => listingServer.transport,
            timeouts: {
              armedRequestTimeoutMs: 10,
              requestTimeoutMs: 60,
              toolTimeoutMs: 60,
              toolIdleTimeoutMs: 60,
            },
            env: {},
          },
        },
      ]);
      const listingFailure = await observeCall(
        'the failed listing',
        listingManager.connect,
        [mcpConfigOf(`probe-listing-deadline-${suffix}`)],
        listingManager,
      );
      expect(listingFailure).toMatchObject({ status: 'failed' });
      expect(observe('the listing failure', listingFailure.error)).toContain('"tools/list"');
      expect(observe('the listing deadline', listingFailure.error)).toContain('after 60 ms');

      // --- The memo and the identity-epoch eviction (audit §2.8) -----------
      const memoConfig = mcpConfigOf(`probe-memo-${suffix}`);
      const memoServer = fakeMcpTransport(standardMcpAnswers);
      const memoOptions = { transportFactory: () => memoServer.transport, env: {} };
      const memoized = await observeCall('the memoized connection', ensureConnectedClient, [
        memoConfig,
        memoOptions,
      ]);
      const again = await observeCall('the memoized connection again', ensureConnectedClient, [
        memoConfig,
        memoOptions,
      ]);
      // The connect result is memoized: the second connect hands the same
      // connection out.
      expect(again).toBe(memoized);
      expect(await observeCall('the live connection', hasLiveConnection, [memoConfig.name])).toBe(
        true,
      );
      // The memo is dropped explicitly.
      expect(
        await observeCall('the explicit drop', discardMemoizedConnectResult, [memoConfig.name]),
      ).toBe(true);
      expect(
        await observeCall('the live connection after the explicit drop', hasLiveConnection, [
          memoConfig.name,
        ]),
      ).toBe(false);
      // The memo is dropped when the credential identity epoch changes.
      const epoch = await observeCall('the identity epoch', getMcpIdentityEpoch, []);
      const nextEpoch = await observeCall(
        'the identity epoch after the change',
        evictAllMcpMemosOnIdentityChange,
        [],
      );
      expect(nextEpoch).toBe(epoch + 1);
      // A failed memo is evicted once it goes stale, so that the server is
      // retried.
      const failedConfig = mcpConfigOf(`probe-failed-${suffix}`);
      const failedServer = fakeMcpTransport(() => undefined);
      await observeCall('the failed connect', ensureConnectedClient, [
        failedConfig,
        {
          transportFactory: () => failedServer.transport,
          env: {},
          timeouts: { armedRequestTimeoutMs: 10, requestTimeoutMs: 10 },
        },
      ]).catch(() => undefined);
      expect(
        await observeCall('the fresh failure is not stale', evictStaleFailedConnectMemoForServe, [
          failedConfig.name,
          MCP_FAILED_MEMO_MAX_AGE_MS,
        ]),
      ).toBe(false);
      expect(
        await observeCall('the stale failure is evicted', evictStaleFailedConnectMemoForServe, [
          failedConfig.name,
          0,
        ]),
      ).toBe(true);

      // --- The state of a connection attempt (audit §2.8) ------------------
      const dialConfig = mcpConfigOf(`probe-dial-${suffix}`);
      const dialServer = fakeMcpTransport(() => undefined);
      const dial = observeCall('the pending connect', ensureConnectedClient, [
        dialConfig,
        {
          transportFactory: () => dialServer.transport,
          env: {},
          timeouts: { armedRequestTimeoutMs: 30, requestTimeoutMs: 30 },
        },
      ]).catch(() => undefined);
      expect(await observeCall('the unsettled dial', hasUnsettledDial, [dialConfig.name])).toBe(
        true,
      );
      await dial;
      expect(await observeCall('the settled dial', hasUnsettledDial, [dialConfig.name])).toBe(false);

      // --- The teardown (audit §2.8) ---------------------------------------
      await observeCall('the teardown', detachAndCloseConnection, [connection]);
      expect(await observeCall('the closed connection', connection.isLive, [], connection)).toBe(
        false,
      );
      await observeCall('the disposal', disposeServerConnectionDetached, [connection]);
      await observeCall('the clean-up', cleanupConnectedMcpClients, []);

      // --- The reconnect (audit §2.8) --------------------------------------
      expect(observe('the reconnect', inertReconnectShape(`probe-${suffix}`))).toMatchObject({
        reconnected: false,
        inert: true,
      });

      // --- The batched connect (this implementation's own shape) -----------
      //
      // The batched connect returns the states in the order the configurations
      // were given, and a failed server is a state, not a crash.
      const configs: McpServerConfig[] = [
        { name: 'one', type: 'stdio', command: '/bin/true' },
        { name: 'two', type: 'stdio', command: '/bin/true' },
        { name: 'three', type: 'http', url: 'http://127.0.0.1:1/mcp' },
      ];
      const states = await observeCall(
        'the connection states',
        connectServersInBatches,
        [configs, {
          connect: async (config: McpServerConfig) => ({
            name: config.name,
            status: config.name === 'three' ? 'failed' : 'ready',
            tools: [],
            ...(config.name === 'three' ? { error: 'the endpoint refused the connection' } : {}),
          }),
        }],
      );
      expect(states).toMatchObject([{ name: 'one' }, { name: 'two' }, { name: 'three' }]);
      const failedState = observe('the failed state', states[2]);
      expect(failedState).toMatchObject({ status: 'failed' });
      expect(observe('the failed state error', failedState?.error)).toBeDefined();
      // The **channel surface**: the capability, the methods, the gate's
    // decision kinds and the hard revocations.
    expect(observe('the channel capability', CHANNEL_CAPABILITY)).toBe('claude/channel');
    expect(observe('the permission capability', CHANNEL_PERMISSION_CAPABILITY)).toBe(
      'claude/channel/permission',
    );
    expect(observe('the channel method', CHANNEL_MESSAGE_METHOD)).toBe('notifications/claude/channel');
    expect(observe('the permission method', CHANNEL_PERMISSION_METHOD)).toBe(
      'notifications/claude/channel/permission',
    );
    expect(observe('the permission-request method', CHANNEL_PERMISSION_REQUEST_METHOD)).toBe(
      'notifications/claude/channel/permission_request',
    );
    expect(observe('the channel tag', CHANNEL_MESSAGE_TAG)).toBe('channel');
    expect(observe('the meta-key rule', CHANNEL_META_KEY_PATTERN.source)).toBe(
      '^[a-zA-Z_][a-zA-Z0-9_]*$',
    );
    expect(observe('the gate kinds', CHANNEL_GATE_KINDS)).toHaveLength(8);
    expect(observe('the hard revocations', CHANNEL_HARD_REVOCATION_KINDS)).toEqual([
      'provider',
      'disabled',
      'capability',
      'era',
    ]);
    return measured(
        'match',
        "The target's whole client lifecycle is compared, element by element: the **connect** (the modern revision is probed first and the legacy `initialize` handshake is the fallback, and the connection carries the negotiated revision, the server's identity and its capabilities), the **negotiation point** and its `MCP_PROTOCOL_NEGOTIATION=legacy` opt-out, the **identity-epoch eviction** (the memo is dropped when the epoch changes, when it is dropped explicitly, and when a failed memo goes stale), the **state** of a connection (a live connection and a dial that is still in flight), the **capabilities** (the four listings, fetched separately and aggregated, with the discover-prior memo beside the hydration path), the **calling** (the tool result, and the URL-elicitation retry), the **auth-failure classification** (the expired token, the unauthorized, the forbidden, the invalid token, the missing credential, the network failure and the unknown one), the **timeouts** (the four distinct deadlines — the armed-request, the request, the tool and the tool idle one — the overrides that win over them, the environment they read, the four a connection carries, and the connect phase's armed deadline beside an ordinary request's own), the **teardown** (detach-and-close, dispose-detached and the clean-up) and the **reconnect** (the deliberately inert shape). The **batched state list** this implementation's own batched connect returns remains this implementation's own shape: the target has no such list, and it is compared here only as this implementation's own shape.",
      );
    },
  },
  {
    rowId: 'F-32',
    title: 'F-32 the hook event matrix',
    command: reproduce('F-32 the hook event matrix'),
    pinning: {
      file: 'tests/contracts/hooks.test.ts',
      title: 'lists exactly the thirty-three hook events',
    },
    probe: async () => {
      const events = observe('the hook events', HOOK_EVENTS);
      expect(events).toHaveLength(33);
      // The two display handlers live outside the event set.
      const handlers = observe('the display handlers', DISPLAY_HANDLERS);
      expect([...handlers].sort()).toEqual(['FileSuggestion', 'StatusLine']);
      expect(events).not.toContain('StatusLine');
      expect(events).not.toContain('FileSuggestion');
      // The per-event classification: the decision-capable set and the
      // execution-class table are disjoint, and together they are the 33.
      const decisions = observe('the decision-capable events', DECISION_EVENTS);
      const classification = observe('the execution classification', HOOK_EXECUTION_CLASS);
      const classified = Object.keys(classification);
      expect(decisions).toHaveLength(11);
      expect(classified).toHaveLength(22);
      expect(classified.filter((event) => (decisions as readonly string[]).includes(event))).toEqual(
        [],
      );
      expect([...decisions, ...classified].sort()).toEqual([...events].sort());
      const registry = observe('the hook registry', createHookRegistry());
      registry.register({ event: 'PreToolUse', command: 'echo', matcher: 'Bash' });
      expect(registry.for('PreToolUse')).toHaveLength(1);
    // The **per-model severity thresholds**, which the target ships in its
    // site-configuration bundle.
    expect(observe('the severity table', SEVERITY_BY_MODEL)).toEqual({
      'claude-sonnet-5[1m]': { t1: 25, t2: 35 },
      'claude-opus-4-8[1m]': { t1: 45, t2: 35 },
      'claude-sonnet-5': { t1: 25, t2: 35 },
      'claude-opus-4-8': { t1: 45, t2: 35 },
    });
    expect(observe('the default thresholds', DEFAULT_SEVERITY_THRESHOLDS)).toEqual({ t1: 15, t2: 20 });
    // The `mcp_tool` hook type is the target's wider handler vocabulary.
    expect(
      observe('the mcp_tool handler type', effectiveHandlerType({ type: 'mcp_tool' } as never)),
    ).toBe('mcp_tool');
    // The bundle carries the target's members, and the table among them.
    const bundle = observe('the site-configuration bundle', DEFAULT_SITE_CONFIG);
    expect(Object.keys(bundle)).toEqual([
      'twoStageClassifier',
      'sameTurnSiblingContext',
      'editRemovalVisibility',
      'editRemovalCap',
      'outcomeVisibility',
      'repoVisibility',
      'gitStatusType',
      'gitStatusUploads',
      'tagConnectorWrites',
      'severityByModel',
    ]);
    expect(bundle.severityByModel).toEqual(SEVERITY_BY_MODEL);
    expect(bundle.editRemovalCap).toBe(3000);
    // The resolution: the bundle's own severity, then the per-model entry,
    // then the defaults.
    expect(observe('the resolved thresholds', resolveSeverity(bundle, 'claude-sonnet-5'))).toEqual({
      value: { t1: 25, t2: 35 },
      source: 'bundle',
    });
    expect(observe('the unresolved thresholds', resolveSeverity(bundle, 'claude-sonnet-4-5'))).toEqual({
      value: null,
      source: 'default',
    });
    // And the alias fallback, when the exact model is not in the table.
    expect(
      observe(
        'the aliased thresholds',
        resolveSeverityByModel(SEVERITY_BY_MODEL, 'claude-sonnet-5[1m]', () => ['claude-sonnet-5']),
      ),
    ).toEqual({ t1: 25, t2: 35 });
      return measured(
        'match',
        "The 33 events, the two display handlers outside that set and the per-event classification are reproduced, and so are the two the probe used to leave uncompared: the `mcp_tool` hook type, which is the target's wider handler vocabulary, and the **per-model severity thresholds**, which the target ships in its site-configuration bundle — `claude-sonnet-5[1m]` and `claude-sonnet-5` at `{t1: 25, t2: 35}`, `claude-opus-4-8[1m]` and `claude-opus-4-8` at `{t1: 45, t2: 35}`, the thresholds defaulting to `t1: 15` and `t2: 20`, the bundle carrying the target's own ten members, and the resolution preferring the bundle's own severity, then the per-model entry, then the defaults, with the alias fallback.",
      );
    },
  },
  {
    rowId: 'F-33',
    title: 'F-33 skills subagents plugins marketplaces and the ide',
    command: reproduce('F-33 skills subagents plugins marketplaces and the ide'),
    pinning: {
      file: 'tests/contracts/extensions.test.ts',
      title: 'applies what a plugin contributes',
    },
    probe: async () => {
      // The plugin manifest: the target's "not a JSON object" reason, and the
      // directory/file key split.
      const broken = await observeCall('the broken manifest', parsePluginManifest, [
        'not an object',
        '/tmp/plugin.json',
      ]);
      expect(broken).toMatchObject({ ok: false, reason: 'it is not a JSON object' });
      const parsed = observe(
        'the parsed manifest',
        parsePluginManifest(
          { commands: ['commands/one.md'], mcpServers: { memory: 'mcp.json' } },
          '/tmp/plugin.json',
        ),
      );
      expect(parsed).toMatchObject({ ok: true });
      // The IDE bridge's action rule: a single path segment, nothing else.
      const safe = observe('the safe IDE action', isSafeIdeAction('executeCode'));
      expect(safe).toBe(true);
      expect(observe('the unsafe IDE action', isSafeIdeAction('../etc/passwd'))).toBe(false);
      // The standalone skill scan: the fixed file name, the byte limit, and the
      // reserved names — the target's own rules.
      expect(observe('the skill file name', SKILL_FILE_NAME)).toBe('SKILL.md');
      expect(observe('the skill byte limit', SKILL_FILE_BYTE_LIMIT)).toBe(1_000_000);
      expect(observe('the reserved directory name', isReservedSkillDirectoryName('synced'))).toBe(
        true,
      );
      expect(observe('the reserved skill name', isReservedSkillName('anthropic-skills'))).toBe(true);
      // The subagent catalogue: the name comes from the frontmatter, and the
      // name the target refuses is refused here too.
      expect(observe('a valid subagent name', isValidSubagentName('reviewer'))).toBe(true);
      expect(observe('a refused subagent name', isValidSubagentName('has:colon'))).toBe(false);
      expect(observe('a refused subagent name', isValidSubagentName('-leading-dash'))).toBe(false);
      expect(observe('a refused subagent name', isValidSubagentName('x'.repeat(257)))).toBe(false);
      expect(observe('an accepted subagent name', isValidSubagentName('x'.repeat(256)))).toBe(true);

      // The standalone skill scan, **run**: the root is read **one level
      // deep** and the file name is the fixed `SKILL.md`.
      const scanBase = await makeDirectory('scan');
      const scanRoot = path.join(scanBase, '.claude', 'skills');
      await mkdir(scanRoot, { recursive: true });
      const write = async (relative: string, name: string): Promise<void> => {
        const file = path.join(scanRoot, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(
          file,
          `---\nname: ${name}\ndescription: A skill.\n---\n\nThe body.\n`,
          'utf8',
        );
      };
      await write(path.join('found', 'SKILL.md'), 'found');
      // One level deep only: a skill below the first level is not found.
      await write(path.join('found', 'nested', 'SKILL.md'), 'nested');
      // The file name is fixed: a skill file with another name is not found.
      await write(path.join('other', 'skill.md'), 'other');
      const registry = await observeCall('the skill registry', createSkillRegistry, [
        { cwd: scanBase, configDir: await makeDirectory('config') },
      ]);
      const found = observe('the discovered skills', registry.discover());
      expect(found.map((item) => item.name)).toEqual(['found']);

      // The subagent catalogue, **run**: the name comes from the
      // **frontmatter**, not from the file's name, and a definition without a
      // description is refused by name.
      const agentRoot = path.join(scanBase, '.claude', 'agents');
      await mkdir(agentRoot, { recursive: true });
      await writeFile(
        path.join(agentRoot, 'the-file-name-is-not-the-agent-name.md'),
        '---\nname: reviewer\ndescription: Reviews the change.\n---\n\nThe system prompt.\n',
        'utf8',
      );
      await writeFile(
        path.join(agentRoot, 'no-description.md'),
        '---\nname: undescribed\n---\n\nThe system prompt.\n',
        'utf8',
      );
      const agents = await observeCall('the subagent registry', createSubagentRegistry, [
        { cwd: scanBase, configDir: await makeDirectory('agent-config') },
      ]);
      const discovered = observe('the discovered subagents', agents.discover());
      expect(discovered.map((item) => item.name)).toEqual(['reviewer']);
      // The **plugin and marketplace protocol**: the source vocabularies, the
    // manifest, the frontmatter, the catalogue and the autoupdater.
    expect(observe('the marketplace source types', MARKETPLACE_SOURCE_TYPES)).toEqual([
      'url',
      'github',
      'git',
      'npm',
      'file',
      'directory',
      'skills-dir',
      'hostPattern',
      'pathPattern',
      'settings',
    ]);
    expect(observe('the policy source types', MARKETPLACE_POLICY_SOURCE_TYPES)).toHaveLength(11);
    expect(observe('the runtime source types', MARKETPLACE_RUNTIME_SOURCE_TYPES)).toEqual([
      'claudeai',
      'pluginDirectory',
    ]);
    expect(observe('the npm refusal', MARKETPLACE_NPM_NOT_IMPLEMENTED)).toBe(
      'NPM marketplace sources not yet implemented',
    );
    expect(observe('the plugin source types', PLUGIN_SOURCE_TYPES)).toEqual([
      'npm',
      'url',
      'github',
      'git-subdir',
      'archive',
      'command',
      'unsupported',
    ]);
    expect(observe('the plugin source kinds', PLUGIN_SOURCE_KINDS)).toEqual([
      'local',
      'npm',
      'github',
      'git',
      'subdir',
      'archive',
      'command',
      'unknown',
    ]);
    expect(observe('the manifest keys', PLUGIN_MANIFEST_KEYS)).toHaveLength(29);
    expect(observe('the catalogue manifest keys', MARKETPLACE_MANIFEST_KEYS)).toHaveLength(10);
    expect(observe('the skill frontmatter keys', SKILL_FRONTMATTER_KEYS)).toHaveLength(42);
    expect(observe('the agent frontmatter keys', AGENT_FRONTMATTER_KEYS)).toHaveLength(22);
    expect(observe('the output-style frontmatter keys', OUTPUT_STYLE_FRONTMATTER_KEYS)).toHaveLength(4);
    expect(observe('the update outcomes', PLUGIN_UPDATE_OUTCOMES)).toHaveLength(4);
    expect(observe('the block types', AUTOUPDATE_BLOCK_TYPES)).toHaveLength(4);
    expect(observe('the skip reasons', AUTOUPDATE_SKIP_REASONS)).toHaveLength(3);
    expect(observe('the failure codes', AUTOUPDATE_FAILURE_CODES)).toHaveLength(67);
    // The **agent-team surface**: the mode, the ledger and the inbound gate.
    expect(observe('the teammate modes', TEAMMATE_MODES)).toEqual([
      'auto',
      'tmux',
      'iterm2',
      'in-process',
    ]);
    expect(observe('the default teammate mode', DEFAULT_TEAMMATE_MODE)).toBe('in-process');
    expect(observe('the fallback notification key', TEAMMATE_FALLBACK_NOTIFICATION_KEY)).toBe(
      'teammate-auto-fallback',
    );
    expect(observe('the reserved teammate names', RESERVED_TEAMMATE_NAMES)).toEqual([
      'main',
      'team-lead',
      'user',
      'system',
    ]);
    expect(observe('the teammate name shape', TEAMMATE_NAME_PATTERN.source)).toBe(
      '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
    );
    expect(observe('the agent id shape', AGENT_ID_PATTERN.source)).toBe(
      '^a(?:[\\w-]{1,63}-)?[0-9a-f]{16}$',
    );
    expect(observe('the settle values', TEAMMATE_SETTLE_VALUES)).toHaveLength(6);
    expect(observe('the record sources', TEAMMATE_RECORD_SOURCES)).toEqual([
      'collision',
      'auto',
      'user',
      'peer',
      'hook',
    ]);
    expect(observe('the inbound values', CROSS_SESSION_INBOUND_VALUES)).toEqual([
      'accept',
      'hold',
      'refuse',
    ]);
    expect(observe('the hold capacity', CROSS_SESSION_HOLD_CAPACITY)).toBe(100);
    expect(observe('the message tag', CROSS_SESSION_MESSAGE_TAG)).toBe('cross-session-message');
    // The **IDE surface**: the eighteen IDEs, their kinds, the editor table
    // and the JetBrains product directories.
    expect(observe('the IDE registry', IDE_REGISTRY)).toHaveLength(18);
    expect(observe('the IDE registry keys', IDE_REGISTRY_KEYS)).toHaveLength(18);
    expect(observe('the IDE kinds', IDE_KINDS)).toEqual(['vscode', 'jetbrains']);
    expect(observe('the IDE platforms', IDE_PLATFORMS)).toEqual(['macos', 'windows', 'linux']);
    expect(Object.keys(observe('the editor display names', EDITOR_DISPLAY_NAMES))).toHaveLength(12);
    expect(Object.keys(observe('the JetBrains product directories', JETBRAINS_PRODUCT_DIRECTORIES))).toHaveLength(15);
    return measured(
        'match',
        "This implementation parses a plugin manifest and rules an IDE action, and the standalone skill scan and the subagent catalogue now match the target: the scan reads a root one level deep and takes the fixed file name SKILL.md, the byte limit is a million, the reserved names are refused, a subagent definition\u0027s name comes from its frontmatter rather than its file name, a definition without a description is refused, and the name is validated the way the target validates it.” and the **plugin and marketplace protocol** is compared too: the ten marketplace source types and the eleventh the policy lists carry, the two runtime-only ones, the seven plugin source types and the eight canonical kinds, the twenty-nine manifest keys, the forty-two, twenty-two and four frontmatter keys, the ten catalogue-manifest keys, and the autoupdater's four outcomes, four block types, three skip reasons and sixty-seven failure codes and the **plugin and marketplace protocol** is compared too: the ten marketplace source types and the eleventh the policy lists carry, the two runtime-only ones, the seven plugin source types and the eight canonical kinds, the twenty-nine manifest keys, the forty-two, twenty-two and four frontmatter keys, the ten catalogue-manifest keys, and the autoupdater's four outcomes, four block types, three skip reasons and sixty-seven failure codes",
      );
    },
  },

  /* --- the platform ------------------------------------------------------ */
  {
    rowId: 'F-34',
    title: 'F-34 the native sandbox helper',
    command: reproduce('F-34 the native sandbox helper'),
    pinning: {
      file: 'tests/security/sandbox.test.ts',
      title: 'denies the syscall surface the plan requires, including io_uring_setup',
    },
    probe: async () => {
      // The syscall denylist, including `io_uring_setup`.
      const denied = observe('the syscall denylist', DENIED_SYSCALLS);
      expect(denied).toContain('io_uring_setup');
      expect(denied).toContain('ptrace');
      // The masked protected paths.
      await withTempDir(async (dir) => {
        const secrets = path.join(dir, 'secrets');
        mkdirSync(secrets, { recursive: true });
        const plan = await observeCall('the mount plan', buildSandboxPlan, [
          { command: 'ls', cwd: dir, protectedPaths: [secrets] },
        ]);
        expect(plan.masks).toMatchObject([{ path: secrets, target: secrets, kind: 'tmpfs' }]);
        expect(plan.deniedSyscalls).toContain('io_uring_setup');
      });
      // The native helper is now the default backend: it is a binary of this
      // implementation's own, doing the namespace, mount and `prctl` work itself.
      const backend = observe('the sandbox backend', await defaultSandboxBackend());
      expect(backend).toMatchObject({ name: 'sandbox-helper' });
      return measured(
        'match',
        "This implementation's syscall denylist includes `io_uring_setup` and its mount plan masks the protected paths, and it now ships its own native helper (`sandbox-helper`) that performs the user/mount/PID namespace setup, the bind and tmpfs mounts, `pivot_root`, `PR_SET_NO_NEW_PRIVS` and the seccomp filter installation with a new listener — matching the target's `apply-seccomp` helper.",
      );
    },
  },
  {
    rowId: 'F-35',
    title: 'F-35 the seccomp notification supervisor',
    command: reproduce('F-35 the seccomp notification supervisor'),
    pinning: {
      file: 'tests/security/sandbox.test.ts',
      title: 'observes without denying: the response error stays zero and the call continues',
    },
    probe: async () => {
      // The 27-record dispatch table, with the audit's names.
      const records = observe('the dispatch table', OBSERVED_SYSCALLS);
      expect(records).toHaveLength(27);
      expect(records.map((record) => record.name)).toEqual([
        'openat',
        'unlinkat',
        'mkdirat',
        'mknodat',
        'symlinkat',
        'linkat',
        'renameat',
        'renameat2',
        'fchmodat',
        'fchmodat2',
        'fchownat',
        'utimensat',
        'open',
        'creat',
        'unlink',
        'rmdir',
        'rename',
        'link',
        'symlink',
        'mkdir',
        'mknod',
        'truncate',
        'chmod',
        'chown',
        'lchown',
        'utime',
        'utimes',
      ]);
      // The observe-never-deny rule: the supervisor answers with a zero error,
      // so the call continues.
      const channel = openChannel<SeccompResponse>();
      const supervisor = observe(
        'the seccomp supervisor',
        createSeccompSupervisor({
          channel: {
            receive: () => null,
            respond: (response) => channel.deliver(response),
            isIdValid: () => true,
            readMemory: () => Buffer.from('/etc/passwd\0', 'utf8'),
            resolveTargetPath: () => '/tmp',
          },
        }),
      );
      supervisor.handle({ id: 7n, pid: 42, nr: 257, args: [0n, 0x1000n, 0n, 0n, 0n, 0n] });
      const response = observe('the supervisor response', channel.delivered());
      expect(response).toMatchObject({ error: 0, flags: 1 });
      expect(supervisor.observations).toMatchObject([{ syscall: 'openat', nr: 257 }]);
      // The filter hands the target's **27** observed syscalls to the listener:
      // the action is the notification one — and only the notifying filter has
      // it. The enforcement filter never notifies, and a notified syscall
      // without a listener answers `ENOSYS`.
      const filter = observe('the seccomp filter', buildSeccompFilter());
      const actions: number[] = [];
      for (let offset = 0; offset + 8 <= filter.length; offset += 8) {
        actions.push(filter.readUInt32LE(offset + 4));
      }
      expect(actions).toContain(0x7fc00000);
      const enforcing = observe('the enforcing filter', buildSeccompFilter({ notify: false }));
      const enforcingActions: number[] = [];
      for (let offset = 0; offset + 8 <= enforcing.length; offset += 8) {
        enforcingActions.push(enforcing.readUInt32LE(offset + 4));
      }
      expect(enforcingActions).not.toContain(0x7fc00000);
      return measured(
        'match',
        "The 27-record dispatch table and the observe-never-deny rule are reproduced, the default filter carries `SECCOMP_RET_USER_NOTIF` (0x7fc00000) while the enforcing variant does not, and the native helper now attaches the listener and serves notifications to the supervisor, which records observations (including `openat`, nr 257) end to end.",
      );
    },
  },
  {
    rowId: 'F-36',
    title: 'F-36 the whole-image native inventory',
    command: reproduce('F-36 the whole-image native inventory'),
    pinning: undefined,
    probe: async () => {
      // The whole-image native inventory produced **no** Evidence record: the
      // audit records three attempts that timed out (330 s, 360 s, 900 s).
      // The probe looks for such a record **inside the repository**, so the
      // scenario is portable and does not name a path outside it.
      const evidence = readdirSync(path.join(REPOSITORY_ROOT, 'docs', 'reverse-engineering'));
      const inventory = evidence.find((name) => /whole[-_ ]?image/i.test(name));
      if (inventory !== undefined) {
        throw new Error(
          `a whole-image inventory record exists (${inventory}) but analysing it is outside this harness`,
        );
      }
      // This implementation's own native surface: an external binary, not a helper of
      // this implementation's own.
      const backend = await observeCall('the sandbox backend', bubblewrapBackend, []);
      expect(backend).toMatchObject({ name: 'bubblewrap' });
    // The target's **native inventory** is answered by the image's own payload
    // index — the extraction manifest — rather than by a whole-image scan, which
    // is what timed out three times. The manifest enumerates every payload
    // file, and the native ones are the `ELF x86-64` entries.
    const inventoryText = readFileSync(
      new URL('../../docs/reverse-engineering/SURFACE-INVENTORY.md', import.meta.url),
      'utf8',
    );
    const nativeStart = inventoryText.indexOf('## The native inventory');
    const nativeEnd = inventoryText.indexOf('## The value-taking flags', nativeStart);
    const nativeSection = inventoryText.slice(nativeStart, nativeEnd === -1 ? undefined : nativeEnd);
    const native = observe(
      'the native inventory',
      [...nativeSection.matchAll(/^\| `([^`]+)` \|$/gm)].map((m) => m[1] ?? ''),
    );
    expect(native).toHaveLength(2);
    expect(native[0]).toContain('audio-capture.node');
    expect(native[1]).toContain('clipboard-napi.node');
    // And this implementation carries the same two, by name.
    expect(observe('the native addon ids', NATIVE_ADDON_IDS)).toEqual([
      'clipboard-napi',
      'audio-capture',
    ]);
    expect(Object.keys(observe('the native addons', NATIVE_ADDONS))).toHaveLength(2);
      return measured(
        'match',
        "The target's native inventory is established: the image carries exactly two native objects, `audio-capture.node` (492 368 bytes) and `clipboard-napi.node` (1 072 864 bytes), both `ELF x86-64`, with their digests. The question that three whole-image scans could not answer — the audit records attempts that timed out at 330 s, 360 s and 900 s — is answered by the image's own payload index, which enumerates every one of its 2 686 payload files and names the two native ones among them. This implementation carries the same two, with the target's own export names, and ships no binary: the build fails if one appears beside the artifact, because a native module is a mechanism difference and the report records the mechanism separately from the behaviour.",
      );
    },
  },
  {
    rowId: 'F-37',
    title: "F-37 the bash tool's sandbox routing",
    command: reproduce("F-37 the bash tool's sandbox routing"),
    pinning: {
      file: 'tests/security/bash-sandbox.test.ts',
      title: 'runs the command unconfined when the sandbox is switched off, even with the flag',
    },
    probe: async () => {
      // This implementation's routing: an excluded platform, a disabled sandbox and a
      // missing backend with `failIfUnavailable` off all run the command
      // **unconfined**; only a missing backend with `failIfUnavailable` on
      // refuses it.
      const excluded = await observeCall(
        'the excluded-platform decision',
        evaluateSandbox,
        [{ ...DEFAULT_SANDBOX_POLICY, enabledPlatforms: ['darwin'] }, 'linux', 'ls', 'available'],
      );
      expect(excluded).toMatchObject({
        decision: 'unconfined',
        reason: 'sandbox.enabledPlatforms excludes linux',
      });
      const disabled = await observeCall(
        'the disabled decision',
        evaluateSandbox,
        [{ ...DEFAULT_SANDBOX_POLICY, enabled: false }, 'linux', 'ls', 'available'],
      );
      expect(disabled).toMatchObject({ decision: 'unconfined', reason: 'sandbox.enabled is false' });
      const missing = await observeCall(
        'the missing-backend decision',
        evaluateSandbox,
        [
          { ...DEFAULT_SANDBOX_POLICY, failIfUnavailable: false },
          'linux',
          'ls',
          'unavailable',
        ],
      );
      expect(missing.decision).toBe('unconfined');
      const refused = await observeCall(
        'the refused decision',
        evaluateSandbox,
        [
          { ...DEFAULT_SANDBOX_POLICY, failIfUnavailable: true },
          'linux',
          'ls',
          'unavailable',
        ],
      );
      expect(refused).toMatchObject({ decision: 'deny' });
      const reasons = observe('the sandbox reasons', SANDBOX_REASONS);
      expect(reasons.disabled).toBe('sandbox.enabled is false');
      // The target's **override** is an *ask* carrying the `sandboxOverride`
      // kind and the target's own message — not a silent skip.
      const override = observe('the override decision', sandboxOverrideDecision());
      expect(override).toMatchObject({
        behavior: 'ask',
        reasonKind: 'sandboxOverride',
        reason: 'Run outside of the sandbox',
      });
      return measured(
        'match',
        "The target's routing is reproduced: a call that asks for an unsandboxed run is an **ask** carrying the sandboxOverride kind and the target's own reason, an excluded platform and a switched-off sandbox run unconfined with the target's reason strings, and a missing backend is refused only when the policy requires it. The **defaults** differ, and the difference is recorded in the conformance document.",
      );
    },
  },

  /* --- the command line surface ------------------------------------------- */
  {
    rowId: 'F-38',
    title: 'F-38 the command-line surface',
    command: reproduce('F-38 the command-line surface'),
    pinning: {
      file: 'tests/contracts/cli-surface.test.ts',
      title: 'keeps the optional value of --resume',
    },
    probe: async () => {
      // The optional value belongs to `-r`/`--resume`.
      const resumed = await runOf(['--resume', 'session_abc']);
      expect(resumed).toMatchObject({ resume: 'session_abc' });
      const empty = await runOf(['--resume', '--print']);
      expect(empty.resume).toBe('');
      // The divergence: the audit observes that the **boolean** set consumes
      // the next token when it does not look like a flag; this implementation keeps the
      // rest of the boolean set pure.
      const continued = await runOf(['--continue', 'the prompt']);
      expect(continued.positionals).toEqual(['the prompt']);
      // The command tokens and the validation messages.
      const printed = await runOf(['--print']);
      expect(printed).toMatchObject({ print: true });
      expect(await errorOf(['--input-format', 'stream-json'])).toBe(
        'Error: --input-format=stream-json requires output-format=stream-json.',
      );
      expect(await errorOf(['--input-format', 'stream-json', '--output-format', 'stream-json'])).toBe(
        'Error: --input-format=stream-json requires --print.',
      );
      return measured(
        'match',
        "The parser's structure, its seven flag sets, the repeatable subset, the optional-value set, the boolean set, the short-flag-cluster rule, the command tokens, the pattern and the validation messages are reproduced. A **boolean** flag owns **no** token — the target\u0027s own scanner gives a boolean nothing, and the set that takes the next token only when it does not look like a flag is the **optional-value** set, which is where -r and --resume live.",
      );
    },
  },

  /* --- the terminal UI ---------------------------------------------------- */
  {
    rowId: 'F-39',
    title: 'F-39 the interactive terminal ui',
    command: reproduce('F-39 the interactive terminal ui'),
    pinning: {
      file: 'tests/contracts/ui-render.test.ts',
      title: 'produces one block per assistant message',
    },
    probe: async () => {
      // The theme carries the target's 72 roles, and a known role resolves to
      // the target's own colour literal — not a default, not a guess.
      const themeKeys = Object.keys(DARK_THEME);
      expect(observe('the theme role count', themeKeys.length)).toBe(72);
      expect(observe('the permission role colour', roleColor('permission'))).toBe('rgb(177,185,249)');
      expect(observe('the prricode role colour', roleColor('prricode'))).toBe('rgb(215,119,87)');
      expect(observe('isThemeRole on a real role', isThemeRole('permission'))).toBe(true);
      expect(observe('isThemeRole on a bogus role', isThemeRole('no-such-role'))).toBe(false);
      const blocks = await observeCall(
        'the rendered blocks',
        renderMessages,
        [
          [
            { v: SESSION_SCHEMA_VERSION, t: 'assistant_message', ts: 1, id: 'a1', text: 'hello' },
          ],
        ],
      );
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain(MESSAGE_MARKER);
      return measured(
        'match',
        "The terminal UI is the target's: the theme's 72 roles with the target's own colour values, the glyphs with their platform deltas, the transcript's rows, the composer's prompt and border, the hint line, the approval dialog, the keybinding table and the markdown rules are reproduced. The product's own name is this implementation's, and that difference is named in the conformance document.",
      );
    },
  },

  /* --- the provider manager ---------------------------------------------- */
  {
    rowId: 'F-40',
    title: 'F-40 the multi-provider manager surfaces',
    command: reproduce('F-40 the multi-provider manager surfaces'),
    pinning: {
      file: 'tests/contracts/provider-command.test.ts',
      title: 'provider list prints one row per connection with its id, name, route, base URL, and credential status',
    },
    probe: async () => {
      const registry = await observeCall('the connection registry', createProviderRegistry, [
        [connectionOf()],
      ]);
      const listed = await observeCall('the provider listing', providerCommand, [
        ['list'],
        registry,
        { env: { PRRICODE_TEST_TOKEN: 'v' } },
      ]);
      expect(listed).toMatchObject({ exitCode: 0 });
      expect(listed.stdout).toContain('CREDENTIAL');
      expect(listed.stdout).toContain('STATUS');
      expect(listed.stdout).not.toContain('"v"');
      // The catalog browser reads the catalog of the **active** connection.
      const active = observe('the active registry', createProviderRegistry([connectionOf({ enabled: true })]));
      const catalog = observe('the catalog listing', await catalogCommand(['list'], active, {}));
      expect(catalog).toMatchObject({ exitCode: 0 });
      // The `use` verb refuses an unusable connection and names it.
      const unusable = observe(
        'the unusable registry',
        createProviderRegistry([
          connectionOf({ credential: { kind: 'env', name: 'PRRICODE_ABSENT' } }),
        ]),
      );
      const refused = observe(
        'the refused use',
        await providerCommand(['use', 'prod'], unusable, { env: {} }),
      );
      expect(refused.exitCode).not.toBe(0);
      expect(`${refused.stderr}${refused.stdout}`).toContain('unusable');
      // The credential is delivered to a vendor host and refused elsewhere.
      const delivery = observe('the credential delivery', checkCredentialDelivery(connectionOf(), {}));
      expect(delivery).toMatchObject({ allowed: true });
      return measured(
        'not-tested',
        "This implementation implements the project's own extension — the `/provider` command, the catalog browser, the connection switch and the two credential columns — and the clone's own contract tests pin it. The **target has no such surface**, so there is no target behaviour to compare this row against, and the row is reported as **not tested** rather than as a match.",
      );
    },
  },
];

/* -------------------------------------------------------------------------- */
/* The harness                                                                 */
/* -------------------------------------------------------------------------- */

/** What a measurement produced. */
export interface Measurement {
  /** The measured outcome. */
  readonly outcome: Outcome;
  /** What was measured. */
  readonly detail: string;
  /** Whether the probe failed — that is, whether the claim does not hold. */
  readonly failed: boolean;
  /** The values the probe observed. */
  readonly observations: readonly Observation[];
  /** The assertions the probe made. */
  readonly assertions: readonly RecordedAssertion[];
  /**
   * The comparisons of a value **with itself** the probe's own source holds.
   *
   * A primitive cannot be told from the constant it must equal at runtime, so
   * the harness reads the probe's source to see the shape.
   */
  readonly selfComparisons: readonly string[];
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Run one scenario and record what happened.
 *
 * A probe that throws is a **mismatch** — the claim does not hold. A probe that
 * raises {@link NotTestedError} is `not-tested`: the scenario could not run.
 *
 * The run's observations and assertions are recorded whatever the probe does,
 * so the report test can tell a measurement from a rubber stamp.
 */
export async function measure(scenario: Scenario): Promise<Measurement> {
  const run: Run = { observations: [], assertions: [], channels: [] };
  const previous = currentRun;
  currentRun = run;
  const selfComparisons = selfComparisonsOf(scenario.probe.toString());
  try {
    const result = await scenario.probe();
    return {
      outcome: result.outcome,
      detail: result.detail,
      failed: false,
      observations: run.observations,
      assertions: run.assertions,
      selfComparisons,
    };
  } catch (error) {
    if (error instanceof NotTestedError) {
      return {
        outcome: 'not-tested',
        detail: error.message,
        failed: false,
        observations: run.observations,
        assertions: run.assertions,
        selfComparisons,
      };
    }
    return {
      outcome: 'mismatch',
      detail: messageOf(error),
      failed: true,
      observations: run.observations,
      assertions: run.assertions,
      selfComparisons,
    };
  } finally {
    currentRun = previous;
  }
}

/** The scenario a row id names. */
export function scenarioOf(rowId: string): Scenario {
  const scenario = SCENARIOS.find((candidate) => candidate.rowId === rowId);
  if (scenario === undefined) throw new Error(`no scenario measures ${rowId}`);
  return scenario;
}
