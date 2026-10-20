/**
 * The shared seams of the built-in tools: the dependencies they are built with, the
 * permission check they all run, the input validation helpers, and the path
 * bookkeeping the file tools need.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "Tool
 * contract") and the `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **Every built-in tool consults the rule engine.** A tool's `checkPermissions` runs
 * `checkPermission` with the session's rules and mode, so a deny rule blocks the
 * call in **every** mode and an allow rule approves it where the mode allows that.
 * No built-in tool hard-codes an allow: a tool that always allowed would make the
 * rule engine advisory.
 *
 * **The safety check runs before the rule engine.** `checkPermission` runs the
 * safety check first, and it holds in every mode — including `bypassPermissions`.
 * The tool's own `safetyCheckForTool` refuses arguments the tool cannot verify.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The dependencies are a **factory argument** rather than a field on the tool
 *     context: the permission module's `ToolContext` is a fixed four-member shape,
 *     and the rules, the mode and the prompt are session state, not per-call state.
 *   - The **environment** a shell command runs in is a dependency as well: the
 *     process environment by default, and the session's own environment when the
 *     session supplies one.
 *   - The file tools keep their path snapshot **per tool instance**, keyed by the
 *     tool-use id, exactly as the audit describes the file-write tool ("stash the
 *     permission decision keyed by `toolUseId`"). The snapshot is of the path the
 *     call will act on — the rewritten path when a hook rewrote the input — and it
 *     is what the write path re-resolves against, so a symlink swapped between the
 *     check and the write is refused.
 *   - A malformed path is a **validation** failure and not a permission refusal:
 *     the file tools' safety check steps aside for it, so the model sees the
 *     validator's typed code (`7` for an invalid path, `3` for a missing field)
 *     rather than a refusal it cannot act on.
 *   - The **output shape** of a tool — `{ type: 'text', … }` — is a implementation choice.
 *     The audit pins the tool-result *metadata*, not the content a tool returns.
 */

import path from 'node:path';

import { readdir, stat } from 'node:fs/promises';

import {
  checkPermission,
  describeReason,
  evaluateRules,
  type AutoModeVerdict,
  type PermissionDecision,
  type PermissionMode,
  type ToolContext,
} from '../../permissions/decision.js';
import { safetyCheckForTool } from '../../permissions/prompts.js';
import { reResolvePath, resolvePathTargets, type PathTargets } from '../../permissions/paths.js';
import { evaluateRuleList, type RuleSet } from '../../permissions/rules.js';

import { TOOL_ERROR_CODES } from '../registry.js';

/** The dependencies every built-in tool is built with. */
export interface BuiltinToolDeps {
  /** The rule lists the permission check consults. */
  rules: RuleSet;
  /** The active permission mode. */
  mode: PermissionMode;
  /** The working directory the path rules and the tools resolve against. */
  cwd?: string;
  /** Extra directories `acceptEdits` may write inside. */
  additionalDirs?: string[];
  /**
   * The environment a shell command runs in.
   *
   * The process environment by default: the session's own environment is what a
   * command inherits, and a session that wants a different one supplies it here.
   */
  env?: NodeJS.ProcessEnv;
  /** The prompt. Consulted for a decision that would prompt. */
  canUseTool?: (
    ctx: ToolContext,
    decision: PermissionDecision,
  ) => Promise<PermissionDecision | undefined>;
  /** The `PermissionRequest` hook. It may rewrite the tool input. */
  hook?: (
    ctx: ToolContext,
  ) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>;
  /** The safety check. The tool's own check runs when this one does not. */
  safetyCheck?: (ctx: ToolContext) => PermissionDecision | undefined;
  /** The auto-mode classifier. */
  classifier?: (ctx: ToolContext) => Promise<AutoModeVerdict | undefined>;
  /** The delegate the `Task` tool runs a sub-agent through. */
  delegate?: (input: unknown, ctx: ToolContext) => Promise<string>;
}

/** The result of a tool's own input validation. */
export type ToolValidation =
  | { ok: true }
  | { ok: false; message: string; errorCode: number };

/**
 * The permission check every built-in tool runs.
 *
 * The decision is the session's: the rules, the mode, the prompt, the hook, the
 * safety check and the classifier all come from the session, and the tool only
 * names itself.
 */
export async function checkToolPermissions(
  ctx: ToolContext,
  deps: BuiltinToolDeps,
  options: {
    /**
     * The tool's own safety check, used when the session supplies none.
     *
     * The file tools supply one that steps aside for a malformed path, because a
     * malformed path is a **validation** failure and not a permission refusal.
     */
    safetyCheck?: (ctx: ToolContext) => PermissionDecision | undefined;
  } = {},
): Promise<PermissionDecision> {
  const fallback = options.safetyCheck ?? safetyCheckForTool;
  return checkPermission(ctx, {
    rules: deps.rules,
    mode: deps.mode,
    cwd: deps.cwd ?? deps.rules.cwd,
    additionalDirs: deps.additionalDirs,
    canUseTool: deps.canUseTool,
    hook: deps.hook,
    safetyCheck: (candidate) => deps.safetyCheck?.(candidate) ?? fallback(candidate),
    classifier: deps.classifier,
  });
}

/**
 * The **deny** decision the rule engine produces for a call, when there is one.
 *
 * It is the part of the check that a **hook rewrite** has to be re-evaluated
 * against: the rule engine evaluated the original input, and the deny list is
 * the boundary that holds in every mode.
 */
export function denyDecisionFor(
  ctx: ToolContext,
  deps: BuiltinToolDeps,
): PermissionDecision | undefined {
  const decision = evaluateRuleList(deps.rules, deps.rules.deny, 'deny', ctx);
  if (!decision) return undefined;
  return { ...decision, reason: describeReason(decision, ctx.toolName) };
}

/**
 * The safety check a **file** tool runs.
 *
 * A path that is missing or is not a string is a **validation** failure, not a
 * permission refusal: the tool's own validator reports it with the typed code
 * the audit records (`7` for an invalid path, `3` for a missing field), and the
 * call does not run either way. The safety check therefore steps aside for it
 * and refuses everything else it cannot verify.
 */
export function fileToolSafetyCheck(
  field: string,
): (ctx: ToolContext) => PermissionDecision | undefined {
  return (ctx: ToolContext) => {
    const value = readInputField(ctx.input, field);
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      return undefined;
    }
    return safetyCheckForTool(ctx);
  };
}

/**
 * The path a file-mutating tool acts on, when the input carries a usable one.
 *
 * The input is **unvalidated** at the time the permission check runs, so the
 * path may be missing or of the wrong type: the check must not crash on it, and
 * the tool's own validator is the one that reports it.
 */
export function inputPath(input: unknown, field: string): string | undefined {
  const value = readInputField(input, field);
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

/**
 * Reject an input that carries a field the tool's schema does not declare.
 *
 * The schemas declare `additionalProperties: false`, so the validator enforces
 * it: a schema that says "no other field" and a validator that accepts one are
 * two different contracts, and the model is told which one holds.
 */
export function rejectUnknownFields(
  input: unknown,
  allowed: readonly string[],
): { ok: true } | { ok: false; message: string; errorCode: number } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: true };
  for (const key of Object.keys(input)) {
    if (allowed.includes(key)) continue;
    return {
      ok: false,
      message: `The '${key}' argument is not accepted by this tool.`,
      errorCode: TOOL_ERROR_CODES.invalidInput,
    };
  }
  return { ok: true };
}

/**
 * Read an own field of an input object.
 *
 * The field name comes from the tool's schema and the value from the model, so the
 * lookup is an **own-property** check: an input carrying `constructor` must not
 * resolve to an inherited member.
 */
export function readInputField(input: unknown, field: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, field)) return undefined;
  return record[field];
}

/** Read a string field of an input object. */
export function inputString(input: unknown, field: string): string | undefined {
  const value = readInputField(input, field);
  if (typeof value !== 'string') return undefined;
  return value;
}

/**
 * Require a non-empty string field.
 *
 * A missing field and a field of the wrong type are different failures, and each
 * carries its own code.
 */
export function requireStringField(
  input: unknown,
  field: string,
  opts: { invalidCode?: number; allowEmpty?: boolean } = {},
): { ok: true; value: string } | { ok: false; message: string; errorCode: number } {
  const value = readInputField(input, field);
  if (value === undefined || value === null) {
    return {
      ok: false,
      message: `The '${field}' argument is required.`,
      errorCode: TOOL_ERROR_CODES.missingField,
    };
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      message: `The '${field}' argument must be a string.`,
      errorCode: opts.invalidCode ?? TOOL_ERROR_CODES.invalidInput,
    };
  }
  if (value.length === 0 && opts.allowEmpty !== true) {
    return {
      ok: false,
      message: `The '${field}' argument must not be empty.`,
      errorCode: opts.invalidCode ?? TOOL_ERROR_CODES.invalidInput,
    };
  }
  return { ok: true, value };
}

/**
 * Validate an optional non-empty string field.
 */
export function optionalStringField(
  input: unknown,
  field: string,
  opts: { invalidCode?: number } = {},
): { ok: true; value?: string } | { ok: false; message: string; errorCode: number } {
  const value = readInputField(input, field);
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'string' || value.length === 0) {
    return {
      ok: false,
      message: `The '${field}' argument must be a non-empty string.`,
      errorCode: opts.invalidCode ?? TOOL_ERROR_CODES.invalidInput,
    };
  }
  return { ok: true, value };
}

/**
 * Validate an optional non-negative integer field.
 */
export function optionalIntegerField(
  input: unknown,
  field: string,
): { ok: true; value?: number } | { ok: false; message: string; errorCode: number } {
  const value = readInputField(input, field);
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return {
      ok: false,
      message: `The '${field}' argument must be a non-negative integer.`,
      errorCode: TOOL_ERROR_CODES.invalidInput,
    };
  }
  return { ok: true, value };
}

/**
 * Validate an optional boolean field.
 */
export function optionalBooleanField(
  input: unknown,
  field: string,
): { ok: true; value?: boolean } | { ok: false; message: string; errorCode: number } {
  const value = readInputField(input, field);
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'boolean') {
    return {
      ok: false,
      message: `The '${field}' argument must be a boolean.`,
      errorCode: TOOL_ERROR_CODES.invalidInput,
    };
  }
  return { ok: true, value };
}

/**
 * The absolute path a tool's path argument names.
 *
 * The path is resolved against the session's working directory, so a relative path
 * means the same thing to the rule engine and to the tool. A `~`-prefixed path is
 * expanded against the home directory, exactly as the rule engine expands it.
 */
export function absoluteToolPath(inputPath: string, cwd: string | undefined): string {
  return resolvePathTargets(inputPath, cwd === undefined ? {} : { cwd }).requested;
}

/** One recorded path. */
interface PathSnapshotEntry {
  /** The path as the call named it. */
  inputPath: string;
  /** Where it resolved when the check ran. */
  targets: PathTargets;
}

/**
 * The number of snapshots a tool instance keeps.
 *
 * The snapshot is taken while the permission check runs and forgotten when the
 * write is over, so the map holds one entry per call in flight. The bound is a
 * safety net for the calls that never reach the write.
 */
export const MAX_PATH_SNAPSHOTS = 64;

/**
 * The path bookkeeping of a file-mutating tool.
 *
 * The snapshot is taken while the permission check runs, and the write path
 * re-resolves it before the write. A symlink swapped in between is refused.
 *
 * **The snapshot is of the path the call will act on.** A hook may rewrite the
 * input, and the rewritten path is the one that is written, so the snapshot is
 * taken once the rewrite is known.
 */
export class PathSnapshot {
  /** The snapshots, keyed by the tool-use id. */
  private readonly snapshots = new Map<string, PathSnapshotEntry>();

  /** The working directory the paths resolve against. */
  constructor(private readonly cwd: string | undefined) {}

  /**
   * Take the snapshot of a path for a call.
   *
   * The oldest snapshot is dropped when the map is full: a call that never
   * reaches its write must not grow the map for the life of the tool.
   */
  record(toolUseId: string, inputPath: string): PathTargets {
    const targets = resolvePathTargets(inputPath, this.cwd === undefined ? {} : { cwd: this.cwd });
    this.snapshots.delete(toolUseId);
    this.snapshots.set(toolUseId, { inputPath, targets });
    while (this.snapshots.size > MAX_PATH_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
    return targets;
  }

  /** The snapshot of a call, when there is one. */
  get(toolUseId: string): PathTargets | undefined {
    return this.snapshots.get(toolUseId)?.targets;
  }

  /** Forget the snapshot of a call. */
  forget(toolUseId: string): void {
    this.snapshots.delete(toolUseId);
  }

  /**
   * Re-resolve a path and compare it with the snapshot.
   *
   * Returns the message of the refusal, or `undefined` when the path still
   * resolves where it did.
   */
  verify(toolUseId: string, inputPath: string): string | undefined {
    const entry = this.snapshots.get(toolUseId);
    if (!entry) return undefined;

    if (entry.inputPath !== inputPath) {
      // The write is to a path the permission check did not approve: the check
      // approved the path of the snapshot, and this is another one.
      return `The path '${entry.inputPath}' was the path the permission check approved, but the write was to '${inputPath}', so the write was refused.`;
    }

    const after = reResolvePath(entry.targets, this.cwd === undefined ? {} : { cwd: this.cwd });
    if (after.resolved === entry.targets.resolved) return undefined;

    return `The path '${entry.targets.requested}' resolved to '${entry.targets.resolved}' when the permission check ran and to '${after.resolved}' when the write was about to happen, so the write was refused.`;
  }
}

/**
 * The permission check a **file-mutating** tool runs.
 *
 * The snapshot is taken **after** the check, on the path the call will act on: a
 * hook may rewrite the input, and the rewritten path is the one that is written.
 * The write path re-resolves that snapshot, so a symlink swapped between the
 * check and the write is refused — on the rewritten path too.
 */
export async function checkFileToolPermissions(
  ctx: ToolContext,
  deps: BuiltinToolDeps,
  snapshot: PathSnapshot,
  field: string,
): Promise<PermissionDecision> {
  const decision = await checkToolPermissions(ctx, deps, {
    safetyCheck: fileToolSafetyCheck(field),
  });
  const effective = decision.updatedInput ?? ctx.input;
  const path = inputPath(effective, field);
  if (path !== undefined) snapshot.record(ctx.toolUseId, path);
  return decision;
}

/**
 * The files under a directory, following symlinked directories.
 *
 * A symlinked directory is followed, because a search path that reaches a file
 * through a symlink is exactly the case the `Read(...)` deny rules have to apply
 * to. The walk keeps a set of the resolved directories it has already visited, so
 * a symlink loop does not make it run forever.
 */
export async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [root];

  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) break;

    const resolved = resolvePathTargets(directory).resolved;
    if (visited.has(resolved)) continue;
    visited.add(resolved);

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(full)).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDirectory) {
        queue.push(full);
        continue;
      }
      files.push(full);
    }
  }

  return files;
}

/**
 * Whether a `Read(...)` deny rule blocks a file.
 *
 * The rule engine resolves the path before the match, so a deny rule fires when
 * **either** the requested path or the resolved target matches. That is what makes
 * a deny rule apply to a file reached through a **symlinked search path**: the
 * requested path is inside the search directory, but the resolved target is not.
 *
 * An `ask` rule does not hide the file: the file is still there to be read, and
 * the read is what needs the approval.
 */
export function isDeniedByReadRule(filePath: string, deps: BuiltinToolDeps): boolean {
  const decision = evaluateRules(deps.rules, {
    toolName: 'Read',
    input: { file_path: filePath },
    toolUseId: '',
    sessionId: '',
  });
  return decision?.behavior === 'deny';
}
