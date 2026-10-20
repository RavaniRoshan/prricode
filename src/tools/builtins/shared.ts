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
 * **The safety check runs after the hook seams, on the effective input.**
 * `checkPermission` runs the hook seams first — the `PreToolUse` seam and the
 * `PermissionRequest` seam — because the input the tool will act on is not known
 * before them, and the safety check judges **that** input. It holds in every
 * mode, including `bypassPermissions`, and it still precedes the mode dispatch.
 * The tool's own `safetyCheckForTool` refuses arguments the tool cannot verify:
 * it is the permission layer's `verifyToolInput` and the refusal it builds, so
 * the tool layer does not verify the same arguments a second time — the check
 * runs on the effective input, which is the input the tool will act on.
 *
 * **Both hook seams are consulted.** The `PreToolUse` seam is the seam the hooks
 * module's `createPreToolUseApproval` plugs into: it may deny the call, ask for
 * the user's decision, approve it and rewrite the tool input. Its **allow never
 * overrides a deny rule or an ask rule**, and its **deny holds in every mode**,
 * `bypassPermissions` included — this implementation's pick of the stricter of the
 * target's two behaviours.
 *
 * **A rewritten input is checked again, in full.** A **hook** may rewrite the
 * input, and the rewritten input is what the tool receives. The check evaluated
 * the *original* input, so the tool runs the **same** check again with the
 * effective one: the ask list, the allow scope and the mode dispatch apply to the
 * path the call will really act on. The re-check may only restrict the call.
 *
 * **The seams are consulted three times for a rewritten call.** The first
 * consultation judges the **original** input — the call as the model made it —
 * and the other two judge the **effective** input: the permission layer's own
 * re-check of the rewritten input, and the tool layer's re-check, which is the
 * second line of defence and owns the write path. A `command` hook therefore
 * runs three processes for one rewritten call. The number is a property of the
 * two re-checks and not a choice: the re-check has to see the effective input,
 * or a rewrite could escape the deny list, the ask list and the allow scope.
 *
 * **The re-check keeps the denial of either seam and nothing else.** An
 * approval was given for the **original** call and it does not carry the
 * rewritten one, so a `PreToolUse` hook that **approves and rewrites** a call
 * that **no rule covers** cannot approve it: the re-check leaves the call as
 * the generic prompt, the runner escalates it to the approval prompt, and with
 * no prompt to answer it the call is **refused** (`permission_unresolved`) —
 * even though the permission layer allowed it and the hook approved it. A call
 * a rule **does** cover is unaffected: the rule's own allow carries it through
 * the re-check.
 *
 * **The two layers consult the seams in the same order.** The `PreToolUse` seam
 * speaks first in the permission layer, so it speaks first here too, and a
 * refusal names the same seam in both layers.
 *
 * **The hook seams are the session's, and the session's assembly supplies
 * them.** The tools never build a seam themselves: `BuiltinToolDeps` carries
 * the two callbacks, and the assembly that constructs those dependencies — the
 * CLI's session assembly — is where the hooks module's creators are plugged
 * in:
 *
 * ```ts
 * const deps: BuiltinToolDeps = {
 *   rules,
 *   mode,
 *   cwd,
 *   hook: createPermissionRequestHook({
 *     approval: createHookApproval(hookRegistry.for('PermissionRequest')),
 *   }),
 *   preToolUseHook: createPreToolUseHook({
 *     approval: createPreToolUseApproval(hookRegistry.for('PreToolUse')),
 *   }),
 * };
 * ```
 *
 * The **agent runtime** carries the same seam: its own `permissionOptions()`
 * (`src/agent/loop.ts`) has to pass the `preToolUseHook` the same way, or a
 * turn that goes through the runtime's own permission service would not be
 * gated by the `PreToolUse` hooks.
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
  evaluateRules,
  type AutoModeVerdict,
  type PermissionDecision,
  type PermissionMode,
  type ToolContext,
} from '../../permissions/decision.js';
import { safetyCheckForTool } from '../../permissions/prompts.js';
import { reResolvePath, resolvePathTargets, type PathTargets } from '../../permissions/paths.js';
import { type RuleSet } from '../../permissions/rules.js';

import { TOOL_ERROR_CODES, type ToolRecheck } from '../registry.js';

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
  /**
   * The `PreToolUse` hook.
   *
   * It is the seam the hooks module's `createPreToolUseApproval` plugs into: the
   * hook may deny the call, ask the user for a decision, approve it and rewrite
   * the tool input. The **session's assembly** supplies it — the `preToolUseHook`
   * of the dependencies it builds (see the module header for the wiring).
   *
   * The **precedence is the permission layer's**, not the hook's: the seam runs
   * after the deny list and the ask list and before the mode's semantics, so an
   * **allow never overrides a deny rule or an ask rule**, and a **deny holds in
   * every mode**, `bypassPermissions` included. That is this implementation's pick of the
   * stricter of the target's two behaviours, and it is recorded in the module
   * headers of both layers.
   */
  preToolUseHook?: (
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
  return runToolCheck(ctx, deps, options, deps.hook, deps.preToolUseHook);
}

/**
 * The **whole** permission check, run again for a rewritten input.
 *
 * It is the same check the original input received — the same rules, the same
 * mode, the same safety check, the same prompt and the same classifier — with
 * the **effective** (rewritten) input, so a hook rewrite cannot escape the ask
 * list, the allow scope or the mode dispatch.
 *
 * The **hooks** are the one difference: see `recheckHook`.
 */
export async function recheckToolPermissions(
  ctx: ToolContext,
  deps: BuiltinToolDeps,
  options: {
    /**
     * The tool's own safety check, used when the session supplies none.
     */
    safetyCheck?: (ctx: ToolContext) => PermissionDecision | undefined;
    /**
     * The field the tool's path is in, when it has one.
     *
     * The path is reported as the **approved** path of the re-check, so the
     * runner can compare the path the check approved with the path the call
     * will act on.
     */
    pathField?: string;
  } = {},
): Promise<ToolRecheck> {
  // The re-check consults **both** seams through the one stricter hook, so the
  // `PreToolUse` seam is not consulted a second time on its own. The seams are
  // consulted in the **same order** as the permission layer consults them, so
  // the two layers report the same refusal.
  const stricter = recheckHook(deps);
  const decision = await runToolCheck(ctx, deps, options, stricter, undefined);
  const approvedPath =
    options.pathField === undefined ? undefined : inputPath(ctx.input, options.pathField);
  return { decision, approvedPath };
}

/**
 * The hook a check runs with.
 */
type ToolHook = (
  ctx: ToolContext,
) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>;

/**
 * Run the session's check with a hook.
 */
async function runToolCheck(
  ctx: ToolContext,
  deps: BuiltinToolDeps,
  options: { safetyCheck?: (ctx: ToolContext) => PermissionDecision | undefined },
  hook: ToolHook | undefined,
  preToolUseHook: ToolHook | undefined,
): Promise<PermissionDecision> {
  const fallback = options.safetyCheck ?? safetyCheckForTool;
  return checkPermission(ctx, {
    rules: deps.rules,
    mode: deps.mode,
    cwd: deps.cwd ?? deps.rules.cwd,
    additionalDirs: deps.additionalDirs,
    canUseTool: deps.canUseTool,
    hook,
    preToolUseHook,
    safetyCheck: (candidate) => deps.safetyCheck?.(candidate) ?? fallback(candidate),
    classifier: deps.classifier,
  });
}

/**
 * The hook as a **re-check** sees it.
 *
 * The re-check evaluates the input a hook rewrote, so the hook's **approval**
 * must not rescue that input: the approval was given for the original call, and
 * a rewrite must not be able to launder itself through the very hook that
 * performed it. The hook's **denial** still speaks, though — a hook that denies
 * a path must not be bypassed by a rewrite onto that path — and the hook's
 * rewrite is dropped, because the rewrite has already been applied and a second
 * one would need a third check, and so on.
 *
 * **Both seams are consulted, and only a denial is kept.** The `PreToolUse`
 * seam speaks first — it is the earlier event, and the permission layer
 * consults it first too — and a denial of either seam is final, so a denial
 * there ends the consultation. The `PermissionRequest` seam speaks too: its
 * denial is a denial as well. Consulting them in the **same order** as the
 * permission layer is what makes the two layers name the same seam in the
 * refusal they report.
 *
 * The re-check is the tool layer's **second line of defence** and it owns the
 * write path, so it is deliberately **stricter** than the permission layer's own
 * rule: the permission layer keeps a hook's approval when it re-checks a
 * rewritten input, and the tool layer does not.
 */
function recheckHook(deps: BuiltinToolDeps): ToolHook {
  return async (ctx: ToolContext) => {
    const denied = await denialFrom(ctx, deps.preToolUseHook);
    if (denied !== undefined) return denied;
    return denialFrom(ctx, deps.hook);
  };
}

/**
 * The **denial** a seam makes about a call, and nothing else.
 *
 * An approval is dropped: it was given for the original call, and the re-check
 * evaluates the rewritten one. A seam that says nothing is nothing at all.
 */
async function denialFrom(
  ctx: ToolContext,
  seam: ToolHook | undefined,
): Promise<PermissionDecision | undefined> {
  if (seam === undefined) return undefined;
  const decision = await seam(ctx);
  if (decision === undefined) return undefined;
  if (decision.behavior !== 'deny') return undefined;
  return decision;
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
  /** Where it resolved when the snapshot was taken. */
  targets: PathTargets;
}

/**
 * The number of snapshots a tool instance keeps.
 *
 * The snapshot is taken after the permission check returns and forgotten when the
 * write is over, so the map holds one entry per call in flight. The bound is a
 * safety net for the calls that never reach the write.
 */
export const MAX_PATH_SNAPSHOTS = 64;

/**
 * The path bookkeeping of a file-mutating tool.
 *
 * The snapshot is taken **after** the permission check returns, and the write
 * path re-resolves it **immediately before** the write. A symlink swapped in
 * between is refused.
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

    return `The path '${entry.targets.requested}' resolved to '${entry.targets.resolved}' when the permission check approved it and to '${after.resolved}' when the write was about to happen, so the write was refused.`;
  }
}

/**
 * The permission check a **file-mutating** tool runs.
 *
 * The snapshot is taken **after** the check returns, on the path the call will
 * act on: a hook may rewrite the input, and the rewritten path is the one that
 * is written. The write path re-resolves that snapshot immediately before the
 * write, so a symlink swapped between the check and the write is refused — on
 * the rewritten path too.
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
