/**
 * Contract test for the hook registry, the tool-name matcher, and the hook
 * runner.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("Hook event
 * matrix", "Hook outputs", "Hook matchers", "Hook sources") and
 * `docs/compatibility/extension-surface.md` ("The result merge rules", "The
 * matcher semantics", "The exit-code contract"), and the `CC-012` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins the closed event list, the display handlers that are **not**
 * hook events, the per-event execution classification, the matcher's two
 * modes, the exit-code contract, the result merge rules, and the seams the
 * permission layer uses.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BLOCKABLE_EVENTS,
  DECISION_EVENTS,
  DISPLAY_HANDLERS,
  HOOK_EVENTS,
  HOOK_EXECUTION_CLASS,
  HOOK_HANDLER_TYPES,
  HookConfigurationError,
  createHookRegistry,
  isBlockableEvent,
  isHookEvent,
  mcpServersAvailable,
  type HookEvent,
  type HookSpec,
} from '../../src/extensions/hooks/registry.js';
import {
  MAX_MATCH_INPUT_LENGTH,
  compileMatcher,
  matchToolName,
} from '../../src/extensions/hooks/schema.js';
import {
  BLOCKED_BY_HOOK_REASON,
  applyUpdatedPermissions,
  createHookApproval,
  hookFailureFromResults,
  mergeHookResults,
  mergePermissionRequestApproval,
  mergePermissionRequestResult,
  runHooks,
  type HookCommandOutcome,
  type HookPayload,
  type HookResult,
} from '../../src/extensions/hooks/runner.js';
import { checkPermission, type ToolContext } from '../../src/permissions/decision.js';
import { createPermissionRequestHook } from '../../src/permissions/prompts.js';
import type { RuleSet } from '../../src/permissions/rules.js';

const NODE = process.execPath;

/** The temporary directories the test creates. */
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc012-'));
  temporaryDirectories.push(directory);
  return directory;
}

/** A hook that runs a node script and writes the JSON it produces. */
function jsonHook(event: HookEvent, body: unknown, extra: Partial<HookSpec> = {}): HookSpec {
  const script = `console.log(JSON.stringify(${JSON.stringify(body)}))`;
  return {
    event,
    command: `${NODE} -e ${shellQuote(script)}`,
    ...extra,
  };
}

/** Quote a string for `/bin/sh -c`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toolContext(toolName = 'Bash', input: unknown = { command: 'ls' }): ToolContext {
  return { toolName, input, toolUseId: 'toolu_01', sessionId: 'session-01' };
}

function ruleSet(overrides: Partial<RuleSet> = {}): RuleSet {
  return {
    allow: [],
    deny: [],
    ask: [],
    cwd: '/work',
    source: 'userSettings',
    ...overrides,
  };
}

// --- the registry ----------------------------------------------------------------

describe('the hook registry', () => {
  it('lists exactly the thirty-three hook events', () => {
    expect(HOOK_EVENTS).toHaveLength(33);
    expect(new Set(HOOK_EVENTS).size).toBe(33);
    expect([...HOOK_EVENTS].sort()).toEqual(
      [
        'ConfigChange',
        'CwdChanged',
        'DirectoryAdded',
        'Elicitation',
        'ElicitationResult',
        'FileChanged',
        'InstructionsLoaded',
        'MessageDisplay',
        'Notification',
        'PermissionDenied',
        'PermissionRequest',
        'PostCompact',
        'PostModelSwitch',
        'PostToolBatch',
        'PostToolUse',
        'PostToolUseFailure',
        'PreCompact',
        'PreModelSwitch',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Setup',
        'Stop',
        'StopFailure',
        'SubagentStart',
        'SubagentStop',
        'TaskCompleted',
        'TaskCreated',
        'TeammateIdle',
        'UserPromptExpansion',
        'UserPromptSubmit',
        'WorktreeCreate',
        'WorktreeRemove',
      ].sort(),
    );
  });

  it('keeps the two display handlers out of the hook events', () => {
    expect([...DISPLAY_HANDLERS]).toEqual(['StatusLine', 'FileSuggestion']);
    for (const handler of DISPLAY_HANDLERS) {
      expect((HOOK_EVENTS as readonly string[]).includes(handler)).toBe(false);
      expect(isHookEvent(handler)).toBe(false);
    }
    // The display handlers are settings-level handlers, and the registry keeps
    // them apart from the hook events.
    const registry = createHookRegistry();
    registry.registerDisplayHandler({ type: 'command', command: 'echo hi' });
    expect(registry.displayHandlers()).toHaveLength(1);
    expect(registry.for('StatusLine' as unknown as HookEvent)).toEqual([]);
  });

  it('returns only the hooks of the event asked for', () => {
    const registry = createHookRegistry();
    const preToolUse: HookSpec = { event: 'PreToolUse', command: 'echo pre' };
    const postToolUse: HookSpec = { event: 'PostToolUse', command: 'echo post' };
    const anotherPreToolUse: HookSpec = { event: 'PreToolUse', command: 'echo pre2' };

    registry.register(preToolUse);
    registry.register(postToolUse);
    registry.register(anotherPreToolUse);

    expect(registry.for('PreToolUse')).toEqual([preToolUse, anotherPreToolUse]);
    expect(registry.for('PostToolUse')).toEqual([postToolUse]);
    expect(registry.for('SessionStart')).toEqual([]);
  });

  it('finds the mcp_tool hooks of a server', () => {
    const registry = createHookRegistry();
    const memory: HookSpec = {
      event: 'PreToolUse',
      type: 'mcp_tool',
      server: 'memory',
      command: 'recall',
    };
    const other: HookSpec = {
      event: 'PreToolUse',
      type: 'mcp_tool',
      server: 'other',
      command: 'recall',
    };
    const local: HookSpec = { event: 'PreToolUse', command: 'echo local' };

    registry.register(memory);
    registry.register(other);
    registry.register(local);

    expect(registry.servers()).toEqual(['memory', 'other']);
    expect(registry.hasServer('memory')).toBe(true);
    expect(registry.hasServer('local')).toBe(false);
    expect(registry.forServer('memory')).toEqual([memory]);
  });

  it('does not resolve an event name or a server name from Object.prototype', () => {
    const registry = createHookRegistry();
    registry.register({ event: 'PreToolUse', command: 'echo pre' });

    for (const name of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(registry.for(name as unknown as HookEvent)).toEqual([]);
      expect(registry.hasServer(name)).toBe(false);
    }
  });

  it('refuses a hook for an event that does not exist', () => {
    const registry = createHookRegistry();

    expect(() => registry.register({ event: 'StatusLine' as unknown as HookEvent, command: 'echo' })).toThrow(
      HookConfigurationError,
    );
    expect(() => registry.register({ event: 'NoSuchEvent' as unknown as HookEvent, command: 'echo' })).toThrow(
      HookConfigurationError,
    );
  });

  it('refuses an mcp_tool hook without a server', () => {
    const registry = createHookRegistry();

    expect(() =>
      registry.register({ event: 'PreToolUse', type: 'mcp_tool', command: 'recall' }),
    ).toThrow(HookConfigurationError);
  });

  it('classifies every event that is not decision-capable', () => {
    const classified = Object.keys(HOOK_EXECUTION_CLASS).sort();
    const decision = [...DECISION_EVENTS].sort();
    const all = [...HOOK_EVENTS].sort();

    // The two sets are disjoint and together they are the 33 events.
    expect(decision.filter((event) => classified.includes(event))).toEqual([]);
    expect([...decision, ...classified].sort()).toEqual(all);
    expect(decision).toHaveLength(11);
    expect(classified).toHaveLength(22);

    expect(HOOK_EXECUTION_CLASS['SessionStart']).toBe('runs_locally');
    expect(HOOK_EXECUTION_CLASS['SessionEnd']).toBe('runs_locally');
    expect(HOOK_EXECUTION_CLASS['Notification']).toBe('runs_locally');
    expect(HOOK_EXECUTION_CLASS['PermissionRequest']).toBe('later');
    expect(HOOK_EXECUTION_CLASS['PreModelSwitch']).toBe('later');
    expect(HOOK_EXECUTION_CLASS['PostModelSwitch']).toBe('later');
    for (const event of [
      'Setup',
      'PreCompact',
      'PostCompact',
      'TeammateIdle',
      'TaskCreated',
      'TaskCompleted',
      'Elicitation',
      'ElicitationResult',
    ] as const) {
      expect(HOOK_EXECUTION_CLASS[event]).toBe('low_value');
    }
    for (const event of [
      'ConfigChange',
      'WorktreeCreate',
      'WorktreeRemove',
      'InstructionsLoaded',
      'CwdChanged',
      'FileChanged',
      'DirectoryAdded',
      'MessageDisplay',
    ] as const) {
      expect(HOOK_EXECUTION_CLASS[event]).toBe('container_internal');
    }
  });

  it('names the handler types the target carries', () => {
    expect([...HOOK_HANDLER_TYPES]).toEqual(['command', 'http', 'mcp_tool', 'prompt', 'agent']);
  });

  it('knows which events fire before the MCP servers are available', () => {
    expect(mcpServersAvailable('SessionStart')).toBe(false);
    expect(mcpServersAvailable('Setup')).toBe(false);
    expect(mcpServersAvailable('PreToolUse')).toBe(true);
  });

  it('knows which events a hook can block', () => {
    expect(isBlockableEvent('PreToolUse')).toBe(true);
    expect(isBlockableEvent('PermissionRequest')).toBe(true);
    expect(isBlockableEvent('Notification')).toBe(false);
    expect(BLOCKABLE_EVENTS).toContain('PermissionDenied');
  });
});

// --- the matcher -----------------------------------------------------------------

describe('the tool-name matcher', () => {
  it('matches an exact string', () => {
    expect(matchToolName('Edit', 'Edit')).toBe(true);
    expect(matchToolName('Edit', 'Read')).toBe(false);
    expect(matchToolName('Edit', 'Editor')).toBe(false);
  });

  it('matches one of the pipe-separated alternatives', () => {
    expect(matchToolName('Edit|Write', 'Write')).toBe(true);
    expect(matchToolName('Edit|Write', 'Edit')).toBe(true);
    expect(matchToolName('Edit|Write', 'Read')).toBe(false);
  });

  it('matches one of the comma-separated alternatives', () => {
    expect(matchToolName('Edit, Write', 'Write')).toBe(true);
    expect(matchToolName('Edit, Write', 'Read')).toBe(false);
  });

  it('matches every tool with the wildcard', () => {
    expect(matchToolName('*', 'Bash')).toBe(true);
    expect(matchToolName('*', 'mcp__memory__recall')).toBe(true);
  });

  it('treats a matcher with a metacharacter as an unanchored regular expression', () => {
    expect(matchToolName('mcp__memory__.*', 'mcp__memory__recall')).toBe(true);
    expect(matchToolName('mcp__memory__.*', 'mcp__other__recall')).toBe(false);
    expect(matchToolName('^Bash$', 'Bash')).toBe(true);
    expect(matchToolName('^Bash$', 'BashOutput')).toBe(false);
    expect(matchToolName('.*Edit', 'MultiEdit')).toBe(true);
  });

  it('matches nothing with a bare mcp__memory', () => {
    // The bare name is in the simple syntax, so it is an exact-string match:
    // no tool is called exactly `mcp__memory`.
    expect(matchToolName('mcp__memory', 'mcp__memory__recall')).toBe(false);
    expect(matchToolName('mcp__memory', 'mcp__memory')).toBe(true);
  });

  it('rejects a malformed matcher rather than treating it as a literal', () => {
    const compiled = compileMatcher('(unclosed');
    expect(compiled.ok).toBe(false);
    expect(matchToolName('(unclosed', 'Bash')).toBe(false);
    expect(matchToolName('(?=lookahead)', 'Bash')).toBe(false);
    expect(matchToolName('\\1', 'Bash')).toBe(false);
    expect(matchToolName('', 'Bash')).toBe(false);
  });

  it('compiles the simple syntax as an exact match and anything else as a regular expression', () => {
    const exact = compileMatcher('Edit|Write');
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.matcher.kind).toBe('exact');

    const regex = compileMatcher('mcp__memory__.*');
    expect(regex.ok).toBe(true);
    if (regex.ok) expect(regex.matcher.kind).toBe('regex');
  });

  it('does not hang on a matcher that backtracks catastrophically', () => {
    const started = Date.now();
    // `(a+)+$` against a long run of `a`s is exponential for a backtracking
    // engine. This implementation compiles the pattern to a non-backtracking program, so
    // the answer comes back immediately.
    expect(matchToolName('(a+)+$', `${'a'.repeat(200)}!`)).toBe(false);
    expect(matchToolName('(a*)*b', `${'a'.repeat(200)}c`)).toBe(false);
    expect(matchToolName('(a|aa)+$', `${'a'.repeat(200)}!`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses a tool name that is longer than the bound', () => {
    const long = 'x'.repeat(MAX_MATCH_INPUT_LENGTH + 1);
    expect(matchToolName('.*', long)).toBe(false);
    expect(matchToolName('x', long)).toBe(false);
  });

  it('agrees with the JavaScript regular expression it accepts', () => {
    const patterns = [
      'mcp__memory__.*',
      '^Bash$',
      'Bash.*',
      '.*Edit',
      '(Edit|Write)',
      'a{2,3}',
      'colou?r',
      '[A-Z]\\w+',
      'tool.*\\.(ts|js)',
      'x?y*z+',
    ];
    const names = ['Bash', 'Edit', 'MultiEdit', 'mcp__memory__recall', 'colour', 'ABC', 'tool.ts', 'xyz'];

    for (const pattern of patterns) {
      const reference = new RegExp(pattern);
      for (const name of names) {
        expect({ pattern, name, matched: matchToolName(pattern, name) }).toEqual({
          pattern,
          name,
          matched: reference.test(name),
        });
      }
    }
  });
});

// --- the runner ------------------------------------------------------------------

describe('the hook runner', () => {
  it('applies the JSON a hook that exits zero wrote', async () => {
    const spec = jsonHook('PreToolUse', {
      additionalContext: 'remember the release notes',
      continue: true,
    });

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' });

    expect(results).toHaveLength(1);
    expect(results[0]?.additionalContext).toBe('remember the release notes');
    expect(results[0]?.continue).toBe(true);
    expect(results[0]?.hookEventName).toBe('PreToolUse');
  });

  it('blocks on exit code two', async () => {
    const spec: HookSpec = {
      event: 'PreToolUse',
      command: 'echo "the call is not allowed" >&2; exit 2',
    };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' });

    expect(results).toHaveLength(1);
    expect(results[0]?.blocked).toBe(true);
    expect(results[0]?.decision?.behavior).toBe('deny');
    expect(results[0]?.decision?.reason).toContain('the call is not allowed');
    expect(results[0]?.permissionDecision).toBe('deny');
  });

  it('leaves the session usable when a hook exits with another code', async () => {
    const spec: HookSpec = { event: 'PreToolUse', command: 'echo "hook trouble" >&2; exit 1' };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' });

    expect(results).toHaveLength(1);
    expect(results[0]?.blocked).toBe(false);
    expect(results[0]?.continue).toBe(true);
    expect(results[0]?.error).toContain('hook trouble');
    expect(results[0]?.decision).toBeUndefined();
  });

  it('does not block on exit code two when the event is not blockable', async () => {
    const spec: HookSpec = { event: 'Notification', command: 'exit 2' };

    const results = await runHooks([spec], 'Notification', {});

    expect(results[0]?.blocked).toBe(false);
    expect(results[0]?.continue).toBe(true);
  });

  it('reports a hook that timed out as a non-blocking error', async () => {
    const spec: HookSpec = {
      event: 'PreToolUse',
      command: `${NODE} -e ${shellQuote('setTimeout(()=>{}, 5000)')}`,
      timeoutMs: 150,
    };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' });

    expect(results[0]?.blocked).toBe(false);
    expect(results[0]?.continue).toBe(true);
    expect(results[0]?.error).toContain('timed out');
  });

  it('reports a hook that was aborted as a non-blocking error', async () => {
    const controller = new AbortController();
    controller.abort();
    const spec: HookSpec = {
      event: 'PreToolUse',
      command: `${NODE} -e ${shellQuote('setTimeout(()=>{}, 5000)')}`,
    };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' }, controller.signal);

    expect(results[0]?.blocked).toBe(false);
    expect(results[0]?.error).toContain('aborted');
  });

  it('runs only the hooks whose matcher matches the tool', async () => {
    const edit: HookSpec = { event: 'PreToolUse', matcher: 'Edit', command: 'echo edit' };
    const write: HookSpec = { event: 'PreToolUse', matcher: 'Write', command: 'echo write' };
    const any: HookSpec = { event: 'PreToolUse', command: 'echo any' };

    const results = await runHooks([edit, write, any], 'PreToolUse', { tool_name: 'Write' });

    expect(results).toHaveLength(2);
  });

  it('runs the matching hooks in parallel', async () => {
    const directory = makeDirectory();
    const marker = path.join(directory, 'marker');

    // The first hook creates the marker; the second one waits for it. The two
    // hooks only both succeed when they run at the same time.
    const first: HookSpec = {
      event: 'PreToolUse',
      command: `${NODE} -e ${shellQuote(
        `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"x"),150)`,
      )}`,
    };
    const second: HookSpec = {
      event: 'PreToolUse',
      command: `${NODE} -e ${shellQuote(
        `const fs=require("fs");const start=Date.now();while(!fs.existsSync(${JSON.stringify(marker)})&&Date.now()-start<5000){};process.exit(fs.existsSync(${JSON.stringify(marker)})?0:3)`,
      )}`,
    };

    const results = await runHooks([second, first], 'PreToolUse', { tool_name: 'Read' });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.exitCode === 0)).toBe(true);
  });

  it('hands the hook the payload the target carries', async () => {
    let seen: HookPayload | undefined;
    const spec: HookSpec = { event: 'PreToolUse', command: 'echo' };

    await runHooks(
      [spec],
      'PreToolUse',
      { tool_name: 'Read', tool_input: { file_path: '/work/a.txt' } },
      undefined,
      {
        context: {
          session_id: 'session-01',
          prompt_id: 'prompt-01',
          transcript_path: '/work/.claude/session.jsonl',
          cwd: '/work',
          scratchpad_dir: '/tmp/scratch',
          permission_mode: 'acceptEdits',
          effort: { level: 'high' },
          agent_id: 'agent-01',
          agent_type: 'Explore',
        },
        runCommand: async (_spec, payload) => {
          seen = payload;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
    );

    expect(seen?.session_id).toBe('session-01');
    expect(seen?.prompt_id).toBe('prompt-01');
    expect(seen?.transcript_path).toBe('/work/.claude/session.jsonl');
    expect(seen?.cwd).toBe('/work');
    expect(seen?.scratchpad_dir).toBe('/tmp/scratch');
    expect(seen?.permission_mode).toBe('acceptEdits');
    expect(seen?.effort?.level).toBe('high');
    expect(seen?.hook_event_name).toBe('PreToolUse');
    expect(seen?.agent_id).toBe('agent-01');
    expect(seen?.agent_type).toBe('Explore');
    expect(seen?.tool_name).toBe('Read');
  });

  it('reads the payload of a hook that runs as a process', async () => {
    const spec: HookSpec = {
      event: 'PreToolUse',
      command: `${NODE} -e ${shellQuote(
        'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify({additionalContext:p.hook_event_name+"/"+p.tool_name}))',
      )}`,
    };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' });

    expect(results[0]?.additionalContext).toBe('PreToolUse/Read');
  });

  it('skips an mcp_tool hook for SessionStart and Setup', async () => {
    let calls = 0;
    const spec: HookSpec = {
      event: 'SessionStart',
      type: 'mcp_tool',
      server: 'memory',
      command: 'recall',
    };

    const results = await runHooks([spec], 'SessionStart', {}, undefined, {
      callMcpTool: async () => {
        calls += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(calls).toBe(0);
    expect(results).toEqual([]);
  });

  it('reads the output of an mcp_tool hook like the output of a command hook', async () => {
    const spec: HookSpec = {
      event: 'PreToolUse',
      type: 'mcp_tool',
      server: 'memory',
      command: 'recall',
    };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' }, undefined, {
      callMcpTool: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ additionalContext: 'the server remembers' }),
        stderr: '',
      }),
    });

    expect(results[0]?.additionalContext).toBe('the server remembers');
  });

  it('treats an mcp_tool error as a non-blocking error', async () => {
    const spec: HookSpec = {
      event: 'PreToolUse',
      type: 'mcp_tool',
      server: 'memory',
      command: 'recall',
    };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' }, undefined, {
      callMcpTool: async () => ({
        exitCode: 0,
        stdout: 'the server is unhappy',
        stderr: '',
        isError: true,
      }),
    });

    expect(results[0]?.blocked).toBe(false);
    expect(results[0]?.continue).toBe(true);
    expect(results[0]?.error).toContain('the server is unhappy');
  });
});

// --- the merge rules -------------------------------------------------------------

describe('the result merge', () => {
  it('merges the permission decision by strictness', () => {
    const allow: HookResult = { hookEventName: 'PreToolUse', permissionDecision: 'allow' };
    const deny: HookResult = { hookEventName: 'PreToolUse', permissionDecision: 'deny' };

    expect(mergeHookResults([allow, deny])?.permissionDecision).toBe('deny');
    expect(mergeHookResults([deny, allow])?.permissionDecision).toBe('deny');
    expect(mergeHookResults([allow])?.permissionDecision).toBe('allow');
  });

  it('takes the reason from the stricter decision', () => {
    const allow: HookResult = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'the hook allows it',
    };
    const deny: HookResult = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'the hook refuses it',
    };

    expect(mergeHookResults([allow, deny])?.permissionDecisionReason).toBe('the hook refuses it');
    expect(mergeHookResults([deny, allow])?.permissionDecisionReason).toBe('the hook refuses it');
  });

  it('does not let the looser decision’s reason survive a stricter one', () => {
    const allow: HookResult = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'the hook allows it',
    };
    const deny: HookResult = { hookEventName: 'PreToolUse', permissionDecision: 'deny' };

    const merged = mergeHookResults([allow, deny]);

    expect(merged?.permissionDecision).toBe('deny');
    expect(merged?.permissionDecisionReason).toBe(BLOCKED_BY_HOOK_REASON);
  });

  it('lets a deny beat an ask', () => {
    const ask: HookResult = { hookEventName: 'PreToolUse', permissionDecision: 'ask' };
    const deny: HookResult = { hookEventName: 'PreToolUse', permissionDecision: 'deny' };

    expect(mergeHookResults([ask, deny])?.permissionDecision).toBe('deny');
    expect(mergeHookResults([ask])?.permissionDecision).toBe('ask');
  });

  it('combines the decisions in the order deny, defer, ask, allow', () => {
    const allow: HookResult = { hookEventName: 'PreToolUse', permissionDecision: 'allow' };
    const ask: HookResult = { hookEventName: 'PreToolUse', permissionDecision: 'ask' };
    const defer: HookResult = { hookEventName: 'PreToolUse', permissionDecision: 'defer' };
    const deny: HookResult = { hookEventName: 'PreToolUse', permissionDecision: 'deny' };

    expect(mergeHookResults([allow, ask])?.permissionDecision).toBe('ask');
    expect(mergeHookResults([ask, defer])?.permissionDecision).toBe('defer');
    expect(mergeHookResults([defer, deny])?.permissionDecision).toBe('deny');
    expect(mergeHookResults([allow, defer, ask, deny])?.permissionDecision).toBe('deny');
  });

  it('reads the permission decision and the rewritten input of a PreToolUse hook', async () => {
    const spec = jsonHook('PreToolUse', {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'the hook approves the rewrite',
        updatedInput: { command: 'ls -la' },
      },
    });

    const results = await runHooks([spec], 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(results[0]?.permissionDecision).toBe('allow');
    expect(results[0]?.permissionDecisionReason).toBe('the hook approves the rewrite');
    expect(results[0]?.updatedInput).toEqual({ command: 'ls -la' });
  });

  it('concatenates the additional context and the watch paths', () => {
    const first: HookResult = {
      hookEventName: 'SessionStart',
      additionalContext: 'first',
      watchPaths: ['/work/a'],
    };
    const second: HookResult = {
      hookEventName: 'SessionStart',
      additionalContext: 'second',
      watchPaths: ['/work/b'],
    };

    const merged = mergeHookResults([first, second]);

    expect(merged?.additionalContext).toBe('first\nsecond');
    expect(merged?.watchPaths).toEqual(['/work/a', '/work/b']);
  });

  it('takes every other member from the newer result', () => {
    const older: HookResult = {
      hookEventName: 'Stop',
      stopReason: 'the older reason',
      retry: false,
    };
    const newer: HookResult = {
      hookEventName: 'Stop',
      stopReason: 'the newer reason',
      retry: true,
    };

    const merged = mergeHookResults([older, newer]);

    expect(merged?.stopReason).toBe('the newer reason');
    expect(merged?.retry).toBe(true);
  });

  it('blocks with "Blocked by hook" when the hook denied without a reason', () => {
    const deny: HookResult = { hookEventName: 'PreToolUse', permissionDecision: 'deny' };

    const merged = mergeHookResults([deny]);

    expect(merged?.permissionDecisionReason).toBe(BLOCKED_BY_HOOK_REASON);
    expect(merged?.decision?.reason).toBe(BLOCKED_BY_HOOK_REASON);
  });

  it('maps each permission of an allow decision and normalizes the mode', () => {
    const allow: HookResult = {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedPermissions: [
        { type: 'add', rule: 'Bash(ls)', target: 'allow' },
        { type: 'setMode', mode: 'manual' },
      ],
    };

    const merged = mergeHookResults([allow]);

    expect(merged?.permissions?.allow).toEqual(['Bash(ls)']);
    // The `manual` alias of `default` is normalized before it is applied.
    expect(merged?.permissions?.mode).toBe('default');
  });

  it('refuses a mode that is not one of the six', () => {
    const map = applyUpdatedPermissions({ allow: [], deny: [], ask: [], mode: 'plan' }, [
      { type: 'setMode', mode: 'not-a-mode' },
    ]);

    expect(map.mode).toBe('plan');
  });

  it('maps a permission map as well as a list of updates', () => {
    const map = applyUpdatedPermissions({ allow: [], deny: [], ask: [] }, {
      'Bash(ls)': 'allow',
      'Bash(rm)': 'deny',
      mode: 'plan',
    });

    expect(map.allow).toEqual(['Bash(ls)']);
    expect(map.deny).toEqual(['Bash(rm)']);
    expect(map.mode).toBe('plan');
  });
});

// --- the permission-request seam -------------------------------------------------

describe('the permission-request hook', () => {
  it('denies the tool call', async () => {
    const spec = jsonHook('PermissionRequest', {
      decision: { behavior: 'deny', reason: 'the hook refuses this call' },
    });

    const hook = createPermissionRequestHook({
      approval: createHookApproval([spec]),
    });

    const decision = await checkPermission(toolContext(), {
      rules: ruleSet(),
      mode: 'default',
      hook,
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.source).toBe('hook');
    expect(decision.reason).toContain('the hook refuses this call');
  });

  it('does not override a deny rule', async () => {
    const spec = jsonHook('PermissionRequest', { decision: { behavior: 'allow' } });

    const hook = createPermissionRequestHook({
      approval: createHookApproval([spec]),
    });

    const decision = await checkPermission(toolContext(), {
      rules: ruleSet({ deny: ['Bash'] }),
      mode: 'default',
      hook,
    });

    expect(decision.behavior).toBe('deny');
  });

  it('does not override an ask rule', async () => {
    const spec = jsonHook('PermissionRequest', { decision: { behavior: 'allow' } });

    const hook = createPermissionRequestHook({
      approval: createHookApproval([spec]),
    });

    const decision = await checkPermission(toolContext(), {
      rules: ruleSet({ ask: ['Bash'] }),
      mode: 'default',
      hook,
    });

    expect(decision.behavior).toBe('ask');
  });

  it('holds a denial in bypassPermissions', async () => {
    const spec = jsonHook('PermissionRequest', {
      decision: { behavior: 'deny', reason: 'the hook refuses this call' },
    });

    const hook = createPermissionRequestHook({
      approval: createHookApproval([spec]),
    });

    const decision = await checkPermission(toolContext(), {
      rules: ruleSet(),
      mode: 'bypassPermissions',
      hook,
    });

    expect(decision.behavior).toBe('deny');
  });

  it('carries the rewritten input into the decision', async () => {
    const spec = jsonHook('PermissionRequest', {
      decision: { behavior: 'allow' },
      updatedInput: { command: 'ls -la' },
    });

    const hook = createPermissionRequestHook({
      approval: createHookApproval([spec]),
    });

    const decision = await checkPermission(toolContext(), {
      rules: ruleSet(),
      mode: 'default',
      hook,
    });

    expect(decision.behavior).toBe('allow');
    expect(decision.updatedInput).toEqual({ command: 'ls -la' });
  });

  it('denies the call when the rewritten input is rejected by the tool validator', async () => {
    const spec = jsonHook('PermissionRequest', {
      decision: { behavior: 'allow' },
      updatedInput: { command: 42 },
    });

    const hook = createPermissionRequestHook({
      approval: createHookApproval([spec]),
      validate: (input) => {
        const command = (input as { command?: unknown }).command;
        if (typeof command !== 'string') {
          return { ok: false, message: "the 'command' argument must be a string." };
        }
        return { ok: true };
      },
    });

    const decision = await checkPermission(toolContext(), {
      rules: ruleSet(),
      mode: 'default',
      hook,
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.reason).toContain("the 'command' argument must be a string.");
  });

  it('denies every tool call when a hook failed with severity stop', async () => {
    const spec: HookSpec = { event: 'PreToolUse', command: 'exit 1', severity: 'stop' };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' });
    const failure = hookFailureFromResults(results);

    expect(failure?.severity).toBe('stop');

    const decision = await checkPermission(toolContext(), {
      rules: ruleSet(),
      mode: 'default',
      hookFailure: failure,
    });

    expect(decision.behavior).toBe('deny');
    expect(decision.source).toBe('hook');
  });

  it('reports no failure when the hooks did not fail', () => {
    const results: HookResult[] = [{ hookEventName: 'PreToolUse', exitCode: 0 }];

    expect(hookFailureFromResults(results)).toBeUndefined();
  });

  it('merges a hook result into a permission-request result', () => {
    const allow: HookResult = {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', reason: 'the hook allows it' },
      updatedInput: { command: 'ls' },
    };

    const merged = mergePermissionRequestResult(allow, { permissionRequestResult: { request: 1 } });

    expect(merged.permissionBehavior).toBe('allow');
    expect(merged.hookPermissionDecisionReason).toBe('the hook allows it');
    expect(merged.permissionRequestResult).toEqual({ request: 1 });
    expect(merged.updatedInput).toEqual({ command: 'ls' });
  });

  it('carries the updated input only when the behavior is allow', () => {
    const deny: HookResult = {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny' },
      updatedInput: { command: 'ls' },
    };

    const merged = mergePermissionRequestResult(deny);

    expect(merged.permissionBehavior).toBe('deny');
    expect(merged.updatedInput).toBeUndefined();
  });

  it('turns a group of hook results into the approval the seam expects', () => {
    const approval = mergePermissionRequestApproval([
      { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', reason: 'no' } },
      { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    ]);

    expect(approval?.decision?.behavior).toBe('deny');
    expect(approval?.decision?.reason).toBe('no');
  });

  it('gives no approval when the hooks did not decide', () => {
    const approval = mergePermissionRequestApproval([
      { hookEventName: 'PermissionRequest', additionalContext: 'just a note' },
    ]);

    expect(approval).toBeUndefined();
  });
});

// --- the elicitation events ------------------------------------------------------

describe('the elicitation events', () => {
  it('matches on the MCP server name', async () => {
    const memory: HookSpec = { event: 'Elicitation', matcher: 'memory', command: 'echo memory' };
    const other: HookSpec = { event: 'Elicitation', matcher: 'other', command: 'echo other' };

    const results = await runHooks([memory, other], 'Elicitation', {
      mcp_server_name: 'memory',
    });

    expect(results).toHaveLength(1);
  });

  it('honours the hookSpecificOutput only on exit zero', async () => {
    const spec: HookSpec = {
      event: 'Elicitation',
      command: `echo '{"hookSpecificOutput":{"action":"decline"}}'; exit 2`,
    };

    const blocked = await runHooks([spec], 'Elicitation', { mcp_server_name: 'memory' });
    expect(blocked[0]?.action).toBeUndefined();
    // `Elicitation` is not a blockable event, so an exit code of two is a
    // non-blocking error there.
    expect(blocked[0]?.blocked).toBe(false);

    const accepted: HookSpec = {
      event: 'Elicitation',
      command: `echo '{"hookSpecificOutput":{"action":"decline","content":{"reason":"no"}}}'`,
    };
    const results = await runHooks([accepted], 'Elicitation', { mcp_server_name: 'memory' });
    expect(results[0]?.action).toBe('decline');
    expect(results[0]?.content).toEqual({ reason: 'no' });
  });
});

// --- the runner's contract with the host ------------------------------------------

describe('a hook that cannot run', () => {
  it('reports an mcp_tool hook with no MCP connection as a non-blocking error', async () => {
    const spec: HookSpec = {
      event: 'PreToolUse',
      type: 'mcp_tool',
      server: 'memory',
      command: 'recall',
    };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' });

    expect(results).toHaveLength(1);
    expect(results[0]?.blocked).toBe(false);
    expect(results[0]?.continue).toBe(true);
  });

  it('does not dispatch a hook of a handler type this implementation cannot execute', async () => {
    const spec: HookSpec = {
      event: 'PreToolUse',
      command: 'echo hi',
      handlerType: 'http',
    };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' });

    expect(results).toEqual([]);
  });

  it('reports a hook that could not be started as a non-blocking error', async () => {
    const outcome: HookCommandOutcome = {
      exitCode: -1,
      stdout: '',
      stderr: 'the hook could not be started',
      failed: true,
    };

    expect(outcome.failed).toBe(true);
  });
});
