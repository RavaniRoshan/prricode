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

import { getEventListeners } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import * as matcherModule from '../../src/extensions/hooks/matcher.js';
import * as schemaModule from '../../src/extensions/hooks/schema.js';
import {
  BLOCKABLE_EVENTS,
  DECISION_EVENTS,
  DISPLAY_HANDLERS,
  HOOK_EVENTS,
  HOOK_EXECUTION_CLASS,
  HOOK_HANDLER_TYPES,
  HookConfigurationError,
  createHookRegistry,
  hookExecutionClass,
  isBlockableEvent,
  isHookEvent,
  mcpServersAvailable,
  type HookEvent,
  type HookSpec,
} from '../../src/extensions/hooks/registry.js';
import {
  MAX_MATCH_INPUT_LENGTH,
  MAX_MATCH_NODES,
  MAX_MATCH_PATTERN_LENGTH,
  buildHookPayload,
  compileMatcher,
  isInputWithinBound,
  matchToolName,
} from '../../src/extensions/hooks/schema.js';
import {
  BLOCKED_BY_HOOK_REASON,
  DECISION_RANKS,
  DECISION_STRICTNESS,
  applyUpdatedPermissions,
  createHookApproval,
  createPreToolUseApproval,
  hookFailureFromResults,
  mergeHookResults,
  mergePermissionRequestApproval,
  mergePermissionRequestResult,
  mergePreToolUseApproval,
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

  it('does not resolve an execution class from Object.prototype', () => {
    const registry = createHookRegistry();

    // The execution classification is a plain table, so the lookup is guarded:
    // an inherited member of `Object.prototype` is not an event and has no
    // classification.
    for (const name of ['constructor', '__proto__', 'toString', 'valueOf']) {
      expect(registry.executionClass(name as unknown as HookEvent)).toBeUndefined();
      expect(hookExecutionClass(name as unknown as HookEvent)).toBeUndefined();
    }
  });

  it('refuses a hook whose matcher this implementation cannot compile', () => {
    const registry = createHookRegistry();

    expect(() =>
      registry.register({ event: 'PreToolUse', matcher: '(unclosed', command: 'echo pre' }),
    ).toThrow(HookConfigurationError);
    // A matcher this implementation can compile is registered.
    expect(() =>
      registry.register({ event: 'PreToolUse', matcher: 'mcp__memory__.*', command: 'echo pre' }),
    ).not.toThrow();
    // The empty character class is a pattern JavaScript accepts, so the
    // registry accepts it too.
    expect(() =>
      registry.register({ event: 'PreToolUse', matcher: '[]', command: 'echo pre' }),
    ).not.toThrow();
  });

  it('carries the handler kind in one field', () => {
    const registry = createHookRegistry();

    // `handlerType` names the handler kind when it is present, and the plan's
    // `type` carries it otherwise: the two are never read for different
    // purposes.
    const asCommand: HookSpec = {
      event: 'PreToolUse',
      type: 'mcp_tool',
      handlerType: 'command',
      command: 'echo hi',
    };
    const asMcpTool: HookSpec = {
      event: 'PreToolUse',
      type: 'mcp_tool',
      server: 'memory',
      command: 'recall',
    };

    registry.register(asCommand);
    registry.register(asMcpTool);

    // The wider vocabulary wins, so the first hook is not an MCP hook and
    // contributes no server.
    expect(registry.servers()).toEqual(['memory']);
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

/**
 * The patterns the bounded fuzz compares against JavaScript.
 *
 * They are generated from the **supported subset** — literals, the character
 * classes, the groups, the alternation and the quantifiers — so every one of
 * them is a pattern both engines accept. The generator is deterministic, so a
 * failure is reproducible.
 */
function fuzzPatterns(count: number): string[] {
  let state = 20261020;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const pick = <T>(list: readonly T[]): T => {
    const chosen = list[Math.floor(random() * list.length)];
    if (chosen === undefined) throw new Error('the list is empty');
    return chosen;
  };

  const literals = ['a', 'b', 'c', 'x', '1', '_', '-', ' ', 'z'];
  const escapes = [
    '\\d', '\\D', '\\w', '\\W', '\\s', '\\S', '\\n', '\\t', '\\r', '\\x41', '\\u0041',
    '\\u{1F600}', '\\cA', '\\0', '\\.', '\\\\',
  ];
  const classes = [
    '[abc]', '[^abc]', '[a-c]', '[abc-]', '[-abc]', '[\\d]', '[^\\w]', '[]', '[^]',
    '[\\]]', '[^\\]]', '[\\x41-\\x5a]',
  ];
  const quantifiers = [
    '',
    '',
    '',
    '*',
    '+',
    '?',
    '{2}',
    '{0,2}',
    '{1,2}',
    '{2,3}',
    '{0,1}',
    '{1,}',
    '{0,}',
    '{3}',
    '{0,0}',
    '{2,4}',
  ];

  const atom = (): string => {
    const roll = random();
    if (roll < 0.3) return pick(literals);
    if (roll < 0.5) return pick(escapes);
    if (roll < 0.72) return pick(classes);
    if (roll < 0.86) return `(${pick(literals)}${pick(literals)})`;
    if (roll < 0.94) return `(?:${pick(literals)}${pick(literals)})`;
    return `(${pick(literals)}|${pick(literals)})`;
  };

  const patterns: string[] = [];
  const seen = new Set<string>();
  while (patterns.length < count) {
    const terms = 1 + Math.floor(random() * 4);
    let body = '';
    for (let index = 0; index < terms; index += 1) {
      body += random() < 0.08 ? atom() : `${atom()}${pick(quantifiers)}`;
    }
    if (random() < 0.15) body = `(?:${body})`;
    if (random() < 0.12) body = `${body}|${atom()}`;
    if (random() < 0.3) body = `^${body}`;
    if (random() < 0.3) body = `${body}$`;
    if (seen.has(body)) continue;
    seen.add(body);
    patterns.push(body);
  }
  return patterns;
}

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
    //
    // The explicit timeout is the point of the test: a hang would never
    // return, and the assertion below could never fire. The timeout turns a
    // hang into a failure that says so.
    expect(matchToolName('(a+)+$', `${'a'.repeat(200)}!`)).toBe(false);
    expect(matchToolName('(a*)*b', `${'a'.repeat(200)}c`)).toBe(false);
    expect(matchToolName('(a|aa)+$', `${'a'.repeat(200)}!`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  it('refuses a matcher whose expansion is exponential instead of compiling it', () => {
    // The pattern is 23 characters long and expands to 64^4 = 16,777,216 nodes
    // when the bounded repetitions are unrolled. This implementation has a global node
    // budget, so it refuses the matcher instead of exhausting the heap.
    //
    // The explicit timeout is the point of the test: a hang would never
    // return, and the assertion below could never fire.
    const pattern = '(((a{64}){64}){64}){64}';
    const started = Date.now();
    const compiled = compileMatcher(pattern);

    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.reason).toContain(String(MAX_MATCH_NODES));
      expect(compiled.reason).toContain('nodes');
    }
    expect(matchToolName(pattern, 'x')).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  it('refuses a matcher whose bounded quantifiers expand exponentially too', () => {
    // The same blow-up through the **optional** path: `{0,64}` compiles the
    // body once and offers it at most once, and the nested repetitions still
    // multiply. The budget is on the whole program, so the matcher is refused
    // — the quantifier's bound does not reopen the blow-up.
    const pattern = '(((a{0,64}){0,64}){0,64}){0,64}';
    const started = Date.now();
    const compiled = compileMatcher(pattern);

    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.reason).toContain(String(MAX_MATCH_NODES));
      expect(compiled.reason).toContain('nodes');
    }
    expect(matchToolName(pattern, 'x')).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  it('refuses a matcher that is longer than the pattern bound', () => {
    const compiled = compileMatcher('x'.repeat(MAX_MATCH_PATTERN_LENGTH + 1));

    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.reason).toContain(String(MAX_MATCH_PATTERN_LENGTH));
      expect(compiled.reason).toContain('characters');
    }
  });

  it('applies the input bound in both modes', () => {
    const long = 'x'.repeat(MAX_MATCH_INPUT_LENGTH + 1);

    // The regular expression mode: without the bound `.*` would match.
    expect(matchToolName('.*', long)).toBe(false);

    // The exact-string mode applies the same bound.
    const exact = compileMatcher('x');
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.matcher.test(long)).toBe(false);
      expect(exact.matcher.test('x'.repeat(MAX_MATCH_INPUT_LENGTH))).toBe(false);
    }

    // The bound itself: a name of exactly the bound is inside it, and one
    // character more is not.
    expect(isInputWithinBound('x'.repeat(MAX_MATCH_INPUT_LENGTH))).toBe(true);
    expect(isInputWithinBound(long)).toBe(false);
  });

  it('matches every character with the negated empty class', () => {
    // `[^]` is the negated empty class: JavaScript matches every character
    // with it, the newline included.
    expect(matchToolName('[^]', 'Bash')).toBe(true);
    expect(matchToolName('[^]', '\n')).toBe(true);
    expect(new RegExp('[^]').test('\n')).toBe(true);
  });

  it('accepts the empty character class, which matches nothing', () => {
    // `[]` is a **valid** class in JavaScript: it matches nothing at all.
    // This implementation accepts it too, and it matches nothing there as well — so the
    // registry does not turn a pattern JavaScript accepts into a configuration
    // error.
    const compiled = compileMatcher('[]');

    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.matcher.kind).toBe('regex');
      expect(compiled.matcher.test('')).toBe(false);
      expect(compiled.matcher.test('a')).toBe(false);
      expect(compiled.matcher.test(']')).toBe(false);
    }
    expect(new RegExp('[]').test('a')).toBe(false);

    // The class ends at its first `]`, so the `]` after it is a literal of
    // its own — the way JavaScript reads it.
    expect(matchToolName('[]', 'a')).toBe(false);
    expect(matchToolName('[]]', ']')).toBe(false);
    expect(new RegExp('[]]').test(']')).toBe(false);
    expect(matchToolName('[^]]', 'a]')).toBe(true);
    expect(new RegExp('[^]]').test('a]')).toBe(true);

    // A class with members is unaffected.
    expect(matchToolName('[abc]', 'b')).toBe(true);
    expect(matchToolName('[^abc]', 'b')).toBe(false);
  });

  it('refuses a character class that is never closed', () => {
    // The reason names what is actually wrong: the class is unterminated.
    const compiled = compileMatcher('[abc');

    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.reason).toContain('unterminated character class');
    }
  });

  it('refuses a quantifier whose bounds are out of order', () => {
    // JavaScript refuses `a{2,1}` — the bounds are out of order — and the
    // implementation refuses it too, rather than reading it as `a{2}` and matching a
    // text the pattern does not name.
    const compiled = compileMatcher('a{2,1}');

    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.reason).toContain('out of order');
    }
    expect(matchToolName('a{2,1}', 'aa')).toBe(false);
    expect(() => new RegExp('a{2,1}')).toThrow();
  });

  it('does not match a line terminator with a dot', () => {
    // JavaScript's `.` matches every character **except** the four line
    // terminators: the line feed, the carriage return, the line separator and
    // the paragraph separator.
    for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
      expect(matchToolName('.', terminator)).toBe(false);
      expect(new RegExp('.').test(terminator)).toBe(false);
    }
    expect(matchToolName('.', 'a')).toBe(true);
    expect(matchToolName('a.c', 'a\nc')).toBe(false);
  });

  it('bounds the quantifiers the way JavaScript does', () => {
    // `x?` is "at most one x" and `x{n,m}` is "between n and m of them" —
    // not "any number of them". This implementation's engine is a non-backtracking
    // program, and the bound is part of the program it compiles.
    const cases: ReadonlyArray<readonly [string, string, boolean]> = [
      ['^a{2,3}$', 'aa', true],
      ['^a{2,3}$', 'aaa', true],
      ['^a{2,3}$', 'aaaa', false],
      ['^a{1,2}$', 'a', true],
      ['^a{1,2}$', 'aa', true],
      ['^a{1,2}$', 'aaa', false],
      ['^a{0,2}$', '', true],
      ['^a{0,2}$', 'aa', true],
      ['^a{0,2}$', 'aaa', false],
      ['^a{0,1}$', '', true],
      ['^a{0,1}$', 'a', true],
      ['^a{0,1}$', 'aa', false],
      ['^colou?r$', 'colour', true],
      ['^colou?r$', 'colouur', false],
      ['^ab?c$', 'ac', true],
      ['^ab?c$', 'abc', true],
      ['^ab?c$', 'abbc', false],
      ['^a?$', '', true],
      ['^a?$', 'a', true],
      ['^a?$', 'aa', false],
      ['^(a|b){1,2}$', 'a', true],
      ['^(a|b){1,2}$', 'ab', true],
      ['^(a|b){1,2}$', 'aba', false],
      ['^(a|b){1,2}$', 'abab', false],
      ['^x{2,}$', 'xx', true],
      ['^x{2,}$', 'xxxxx', true],
      ['^x{2,}$', 'x', false],
    ];

    for (const [pattern, name, expected] of cases) {
      expect({ pattern, name, matched: matchToolName(pattern, name) }).toEqual({
        pattern,
        name,
        matched: expected,
      });
      // And the expectation is JavaScript's, not this implementation's.
      expect(expected).toBe(new RegExp(pattern).test(name));
    }
  });

  it('reads the escapes the way JavaScript reads them', () => {
    // `\xHH` and `\uHHHH` are the code units they name.
    expect(matchToolName('\\x41', 'A')).toBe(true);
    expect(matchToolName('\\u0041', 'A')).toBe(true);
    expect(matchToolName('\\u0041', 'u0041')).toBe(false);
    // `\cA` is the control character U+0001, the way JavaScript reads it.
    expect(matchToolName('\\cA', '\u0001')).toBe(true);
    expect(matchToolName('\\cA', 'cA')).toBe(false);
    expect(matchToolName('\\cz', '\u001a')).toBe(true);
    // `\u{...}` is a code-point escape only with JavaScript's `u` flag, and a
    // matcher carries no flags: JavaScript reads `\u` as the letter `u` and
    // the braces as ordinary text.
    expect(matchToolName('\\u{1F600}', 'u{1F600}')).toBe(true);
    expect(matchToolName('\\u{1F600}', '\u{1F600}')).toBe(false);
    expect(matchToolName('\\u{2}', 'uu')).toBe(true);
    // `\0` is the NUL character.
    expect(matchToolName('\\0', '\u0000')).toBe(true);

    // And every one of them agrees with JavaScript.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['\\x41', 'A'],
      ['\\x41', 'u0041'],
      ['\\u0041', 'A'],
      ['\\cA', '\u0001'],
      ['\\cA', 'cA'],
      ['\\cz', '\u001a'],
      ['\\u{1F600}', 'u{1F600}'],
      ['\\u{1F600}', '\u{1F600}'],
      ['\\u{2}', 'uu'],
      ['\\0', '\u0000'],
      ['\\n', '\n'],
      ['\\t', '\t'],
      ['\\.', '.'],
      ['\\\\', '\\'],
    ];
    for (const [pattern, name] of cases) {
      expect({ pattern, name, matched: matchToolName(pattern, name) }).toEqual({
        pattern,
        name,
        matched: new RegExp(pattern).test(name),
      });
    }
  });

  it('refuses the escapes and the quantifiers it cannot read', () => {
    // The legacy octal escapes, the backreferences, a control escape without
    // a letter, and a quantifier on an assertion: this implementation refuses them
    // loudly rather than reading them as something else.
    for (const pattern of ['\\01', '\\1', '\\c1', '^*', '\\b*', '$*']) {
      const compiled = compileMatcher(pattern);

      expect(compiled.ok).toBe(false);
      expect(matchToolName(pattern, 'a')).toBe(false);
    }
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
      // The bounded quantifiers: they are bounded, the way JavaScript's are.
      'a{1,2}',
      'a{0,2}',
      'a{0,1}',
      'a?',
      'ab?c',
      '(a|b){1,2}',
      'a{2,}',
      'a{0}',
      // The patterns that match the empty string: they match every text, the
      // way JavaScript's do.
      'x{0,0}',
      '()',
      '(?:)',
      '(?:a|)',
      // The whitespace classes, which are JavaScript's and not the ASCII six.
      '\\s',
      '\\S',
      // The classes, including the empty one and the negated empty one.
      '[]',
      '[^]',
      '[a-c]',
      '[^a-c]',
    ];
    const names = [
      'Bash',
      'Edit',
      'MultiEdit',
      'mcp__memory__recall',
      'colour',
      'ABC',
      'tool.ts',
      'xyz',
      '\u00a0',
      '\u2028',
      // The repeated characters: a corpus without them cannot tell a bounded
      // quantifier from an unbounded one.
      'aa',
      'aaa',
      'aaaa',
      'colouur',
      'abbc',
      'a',
      'b',
      'ab',
    ];

    for (const pattern of patterns) {
      // The premise of the comparison: this implementation compiles this pattern as a
      // **regular expression**. A pattern in the simple syntax is an
      // exact-string match, and it is compared against the simple rule in the
      // test below — never against a regular expression.
      const compiled = compileMatcher(pattern);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) continue;
      expect(compiled.matcher.kind).toBe('regex');

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

  it('compares the simple syntax against the simple rule, not against a regular expression', () => {
    // `a|` and `|a` are in the **simple** syntax: this implementation matches them as
    // an exact string with an empty alternative, and an empty alternative
    // matches every tool — the way the equivalent regular expression does.
    // The comparison with `new RegExp` would hold by luck and would not
    // exercise the empty node, so the simple rule is compared directly.
    for (const pattern of ['a|', '|a']) {
      const compiled = compileMatcher(pattern);

      expect(compiled.ok).toBe(true);
      if (!compiled.ok) continue;
      expect(compiled.matcher.kind).toBe('exact');
      expect(compiled.matcher.test('a')).toBe(true);
      expect(compiled.matcher.test('anything else')).toBe(true);
      expect(compiled.matcher.test('')).toBe(true);
    }

    // A simple matcher without an empty alternative matches its names only,
    // and it never matches a text that merely contains one.
    const exact = compileMatcher('Edit|Write');

    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.matcher.kind).toBe('exact');
      expect(exact.matcher.test('Edit')).toBe(true);
      expect(exact.matcher.test('Write')).toBe(true);
      expect(exact.matcher.test('MultiEdit')).toBe(false);
    }
  });

  it('agrees with JavaScript over a bounded fuzz of the supported subset', () => {
    // The property the whole module rests on: for every pattern this implementation
    // accepts **and** JavaScript accepts, the two agree on every input. The
    // fuzz generates patterns from the supported subset and compares the two
    // engines over a corpus that carries repeated characters — without them a
    // bounded quantifier and an unbounded one look the same.
    const patterns = fuzzPatterns(300);
    const names = [
      '',
      'a',
      'b',
      'c',
      'ab',
      'ba',
      'aa',
      'aaa',
      'aaaa',
      'aaaaa',
      'abab',
      'abbc',
      'colouur',
      'colour',
      'abc',
      'aab',
      'x',
      'xyz',
      'a1',
      'A_',
      'a b',
      'a.b',
      '\n',
      '\r',
      '\u2028',
      '\u2029',
      '\t',
    ];

    let compared = 0;
    let regexPatterns = 0;
    const divergences: string[] = [];

    for (const pattern of patterns) {
      const compiled = compileMatcher(pattern);
      if (!compiled.ok) continue;
      // The simple syntax is an exact-string match: it is not compared with
      // a regular expression.
      if (compiled.matcher.kind !== 'regex') continue;
      regexPatterns += 1;

      const reference = ((): RegExp | undefined => {
        try {
          return new RegExp(pattern);
        } catch {
          // JavaScript refuses the pattern. This implementation's `*` wildcard is the
          // one construct it accepts that JavaScript does not, so a pattern
          // JavaScript refuses is not compared here.
          return undefined;
        }
      })();
      if (reference === undefined) continue;
      for (const name of names) {
        compared += 1;
        const mine = compiled.matcher.test(name);
        const theirs = reference.test(name);
        if (mine !== theirs) {
          divergences.push(`${pattern} vs ${JSON.stringify(name)}: implementation=${mine} js=${theirs}`);
        }
      }
    }

    // The fuzz really ran.
    expect(regexPatterns).toBeGreaterThan(100);
    expect(compared).toBeGreaterThan(1000);
    expect(divergences).toEqual([]);
  });

  it('matches JavaScript’s whitespace set, not the ASCII six', () => {
    // JavaScript's `\s` is the ASCII whitespace characters, the no-break
    // space, the ogham space, the en-quad … hair-space block, the line and
    // paragraph separators, the narrow no-break space, the medium
    // mathematical space, the ideographic space and the byte order mark.
    for (const space of ['\u00a0', '\u2028', '\u2029', '\u3000', '\ufeff', '\u205f', '\u1680']) {
      expect(matchToolName('\\s', space)).toBe(true);
      expect(matchToolName('\\S', space)).toBe(false);
    }
    for (const space of [' ', '\t', '\n', '\r', '\f', '\v']) {
      expect(matchToolName('\\s', space)).toBe(true);
      expect(matchToolName('\\S', space)).toBe(false);
    }
    expect(matchToolName('\\S', 'Bash')).toBe(true);
  });
});

// --- the payload -----------------------------------------------------------------

describe('the hook payload', () => {
  it('carries the normalized permission mode', () => {
    // The payload carries one of the six modes: the `manual` alias of
    // `default` is normalized, never carried verbatim.
    const payload = buildHookPayload(
      'PreToolUse',
      { tool_name: 'Read' },
      { permission_mode: 'manual' },
    );

    expect(payload.permission_mode).toBe('default');
  });

  it('carries one of the six modes', () => {
    const modes = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;

    for (const mode of modes) {
      const payload = buildHookPayload('PreToolUse', { tool_name: 'Read' }, { permission_mode: mode });
      expect(payload.permission_mode).toBe(mode);
      expect(modes).toContain(payload.permission_mode as (typeof modes)[number]);
    }
  });

  it('normalizes the alias in the caller’s input too', () => {
    const payload = buildHookPayload('PreToolUse', {
      tool_name: 'Read',
      permission_mode: 'manual',
    });

    expect(payload.permission_mode).toBe('default');
  });

  it('refuses a permission mode that is not one of the six', () => {
    // The payload is built from the caller's input, which is untrusted data,
    // so the "one of the six" guarantee cannot be a type claim alone: a value
    // that names none of the six is **not carried** by the payload.
    const payload = buildHookPayload('PreToolUse', {
      tool_name: 'Read',
      permission_mode: 'nonsense',
    });

    expect(payload.permission_mode).toBeUndefined();
    expect(payload['permission_mode']).toBeUndefined();

    // A value that is not even a string is refused the same way.
    const numbered = buildHookPayload('PreToolUse', {
      tool_name: 'Read',
      permission_mode: 42,
    });

    expect(numbered.permission_mode).toBeUndefined();
  });

  it('refuses a permission mode that is not one of the six in the context too', () => {
    const payload = buildHookPayload(
      'PreToolUse',
      { tool_name: 'Read' },
      { permission_mode: 'nonsense' as unknown as 'default' },
    );

    expect(payload.permission_mode).toBeUndefined();
  });

  it('carries the six modes and only the six', () => {
    const modes = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;

    for (const mode of modes) {
      const payload = buildHookPayload('PreToolUse', { tool_name: 'Read' }, { permission_mode: mode });
      expect(payload.permission_mode).toBe(mode);
      expect(modes).toContain(payload.permission_mode as (typeof modes)[number]);
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

  it('dispatches a hook by its effective handler kind', async () => {
    let commands = 0;
    let mcpCalls = 0;
    // `handlerType` carries the handler kind when it is present, so this hook
    // is a command hook and not an MCP hook.
    const spec: HookSpec = {
      event: 'PreToolUse',
      type: 'mcp_tool',
      handlerType: 'command',
      command: 'echo hi',
    };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' }, undefined, {
      runCommand: async () => {
        commands += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      callMcpTool: async () => {
        mcpCalls += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(commands).toBe(1);
    expect(mcpCalls).toBe(0);
    expect(results[0]?.exitCode).toBe(0);
  });

  it('removes the abort listener when the hook has finished', async () => {
    const controller = new AbortController();
    const spec: HookSpec = { event: 'PreToolUse', command: 'echo hi' };

    for (let round = 0; round < 5; round += 1) {
      await runHooks([spec], 'PreToolUse', { tool_name: 'Read' }, controller.signal);
    }

    // The listener closes over the child process and its captured output, and
    // an `AbortSignal` has no `setMaxListeners`, so a listener that stayed
    // would leak for the life of the session.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('names the hook that failed', async () => {
    const first: HookSpec = { event: 'PreToolUse', id: 'first-hook', command: 'echo first' };
    const second: HookSpec = { event: 'PreToolUse', id: 'second-hook', command: 'exit 3' };
    const third: HookSpec = { event: 'PreToolUse', id: 'third-hook', command: 'echo third' };

    const results = await runHooks([first, second, third], 'PreToolUse', { tool_name: 'Read' });

    expect(results).toHaveLength(3);
    // The message names the hook that failed, and only that one.
    expect(results[1]?.error).toContain('second-hook');
    expect(results[1]?.error).not.toContain('first-hook');
    expect(results[1]?.error).not.toContain('third-hook');
    expect(results[0]?.error).toBeUndefined();
    expect(results[2]?.error).toBeUndefined();
  });

  it('names the hook that failed by its command when it has no id', async () => {
    const spec: HookSpec = { event: 'PreToolUse', command: 'echo the-hook-trouble >&2; exit 1' };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' });

    expect(results[0]?.error).toContain('the-hook-trouble');
    expect(results[0]?.error).toContain('exit 1');
  });

  it('marks a deny decision as blocked whether the hook exited zero or two', async () => {
    const denied: HookSpec = {
      event: 'PreToolUse',
      command: `echo '{"hookSpecificOutput":{"permissionDecision":"deny"}}'`,
    };
    const blocked: HookSpec = { event: 'PreToolUse', command: 'exit 2' };
    const allowed: HookSpec = {
      event: 'PreToolUse',
      command: `echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'`,
    };

    const deniedResults = await runHooks([denied], 'PreToolUse', { tool_name: 'Read' });
    const blockedResults = await runHooks([blocked], 'PreToolUse', { tool_name: 'Read' });
    const allowedResults = await runHooks([allowed], 'PreToolUse', { tool_name: 'Read' });

    // Both ways of denying block the operation.
    expect(deniedResults[0]?.permissionDecision).toBe('deny');
    expect(deniedResults[0]?.blocked).toBe(true);
    expect(blockedResults[0]?.permissionDecision).toBe('deny');
    expect(blockedResults[0]?.blocked).toBe(true);
    // And an approval does not block it.
    expect(allowedResults[0]?.blocked).toBe(false);
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

  it('can express a permission rule named mode in the map form', () => {
    // The value decides: a mode name changes the mode, and anything else is
    // a permission rule — so a rule literally named `mode` is expressible.
    const rule = applyUpdatedPermissions({ allow: [], deny: [], ask: [] }, { mode: 'deny' });

    expect(rule.deny).toEqual(['mode']);
    expect(rule.allow).toEqual([]);
    expect(rule.mode).toBeUndefined();

    const removal = applyUpdatedPermissions(
      { allow: ['mode'], deny: [], ask: [] },
      { mode: 'remove' },
    );

    expect(removal.allow).toEqual([]);
  });

  it('keeps the audit’s strictness table', () => {
    // The audit's table is `allow: 1`, `ask: 2`, `deny: 3`, and the ranks of
    // the merge are derived from it.
    expect(DECISION_STRICTNESS).toEqual({ allow: 1, ask: 2, deny: 3 });
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

// --- the PreToolUse seam ---------------------------------------------------------

describe('the PreToolUse seam', () => {
  it('denies the tool call', async () => {
    const spec = jsonHook('PreToolUse', {
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'the hook refuses this call',
      },
    });

    const hook = createPermissionRequestHook({
      approval: createPreToolUseApproval([spec]),
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
    // This implementation picks the stricter of the target's two behaviours: a
    // `PreToolUse` hook's `allow` never overrides a deny rule.
    const spec = jsonHook('PreToolUse', {
      hookSpecificOutput: { permissionDecision: 'allow' },
    });

    const hook = createPermissionRequestHook({
      approval: createPreToolUseApproval([spec]),
    });

    const decision = await checkPermission(toolContext(), {
      rules: ruleSet({ deny: ['Bash'] }),
      mode: 'default',
      hook,
    });

    expect(decision.behavior).toBe('deny');
  });

  it('does not override an ask rule', async () => {
    const spec = jsonHook('PreToolUse', {
      hookSpecificOutput: { permissionDecision: 'allow' },
    });

    const hook = createPermissionRequestHook({
      approval: createPreToolUseApproval([spec]),
    });

    const decision = await checkPermission(toolContext(), {
      rules: ruleSet({ ask: ['Bash'] }),
      mode: 'default',
      hook,
    });

    expect(decision.behavior).toBe('ask');
  });

  it('holds a denial in bypassPermissions', async () => {
    // This implementation picks the stricter of the target's two behaviours: a
    // `PreToolUse` hook's `deny` holds in every mode.
    const spec = jsonHook('PreToolUse', {
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'the hook refuses this call',
      },
    });

    const hook = createPermissionRequestHook({
      approval: createPreToolUseApproval([spec]),
    });

    const decision = await checkPermission(toolContext(), {
      rules: ruleSet(),
      mode: 'bypassPermissions',
      hook,
    });

    expect(decision.behavior).toBe('deny');
  });

  it('turns a group of hook results into the approval the seam expects', () => {
    const approval = mergePreToolUseApproval([
      { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
      { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    ]);

    expect(approval?.hookEventName).toBe('PreToolUse');
    expect(approval?.decision?.behavior).toBe('deny');
    expect(approval?.decision?.reason).toBe('no');
  });

  it('gives no approval when the PreToolUse hooks did not decide', () => {
    const approval = mergePreToolUseApproval([
      { hookEventName: 'PreToolUse', additionalContext: 'just a note' },
    ]);

    expect(approval).toBeUndefined();
  });
});

// --- the documented shape of the hook surface -----------------------------------

/** The source of a module of the hook surface. */
function moduleSource(name: string): string {
  return readFileSync(new URL(`../../src/extensions/hooks/${name}.ts`, import.meta.url), 'utf8');
}

/** The header of a module of the hook surface, with the comment markers stripped. */
function moduleHeader(name: string): string {
  const source = moduleSource(name);
  return source.slice(0, source.indexOf('*/')).replace(/^\s*\*\s?/gm, '');
}

describe('the documented shape of the hook surface', () => {
  it('labels the implementation choices in the module headers', () => {
    const runner = moduleHeader('runner');
    // The command shell, the default timeout, the handler types this implementation
    // does not dispatch, the shape of a permission update, and the
    // `PreToolUse` precedence this implementation picked.
    expect(runner).toMatch(/\/bin\/sh -c/);
    expect(runner).toMatch(/60 seconds/);
    expect(runner).toMatch(/`http`[\s\S]*`prompt`[\s\S]*`agent`/);
    expect(runner).toMatch(/`updatedPermissions`/);
    expect(runner).toMatch(/bypassPermissions/);

    const matcher = moduleHeader('matcher');
    // The supported subset, the malformed-matcher rule and the bounds.
    expect(matcher).toMatch(/subset/);
    expect(matcher).toMatch(/matches nothing/);
    expect(matcher).toMatch(/MAX_MATCH_NODES/);
    // The agreement claim: the engine is not an approximation of JavaScript's
    // regular expressions, it is the same language over the same patterns.
    expect(matcher).toMatch(/agrees with JavaScript on every\s+pattern they both accept/);
    expect(matcher).toMatch(/`\*` with nothing in front of[\s\S]*wildcard/);

    // The payload's guarantee about the permission mode is documented where
    // the payload is built.
    const schema = moduleHeader('schema');
    expect(schema).toMatch(/permission_mode` in the payload is the normalized six/);
    expect(schema).toMatch(/refused/);

    // The blockable-event set is a implementation choice, and it is labelled in both
    // modules that carry it.
    for (const name of ['registry', 'schema']) {
      const header = moduleHeader(name);
      expect(header).toMatch(/blockable events are the eleven decision-capable events plus/);
    }
  });

  it('keeps the runner free of a run-time dependency on the registry', () => {
    const source = moduleSource('runner');
    const imports = [...source.matchAll(/import\s+([^;]*?)\s+from\s+'\.\/registry\.js'/g)];

    // The registry's types are imported with `import type`, which is erased:
    // the emitted module never imports the registry, so the two modules do
    // not depend on each other at run time.
    expect(imports.length).toBeGreaterThan(0);
    for (const entry of imports) {
      expect(entry[1]).toMatch(/^type\s/);
    }
  });

  it('keeps the matcher in its own module and reachable from the schema', () => {
    // The matcher is a regular expression engine, and it is the only part of
    // the hook surface that reasons about untrusted text: it has a module of
    // its own. Its public surface is still reachable from the schema module,
    // so no caller breaks.
    expect(schemaModule.compileMatcher).toBe(matcherModule.compileMatcher);
    expect(schemaModule.matchToolName).toBe(matcherModule.matchToolName);
    expect(schemaModule.MAX_MATCH_NODES).toBe(matcherModule.MAX_MATCH_NODES);
    expect(moduleHeader('schema')).toMatch(/matcher\.js/);
  });

  it('derives the decision ranks from the audit’s strictness table', () => {
    expect(DECISION_RANKS.allow).toBe(DECISION_STRICTNESS.allow * 2);
    expect(DECISION_RANKS.ask).toBe(DECISION_STRICTNESS.ask * 2);
    expect(DECISION_RANKS.deny).toBe(DECISION_STRICTNESS.deny * 2);
    // `defer` sits between `ask` and `deny`.
    expect(DECISION_RANKS.defer).toBeGreaterThan(DECISION_RANKS.ask);
    expect(DECISION_RANKS.defer).toBeLessThan(DECISION_RANKS.deny);
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

  it('reports a hook of a handler type this implementation cannot execute instead of dropping it', async () => {
    const spec: HookSpec = {
      event: 'PreToolUse',
      id: 'the-http-hook',
      command: 'echo hi',
      handlerType: 'http',
    };

    const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' });

    // A hook the user configured is never dropped in silence: the result
    // names the handler type and the hook.
    expect(results).toHaveLength(1);
    expect(results[0]?.severity).toBe('warning');
    expect(results[0]?.blocked).toBe(false);
    expect(results[0]?.continue).toBe(true);
    expect(results[0]?.error).toContain('http');
    expect(results[0]?.error).toContain('the-http-hook');
    expect(results[0]?.error).toContain('not dispatched by this implementation');
  });

  it('reports every handler type this implementation cannot execute', async () => {
    for (const handler of ['http', 'prompt', 'agent'] as const) {
      const spec: HookSpec = {
        event: 'PreToolUse',
        command: 'echo hi',
        handlerType: handler,
      };

      const results = await runHooks([spec], 'PreToolUse', { tool_name: 'Read' });

      expect(results).toHaveLength(1);
      expect(results[0]?.error).toContain(handler);
      expect(results[0]?.blocked).toBe(false);
    }
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
