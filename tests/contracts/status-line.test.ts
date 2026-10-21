/**
 * Contract test: the **status line** — the setting, the payload, the runner and the
 * gates.
 *
 * Evidence: `chunk-c9s0jh80.js:283237` (the setting), `chunk-4jsg44k7.js:2367468` (the
 * payload), `:2366659` (the runner), `:2366573` (the two constants), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §3.
 */

import { describe, expect, it } from 'vitest';

import {
  STATUS_LINE_DEBOUNCE_MS,
  STATUS_LINE_MIN_GAP_MS,
  buildStatusLinePayload,
  runStatusLine,
  statusLineGate,
  statusLineRefreshIntervalMs,
  type StatusLineInput,
} from '../../src/ui/statusLine.js';

function inputOf(overrides: Partial<StatusLineInput> = {}): StatusLineInput {
  return {
    session: { id: 'session-1', transcriptPath: '/tmp/session-1.jsonl', title: 'a title' },
    permissionMode: 'default',
    cwd: '/work/project',
    projectDir: '/work/project',
    addedDirs: ['/work/extra'],
    modelId: 'claude-sonnet-4-5',
    modelDisplayName: 'Sonnet 4.5',
    outputStyleName: 'default',
    cost: {
      total_cost_usd: 0.25,
      total_duration_ms: 1000,
      total_api_duration_ms: 500,
      total_lines_added: 3,
      total_lines_removed: 1,
    },
    contextWindow: {
      total_input_tokens: 100,
      total_output_tokens: 20,
      context_window_size: 200000,
      used_percentage: 0.1,
      remaining_percentage: 99.9,
    },
    exceeds200kTokens: false,
    fastMode: false,
    thinkingEnabled: true,
    ...overrides,
  };
}

describe('the status line setting', () => {
  it('turns a refresh interval of N seconds into N seconds of milliseconds', () => {
    expect(
      statusLineRefreshIntervalMs({ type: 'command', command: 'x', refreshInterval: 5 }),
    ).toBe(5000);
  });

  it('answers null when there is no refresh interval', () => {
    expect(statusLineRefreshIntervalMs({ type: 'command', command: 'x' })).toBeNull();
    expect(statusLineRefreshIntervalMs(undefined)).toBeNull();
  });

  it('never refreshes faster than once a second', () => {
    expect(
      statusLineRefreshIntervalMs({ type: 'command', command: 'x', refreshInterval: 0 }),
    ).toBe(1000);
  });

  it('carries the target\'s two constants', () => {
    expect(STATUS_LINE_DEBOUNCE_MS).toBe(300);
    expect(STATUS_LINE_MIN_GAP_MS).toBe(1000);
  });
});

describe('the status line payload', () => {
  it('carries the target\'s session block', () => {
    const payload = buildStatusLinePayload(inputOf());
    expect(payload.session_id).toBe('session-1');
    expect(payload.transcript_path).toBe('/tmp/session-1.jsonl');
    expect(payload.cwd).toBe('/work/project');
    expect(payload.permission_mode).toBe('default');
  });

  it('carries the session\'s title as session_name', () => {
    expect(buildStatusLinePayload(inputOf()).session_name).toBe('a title');
  });

  it('leaves session_name out when the session has no title', () => {
    const input = inputOf({ session: { id: 'session-1' } });
    expect('session_name' in buildStatusLinePayload(input)).toBe(false);
  });

  it('carries the model\'s id and display name', () => {
    const payload = buildStatusLinePayload(inputOf());
    expect(payload.model).toEqual({ id: 'claude-sonnet-4-5', display_name: 'Sonnet 4.5' });
  });

  it('carries the workspace block', () => {
    const payload = buildStatusLinePayload(inputOf());
    expect(payload.workspace.current_dir).toBe('/work/project');
    expect(payload.workspace.project_dir).toBe('/work/project');
    expect(payload.workspace.added_dirs).toEqual(['/work/extra']);
  });

  it('carries the output style\'s name', () => {
    expect(buildStatusLinePayload(inputOf()).output_style).toEqual({ name: 'default' });
  });

  it('carries the cost block', () => {
    expect(buildStatusLinePayload(inputOf()).cost).toEqual({
      total_cost_usd: 0.25,
      total_duration_ms: 1000,
      total_api_duration_ms: 500,
      total_lines_added: 3,
      total_lines_removed: 1,
    });
  });

  it('carries the context-window block', () => {
    const payload = buildStatusLinePayload(inputOf());
    expect(payload.context_window.total_input_tokens).toBe(100);
    expect(payload.context_window.total_output_tokens).toBe(20);
    expect(payload.context_window.context_window_size).toBe(200000);
    expect(payload.context_window.used_percentage).toBe(0.1);
  });

  it('carries the thinking flag and the fast-mode flag', () => {
    const payload = buildStatusLinePayload(inputOf());
    expect(payload.thinking).toEqual({ enabled: true });
    expect(payload.fast_mode).toBe(false);
  });

  it('leaves the optional blocks out when there is nothing to say', () => {
    const payload = buildStatusLinePayload(inputOf());
    expect('prompt_cache' in payload).toBe(false);
    expect('rate_limits' in payload).toBe(false);
    expect('vim' in payload).toBe(false);
    expect('agent' in payload).toBe(false);
    expect('remote' in payload).toBe(false);
    expect('pr' in payload).toBe(false);
    expect('worktree' in payload).toBe(false);
  });

  it('carries the optional blocks when there is something to say', () => {
    const payload = buildStatusLinePayload(
      inputOf({
        promptCache: {
          warm: true,
          caching_observed: true,
          requests: 2,
          misses: 0,
          expected_rebuilds: 0,
        },
        rateLimits: { five_hour: { used_percentage: 10, resets_at: 1 } },
        vimMode: 'INSERT',
        agentName: 'reviewer',
        remoteSessionId: 'remote-1',
        pr: { number: 7, url: 'https://example.invalid/pull/7' },
        worktree: { name: 'wt', path: '/work/wt' },
      }),
    );
    expect(payload.prompt_cache?.warm).toBe(true);
    expect(payload.rate_limits?.five_hour?.used_percentage).toBe(10);
    expect(payload.vim).toEqual({ mode: 'INSERT' });
    expect(payload.agent).toEqual({ name: 'reviewer' });
    expect(payload.remote).toEqual({ session_id: 'remote-1' });
    expect(payload.pr?.number).toBe(7);
    expect(payload.worktree?.name).toBe('wt');
  });

  it('writes the members in the target\'s own order', () => {
    const payload = buildStatusLinePayload(inputOf({ effortLevel: 'high' })) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload)).toEqual([
      'session_id',
      'transcript_path',
      'cwd',
      'permission_mode',
      'effort',
      'session_name',
      'model',
      'workspace',
      'version',
      'output_style',
      'cost',
      'context_window',
      'exceeds_200k_tokens',
      'fast_mode',
      'thinking',
    ]);
  });

  it('lets the model\'s effort level replace the session\'s', () => {
    const payload = buildStatusLinePayload(
      inputOf({ effortLevel: 'session-level', modelEffortLevel: 'model-level' }),
    );
    expect(payload.effort).toEqual({ level: 'model-level' });
  });
});

describe('the status line runner', () => {
  it('writes the payload to the command\'s standard input and takes its output', async () => {
    const payload = buildStatusLinePayload(inputOf());
    const result = await runStatusLine('cat', payload, { cwd: '/tmp' });
    expect(result.ok).toBe(true);
    const written = JSON.parse(result.text) as { session_id: string };
    expect(written.session_id).toBe('session-1');
  });

  it('runs the command through the shell', async () => {
    const payload = buildStatusLinePayload(inputOf());
    const result = await runStatusLine('printf shell-ran', payload, { cwd: '/tmp' });
    expect(result.text).toBe('shell-ran');
  });

  it('swallows a failure of the command', async () => {
    const payload = buildStatusLinePayload(inputOf());
    const result = await runStatusLine('exit 3', payload, { cwd: '/tmp' });
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
  });

  it('swallows a command that does not exist', async () => {
    const payload = buildStatusLinePayload(inputOf());
    const result = await runStatusLine('this-command-does-not-exist-12345', payload, { cwd: '/tmp' });
    expect(result.ok).toBe(false);
  });
});

describe('the status line gates', () => {
  it('runs the command when nothing objects', () => {
    expect(statusLineGate(undefined, true)).toEqual({ allowed: true });
  });

  it('does not run the command when all hooks are disabled', () => {
    const gate = statusLineGate({ disableAllHooks: true }, true);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('Status line is configured but disableAllHooks is true');
  });

  it('skips the command when the workspace trust is not accepted', () => {
    const gate = statusLineGate(undefined, false);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe('Status line command skipped: workspace trust not accepted');
  });
});
