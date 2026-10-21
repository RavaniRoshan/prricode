/**
 * Contract test for the **self-hosted runner** surface.
 *
 * Evidence: the target's own source, read out of the pinned build — the nine
 * tool definitions (`chunk-c4brmbaw.js`), the names and the descriptions
 * (`chunk-e8yvb8wq.js`), the transport (`chunk-dqnsxcf9.js`), the
 * registration gate (`chunk-705mhzj8.js` and `chunk-d8mq0b21.js`), the
 * runner's configuration and its environment variables
 * (`chunk-56g9kk6e.js`), the runner's API client (`chunk-s45rta2n.js`), the
 * CLI subcommand tree (`cli.mjs`) and the setup wizard (`chunk-jn8w77mq.js`).
 * The full reading, with every file and byte offset, is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-self-hosted-runner.md`.
 *
 * **The target has a self-hosted runner surface and this implementation does
 * not.** The target ships nine runner tools, a runner process, a registration
 * protocol and forty-one environment variables. This implementation has no
 * runner, no registration, no environment secret and no account, so the nine
 * tools exist — with the target's names, descriptions, schemas and permission
 * rules — and every one of them **refuses** and names the capability it needs.
 */

import { describe, expect, it } from 'vitest';

import {
  TOOL_ERROR_CODES,
  ToolExecutionError,
  createToolRegistry,
  isToolConcurrencySafe,
} from '../../src/tools/registry.js';
import { registerBuiltinTools } from '../../src/tools/builtins/index.js';
import type { BuiltinToolDeps } from '../../src/tools/builtins/shared.js';
import type { RuleSet } from '../../src/permissions/rules.js';
import type { ToolContext } from '../../src/permissions/decision.js';
import {
  SELF_HOSTED_API_CAPABILITY,
  SELF_HOSTED_RUNNER_CLI_SUBCOMMANDS,
  SELF_HOSTED_RUNNER_DEFAULT_HEALTH_PORT,
  SELF_HOSTED_RUNNER_DEFAULT_TAIL_BYTES,
  SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLES,
  SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES,
  SELF_HOSTED_RUNNER_IGNORED_METRICS,
  SELF_HOSTED_LOCAL_CAPABILITY,
  SELF_HOSTED_RUNNER_METRIC_PREFIX,
  SELF_HOSTED_RUNNER_PROTOCOL,
  SELF_HOSTED_RUNNER_REFUSED_ENVIRONMENT_VARIABLES,
  SELF_HOSTED_RUNNER_REQUEST_HEADERS,
  SELF_HOSTED_SPAWN_CAPABILITY,
  SELF_HOSTED_RUNNER_TOOL_NAMES,
  SELF_HOSTED_RUNNER_TOOL_SPECS,
  SELF_HOSTED_RUNNER_WIZARD_TOOL_NAMES,
  SELF_HOSTED_RUNNER_WRITE_TOOL_NAMES,
  createSelfHostedRunnerTools,
  readSelfHostedRunnerEnvironment,
} from '../../src/tools/builtins/selfHostedRunner.js';

const WORKDIR = '/work';

function toolContext(
  toolName: string,
  input: unknown,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    toolName,
    input,
    toolUseId: 'toolu_01',
    sessionId: 'session-01',
    ...overrides,
  };
}

function ruleSet(overrides: Partial<RuleSet> = {}): RuleSet {
  return {
    allow: [],
    deny: [],
    ask: [],
    cwd: WORKDIR,
    source: 'userSettings',
    ...overrides,
  };
}

function builtinDeps(overrides: Partial<BuiltinToolDeps> = {}): BuiltinToolDeps {
  return {
    rules: ruleSet(),
    mode: 'default',
    cwd: WORKDIR,
    ...overrides,
  };
}

/**
 * The nine tools, in the target's own order.
 *
 * `chunk-c4brmbaw.js:16557` — the target's export array.
 */
describe('the self-hosted runner surface', () => {
  it("carries the target's nine runner tools, in the target's order", () => {
    expect([...SELF_HOSTED_RUNNER_TOOL_NAMES]).toEqual([
      'self_hosted_runner_get_pool',
      'self_hosted_runner_list_runners',
      'self_hosted_runner_list_sessions',
      'self_hosted_runner_list_secrets',
      'self_hosted_runner_spawn_local',
      'self_hosted_runner_read_health',
      'self_hosted_runner_read_metrics',
      'self_hosted_runner_tail_log',
      'self_hosted_runner_requeue_session',
    ]);

    const registry = createToolRegistry();
    registerBuiltinTools(registry, builtinDeps());
    for (const name of SELF_HOSTED_RUNNER_TOOL_NAMES) {
      expect(registry.get(name)?.name, name).toBe(name);
    }
  });

  it("carries the target's own descriptions", () => {
    const specs = new Map(SELF_HOSTED_RUNNER_TOOL_SPECS.map((spec) => [spec.name, spec]));

    expect(specs.get('self_hosted_runner_get_pool')?.description).toContain(
      "Read a self-hosted environment's aggregate state (alive_runner_count, available_capacity_total, capacity_in_use, pending_session_count, unplaceable_session_count, backing_off_count, circuit_broken_count)",
    );
    expect(specs.get('self_hosted_runner_list_runners')?.description).toContain(
      'lease_expires_at, locked_account_id/email, and assigned_session_count',
    );
    expect(specs.get('self_hosted_runner_list_sessions')?.description).toContain(
      'status, failure_log[], excluded_runner_ids, spawn_attempt, spawn_last_error',
    );
    expect(specs.get('self_hosted_runner_list_secrets')?.description).toContain(
      'Secret values are never returned — only metadata.',
    );
    expect(specs.get('self_hosted_runner_spawn_local')?.description).toContain(
      'Spawn a self-hosted runner as a detached background process on THIS machine',
    );
    expect(specs.get('self_hosted_runner_read_health')?.description).toContain(
      'GET http://127.0.0.1:{health_port}/healthz on the local runner (2s timeout)',
    );
    expect(specs.get('self_hosted_runner_read_metrics')?.description).toContain(
      'GET http://127.0.0.1:{health_port}/metrics on the local runner',
    );
    expect(specs.get('self_hosted_runner_tail_log')?.description).toContain(
      'with the shared secret redaction',
    );
    expect(specs.get('self_hosted_runner_requeue_session')?.description).toContain(
      "Appends the observed runner to the session's excluded_runner_ids",
    );

    // The target's own operator tail, on the five account-side tools.
    for (const name of [
      'self_hosted_runner_get_pool',
      'self_hosted_runner_list_runners',
      'self_hosted_runner_list_sessions',
      'self_hosted_runner_list_secrets',
      'self_hosted_runner_requeue_session',
    ]) {
      expect(specs.get(name)?.description, name).toContain(
        'The result includes an `equivalent.ui` string with the Admin-UI path.',
      );
      expect(specs.get(name)?.description, name).toContain(
        'Auth: handled internally via the operator',
      );
    }

    // The four local tools do not carry that tail.
    for (const name of [
      'self_hosted_runner_spawn_local',
      'self_hosted_runner_read_health',
      'self_hosted_runner_read_metrics',
      'self_hosted_runner_tail_log',
    ]) {
      expect(specs.get(name)?.description, name).not.toContain('equivalent.ui');
    }
  });

  it("carries the target's own input schemas", () => {
    const specs = new Map(SELF_HOSTED_RUNNER_TOOL_SPECS.map((spec) => [spec.name, spec]));
    const schemaOf = (name: string) =>
      specs.get(name)?.inputSchema as {
        type: string;
        properties: Record<string, { type?: string; description?: string }>;
        required: string[];
        additionalProperties?: boolean;
      };

    // The target's schemas are strict objects: `z.strictObject`.
    expect(schemaOf('self_hosted_runner_get_pool').additionalProperties).toBe(false);

    expect(schemaOf('self_hosted_runner_get_pool').required).toEqual(['pool_id']);
    expect(schemaOf('self_hosted_runner_get_pool').properties.pool_id?.description).toBe(
      'Tagged environment id (ccpool_…).',
    );

    expect(schemaOf('self_hosted_runner_list_sessions').required).toEqual(['pool_id']);
    expect(
      schemaOf('self_hosted_runner_list_sessions').properties.status_filter?.description,
    ).toBe('Optional server-side status filter (e.g. "queued").');

    expect(schemaOf('self_hosted_runner_read_health').required).toEqual([]);
    expect(schemaOf('self_hosted_runner_read_health').properties.health_port?.description).toBe(
      'Default 8080. 0 means disabled.',
    );

    expect(schemaOf('self_hosted_runner_tail_log').required).toEqual(['log_path']);
    expect(schemaOf('self_hosted_runner_tail_log').properties.bytes?.description).toBe(
      'How many trailing bytes to read. Default 65536.',
    );

    expect(schemaOf('self_hosted_runner_requeue_session').required).toEqual([
      'session_id',
      'runner_id',
    ]);
    expect(schemaOf('self_hosted_runner_spawn_local').required).toEqual(['secret_file_path']);
  });

  it("carries the target's result shapes, endpoints and Admin-UI paths", () => {
    const specs = new Map(SELF_HOSTED_RUNNER_TOOL_SPECS.map((spec) => [spec.name, spec]));

    expect(specs.get('self_hosted_runner_get_pool')?.resultFields).toEqual([
      'pool',
      'equivalent',
    ]);
    expect(specs.get('self_hosted_runner_get_pool')?.endpoint).toBe(
      '/v1/code/runners/self-hosted/pools/{pool_id}',
    );
    expect(specs.get('self_hosted_runner_get_pool')?.equivalentUi).toBe(
      'Admin settings → Cloud environments → Self-hosted environments → (environment) — header stat tiles',
    );
    expect(specs.get('self_hosted_runner_list_sessions')?.endpoint).toBe(
      '/v1/code/runners/self-hosted/pools/{pool_id}/sessions',
    );
    expect(specs.get('self_hosted_runner_list_runners')?.endpoint).toBe(
      '/v1/code/runners/self-hosted/runners?pool_id={pool_id}',
    );
    expect(specs.get('self_hosted_runner_list_secrets')?.endpoint).toBe(
      '/v1/code/runners/self-hosted/pools/{pool_id}/secrets',
    );
    expect(specs.get('self_hosted_runner_requeue_session')?.endpoint).toBe(
      '/v1/code/runners/self-hosted/sessions/{session_id}/requeue',
    );
    expect(specs.get('self_hosted_runner_read_health')?.endpoint).toBe(
      'http://127.0.0.1:{health_port}/healthz',
    );
    expect(specs.get('self_hosted_runner_read_metrics')?.endpoint).toBe(
      'http://127.0.0.1:{health_port}/metrics',
    );
    expect(specs.get('self_hosted_runner_spawn_local')?.resultFields).toEqual([
      'pid',
      'pid_file',
      'log_path',
      'health_port',
      'command',
    ]);
  });

  it("carries the target's read-only and concurrency flags", () => {
    const specs = new Map(SELF_HOSTED_RUNNER_TOOL_SPECS.map((spec) => [spec.name, spec]));

    for (const name of [
      'self_hosted_runner_get_pool',
      'self_hosted_runner_list_runners',
      'self_hosted_runner_list_sessions',
      'self_hosted_runner_list_secrets',
      'self_hosted_runner_read_health',
      'self_hosted_runner_read_metrics',
      'self_hosted_runner_tail_log',
    ]) {
      expect(specs.get(name)?.readOnly, name).toBe(true);
      expect(specs.get(name)?.concurrencySafe, name).toBe(true);
    }

    // The two write tools: not read-only, not concurrency safe (the target's
    // own default for a tool that does not declare the flag), and they carry
    // the two flags the target declares.
    for (const name of SELF_HOSTED_RUNNER_WRITE_TOOL_NAMES) {
      expect(specs.get(name)?.readOnly, name).toBe(false);
      expect(specs.get(name)?.concurrencySafe, name).toBe(false);
      expect(specs.get(name)?.enablesCodeExecution, name).toBe(true);
      expect(specs.get(name)?.ignoresWholeToolAllowRule, name).toBe(true);
      expect(specs.get(name)?.suppressesAlwaysAllowRule, name).toBe(true);
    }

    // The target's own result-size caps.
    expect(specs.get('self_hosted_runner_tail_log')?.maxResultSizeChars).toBe(200000);
    expect(specs.get('self_hosted_runner_get_pool')?.maxResultSizeChars).toBe(100000);
  });

  it('is concurrency safe only for the seven read tools', () => {
    const tools = createSelfHostedRunnerTools(builtinDeps());
    for (const tool of tools) {
      const expected = !SELF_HOSTED_RUNNER_WRITE_TOOL_NAMES.includes(tool.name);
      expect(isToolConcurrencySafe(tool, {}), tool.name).toBe(expected);
    }
  });

  it("carries the target's environment-variable surface — thirty-seven names", () => {
    // The record's list held thirty-one and missed the ten the runner reads
    // through a variable. The target reads thirty-seven.
    expect(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).toHaveLength(37);
    expect(new Set(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).size).toBe(37);
    expect(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).toContain(
      'SELF_HOSTED_RUNNER_BASE_DIR',
    );
    expect(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).toContain(
      'SELF_HOSTED_RUNNER_BG_RESULT_GRACE_MS',
    );
    expect(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).toContain(
      'SELF_HOSTED_RUNNER_MAX_LIFETIME_GRACE_MS',
    );
    expect(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).toContain(
      'SELF_HOSTED_RUNNER_POST_TURN_SETTLE_MS',
    );
    expect(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).toContain(
      'SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_COMMAND',
    );
    expect(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).toContain(
      'SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_FILE',
    );
    expect(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).toContain(
      'SELF_HOSTED_RUNNER_SIGKILL_GRACE_MS',
    );
    expect(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).toContain(
      'SELF_HOSTED_RUNNER_DRAIN_WAIT_BG_TASKS_MS',
    );
    expect(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).toContain(
      'SELF_HOSTED_RUNNER_POOL_SECRET',
    );
    expect(SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLE_NAMES).toContain(
      'SELF_HOSTED_RUNNER_TRUST_WORKSPACE',
    );
  });

  it("carries the target's environment-variable defaults", () => {
    const defaults = new Map(
      SELF_HOSTED_RUNNER_ENVIRONMENT_VARIABLES.map((spec) => [spec.name, spec.default]),
    );

    expect(defaults.get('SELF_HOSTED_RUNNER_BASE_DIR')).toBe('/workspace');
    expect(defaults.get('SELF_HOSTED_RUNNER_HEALTH_PORT')).toBe(8080);
    expect(defaults.get('SELF_HOSTED_RUNNER_CONFINE_REPO_SETTINGS')).toBe('warn');
    expect(defaults.get('SELF_HOSTED_RUNNER_SERVER_AUTO_MODE_LISTS')).toBe('no-allow');
    expect(defaults.get('SELF_HOSTED_RUNNER_HOST_CONFIG_SNAPSHOT')).toBe('disk');
    expect(defaults.get('SELF_HOSTED_RUNNER_TRUST_WORKSPACE')).toBe(true);
    expect(defaults.get('SELF_HOSTED_RUNNER_REMOVE_SESSION_STATE')).toBe(false);
    expect(defaults.get('SELF_HOSTED_RUNNER_SESSION_STOP_GRACE_MS')).toBe(5000);
    expect(defaults.get('SELF_HOSTED_RUNNER_POST_SESSION_HOOK_TIMEOUT_MS')).toBe(60000);
    expect(defaults.get('SELF_HOSTED_RUNNER_STARTUP_TIMEOUT_MS')).toBe(900000);
    expect(defaults.get('SELF_HOSTED_RUNNER_MAX_LIFETIME_GRACE_MS')).toBe(900000);
    expect(defaults.get('SELF_HOSTED_RUNNER_BG_RESULT_GRACE_MS')).toBe(30000);
    expect(defaults.get('SELF_HOSTED_RUNNER_POST_TURN_SETTLE_MS')).toBe(7000);
    expect(defaults.get('SELF_HOSTED_RUNNER_IDLE_SHUTDOWN_MS')).toBe(0);
    expect(defaults.get('SELF_HOSTED_RUNNER_SESSION_IDLE_MS')).toBe(0);
    expect(defaults.get('SELF_HOSTED_RUNNER_MAX_LIFETIME_MS')).toBe(0);
    expect(defaults.get('SELF_HOSTED_RUNNER_DEFER_SHUTDOWN_MAX_MS')).toBe(0);
    expect(defaults.get('SELF_HOSTED_RUNNER_DRAIN_GRACE_MS')).toBe(0);
    expect(defaults.get('SELF_HOSTED_RUNNER_RETIRE_AT')).toBe(0);
  });

  it('validates the environment variables the way the target does', () => {
    const empty = readSelfHostedRunnerEnvironment({});
    expect(empty.invalid).toEqual([]);
    expect(empty.values.SELF_HOSTED_RUNNER_HEALTH_PORT).toBe(8080);
    expect(empty.values.SELF_HOSTED_RUNNER_TRUST_WORKSPACE).toBe(true);

    const set = readSelfHostedRunnerEnvironment({
      SELF_HOSTED_RUNNER_HEALTH_PORT: '9999',
      SELF_HOSTED_RUNNER_TRUST_WORKSPACE: '0',
      SELF_HOSTED_RUNNER_CONFINE_REPO_SETTINGS: 'enforce',
      SELF_HOSTED_RUNNER_SERVER_AUTO_MODE_LISTS: 'all',
      SELF_HOSTED_RUNNER_HOST_CONFIG_SNAPSHOT: 'memory',
      SELF_HOSTED_RUNNER_CLIENT_LABEL: '  runner-1  ',
    });
    expect(set.invalid).toEqual([]);
    expect(set.values.SELF_HOSTED_RUNNER_HEALTH_PORT).toBe(9999);
    expect(set.values.SELF_HOSTED_RUNNER_TRUST_WORKSPACE).toBe(false);
    expect(set.values.SELF_HOSTED_RUNNER_CONFINE_REPO_SETTINGS).toBe('enforce');
    expect(set.values.SELF_HOSTED_RUNNER_SERVER_AUTO_MODE_LISTS).toBe('all');
    expect(set.values.SELF_HOSTED_RUNNER_HOST_CONFIG_SNAPSHOT).toBe('memory');
    expect(set.values.SELF_HOSTED_RUNNER_CLIENT_LABEL).toBe('runner-1');

    // The target's own validation messages.
    const badPort = readSelfHostedRunnerEnvironment({ SELF_HOSTED_RUNNER_HEALTH_PORT: '70000' });
    expect(badPort.invalid[0]?.message).toBe(
      'SELF_HOSTED_RUNNER_HEALTH_PORT must be an integer in [0, 65535] (0 disables), got: 70000',
    );

    const badBoolean = readSelfHostedRunnerEnvironment({
      SELF_HOSTED_RUNNER_TRUST_WORKSPACE: 'maybe',
    });
    expect(badBoolean.invalid[0]?.message).toBe(
      'SELF_HOSTED_RUNNER_TRUST_WORKSPACE must be one of 1/true/yes/on or 0/false/no/off (got: maybe)',
    );

    const badEnum = readSelfHostedRunnerEnvironment({
      SELF_HOSTED_RUNNER_SERVER_AUTO_MODE_LISTS: 'some',
    });
    expect(badEnum.invalid[0]?.message).toBe(
      'SELF_HOSTED_RUNNER_SERVER_AUTO_MODE_LISTS must be one of all/no-allow/none (got: some)',
    );
  });

  it('names the four environment variables the target refuses or ignores', () => {
    expect(SELF_HOSTED_RUNNER_REFUSED_ENVIRONMENT_VARIABLES.map((entry) => entry.name)).toEqual([
      'SELF_HOSTED_RUNNER_SIGKILL_TIMEOUT_MS',
      'SELF_HOSTED_RUNNER_RELEASE_IDLE_SESSION_MIN',
      'SELF_HOSTED_RUNNER_SESSION_IDLE_MIN',
      'SELF_HOSTED_RUNNER_SESSION_IDLE_SEC',
    ]);
    expect(SELF_HOSTED_RUNNER_REFUSED_ENVIRONMENT_VARIABLES[0]?.behaviour).toBe('fatal');
    expect(SELF_HOSTED_RUNNER_REFUSED_ENVIRONMENT_VARIABLES[0]?.message).toContain(
      'was renamed to SELF_HOSTED_RUNNER_SESSION_STOP_GRACE_MS',
    );

    const refused = readSelfHostedRunnerEnvironment({
      SELF_HOSTED_RUNNER_SIGKILL_TIMEOUT_MS: '5000',
      SELF_HOSTED_RUNNER_SESSION_IDLE_MIN: '5',
    });
    expect(refused.refused.map((entry) => entry.name)).toEqual([
      'SELF_HOSTED_RUNNER_SIGKILL_TIMEOUT_MS',
      'SELF_HOSTED_RUNNER_SESSION_IDLE_MIN',
    ]);
  });

  it("carries the target's runner protocol and the CLI subcommand tree", () => {
    expect(SELF_HOSTED_RUNNER_PROTOCOL.map((call) => call.name)).toEqual([
      'RegisterRunner',
      'PollSpawnHints',
      'NackSpawnHint',
      'PollWork',
      'IssueSessionToken',
      'ReportSessionFailure',
      'ReleaseSession',
      'DeregisterRunner',
      'RefreshToken',
      'WorkHintsStream',
    ]);
    expect(SELF_HOSTED_RUNNER_PROTOCOL[0]?.path).toBe(
      '/v1/code/runners/self-hosted/runners/register',
    );
    expect(SELF_HOSTED_RUNNER_PROTOCOL[0]?.timeoutMs).toBe(15000);
    expect(SELF_HOSTED_RUNNER_PROTOCOL[3]?.path).toBe(
      '/v1/code/runners/self-hosted/runners/{runnerId}/poll',
    );

    expect(SELF_HOSTED_RUNNER_REQUEST_HEADERS['anthropic-version']).toBe('2023-06-01');
    expect(SELF_HOSTED_RUNNER_REQUEST_HEADERS['x-self-hosted-runner-version']).toBe('2.1.303');

    expect([...SELF_HOSTED_RUNNER_CLI_SUBCOMMANDS]).toEqual([
      'orchestrator',
      'setup',
      'doctor',
      'code-sign',
      'decode-token',
    ]);

    // The target's own metric prefix and the gauges it drops.
    expect(SELF_HOSTED_RUNNER_METRIC_PREFIX).toBe('claude_code_self_hosted_runner_');
    expect([...SELF_HOSTED_RUNNER_IGNORED_METRICS]).toEqual([
      'session_idle_seconds',
      'poll_errors_total',
    ]);

    // The target's own defaults.
    expect(SELF_HOSTED_RUNNER_DEFAULT_HEALTH_PORT).toBe(8080);
    expect(SELF_HOSTED_RUNNER_DEFAULT_TAIL_BYTES).toBe(65536);

    // The wizard's own tool list: seven of the nine, and not the other two.
    expect(SELF_HOSTED_RUNNER_WIZARD_TOOL_NAMES).toHaveLength(15);
    expect(SELF_HOSTED_RUNNER_WIZARD_TOOL_NAMES).not.toContain(
      'self_hosted_runner_list_sessions',
    );
    expect(SELF_HOSTED_RUNNER_WIZARD_TOOL_NAMES).not.toContain(
      'self_hosted_runner_requeue_session',
    );
  });

  it('refuses every runner tool and names the capability it needs', async () => {
    const tools = createSelfHostedRunnerTools(builtinDeps());
    expect(tools).toHaveLength(SELF_HOSTED_RUNNER_TOOL_NAMES.length);

    for (const tool of tools) {
      await expect(tool.execute({}, toolContext(tool.name, {})), tool.name).rejects.toMatchObject({
        errorCode: TOOL_ERROR_CODES.capabilityUnavailable,
      });
    }
  });

  it('names the capability each runner tool needs in the refusal', async () => {
    const tools = createSelfHostedRunnerTools(builtinDeps());
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    await expect(
      byName.get('self_hosted_runner_get_pool')?.execute(
        { pool_id: 'ccpool_1' },
        toolContext('self_hosted_runner_get_pool', {}),
      ),
    ).rejects.toThrow(new RegExp(SELF_HOSTED_API_CAPABILITY));

    await expect(
      byName.get('self_hosted_runner_read_health')?.execute(
        {},
        toolContext('self_hosted_runner_read_health', {}),
      ),
    ).rejects.toThrow(new RegExp(SELF_HOSTED_LOCAL_CAPABILITY));

    await expect(
      byName.get('self_hosted_runner_spawn_local')?.execute(
        { secret_file_path: '/tmp/secret' },
        toolContext('self_hosted_runner_spawn_local', {}),
      ),
    ).rejects.toThrow(new RegExp(SELF_HOSTED_SPAWN_CAPABILITY));
  });

  it('does not let a runner tool pretend to run a runner', async () => {
    for (const tool of createSelfHostedRunnerTools(builtinDeps())) {
      const outcome = await tool.execute({}, toolContext(tool.name, {})).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      expect(outcome, tool.name).toBeInstanceOf(ToolExecutionError);
    }
  });

  it('asks for the two write tools, with the target own message', async () => {
    const tools = createSelfHostedRunnerTools(builtinDeps());
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const requeue = byName.get('self_hosted_runner_requeue_session');
    const requeueDecision = await requeue?.checkPermissions(
      { session_id: 'ccsess_1', runner_id: 'ccrunner_1' },
      toolContext('self_hosted_runner_requeue_session', {
        session_id: 'ccsess_1',
        runner_id: 'ccrunner_1',
      }),
    );
    expect(requeueDecision?.behavior).toBe('ask');
    expect(requeueDecision?.message).toBe(
      'Requeue session ccsess_1 off runner ccrunner_1? This re-launches the session on another runner in the environment.',
    );

    const spawn = byName.get('self_hosted_runner_spawn_local');
    const spawnDecision = await spawn?.checkPermissions(
      { secret_file_path: '/tmp/secret' },
      toolContext('self_hosted_runner_spawn_local', { secret_file_path: '/tmp/secret' }),
    );
    expect(spawnDecision?.behavior).toBe('ask');
    expect(spawnDecision?.message).toBe(
      'Start a detached self-hosted runner with the environment secret file /tmp/secret (base dir ./runner-setup/workspace)? The runner will execute that environment\'s queued sessions on this machine and will keep running after this session ends.',
    );
  });

  it('ignores a whole-tool allow rule for the two write tools', async () => {
    const deps = builtinDeps({
      rules: ruleSet({ allow: ['self_hosted_runner_spawn_local'] }),
    });
    const tools = createSelfHostedRunnerTools(deps);
    const spawn = tools.find((tool) => tool.name === 'self_hosted_runner_spawn_local');

    const decision = await spawn?.checkPermissions(
      { secret_file_path: '/tmp/secret' },
      toolContext('self_hosted_runner_spawn_local', { secret_file_path: '/tmp/secret' }),
    );

    expect(decision?.behavior).toBe('ask');
  });

  it('lets a deny rule block the two write tools', async () => {
    const deps = builtinDeps({
      rules: ruleSet({ deny: ['self_hosted_runner_requeue_session'] }),
    });
    const tools = createSelfHostedRunnerTools(deps);
    const requeue = tools.find((tool) => tool.name === 'self_hosted_runner_requeue_session');

    const decision = await requeue?.checkPermissions(
      { session_id: 'ccsess_1', runner_id: 'ccrunner_1' },
      toolContext('self_hosted_runner_requeue_session', {
        session_id: 'ccsess_1',
        runner_id: 'ccrunner_1',
      }),
    );

    expect(decision?.behavior).toBe('deny');
    expect(decision?.reasonType).toBe('rule');
  });

  it('rejects a runner call whose input does not match the target own schema', async () => {
    const tools = createSelfHostedRunnerTools(builtinDeps());
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    // A missing required field.
    const missing = await byName
      .get('self_hosted_runner_get_pool')
      ?.validateInput({}, toolContext('self_hosted_runner_get_pool', {}));
    expect(missing?.ok).toBe(false);

    // An argument the target's strict schema does not name.
    const unknown = await byName
      .get('self_hosted_runner_get_pool')
      ?.validateInput(
        { pool_id: 'ccpool_1', extra: true },
        toolContext('self_hosted_runner_get_pool', {}),
      );
    expect(unknown?.ok).toBe(false);

    // The target's own bounds: `bytes` is a positive integer.
    const badBytes = await byName
      .get('self_hosted_runner_tail_log')
      ?.validateInput(
        { log_path: '/tmp/runner.log', bytes: 0 },
        toolContext('self_hosted_runner_tail_log', {}),
      );
    expect(badBytes?.ok).toBe(false);

    // A well-formed call validates.
    const good = await byName
      .get('self_hosted_runner_requeue_session')
      ?.validateInput(
        { session_id: 'ccsess_1', runner_id: 'ccrunner_1' },
        toolContext('self_hosted_runner_requeue_session', {}),
      );
    expect(good?.ok).toBe(true);
  });

  it('names no target product name in any runner description', () => {
    for (const spec of SELF_HOSTED_RUNNER_TOOL_SPECS) {
      expect(spec.description, spec.name).not.toMatch(
        new RegExp(`(?<![A-Za-z0-9])${['Cla', 'ude'].join('')}(?![A-Za-z0-9])`),
      );
      // The lowercase program name, used as a program, is the target's.
      expect(spec.description, spec.name).not.toMatch(
        new RegExp(`(?<![A-Za-z0-9_./-])${['cla', 'ude'].join('')}(?=\\s+-{1,2}[A-Za-z])`),
      );
    }
  });
});
