/**
 * The approval surface: the hook approval path, the safety check, the prompt text,
 * and the remote `can_use_tool` dispatcher.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "Host-level
 * gates" and "Remote permission transport").
 *
 * **Only hooks rewrite the tool input.** A `PermissionRequest` hook may return an
 * `updatedInput`, and that rewritten input is what the tool receives. A rewritten
 * input that the tool's own validator rejects **denies** the call — the rewritten
 * input is never executed. The rule engine lives in `src/permissions/rules.ts` and
 * never rewrites anything.
 *
 * **The `PreToolUse` seam maps the hooks module's approval into the permission
 * decision vocabulary.** The mapping lives here, in the permission layer, because
 * the approval the hooks module produces carries a `decision.behavior` and nothing
 * else. The mapping is **pure**: the tool's own validator and the safety check
 * are the **permission layer's** job (`checkPermission` in `src/permissions/
 * decision.ts`), because they judge the input the tool would act on and they run
 * there **once** per call, against the **effective** input. A seam that ran them
 * itself would run them twice over a rewritten call — once for the original and
 * once for the re-check of the rewrite — and a caller-supplied check that is not
 * idempotent would see four invocations per tool call.
 *
 * **The `PermissionRequest` seam keeps its own rewrite check.** The function
 * `applyPermissionRequestHook` runs the tool's validator and the safety check
 * against the rewritten input, and that behaviour is pinned by
 * `tests/contracts/permission-decision.test.ts`: a rewritten input the tool
 * rejects denies the call, and a refusal is a `safetyCheck`, never a user denial.
 *
 * **The hooks module's decision vocabulary is imported type-only.** The
 * `PreToolUse` seam understands `allow`, `ask`, `defer` and `deny`, and the
 * permission layer's own vocabulary has three of them. The four-value type comes
 * from the hooks module (`HookDecisionValue`) through a **type-only** import,
 * which is erased at compile time: the permission layer does not depend on the
 * hooks module at runtime, so the import cannot close a cycle — the hooks module
 * imports the permission layer, never the other way round.
 *
 * **A safety check is independent of the rule engine.** A `PermissionRequest` hook
 * may approve a WebFetch whose approved arguments the tool cannot verify; the fetch
 * is then refused, and the refusal is **not** reported as a user denial — it is a
 * `safetyCheck`, and the source is the hook, never `user_reject` or `user_abort`.
 * The hook approval carries a `classifierApprovable: false` marker in that case, so
 * the auto-mode review cannot launder an unverifiable approval into an approval.
 *
 * **The remote transport dispatcher** accepts only the `can_use_tool` subtype. A
 * request whose `request_id` is **not a string** is dropped with **no response**,
 * because no response is possible. A malformed request is denied with a synthesized
 * denial. An in-flight `request_id` is not dispatched twice.
 *
 * **The computer-folder and repository-trust tool names are configuration, not
 * constants.** The audit names neither tool, so the names come from the transport
 * layer that knows them. A request that carries a **folder path** where a
 * computer-folder prompt would carry one, but whose tool name is not the
 * configured one, is **refused**, not forwarded: an unrecognised prompt must never
 * be forwarded unvalidated. The computer-folder prompt is validated strictly:
 * exactly three string arguments, no CR, LF, U+2028 or U+2029 in the folder path or
 * the computer name, and a path **and a computer name** that must equal their own
 * normalized form.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The audit does not name the tool that carries the computer-folder prompt, so
 *     this implementation takes the name from the transport layer's configuration and refuses
 *     a prompt-shaped request whose name it does not know.
 *   - The three arguments of the computer-folder prompt are taken to be the folder
 *     path, the computer name and an opaque identifier.
 *   - **The narrowing of that refusal is a implementation choice, and it names a residual
 *     risk.** This implementation refuses a request only when it carries a **folder path**
 *     where a computer-folder prompt would carry one — three string arguments
 *     whose first is a path — so that a legitimate peer tool that happens to take
 *     three plain strings is not denied. The **residual risk**: a peer tool that
 *     takes a path and two more strings is still refused, and a computer-folder
 *     prompt whose folder path is a bare relative name (no separator, no drive
 *     letter) is not recognised as one and would be forwarded unvalidated. The
 *     implementation keeps the fail-closed behaviour for every request that carries a
 *     path, which is the case the rule exists for.
 *   - The approval prompt shows the **command text** as well as the resolved
 *     destinations: the resolved destination is what the kernel will act on, and
 *     the command text is what the user asked about. A prompt that shows only
 *     fabricated paths the user cannot verify is as bad as one that shows only a
 *     literal string.
 */

import path from 'node:path';

import type { HookDecisionValue } from '../extensions/hooks/runner.js';

import {
  describeReason,
  type PermissionDecision,
  type ToolContext,
  type ToolInputValidator,
} from './decision.js';
import {
  extractPrimaryValue,
  extractToolPath,
  resolvePathTargets,
  shellInvocation,
  shellSubCommandParts,
  shellSubCommandMutatesFiles,
} from './rules.js';

/**
 * The tool's own input validation.
 *
 * The type lives in the decision module, because the permission layer runs the
 * validator against the **effective** input; it is re-exported here so that a
 * caller of this module still finds it where it always was.
 */
export type { ToolInputValidator };

/** The result of validating a tool's arguments. */
export type ToolInputVerification = { ok: true } | { ok: false; message: string };

/**
 * Verify a tool's arguments.
 *
 * The verification is deliberately shallow — it checks that the arguments the tool
 * would act on are present and of the right shape — but it is enough to refuse a
 * call whose arguments cannot be checked at all.
 */
export function verifyToolInput(toolName: string, input: unknown): ToolInputVerification {
  if (toolName === 'WebFetch') {
    const url = readField(input, 'url');
    if (typeof url !== 'string' || url.length === 0) {
      return { ok: false, message: 'the url argument is missing' };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, message: `the url argument '${url}' is not a valid URL` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, message: `the url argument '${url}' is not an http(s) URL` };
    }
    return { ok: true };
  }

  if (toolName === 'Bash') {
    const command = readField(input, 'command');
    if (typeof command !== 'string' || command.trim().length === 0) {
      return { ok: false, message: 'the command argument is missing' };
    }
    return { ok: true };
  }

  const toolPath =
    readField(input, 'file_path') ?? readField(input, 'notebook_path') ?? readField(input, 'path');
  if (toolPath !== undefined) {
    if (typeof toolPath !== 'string' || toolPath.length === 0) {
      return { ok: false, message: 'the path argument is missing' };
    }
    return { ok: true };
  }

  return { ok: true };
}

function readField(input: unknown, field: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, field)) return undefined;
  return record[field];
}

/**
 * The safety check a `PermissionRequest` hook approval runs against.
 *
 * The check runs on the **rewritten** input, because that is the input the tool
 * would act on. A refusal is a `safetyCheck` and is never reported as a user
 * denial.
 */
export function safetyCheckForTool(ctx: ToolContext): PermissionDecision | undefined {
  const verification = verifyToolInput(ctx.toolName, ctx.input);
  if (verification.ok) return undefined;

  const reason =
    ctx.toolName === 'WebFetch'
      ? `The fetch arguments could not be verified, so nothing was fetched: ${verification.message}.`
      : `The ${ctx.toolName} arguments could not be verified: ${verification.message}.`;

  return {
    behavior: 'deny',
    source: 'hook',
    reasonType: 'safetyCheck',
    reasonKind: 'safetyCheck',
    reason,
  };
}

/**
 * The behaviors a hook's approval can carry.
 *
 * This is the **hooks module's** decision vocabulary, imported **type-only**.
 * The import is erased at compile time, so the permission layer does not depend
 * on the hooks module at runtime and the import cannot close a cycle: the hooks
 * module imports the permission layer, never the other way round.
 *
 * The `PermissionRequest` seam only ever sees `allow` and `deny` — the audit names
 * those two for a permission-request decision. The `PreToolUse` seam also
 * understands `ask` and `defer`.
 */
export type HookApprovalBehavior = HookDecisionValue;

/**
 * A hook's approval, in the shape the permission layer maps into a decision.
 *
 * The hooks module's `PermissionRequest` approval (`PermissionRequestHookApproval`)
 * is a **narrower** shape of this one, so it is assignable to it: the seam is
 * reused rather than duplicated.
 */
export interface HookApproval {
  /** The hook event name; it names the hook in the reason text. */
  hookEventName?: string;
  /** The hook's decision. */
  decision?: { behavior: HookApprovalBehavior; reason?: string };
  /** The rewritten tool input. */
  updatedInput?: unknown;
  /**
   * Whether a classifier may turn this approval into an allow.
   *
   * `false` marks an approval that must not be laundered by the auto-mode review.
   */
  classifierApprovable?: boolean;
}

/**
 * A `PermissionRequest` hook's approval.
 *
 * It is the **narrowing** of `HookApproval`: the `PermissionRequest` seam only
 * ever sees `allow` and `deny`, so its decision carries no `ask` and no `defer`.
 */
export interface PermissionRequestHookApproval extends HookApproval {
  /** The hook's decision. */
  decision?: { behavior: 'allow' | 'deny'; reason?: string };
}

/** The options the hook approval path runs with. */
export interface HookApprovalOptions {
  /** The safety check, run against the rewritten input. */
  safetyCheck?: (ctx: ToolContext) => PermissionDecision | undefined;
  /** The tool's own validator, run against the rewritten input. */
  validate?: ToolInputValidator;
  /**
   * The name of the hook event, used in the reason text.
   *
   * It defaults to `PermissionRequest`, the seam this module was written for.
   */
  hookName?: string;
}

/**
 * The outcome of checking a hook's rewritten input.
 *
 * The check runs on the **effective** input — the input the tool would act on —
 * because that is the input the tool's own validator and the safety check have to
 * judge.
 */
type RewriteCheck = { ok: true } | { ok: false; decision: PermissionDecision };

/**
 * Check the input a hook rewrote.
 *
 * The tool's own validator runs first: a rewritten input the tool rejects denies
 * the call, because the rewritten input is never executed. The safety check runs
 * next, on the same effective input: a refusal is a `safetyCheck`, never a user
 * denial.
 */
function checkRewrittenInput(
  hook: HookApproval,
  ctx: ToolContext,
  opts: HookApprovalOptions,
): RewriteCheck {
  const rewritten = hook.updatedInput !== undefined;
  const effective = rewritten ? hook.updatedInput : ctx.input;
  const effectiveCtx: ToolContext = { ...ctx, input: effective };

  // A rewritten input the tool's own validator rejects denies the call: the
  // rewritten input is never executed.
  if (opts.validate) {
    const validation = opts.validate(effective, effectiveCtx);
    if (!validation.ok) {
      const code = validation.errorCode === undefined ? '' : ` (error ${validation.errorCode})`;
      return {
        ok: false,
        decision: {
          behavior: 'deny',
          source: 'hook',
          reasonType: 'other',
          reason: `A hook rewrote the tool input and the tool rejected it${code}: ${validation.message}`,
        },
      };
    }
  }

  // The safety check runs on the rewritten input, because that is the input the
  // tool would act on.
  const safety = opts.safetyCheck?.(effectiveCtx);
  if (safety) {
    // The refusal is a safety check, never a user denial.
    return { ok: false, decision: { ...safety, source: 'hook' } };
  }

  return { ok: true };
}

/**
 * Apply a `PermissionRequest` hook approval to a tool call.
 *
 * Returns `undefined` when the hook did not decide anything, so the caller can
 * continue with the ordinary rule evaluation.
 */
export function applyPermissionRequestHook(
  hook: HookApproval | undefined,
  ctx: ToolContext,
  opts: HookApprovalOptions = {},
): PermissionDecision | undefined {
  if (!hook) return undefined;

  // The hook's own event name names it in the reason; the option overrides it.
  const hookName = opts.hookName ?? hook.hookEventName ?? 'PermissionRequest';
  const behavior = hook.decision?.behavior;
  if (behavior === 'deny') {
    return {
      behavior: 'deny',
      source: 'hook',
      reasonType: 'other',
      reason: hook.decision?.reason ?? `A ${hookName} hook denied this call.`,
    };
  }
  if (behavior !== 'allow') return undefined;

  const checked = checkRewrittenInput(hook, ctx, opts);
  if (!checked.ok) return checked.decision;

  const decision: PermissionDecision = {
    behavior: 'allow',
    source: 'hook',
    reasonType: 'other',
    reason: `A ${hookName} hook approved this call.`,
  };
  if (hook.updatedInput !== undefined) decision.updatedInput = hook.updatedInput;
  if (hook.classifierApprovable === false) decision.classifierApprovable = false;
  return decision;
}

/**
 * The `PreToolUse` seam of `checkPermission`.
 *
 * The returned callback is the `preToolUseHook` option of a permission check: it
 * runs the `PreToolUse` hooks for the tool call and maps their approval into the
 * permission decision vocabulary.
 *
 * **The shape adaptation lives here.** The hooks module's approval carries a
 * `decision.behavior` and nothing else — no `source`, no `reasonType`, no
 * `message` — so it is mapped into a `PermissionDecision` inside the permission
 * layer. The option's own type stays the plan's:
 * `(ctx: ToolContext) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>`.
 * A caller written against the plan therefore still works, and the hooks module's
 * `createPreToolUseApproval` plugs straight in.
 *
 * **The mapping is pure.** The tool's own validator and the safety check are the
 * **permission layer's** job: they judge the input the tool would act on, and
 * they run there **once** per call, against the **effective** input. A seam that
 * ran them itself would run them twice — once for the original call and once for
 * the re-check of the rewritten one — and a caller-supplied check that is not
 * idempotent would see four invocations per tool call.
 *
 * **An `ask` is the pending question** and **a `defer` is no opinion** — the
 * implementation's pick, pinned by `tests/contracts/permission-hook.test.ts`:
 *
 *   - an `ask` means the hook wants a human decision, and the permission
 *     vocabulary has an exact word for it, so the call becomes the question the
 *     prompt asks;
 *   - a `defer` has **no** word in the permission vocabulary — the decision
 *     behaviors are exactly `allow`, `deny` and `ask` — so it is an absence of
 *     opinion, and the normal permission path decides. Inventing a fourth
 *     behavior would break the closed vocabulary the target defines.
 */
export function createPreToolUseHook(opts: {
  /** The hook's own approval, or `undefined` when the hook did not decide. */
  approval: (ctx: ToolContext) => HookApproval | undefined | Promise<HookApproval | undefined>;
}): (ctx: ToolContext) => Promise<PermissionDecision | undefined> {
  return async (ctx: ToolContext) => {
    const approval = await opts.approval(ctx);
    if (approval === undefined) return undefined;

    const behavior = approval.decision?.behavior;
    // An approval without a decision expresses no opinion.
    if (behavior === undefined) return undefined;
    // A deferral is no opinion: the normal permission path decides.
    if (behavior === 'defer') return undefined;

    // The hook's own event name names it in the reason.
    const hookName = approval.hookEventName ?? 'PreToolUse';

    if (behavior === 'ask') {
      const reason =
        approval.decision?.reason ?? 'A PreToolUse hook asked for this call to be approved.';
      const decision: PermissionDecision = {
        behavior: 'ask',
        source: 'hook',
        reasonType: 'other',
        reason,
        message: reason,
      };
      if (approval.updatedInput !== undefined) decision.updatedInput = approval.updatedInput;
      if (approval.classifierApprovable === false) decision.classifierApprovable = false;
      return decision;
    }

    if (behavior === 'deny') {
      return {
        behavior: 'deny',
        source: 'hook',
        reasonType: 'other',
        reason: approval.decision?.reason ?? `A ${hookName} hook denied this call.`,
      };
    }

    const decision: PermissionDecision = {
      behavior: 'allow',
      source: 'hook',
      reasonType: 'other',
      reason: `A ${hookName} hook approved this call.`,
    };
    if (approval.updatedInput !== undefined) decision.updatedInput = approval.updatedInput;
    if (approval.classifierApprovable === false) decision.classifierApprovable = false;
    return decision;
  };
}

/**
 * The hook seam of `checkPermission`.
 *
 * The returned callback is the `hook` option of a permission check: it runs
 * **after** the deny list, so a hook approval can never override a deny rule, and
 * the check refuses a hook approval that would override an ask rule — or the
 * escalation of a compound command an allow rule covered only in part — as well.
 */
export function createPermissionRequestHook(opts: {
  /** The hook's own approval, or `undefined` when the hook did not decide. */
  approval: (
    ctx: ToolContext,
  ) => PermissionRequestHookApproval | undefined | Promise<PermissionRequestHookApproval | undefined>;
  /** The safety check, run against the rewritten input. */
  safetyCheck?: (ctx: ToolContext) => PermissionDecision | undefined;
  /** The tool's own validator, run against the rewritten input. */
  validate?: ToolInputValidator;
}): (ctx: ToolContext) => Promise<PermissionDecision | undefined> {
  return async (ctx: ToolContext) => {
    const approval = await opts.approval(ctx);
    return applyPermissionRequestHook(approval, ctx, {
      safetyCheck: opts.safetyCheck,
      validate: opts.validate,
    });
  };
}

/**
 * The input the tool receives.
 *
 * A hook that rewrote the input decides what runs; without a rewrite the original
 * input is used unchanged.
 */
export function effectiveInput(
  decision: PermissionDecision | undefined,
  original: unknown,
): unknown {
  if (!decision) return original;
  if (decision.updatedInput !== undefined) return decision.updatedInput;
  return original;
}

/** The approval prompt's inputs. */
export interface ApprovalPromptInput {
  toolName: string;
  input: unknown;
  decision: PermissionDecision;
  cwd?: string;
}

/**
 * The approval prompt.
 *
 * The prompt shows the **command text** and the **resolved** destination: the
 * resolved destination is what the kernel will act on (a prompt that shows the
 * literal string alone is a prompt that can be lied to by a symlink), and the
 * command text is what the user is being asked about.
 */
export function buildApprovalPrompt(input: ApprovalPromptInput): string {
  const { toolName, decision } = input;
  const ctx: ToolContext = {
    toolName,
    input: input.input,
    toolUseId: '',
    sessionId: '',
  };

  const parts: string[] = [`${toolName} wants to run this command.`];

  const command = extractPrimaryValue(ctx);
  if (command !== undefined) parts.push(command);

  const destinations = resolvedDestinations(ctx, input.cwd);
  if (destinations.length > 0) {
    const listed = destinations.map((destination) => `  ${destination}`).join('\n');
    parts.push(`The resolved destination is:\n${listed}`);
  }

  parts.push(describeReason(decision, toolName));
  return parts.join('\n\n');
}

/**
 * The resolved destinations of a call.
 *
 * For a file tool it is the resolved path; for a shell command it is the resolved
 * path of every redirection target and of every argument that is **plausibly a
 * path** — an argument of a file-mutating command, or an argument that names a
 * path. A URL, a flag and an ordinary word are not paths, and resolving them would
 * show the user paths that do not exist.
 */
export function resolvedDestinations(ctx: ToolContext, cwd?: string): string[] {
  const options = cwd === undefined ? {} : { cwd };
  const destinations: string[] = [];

  const toolPath = extractToolPath(ctx);
  if (toolPath !== undefined) {
    destinations.push(resolvePathTargets(toolPath, options).resolved);
    return destinations;
  }

  if (ctx.toolName === 'Bash') {
    const command = extractPrimaryValue(ctx);
    if (command === undefined) return destinations;
    for (const part of shellSubCommandParts(command)) {
      // A redirection target is always a path: the shell will write there.
      for (const redirect of part.redirects) {
        if (redirect.target === undefined) continue;
        destinations.push(resolvePathTargets(redirect.target, options).resolved);
      }
      const invocation = shellInvocation(part.text);
      const mutating = shellSubCommandMutatesFiles(part);
      for (const argument of invocation.args) {
        if (!isPlausiblePath(argument, mutating)) continue;
        destinations.push(resolvePathTargets(argument, options).resolved);
      }
    }
  }

  return destinations;
}

/**
 * Whether an argument is plausibly a filesystem path.
 *
 * A flag is not a path, a URL is not a path, and an ordinary word is not a path
 * either — resolving `https://example.com/x` would show the user
 * `/work/https:/example.com/x`, a path that does not exist. The arguments of a
 * file-mutating command are paths, because that command writes them.
 */
function isPlausiblePath(argument: string, mutating: boolean): boolean {
  if (argument.length === 0) return false;
  if (argument.startsWith('-')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(argument)) return false;
  if (mutating) return true;
  if (argument.startsWith('~') || argument.startsWith('.')) return true;
  return argument.includes('/');
}

/** The text of a remote permission prompt. */
export function buildPermissionPromptText(input: {
  toolName: string;
  description?: string;
  decisionReason?: string;
}): string {
  const parts: string[] = [`${input.toolName} requests permission.`];
  if (input.description) parts.push(input.description);
  if (input.decisionReason) parts.push(`Reason: ${input.decisionReason}`);
  return parts.join('\n');
}

// --- the remote transport dispatcher --------------------------------------------

/** A `can_use_tool` control request arriving from a remote peer. */
export interface CanUseToolRequest {
  subtype?: unknown;
  request_id?: unknown;
  tool_name?: unknown;
  input?: unknown;
  description?: unknown;
  decision_reason?: unknown;
}

/** The response the dispatcher sends back. */
export interface TransportPermissionResponse {
  subtype: 'success';
  request_id: string;
  response: {
    behavior: 'allow' | 'deny';
    updatedInput?: unknown;
    message?: string;
    decisionReason: { type: string; reason?: string };
  };
}

/** The outcome of dispatching one request. */
export type TransportDispatchResult =
  | { kind: 'dropped'; reason: string }
  | { kind: 'response'; response: TransportPermissionResponse };

/** The request the dispatcher hands to the permission handler. */
export interface TransportPermissionRequest {
  request_id: string;
  tool_name: string;
  input: unknown;
  prompt: string;
}

/** The options the dispatcher runs with. */
export interface TransportPermissionDispatcherOptions {
  /** Asks the user. Without it, every well-formed request is denied. */
  requestDecision?: (
    request: TransportPermissionRequest,
  ) => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string }>;
  /**
   * The tool that carries the computer-folder prompt.
   *
   * The name comes from the transport layer, which is the only place that knows
   * it. Without it, a request that looks like a computer-folder prompt is refused.
   */
  computerFolderTool?: string;
  /** The tool that carries the repository-trust prompt. */
  repositoryTrustTool?: string;
}

/** The remote permission dispatcher. */
export interface TransportPermissionDispatcher {
  /** Dispatch one request. */
  dispatch(request: CanUseToolRequest): Promise<TransportDispatchResult>;
  /** The request ids that are in flight. */
  inFlight(): readonly string[];
}

function dropped(reason: string): TransportDispatchResult {
  return { kind: 'dropped', reason };
}

function denialResponse(
  requestId: string,
  message: string,
  reason: string,
): TransportDispatchResult {
  return {
    kind: 'response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        behavior: 'deny',
        message,
        decisionReason: { type: 'other', reason },
      },
    },
  };
}

function hasForbiddenControlCharacter(value: string): boolean {
  return /[\r\n\u2028\u2029]/.test(value);
}

/**
 * Validate a computer-folder prompt.
 *
 * The prompt carries exactly three string arguments: the folder path, the computer
 * name and an opaque identifier. The path and the computer name may not contain a
 * CR, LF, U+2028 or U+2029, and **both** must equal their own normalized form.
 */
export function validateComputerFolderInput(
  input: unknown,
): { ok: true } | { ok: false; message: string; reason: string } {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      message: 'The computer-folder prompt needs exactly three string arguments.',
      reason: 'the computer-folder prompt input is not a list of three strings',
    };
  }
  if (input.length !== 3) {
    return {
      ok: false,
      message: 'The computer-folder prompt needs exactly three string arguments.',
      reason: 'the computer-folder prompt input does not have three arguments',
    };
  }
  for (const value of input) {
    if (typeof value !== 'string') {
      return {
        ok: false,
        message: 'The computer-folder prompt needs exactly three string arguments.',
        reason: 'the computer-folder prompt input has a non-string argument',
      };
    }
  }

  const folderPath = input[0] ?? '';
  const computerName = input[1] ?? '';

  if (hasForbiddenControlCharacter(folderPath) || hasForbiddenControlCharacter(computerName)) {
    return {
      ok: false,
      message: 'The computer-folder prompt carries a forbidden control character.',
      reason: 'the computer-folder prompt carries a CR, LF, U+2028 or U+2029',
    };
  }

  if (path.normalize(folderPath) !== folderPath) {
    return {
      ok: false,
      message: 'The computer-folder prompt carries a path that is not normalized.',
      reason: 'the computer-folder prompt path is not equal to its normalized form',
    };
  }

  if (path.normalize(computerName) !== computerName) {
    return {
      ok: false,
      message: 'The computer-folder prompt carries a computer name that is not normalized.',
      reason: 'the computer-folder prompt computer name is not equal to its normalized form',
    };
  }

  return { ok: true };
}

/**
 * Whether an input looks like a computer-folder prompt.
 *
 * The computer-folder prompt carries exactly three string arguments: the folder
 * path, the computer name and an opaque identifier. A request that carries a
 * **folder path** in that first position — three string arguments whose first one
 * is a path — is a computer-folder prompt whose tool name the dispatcher did not
 * recognise, and such a request is **refused** rather than forwarded unvalidated.
 *
 * The narrowing is the **path**: the folder path is the one field the kernel
 * would act on, so a request that carries no path has nothing to validate and is
 * not refused. That is what keeps the rule from denying a legitimate peer tool
 * that happens to take three plain strings.
 */
export function looksLikeComputerFolderInput(input: unknown): boolean {
  if (!Array.isArray(input) || input.length !== 3) return false;
  if (!input.every((value) => typeof value === 'string')) return false;
  const folderPath = input[0] ?? '';
  return isPathLike(folderPath);
}

/**
 * Whether a string is a **path**.
 *
 * A path is absolute, home-relative, a Windows drive path, or carries a path
 * separator.
 */
function isPathLike(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith('/') || value.startsWith('~')) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.includes('/') || value.includes('\\');
}

/**
 * Create the remote permission dispatcher.
 *
 * The dispatcher is the target's `TransportPermissionDispatcher`: it accepts only
 * the `can_use_tool` subtype, drops a request whose `request_id` is not a string
 * (no response is possible), denies a malformed request with a synthesized denial,
 * deduplicates by `request_id`, and validates the computer-folder and
 * repository-trust prompts.
 */
export function createTransportPermissionDispatcher(
  opts: TransportPermissionDispatcherOptions = {},
): TransportPermissionDispatcher {
  const computerFolderTool = opts.computerFolderTool;
  const repositoryTrustTool = opts.repositoryTrustTool;
  const inFlight = new Set<string>();

  const dispatch = async (request: CanUseToolRequest): Promise<TransportDispatchResult> => {
    if (typeof request !== 'object' || request === null) {
      return dropped('the request is not an object');
    }
    const record = request as Record<string, unknown>;

    // Only the `can_use_tool` subtype is accepted.
    if (record['subtype'] !== 'can_use_tool') {
      return dropped('the control-request subtype is not can_use_tool');
    }

    const requestId = record['request_id'];
    // A request id that is not a string is dropped with **no response**: the
    // response could not be correlated, so no response is possible.
    if (typeof requestId !== 'string') {
      return dropped('the request_id is not a string, so no response is possible');
    }

    if (inFlight.has(requestId)) {
      return dropped('the request_id is already in flight');
    }

    const toolName = record['tool_name'];
    if (typeof toolName !== 'string' || toolName.length === 0) {
      return denialResponse(
        requestId,
        'The permission request is malformed and was denied.',
        'the can_use_tool request is malformed',
      );
    }

    if (computerFolderTool !== undefined && toolName === computerFolderTool) {
      const validation = validateComputerFolderInput(record['input']);
      if (!validation.ok) {
        return denialResponse(requestId, validation.message, validation.reason);
      }
    } else if (looksLikeComputerFolderInput(record['input'])) {
      // The request looks like a computer-folder prompt, but its tool name is not
      // the configured one: it is refused rather than forwarded unvalidated.
      return denialResponse(
        requestId,
        'The request looks like a computer-folder prompt, but its tool name is not a configured computer-folder prompt.',
        'the request looks like a computer-folder prompt but its tool name is not configured',
      );
    }

    const description = record['description'];
    const decisionReason = record['decision_reason'];
    const prompt =
      repositoryTrustTool !== undefined && toolName === repositoryTrustTool
        ? `Do you trust this repository?\n\n${typeof description === 'string' ? description : ''}`
        : buildPermissionPromptText({
            toolName,
            description: typeof description === 'string' ? description : undefined,
            decisionReason: typeof decisionReason === 'string' ? decisionReason : undefined,
          });

    inFlight.add(requestId);
    try {
      const decision = opts.requestDecision
        ? await opts.requestDecision({
            request_id: requestId,
            tool_name: toolName,
            input: record['input'],
            prompt,
          })
        : { behavior: 'deny' as const, message: 'No permission handler is available.' };

      const response: TransportPermissionResponse = {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: decision.behavior,
          message: decision.message,
          decisionReason: {
            type: decision.behavior === 'allow' ? 'rule' : 'other',
            reason: decision.message,
          },
        },
      };
      if (decision.updatedInput !== undefined) response.response.updatedInput = decision.updatedInput;
      return { kind: 'response', response };
    } finally {
      inFlight.delete(requestId);
    }
  };

  return {
    dispatch,
    inFlight: () => [...inFlight],
  };
}
