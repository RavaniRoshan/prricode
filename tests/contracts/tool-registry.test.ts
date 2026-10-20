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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FILE_MUTATING_TOOLS,
  TOOL_ERROR_CODES,
  ToolExecutionError,
  createToolRegistry,
  type ToolDefinition,
  type ToolRegistry,
} from '../../src/tools/registry.js';
import { runTool, type ToolResultEnvelope } from '../../src/tools/runner.js';
import {
  BUILTIN_TOOL_NAMES,
  createBuiltinTools,
  registerBuiltinTools,
} from '../../src/tools/builtins/index.js';
import { createBashTool } from '../../src/tools/builtins/bash.js';
import { createEditTool } from '../../src/tools/builtins/edit.js';
import { createGlobTool } from '../../src/tools/builtins/glob.js';
import { createGrepTool } from '../../src/tools/builtins/grep.js';
import { createNotebookEditTool } from '../../src/tools/builtins/notebookedit.js';
import { createReadTool } from '../../src/tools/builtins/read.js';
import { createTaskTool } from '../../src/tools/builtins/task.js';
import { createTodoWriteTool } from '../../src/tools/builtins/todowrite.js';
import type { TodoWriteInput } from '../../src/tools/builtins/todowrite.js';
import { createWebFetchTool } from '../../src/tools/builtins/webfetch.js';
import { createWriteTool } from '../../src/tools/builtins/write.js';
import type { BuiltinToolDeps } from '../../src/tools/builtins/shared.js';
import { buildApprovalPrompt } from '../../src/permissions/prompts.js';
import { FILE_MUTATING_TOOL_NAMES, type RuleSet } from '../../src/permissions/rules.js';
import type { PermissionDecision, ToolContext } from '../../src/permissions/decision.js';

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

  it('reports a typed failure when no task runner is available', async () => {
    const tool = createTaskTool(builtinDeps({ rules: ruleSet({ allow: ['Task'] }) }));
    const input = { description: 'do the thing', prompt: 'do the thing' };

    await expect(tool.execute(input, toolContext('Task', input))).rejects.toMatchObject({
      errorCode: TOOL_ERROR_CODES.taskUnavailable,
    });
  });
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

    const tool = createReadTool(
      builtinDeps({ rules: ruleSet({ allow: ['Read'], cwd: root }), cwd: root }),
    );
    const input = { file_path: file };
    const decision = await tool.checkPermissions(input, toolContext('Read', input));

    expect(decision?.updatedInput).toBeUndefined();
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
 * never rewrite the input: only the hook path uses the member.
 */
type RuleDecision = NonNullable<ReturnType<typeof import('../../src/permissions/decision.js').evaluateRules>>;
type RuleDecisionInput = RuleDecision extends { updatedInput?: infer T } ? T : 'absent';
type RulesNeverRewriteInput = [unknown] extends [RuleDecisionInput] ? true : false;
type AssertFalse<T extends boolean> = [T] extends [true] ? never : false;
const RULES_NEVER_REWRITE_INPUT: AssertFalse<RulesNeverRewriteInput> = false;

describe('the permission decision the tools carry', () => {
  it('keeps the rewritten input out of a rule decision', () => {
    expect(RULES_NEVER_REWRITE_INPUT).toBe(false);
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
