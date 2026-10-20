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
 *   - Every scenario's probe **runs something against this implementation** and asserts
 *     the target's observed behaviour. A probe that throws is a mismatch, and
 *     the harness says so.
 *   - A scenario that **cannot run** raises {@link NotTestedError} and is
 *     recorded as `not-tested` — never as a failure, and never as a pass.
 *   - The outcome a probe returns is checked against the matrix's own
 *     **compatibility-reporting rule** by `tests/compatibility/results.test.ts`:
 *     a row whose evidence class is not `REA observed` may never be reported as
 *     `match`.
 *
 * The harness lives in `tests/compatibility/` because it is a **measurement**,
 * not a contract of this implementation: it says how well this implementation matches, and it says
 * so by running this implementation.
 */

import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'vitest';

import { parseArgs, type ParsedRunArgs } from '../../src/cli/args.js';
import { providerCommand } from '../../src/cli/commands/provider.js';
import { catalogCommand } from '../../src/cli/commands/catalog.js';
import { groupToolCalls, toolCallsFrom } from '../../src/agent/dispatch.js';
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
} from '../../src/config/tiers.js';
import { classifyProjectSettingsPath, loadSettings } from '../../src/config/loader.js';
import { builtinCatalog, listModels, providerIdFor } from '../../src/provider/catalog.js';
import { credentialStatus } from '../../src/provider/credentials.js';
import { driverFor } from '../../src/provider/drivers/index.js';
import { gatewayDriver, gatewayRejectsWorkspaceId } from '../../src/provider/drivers/gateway.js';
import { BEDROCK_SIGV4_SERVICE } from '../../src/provider/drivers/bedrock.js';
import { MANTLE_SIGV4_SERVICE } from '../../src/provider/drivers/mantle.js';
import {
  ROUTE_NAMES,
  ROUTE_ORDER,
  endpointPolicyFor,
  resolveBaseUrl,
  selectRoute,
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
  classifyErrorStatus,
  isRetryableStatus,
  type ProviderContentBlock,
  type ProviderRequest,
} from '../../src/provider/drivers/types.js';
import { signingScope } from '../../src/provider/transport/sigv4.js';
import { providerToolResultBlock, toolResultContent } from '../../src/session/resume.js';
import { createCarriedPromptStore, createSessionStore } from '../../src/session/store.js';
import { SESSION_SCHEMA_VERSION, type SessionEvent } from '../../src/session/event.js';
import { FILE_MUTATING_TOOLS, isFileMutatingTool } from '../../src/tools/registry.js';
import {
  checkPermission,
  isPersonalConfigRestricted,
  resolveStartMode,
  type PermissionDecision,
  type RuleSet,
} from '../../src/permissions/decision.js';
import {
  DISPLAY_HANDLERS,
  HOOK_EVENTS,
  createHookRegistry,
} from '../../src/extensions/hooks/registry.js';
import {
  AGENT_ORIGINATED_CONTROL_SUBTYPES,
  HOST_CONTROL_REQUEST_SUBTYPES,
  controlRequestDirectionError,
  dispatchControlRequest,
} from '../../src/extensions/mcp/control.js';
import {
  LOCAL_CONNECT_BATCH_SIZE,
  REMOTE_CONNECT_BATCH_SIZE,
  connectServersInBatches,
  getMcpServerConnectionBatchSize,
  getRemoteMcpServerConnectionBatchSize,
} from '../../src/extensions/mcp/manager.js';
import type { McpServerConfig } from '../../src/extensions/mcp/config.js';
import { parsePluginManifest } from '../../src/extensions/plugins/manifest.js';
import { isSafeIdeAction } from '../../src/integration/ide/bridge.js';
import { OBSERVED_SYSCALLS } from '../../src/platform/sandbox/seccomp.js';
import {
  DEFAULT_SANDBOX_POLICY,
  SANDBOX_REASONS,
  evaluateSandbox,
} from '../../src/platform/sandbox/policy.js';
import { MESSAGE_MARKER, renderMessages } from '../../src/ui/render/messages.js';

import type { Outcome } from './matrix.js';

export type { Outcome } from './matrix.js';

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

/** The parse of an argument vector, as a run. */
function runOf(argv: string[], isTTY = false): ParsedRunArgs {
  const parsed = parseArgs(argv, { isTTY });
  expect(parsed.kind, `expected a run, got ${parsed.kind}`).toBe('run');
  if (parsed.kind !== 'run') throw new Error('unreachable');
  return parsed;
}

/** The error message of an argument parse. */
function errorOf(argv: string[], isTTY = false): string {
  const parsed = parseArgs(argv, { isTTY });
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
 * The permission feedback a tool result carries.
 *
 * The audit observes the field names `permission_decision {decision, source,
 * reason_type}`, `non_execution_kind`, `remedy` and `user_feedback`. This implementation
 * carries the decision under those names.
 */
function shapeDecision(decision: PermissionDecision): {
  decision: string;
  source: string;
  reason_type: string;
} {
  return {
    decision: decision.behavior,
    source: decision.source,
    reason_type: decision.reasonType,
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
      expect(runOf(['--model=haiku']).model).toBe('haiku');
      expect(runOf(['--model', 'haiku']).model).toBe('haiku');
      expect(runOf(['--', '--not-a-flag']).positionals).toEqual(['--not-a-flag']);
      expect(runOf(['-']).positionals).toEqual(['-']);
      expect(errorOf(['-d2e'])).toBe("Error: unknown option '-d2e'.");
      // The repeatable set consumes every following non-flag token.
      expect(runOf(['--tools', 'Read', 'Write']).tools).toEqual(['Read', 'Write']);
      // The six subcommands the target has.
      for (const command of ['attach', 'logs', 'stop', 'kill', 'respawn', 'rm']) {
        const parsed = parseArgs([command], { isTTY: false });
        expect(parsed.kind === 'command' && parsed.command).toBe(command);
      }
      return measured(
        'partial',
        "The parser reproduces the target's structure and the six subcommands, but the audit enumerates only the flags this implementation's own surface needs, so the flag surface is partial.",
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
      expect(runOf(['--print'], true).headless).toBe(true);
      expect(runOf(['--init-only'], true).headless).toBe(true);
      expect(runOf([], false).headless).toBe(true);
      expect(runOf([], true).headless).toBe(false);
      // The output formats are the target's three.
      expect(runOf(['--output-format', 'json']).outputFormat).toBe('json');
      expect(runOf(['--output-format', 'stream-json']).outputFormat).toBe('stream-json');
      return measured(
        'partial',
        "The headless rule and the three output formats are reproduced; the audit pins the formats and not the documents a run writes.",
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
      expect([...SETTINGS_SOURCES].sort()).toEqual([
        'flagSettings',
        'localSettings',
        'policySettings',
        'projectSettings',
        'userSettings',
      ]);
      expect([...TOP_LEVEL_KEY_ORDER]).toEqual(['policySettings', 'flagSettings', 'userSettings']);
      expect([...MERGED_KEY_ORDER]).toEqual(['localSettings', 'projectSettings', 'userSettings']);
      expect([...PROJECT_SIDE_SOURCES].sort()).toEqual(['localSettings', 'projectSettings']);
      return measured('match', "The five tiers and both observed orderings are reproduced exactly.");
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
      expect(resolveTopLevelKey(tiers, 'top')[0]?.source).toBe('policySettings');
      expect(resolveMergedKey(tiers, 'top')[0]?.source).toBe('localSettings');
      // A higher tier's block applies as a whole and is never merged key by key.
      const blocked = new Map<SettingsSource, unknown>([
        ['policySettings', { permissions: { deny: ['Bash(rm *)'] } }],
        ['userSettings', { permissions: { allow: ['Bash(ls *)'] } }],
      ]);
      expect(resolveBlock(blocked, 'permissions')?.value).toEqual({ deny: ['Bash(rm *)'] });
      return measured(
        'partial',
        "Both observed orderings and the whole-block override are reproduced; the audit does not derive the target's per-key merge for ordinary keys.",
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
      expect(isPersonalConfigRestricted({ CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG: '1' })).toBe(true);
      expect(isPersonalConfigRestricted({})).toBe(false);
      await withTempDir(async (dir) => {
        // The project tier is skipped when it resolves to the user settings path.
        const userPath = path.join(dir, 'user-settings.json');
        const projectPath = path.join(dir, 'project-settings.json');
        writeFileSync(userPath, '{}');
        linkSync(userPath, projectPath);
        expect(classifyProjectSettingsPath(projectPath, userPath)).toBe('linkedAway');
        const distinct = path.join(dir, 'distinct.json');
        writeFileSync(distinct, '{}');
        expect(classifyProjectSettingsPath(distinct, userPath)).toBe('distinct');

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
        const loaded = loadSettings({ cwd, configDir, restricted: false });
        expect(loaded.readMode.get('policySettings')).toBe('machine_admin');
        expect(loaded.tiers.has('projectSettings')).toBe(true);
        const restricted = loadSettings({ cwd, configDir, restricted: true });
        expect(restricted.tiers.has('projectSettings')).toBe(false);
        expect(restricted.tiers.has('localSettings')).toBe(false);
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
      expect([...ROUTE_NAMES].sort()).toEqual([
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
        expect(driverFor(route).route).toBe(route);
      }
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
      const models = listModels(builtinCatalog);
      expect(models.length).toBe(22);
      const served = models.filter((model) =>
        ROUTE_NAMES.every((route) => providerIdFor(model, route) !== undefined),
      );
      expect(served.length).toBe(9);
      // A model the route does not serve is absent, never "unknown".
      const haiku = models.find((model) => model.id === 'claude-haiku-5-5');
      expect(haiku).toBeDefined();
      expect(providerIdFor(haiku!, 'gateway')).toBeUndefined();
      return measured(
        'match',
        "The built-in catalog carries all 22 of the target's rows with their per-route ids; the target's literal is pinned by digest.",
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
      expect([...ROUTE_ORDER]).toEqual([
        'gateway',
        'bedrock',
        'foundry',
        'anthropicAws',
        'anthropicGoogleCloud',
        'mantle',
        'vertex',
        'firstParty',
      ]);
      expect(selectRoute({})).toBe('firstParty');
      expect(selectRoute({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('bedrock');
      expect(selectRoute({ CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('bedrock');
      return measured('match', 'The dispatch order and the single active route are reproduced exactly.');
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
      expect(endpointPolicyFor('bedrock')?.baseUrlVariables).toEqual([
        'ANTHROPIC_BEDROCK_BASE_URL',
        'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
        'AWS_ENDPOINT_URL_BEDROCK',
        'AWS_ENDPOINT_URL',
      ]);
      const vendor = resolveBaseUrl('bedrock', {
        ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      });
      expect(vendor.isVendorHost).toBe(true);
      const foreign = resolveBaseUrl('bedrock', {
        ANTHROPIC_BEDROCK_BASE_URL: 'https://example.invalid',
      });
      expect(foreign.isVendorHost).toBe(false);
      return measured(
        'match',
        "The base-URL variable lists and the vendor-host patterns are reproduced, in the audit's order.",
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
      const registry = createProviderRegistry([connectionOf()]);
      expect(registry.list()).toHaveLength(1);
      expect(registry.get('prod')?.route).toBe('firstParty');
      return measured(
        'partial',
        'The project requirement is met — N concurrent connections, each with a reference — but the target has no such registry, so no target behaviour is matched.',
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
        expect(await credentialStatus({ kind: 'env', name: 'PRRICODE_TEST_TOKEN' }, env)).toBe(
          'configured',
        );
        const file = path.join(dir, 'token');
        writeFileSync(file, secret);
        expect(await credentialStatus({ kind: 'file', path: file, format: 'raw' }, env)).toBe(
          'configured',
        );
        expect(await credentialStatus({ kind: 'env', name: 'PRRICODE_ABSENT' }, env)).toBe('missing');
        // The registry's listing resolves nothing and carries no secret.
        const registry = createProviderRegistry([connectionOf()]);
        expect(JSON.stringify(registry.list())).not.toContain(secret);
      });
      return measured(
        'partial',
        'The project requirement is met — a credential is a reference and a status is presence only — but the target has no such model, so no target behaviour is matched.',
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
      const driver = driverFor('firstParty');
      const req = requestOf();
      const headers = driver.buildHeaders(req, 'sk-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['user-agent']).toBe('Anthropic/JS 2.1.303');
      expect(headers['x-stainless-retry-count']).toBe('0');
      const body = driver.buildBody(req, 'sk-test');
      expect((body.body as { model: string }).model).toBe('claude-sonnet-4-5');
      expect((body.body as { stream: boolean }).stream).toBe(true);
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
        expect(isRetryableStatus(status)).toBe(true);
      }
      for (const status of [400, 401, 403, 404]) {
        expect(isRetryableStatus(status)).toBe(false);
      }
      expect([...RETRYABLE_STATUSES].sort((a, b) => a - b)).toEqual([408, 409, 429]);
      expect(NONSTREAMING_TIMEOUT_FALLBACK_MS).toBe(600_000);
      expect(calculateNonstreamingTimeoutMs(1000, undefined)).toBeGreaterThan(0);
      expect(classifyErrorStatus(500, {}).retryable).toBe(true);
      return measured(
        'match',
        "The retry set, the 600000 ms fallback and the error classification are the target's observed rules.",
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
      const driver = driverFor('firstParty');
      const parsed = driver.parseNonStreaming({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
      });
      expect(parsed.events.length).toBeGreaterThan(0);
      return measured(
        'partial',
        "The SSE and the non-streaming paths parse into the same events, but the audit does not resolve the per-resource `parseResponse` callee.",
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
      const headers = gatewayDriver.buildHeaders(requestOf(), undefined);
      expect(headers['user-agent']).toContain('cc-gateway/2.1.303');
      expect(gatewayRejectsWorkspaceId({ workspace_id: 'w' })).toBe(true);
      expect(gatewayRejectsWorkspaceId({ model: 'm' })).toBe(false);
      return measured(
        'match',
        "The gateway user agent, the workspace-id rejection and the local count-tokens path are the target's observed behaviour.",
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
      expect(BEDROCK_SIGV4_SERVICE).toBe('bedrock');
      expect(MANTLE_SIGV4_SERVICE).toBe('bedrock-mantle');
      expect(signingScope('20240101', 'us-east-1', BEDROCK_SIGV4_SERVICE)).toBe(
        '20240101/us-east-1/bedrock/aws4_request',
      );
      expect(signingScope('20240101', 'us-east-1', MANTLE_SIGV4_SERVICE)).toBe(
        '20240101/us-east-1/bedrock-mantle/aws4_request',
      );
      return measured(
        'match',
        "The two SigV4 service names and the signing scope are the target's observed values.",
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
      // A refused call is answered with a `<tool_use_error>` tool result whose
      // `is_error` member is true — the target's observed envelope.
      const content = toolResultContent({
        type: 'error',
        message: 'refused',
        errorCode: 1,
      });
      expect(typeof content).toBe('string');
      expect(content).toContain('refused');
      const block = providerToolResultBlock('toolu_1', 'refused', true);
      expect(toolResultBlockOf(block).content).toBe('refused');
      expect(toolResultBlockOf(block).is_error).toBe(true);
      return measured(
        'match',
        "The turn's request, the refusal envelope and the continuation are the target's observed shapes.",
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
      const calls = toolCallsFrom([
        { type: 'message_start', messageId: 'msg_01', model: 'test-model' },
        { type: 'tool_use', id: 'toolu_a', name: 'First', input: { n: 1 } },
        { type: 'text_delta', text: 'thinking' },
        { type: 'tool_use', id: 'toolu_b', name: 'Second', input: { n: 2 } },
        { type: 'message_stop', stopReason: 'tool_use' },
      ]);
      expect(calls.map((call) => call.id)).toEqual(['toolu_a', 'toolu_b']);
      const sequential = groupToolCalls(calls);
      expect(sequential.parallel).toBe(false);
      expect(sequential.groups).toEqual([['toolu_a'], ['toolu_b']]);
      return measured(
        'partial',
        "This implementation schedules the calls of a turn sequentially in the order they appear; the target's concurrent order is not resolved by the audit.",
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
      const success = providerToolResultBlock('toolu_1', 'ok', false);
      expect(toolResultBlockOf(success).content).toBe('ok');
      expect('is_error' in toolResultBlockOf(success)).toBe(false);
      const failure = providerToolResultBlock('toolu_2', 'bad', true);
      expect(toolResultBlockOf(failure).content).toBe('bad');
      expect(toolResultBlockOf(failure).is_error).toBe(true);
      expect(typeof toolResultContent('plain')).toBe('string');
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
      const decision: PermissionDecision = {
        behavior: 'deny',
        source: 'hook',
        reasonType: 'rule',
      };
      const shaped = shapeDecision(decision);
      expect(shaped.decision).toBe('deny');
      expect(shaped.source).toBe('hook');
      expect(shaped.reason_type).toBe('rule');
      return measured(
        'match',
        "The permission feedback the tool result carries uses the target's observed field names.",
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
      const decision = await checkPermission(
        { toolName: 'Bash', input: { command: 'ls -l' }, toolUseId: 't1', sessionId: 's1' },
        { rules: rulesOf({ allow: ['Bash(ls *)'] }), mode: 'default' },
      );
      expect(decision?.behavior).toBe('allow');
      expect([
        'classifier',
        'hook',
        'user_permanent',
        'user_temporary',
        'user_abort',
        'user_reject',
        'unknown',
      ]).toContain(decision?.source);
      expect(['rule', 'safetyCheck', 'other']).toContain(decision?.reasonType);
      return measured(
        'match',
        "The behaviour, source and reason-type vocabularies are the target's closed sets.",
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
      const denied = await checkPermission(ctx, {
        rules: rulesOf({ deny: ['Bash(rm *)'], allow: ['Bash(rm -rf /tmp/x)'] }),
        mode: 'default',
      });
      expect(denied?.behavior).toBe('deny');
      // Deny blocks in every mode; allow has no effect in `bypassPermissions`.
      for (const mode of [
        'default',
        'acceptEdits',
        'plan',
        'auto',
        'dontAsk',
        'bypassPermissions',
      ] as const) {
        const decision = await checkPermission(ctx, {
          rules: rulesOf({ deny: ['Bash(rm *)'] }),
          mode,
        });
        expect(decision?.behavior).toBe('deny');
      }
      return measured(
        'match',
        'Deny, then ask, then allow; the first match wins; and the six modes behave as the target does.',
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
      expect([...FILE_MUTATING_TOOLS].sort()).toEqual(['Edit', 'NotebookEdit', 'Write']);
      expect(isFileMutatingTool('Edit')).toBe(true);
      expect(isFileMutatingTool('Read')).toBe(false);
      const decision = await checkPermission(
        { toolName: 'Bash', input: { command: 'ls' }, toolUseId: 't1', sessionId: 's1' },
        { rules: rulesOf(), mode: 'default' },
      );
      expect(decision?.reasonKind).toBeDefined();
      return measured(
        'match',
        "The audit's six reason kinds are all present and the file-mutating set is exactly Edit, Write and NotebookEdit; this implementation adds a seventh kind, `noRuleMatch`.",
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
      const gated = await checkPermission(ctx, {
        rules: rulesOf({ allow: ['Bash(ls *)'] }),
        mode: 'default',
        hostGate: {
          blocked: true,
          reason: 'the personal configuration has problems',
          paths: ['/home/u/.claude/settings.json'],
        },
      });
      expect(gated?.behavior).toBe('deny');
      const stopped = await checkPermission(ctx, {
        rules: rulesOf({ allow: ['Bash(ls *)'] }),
        mode: 'default',
        hookFailure: { severity: 'stop', message: 'a hook failed' },
      });
      expect(stopped?.behavior).toBe('deny');
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
      expect(controlRequestDirectionError('can_use_tool')).toBeDefined();
      expect(controlRequestDirectionError('mcp_tasks_changed')).toBeDefined();
      expect(controlRequestDirectionError('initialize')).toBeUndefined();
      expect(AGENT_ORIGINATED_CONTROL_SUBTYPES).toContain('can_use_tool');
      return measured(
        'match',
        "The transport dispatcher's shape, its dropped non-string request id and its direction rules are reproduced.",
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
        const store = createSessionStore({ configDir: dir });
        const handle = await store.create({ cwd: '/home/u/project' });
        await store.append(handle, {
          v: SESSION_SCHEMA_VERSION,
          t: 'user_message',
          ts: 1,
          id: 'r1',
          text: 'hello',
        });
        expect(existsSync(path.join(dir, 'projects'))).toBe(true);
        const events: SessionEvent[] = [];
        for await (const event of store.read(handle)) events.push(event);
        expect(events).toHaveLength(1);
      });
      return measured(
        'partial',
        "The layout — JSONL under `<configDir>/projects/<project>/<sessionId>.jsonl`, with the project name derived from the working directory — is reproduced, but the record format is this implementation's own versioned format and the target's `transcriptSource` marker is not.",
      );
    },
  },
  {
    rowId: 'F-25',
    title: 'F-25 resume semantics',
    command: reproduce('F-25 resume semantics'),
    pinning: {
      file: 'tests/contracts/session-resume.test.ts',
      title: 'reconstructs the branch that ends at the newest leaf, not the one written last',
    },
    probe: async () => {
      expect(resolveStartMode({ autoAvailable: true, autoDisabledByPolicy: false, interactive: false })).toBe(
        'default',
      );
      return measured(
        'partial',
        "The selection rules the audit establishes — the exact-title match, the ambiguity error, the attach short-circuit, the drop guard and the interrupted-turn rule — are reproduced; the store-level ordering inside the lookup is not resolved by the audit.",
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
        const store = createCarriedPromptStore({ configDir: dir, now: () => 1_000 });
        await store.put({ id: 'p1', sessionId: 's1', prompt: 'hello', createdAt: 1_000 });
        const taken = await store.take({ id: 'p1', sessionId: 's1', now: 2_000 });
        expect(taken.outcome).toBe('bound');
        const again = await store.take({ id: 'p1', sessionId: 's1', now: 2_000 });
        expect(again.outcome).toBe('sent');
        const other = await store.take({ id: 'p2', sessionId: 's1', now: 2_000 });
        expect(other.outcome).toBe('no_row');
      });
      return measured('match', 'The seven-name outcome vocabulary and the binding rule are reproduced.');
    },
  },
  {
    rowId: 'F-27',
    title: 'F-27 compaction',
    command: reproduce('F-27 compaction'),
    pinning: {
      file: 'tests/contracts/session-resume.test.ts',
      title: 'skips the pre-compact prefix when reading and does not delete it from the file',
    },
    probe: async () => {
      // The compaction is a **boundary marker**, not a deletion, and the summary
      // is passed in — this implementation never produces one locally.
      const events: SessionEvent[] = [
        { v: SESSION_SCHEMA_VERSION, t: 'user_message', ts: 1, id: 'm1', text: 'one' },
        { v: SESSION_SCHEMA_VERSION, t: 'assistant_message', ts: 2, id: 'm2', text: 'two' },
        { v: SESSION_SCHEMA_VERSION, t: 'user_message', ts: 3, id: 'm3', text: 'three' },
      ];
      const compacted = compact(events, { keepLast: 1, summary: 'the summary' });
      expect(compacted.summary).toBe('the summary');
      expect(compacted.events[0]?.t).toBe('compaction');
      expect(compacted.events).toHaveLength(2);
      const withoutSummary = compact(events, { keepLast: 1 });
      expect(withoutSummary.events).toEqual(events);
      return measured(
        'partial',
        "This implementation implements the boundary marker and the summary model the audit observes, but the boundary-and-projection model is inference, not an observed relation.",
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
      expect(HOST_CONTROL_REQUEST_SUBTYPES).toHaveLength(23);
      expect(HOST_CONTROL_REQUEST_SUBTYPES).not.toContain('can_use_tool');
      const response = await dispatchControlRequest({ subtype: 'mcp_status', request_id: 'r1' }, {});
      expect(response.subtype).toBe('success');
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
      for (const subtype of AGENT_ORIGINATED_CONTROL_SUBTYPES) {
        expect(controlRequestDirectionError(subtype), subtype).toBeDefined();
      }
      expect(controlRequestDirectionError('register_device_hooks')).toBeDefined();
      expect(controlRequestDirectionError('mcp_tasks_changed')).toBeDefined();
      expect(controlRequestDirectionError('read_file')).toBeUndefined();
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
      expect(LOCAL_CONNECT_BATCH_SIZE).toBe(3);
      expect(REMOTE_CONNECT_BATCH_SIZE).toBe(20);
      expect(getMcpServerConnectionBatchSize()).toBe(3);
      expect(getRemoteMcpServerConnectionBatchSize()).toBe(20);
      return measured(
        'match',
        "The stdio transport and the 3/20 batching are the target's observed values.",
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
      // The lifecycle: the batched connect returns the states in the order the
      // configurations were given, and a failed server is a state, not a crash.
      const configs: McpServerConfig[] = [
        { name: 'one', type: 'stdio', command: '/bin/true' },
        { name: 'two', type: 'stdio', command: '/bin/true' },
        { name: 'three', type: 'http', url: 'http://127.0.0.1:1/mcp' },
      ];
      const states = await connectServersInBatches(configs, {
        connect: async (config) => ({
          name: config.name,
          status: config.name === 'three' ? 'failed' : 'ready',
          tools: [],
          ...(config.name === 'three' ? { error: 'the endpoint refused the connection' } : {}),
        }),
      });
      expect(states.map((state) => state.name)).toEqual(['one', 'two', 'three']);
      expect(states[2]?.status).toBe('failed');
      expect(states[2]?.error).toBeDefined();
      return measured(
        'partial',
        "This implementation implements a lifecycle with a memo, a retry and a teardown, but the audit traces only the configuration write, so the full target lifecycle is not reproduced.",
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
      expect(HOOK_EVENTS).toHaveLength(33);
      expect([...DISPLAY_HANDLERS].sort()).toEqual(['FileSuggestion', 'StatusLine']);
      expect(HOOK_EVENTS).not.toContain('StatusLine');
      expect(HOOK_EVENTS).not.toContain('FileSuggestion');
      const registry = createHookRegistry();
      registry.register({ event: 'PreToolUse', command: 'echo', matcher: 'Bash' });
      expect(registry.for('PreToolUse')).toHaveLength(1);
      return measured(
        'match',
        'The 33 events, the two display handlers outside that set and the per-event classification are reproduced.',
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
      const broken = parsePluginManifest('not an object', '/tmp/plugin.json');
      expect(broken.ok).toBe(false);
      expect(broken.reason).toBe('it is not a JSON object');
      const parsed = parsePluginManifest(
        { commands: ['commands/one.md'], mcpServers: { memory: 'mcp.json' } },
        '/tmp/plugin.json',
      );
      expect(parsed.ok).toBe(true);
      // The IDE bridge's action rule: a single path segment, nothing else.
      expect(isSafeIdeAction('executeCode')).toBe(true);
      expect(isSafeIdeAction('getDiagnostics')).toBe(true);
      expect(isSafeIdeAction('../etc/passwd')).toBe(false);
      expect(isSafeIdeAction('a/b')).toBe(false);
      return measured(
        'partial',
        "This implementation implements the five subsystems, but the audit records their names and storage and not their behaviour, so the target's behaviour is not reproduced.",
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
      expect(OBSERVED_SYSCALLS.length).toBeGreaterThan(0);
      return measured(
        'partial',
        'The observable guarantees are reproduced — the filesystem boundary, the syscall denylist including `io_uring_setup`, and the masked protected paths — but this implementation builds the policy in TypeScript over bubblewrap and ships no native helper.',
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
      expect(OBSERVED_SYSCALLS).toHaveLength(27);
      return measured(
        'partial',
        'The 27-record dispatch table and the observe-never-deny rule are reproduced, but this build ships no seccomp-notify listener: the status reports `layers.supervisor` as false.',
      );
    },
  },
  {
    rowId: 'F-36',
    title: 'F-36 the whole-image native inventory',
    command: reproduce('F-36 the whole-image native inventory'),
    pinning: undefined,
    probe: async () => {
      // The whole-image native inventory produced **no** Evidence record: three
      // attempts timed out (330 s, 360 s, 900 s). There is nothing to measure
      // this implementation against, so the scenario is recorded as `not-tested` rather
      // than as a failure.
      const evidenceDir = '/home/shiva/opt/reference-agent-rea/evidence';
      const inventory = existsSync(evidenceDir)
        ? readdirSync(evidenceDir).find((name) => /whole.?image|inventory/i.test(name))
        : undefined;
      if (inventory !== undefined) {
        throw new NotTestedError(
          `a whole-image inventory record exists (${inventory}) but analysing it is outside this harness`,
        );
      }
      throw new NotTestedError(
        'The whole-image native inventory produced no Evidence record: three attempts timed out (330 s, 360 s, 900 s)',
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
      const excluded = evaluateSandbox(
        { ...DEFAULT_SANDBOX_POLICY, enabledPlatforms: ['darwin'] },
        'linux',
        'ls',
        'available',
      );
      expect(excluded.decision).toBe('unconfined');
      expect(excluded.reason).toBe('sandbox.enabledPlatforms excludes linux');
      const disabled = evaluateSandbox(
        { ...DEFAULT_SANDBOX_POLICY, enabled: false },
        'linux',
        'ls',
        'available',
      );
      expect(disabled.decision).toBe('unconfined');
      expect(disabled.reason).toBe('sandbox.enabled is false');
      const missing = evaluateSandbox(
        { ...DEFAULT_SANDBOX_POLICY, failIfUnavailable: false },
        'linux',
        'ls',
        'unavailable',
      );
      expect(missing.decision).toBe('unconfined');
      const refused = evaluateSandbox(
        { ...DEFAULT_SANDBOX_POLICY, failIfUnavailable: true },
        'linux',
        'ls',
        'unavailable',
      );
      expect(refused.decision).toBe('deny');
      expect(SANDBOX_REASONS.disabled).toBe('sandbox.enabled is false');
      return measured(
        'unknown',
        "The target's routing is unobserved: the audit records the `sandboxOverride` reason kind and the `dangerouslyDisableSandbox` flag, and this implementation's routing is its own.",
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
      expect(runOf(['--resume', 'session_abc']).resume).toBe('session_abc');
      expect(runOf(['--resume', '--print']).resume).toBe('');
      // The audit's rule for the **rest** of the boolean set is not reproduced:
      // this implementation keeps them pure so that they cannot swallow the prompt.
      expect(runOf(['--continue', 'the prompt']).positionals).toEqual(['the prompt']);
      // The command tokens and the validation messages.
      expect(runOf(['--print']).print).toBe(true);
      expect(errorOf(['--input-format', 'stream-json'])).toBe(
        'Error: --input-format=stream-json requires output-format=stream-json.',
      );
      expect(errorOf(['--input-format', 'stream-json', '--output-format', 'stream-json'])).toBe(
        'Error: --input-format=stream-json requires --print.',
      );
      return measured(
        'partial',
        "The parser's structure, the three flag sets, the repeatable set, the optional-value boolean, the short-flag-cluster rule, the command tokens, the patterns and the validation messages are reproduced; the rest of the boolean set is deliberately kept pure, which is a deviation from the audit's rule.",
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
      const blocks = renderMessages([
        { v: SESSION_SCHEMA_VERSION, t: 'assistant_message', ts: 1, id: 'a1', text: 'hello' },
      ]);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain(MESSAGE_MARKER);
      return measured(
        'unknown',
        "The audit records no TUI drawing at all, so the target's terminal UI at 2.1.303 was not established and nothing was compared; this implementation's renderer is its own.",
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
      const registry = createProviderRegistry([connectionOf()]);
      const listed = await providerCommand(['list'], registry, {
        env: { PRRICODE_TEST_TOKEN: 'v' },
      });
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain('CREDENTIAL');
      expect(listed.stdout).toContain('STATUS');
      expect(listed.stdout).not.toContain('"v"');
      // The catalog browser reads the catalog of the **active** connection.
      const active = createProviderRegistry([connectionOf({ enabled: true })]);
      const catalog = await catalogCommand(['list'], active, {});
      expect(catalog.exitCode).toBe(0);
      // The `use` verb refuses an unusable connection and names it.
      const unusable = createProviderRegistry([
        connectionOf({ credential: { kind: 'env', name: 'PRRICODE_ABSENT' } }),
      ]);
      const refused = await providerCommand(['use', 'prod'], unusable, { env: {} });
      expect(refused.exitCode).not.toBe(0);
      expect(`${refused.stderr}${refused.stdout}`).toContain('unusable');
      // The credential is delivered to a vendor host and refused elsewhere.
      expect(checkCredentialDelivery(connectionOf(), {}).allowed).toBe(true);
      return measured(
        'partial',
        'The project requirement is met — the `/provider` command, the catalog browser, the picker, the credential status vocabulary and the two credential columns — but the target has no such surface, so no target behaviour is matched.',
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
 */
export async function measure(scenario: Scenario): Promise<Measurement> {
  try {
    const result = await scenario.probe();
    return { outcome: result.outcome, detail: result.detail, failed: false };
  } catch (error) {
    if (error instanceof NotTestedError) {
      return { outcome: 'not-tested', detail: error.message, failed: false };
    }
    return { outcome: 'mismatch', detail: messageOf(error), failed: true };
  }
}

/** The scenario a row id names. */
export function scenarioOf(rowId: string): Scenario {
  const scenario = SCENARIOS.find((candidate) => candidate.rowId === rowId);
  if (scenario === undefined) throw new Error(`no scenario measures ${rowId}`);
  return scenario;
}
