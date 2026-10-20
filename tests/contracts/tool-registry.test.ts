/**
 * Contract test for the tool registry, the tool runner, and the built-in tools.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch) and §2.5 (Permissions, "Tool contract" and "Host-level gates"), and the
 * `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins the registry's discoverability, the runner's order (**check
 * permissions → validate input → execute**), the envelope's shape, the refusal of a
 * write whose path was re-resolved after the check, the built-in tools' input
 * rejection and normal paths, and the rule engine's role in the tools' permission
 * checks.
 */

import { createServer, type Server } from 'node:http';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FILE_MUTATING_TOOLS,
  TOOL_ERROR_CODES,
  ToolExecutionError,
  createToolRegistry,
  isToolConcurrencySafe,
  type ToolDefinition,
  type ToolRegistry,
  type ToolRecheck,
} from '../../src/tools/registry.js';
import { runTool, type ToolResultEnvelope } from '../../src/tools/runner.js';
import {
  BUILTIN_TOOL_NAMES,
  createBuiltinTools,
  registerBuiltinTools,
} from '../../src/tools/builtins/index.js';
import { createBashTool, resolveBashTimeout, DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS } from '../../src/tools/builtins/bash.js';
import { createEditTool } from '../../src/tools/builtins/edit.js';
import { createGlobTool, MAX_GLOB_RESULTS } from '../../src/tools/builtins/glob.js';
import { createGrepTool, MAX_GREP_FILES } from '../../src/tools/builtins/grep.js';
import { createNotebookEditTool } from '../../src/tools/builtins/notebookedit.js';
import { createReadTool } from '../../src/tools/builtins/read.js';
import { createTaskTool } from '../../src/tools/builtins/task.js';
import { createTodoWriteTool } from '../../src/tools/builtins/todowrite.js';
import type { TodoWriteInput } from '../../src/tools/builtins/todowrite.js';
import { createWebFetchTool, MAX_WEBFETCH_BYTES } from '../../src/tools/builtins/webfetch.js';
import { createWriteTool } from '../../src/tools/builtins/write.js';
import { PathSnapshot, type BuiltinToolDeps } from '../../src/tools/builtins/shared.js';
import { buildApprovalPrompt } from '../../src/permissions/prompts.js';
import {
  FILE_MUTATING_TOOL_NAMES,
  type RuleDecision,
  type RuleSet,
} from '../../src/permissions/rules.js';
import { evaluateRules, type PermissionDecision, type ToolContext } from '../../src/permissions/decision.js';

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

/** The temporary directories the test creates. */
const temporaryDirectories: string[] = [];

function makeDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'cc008-'));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Point a symlink at another target, **atomically**.
 *
 * `unlink` followed by `symlink` leaves a window in which the path does not
 * exist at all, and a read that lands in that window fails with `ENOENT`
 * instead of following the new link. A `rename` over the old link does not.
 */
function swapSymlink(link: string, target: string): void {
  const temporary = `${link}.swap`;
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}

/** The servers the test starts. */
const servers: Server[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
  while (servers.length > 0) {
    const server = servers.pop();
    server?.close();
  }
});

/** A tool definition whose three members the test controls. */
function stubTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'Stub',
    description: 'A stub tool.',
    inputSchema: { type: 'object' },
    mutatesFiles: false,
    async checkPermissions() {
      return undefined;
    },
    async validateInput() {
      return { ok: true };
    },
    async recheckPermission() {
      // The re-check approves the rewritten input by default; a test that cares
      // about the re-check overrides it.
      return {
        decision: { behavior: 'allow', source: 'unknown', reasonType: 'other' },
      };
    },
    async execute() {
      return 'done';
    },
    ...overrides,
  };
}

/**
 * An input as it arrives at runtime.
 *
 * The model sends JSON, so the value may not match the tool's declared shape at
 * all — that is exactly what `validateInput` is for.
 */
function raw(value: unknown): never {
  return value as never;
}

// --- the registry ----------------------------------------------------------------

describe('the tool registry', () => {
  it('makes a registered tool discoverable', () => {
    const registry = createToolRegistry();
    const tool = stubTool({ name: 'Read' });

    registry.register(tool);

    expect(registry.get('Read')).toBe(tool);
  });

  it('returns undefined for an unknown tool name', () => {
    const registry = createToolRegistry();

    expect(registry.get('NoSuchTool')).toBeUndefined();
  });

  it('lists the tools in registration order', () => {
    const registry = createToolRegistry();
    const first = stubTool({ name: 'First' });
    const second = stubTool({ name: 'Second' });
    const third = stubTool({ name: 'Third' });

    registry.register(first);
    registry.register(second);
    registry.register(third);

    expect(registry.list().map((tool) => tool.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('does not resolve a tool name from Object.prototype', () => {
    const registry = createToolRegistry();
    registry.register(stubTool({ name: 'Read' }));

    for (const name of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(registry.get(name)).toBeUndefined();
    }
  });

  it('derives the file-mutating tool set from the permission module', () => {
    expect(FILE_MUTATING_TOOLS).toEqual(['Edit', 'Write', 'NotebookEdit']);
    expect([...FILE_MUTATING_TOOLS]).toEqual([...FILE_MUTATING_TOOL_NAMES]);
    // The set is derived, not duplicated: the two arrays are not the same object.
    expect(FILE_MUTATING_TOOLS).not.toBe(FILE_MUTATING_TOOL_NAMES);
  });

  it('registers the ten built-in tools', () => {
    const registry = createToolRegistry();
    registerBuiltinTools(registry, builtinDeps());

    expect(registry.list().map((tool) => tool.name)).toEqual([...BUILTIN_TOOL_NAMES]);
    expect(BUILTIN_TOOL_NAMES).toHaveLength(10);
    for (const name of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'TodoWrite', 'NotebookEdit', 'Task']) {
      expect(registry.get(name)).toBeDefined();
    }
  });

  it('marks exactly the three file-mutating built-ins as mutating', () => {
    const tools = createBuiltinTools(builtinDeps());
    const mutating = tools.filter((tool) => tool.mutatesFiles).map((tool) => tool.name);

    expect(mutating.sort()).toEqual(['Edit', 'NotebookEdit', 'Write']);
  });
});

// --- the runner ------------------------------------------------------------------

describe('the tool runner', () => {
  it('produces an error envelope with the decision attached when the check denies', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        name: 'Write',
        async checkPermissions() {
          return {
            behavior: 'deny',
            source: 'unknown',
            reasonType: 'rule',
            reason: "Permission rule 'Write' from userSettings denies this Write call.",
            rule: { content: 'Write', source: 'userSettings' },
          };
        },
        execute,
      }),
    );

    const envelope = await runTool(
      registry,
      'Write',
      { file_path: '/work/a.txt', content: 'x' },
      toolContext('Write', { file_path: '/work/a.txt', content: 'x' }),
    );

    expect(envelope.isError).toBe(true);
    expect(envelope.permissionDecision).toEqual({
      decision: 'deny',
      source: 'unknown',
      reasonType: 'rule',
    });
    expect(envelope.toolUseId).toBe('toolu_01');
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports the denial reason and the typed error code in the content', async () => {
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return {
            behavior: 'deny',
            source: 'user_reject',
            reasonType: 'other',
            reason: 'The user rejected the call.',
          };
        },
      }),
    );

    const envelope = await runTool(
      registry,
      'Stub',
      {},
      toolContext('Stub', {}),
    );

    expect(envelope.isError).toBe(true);
    expect(envelope.content).toEqual({
      type: 'error',
      message: 'The user rejected the call.',
      errorCode: TOOL_ERROR_CODES.permissionDenied,
    });
    expect(envelope.userFeedback).toBe('The user rejected the call.');
  });

  it('produces an error envelope with the message and the error code when the validation fails', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return { behavior: 'allow', source: 'user_permanent', reasonType: 'other' };
        },
        async validateInput() {
          return {
            ok: false,
            message: "The 'file_path' argument is required.",
            errorCode: TOOL_ERROR_CODES.missingField,
          };
        },
        execute,
      }),
    );

    const envelope = await runTool(registry, 'Stub', {}, toolContext('Stub', {}));

    expect(envelope.isError).toBe(true);
    expect(envelope.content).toEqual({
      type: 'error',
      message: "The 'file_path' argument is required.",
      errorCode: TOOL_ERROR_CODES.missingField,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('records the permission decision on the envelope of a call that ran', async () => {
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return { behavior: 'allow', source: 'user_permanent', reasonType: 'rule' };
        },
      }),
    );

    const envelope = await runTool(
      registry,
      'Stub',
      { a: 1 },
      toolContext('Stub', { a: 1 }),
    );

    expect(envelope.isError).toBe(false);
    expect(envelope.content).toBe('done');
    expect(envelope.permissionDecision).toEqual({
      decision: 'allow',
      source: 'user_permanent',
      reasonType: 'rule',
    });
  });

  it('runs the input a hook rewrote', async () => {
    const seen: unknown[] = [];
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return {
            behavior: 'allow',
            source: 'hook',
            reasonType: 'other',
            updatedInput: { file_path: '/work/rewritten.txt' },
          };
        },
        // The validator **rejects** the original input, so the test fails when
        // the runner executes what the call named instead of what the hook
        // rewrote it to.
        async validateInput(input) {
          const value = (input as { file_path?: unknown }).file_path;
          if (value !== '/work/rewritten.txt') {
            return {
              ok: false,
              message: `The tool was given '${String(value)}' and not the rewritten input.`,
              errorCode: TOOL_ERROR_CODES.invalidPath,
            };
          }
          return { ok: true };
        },
        async execute(input) {
          seen.push(input);
          return 'done';
        },
      }),
    );

    const envelope = await runTool(
      registry,
      'Stub',
      { file_path: '/work/original.txt' },
      toolContext('Stub', { file_path: '/work/original.txt' }),
    );

    expect(envelope.isError).toBe(false);
    expect(seen).toEqual([{ file_path: '/work/rewritten.txt' }]);
  });

  it('denies the call when the input a hook rewrote is rejected by the tool validator', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return {
            behavior: 'allow',
            source: 'hook',
            reasonType: 'other',
            updatedInput: { file_path: 42 },
          };
        },
        async validateInput() {
          return {
            ok: false,
            message: "The 'file_path' argument must be a string.",
            errorCode: TOOL_ERROR_CODES.invalidPath,
          };
        },
        execute,
      }),
    );

    const envelope = await runTool(
      registry,
      'Stub',
      { file_path: '/work/original.txt' },
      toolContext('Stub', { file_path: '/work/original.txt' }),
    );

    expect(envelope.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(envelope.permissionDecision?.decision).toBe('deny');
    expect(envelope.permissionDecision?.source).toBe('hook');
    expect(envelope.content).toMatchObject({
      errorCode: TOOL_ERROR_CODES.invalidPath,
    });
  });

  it('refuses a call that still needs approval', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return { behavior: 'ask', source: 'unknown', reasonType: 'other' };
        },
        execute,
      }),
    );

    const envelope = await runTool(registry, 'Stub', {}, toolContext('Stub', {}));

    expect(envelope.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(envelope.permissionDecision?.decision).toBe('ask');
    expect(envelope.nonExecutionKind).toBe('permission_unresolved');
  });

  it('refuses a call whose tool expressed no opinion', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(stubTool({ execute }));

    const envelope = await runTool(registry, 'Stub', {}, toolContext('Stub', {}));

    expect(envelope.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(envelope.nonExecutionKind).toBe('permission_denied');
  });

  it('escalates a tool that expressed no opinion to the session permission service', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(stubTool({ execute }));

    const envelope = await runTool(
      registry,
      'Stub',
      {},
      toolContext('Stub', {}),
      {
        checkPermission: async () => ({
          behavior: 'allow',
          source: 'classifier',
          reasonType: 'other',
        }),
      },
    );

    expect(envelope.isError).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(envelope.permissionDecision?.source).toBe('classifier');
  });

  it('refuses a call to a tool the registry does not hold', async () => {
    const registry = createToolRegistry();

    const envelope = await runTool(registry, 'NoSuchTool', {}, toolContext('NoSuchTool', {}));

    expect(envelope.isError).toBe(true);
    expect(envelope.nonExecutionKind).toBe('unknown_tool');
    expect(envelope.content).toMatchObject({ errorCode: TOOL_ERROR_CODES.unknownTool });
  });

  it('reports the typed error code of a failed execution', async () => {
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return { behavior: 'allow', source: 'user_permanent', reasonType: 'other' };
        },
        async execute() {
          throw new ToolExecutionError('The file could not be read.', TOOL_ERROR_CODES.fileNotFound);
        },
      }),
    );

    const envelope = await runTool(registry, 'Stub', {}, toolContext('Stub', {}));

    expect(envelope.isError).toBe(true);
    expect(envelope.nonExecutionKind).toBe('execution_failed');
    expect(envelope.content).toEqual({
      type: 'error',
      message: 'The file could not be read.',
      errorCode: TOOL_ERROR_CODES.fileNotFound,
    });
  });

  it('tells the caller what to do about every failure', async () => {
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return { behavior: 'deny', source: 'user_reject', reasonType: 'other', reason: 'no' };
        },
      }),
    );

    const envelope = await runTool(registry, 'Stub', {}, toolContext('Stub', {}));

    expect(envelope.isError).toBe(true);
    expect(envelope.remedy).toBeTypeOf('string');
    expect(envelope.remedy?.length).toBeGreaterThan(0);
  });

  it('tells the caller what to do about every way a call can fail', async () => {
    const denying = createToolRegistry();
    denying.register(
      stubTool({
        async checkPermissions() {
          return { behavior: 'deny', source: 'user_reject', reasonType: 'other', reason: 'no' };
        },
      }),
    );

    const failing = createToolRegistry();
    failing.register(
      stubTool({
        async checkPermissions() {
          throw new Error('the rules could not be read');
        },
      }),
    );

    const invalid = createToolRegistry();
    invalid.register(
      stubTool({
        async checkPermissions() {
          return { behavior: 'allow', source: 'user_permanent', reasonType: 'other' };
        },
        async validateInput() {
          return { ok: false, message: 'no', errorCode: TOOL_ERROR_CODES.invalidInput };
        },
      }),
    );

    const failingExecution = createToolRegistry();
    failingExecution.register(
      stubTool({
        async checkPermissions() {
          return { behavior: 'allow', source: 'user_permanent', reasonType: 'other' };
        },
        async execute() {
          throw new Error('it broke');
        },
      }),
    );

    const silent = createToolRegistry();
    silent.register(stubTool());

    const envelopes = [
      await runTool(denying, 'Stub', {}, toolContext('Stub', {})),
      await runTool(failing, 'Stub', {}, toolContext('Stub', {})),
      await runTool(invalid, 'Stub', {}, toolContext('Stub', {})),
      await runTool(failingExecution, 'Stub', {}, toolContext('Stub', {})),
      await runTool(silent, 'Stub', {}, toolContext('Stub', {})),
      await runTool(createToolRegistry(), 'NoSuchTool', {}, toolContext('NoSuchTool', {})),
    ];

    for (const envelope of envelopes) {
      expect(envelope.isError).toBe(true);
      expect(envelope.remedy).toBeTypeOf('string');
      expect(envelope.remedy?.length).toBeGreaterThan(0);
    }
  });

  it('runs a call the approval allowed', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return { behavior: 'ask', source: 'unknown', reasonType: 'other' };
        },
        execute,
      }),
    );

    const envelope = await runTool(registry, 'Stub', {}, toolContext('Stub', {}), {
      approveAsk: async () => ({ behavior: 'allow', source: 'user_temporary', reasonType: 'other' }),
    });

    expect(envelope.isError).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(envelope.permissionDecision?.decision).toBe('allow');
    expect(envelope.permissionDecision?.source).toBe('user_temporary');
  });

  it('refuses a call whose approval asked again', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return { behavior: 'ask', source: 'unknown', reasonType: 'other' };
        },
        execute,
      }),
    );

    const envelope = await runTool(registry, 'Stub', {}, toolContext('Stub', {}), {
      approveAsk: async () => ({ behavior: 'ask', source: 'unknown', reasonType: 'other' }),
    });

    expect(envelope.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(envelope.nonExecutionKind).toBe('permission_unresolved');
    expect(envelope.permissionDecision?.decision).toBe('ask');
  });

  it('reports a permission check that failed', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          throw new Error('the rules could not be read');
        },
        execute,
      }),
    );

    const envelope = await runTool(registry, 'Stub', {}, toolContext('Stub', {}));

    expect(envelope.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(envelope.nonExecutionKind).toBe('permission_check_failed');
    expect(envelope.content).toMatchObject({ errorCode: TOOL_ERROR_CODES.executionFailed });
    expect(String((envelope.content as { message: string }).message)).toContain(
      'the rules could not be read',
    );
  });

  it('reports a permission service that failed', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(stubTool({ execute }));

    const envelope = await runTool(registry, 'Stub', {}, toolContext('Stub', {}), {
      checkPermission: async () => {
        throw new Error('the service is down');
      },
    });

    expect(envelope.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(envelope.nonExecutionKind).toBe('permission_check_failed');
    expect(String((envelope.content as { message: string }).message)).toContain(
      'the service is down',
    );
  });

  it('uses the name of the tool itself for the rules and the path of an aliased registration', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'x');

    const tool = createWriteTool(
      builtinDeps({ rules: ruleSet({ deny: ['Write(a.txt)'], cwd: root }), cwd: root }),
    );
    const registry: ToolRegistry = {
      register: () => {},
      get: (name) => (name === 'Writer' ? tool : undefined),
      list: () => [tool],
    };

    const input = { file_path: file, content: 'y' };
    const envelope = await runTool(
      registry,
      'Writer',
      input,
      toolContext('Writer', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    expect(envelope.permissionDecision?.decision).toBe('deny');
    expect(readFileSync(file, 'utf8')).toBe('x');
  });
});

// --- the post-check re-resolution -------------------------------------------------

describe('the write path', () => {
  it('refuses a write whose path was re-resolved to another target after the check', async () => {
    const root = makeDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, 'file.txt'), 'first');
    writeFileSync(path.join(second, 'file.txt'), 'second');
    const link = path.join(root, 'link');
    symlinkSync(first, link);

    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        name: 'Write',
        mutatesFiles: true,
        async checkPermissions() {
          // The symlink is swapped **while the permission check runs**.
          unlinkSync(link);
          symlinkSync(second, link);
          return { behavior: 'allow', source: 'user_permanent', reasonType: 'other' };
        },
        execute,
      }),
    );

    const envelope = await runTool(
      registry,
      'Write',
      { file_path: path.join(link, 'file.txt'), content: 'x' },
      toolContext('Write', { file_path: path.join(link, 'file.txt'), content: 'x' }),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(envelope.nonExecutionKind).toBe('path_changed');
    expect(envelope.content).toMatchObject({ errorCode: TOOL_ERROR_CODES.pathChanged });
    expect(String((envelope.content as { message: string }).message)).toContain(
      path.join(first, 'file.txt'),
    );
  });

  it('lets a write through when the path still resolves where it did', async () => {
    const root = makeDirectory();
    const target = path.join(root, 'file.txt');
    writeFileSync(target, 'before');

    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        name: 'Write',
        mutatesFiles: true,
        async checkPermissions() {
          return { behavior: 'allow', source: 'user_permanent', reasonType: 'other' };
        },
        execute,
      }),
    );

    const envelope = await runTool(
      registry,
      'Write',
      { file_path: target, content: 'x' },
      toolContext('Write', { file_path: target, content: 'x' }),
      { cwd: root },
    );

    expect(envelope.isError).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('re-resolves the path of a built-in write tool before the write', async () => {
    const root = makeDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, 'file.txt'), 'first');
    writeFileSync(path.join(second, 'file.txt'), 'second');
    const link = path.join(root, 'link');
    symlinkSync(first, link);

    const tool = createWriteTool(
      builtinDeps({ rules: ruleSet({ allow: ['Write'], cwd: root }), cwd: root }),
    );
    const input = { file_path: path.join(link, 'file.txt'), content: 'rewritten' };
    const ctx = toolContext('Write', input);

    await tool.checkPermissions(input, ctx);

    // The symlink is swapped **after** the check and before the write.
    unlinkSync(link);
    symlinkSync(second, link);

    await expect(tool.execute(input, ctx)).rejects.toThrow(/resolved to/);
    expect(readFileSync(path.join(second, 'file.txt'), 'utf8')).toBe('second');
  });

  it('refuses a write to a symlink a hook rewrote to when the symlink is swapped after the check', async () => {
    const root = makeDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, 'file.txt'), 'first');
    writeFileSync(path.join(second, 'file.txt'), 'second');
    const link = path.join(root, 'link');
    symlinkSync(first, link);

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Write'], cwd: root }),
        cwd: root,
        hook: () => ({
          behavior: 'allow',
          source: 'hook',
          reasonType: 'other',
          updatedInput: { file_path: path.join(link, 'file.txt'), content: 'rewritten' },
        }),
      }),
    );

    const original = { file_path: path.join(root, 'ok.txt'), content: 'x' };
    const ctx = toolContext('Write', original);
    const decision = await tool.checkPermissions(original, ctx);

    // The hook rewrote the path, so the path that will be written is the one the
    // symlink names.
    expect(decision?.updatedInput).toBeDefined();
    const rewritten = decision?.updatedInput as { file_path: string; content: string };
    expect(rewritten.file_path).toBe(path.join(link, 'file.txt'));

    // The symlink is swapped **after** the check and before the write.
    unlinkSync(link);
    symlinkSync(second, link);

    await expect(tool.execute(rewritten, ctx)).rejects.toThrow(/resolved to/);
    expect(readFileSync(path.join(second, 'file.txt'), 'utf8')).toBe('second');
    expect(readFileSync(path.join(first, 'file.txt'), 'utf8')).toBe('first');
  });

  it('re-resolves the path a hook rewrote to before the write', async () => {
    const root = makeDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, 'file.txt'), 'first');
    writeFileSync(path.join(second, 'file.txt'), 'second');
    const link = path.join(root, 'link');
    symlinkSync(first, link);

    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        name: 'Write',
        mutatesFiles: true,
        async checkPermissions() {
          return {
            behavior: 'allow',
            source: 'hook',
            reasonType: 'other',
            updatedInput: { file_path: path.join(link, 'file.txt') },
          };
        },
        async validateInput() {
          // The symlink is swapped **after** the check and before the write.
          unlinkSync(link);
          symlinkSync(second, link);
          return { ok: true };
        },
        execute,
      }),
    );

    const envelope = await runTool(
      registry,
      'Write',
      { file_path: path.join(root, 'ok.txt') },
      toolContext('Write', { file_path: path.join(root, 'ok.txt') }),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    expect(envelope.nonExecutionKind).toBe('path_changed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not re-resolve the path of a tool that does not mutate files', async () => {
    const root = makeDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, 'file.txt'), 'first');
    const link = path.join(root, 'link');
    symlinkSync(first, link);

    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        name: 'Read',
        mutatesFiles: false,
        async checkPermissions() {
          // The symlink is swapped while the permission check runs.
          unlinkSync(link);
          symlinkSync(second, link);
          return { behavior: 'allow', source: 'user_permanent', reasonType: 'other' };
        },
        execute,
      }),
    );

    const envelope = await runTool(
      registry,
      'Read',
      { file_path: path.join(link, 'file.txt') },
      toolContext('Read', { file_path: path.join(link, 'file.txt') }),
      { cwd: root },
    );

    expect(envelope.isError).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a write whose rewritten path was swapped while the re-check ran', async () => {
    const root = makeDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, 'file.txt'), 'first');
    writeFileSync(path.join(second, 'file.txt'), 'second');
    const link = path.join(root, 'link');
    symlinkSync(first, link);

    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        name: 'Write',
        mutatesFiles: true,
        async checkPermissions() {
          return {
            behavior: 'allow',
            source: 'hook',
            reasonType: 'other',
            updatedInput: { file_path: path.join(link, 'file.txt') },
          };
        },
        async recheckPermission() {
          // The symlink is swapped **while the re-check that approves the
          // rewritten path runs**.
          swapSymlink(link, second);
          return {
            decision: { behavior: 'allow', source: 'unknown', reasonType: 'other' },
          };
        },
        execute,
      }),
    );

    const envelope = await runTool(
      registry,
      'Write',
      { file_path: path.join(root, 'ok.txt') },
      toolContext('Write', { file_path: path.join(root, 'ok.txt') }),
      { cwd: root },
    );

    // The rewritten path is resolved **before** the check that approves it, so
    // the swap is caught on the path that is actually written.
    expect(envelope.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(envelope.nonExecutionKind).toBe('path_changed');
    expect(envelope.content).toMatchObject({ errorCode: TOOL_ERROR_CODES.pathChanged });
  });

  it('refuses a write whose rewritten path was swapped while the hook saw it again', async () => {
    const root = makeDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, 'file.txt'), 'first');
    writeFileSync(path.join(second, 'file.txt'), 'second');
    const link = path.join(root, 'link');
    symlinkSync(first, link);
    const rewritten = path.join(link, 'file.txt');

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Write'], cwd: root }),
        cwd: root,
        hook: (ctx) => {
          const input = ctx.input as { file_path?: string };
          if (input.file_path === rewritten) {
            // The re-check consults the hook with the **rewritten** input: the
            // symlink is swapped there.
            swapSymlink(link, second);
            return undefined;
          }
          return {
            behavior: 'allow',
            source: 'hook',
            reasonType: 'other',
            updatedInput: { file_path: rewritten, content: 'written' },
          };
        },
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const input = { file_path: path.join(root, 'ok.txt'), content: 'fine' };
    const envelope = await runTool(
      registry,
      'Write',
      input,
      toolContext('Write', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    expect(envelope.nonExecutionKind).toBe('path_changed');
    expect(readFileSync(path.join(second, 'file.txt'), 'utf8')).toBe('second');
  });

  it('re-resolves the path of a built-in write tool immediately before the write', async () => {
    const root = makeDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, 'file.txt'), 'first');
    writeFileSync(path.join(second, 'file.txt'), 'second');
    const link = path.join(root, 'link');
    symlinkSync(first, link);

    const tool = createWriteTool(
      builtinDeps({ rules: ruleSet({ allow: ['Write'], cwd: root }), cwd: root }),
    );
    const input = { file_path: path.join(link, 'file.txt'), content: 'written' };
    const ctx = toolContext('Write', input);

    await tool.checkPermissions(input, ctx);

    // The symlink is swapped **after the write path started** and before the
    // write, so only the re-resolution that guards the write can catch it.
    const writing = tool.execute(input, ctx);
    swapSymlink(link, second);

    await expect(writing).rejects.toThrow(/resolved to/);
    expect(readFileSync(path.join(first, 'file.txt'), 'utf8')).toBe('first');
    expect(readFileSync(path.join(second, 'file.txt'), 'utf8')).toBe('second');
  });

  it('re-resolves the path of a built-in edit tool immediately before the edit', async () => {
    const root = makeDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    // The two files hold the same text, so the read that sits between the check
    // and the write still finds the string to replace.
    writeFileSync(path.join(first, 'file.txt'), 'same');
    writeFileSync(path.join(second, 'file.txt'), 'same');
    const link = path.join(root, 'link');
    symlinkSync(first, link);

    const tool = createEditTool(
      builtinDeps({ rules: ruleSet({ allow: ['Edit'], cwd: root }), cwd: root }),
    );
    const input = { file_path: path.join(link, 'file.txt'), old_string: 'same', new_string: 'edited' };
    const ctx = toolContext('Edit', input);

    await tool.checkPermissions(input, ctx);

    // The symlink is swapped **after the write path started** and before the
    // write, so only the re-resolution that guards the write can catch it.
    const editing = tool.execute(input, ctx);
    swapSymlink(link, second);

    await expect(editing).rejects.toThrow(/resolved to/);
    expect(readFileSync(path.join(first, 'file.txt'), 'utf8')).toBe('same');
    expect(readFileSync(path.join(second, 'file.txt'), 'utf8')).toBe('same');
  });
});

describe('a hook rewrite and the deny list', () => {
  it('denies a call a hook rewrote to a path the deny list covers', async () => {
    const root = makeDirectory();
    const secret = path.join(root, 'secret.txt');
    writeFileSync(secret, 'the secret');

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ deny: ['Write(secret.txt)'], allow: ['Write'], cwd: root }),
        cwd: root,
        hook: () => ({
          behavior: 'allow',
          source: 'hook',
          reasonType: 'other',
          updatedInput: { file_path: secret, content: 'overwritten' },
        }),
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const input = { file_path: path.join(root, 'ok.txt'), content: 'fine' };
    const envelope = await runTool(
      registry,
      'Write',
      input,
      toolContext('Write', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    expect(envelope.permissionDecision?.decision).toBe('deny');
    expect(envelope.permissionDecision?.source).toBe('unknown');
    expect(envelope.nonExecutionKind).toBe('permission_denied');
    expect(envelope.content).toMatchObject({ errorCode: TOOL_ERROR_CODES.permissionDenied });
    // The denied file is untouched.
    expect(readFileSync(secret, 'utf8')).toBe('the secret');
  });

  it('runs a call a hook rewrote to a path the deny list does not cover', async () => {
    const root = makeDirectory();
    const other = path.join(root, 'other.txt');

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ deny: ['Write(secret.txt)'], allow: ['Write'], cwd: root }),
        cwd: root,
        hook: () => ({
          behavior: 'allow',
          source: 'hook',
          reasonType: 'other',
          updatedInput: { file_path: other, content: 'written' },
        }),
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const input = { file_path: path.join(root, 'ok.txt'), content: 'fine' };
    const envelope = await runTool(
      registry,
      'Write',
      input,
      toolContext('Write', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(false);
    expect(readFileSync(other, 'utf8')).toBe('written');
  });
});

// --- a hook rewrite and the whole permission check --------------------------------

/**
 * A hook rewrite and the **whole** permission check.
 *
 * The check evaluated the original input, so a rewrite that moves the call to
 * another path, to another command or to another mode's scope is a permission
 * bypass unless the rewritten input is checked again. The re-check is the same
 * check — the same rules, the same mode, the same safety check — and the runner
 * honours its verdict as it honours the first one.
 */
describe('a hook rewrite and the whole permission check', () => {
  it('refuses a rewrite onto a path an ask rule covers, with the shape of the no-hook refusal', async () => {
    const root = makeDirectory();
    const secret = path.join(root, 'secret.txt');
    writeFileSync(secret, 'the secret');
    const rules = ruleSet({ ask: ['Write(secret.txt)'], allow: ['Write'], cwd: root });

    // The same call **without** a hook: the ask rule covers it, so the call is
    // refused for the same reason a rewrite is refused for.
    const plain = createToolRegistry();
    plain.register(createWriteTool(builtinDeps({ rules, cwd: root })));
    const secretInput = { file_path: secret, content: 'overwritten' };
    const plainEnvelope = await runTool(
      plain,
      'Write',
      secretInput,
      toolContext('Write', secretInput),
      { cwd: root },
    );

    // The hook sends the call to the ask-covered path.
    const hooked = createToolRegistry();
    hooked.register(
      createWriteTool(
        builtinDeps({
          rules,
          cwd: root,
          hook: () => ({
            behavior: 'allow',
            source: 'hook',
            reasonType: 'other',
            updatedInput: { file_path: secret, content: 'overwritten' },
          }),
        }),
      ),
    );
    const input = { file_path: path.join(root, 'ok.txt'), content: 'fine' };
    const envelope = await runTool(
      hooked,
      'Write',
      input,
      toolContext('Write', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    // The refusal is the **same shape** as the no-hook refusal.
    expect(envelope.content).toEqual(plainEnvelope.content);
    expect(envelope.nonExecutionKind).toBe(plainEnvelope.nonExecutionKind);
    expect(envelope.permissionDecision).toEqual(plainEnvelope.permissionDecision);
    // The ask-covered file is untouched.
    expect(readFileSync(secret, 'utf8')).toBe('the secret');
  });

  it('refuses a rewrite outside the allow scope', async () => {
    const root = makeDirectory();
    const inside = path.join(root, 'safe', 'a.txt');
    const outside = path.join(root, 'outside.txt');
    mkdirSync(path.join(root, 'safe'));

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Write(safe/*.txt)'], cwd: root }),
        cwd: root,
        hook: () => ({
          behavior: 'allow',
          source: 'hook',
          reasonType: 'other',
          updatedInput: { file_path: outside, content: 'written' },
        }),
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const input = { file_path: inside, content: 'fine' };
    const envelope = await runTool(
      registry,
      'Write',
      input,
      toolContext('Write', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    expect(envelope.permissionDecision?.decision).toBe('ask');
    // The allow rule never covered the rewritten path, so nothing was written.
    expect(existsSync(outside)).toBe(false);
  });

  it('refuses a rewrite outside the working directory in acceptEdits mode', async () => {
    const root = makeDirectory();
    const outside = makeDirectory();

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ cwd: root }),
        mode: 'acceptEdits',
        cwd: root,
        hook: () => ({
          behavior: 'allow',
          source: 'hook',
          reasonType: 'other',
          updatedInput: { file_path: path.join(outside, 'x.txt'), content: 'written' },
        }),
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const input = { file_path: path.join(root, 'ok.txt'), content: 'fine' };
    const envelope = await runTool(
      registry,
      'Write',
      input,
      toolContext('Write', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    expect(envelope.permissionDecision?.decision).toBe('ask');
    // `acceptEdits` approves a write inside the working directory only.
    expect(existsSync(path.join(outside, 'x.txt'))).toBe(false);
  });

  it('runs a rewrite that stays inside the allow scope', async () => {
    const root = makeDirectory();
    const inside = path.join(root, 'safe', 'a.txt');
    const rewritten = path.join(root, 'safe', 'b.txt');
    mkdirSync(path.join(root, 'safe'));

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Write(safe/*.txt)'], cwd: root }),
        cwd: root,
        hook: () => ({
          behavior: 'allow',
          source: 'hook',
          reasonType: 'other',
          updatedInput: { file_path: rewritten, content: 'written' },
        }),
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const input = { file_path: inside, content: 'fine' };
    const envelope = await runTool(
      registry,
      'Write',
      input,
      toolContext('Write', input),
      { cwd: root },
    );

    // The negative control: the re-check is not over-broad, so a rewrite that
    // stays inside the allow scope still runs.
    expect(envelope.isError).toBe(false);
    expect(readFileSync(rewritten, 'utf8')).toBe('written');
  });

  it('does not run a call whose check asked and whose re-check allowed', async () => {
    const recheck = vi.fn(async (): Promise<ToolRecheck> => ({
      decision: { behavior: 'allow', source: 'unknown', reasonType: 'other' },
    }));
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          // The call needed the user's approval, and a hook rewrote it.
          return {
            behavior: 'ask',
            source: 'unknown',
            reasonType: 'other',
            reason: 'The call needs approval.',
            updatedInput: { file_path: '/work/rewritten.txt' },
          };
        },
        recheckPermission: recheck,
        execute,
      }),
    );

    const envelope = await runTool(
      registry,
      'Stub',
      { file_path: '/work/original.txt' },
      toolContext('Stub', { file_path: '/work/original.txt' }),
      {
        // The approval of the original call is not the approval of the rewritten
        // one, and the re-check's `allow` does not settle the ask either.
        approveAsk: async () => undefined,
      },
    );

    // The re-check ran, and it may only restrict the call: it never widens what
    // the first check allowed, so the `ask` stands and the call is not executed.
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(envelope.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(envelope.permissionDecision?.decision).toBe('ask');
    expect(envelope.nonExecutionKind).toBe('permission_unresolved');
  });

  it('stops the call when the hook denies the rewritten path', async () => {
    const root = makeDirectory();
    const secret = path.join(root, 'secret.txt');
    writeFileSync(secret, 'the secret');

    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Write'], cwd: root }),
        cwd: root,
        hook: (ctx) => {
          const input = ctx.input as { file_path?: string };
          if (input.file_path === secret) {
            // The re-check consults the hook with the **rewritten** input, and the
            // hook denies that path.
            return {
              behavior: 'deny',
              source: 'hook',
              reasonType: 'other',
              reason: 'The hook denied this path.',
            };
          }
          return {
            behavior: 'allow',
            source: 'hook',
            reasonType: 'other',
            updatedInput: { file_path: secret, content: 'overwritten' },
          };
        },
      }),
    );

    const registry = createToolRegistry();
    registry.register(tool);

    const input = { file_path: path.join(root, 'ok.txt'), content: 'fine' };
    const envelope = await runTool(
      registry,
      'Write',
      input,
      toolContext('Write', input),
      { cwd: root },
    );

    // The hook's **denial** still speaks in the re-check: a rewrite onto a denied
    // path does not get past it.
    expect(envelope.isError).toBe(true);
    expect(envelope.permissionDecision?.decision).toBe('deny');
    expect(readFileSync(secret, 'utf8')).toBe('the secret');
  });

  it('stops the call when the re-check asks, and carries the reason', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return {
            behavior: 'allow',
            source: 'hook',
            reasonType: 'other',
            updatedInput: { file_path: '/work/rewritten.txt' },
          };
        },
        async recheckPermission() {
          return {
            decision: {
              behavior: 'ask',
              source: 'unknown',
              reasonType: 'other',
              reason: 'The rewritten call needs approval.',
            },
          };
        },
        execute,
      }),
    );

    const envelope = await runTool(
      registry,
      'Stub',
      { file_path: '/work/original.txt' },
      toolContext('Stub', { file_path: '/work/original.txt' }),
    );

    // Every verdict but `allow` stops the call, and the refusal carries the
    // reason of the verdict.
    expect(envelope.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(envelope.permissionDecision?.decision).toBe('ask');
    expect(String((envelope.content as { message: string }).message)).toContain(
      'The rewritten call needs approval.',
    );
  });

  it('refuses a call whose re-check expressed no opinion', async () => {
    const execute = vi.fn(async () => 'done');
    const registry = createToolRegistry();
    registry.register(
      stubTool({
        async checkPermissions() {
          return {
            behavior: 'allow',
            source: 'hook',
            reasonType: 'other',
            updatedInput: { file_path: '/work/rewritten.txt' },
          };
        },
        async recheckPermission() {
          return { decision: undefined };
        },
        execute,
      }),
    );

    const envelope = await runTool(
      registry,
      'Stub',
      { file_path: '/work/original.txt' },
      toolContext('Stub', { file_path: '/work/original.txt' }),
    );

    expect(envelope.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(envelope.nonExecutionKind).toBe('permission_denied');
  });
});

// --- the built-in tools -----------------------------------------------------------

describe('the Read tool', () => {
  it('rejects an input without a file path', async () => {
    const tool = createReadTool(builtinDeps());

    const validation = await tool.validateInput(raw({}), toolContext('Read', {}));

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.missingField);
  });

  it('rejects a file path that is not a string', async () => {
    const tool = createReadTool(builtinDeps());

    const validation = await tool.validateInput(
      raw({ file_path: 42 }),
      toolContext('Read', { file_path: 42 }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidPath);
  });

  it('reads the file it is given', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'note.txt');
    writeFileSync(file, 'one\ntwo\nthree\n');

    const tool = createReadTool(
      builtinDeps({ rules: ruleSet({ allow: ['Read'], cwd: root }), cwd: root }),
    );
    const input = { file_path: file };
    const ctx = toolContext('Read', input);

    const decision = await tool.checkPermissions(input, ctx);
    expect(decision?.behavior).toBe('allow');

    const validation = await tool.validateInput(input, ctx);
    expect(validation.ok).toBe(true);

    const output = await tool.execute(input, ctx);
    expect(output.text).toBe('one\ntwo\nthree\n');
    expect(output.filePath).toBe(file);
  });

  it('reads only the lines it was asked for', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'note.txt');
    writeFileSync(file, 'one\ntwo\nthree\n');

    const tool = createReadTool(
      builtinDeps({ rules: ruleSet({ allow: ['Read'], cwd: root }), cwd: root }),
    );
    const input = { file_path: file, offset: 1, limit: 1 };

    const output = await tool.execute(input, toolContext('Read', input));

    expect(output.text).toBe('two');
  });
});

describe('the Write tool', () => {
  it('rejects an input without content', async () => {
    const tool = createWriteTool(builtinDeps());

    const validation = await tool.validateInput(
      raw({ file_path: '/work/a.txt' }),
      toolContext('Write', { file_path: '/work/a.txt' }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.missingField);
  });

  it('writes the file it is given', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'nested', 'out.txt');

    const tool = createWriteTool(
      builtinDeps({ rules: ruleSet({ allow: ['Write'], cwd: root }), cwd: root }),
    );
    const input = { file_path: file, content: 'hello\n' };
    const ctx = toolContext('Write', input);

    const decision = await tool.checkPermissions(input, ctx);
    expect(decision?.behavior).toBe('allow');

    const validation = await tool.validateInput(input, ctx);
    expect(validation.ok).toBe(true);

    const output = await tool.execute(input, ctx);
    expect(output.filePath).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe('hello\n');
  });

  it('accepts an empty file', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'empty.txt');

    const tool = createWriteTool(
      builtinDeps({ rules: ruleSet({ allow: ['Write'], cwd: root }), cwd: root }),
    );
    const input = { file_path: file, content: '' };

    const validation = await tool.validateInput(input, toolContext('Write', input));
    expect(validation.ok).toBe(true);

    await tool.execute(input, toolContext('Write', input));
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  it('rejects an argument the schema does not declare', async () => {
    const tool = createWriteTool(builtinDeps());
    const input = raw({ file_path: '/work/a.txt', content: 'x', surprise: 'extra' });

    const validation = await tool.validateInput(input, toolContext('Write', input));

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidInput);
    expect(validation.ok ? '' : validation.message).toContain('surprise');
  });

  it('refuses a write to a path the permission check did not approve', async () => {
    const root = makeDirectory();
    const approved = path.join(root, 'approved.txt');
    const other = path.join(root, 'other.txt');
    writeFileSync(approved, 'x');

    const tool = createWriteTool(
      builtinDeps({ rules: ruleSet({ allow: ['Write'], cwd: root }), cwd: root }),
    );
    const ctx = toolContext('Write', { file_path: approved });

    await tool.checkPermissions({ file_path: approved, content: 'x' }, ctx);

    // The write is to another path than the one the check approved.
    await expect(tool.execute({ file_path: other, content: 'y' }, ctx)).rejects.toThrow(
      /approved/,
    );
    expect(existsSync(other)).toBe(false);
  });

  it('forgets the path snapshot once the write is over', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'x');

    const tool = createWriteTool(
      builtinDeps({ rules: ruleSet({ allow: ['Write'], cwd: root }), cwd: root }),
    );
    const ctx = toolContext('Write', { file_path: file });

    await tool.checkPermissions({ file_path: file, content: 'y' }, ctx);
    await tool.execute({ file_path: file, content: 'y' }, ctx);

    // The snapshot of the finished call is gone, so a later call with the same
    // tool-use id is not refused by the snapshot of the earlier one.
    const other = path.join(root, 'b.txt');
    await expect(
      tool.execute({ file_path: other, content: 'z' }, ctx),
    ).resolves.toBeDefined();
    expect(readFileSync(other, 'utf8')).toBe('z');
  });
});

describe('the Edit tool', () => {
  it('rejects an input without a string to replace', async () => {
    const tool = createEditTool(builtinDeps());

    const validation = await tool.validateInput(
      raw({ file_path: '/work/a.txt', new_string: 'b' }),
      toolContext('Edit', { file_path: '/work/a.txt', new_string: 'b' }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.missingField);
  });

  it('rejects an empty string to replace', async () => {
    const tool = createEditTool(builtinDeps());

    const validation = await tool.validateInput(
      raw({ file_path: '/work/a.txt', old_string: '', new_string: 'b' }),
      toolContext('Edit', { file_path: '/work/a.txt', old_string: '', new_string: 'b' }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidInput);
  });

  it('replaces the string it was given', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'one two three\n');

    const tool = createEditTool(
      builtinDeps({ rules: ruleSet({ allow: ['Edit'], cwd: root }), cwd: root }),
    );
    const input = { file_path: file, old_string: 'two', new_string: 'four' };
    const ctx = toolContext('Edit', input);

    const decision = await tool.checkPermissions(input, ctx);
    expect(decision?.behavior).toBe('allow');

    const validation = await tool.validateInput(input, ctx);
    expect(validation.ok).toBe(true);

    const output = await tool.execute(input, ctx);
    expect(output.replacements).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('one four three\n');
  });

  it('replaces every occurrence when the call asks for it', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'one two one\n');

    const tool = createEditTool(
      builtinDeps({ rules: ruleSet({ allow: ['Edit'], cwd: root }), cwd: root }),
    );
    const input = { file_path: file, old_string: 'one', new_string: 'three', replace_all: true };
    const ctx = toolContext('Edit', input);

    const decision = await tool.checkPermissions(input, ctx);
    expect(decision?.behavior).toBe('allow');

    const validation = await tool.validateInput(input, ctx);
    expect(validation.ok).toBe(true);

    const output = await tool.execute(input, ctx);
    expect(output.replacements).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe('three two three\n');
  });

  it('suppresses an edit that would change nothing', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'one two\n');

    const tool = createEditTool(
      builtinDeps({ rules: ruleSet({ allow: ['Edit'], cwd: root }), cwd: root }),
    );
    const input = { file_path: file, old_string: 'two', new_string: 'two' };

    await expect(tool.execute(input, toolContext('Edit', input))).rejects.toMatchObject({
      errorCode: TOOL_ERROR_CODES.suppressedWrite,
    });
    expect(readFileSync(file, 'utf8')).toBe('one two\n');
  });

  it('refuses an edit that would change more than the caller asked for', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'one two one\n');

    const tool = createEditTool(
      builtinDeps({ rules: ruleSet({ allow: ['Edit'], cwd: root }), cwd: root }),
    );
    const input = { file_path: file, old_string: 'one', new_string: 'three' };

    await expect(tool.execute(input, toolContext('Edit', input))).rejects.toThrow(/appears 2 times/);
    expect(readFileSync(file, 'utf8')).toBe('one two one\n');
  });

  it('re-resolves the path of the file before the edit', async () => {
    const root = makeDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, 'file.txt'), 'first');
    writeFileSync(path.join(second, 'file.txt'), 'second');
    const link = path.join(root, 'link');
    symlinkSync(first, link);

    const tool = createEditTool(
      builtinDeps({ rules: ruleSet({ allow: ['Edit'], cwd: root }), cwd: root }),
    );
    const input = { file_path: path.join(link, 'file.txt'), old_string: 'first', new_string: 'edited' };
    const ctx = toolContext('Edit', input);

    await tool.checkPermissions(input, ctx);

    // The symlink is swapped **after** the check and before the edit.
    unlinkSync(link);
    symlinkSync(second, link);

    await expect(tool.execute(input, ctx)).rejects.toThrow(/resolved to/);
    expect(readFileSync(path.join(second, 'file.txt'), 'utf8')).toBe('second');
  });
});

describe('the Bash tool', () => {
  it('rejects a call without a command', async () => {
    const tool = createBashTool(builtinDeps());

    const validation = await tool.validateInput(raw({}), toolContext('Bash', {}));

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.missingField);
  });

  it('rejects an empty command', async () => {
    const tool = createBashTool(builtinDeps());

    const validation = await tool.validateInput(
      raw({ command: '' }),
      toolContext('Bash', { command: '' }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidCommand);
  });

  it('runs the command it is given', async () => {
    const root = makeDirectory();
    const tool = createBashTool(
      builtinDeps({ rules: ruleSet({ allow: ['Bash'], cwd: root }), cwd: root }),
    );
    const input = { command: 'printf hello' };
    const ctx = toolContext('Bash', input);

    const decision = await tool.checkPermissions(input, ctx);
    expect(decision?.behavior).toBe('allow');

    const validation = await tool.validateInput(input, ctx);
    expect(validation.ok).toBe(true);

    const output = await tool.execute(input, ctx);
    expect(output.stdout).toBe('hello');
    expect(output.exitCode).toBe(0);
  });

  it('rejects a timeout of zero', async () => {
    const tool = createBashTool(builtinDeps());
    const input = raw({ command: 'true', timeout: 0 });

    const validation = await tool.validateInput(input, toolContext('Bash', input));

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidInput);
    expect(validation.ok ? '' : validation.message).toContain('timeout');
  });

  it('bounds the timeout of a command', () => {
    expect(resolveBashTimeout(undefined)).toBe(DEFAULT_BASH_TIMEOUT_MS);
    expect(resolveBashTimeout(0)).toBe(DEFAULT_BASH_TIMEOUT_MS);
    expect(resolveBashTimeout(5_000)).toBe(5_000);
    expect(resolveBashTimeout(DEFAULT_BASH_TIMEOUT_MS)).toBe(DEFAULT_BASH_TIMEOUT_MS);
    expect(resolveBashTimeout(MAX_BASH_TIMEOUT_MS)).toBe(MAX_BASH_TIMEOUT_MS);
    expect(resolveBashTimeout(MAX_BASH_TIMEOUT_MS + 1)).toBe(MAX_BASH_TIMEOUT_MS);
    expect(resolveBashTimeout(10_000_000)).toBe(MAX_BASH_TIMEOUT_MS);
  });

  it('runs the command in the filtered environment of the session', async () => {
    const root = makeDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Bash'], cwd: root }),
        cwd: root,
        env: { ...process.env, PATH: '/usr/bin:/bin', PRRICHECK_ENV: 'from the session' },
      }),
    );
    const input = { command: 'printf "%s|%s" "$PATH" "$PRRICHECK_ENV"' };

    const output = await tool.execute(input, toolContext('Bash', input));

    // The session's environment is used **as far as the sandbox's allowlist
    // allows**: `PATH` is on the list and comes from the session, and a variable
    // that is not on it never reaches the command — the agent's credentials live
    // in exactly such a variable.
    expect(output.stdout).toBe('/usr/bin:/bin|');
  });

  it('does not let the sandbox flag past a deny rule', async () => {
    const root = makeDirectory();
    const tool = createBashTool(
      builtinDeps({
        rules: ruleSet({ deny: ['Bash(curl *)'], allow: ['Bash'], cwd: root }),
        cwd: root,
      }),
    );
    const input = { command: 'curl https://example.com', dangerouslyDisableSandbox: true };

    const decision = await tool.checkPermissions(input, toolContext('Bash', input));

    expect(decision?.behavior).toBe('deny');
    expect(decision?.reasonType).toBe('rule');
  });
});

describe('the Glob tool', () => {
  it('rejects a call without a pattern', async () => {
    const tool = createGlobTool(builtinDeps());

    const validation = await tool.validateInput(raw({}), toolContext('Glob', {}));

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.missingField);
  });

  it('finds the files that match the pattern', async () => {
    const root = makeDirectory();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
    writeFileSync(path.join(root, 'src', 'b.js'), 'b');
    writeFileSync(path.join(root, 'c.ts'), 'c');

    const tool = createGlobTool(
      builtinDeps({ rules: ruleSet({ allow: ['Glob'], cwd: root }), cwd: root }),
    );
    const input = { pattern: '**/*.ts' };
    const ctx = toolContext('Glob', input);

    const decision = await tool.checkPermissions(input, ctx);
    expect(decision?.behavior).toBe('allow');

    const validation = await tool.validateInput(input, ctx);
    expect(validation.ok).toBe(true);

    const output = await tool.execute(input, ctx);
    expect(output.files.sort()).toEqual(
      [path.join(root, 'c.ts'), path.join(root, 'src', 'a.ts')].sort(),
    );
  });

  it('caps the number of files it reports', async () => {
    const root = makeDirectory();
    for (let index = 0; index < MAX_GLOB_RESULTS + 1; index += 1) {
      writeFileSync(path.join(root, `file-${index}.txt`), 'x');
    }

    const tool = createGlobTool(
      builtinDeps({ rules: ruleSet({ allow: ['Glob'], cwd: root }), cwd: root }),
    );
    const input = { pattern: '*.txt' };

    const output = await tool.execute(input, toolContext('Glob', input));

    expect(output.files).toHaveLength(MAX_GLOB_RESULTS);
    expect(output.truncated).toBe(true);
  });
});

describe('the Grep tool', () => {
  it('rejects a pattern that is not a regular expression', async () => {
    const tool = createGrepTool(builtinDeps());

    const validation = await tool.validateInput(
      raw({ pattern: '([' }),
      toolContext('Grep', { pattern: '([' }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidInput);
  });

  it('reports the files that contain the pattern', async () => {
    const root = makeDirectory();
    writeFileSync(path.join(root, 'a.txt'), 'alpha\nbeta\n');
    writeFileSync(path.join(root, 'b.txt'), 'gamma\n');

    const tool = createGrepTool(
      builtinDeps({ rules: ruleSet({ allow: ['Grep'], cwd: root }), cwd: root }),
    );
    const input = { pattern: 'alpha' };
    const ctx = toolContext('Grep', input);

    const decision = await tool.checkPermissions(input, ctx);
    expect(decision?.behavior).toBe('allow');

    const validation = await tool.validateInput(input, ctx);
    expect(validation.ok).toBe(true);

    const output = await tool.execute(input, ctx);
    expect(output.files).toEqual([path.join(root, 'a.txt')]);
  });

  it('reports the matches of a search in content mode', async () => {
    const root = makeDirectory();
    writeFileSync(path.join(root, 'a.txt'), 'alpha\nbeta\n');

    const tool = createGrepTool(
      builtinDeps({ rules: ruleSet({ allow: ['Grep'], cwd: root }), cwd: root }),
    );
    const input = { pattern: 'alpha', output_mode: 'content' as const };

    const output = await tool.execute(input, toolContext('Grep', input));

    expect(output.matches).toEqual([
      { file: path.join(root, 'a.txt'), line: 1, text: 'alpha' },
    ]);
    expect(output.text).toContain('alpha');
  });

  it('counts the matches of a search in count mode', async () => {
    const root = makeDirectory();
    writeFileSync(path.join(root, 'a.txt'), 'alpha\nalpha\nbeta\n');

    const tool = createGrepTool(
      builtinDeps({ rules: ruleSet({ allow: ['Grep'], cwd: root }), cwd: root }),
    );
    const input = { pattern: 'alpha', output_mode: 'count' as const };

    const output = await tool.execute(input, toolContext('Grep', input));

    expect(output.counts).toEqual({ [path.join(root, 'a.txt')]: 2 });
    expect(output.text).toContain('2');
  });

  it('reports only the files the glob filter matches', async () => {
    const root = makeDirectory();
    writeFileSync(path.join(root, 'a.txt'), 'alpha\n');
    writeFileSync(path.join(root, 'b.md'), 'alpha\n');

    const tool = createGrepTool(
      builtinDeps({ rules: ruleSet({ allow: ['Grep'], cwd: root }), cwd: root }),
    );
    const input = { pattern: 'alpha', glob: '*.txt' };

    const output = await tool.execute(input, toolContext('Grep', input));

    expect(output.files).toEqual([path.join(root, 'a.txt')]);
  });

  it('stops after the bound of files it has examined', async () => {
    const root = makeDirectory();
    for (let index = 0; index < MAX_GREP_FILES + 1; index += 1) {
      writeFileSync(path.join(root, `file-${index}.txt`), 'nothing to see here\n');
    }

    const tool = createGrepTool(
      builtinDeps({ rules: ruleSet({ allow: ['Grep'], cwd: root }), cwd: root }),
    );
    const input = { pattern: 'needle' };

    const output = await tool.execute(input, toolContext('Grep', input));

    // No file matches, so the bound cannot be reached by the number of matches:
    // it is the number of files **examined** that is bounded.
    expect(output.files).toEqual([]);
    expect(output.truncated).toBe(true);
  });
});

describe('the WebFetch tool', () => {
  it('rejects a url that is not a url', async () => {
    const tool = createWebFetchTool(builtinDeps());

    const validation = await tool.validateInput(
      raw({ url: 'not a url' }),
      toolContext('WebFetch', { url: 'not a url' }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidUrl);
  });

  it('rejects a url that is not an http(s) url', async () => {
    const tool = createWebFetchTool(builtinDeps());

    const validation = await tool.validateInput(
      raw({ url: 'file:///etc/passwd' }),
      toolContext('WebFetch', { url: 'file:///etc/passwd' }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidUrl);
  });

  it('fetches the url it is given', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('the body');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const url = `http://127.0.0.1:${address.port}/page`;

    const tool = createWebFetchTool(
      builtinDeps({ rules: ruleSet({ allow: ['WebFetch'] }) }),
    );
    const input = { url };
    const ctx = toolContext('WebFetch', input);

    const decision = await tool.checkPermissions(input, ctx);
    expect(decision?.behavior).toBe('allow');

    const validation = await tool.validateInput(input, ctx);
    expect(validation.ok).toBe(true);

    const output = await tool.execute(input, ctx);
    expect(output.text).toBe('the body');
    expect(output.status).toBe(200);
  });

  it('refuses a fetch whose arguments cannot be verified, without calling it a user denial', async () => {
    const tool = createWebFetchTool(builtinDeps({ rules: ruleSet({ allow: ['WebFetch'] }) }));
    const input = { url: 'not a url' };
    const ctx = toolContext('WebFetch', input);

    const decision = await tool.checkPermissions(input, ctx);

    expect(decision?.behavior).toBe('deny');
    expect(decision?.reasonType).toBe('safetyCheck');
    expect(decision?.source).not.toBe('user_reject');
    expect(decision?.source).not.toBe('user_abort');
    expect(decision?.reason).toMatch(/nothing was fetched/);
  });

  it('stops reading the body at the byte cap', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'a');
    let stopped = false;
    const server = createServer((_request, response) => {
      response.on('error', () => {
        // The client stops reading at the cap: the rest of the body is refused.
      });
      response.on('close', () => {
        stopped = true;
      });
      response.writeHead(200, { 'content-type': 'text/plain' });
      // The body never ends: only the cap can stop the reading.
      const timer = setInterval(() => {
        if (stopped) {
          clearInterval(timer);
          return;
        }
        response.write(chunk);
      }, 1);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const url = `http://127.0.0.1:${address.port}/endless`;

    const tool = createWebFetchTool(
      builtinDeps({ rules: ruleSet({ allow: ['WebFetch'] }) }),
      { timeoutMs: 5_000 },
    );
    const input = { url };

    const output = await tool.execute(input, toolContext('WebFetch', input));

    // The reading stopped at the cap: the body was never buffered in full.
    expect(output.truncated).toBe(true);
    expect(output.text.length).toBe(MAX_WEBFETCH_BYTES);
  });

  it('gives up on a fetch that runs past its timeout', async () => {
    const server = createServer(() => {
      // The response is never sent: the fetch runs until its timeout.
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const url = `http://127.0.0.1:${address.port}/slow`;

    const tool = createWebFetchTool(
      builtinDeps({ rules: ruleSet({ allow: ['WebFetch'] }) }),
      { timeoutMs: 50 },
    );
    const input = { url };

    await expect(tool.execute(input, toolContext('WebFetch', input))).rejects.toThrow();
  });
});

describe('the TodoWrite tool', () => {
  it('rejects a list that is not an array', async () => {
    const tool = createTodoWriteTool(builtinDeps());

    const validation = await tool.validateInput(
      raw({ todos: 'nope' }),
      toolContext('TodoWrite', { todos: 'nope' }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidInput);
  });

  it('rejects an item with an unknown status', async () => {
    const tool = createTodoWriteTool(builtinDeps());
    const input = raw({ todos: [{ content: 'a', status: 'later', activeForm: 'doing a' }] });

    const validation = await tool.validateInput(input, toolContext('TodoWrite', input));

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidInput);
  });

  it('records the list it is given', async () => {
    const tool = createTodoWriteTool(
      builtinDeps({ rules: ruleSet({ allow: ['TodoWrite'] }) }),
    );
    const input: TodoWriteInput = {
      todos: [{ content: 'write the tool', status: 'in_progress', activeForm: 'writing the tool' }],
    };
    const ctx = toolContext('TodoWrite', input);

    const decision = await tool.checkPermissions(input, ctx);
    expect(decision?.behavior).toBe('allow');

    const validation = await tool.validateInput(input, ctx);
    expect(validation.ok).toBe(true);

    const output = await tool.execute(input, ctx);
    expect(output.todos).toHaveLength(1);
    expect(output.todos[0]?.content).toBe('write the tool');
  });

  it('accepts a list with two items in progress', async () => {
    const tool = createTodoWriteTool(builtinDeps());
    const input = raw({
      todos: [
        { content: 'a', status: 'in_progress', activeForm: 'doing a' },
        { content: 'b', status: 'in_progress', activeForm: 'doing b' },
      ],
    });

    const validation = await tool.validateInput(input, toolContext('TodoWrite', input));

    expect(validation.ok).toBe(true);
  });

  it('rejects an item with a field the schema does not declare', async () => {
    const tool = createTodoWriteTool(builtinDeps());
    const input = raw({
      todos: [{ content: 'a', status: 'pending', activeForm: 'doing a', extra: 'no' }],
    });

    const validation = await tool.validateInput(input, toolContext('TodoWrite', input));

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidInput);
    expect(validation.ok ? '' : validation.message).toContain('extra');
  });
});

describe('the NotebookEdit tool', () => {
  it('rejects a call without a cell id', async () => {
    const tool = createNotebookEditTool(builtinDeps());

    const validation = await tool.validateInput(
      raw({ notebook_path: '/work/a.ipynb', new_source: 'x' }),
      toolContext('NotebookEdit', { notebook_path: '/work/a.ipynb', new_source: 'x' }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.missingField);
  });

  it('replaces the source of the cell it was given', async () => {
    const root = makeDirectory();
    const notebook = path.join(root, 'a.ipynb');
    writeFileSync(
      notebook,
      JSON.stringify({
        cells: [{ id: 'cell-1', cell_type: 'code', source: ['old\n', 'lines\n'] }],
      }),
    );

    const tool = createNotebookEditTool(
      builtinDeps({ rules: ruleSet({ allow: ['NotebookEdit'], cwd: root }), cwd: root }),
    );
    const input = { notebook_path: notebook, cell_id: 'cell-1', new_source: 'new\nsource' };
    const ctx = toolContext('NotebookEdit', input);

    const decision = await tool.checkPermissions(input, ctx);
    expect(decision?.behavior).toBe('allow');

    const validation = await tool.validateInput(input, ctx);
    expect(validation.ok).toBe(true);

    await tool.execute(input, ctx);

    const written = JSON.parse(readFileSync(notebook, 'utf8')) as {
      cells: { id: string; source: string | string[] }[];
    };
    expect(written.cells[0]?.source).toEqual(['new\n', 'source']);
  });

  it('refuses a cell the notebook does not have', async () => {
    const root = makeDirectory();
    const notebook = path.join(root, 'a.ipynb');
    writeFileSync(notebook, JSON.stringify({ cells: [{ id: 'cell-1', source: 'x' }] }));

    const tool = createNotebookEditTool(
      builtinDeps({ rules: ruleSet({ allow: ['NotebookEdit'], cwd: root }), cwd: root }),
    );
    const input = { notebook_path: notebook, cell_id: 'cell-9', new_source: 'new' };

    await expect(tool.execute(input, toolContext('NotebookEdit', input))).rejects.toThrow(
      /has no cell/,
    );
  });

  it('deletes the cell it was given when the mode is delete', async () => {
    const root = makeDirectory();
    const notebook = path.join(root, 'a.ipynb');
    writeFileSync(
      notebook,
      JSON.stringify({
        cells: [
          { id: 'c1', cell_type: 'code', source: 'x' },
          { id: 'c2', cell_type: 'code', source: 'y' },
        ],
      }),
    );

    const tool = createNotebookEditTool(
      builtinDeps({ rules: ruleSet({ allow: ['NotebookEdit'], cwd: root }), cwd: root }),
    );
    const input = {
      notebook_path: notebook,
      cell_id: 'c1',
      new_source: '',
      edit_mode: 'delete' as const,
    };

    await tool.execute(input, toolContext('NotebookEdit', input));

    const written = JSON.parse(readFileSync(notebook, 'utf8')) as {
      cells: { id: string; source: string | string[] }[];
    };
    expect(written.cells).toHaveLength(1);
    expect(written.cells[0]?.id).toBe('c2');
  });

  it('inserts a cell after the cell it was given when the mode is insert', async () => {
    const root = makeDirectory();
    const notebook = path.join(root, 'a.ipynb');
    writeFileSync(
      notebook,
      JSON.stringify({
        cells: [
          { id: 'c1', cell_type: 'code', source: 'x' },
          { id: 'c2', cell_type: 'code', source: 'y' },
        ],
      }),
    );

    const tool = createNotebookEditTool(
      builtinDeps({ rules: ruleSet({ allow: ['NotebookEdit'], cwd: root }), cwd: root }),
    );
    const input = {
      notebook_path: notebook,
      cell_id: 'c1',
      new_source: 'inserted\n',
      edit_mode: 'insert' as const,
    };

    await tool.execute(input, toolContext('NotebookEdit', input));

    const written = JSON.parse(readFileSync(notebook, 'utf8')) as {
      cells: { id: string; cell_type?: string; source: string | string[] }[];
    };
    expect(written.cells).toHaveLength(3);
    expect(written.cells[0]?.id).toBe('c1');
    expect(written.cells[1]?.source).toBe('inserted\n');
    expect(written.cells[1]?.cell_type).toBe('code');
    expect(written.cells[2]?.id).toBe('c2');
  });

  it('rejects an edit mode the tool does not implement', async () => {
    const tool = createNotebookEditTool(builtinDeps());
    const input = raw({
      notebook_path: '/work/a.ipynb',
      cell_id: 'c1',
      new_source: 'x',
      edit_mode: 'append',
    });

    const validation = await tool.validateInput(input, toolContext('NotebookEdit', input));

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.invalidInput);
  });

  it('re-resolves the path of the notebook before the edit', async () => {
    const root = makeDirectory();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, 'a.ipynb'), JSON.stringify({ cells: [] }));
    writeFileSync(path.join(second, 'a.ipynb'), JSON.stringify({ cells: [] }));
    const link = path.join(root, 'link');
    symlinkSync(first, link);

    const tool = createNotebookEditTool(
      builtinDeps({ rules: ruleSet({ allow: ['NotebookEdit'], cwd: root }), cwd: root }),
    );
    const input = {
      notebook_path: path.join(link, 'a.ipynb'),
      cell_id: 'c1',
      new_source: 'x',
    };
    const ctx = toolContext('NotebookEdit', input);

    await tool.checkPermissions(input, ctx);

    // The symlink is swapped **after** the check and before the edit.
    unlinkSync(link);
    symlinkSync(second, link);

    await expect(tool.execute(input, ctx)).rejects.toThrow(/resolved to/);
    expect(readFileSync(path.join(second, 'a.ipynb'), 'utf8')).toBe(
      JSON.stringify({ cells: [] }),
    );
  });
});

describe('the Task tool', () => {
  it('rejects a call without a prompt', async () => {
    const tool = createTaskTool(builtinDeps());

    const validation = await tool.validateInput(
      raw({ description: 'do the thing' }),
      toolContext('Task', { description: 'do the thing' }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.ok ? '' : validation.errorCode).toBe(TOOL_ERROR_CODES.missingField);
  });

  it('delegates the work to the runner the session supplies', async () => {
    const seen: unknown[] = [];
    const tool = createTaskTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Task'] }),
        delegate: async (input) => {
          seen.push(input);
          return 'the sub-agent finished';
        },
      }),
    );
    const input = { description: 'do the thing', prompt: 'do the thing' };
    const ctx = toolContext('Task', input);

    const decision = await tool.checkPermissions(input, ctx);
    expect(decision?.behavior).toBe('allow');

    const output = await tool.execute(input, ctx);
    expect(output.text).toBe('the sub-agent finished');
    expect(seen).toHaveLength(1);
  });

  it('hands the kind of sub-agent to the delegate', async () => {
    const seen: unknown[] = [];
    const tool = createTaskTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Task'] }),
        delegate: async (input) => {
          seen.push(input);
          return 'done';
        },
      }),
    );
    const input = {
      description: 'do the thing',
      prompt: 'do the thing',
      subagent_type: 'explore',
    };

    await tool.execute(input, toolContext('Task', input));

    expect(seen).toEqual([input]);
    expect((seen[0] as { subagent_type?: string }).subagent_type).toBe('explore');
  });

  it('reports a typed failure when no task runner is available', async () => {
    const tool = createTaskTool(builtinDeps({ rules: ruleSet({ allow: ['Task'] }) }));
    const input = { description: 'do the thing', prompt: 'do the thing' };

    await expect(tool.execute(input, toolContext('Task', input))).rejects.toMatchObject({
      errorCode: TOOL_ERROR_CODES.taskUnavailable,
    });
  });
});

// --- the file-mutating tools, end to end ------------------------------------------

describe('a malformed call to a file-mutating tool', () => {
  /**
   * A malformed call, run through the runner.
   *
   * The runner's order is **check → validate → execute**, so the check runs on an
   * input the validator has not seen yet: the check must not crash on it, and the
   * model must see the **validator's** typed error rather than an internal
   * `TypeError`.
   */
  const cases: {
    name: string;
    input: unknown;
    field: string;
    errorCode: number;
  }[] = [
    {
      name: 'Write',
      input: { file_path: 42, content: 'x' },
      field: 'file_path',
      errorCode: TOOL_ERROR_CODES.invalidPath,
    },
    {
      name: 'Write',
      input: { content: 'x' },
      field: 'file_path',
      errorCode: TOOL_ERROR_CODES.missingField,
    },
    {
      name: 'Edit',
      input: { file_path: 42, old_string: 'a', new_string: 'b' },
      field: 'file_path',
      errorCode: TOOL_ERROR_CODES.invalidPath,
    },
    {
      name: 'Edit',
      input: { file_path: '/work/a.txt', old_string: 'a' },
      field: 'new_string',
      errorCode: TOOL_ERROR_CODES.missingField,
    },
    {
      name: 'NotebookEdit',
      input: { notebook_path: 42, cell_id: 'c1', new_source: 'x' },
      field: 'notebook_path',
      errorCode: TOOL_ERROR_CODES.invalidPath,
    },
    {
      name: 'NotebookEdit',
      input: { notebook_path: '/work/a.ipynb', new_source: 'x' },
      field: 'cell_id',
      errorCode: TOOL_ERROR_CODES.missingField,
    },
  ];

  for (const testCase of cases) {
    it(`reports the typed error of a malformed ${testCase.name} call`, async () => {
      const root = makeDirectory();
      const registry = createToolRegistry();
      registerBuiltinTools(
        registry,
        builtinDeps({
          rules: ruleSet({ allow: ['Write', 'Edit', 'NotebookEdit'], cwd: root }),
          cwd: root,
        }),
      );

      const envelope = await runTool(
        registry,
        testCase.name,
        testCase.input,
        toolContext(testCase.name, testCase.input),
        { cwd: root },
      );

      expect(envelope.isError).toBe(true);
      expect(envelope.nonExecutionKind).toBe('validation_error');
      const content = envelope.content as { errorCode: number; message: string };
      expect(content.errorCode).toBe(testCase.errorCode);
      expect(content.message).toContain(testCase.field);
      expect(content.message).not.toMatch(/TypeError|Cannot read properties/);
    });
  }
});

// --- the built-in tools and the rule engine ---------------------------------------

describe('the built-in tools and the rule engine', () => {
  it('consults the rules instead of hard-coding an allow', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'secret.txt');
    writeFileSync(file, 'x');

    const denied = createReadTool(
      builtinDeps({ rules: ruleSet({ deny: ['Read(secret.txt)'], cwd: root }), cwd: root }),
    );
    const input = { file_path: file };
    const decision = await denied.checkPermissions(input, toolContext('Read', input));

    expect(decision?.behavior).toBe('deny');
    expect(decision?.reasonType).toBe('rule');
  });

  it('never rewrites the input itself — only a hook may', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'x');

    const tool = createWriteTool(
      builtinDeps({ rules: ruleSet({ allow: ['Write'], cwd: root }), cwd: root }),
    );
    const input = { file_path: file, content: 'x' };
    const decision = await tool.checkPermissions(input, toolContext('Write', input));

    // The tool rewrote nothing: the decision carries no rewritten input, and the
    // input the call carries is untouched.
    expect(decision?.updatedInput).toBeUndefined();
    expect(input).toEqual({ file_path: file, content: 'x' });

    // The contrast: a **hook** that rewrites the input does carry one, so the
    // assertion above is about the tool and not about the shape of the decision.
    const hooked = createWriteTool(
      builtinDeps({
        rules: ruleSet({ allow: ['Write'], cwd: root }),
        cwd: root,
        hook: () => ({
          behavior: 'allow',
          source: 'hook',
          reasonType: 'other',
          updatedInput: { file_path: path.join(root, 'b.txt'), content: 'x' },
        }),
      }),
    );
    const hookedDecision = await hooked.checkPermissions(input, toolContext('Write', input));

    expect(hookedDecision?.updatedInput).toEqual({
      file_path: path.join(root, 'b.txt'),
      content: 'x',
    });
  });

  it('shows the resolved destination in the approval prompt, not the literal path', async () => {
    const root = makeDirectory();
    const real = path.join(root, 'real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'a.txt'), 'x');
    const link = path.join(root, 'link');
    symlinkSync(real, link);

    let prompt = '';
    const tool = createWriteTool(
      builtinDeps({
        rules: ruleSet({ ask: ['Write'], cwd: root }),
        cwd: root,
        canUseTool: async (ctx, decision) => {
          prompt = buildApprovalPrompt({
            toolName: ctx.toolName,
            input: ctx.input,
            decision,
            cwd: root,
          });
          return {
            behavior: 'deny',
            source: 'user_reject',
            reasonType: 'other',
            reason: 'The user rejected the call.',
          };
        },
      }),
    );
    const input = { file_path: path.join(link, 'a.txt'), content: 'x' };
    const ctx = toolContext('Write', input);

    await tool.checkPermissions(input, ctx);

    expect(prompt).toContain(path.join(real, 'a.txt'));
  });

  it('matches a Bash rule against the command text, not the program identity', async () => {
    const root = makeDirectory();
    const denied = createBashTool(
      builtinDeps({ rules: ruleSet({ deny: ['Bash(curl *)'], cwd: root }), cwd: root }),
    );
    const input = { command: 'curl https://example.com' };
    const decision = await denied.checkPermissions(input, toolContext('Bash', input));

    expect(decision?.behavior).toBe('deny');

    // The rule engine matches command **text**. A rule written for a program name
    // is not a boundary around the program: the target's own documentation says so,
    // and this implementation does not claim a stronger guarantee than the engine gives.
    const allowed = createBashTool(
      builtinDeps({ rules: ruleSet({ deny: ['Bash(curl *)'], cwd: root }), cwd: root }),
    );
    const other = await allowed.checkPermissions(
      { command: '/usr/bin/curl https://example.com' },
      toolContext('Bash', { command: '/usr/bin/curl https://example.com' }),
    );

    expect(other?.behavior).not.toBe('deny');
  });

  it('applies a Read deny rule to the files a search reaches through a symlinked search path', async () => {
    const root = makeDirectory();
    const real = path.join(root, 'real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'secret.txt'), 'the secret');
    writeFileSync(path.join(real, 'other.txt'), 'the other');
    const link = path.join(root, 'link');
    symlinkSync(real, link);

    const rules = ruleSet({ allow: ['Glob', 'Grep'], deny: ['Read(real/secret.txt)'], cwd: root });

    const glob = createGlobTool(builtinDeps({ rules, cwd: root }));
    const globOutput = await glob.execute(
      { pattern: '*.txt', path: link },
      toolContext('Glob', { pattern: '*.txt', path: link }),
    );
    expect(globOutput.files).toEqual([path.join(link, 'other.txt')]);

    const grep = createGrepTool(builtinDeps({ rules, cwd: root }));
    const grepOutput = await grep.execute(
      { pattern: 'the', path: link },
      toolContext('Grep', { pattern: 'the', path: link }),
    );
    expect(grepOutput.files).toEqual([path.join(link, 'other.txt')]);
  });

  it('applies an Edit deny rule to a file reached through a symlinked path', async () => {
    const root = makeDirectory();
    const real = path.join(root, 'real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'secret.txt'), 'the secret');
    const link = path.join(root, 'link');
    symlinkSync(real, link);

    const tool = createEditTool(
      builtinDeps({
        rules: ruleSet({ deny: ['Edit(real/secret.txt)'], cwd: root }),
        cwd: root,
      }),
    );
    const input = { file_path: path.join(link, 'secret.txt'), old_string: 'the', new_string: 'a' };

    const decision = await tool.checkPermissions(input, toolContext('Edit', input));

    expect(decision?.behavior).toBe('deny');
    expect(decision?.reasonType).toBe('rule');
  });

  it('reports the files of a search that no deny rule blocks', async () => {
    const root = makeDirectory();
    const real = path.join(root, 'real');
    mkdirSync(real);
    writeFileSync(path.join(real, 'secret.txt'), 'the secret');
    const link = path.join(root, 'link');
    symlinkSync(real, link);

    const glob = createGlobTool(
      builtinDeps({ rules: ruleSet({ allow: ['Glob'], cwd: root }), cwd: root }),
    );
    const output = await glob.execute(
      { pattern: '*.txt', path: link },
      toolContext('Glob', { pattern: '*.txt', path: link }),
    );

    expect(output.files).toEqual([path.join(link, 'secret.txt')]);
  });
});

describe('a tool call through the registry', () => {
  it('runs a built-in tool end to end and reports the decision on the envelope', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'note.txt');
    writeFileSync(file, 'hello\n');

    const registry: ToolRegistry = createToolRegistry();
    registerBuiltinTools(registry, builtinDeps({ rules: ruleSet({ allow: ['Read'], cwd: root }), cwd: root }));

    const input = { file_path: file };
    const envelope: ToolResultEnvelope = await runTool(
      registry,
      'Read',
      input,
      toolContext('Read', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(false);
    expect(envelope.toolUseId).toBe('toolu_01');
    expect(envelope.permissionDecision?.decision).toBe('allow');
    expect((envelope.content as { text: string }).text).toBe('hello\n');
  });

  it('denies a built-in tool call a deny rule covers, without running it', async () => {
    const root = makeDirectory();
    const file = path.join(root, 'secret.txt');
    writeFileSync(file, 'x');

    const registry = createToolRegistry();
    registerBuiltinTools(registry, builtinDeps({ rules: ruleSet({ deny: ['Read'], cwd: root }), cwd: root }));

    const input = { file_path: file };
    const envelope = await runTool(
      registry,
      'Read',
      input,
      toolContext('Read', input),
      { cwd: root },
    );

    expect(envelope.isError).toBe(true);
    expect(envelope.permissionDecision?.decision).toBe('deny');
    expect(envelope.nonExecutionKind).toBe('permission_denied');
  });
});

/**
 * A compile-time pin on the permission decision's `updatedInput`.
 *
 * The rule engine's decision type carries `updatedInput?: never`, so a **rule** can
 * never rewrite the input: only the hook path uses the member. The pin is a
 * `@ts-expect-error`, so it bites under `tsc --noEmit` — a runtime assertion cannot
 * stand in for it, because it would pass whatever the runtime did.
 */
function ruleDecisionMayNotCarryARewrittenInput(): void {
  const decision: RuleDecision = {
    behavior: 'allow',
    source: 'unknown',
    reasonType: 'other',
    // @ts-expect-error — a rule decision cannot carry a rewritten tool input.
    updatedInput: { file_path: '/work/rewritten.txt' },
  };
  void decision;
}

describe('the permission decision the tools carry', () => {
  it('keeps the rewritten input out of a rule decision', () => {
    const decision = evaluateRules(
      ruleSet({ deny: ['Read(a.txt)'] }),
      {
        toolName: 'Read',
        input: { file_path: '/work/a.txt' },
        toolUseId: '',
        sessionId: '',
      },
    );

    expect(decision?.behavior).toBe('deny');
    expect(decision?.updatedInput).toBeUndefined();

    // The compile-time pin is exercised here, so that it is not dead code.
    ruleDecisionMayNotCarryARewrittenInput();
  });

  it('carries a hook rewrite in the decision it returns', async () => {
    const rewritten: PermissionDecision = {
      behavior: 'allow',
      source: 'hook',
      reasonType: 'other',
      updatedInput: { file_path: '/work/rewritten.txt' },
    };

    expect(rewritten.updatedInput).toEqual({ file_path: '/work/rewritten.txt' });
  });
});

/* -------------------------------------------------------------------------- */
/* The concurrency-safety flag                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The concurrency-safety flag.
 *
 * The target's scheduler is **per tool**: every tool declares whether it is
 * concurrency safe, the safe calls of one assistant message run together, and
 * a call that is not concurrency safe runs alone and is a barrier. **A tool
 * that does not declare the flag is not concurrency safe** — the target's own
 * default, and the `catch` around the flag's read.
 */
describe('the concurrency-safety flag', () => {
  it('is not declared by a tool that does not declare it', () => {
    const tool = stubTool({ name: 'Silent' });

    expect(tool.isConcurrencySafe).toBeUndefined();
    expect(isToolConcurrencySafe(tool, {})).toBe(false);
  });

  it('is not declared for a tool the registry does not hold', () => {
    expect(isToolConcurrencySafe(undefined, {})).toBe(false);
  });

  it('is false for a flag that throws', () => {
    const tool = stubTool({
      name: 'Broken',
      isConcurrencySafe() {
        throw new Error('the flag could not be read');
      },
    });

    expect(isToolConcurrencySafe(tool, {})).toBe(false);
  });

  it('is read per call, from the tool that was called', () => {
    const tool = stubTool({
      name: 'Picky',
      isConcurrencySafe(input: unknown) {
        return (input as { safe?: boolean }).safe === true;
      },
    });

    expect(isToolConcurrencySafe(tool, { safe: true })).toBe(true);
    expect(isToolConcurrencySafe(tool, { safe: false })).toBe(false);
  });

  it('is declared by the read-only built-in tools', () => {
    const tools = createBuiltinTools(builtinDeps());
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of ['Glob', 'Grep', 'Read', 'WebFetch']) {
      expect([name, isToolConcurrencySafe(byName.get(name), {})]).toEqual([name, true]);
    }
  });

  it('is not declared by the built-in tools that mutate or delegate', () => {
    const tools = createBuiltinTools(builtinDeps());
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    // `NotebookEdit` is this implementation's notebook tool, and it **mutates**
    // a file: the target's notebook **read** tool is the concurrency-safe one.
    for (const name of ['Edit', 'Write', 'NotebookEdit', 'Task', 'TodoWrite']) {
      expect([name, isToolConcurrencySafe(byName.get(name), {})]).toEqual([name, false]);
    }
  });

  it('is declared by the Bash tool only for a read-only command', () => {
    const tool = createBashTool(builtinDeps());

    expect(isToolConcurrencySafe(tool, { command: 'ls' })).toBe(true);
    expect(isToolConcurrencySafe(tool, { command: 'cat file' })).toBe(true);
    expect(isToolConcurrencySafe(tool, { command: 'rm -rf /' })).toBe(false);
    expect(isToolConcurrencySafe(tool, { command: 'echo hello > out.txt' })).toBe(false);
    // A command the tool cannot read is not read-only.
    expect(isToolConcurrencySafe(tool, { command: 42 })).toBe(false);
  });
});
