/**
 * The tool registry: the shape of a tool, the registry that holds them, the
 * file-mutating tool set, and the error vocabulary the tools and the runner share.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch) and §2.5 (Permissions, "Tool contract"), and the `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **A tool is the boundary between a model's request and the machine.** The audit's
 * tool contract is that a tool's `create()` returns `checkPermissions(input,
 * context)`, `validateInput(input, context)` and the execution path; the file-write
 * tool's observed sequence is "normalize the path, stash the permission decision
 * keyed by `toolUseId`, evaluate the rules, fall back to a path-specific rule,
 * allow a modified input only when a rule rewrites it, then run input validation
 * which returns typed failures with numeric `errorCode` values". This implementation keeps
 * the sequence but restricts the rewrite to the **hook** path: a rule is a pure
 * predicate, so it never changes what runs (`src/permissions/rules.ts`).
 *
 * **The registry is the only way a model reaches the machine.** A model-generated
 * action never reaches execution without passing the permission service, so the
 * registry holds the definitions and the runner (`src/tools/runner.ts`) owns the
 * order: check permissions → validate input → execute → wrap the result.
 *
 * **A tool also declares whether it is concurrency safe.** The target's
 * scheduler is per tool: a call whose tool declares itself concurrency safe
 * runs beside the other safe calls of the same assistant message, and a call
 * that is not concurrency safe runs alone and is a barrier. **A tool that does
 * not declare the flag is not concurrency safe** — the target's own default,
 * and the `catch` around the flag's read. See {@link isToolConcurrencySafe}.
 *
 * **The file-mutating tool set has one source of truth.** The set is exactly
 * `["Edit", "Write", "NotebookEdit"]`, and it is **derived** from
 * `FILE_MUTATING_TOOL_NAMES` in `src/permissions/rules.ts` rather than duplicated
 * here: two copies of the set would drift, and the mode layer, the redirect matcher
 * and the plan-mode effect check all read the permission module's copy.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The **error codes** are the target's for the two the audit names — `7` for an
 *     invalid path and `14` for a suppressed write — and **implementation choices** for the
 *     rest. The audit does not enumerate the remaining codes, so this implementation does not
 *     claim them. **The numbering is implementation-internal**: the gaps in it are the
 *     implementation's own and are **not** an alignment with an unstated target table, so
 *     a code other than `7` and `14` must never be read as a compatibility claim.
 *   - The **error content** of a failed call — `{ type: 'error', message, errorCode }`
 *     — is a implementation choice as well. The audit pins the tool-result *metadata*, not
 *     the content the tool returns, so the shape of the content is this implementation's.
 *   - A registry holds one definition per name: registering a name twice
 *     **replaces** the earlier definition.
 *   - The registry is a `Map`, so a tool named `constructor`, `toString` or
 *     `__proto__` resolves to no tool. The name is caller-supplied data.
 *   - `ToolExecutionError` carries a numeric `errorCode` so that a failure inside a
 *     tool's `execute` reaches the result envelope as a **typed** error rather than
 *     as an opaque message.
 */

import type { PermissionDecision, ToolContext } from '../permissions/decision.js';
import { FILE_MUTATING_TOOL_NAMES } from '../permissions/rules.js';

export type { PermissionDecision, ToolContext } from '../permissions/decision.js';

/**
 * A tool definition.
 *
 * The members that matter for the boundary are `checkPermissions`,
 * `recheckPermission`, `validateInput` and `execute`; the runner calls them in
 * that order.
 */
export interface ToolDefinition<I = unknown, O = unknown> {
  /** The tool's name, as the model calls it. */
  name: string;
  /** The description the model sees. */
  description: string;
  /** The input schema, as JSON Schema. */
  inputSchema: unknown;
  /** Whether the tool writes to the filesystem. */
  mutatesFiles: boolean;
  /**
   * Whether the call may run **beside** another call.
   *
   * The target's scheduler is **per tool, not per message**: every tool
   * declares whether it is concurrency safe, the safe calls of one assistant
   * message run **together**, and a call that is not concurrency safe runs
   * **alone** and is a **barrier** — the queue stops at it, and nothing else
   * starts until it has finished.
   *
   * **A tool that does not declare the flag is not concurrency safe.** That is
   * the target's own default: the flag is read inside a `try`, and a tool
   * without it — or one whose flag throws — is treated as not concurrency
   * safe. See {@link isToolConcurrencySafe}.
   *
   * The flag is a **method** and not a property, so a tool that declares a
   * narrower input type stays assignable to the registry's own type.
   */
  isConcurrencySafe?(input: I): boolean;
  /**
   * The tool's own permission check.
   *
   * Returns the decision that governs the call, or `undefined` when the tool
   * expresses no opinion — the runner then escalates to the session's permission
   * service and, failing that, refuses the call.
   */
  checkPermissions(input: I, ctx: ToolContext): Promise<PermissionDecision | undefined>;
  /**
   * The tool's own input validation, with a typed failure.
   */
  validateInput(
    input: I,
    ctx: ToolContext,
  ): Promise<{ ok: true } | { ok: false; message: string; errorCode: number }>;
  /**
   * Re-evaluate the **whole** permission check against a rewritten input.
   *
   * The runner calls this when a **hook** rewrote the input. The check evaluated
   * the *original* input, so a rewrite that moves the call to another path, to
   * another command or to another mode's scope would otherwise be a permission
   * bypass. The re-check is therefore **the same check** — the same rules, the
   * same mode, the same safety check and the same hook semantics — run with the
   * **effective** (rewritten) input, and the runner honours its verdict exactly
   * as it honours the first one.
   *
   * It is a member of the contract rather than an optional extra, because a tool
   * that cannot re-evaluate its own check cannot be given a rewrite.
   */
  recheckPermission(input: I, ctx: ToolContext): Promise<ToolRecheck>;
  /** The execution. It runs only after the permission check and the validation. */
  execute(input: I, ctx: ToolContext): Promise<O>;
}

/** The registry of tools. */
export interface ToolRegistry {
  /** Register a tool. A name that is already registered is replaced. */
  register(tool: ToolDefinition): void;
  /** The tool with that name, or `undefined` when there is none. */
  get(name: string): ToolDefinition | undefined;
  /** The registered tools, in registration order. */
  list(): readonly ToolDefinition[];
}

/**
 * The result of re-checking a rewritten input.
 *
 * The re-check is the **whole** permission check, run again with the effective
 * (rewritten) input, so a hook rewrite cannot escape the ask list, the allow
 * scope or the mode dispatch.
 */
export interface ToolRecheck {
  /**
   * The decision the check produced for the effective input.
   *
   * `undefined` means the tool expressed **no opinion** about the effective
   * input: the runner then escalates to the session's permission service and,
   * failing that, refuses the call — exactly as it does for a first check that
   * expressed no opinion.
   */
  decision: PermissionDecision | undefined;
  /**
   * The path the check approved, when the check approved one.
   *
   * It is the path **as the call named it**. The runner compares the path's
   * resolution after the check with the one it took before it, so a symlink
   * swapped while the check ran is refused — and it refuses a call whose check
   * approved **another** path than the one the call will act on.
   */
  approvedPath?: string;
}

/**
 * The file-mutating tools, exactly as the target names them.
 *
 * The set is **derived** from `FILE_MUTATING_TOOL_NAMES`, so the registry and the
 * permission engine cannot drift apart.
 */
export const FILE_MUTATING_TOOLS: readonly string[] = Object.freeze([
  ...FILE_MUTATING_TOOL_NAMES,
]);

/**
 * Whether a call may run beside another call.
 *
 * The target reads the flag **per tool call**, from the tool definition, and
 * wraps the read in a `try`: a tool that does not declare the flag is **not**
 * concurrency safe, and a flag that throws is not concurrency safe either.
 * That is the target's own default, and it is the rule this implementation
 * follows.
 *
 * A tool the registry does not hold is not concurrency safe: there is no
 * definition to read the flag from.
 *
 * **The target also requires the call's input to validate** before it reads
 * the flag, and a call whose input does not validate is therefore not
 * concurrency safe. This implementation does not run the tool's validator a
 * second time to find that out: the runner refuses a call whose input does
 * not validate before it does anything, so the only difference is the
 * scheduling of a call that was going to fail anyway.
 */
export function isToolConcurrencySafe(tool: ToolDefinition | undefined, input: unknown): boolean {
  if (tool === undefined) return false;
  const flag = tool.isConcurrencySafe;
  if (flag === undefined) return false;
  try {
    return flag.call(tool, input) === true;
  } catch {
    // The target's own default: a flag that throws is not concurrency safe.
    return false;
  }
}

/** Whether a tool writes to the filesystem. */
export function isFileMutatingTool(name: string): boolean {
  return FILE_MUTATING_TOOL_NAMES.includes(name);
}

/**
 * The error codes a tool failure carries.
 *
 * `invalidPath` (`7`) and `suppressedWrite` (`14`) are the two the audit names for
 * the file-write tool. The others are **implementation choices**: the audit does not
 * enumerate them, so this implementation does not claim them.
 */
export const TOOL_ERROR_CODES = {
  /** The registry holds no tool with that name. */
  unknownTool: 1,
  /** The input is not of the shape the tool accepts. */
  invalidInput: 2,
  /** A required field is missing. */
  missingField: 3,
  /** The path is not usable. Audit-observed code. */
  invalidPath: 7,
  /** The file does not exist. */
  fileNotFound: 8,
  /** The command is not usable. */
  invalidCommand: 9,
  /** The URL is not a usable http(s) URL. */
  invalidUrl: 10,
  /** The execution failed. */
  executionFailed: 12,
  /** The permission check denied the call. */
  permissionDenied: 13,
  /** The write was suppressed. Audit-observed code. */
  suppressedWrite: 14,
  /** The path resolved to a different target after the permission check. */
  pathChanged: 15,
  /** The string an edit was asked to replace is not in the file. */
  stringNotFound: 16,
  /** The notebook is not a notebook, or the cell does not exist. */
  invalidNotebook: 17,
  /** The call still needs approval and no approval was given. */
  approvalRequired: 18,
  /** The task runner is not available. */
  taskUnavailable: 19,
} as const;

/** One of the error codes. */
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

/**
 * A failure inside a tool's `execute`.
 *
 * The error carries the numeric code of the failure, so the result envelope
 * reports a **typed** failure rather than an opaque message.
 */
export class ToolExecutionError extends Error {
  /** The typed error code. */
  readonly errorCode: number;

  constructor(message: string, errorCode: number) {
    super(message);
    this.name = 'ToolExecutionError';
    this.errorCode = errorCode;
  }
}

/**
 * Create a registry.
 *
 * The registry is a `Map`, so a caller-supplied tool name never resolves to an
 * inherited member of `Object.prototype`: `get('constructor')` and `get('__proto__')`
 * both return `undefined`.
 */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      tools.set(tool.name, tool);
    },
    get(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },
    list(): readonly ToolDefinition[] {
      return [...tools.values()];
    },
  };
}
