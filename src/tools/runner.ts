/**
 * The tool runner: the single order in which a tool call becomes an action.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch) and §2.5 (Permissions, "Tool contract" and "Decision shape"), and the
 * `CC-008` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The order is: check permissions → validate input → execute → wrap the result.**
 * Nothing runs before the permission check, and a call that the check denies never
 * reaches the validation or the execution.
 *
 * **A denied call is an envelope, not an exception.** The model observes the
 * decision, so the refusal has to reach it: the envelope carries `isError: true`,
 * the decision, and the reason. Throwing would hide the decision from the model.
 *
 * **The permission decision is threaded back through the tool result.** The audit
 * records the target's tool-result metadata as
 * `{ id: tool_use_id, non_execution_kind, user_feedback, remedy, permission_decision:
 * { decision, source, reason_type } }`, and states that "permission decisions are
 * threaded back to the model through the tool result, so the model observes the
 * decision and its reason type".
 *
 * **Only a hook rewrites the input.** The rule engine is a pure predicate, so a
 * rule never rewrites what runs. A hook may, and the rewritten input is what the
 * tool receives. A rewritten input that the tool's **own validator** rejects **denies**
 * the call: the rewritten input is never executed.
 *
 * **A rewrite is re-evaluated against the whole check.** The rule engine evaluated
 * the *original* input, so a rewrite that moves the call to another path, to
 * another command or to another mode's scope would be a permission bypass. The
 * runner therefore asks the tool to run **the same check** again with the
 * effective (rewritten) input — the same rules, the same mode, the same safety
 * check and the same hook semantics — and it honours that verdict exactly as it
 * honours the first one: an `ask` is still an ask, a `deny` is still a denial,
 * and an `allow` never widens what the first check allowed.
 *
 * **The write path re-resolves the path after the check.** The resolution taken
 * before the check is a point-in-time fact: a symlink can be swapped between the
 * check and the write. The runner therefore resolves the path **before** the check
 * and re-resolves it **after** the check, and refuses the call when the two
 * disagree. This is the seam `reResolvePath` in `src/permissions/paths.ts` exposes
 * and that the `CC-007` review found was never called.
 *
 * **A rewrite does not step out of the comparison.** The path that will be
 * written is the **effective** path — the one the hook rewrote to — so the
 * effective path is resolved **before** the re-check that approves it and
 * re-resolved immediately before the execution. A symlink swapped in between is
 * refused on the rewritten path too.
 *
 * The re-resolution covers the **file-mutating tools** — the observed set is
 * exactly `Edit`, `Write` and `NotebookEdit`. A shell command's redirection
 * target is checked by the rule engine against the file rules, but the shell
 * resolves the target when it runs, so this implementation does **not** claim the same
 * guarantee for a shell redirection as for a file tool.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The **non-execution kinds** are a reimplementation vocabulary: `unknown_tool`,
 *     `permission_denied`, `permission_unresolved`, `permission_check_failed`,
 *     `validation_error`, `path_changed` and `execution_failed`. The audit names the
 *     member `non_execution_kind` but does not enumerate its values.
 *   - The **error content** of a failed call — `{ type: 'error', message, errorCode }`
 *     — is a implementation choice as well: the audit pins the tool-result *metadata*, not
 *     the content the tool returns.
 *   - A tool whose `checkPermissions` expresses **no opinion** does not get to run:
 *     the runner escalates to the session's permission service and, when there is
 *     none, **refuses** the call. A tool that returns no decision is not a tool that
 *     was approved.
 *   - A decision that still needs approval and is not resolved is **refused** rather
 *     than executed. The runner fails closed.
 *   - The runner asks the tool to **re-evaluate its own check** against the
 *     effective input, through the `recheckPermission` member of the tool
 *     contract: the rules are the session's, so only the tool can evaluate them.
 *     The re-check may only **restrict** the call: it never widens what the
 *     first check allowed, so an `ask` the first check produced stands even when
 *     the re-check says `allow`.
 */

import { reResolvePath, resolvePathTargets, type PathTargets } from '../permissions/paths.js';
import { extractToolPath } from '../permissions/rules.js';
import type {
  PermissionBehavior,
  PermissionDecision,
  PermissionReasonType,
  PermissionSource,
  ToolContext,
} from '../permissions/decision.js';

import {
  TOOL_ERROR_CODES,
  ToolExecutionError,
  isFileMutatingTool,
  type ToolDefinition,
  type ToolRegistry,
  type ToolRecheck,
} from './registry.js';

/**
 * The result of a tool call.
 *
 * The members are the target's tool-result metadata: the tool-use id, the
 * content, the error flag, the permission decision, and the three optional
 * members the target's `vo(e)` helper builds.
 *
 * **The names are the target's own.** The audit records the target's metadata
 * object as `{ id: tool_use_id, non_execution_kind, user_feedback, remedy,
 * permission_decision: { decision, source, reason_type } }` (§2.4), and this
 * envelope carries those names: `id`, `non_execution_kind`, `user_feedback`,
 * `remedy` and `permission_decision` — and the decision's own members are
 * `decision`, `source` and `reason_type`.
 *
 * `content` and `isError` are this implementation's own members: they are the
 * tool result's own payload, and the target spells them on the *content
 * block* (`{ tool_use_id, type, content, is_error }`), which is a different
 * object from the metadata one.
 */
export interface ToolResultEnvelope {
  /**
   * The id of the tool use this result answers — the target's `id`.
   *
   * It is **optional** for one reason only: the migration path. A transcript
   * written by an earlier build spells the id `toolUseId`, and the reader
   * migrates it. The writer always sets `id`.
   */
  id?: string;
  /** The tool's output, or the error that stopped it. */
  content: unknown;
  /** Whether the call failed. */
  isError: boolean;
  /** The permission decision, so the model observes it. */
  permission_decision?: {
    decision: PermissionBehavior;
    source: PermissionSource;
    reason_type?: PermissionReasonType;
  };
  /** The kind of failure that stopped the call, when it did not run. */
  non_execution_kind?: string;
  /** What the caller can do about the failure. */
  remedy?: string;
  /** The feedback the user gave, when the user gave any. */
  user_feedback?: string;

  /* ------------------------------------------------------------------ */
  /* The previous spellings                                              */
  /* ------------------------------------------------------------------ */

  /**
   * The **previous** spelling of {@link id}.
   *
   * @deprecated The target's name is `id`. This member is the migration path:
   * the transcript reader accepts it in a record written by an earlier build,
   * and the envelope this build returns carries the target's names.
   */
  toolUseId?: string;
  /**
   * The **previous** spelling of {@link permission_decision}.
   *
   * @deprecated The target's name is `permission_decision`, and the decision's
   * own members are `decision`, `source` and `reason_type`.
   */
  permissionDecision?: {
    decision: PermissionBehavior;
    source: PermissionSource;
    reasonType?: PermissionReasonType;
  };
  /**
   * The **previous** spelling of {@link non_execution_kind}.
   *
   * @deprecated The target's name is `non_execution_kind`.
   */
  nonExecutionKind?: string;
  /**
   * The **previous** spelling of {@link user_feedback}.
   *
   * @deprecated The target's name is `user_feedback`.
   */
  userFeedback?: string;
}

/** The options a run runs with. */
export interface RunToolOptions {
  /**
   * The session's permission service.
   *
   * It is consulted when the tool's own `checkPermissions` expresses no opinion.
   * Without it, a tool that expresses no opinion is **refused**.
   */
  checkPermission?: (ctx: ToolContext) => Promise<PermissionDecision | undefined>;
  /**
   * Resolves a decision that still needs approval.
   *
   * Without it, a call that still needs approval is **refused**.
   */
  approveAsk?: (
    ctx: ToolContext,
    decision: PermissionDecision,
  ) => Promise<PermissionDecision | undefined>;
  /**
   * The working directory the path rules and the tools resolve against.
   *
   * It must be the **same** directory the tools resolve against, because the
   * runner compares the path it resolved before the check with the path it
   * resolves after it.
   */
  cwd?: string;
}

/** The error content of a failed call. */
export interface ToolErrorContent {
  type: 'error';
  message: string;
  errorCode: number;
}

/** The decision as the tool result carries it. */
function toEnvelopeDecision(
  decision: PermissionDecision,
): NonNullable<ToolResultEnvelope['permission_decision']> {
  return {
    decision: decision.behavior,
    source: decision.source,
    reason_type: decision.reasonType,
  };
}

/**
 * Attach the **previous** spellings of the envelope's members.
 *
 * The envelope's members carry the **target's** names (audit §2.4), and the
 * shape of the envelope — what `Object.keys` and `JSON.stringify` see — is
 * the target's. The spellings this implementation used before are kept as
 * **non-enumerable** aliases: a caller written against the earlier build
 * still reads `envelope.nonExecutionKind` and `envelope.permissionDecision`,
 * and a transcript written by the earlier build is migrated by the reader.
 *
 * The aliases are a **migration path**, not part of the envelope's shape.
 */
export function withLegacyEnvelopeNames(envelope: ToolResultEnvelope): ToolResultEnvelope {
  defineLegacyName(envelope, 'toolUseId', () => envelope.id);
  defineLegacyName(envelope, 'nonExecutionKind', () => envelope.non_execution_kind);
  defineLegacyName(envelope, 'userFeedback', () => envelope.user_feedback);
  defineLegacyName(envelope, 'permissionDecision', () => {
    const decision = envelope.permission_decision;
    if (decision === undefined) return undefined;
    return {
      decision: decision.decision,
      source: decision.source,
      reasonType: decision.reason_type,
    };
  });
  return envelope;
}

/**
 * Define one non-enumerable alias on the envelope.
 *
 * The name is one of this module's own fixed names, never a caller's, and the
 * property is **not enumerable**: the envelope's shape stays the target's.
 */
function defineLegacyName(
  envelope: ToolResultEnvelope,
  name: string,
  read: () => unknown,
): void {
  Object.defineProperty(envelope, name, {
    get: read,
    enumerable: false,
    configurable: true,
  });
}

/** The sources whose reason is the user's own feedback. */
const USER_SOURCES: ReadonlySet<PermissionSource> = new Set<PermissionSource>([
  'user_permanent',
  'user_temporary',
  'user_abort',
  'user_reject',
]);

function errorEnvelope(
  ctx: ToolContext,
  detail: {
    message: string;
    errorCode: number;
    nonExecutionKind: string;
    decision?: PermissionDecision;
    remedy?: string;
    userFeedback?: string;
  },
): ToolResultEnvelope {
  const envelope: ToolResultEnvelope = {
    id: ctx.toolUseId,
    content: {
      type: 'error',
      message: detail.message,
      errorCode: detail.errorCode,
    } satisfies ToolErrorContent,
    isError: true,
    non_execution_kind: detail.nonExecutionKind,
  };
  if (detail.decision) envelope.permission_decision = toEnvelopeDecision(detail.decision);
  if (detail.remedy !== undefined) envelope.remedy = detail.remedy;
  if (detail.userFeedback !== undefined) envelope.user_feedback = detail.userFeedback;
  return withLegacyEnvelopeNames(envelope);
}

/** The reason a denial is reported with. */
function denialMessage(decision: PermissionDecision, toolName: string): string {
  return decision.reason ?? `The ${toolName} call was denied.`;
}

/** The remedy a denial is reported with. */
function denialRemedy(decision: PermissionDecision): string {
  const rule = decision.rule;
  if (rule) {
    return `The rule '${rule.content}' from ${rule.source} governs this call; ask the user to change it or to approve the call.`;
  }
  return 'Ask the user to approve the call, or change the permission rules.';
}

/** The user's own feedback, when the decision carries any. */
function userFeedbackOf(decision: PermissionDecision): string | undefined {
  if (!USER_SOURCES.has(decision.source)) return undefined;
  return decision.message ?? decision.reason;
}

/**
 * The path a tool acts on, and where it resolves to.
 *
 * The **requested** path is the path the tool asked for; the **resolved** path is
 * where the kernel would end up.
 */
function toolPathTargets(
  toolName: string,
  input: unknown,
  cwd: string | undefined,
): PathTargets | undefined {
  const path = extractToolPath({
    toolName,
    input,
    toolUseId: '',
    sessionId: '',
  });
  if (path === undefined) return undefined;
  return resolvePathTargets(path, cwd === undefined ? {} : { cwd });
}

/**
 * The message of a thrown value.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The stricter of two decisions.
 *
 * The re-check of a rewritten input may only **restrict** the call: it never
 * widens what the first check allowed. A `deny` wins over everything, an `ask`
 * wins over an `allow`, and two `allow`s are the first one.
 */
function stricterDecision(
  first: PermissionDecision,
  second: PermissionDecision,
): PermissionDecision {
  if (first.behavior === 'deny') return first;
  if (second.behavior === 'deny') return second;
  if (first.behavior === 'ask') return first;
  if (second.behavior === 'ask') return second;
  return first;
}

/**
 * The envelope of a denial.
 */
function denialEnvelope(
  ctx: ToolContext,
  decision: PermissionDecision,
  toolName: string,
): ToolResultEnvelope {
  return errorEnvelope(ctx, {
    message: denialMessage(decision, toolName),
    errorCode: TOOL_ERROR_CODES.permissionDenied,
    nonExecutionKind: 'permission_denied',
    decision,
    remedy: denialRemedy(decision),
    userFeedback: userFeedbackOf(decision),
  });
}

/**
 * Whether the path a check approved is the path the call will act on.
 *
 * The paths are compared as they **resolve**, so a relative path and the
 * absolute path it names are the same path.
 */
function approvedPathMatches(
  approvedPath: string,
  effective: PathTargets | undefined,
  cwd: string | undefined,
): boolean {
  // A call with no path to approve — a shell command, say — has nothing to
  // compare.
  if (!effective) return true;
  const approved = resolvePathTargets(approvedPath, cwd === undefined ? {} : { cwd });
  return approved.requested === effective.requested;
}

/**
 * Run a tool call.
 *
 * The order is the whole point of this function: **check permissions → validate
 * input → execute → wrap the result**. The path of a file-mutating tool is resolved
 * before the check and **re-resolved before the write**, and the call is refused
 * when the two resolutions disagree.
 */
export async function runTool(
  registry: ToolRegistry,
  name: string,
  input: unknown,
  ctx: ToolContext,
  options: RunToolOptions = {},
): Promise<ToolResultEnvelope> {
  const tool: ToolDefinition | undefined = registry.get(name);
  if (!tool) {
    return errorEnvelope(ctx, {
      message: `There is no tool named '${name}'.`,
      errorCode: TOOL_ERROR_CODES.unknownTool,
      nonExecutionKind: 'unknown_tool',
      remedy: 'Call one of the tools the registry holds.',
    });
  }

  // The caller's context, with the input the call actually carries and the name
  // of the tool that will run: a tool that is reached under another name is still
  // the tool whose rules and whose path fields apply.
  const callCtx: ToolContext = { ...ctx, toolName: tool.name, input };

  // The path the check resolves, taken **before** the check. The observed
  // file-mutating set is `Edit`, `Write` and `NotebookEdit`, so a tool that is in
  // that set is treated as mutating whether it says so or not.
  const mutating = tool.mutatesFiles || isFileMutatingTool(tool.name);
  const preCheck = mutating ? toolPathTargets(tool.name, input, options.cwd) : undefined;

  let decision: PermissionDecision | undefined;
  try {
    decision = await tool.checkPermissions(input, callCtx);
  } catch (error) {
    return errorEnvelope(ctx, {
      message: `The permission check for '${tool.name}' failed: ${messageOf(error)}`,
      errorCode: TOOL_ERROR_CODES.executionFailed,
      nonExecutionKind: 'permission_check_failed',
      remedy: 'Fix the permission check and retry the call.',
    });
  }

  if (decision === undefined) {
    // The tool expressed no opinion. The session's permission service decides; when
    // there is none, the call is refused: a tool that returned no decision was not
    // approved.
    let escalated: PermissionDecision | undefined;
    try {
      escalated = await options.checkPermission?.(callCtx);
    } catch (error) {
      return errorEnvelope(ctx, {
        message: `The permission service failed: ${messageOf(error)}`,
        errorCode: TOOL_ERROR_CODES.executionFailed,
        nonExecutionKind: 'permission_check_failed',
        remedy: 'Fix the permission service and retry the call.',
      });
    }
    if (!escalated) {
      return errorEnvelope(ctx, {
        message: `The '${tool.name}' tool returned no permission decision, so the call was refused.`,
        errorCode: TOOL_ERROR_CODES.permissionDenied,
        nonExecutionKind: 'permission_denied',
        remedy: 'Give the tool a permission check, or run the call through the session permission service.',
      });
    }
    decision = escalated;
  }

  // A denial is a denial: the call is refused before the re-check, and the
  // re-check cannot un-deny it.
  if (decision.behavior === 'deny') {
    return denialEnvelope(ctx, decision, tool.name);
  }

  // The rewritten input. Only a **hook** rewrites the input; the rule engine is a
  // pure predicate and never does.
  const rewritten = decision.updatedInput !== undefined;
  const effectiveInput = decision.updatedInput ?? input;
  const effectiveCtx: ToolContext = { ...callCtx, input: effectiveInput };

  // The path the call will act on, resolved **before** the re-check that approves
  // it. It is re-resolved immediately before the execution, so a symlink swapped
  // in between is caught on the rewritten path too.
  const effectiveCheck =
    rewritten && mutating ? toolPathTargets(tool.name, effectiveInput, options.cwd) : undefined;

  if (rewritten) {
    // A rewrite is a **new** call: the check evaluated the *original* input, so the
    // rewritten input is evaluated against the **whole** check again — the same
    // rules, the same mode, the same safety check and the same hook semantics.
    // The re-check may only restrict the call, so it never widens what the first
    // check allowed.
    let recheck: ToolRecheck;
    try {
      recheck = await tool.recheckPermission(effectiveInput, effectiveCtx);
    } catch (error) {
      return errorEnvelope(ctx, {
        message: `The permission check for '${tool.name}' failed: ${messageOf(error)}`,
        errorCode: TOOL_ERROR_CODES.executionFailed,
        nonExecutionKind: 'permission_check_failed',
        decision,
        remedy: 'Fix the permission check and retry the call.',
      });
    }

    let rechecked = recheck.decision;
    if (rechecked === undefined) {
      // The tool expressed no opinion about the rewritten input. The session's
      // permission service decides; when there is none, the call is refused: a
      // tool that returned no decision was not approved.
      let escalated: PermissionDecision | undefined;
      try {
        escalated = await options.checkPermission?.(effectiveCtx);
      } catch (error) {
        return errorEnvelope(ctx, {
          message: `The permission service failed: ${messageOf(error)}`,
          errorCode: TOOL_ERROR_CODES.executionFailed,
          nonExecutionKind: 'permission_check_failed',
          decision,
          remedy: 'Fix the permission service and retry the call.',
        });
      }
      if (!escalated) {
        return errorEnvelope(ctx, {
          message: `The '${tool.name}' tool returned no permission decision for the input a hook rewrote, so the call was refused.`,
          errorCode: TOOL_ERROR_CODES.permissionDenied,
          nonExecutionKind: 'permission_denied',
          decision,
          remedy:
            'Give the tool a permission check, or run the call through the session permission service.',
        });
      }
      rechecked = escalated;
    }

    // The check approved a path: it must be the path the call will act on.
    const approvedPath = recheck.approvedPath;
    if (
      approvedPath !== undefined &&
      !approvedPathMatches(approvedPath, effectiveCheck, options.cwd)
    ) {
      return errorEnvelope(ctx, {
        message: `The permission check approved the path '${approvedPath}', but the call would act on another path, so the call was refused.`,
        errorCode: TOOL_ERROR_CODES.pathChanged,
        nonExecutionKind: 'path_changed',
        decision,
        remedy:
          'The check and the call disagree about the path; run the check again and retry the call.',
      });
    }

    decision = stricterDecision(decision, rechecked);
  }

  if (decision.behavior === 'ask') {
    let resolved: PermissionDecision | undefined;
    try {
      resolved = await options.approveAsk?.(effectiveCtx, decision);
    } catch (error) {
      return errorEnvelope(ctx, {
        message: `The approval of the ${tool.name} call failed: ${messageOf(error)}`,
        errorCode: TOOL_ERROR_CODES.executionFailed,
        nonExecutionKind: 'permission_check_failed',
        decision,
        remedy: 'Approve the call and run it again.',
      });
    }
    if (!resolved) {
      return errorEnvelope(ctx, {
        message:
          decision.reason ?? `The ${tool.name} call still needs approval, so it was not executed.`,
        errorCode: TOOL_ERROR_CODES.approvalRequired,
        nonExecutionKind: 'permission_unresolved',
        decision,
        remedy: 'Approve the call and run it again.',
        userFeedback: userFeedbackOf(decision),
      });
    }
    decision = resolved;
    if (decision.behavior === 'ask') {
      // The approval did not settle the call: it still needs one. The runner fails
      // closed.
      return errorEnvelope(ctx, {
        message:
          decision.reason ?? `The ${tool.name} call still needs approval, so it was not executed.`,
        errorCode: TOOL_ERROR_CODES.approvalRequired,
        nonExecutionKind: 'permission_unresolved',
        decision,
        remedy: 'Approve the call and run it again.',
        userFeedback: userFeedbackOf(decision),
      });
    }
  }

  if (decision.behavior === 'deny') {
    // The denial of the re-check, or the denial the approval came back with.
    return denialEnvelope(ctx, decision, tool.name);
  }

  let validation: { ok: true } | { ok: false; message: string; errorCode: number };
  try {
    validation = await tool.validateInput(effectiveInput, effectiveCtx);
  } catch (error) {
    return errorEnvelope(ctx, {
      message: `The input of '${tool.name}' could not be validated: ${messageOf(error)}`,
      errorCode: TOOL_ERROR_CODES.invalidInput,
      nonExecutionKind: 'validation_error',
      decision,
      remedy: 'Correct the arguments of the call and run it again.',
    });
  }

  if (!validation.ok) {
    // A rewritten input the tool's own validator rejects **denies** the call: the
    // rewritten input is never executed.
    const denial: PermissionDecision | undefined = rewritten
      ? {
          behavior: 'deny',
          source: 'hook',
          reasonType: 'other',
          reason: `A hook rewrote the tool input and the tool rejected it (error ${validation.errorCode}): ${validation.message}`,
        }
      : undefined;
    return errorEnvelope(ctx, {
      message: validation.message,
      errorCode: validation.errorCode,
      nonExecutionKind: 'validation_error',
      decision: denial ?? decision,
      remedy: 'Correct the arguments of the call and run it again.',
      userFeedback: userFeedbackOf(decision),
    });
  }

  // The post-check re-resolution, immediately before the write. The write path
  // must not trust the resolution the check took: a symlink can be swapped
  // while the check runs.
  const refused = refuseChangedPath(
    preCheck,
    effectiveCheck,
    options.cwd,
    decision,
    ctx,
  );
  if (refused) return refused;

  try {
    const output = await tool.execute(effectiveInput, effectiveCtx);
    const envelope: ToolResultEnvelope = {
      id: ctx.toolUseId,
      content: output,
      isError: false,
      permission_decision: toEnvelopeDecision(decision),
    };
    return withLegacyEnvelopeNames(envelope);
  } catch (error) {
    const errorCode =
      error instanceof ToolExecutionError ? error.errorCode : TOOL_ERROR_CODES.executionFailed;
    return errorEnvelope(ctx, {
      message: messageOf(error),
      errorCode,
      nonExecutionKind: 'execution_failed',
      decision,
      remedy: 'Fix the cause of the failure and run the call again.',
    });
  }
}

/**
 * Refuse a call whose path resolves to a different target after the check.
 *
 * Two comparisons are made, and both of them are between a resolution and a
 * **later** resolution of the same path:
 *
 *   - the path the call named, resolved **before** the check and re-resolved
 *     **after** it: a symlink swapped while the check ran is caught;
 *   - the path the call will act on — the rewritten one, when a hook rewrote the
 *     input — resolved **before** the re-check that approves it and re-resolved
 *     immediately before the execution: a symlink swapped while that check ran
 *     is caught on the path that is actually written.
 */
function refuseChangedPath(
  preCheck: PathTargets | undefined,
  effectiveCheck: PathTargets | undefined,
  cwd: string | undefined,
  decision: PermissionDecision,
  ctx: ToolContext,
): ToolResultEnvelope | undefined {
  const options = cwd === undefined ? {} : { cwd };
  const comparisons: PathTargets[] = [];
  if (effectiveCheck) comparisons.push(effectiveCheck);
  // The path the call named is compared as well: the resolution the check took is
  // the one the rules were evaluated against, so a change under it is a change
  // the check never saw.
  if (preCheck) comparisons.push(preCheck);

  for (const before of comparisons) {
    const after = reResolvePath(before, options);
    if (after.resolved === before.resolved) continue;

    return errorEnvelope(ctx, {
      message: `The path '${before.requested}' resolved to '${before.resolved}' when the permission check ran and to '${after.resolved}' afterwards, so the call was refused.`,
      errorCode: TOOL_ERROR_CODES.pathChanged,
      nonExecutionKind: 'path_changed',
      decision,
      remedy:
        'The path changed while the permission check ran; run the check again and retry the call.',
    });
  }

  return undefined;
}
