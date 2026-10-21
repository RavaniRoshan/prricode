/**
 * The **self-hosted runner** surface: the target's nine tools, the
 * environment variables its runner reads, and the protocol around them.
 *
 * Evidence: the target's own source, read out of the pinned build. The full
 * reading, with every file and byte offset, is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-self-hosted-runner.md`.
 *
 * | what | where in the target |
 * |---|---|
 * | the nine tools | `chunk-c4brmbaw.js` — `Qt({name:…` at `:4775`, `:5759`, `:6740`, `:7653`, `:8648`, `:10067`, `:11180`, `:13575`, `:15681`; the export array at `:16557` |
 * | the nine names | `chunk-e8yvb8wq.js:424` |
 * | the nine descriptions | `chunk-e8yvb8wq.js:955` |
 * | the transport | `chunk-dqnsxcf9.js` — the default health port at `:1137`, the first-party gate and the auth at `:1160`–`:1195` |
 * | the registration gate | `chunk-705mhzj8.js:151190` and `:154526`; the latch at `chunk-d8mq0b21.js:101740` |
 * | the runner's configuration and its environment variables | `chunk-56g9kk6e.js:210931` (the config), `:69502` (the numeric reader), `:208227` (the retire-at reader) |
 * | the runner's API client | `chunk-s45rta2n.js:9372`–`:15400` |
 * | the CLI subcommand tree | `cli.mjs:19835` |
 * | the setup wizard's own tool list | `chunk-jn8w77mq.js:14557` |
 *
 * ## What the target's surface is
 *
 * A **self-hosted runner** is a process on an operator's own machine that
 * registers with the account's environment-management service, polls for
 * sessions, and runs them locally. The nine tools are how an agent *observes
 * and drives* that deployment: five read or write the account's own
 * environment state over an authenticated API, and four read or start a runner
 * on the operator's machine.
 *
 * ## The honest boundary
 *
 * **This implementation has no self-hosted runner.** There is no runner
 * process, no runner registration, no environment secret, no account and no
 * environment-management service here. A tool that pretended to read a pool's
 * runner count, or that spawned a runner process that does not exist, would be
 * a lie told to the model — and the model would act on it.
 *
 * So the surface is **recorded and shaped, never faked**:
 *
 *   - the **nine tools** exist, with the target's names, descriptions, input
 *     schemas, result shapes, endpoints, Admin-UI paths, read-only flags,
 *     concurrency flags and permission rules;
 *   - the **environment variables** the runner reads are named, with the
 *     target's defaults and the target's validation — the runner's own
 *     configuration surface is reproduced as **data**, because a deployment
 *     that reads a renamed variable is a deployment that does not work;
 *   - and **every one of the nine refuses**, with a typed failure that names
 *     the capability it needed: the account's environment-management API, a
 *     local runner, or a runner process.
 *
 * ## The two rules the target's own flags encode
 *
 * The two write tools — `self_hosted_runner_requeue_session` and
 * `self_hosted_runner_spawn_local` — declare, in the target:
 *
 *   - `ignoresWholeToolAllowRule()` — a **whole-tool** allow rule does not
 *     apply to them. The target's own check answers `ask` in every mode but
 *     `auto`, so a bare `allow: ["self_hosted_runner_spawn_local"]` cannot
 *     wave them through. Reproduced here: the whole-tool allow rules for the
 *     tool are dropped before the check runs, and the tool's own check answers.
 *   - `suppressesAlwaysAllowRule()` — the "don't ask again" affordance does
 *     not persist an always-allow rule for them. **This implementation has no
 *     always-allow persistence**, so the flag has no counterpart here; it is
 *     recorded and named rather than pretended at.
 *
 * In `auto` mode the target's own check *passes* the call to the classifier
 * ("requires classifier review"), so the classifier decides. Reproduced: in
 * `auto` mode the tool's own check stands aside and the standard check runs.
 *
 * Implementation choices (the target does not pin them, so they are marked
 * here):
 *
 *   - The **refusal** is this implementation's own. The target has a runner, so
 *     the target never refuses; here the refusal is a typed
 *     `capabilityUnavailable` that names the capability the tool needed.
 *   - The **capability names** are this implementation's own.
 *   - The **input validation** is this implementation's own: it checks the
 *     target's schema — the required fields, the types and the bounds — and
 *     reports the typed codes the rest of this implementation reports.
 *   - The **environment-variable reader** is this implementation's own. The
 *     target's reader lives inside the runner's own process, and the runner
 *     does not exist here; what is reproduced is the *contract*: the names,
 *     the defaults, the accepted values and the validation messages.
 *   - The **product's own name** replaces the target's where the target's own
 *     text names it. Nothing else in the descriptions is changed.
 */

import {
  TOOL_ERROR_CODES,
  withoutWholeToolAllowRules,
  type ToolDefinition,
} from '../registry.js';
import type { PermissionDecision, ToolContext } from '../../permissions/decision.js';
import { safetyCheckForTool } from '../../permissions/prompts.js';

import {
  capabilityRefusal,
  checkToolPermissions,
  recheckToolPermissions,
  type BuiltinToolDeps,
} from './shared.js';

/* -------------------------------------------------------------------------- */
/* The capabilities                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The capability the five account-side tools need.
 *
 * The pool, the runners, the sessions, the secrets and the requeue all live
 * behind the account's environment-management API, and the target reaches it
 * with the operator's OAuth session — never with an API key.
 */
export const SELF_HOSTED_API_CAPABILITY = 'self-hosted environment management API';

/**
 * The capability the three local tools need.
 *
 * `self_hosted_runner_read_health`, `self_hosted_runner_read_metrics` and
 * `self_hosted_runner_tail_log` read a runner **on the operator's own
 * machine**: its `/healthz` endpoint, its `/metrics` endpoint and its log
 * file.
 */
export const SELF_HOSTED_LOCAL_CAPABILITY = 'local self-hosted runner';

/**
 * The capability `self_hosted_runner_spawn_local` needs.
 *
 * It starts a **detached runner process** on this machine. There is no such
 * process here, and no subcommand that could start one.
 */
export const SELF_HOSTED_SPAWN_CAPABILITY = 'self-hosted runner process';

/* -------------------------------------------------------------------------- */
/* The nine tools                                                               */
/* -------------------------------------------------------------------------- */

/** One of the target's nine self-hosted runner tools. */
export interface SelfHostedRunnerToolSpec {
  /** The tool's name, as the model calls it. */
  name: string;
  /** The description the model sees. The target's own text. */
  description: string;
  /** The target's own one-line summary of when to reach for the tool. */
  searchHint: string;
  /** The input schema, as JSON Schema. The target's own shape. */
  inputSchema: unknown;
  /** The fields the target's own result carries. */
  resultFields: readonly string[];
  /** The endpoint the tool calls, when it calls one. */
  endpoint?: string;
  /** The Admin-UI path the target reports as `equivalent.ui`. */
  equivalentUi?: string;
  /** Whether the target declares the tool read-only. */
  readOnly: boolean;
  /** Whether the target declares the tool concurrency safe. */
  concurrencySafe: boolean;
  /** The target's result-size cap, in characters. */
  maxResultSizeChars: number;
  /** Whether the target's own check lets code execution through. */
  enablesCodeExecution?: boolean;
  /** Whether the target ignores a whole-tool allow rule for this tool. */
  ignoresWholeToolAllowRule?: boolean;
  /** Whether the target suppresses the always-allow affordance for this tool. */
  suppressesAlwaysAllowRule?: boolean;
  /** The capability the tool needs, and that this implementation does not have. */
  capability: string;
}

/**
 * The target's own operator-facing tail, shared by the five account-side
 * tools.
 *
 * `chunk-e8yvb8wq.js:955` — the target's text, with the product's own name
 * where the target's own text names its product.
 */
const OPERATOR_TAIL =
  '\nThe result includes an `equivalent.ui` string with the Admin-UI path. Surface it to the operator so they can repeat the action without you.' +
  '\nAuth: handled internally via the operator\'s PRRICODE login OAuth session — secrets never enter the conversation.';

/**
 * The target's nine tools, in the target's own order.
 *
 * **The data is the target's.** The names, the descriptions, the input
 * schemas, the result shapes, the endpoints, the Admin-UI paths and the flags
 * are the target's own, read out of the pinned build.
 */
export const SELF_HOSTED_RUNNER_TOOL_SPECS: readonly SelfHostedRunnerToolSpec[] = Object.freeze([
  {
    name: 'self_hosted_runner_get_pool',
    description:
      "Read a self-hosted environment's aggregate state (alive_runner_count, available_capacity_total, capacity_in_use, pending_session_count, unplaceable_session_count, backing_off_count, circuit_broken_count)." +
      OPERATOR_TAIL,
    searchHint: 'read self-hosted environment aggregates and queue counts',
    inputSchema: {
      type: 'object',
      properties: {
        pool_id: {
          type: 'string',
          description: 'Tagged environment id (ccpool_…).',
        },
      },
      required: ['pool_id'],
      additionalProperties: false,
    },
    resultFields: ['pool', 'equivalent'],
    endpoint: '/v1/code/runners/self-hosted/pools/{pool_id}',
    equivalentUi:
      'Admin settings → Cloud environments → Self-hosted environments → (environment) — header stat tiles',
    readOnly: true,
    concurrencySafe: true,
    maxResultSizeChars: 100000,
    capability: SELF_HOSTED_API_CAPABILITY,
  },
  {
    name: 'self_hosted_runner_list_runners',
    description:
      'List runners registered to a self-hosted environment, with per-runner lease_expires_at, locked_account_id/email, and assigned_session_count.' +
      OPERATOR_TAIL,
    searchHint: 'list registered self-hosted runners for an environment',
    inputSchema: {
      type: 'object',
      properties: {
        pool_id: {
          type: 'string',
          description: 'Tagged environment id (ccpool_…).',
        },
      },
      required: ['pool_id'],
      additionalProperties: false,
    },
    resultFields: ['runners', 'equivalent'],
    endpoint: '/v1/code/runners/self-hosted/runners?pool_id={pool_id}',
    equivalentUi:
      'Admin settings → Cloud environments → Self-hosted environments → (environment) → Activity tab → Runners',
    readOnly: true,
    concurrencySafe: true,
    maxResultSizeChars: 100000,
    capability: SELF_HOSTED_API_CAPABILITY,
  },
  {
    name: 'self_hosted_runner_list_sessions',
    description:
      'List sessions queued/assigned in a self-hosted environment (status, failure_log[], excluded_runner_ids, spawn_attempt, spawn_last_error).' +
      OPERATOR_TAIL,
    searchHint: 'list queued/assigned sessions in a self-hosted environment',
    inputSchema: {
      type: 'object',
      properties: {
        pool_id: {
          type: 'string',
          description: 'Tagged environment id (ccpool_…).',
        },
        status_filter: {
          type: 'string',
          description: 'Optional server-side status filter (e.g. "queued").',
        },
      },
      required: ['pool_id'],
      additionalProperties: false,
    },
    resultFields: ['sessions', 'equivalent'],
    endpoint: '/v1/code/runners/self-hosted/pools/{pool_id}/sessions',
    equivalentUi:
      'Admin settings → Cloud environments → Self-hosted environments → (environment) → Activity tab → Sessions',
    readOnly: true,
    concurrencySafe: true,
    maxResultSizeChars: 100000,
    capability: SELF_HOSTED_API_CAPABILITY,
  },
  {
    name: 'self_hosted_runner_list_secrets',
    description:
      'List environment secrets (jti, label, created_at, revoked, last_used_at). Secret values are never returned — only metadata.' +
      OPERATOR_TAIL,
    searchHint: 'list self-hosted environment secrets (metadata only)',
    inputSchema: {
      type: 'object',
      properties: {
        pool_id: {
          type: 'string',
          description: 'Tagged environment id (ccpool_…).',
        },
      },
      required: ['pool_id'],
      additionalProperties: false,
    },
    resultFields: ['secrets', 'equivalent'],
    endpoint: '/v1/code/runners/self-hosted/pools/{pool_id}/secrets',
    equivalentUi:
      'Admin settings → Cloud environments → Self-hosted environments → (environment) → Configuration tab → Environment keys',
    readOnly: true,
    concurrencySafe: true,
    maxResultSizeChars: 100000,
    capability: SELF_HOSTED_API_CAPABILITY,
  },
  {
    name: 'self_hosted_runner_spawn_local',
    description:
      "Spawn a self-hosted runner as a detached background process on THIS machine using this binary's `self-hosted-runner` subcommand. Always passes `--base-dir` (the runner's default of /workspace is unwritable on operator laptops) and uses space-separated flags only. Returns {pid, log_path, health_port, command} — `command` is the equivalent shell line for the operator's cheat sheet. This is for the zero→aha proof; production deployment (k8s / docker-compose) is taught, not tooled.",
    searchHint: 'start a local self-hosted runner process for try-it-out',
    inputSchema: {
      type: 'object',
      properties: {
        secret_file_path: {
          type: 'string',
          description: 'Path to the environment secret the operator saved from the Admin UI.',
        },
        capacity: {
          type: 'integer',
          exclusiveMinimum: 0,
          description: 'Default 1.',
        },
        base_dir: {
          type: 'string',
          description:
            'Always passed to the runner (its built-in default of /workspace is unwritable on laptops). Default: ./runner-setup/workspace',
        },
        health_port: {
          type: 'integer',
          description: 'Default 8080. 0 disables /healthz.',
        },
        log_path: {
          type: 'string',
          description: 'Default: ./runner-setup/runner.log',
        },
      },
      required: ['secret_file_path'],
      additionalProperties: false,
    },
    resultFields: ['pid', 'pid_file', 'log_path', 'health_port', 'command'],
    readOnly: false,
    concurrencySafe: false,
    maxResultSizeChars: 100000,
    enablesCodeExecution: true,
    ignoresWholeToolAllowRule: true,
    suppressesAlwaysAllowRule: true,
    capability: SELF_HOSTED_SPAWN_CAPABILITY,
  },
  {
    name: 'self_hosted_runner_read_health',
    description:
      'GET http://127.0.0.1:{health_port}/healthz on the local runner (2s timeout). Returns the health JSON, or {disabled:true} when health_port is 0, or {unreachable:true,error} when nothing is listening.',
    searchHint: 'probe local self-hosted runner /healthz endpoint',
    inputSchema: {
      type: 'object',
      properties: {
        health_port: {
          type: 'integer',
          description: 'Default 8080. 0 means disabled.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    resultFields: ['health', 'disabled', 'unreachable', 'error'],
    endpoint: 'http://127.0.0.1:{health_port}/healthz',
    readOnly: true,
    concurrencySafe: true,
    maxResultSizeChars: 100000,
    capability: SELF_HOSTED_LOCAL_CAPABILITY,
  },
  {
    name: 'self_hosted_runner_read_metrics',
    description:
      'GET http://127.0.0.1:{health_port}/metrics on the local runner and parse the `claude_code_self_hosted_runner_*` Prometheus gauges into {capacity, active_sessions, last_poll_age_seconds, locked_account_email?}.',
    searchHint: 'read self-hosted runner Prometheus gauges from /metrics',
    inputSchema: {
      type: 'object',
      properties: {
        health_port: {
          type: 'integer',
          description: 'Default 8080. 0 means disabled.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    resultFields: ['gauges', 'raw', 'disabled', 'unreachable', 'error'],
    endpoint: 'http://127.0.0.1:{health_port}/metrics',
    readOnly: true,
    concurrencySafe: true,
    maxResultSizeChars: 100000,
    capability: SELF_HOSTED_LOCAL_CAPABILITY,
  },
  {
    name: 'self_hosted_runner_tail_log',
    description:
      "Read the last N bytes of the runner's --log-file with the shared secret redaction (key=value secrets, sk-ant/Bearer/Basic, URL userinfo, JWTs, and VCS/service PATs — see redact() in src/utils/secretRedaction.ts for the current rule set) applied before the content reaches model context.",
    searchHint: 'tail self-hosted runner log file with secret redaction',
    inputSchema: {
      type: 'object',
      properties: {
        log_path: {
          type: 'string',
          description: 'Path to the runner’s --log-file.',
        },
        bytes: {
          type: 'integer',
          exclusiveMinimum: 0,
          description: 'How many trailing bytes to read. Default 65536.',
        },
      },
      required: ['log_path'],
      additionalProperties: false,
    },
    resultFields: ['lines', 'bytes_read', 'error'],
    readOnly: true,
    concurrencySafe: true,
    maxResultSizeChars: 200000,
    capability: SELF_HOSTED_LOCAL_CAPABILITY,
  },
  {
    name: 'self_hosted_runner_requeue_session',
    description:
      "Requeue an assigned session onto a different runner. Appends the observed runner to the session's excluded_runner_ids so the queue pop doesn't immediately hand it back. Takes session_id + runner_id (the runner the caller observed failing). Only write operation in the doctor tool suite." +
      OPERATOR_TAIL,
    searchHint: 'requeue a stuck self-hosted runner session onto another runner',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Tagged session id (ccsess_…).',
        },
        runner_id: {
          type: 'string',
          description:
            'Tagged runner id (ccrunner_…) the caller observed failing. Server verifies this still matches the session assignment; mismatch returns Conflict. For a stuck session whose runner is gone, any value is accepted.',
        },
      },
      required: ['session_id', 'runner_id'],
      additionalProperties: false,
    },
    resultFields: ['excluded_count', 'equivalent'],
    endpoint: '/v1/code/runners/self-hosted/sessions/{session_id}/requeue',
    equivalentUi:
      'Admin settings → Cloud environments → Self-hosted environments → (environment) → Activity tab → Sessions → (session) → Retry',
    readOnly: false,
    concurrencySafe: false,
    maxResultSizeChars: 100000,
    enablesCodeExecution: true,
    ignoresWholeToolAllowRule: true,
    suppressesAlwaysAllowRule: true,
    capability: SELF_HOSTED_API_CAPABILITY,
  },
]);

/** The names of the target's nine runner tools, in the target's order. */
export const SELF_HOSTED_RUNNER_TOOL_NAMES: readonly string[] = Object.freeze(
  SELF_HOSTED_RUNNER_TOOL_SPECS.map((spec) => spec.name),
);

/**
 * The two tools the target's own check answers `ask` for.
 *
 * `chunk-c4brmbaw.js:11180` and `:13575`.
 */
export const SELF_HOSTED_RUNNER_WRITE_TOOL_NAMES: readonly string[] = Object.freeze([
  'self_hosted_runner_spawn_local',
  'self_hosted_runner_requeue_session',
]);

/**
 * The tools the target's setup wizard hands to its child session.
 *
 * `chunk-jn8w77mq.js:14557` — fifteen tools: eight of the session's own, and
 * **seven** of the nine runner tools. `self_hosted_runner_list_sessions` and
 * `self_hosted_runner_requeue_session` are **not** among them.
 */
export const SELF_HOSTED_RUNNER_WIZARD_TOOL_NAMES: readonly string[] = Object.freeze([
  'Bash',
  'Read',
  'Write',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'self_hosted_runner_get_pool',
  'self_hosted_runner_list_runners',
  'self_hosted_runner_list_secrets',
  'self_hosted_runner_read_health',
  'self_hosted_runner_read_metrics',
  'self_hosted_runner_spawn_local',
  'self_hosted_runner_tail_log',
]);

/* -------------------------------------------------------------------------- */
/* The protocol                                                                 */
/* -------------------------------------------------------------------------- */

/** One call of the runner's own protocol. */
export interface SelfHostedRunnerProtocolCall {
  /** The target's own name of the call. */
  name: string;
  /** The method and the path the target calls. */
  method: 'GET' | 'POST';
  /** The path, with the target's own placeholders. */
  path: string;
  /** The target's own timeout, in milliseconds. */
  timeoutMs: number;
  /** Where the target's own source holds it. */
  readAt: string;
}

/**
 * The runner's own protocol — the ten calls it makes against the account.
 *
 * `chunk-s45rta2n.js:9372`–`:15400`, and the work-hints stream at
 * `chunk-56g9kk6e.js:209800`.
 */
export const SELF_HOSTED_RUNNER_PROTOCOL: readonly SelfHostedRunnerProtocolCall[] = Object.freeze([
  {
    name: 'RegisterRunner',
    method: 'POST',
    path: '/v1/code/runners/self-hosted/runners/register',
    timeoutMs: 15000,
    readAt: 'chunk-s45rta2n.js:9372',
  },
  {
    name: 'PollSpawnHints',
    method: 'POST',
    path: '/v1/code/runners/self-hosted/spawn-hints/poll',
    timeoutMs: 30000,
    readAt: 'chunk-s45rta2n.js:10005',
  },
  {
    name: 'NackSpawnHint',
    method: 'POST',
    path: '/v1/code/runners/self-hosted/spawn-hints/nack',
    timeoutMs: 15000,
    readAt: 'chunk-s45rta2n.js:11078',
  },
  {
    name: 'PollWork',
    method: 'POST',
    path: '/v1/code/runners/self-hosted/runners/{runnerId}/poll',
    timeoutMs: 10000,
    readAt: 'chunk-s45rta2n.js:11594',
  },
  {
    name: 'IssueSessionToken',
    method: 'POST',
    path: '/v1/code/runners/self-hosted/sessions/{sessionId}/token',
    timeoutMs: 15000,
    readAt: 'chunk-s45rta2n.js:12972',
  },
  {
    name: 'ReportSessionFailure',
    method: 'POST',
    path: '/v1/code/runners/self-hosted/sessions/{sessionId}/report-failure',
    timeoutMs: 15000,
    readAt: 'chunk-s45rta2n.js:13596',
  },
  {
    name: 'ReleaseSession',
    method: 'POST',
    path: '/v1/code/runners/self-hosted/sessions/{sessionId}/release',
    timeoutMs: 15000,
    readAt: 'chunk-s45rta2n.js:14170',
  },
  {
    name: 'DeregisterRunner',
    method: 'POST',
    path: '/v1/code/runners/self-hosted/deregister',
    timeoutMs: 10000,
    readAt: 'chunk-s45rta2n.js:14577',
  },
  {
    name: 'RefreshToken',
    method: 'POST',
    path: '/v1/code/auth/refresh',
    timeoutMs: 15000,
    readAt: 'chunk-s45rta2n.js:15142',
  },
  {
    name: 'WorkHintsStream',
    method: 'GET',
    path: '/v1/code/runners/self-hosted/runners/{runnerId}/work-hints/stream',
    timeoutMs: 45000,
    readAt: 'chunk-56g9kk6e.js:209800',
  },
]);

/**
 * The header the runner sends on every call.
 *
 * `chunk-s45rta2n.js:6175` and `:6346`.
 */
export const SELF_HOSTED_RUNNER_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
  'x-self-hosted-runner-version': '2.1.303',
});

/**
 * The CLI subcommand tree.
 *
 * `cli.mjs:19835` — the `self-hosted-runner` subcommand and its five
 * subcommands.
 */
export const SELF_HOSTED_RUNNER_CLI_SUBCOMMANDS: readonly string[] = Object.freeze([
  'orchestrator',
  'setup',
  'doctor',
  'code-sign',
  'decode-token',
]);

/**
 * The Prometheus prefix the target's metrics tool parses.
 *
 * `chunk-c4brmbaw.js:10061`.
 */
export const SELF_HOSTED_RUNNER_METRIC_PREFIX = 'claude_code_self_hosted_runner_';

/**
 * The gauges the target's metrics tool **drops**.
 *
 * `chunk-c4brmbaw.js:10061` — every `*_bucket`, plus `session_idle_seconds`
 * and `poll_errors_total`.
 */
export const SELF_HOSTED_RUNNER_IGNORED_METRICS: readonly string[] = Object.freeze([
  'session_idle_seconds',
  'poll_errors_total',
]);

/**
 * The default health port.
 *
 * `chunk-dqnsxcf9.js:1137` — `var _Ke=8080`.
 */
export const SELF_HOSTED_RUNNER_DEFAULT_HEALTH_PORT = 8080;

/**
 * The default byte count the log tool reads.
 *
 * `chunk-c4brmbaw.js:15435` — `var q=65536`.
 */
export const SELF_HOSTED_RUNNER_DEFAULT_TAIL_BYTES = 65536;

/* -------------------------------------------------------------------------- */
/* The environment variables                                                    */
/* -------------------------------------------------------------------------- */

/** What kind of value an environment variable holds. */
export type SelfHostedRunnerEnvKind =
  | 'path'
  | 'secret'
  | 'boolean'
  | 'enum'
  | 'duration-ms'
  | 'port'
  | 'epoch-seconds'
  | 'label'
  | 'command';

/** One of the environment variables the target's runner reads. */
export interface SelfHostedRunnerEnvSpec {
  /** The variable's name. The target's own. */
  name: string;
  /** What kind of value it holds. */
  kind: SelfHostedRunnerEnvKind;
  /**
   * The target's own default.
   *
   * `undefined` means the target has no default for it: the variable is unset
   * unless the operator sets it.
   */
  default?: string | number | boolean;
  /** The values the target accepts, for an enum. */
  values?: readonly string[];
  /** The target's own validation message, when it has one. */
  message?: string;
  /** Where the target reads it. */
  readAt: string;
}

/**
 * The environment variables the target's runner reads.
 *
 * **Thirty-seven.** The names, the defaults and the accepted values are the
 * target's own, read out of the pinned build. The record's list held thirty-one
 * and missed the ten the runner reads through a variable — see
 * `findings-self-hosted-runner.md` §3.1.
 */
export const SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLES: readonly SelfHostedRunnerEnvSpec[] =
  Object.freeze([
    {
      name: 'SELF_HOSTED_RUNNER_BASE_DIR',
      kind: 'path',
      default: '/workspace',
      readAt: 'chunk-56g9kk6e.js:210931',
    },
    {
      name: 'SELF_HOSTED_RUNNER_BG_RESULT_GRACE_MS',
      kind: 'duration-ms',
      default: 30000,
      readAt: 'chunk-56g9kk6e.js:140361',
    },
    {
      name: 'SELF_HOSTED_RUNNER_CLIENT_LABEL',
      kind: 'label',
      readAt: 'chunk-56g9kk6e.js:211415',
    },
    {
      name: 'SELF_HOSTED_RUNNER_CONFIGURE_GIT',
      kind: 'boolean',
      default: false,
      readAt: 'chunk-56g9kk6e.js:211597',
    },
    {
      name: 'SELF_HOSTED_RUNNER_CONFINE_REPO_SETTINGS',
      kind: 'enum',
      default: 'warn',
      values: ['enforce', 'warn', 'off'],
      message:
        'SELF_HOSTED_RUNNER_CONFINE_REPO_SETTINGS must be one of enforce/warn/off (got: {value})',
      readAt: 'chunk-56g9kk6e.js:210016',
    },
    {
      name: 'SELF_HOSTED_RUNNER_DEBUG_DIR',
      kind: 'path',
      readAt: 'chunk-a5tzvmf3.js:16830',
    },
    {
      name: 'SELF_HOSTED_RUNNER_DEBUG_TOKEN_DIR',
      kind: 'path',
      readAt: 'chunk-56g9kk6e.js:211293',
    },
    {
      name: 'SELF_HOSTED_RUNNER_DEFER_SHUTDOWN_MAX_MS',
      kind: 'duration-ms',
      default: 0,
      readAt: 'chunk-56g9kk6e.js:218397',
    },
    {
      name: 'SELF_HOSTED_RUNNER_DRAIN_GRACE_MS',
      kind: 'duration-ms',
      default: 0,
      readAt: 'chunk-56g9kk6e.js:217436',
    },
    {
      name: 'SELF_HOSTED_RUNNER_DRAIN_MARKER_FILE',
      kind: 'path',
      readAt: 'chunk-56g9kk6e.js:208454',
    },
    {
      name: 'SELF_HOSTED_RUNNER_DRAIN_WAIT_BG_TASKS_MS',
      kind: 'duration-ms',
      default: 0,
      readAt: 'chunk-56g9kk6e.js:69810',
    },
    {
      name: 'SELF_HOSTED_RUNNER_DRAIN_WAIT_MS',
      kind: 'duration-ms',
      default: 0,
      readAt: 'chunk-56g9kk6e.js:69810',
    },
    {
      name: 'SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET',
      kind: 'secret',
      readAt: 'chunk-56g9kk6e.js:221399',
    },
    {
      name: 'SELF_HOSTED_RUNNER_EXEC_PATH',
      kind: 'path',
      readAt: 'chunk-56g9kk6e.js:211105',
    },
    {
      name: 'SELF_HOSTED_RUNNER_HEALTH_PORT',
      kind: 'port',
      default: SELF_HOSTED_RUNNER_DEFAULT_HEALTH_PORT,
      message: 'SELF_HOSTED_RUNNER_HEALTH_PORT must be an integer in [0, 65535] (0 disables), got: {value}',
      readAt: 'chunk-56g9kk6e.js:209591',
    },
    {
      name: 'SELF_HOSTED_RUNNER_HOOKS_DIR',
      kind: 'path',
      readAt: 'chunk-56g9kk6e.js:211204',
    },
    {
      name: 'SELF_HOSTED_RUNNER_HOST_CONFIG_DIR',
      kind: 'path',
      default: '~/.claude',
      readAt: 'chunk-56g9kk6e.js:137009',
    },
    {
      name: 'SELF_HOSTED_RUNNER_HOST_CONFIG_SNAPSHOT',
      kind: 'enum',
      default: 'disk',
      values: ['disk', 'memory'],
      message: 'SELF_HOSTED_RUNNER_HOST_CONFIG_SNAPSHOT must be one of disk/memory (got: {value})',
      readAt: 'chunk-56g9kk6e.js:210847',
    },
    {
      name: 'SELF_HOSTED_RUNNER_IDLE_SHUTDOWN_MS',
      kind: 'duration-ms',
      default: 0,
      readAt: 'chunk-56g9kk6e.js:215559',
    },
    {
      name: 'SELF_HOSTED_RUNNER_LOCK_TO_ACCOUNT',
      kind: 'label',
      readAt: 'chunk-56g9kk6e.js:211356',
    },
    {
      name: 'SELF_HOSTED_RUNNER_LOG_FILE',
      kind: 'path',
      readAt: 'chunk-56g9kk6e.js:211170',
    },
    {
      name: 'SELF_HOSTED_RUNNER_MAX_LIFETIME_GRACE_MS',
      kind: 'duration-ms',
      default: 900000,
      readAt: 'chunk-56g9kk6e.js:139519',
    },
    {
      name: 'SELF_HOSTED_RUNNER_MAX_LIFETIME_MS',
      kind: 'duration-ms',
      default: 0,
      readAt: 'chunk-56g9kk6e.js:139459',
    },
    {
      name: 'SELF_HOSTED_RUNNER_POOL_SECRET',
      kind: 'secret',
      readAt: 'chunk-56g9kk6e.js:221476',
    },
    {
      name: 'SELF_HOSTED_RUNNER_POST_SESSION_HOOK_TIMEOUT_MS',
      kind: 'duration-ms',
      default: 60000,
      readAt: 'chunk-56g9kk6e.js:216397',
    },
    {
      name: 'SELF_HOSTED_RUNNER_POST_TURN_SETTLE_MS',
      kind: 'duration-ms',
      default: 7000,
      readAt: 'chunk-56g9kk6e.js:140412',
    },
    {
      name: 'SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_COMMAND',
      kind: 'command',
      readAt: 'chunk-zjm15h4n.js:17376',
    },
    {
      name: 'SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_FILE',
      kind: 'path',
      readAt: 'chunk-zjm15h4n.js:17456',
    },
    {
      name: 'SELF_HOSTED_RUNNER_PUSH_OUTCOME_ON_RELEASE',
      kind: 'boolean',
      default: false,
      readAt: 'chunk-56g9kk6e.js:211667',
    },
    {
      name: 'SELF_HOSTED_RUNNER_REMOVE_SESSION_STATE',
      kind: 'boolean',
      default: false,
      readAt: 'chunk-56g9kk6e.js:211840',
    },
    {
      name: 'SELF_HOSTED_RUNNER_RETIRE_AT',
      kind: 'epoch-seconds',
      default: 0,
      readAt: 'chunk-56g9kk6e.js:208259',
    },
    {
      name: 'SELF_HOSTED_RUNNER_SERVER_AUTO_MODE_LISTS',
      kind: 'enum',
      default: 'no-allow',
      values: ['all', 'no-allow', 'none'],
      message:
        'SELF_HOSTED_RUNNER_SERVER_AUTO_MODE_LISTS must be one of all/no-allow/none (got: {value})',
      readAt: 'chunk-56g9kk6e.js:210619',
    },
    {
      name: 'SELF_HOSTED_RUNNER_SESSION_IDLE_MS',
      kind: 'duration-ms',
      default: 0,
      readAt: 'chunk-56g9kk6e.js:217715',
    },
    {
      name: 'SELF_HOSTED_RUNNER_SESSION_STOP_GRACE_MS',
      kind: 'duration-ms',
      default: 5000,
      readAt: 'chunk-56g9kk6e.js:215871',
    },
    {
      name: 'SELF_HOSTED_RUNNER_SIGKILL_GRACE_MS',
      kind: 'duration-ms',
      default: 30000,
      readAt: 'chunk-56g9kk6e.js:139603',
    },
    {
      name: 'SELF_HOSTED_RUNNER_STARTUP_TIMEOUT_MS',
      kind: 'duration-ms',
      default: 900000,
      readAt: 'chunk-56g9kk6e.js:218045',
    },
    {
      name: 'SELF_HOSTED_RUNNER_TRUST_WORKSPACE',
      kind: 'boolean',
      default: true,
      readAt: 'chunk-56g9kk6e.js:211730',
    },
  ]);

/** The names of the environment variables the target's runner reads. */
export const SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES: readonly string[] = Object.freeze(
  SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLES.map((spec) => spec.name),
);

/**
 * The environment variables the target **refuses or ignores on purpose**.
 *
 * `chunk-56g9kk6e.js:244624` and `:245018`. They are part of the surface: a
 * deployment that sets one of them must be told what happens to it.
 */
export const SELF_HOSTED_RUNNER_REFUSED_ENVIRONMENT_VARIABLES: readonly {
  name: string;
  /** What the target does with it. */
  behaviour: 'fatal' | 'ignored';
  /** The target's own message. */
  message: string;
}[] = Object.freeze([
  {
    name: 'SELF_HOSTED_RUNNER_SIGKILL_TIMEOUT_MS',
    behaviour: 'fatal',
    message:
      'SELF_HOSTED_RUNNER_SIGKILL_TIMEOUT_MS was renamed to SELF_HOSTED_RUNNER_SESSION_STOP_GRACE_MS. It controls how long to wait for the PRRICODE process to exit cleanly after a session ends, before force-killing it. The post-session hook runs after this.',
  },
  {
    name: 'SELF_HOSTED_RUNNER_RELEASE_IDLE_SESSION_MIN',
    behaviour: 'ignored',
    message:
      'SELF_HOSTED_RUNNER_RELEASE_IDLE_SESSION_MIN is set but is not a setting this runner reads — it is being IGNORED. The session idle-release window is configured with --release-idle-session-min <minutes> (or env SELF_HOSTED_RUNNER_SESSION_IDLE_MS, in milliseconds).',
  },
  {
    name: 'SELF_HOSTED_RUNNER_SESSION_IDLE_MIN',
    behaviour: 'ignored',
    message:
      'SELF_HOSTED_RUNNER_SESSION_IDLE_MIN is set but is not a setting this runner reads — it is being IGNORED. The session idle-release window is configured with --release-idle-session-min <minutes> (or env SELF_HOSTED_RUNNER_SESSION_IDLE_MS, in milliseconds).',
  },
  {
    name: 'SELF_HOSTED_RUNNER_SESSION_IDLE_SEC',
    behaviour: 'ignored',
    message:
      'SELF_HOSTED_RUNNER_SESSION_IDLE_SEC is set but is not a setting this runner reads — it is being IGNORED. The session idle-release window is configured with --release-idle-session-min <minutes> (or env SELF_HOSTED_RUNNER_SESSION_IDLE_MS, in milliseconds).',
  },
]);

/**
 * The environment variables the target clears from a child session.
 *
 * `chunk-56g9kk6e.js:136917` — the secrets never reach the child.
 */
export const SELF_HOSTED_RUNNER_CLEARED_ENVIRONMENT_VARIABLES: readonly string[] = Object.freeze([
  'SELF_HOSTED_RUNNER_POOL_SECRET',
  'SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET',
  'SELF_HOSTED_RUNNER_HOST_CONFIG_DIR',
]);

/**
 * The environment variable the surface touches that is **not** under the
 * `SELF_HOSTED_RUNNER_` prefix.
 *
 * `chunk-56g9kk6e.js:210931`.
 */
export const SELF_HOSTED_RUNNER_GIT_PROXY_VARIABLE = 'CLAUDE_RUNNER_USE_GIT_PROXY';

/**
 * The environment the target's runner configuration resolves to.
 */
export interface SelfHostedRunnerEnvironment {
  /**
   * Every variable's value, after validation.
   *
   * A variable the operator did not set carries the target's own default, and
   * a variable with no default is absent.
   */
  readonly values: Readonly<Record<string, string | number | boolean>>;
  /** The variables the target refuses, with the target's own message. */
  readonly refused: readonly { name: string; behaviour: 'fatal' | 'ignored'; message: string }[];
  /** The variables that carry an invalid value. */
  readonly invalid: readonly { name: string; message: string }[];
}

/**
 * Read the target's runner environment.
 *
 * **The contract is the target's**: the names, the defaults, the accepted
 * values and the validation messages. The **reader** is this implementation's
 * own — the target's reader lives inside the runner's own process, and there is
 * no runner here.
 *
 * A value the target rejects is reported in `invalid` rather than thrown, so a
 * caller sees every problem at once; the target stops the runner at startup on
 * the first invalid value.
 */
export function readSelfHostedRunnerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SelfHostedRunnerEnvironment {
  const values: Record<string, string | number | boolean> = {};
  const refused: { name: string; behaviour: 'fatal' | 'ignored'; message: string }[] = [];
  const invalid: { name: string; message: string }[] = [];

  for (const spec of SELF_HOSTED_RUNNER_REFUSED_ENVIRONMENT_VARIABLES) {
    const raw = env[spec.name];
    if (raw === undefined) continue;
    refused.push({ name: spec.name, behaviour: spec.behaviour, message: spec.message });
  }

  for (const spec of SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLES) {
    const raw = env[spec.name];
    if (raw === undefined || raw === '') {
      if (spec.default !== undefined) values[spec.name] = spec.default;
      continue;
    }
    const resolved = resolveEnvValue(spec, raw);
    if (!resolved.ok) {
      invalid.push({ name: spec.name, message: resolved.message });
      if (spec.default !== undefined) values[spec.name] = spec.default;
      continue;
    }
    values[spec.name] = resolved.value;
  }

  return { values, refused, invalid };
}

/**
 * The outcome of resolving one variable's value.
 *
 * A rejected value carries the target's own message; an accepted one carries
 * the value.
 */
type EnvResolution =
  | { ok: true; value: string | number | boolean }
  | { ok: false; message: string };

/**
 * Resolve one variable's value, or the target's own rejection message.
 */
function resolveEnvValue(spec: SelfHostedRunnerEnvSpec, raw: string): EnvResolution {
  switch (spec.kind) {
    case 'boolean': {
      const value = raw.trim().toLowerCase();
      if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
        return { ok: true, value: true };
      }
      if (value === '0' || value === 'false' || value === 'no' || value === 'off') {
        return { ok: true, value: false };
      }
      return {
        ok: false,
        message: `${spec.name} must be one of 1/true/yes/on or 0/false/no/off (got: ${raw})`,
      };
    }
    case 'enum': {
      const value = raw.trim().toLowerCase();
      if (spec.values?.includes(value) === true) return { ok: true, value };
      return {
        ok: false,
        message: (spec.message ?? `${spec.name} must be one of ${spec.values?.join('/')}`).replace(
          '{value}',
          raw,
        ),
      };
    }
    case 'port': {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        return {
          ok: false,
          message: (
            spec.message ?? `${spec.name} must be an integer in [0, 65535]`
          ).replace('{value}', raw),
        };
      }
      return { ok: true, value };
    }
    case 'duration-ms':
    case 'epoch-seconds': {
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) return { ok: true, value: 0 };
      return { ok: true, value: Math.min(value, 2147483647) };
    }
    case 'label': {
      const value = raw.trim();
      return { ok: true, value };
    }
    case 'path':
    case 'secret':
    case 'command':
    default:
      return { ok: true, value: raw };
  }
}

/* -------------------------------------------------------------------------- */
/* The tools                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create the nine self-hosted runner tools.
 *
 * **Every one of them refuses.** There is no runner behind them, so a call
 * ends in a typed refusal that names the capability it needed.
 */
export function createSelfHostedRunnerTools(deps: BuiltinToolDeps): ToolDefinition[] {
  return SELF_HOSTED_RUNNER_TOOL_SPECS.map((spec) => createSelfHostedRunnerTool(spec, deps));
}

/**
 * Create one self-hosted runner tool.
 */
function createSelfHostedRunnerTool(
  spec: SelfHostedRunnerToolSpec,
  deps: BuiltinToolDeps,
): ToolDefinition {
  // The target's own flag: a **whole-tool** allow rule does not apply to the
  // two write tools, so the rules the check runs against drop them.
  const scoped: BuiltinToolDeps =
    spec.ignoresWholeToolAllowRule === true
      ? { ...deps, rules: withoutWholeToolAllowRules(deps.rules, spec.name) }
      : deps;

  const tool: ToolDefinition = {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    mutatesFiles: false,

    async checkPermissions(input, ctx: ToolContext) {
      return checkToolPermissions(ctx, scoped, { safetyCheck: ownCheck(spec, deps) });
    },

    async recheckPermission(input, ctx: ToolContext) {
      return recheckToolPermissions(ctx, scoped, { safetyCheck: ownCheck(spec, deps) });
    },

    async validateInput(input) {
      return validateRunnerInput(spec, input);
    },

    async execute(_input, _ctx) {
      throw capabilityRefusal(spec.name, spec.capability);
    },
  };

  // The target's own concurrency flag. A tool that does not declare it is
  // **not** concurrency safe — the target's own default — so the two write
  // tools leave it off.
  if (spec.concurrencySafe) {
    tool.isConcurrencySafe = () => true;
  }

  return tool;
}

/**
 * The tool's own permission check.
 *
 * The seven read tools have **no** own check in the target, so the standard
 * check is the whole of their permission behaviour; the two write tools have
 * one, and it is reproduced here.
 *
 * The target's own check runs **after** the deny rules and **before** the mode
 * dispatch, so it is installed as the tool's own safety check: a deny rule
 * still blocks, and the tool's own answer is the one that reaches the user.
 *
 * When the tool has no opinion — the seven read tools, and the two write tools
 * in `auto` mode, where the target passes the call to the classifier — the
 * standard safety check runs, exactly as it would without the tool.
 */
function ownCheck(
  spec: SelfHostedRunnerToolSpec,
  deps: BuiltinToolDeps,
): (ctx: ToolContext) => PermissionDecision | undefined {
  return (ctx: ToolContext) => {
    const decision = spec.readOnly ? undefined : writeToolDecision(spec, deps.mode, ctx);
    if (decision !== undefined) return decision;
    // The tool's own check reads the **effective** input, so a hook's rewrite
    // is what the message names.
    return safetyCheckForTool(ctx);
  };
}

/**
 * The decision the target's own check makes for the two write tools.
 *
 * `chunk-c4brmbaw.js:11180` and `:13575` — the target's check answers `ask`
 * with its own message in every mode but `auto`, and in `auto` mode it passes
 * the call to the classifier ("requires classifier review"), so the decision
 * here is `undefined` and the standard check runs.
 */
function writeToolDecision(
  spec: SelfHostedRunnerToolSpec,
  mode: BuiltinToolDeps['mode'],
  ctx: ToolContext,
): PermissionDecision | undefined {
  if (mode === 'auto') return undefined;
  const message = writeToolMessage(spec, ctx.input);
  return {
    behavior: 'ask',
    source: 'unknown',
    reasonType: 'other',
    reason: message,
    message,
  };
}

/**
 * The target's own message for the two write tools.
 *
 * `chunk-c4brmbaw.js:11180` and `:13575`.
 */
function writeToolMessage(spec: SelfHostedRunnerToolSpec, input: unknown): string {
  if (spec.name === 'self_hosted_runner_requeue_session') {
    const sessionId = readField(input, 'session_id');
    const runnerId = readField(input, 'runner_id');
    return `Requeue session ${sessionId} off runner ${runnerId}? This re-launches the session on another runner in the environment.`;
  }
  const secretFile = readField(input, 'secret_file_path');
  const baseDir = readField(input, 'base_dir') ?? './runner-setup/workspace';
  return `Start a detached self-hosted runner with the environment secret file ${secretFile} (base dir ${baseDir})? The runner will execute that environment's queued sessions on this machine and will keep running after this session ends.`;
}

/**
 * Read an own string field of an input object.
 *
 * The field name comes from the tool's schema and the value from the model, so
 * the lookup is an **own-property** check. A field the call does not carry is
 * `undefined`, so the target's own `?? <default>` applies.
 */
function readField(input: unknown, field: string): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, field)) return undefined;
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* The validation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The subset of JSON Schema the target's own runner schemas use.
 */
interface RunnerSchemaNode {
  type?: string;
  properties?: Readonly<Record<string, RunnerSchemaNode>>;
  required?: readonly string[];
  exclusiveMinimum?: number;
}

/**
 * Validate a call against the target's own schema.
 *
 * The target's runner schemas are **strict** objects, so an argument the
 * schema does not name is refused.
 */
export function validateRunnerInput(
  spec: SelfHostedRunnerToolSpec,
  input: unknown,
): { ok: true } | { ok: false; message: string; errorCode: number } {
  const schema = spec.inputSchema as RunnerSchemaNode;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      message: `The '${spec.name}' call must be an object.`,
      errorCode: TOOL_ERROR_CODES.invalidInput,
    };
  }
  const record = input as Record<string, unknown>;

  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(record, required)) {
      return {
        ok: false,
        message: `The '${required}' argument is required.`,
        errorCode: TOOL_ERROR_CODES.missingField,
      };
    }
  }

  for (const [key, value] of Object.entries(record)) {
    const child = schema.properties?.[key];
    if (child === undefined) {
      return {
        ok: false,
        message: `The '${key}' argument is not accepted by this tool.`,
        errorCode: TOOL_ERROR_CODES.invalidInput,
      };
    }
    const failure = checkField(key, child, value);
    if (failure !== undefined) return failure;
  }

  return { ok: true };
}

/**
 * Check one field against the target's own schema.
 */
function checkField(
  name: string,
  schema: RunnerSchemaNode,
  value: unknown,
): { ok: false; message: string; errorCode: number } | undefined {
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      return {
        ok: false,
        message: `The '${name}' argument must be a string.`,
        errorCode: TOOL_ERROR_CODES.invalidInput,
      };
    }
    if (value.length === 0) {
      return {
        ok: false,
        message: `The '${name}' argument must not be empty.`,
        errorCode: TOOL_ERROR_CODES.invalidInput,
      };
    }
    return undefined;
  }
  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return {
        ok: false,
        message: `The '${name}' argument must be an integer.`,
        errorCode: TOOL_ERROR_CODES.invalidInput,
      };
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      return {
        ok: false,
        message: `The '${name}' argument must be greater than ${schema.exclusiveMinimum}.`,
        errorCode: TOOL_ERROR_CODES.invalidInput,
      };
    }
    return undefined;
  }
  return undefined;
}
