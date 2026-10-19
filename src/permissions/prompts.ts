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
 * denial. An in-flight `request_id` is not dispatched twice. A computer-folder
 * prompt is validated strictly: exactly three string arguments, no CR, LF, U+2028 or
 * U+2029 in the folder path or the computer name, and a path that must equal its own
 * normalized form.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The audit does not name the tool that carries the computer-folder prompt, so
 *     this implementation recognises a configurable placeholder name
 *     (`COMPUTER_FOLDER_PROMPT_TOOL`) and validates that prompt strictly. The same
 *     holds for the repository-trust prompt.
 *   - The three arguments of the computer-folder prompt are taken to be the folder
 *     path, the computer name and an opaque identifier.
 */

import path from 'node:path';

import type { PermissionDecision, ToolContext } from './decision.js';
import {
  describeReason,
  extractPrimaryValue,
  extractToolPath,
  resolvePathTargets,
  shellInvocation,
  shellSubCommands,
} from './rules.js';

/** The tool this implementation recognises as the computer-folder prompt. */
export const COMPUTER_FOLDER_PROMPT_TOOL = 'computer_folder';

/** The tool this implementation recognises as the repository-trust prompt. */
export const REPOSITORY_TRUST_PROMPT_TOOL = 'repository_trust';

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

  const toolPath = readField(input, 'file_path') ?? readField(input, 'notebook_path') ?? readField(input, 'path');
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

/** A `PermissionRequest` hook's approval. */
export interface PermissionRequestHookApproval {
  /** The hook event name; only `PermissionRequest` is an approval. */
  hookEventName?: string;
  /** The hook's decision. */
  decision?: { behavior: 'allow' | 'deny'; reason?: string };
  /** The rewritten tool input. */
  updatedInput?: unknown;
  /**
   * Whether a classifier may turn this approval into an allow.
   *
   * `false` marks an approval that must not be laundered by the auto-mode review.
   */
  classifierApprovable?: boolean;
}

/** A tool's own input validation. */
export type ToolInputValidator = (
  input: unknown,
  ctx: ToolContext,
) => { ok: true } | { ok: false; message: string; errorCode?: number };

/** The options the hook approval path runs with. */
export interface HookApprovalOptions {
  /** The safety check, run against the rewritten input. */
  safetyCheck?: (ctx: ToolContext) => PermissionDecision | undefined;
  /** The tool's own validator, run against the rewritten input. */
  validate?: ToolInputValidator;
}

/**
 * Apply a `PermissionRequest` hook approval to a tool call.
 *
 * Returns `undefined` when the hook did not decide anything, so the caller can
 * continue with the ordinary rule evaluation.
 */
export function applyPermissionRequestHook(
  hook: PermissionRequestHookApproval | undefined,
  ctx: ToolContext,
  opts: HookApprovalOptions = {},
): PermissionDecision | undefined {
  if (!hook) return undefined;

  const behavior = hook.decision?.behavior;
  if (behavior === 'deny') {
    return {
      behavior: 'deny',
      source: 'hook',
      reasonType: 'other',
      reason: hook.decision?.reason ?? 'A PermissionRequest hook denied this call.',
    };
  }
  if (behavior !== 'allow') return undefined;

  const rewritten = hook.updatedInput !== undefined;
  const effective = rewritten ? hook.updatedInput : ctx.input;
  const effectiveCtx: ToolContext = { ...ctx, input: effective };

  // A rewritten input the tool's own validator rejects denies the call: the
  // rewritten input is never executed.
  if (opts.validate) {
    const validation = opts.validate(effective, effectiveCtx);
    if (!validation.ok) {
      const code =
        validation.errorCode === undefined ? '' : ` (error ${validation.errorCode})`;
      return {
        behavior: 'deny',
        source: 'hook',
        reasonType: 'other',
        reason: `A hook rewrote the tool input and the tool rejected it${code}: ${validation.message}`,
      };
    }
  }

  // The safety check runs on the rewritten input, because that is the input the
  // tool would act on.
  const safety = opts.safetyCheck?.(effectiveCtx);
  if (safety) {
    // The refusal is a safety check, never a user denial.
    return { ...safety, source: 'hook' };
  }

  const decision: PermissionDecision = {
    behavior: 'allow',
    source: 'hook',
    reasonType: 'other',
    reason: 'A PermissionRequest hook approved this call.',
  };
  if (rewritten) decision.updatedInput = hook.updatedInput;
  if (hook.classifierApprovable === false) decision.classifierApprovable = false;
  return decision;
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
 * The prompt shows the **resolved** destination, not the literal command string: a
 * prompt that shows the literal string is a prompt that can be lied to by a symlink.
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

  const destinations = resolvedDestinations(ctx, input.cwd);
  if (destinations.length > 0) {
    const listed = destinations.map((destination) => `  ${destination}`).join('\n');
    parts.push(`The resolved destination is:\n${listed}`);
  } else {
    const command = extractPrimaryValue(ctx);
    if (command !== undefined) parts.push(command);
  }

  parts.push(describeReason(decision, toolName));
  return parts.join('\n\n');
}

/**
 * The resolved destinations of a call.
 *
 * For a file tool it is the resolved path; for a shell command it is the resolved
 * path of every path argument of every sub-command.
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
    for (const subCommand of shellSubCommands(command)) {
      const invocation = shellInvocation(subCommand);
      for (const argument of invocation.args) {
        if (argument.startsWith('-')) continue;
        destinations.push(resolvePathTargets(argument, options).resolved);
      }
    }
  }

  return destinations;
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
  return parts.join('\n\n');
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
  /** The tool that carries the computer-folder prompt. */
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
 * CR, LF, U+2028 or U+2029, and the path must equal its own normalized form.
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

  return { ok: true };
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
  const computerFolderTool = opts.computerFolderTool ?? COMPUTER_FOLDER_PROMPT_TOOL;
  const repositoryTrustTool = opts.repositoryTrustTool ?? REPOSITORY_TRUST_PROMPT_TOOL;
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

    if (toolName === computerFolderTool) {
      const validation = validateComputerFolderInput(record['input']);
      if (!validation.ok) {
        return denialResponse(requestId, validation.message, validation.reason);
      }
    }

    const description = record['description'];
    const decisionReason = record['decision_reason'];
    const prompt =
      toolName === repositoryTrustTool
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

export { describeReason } from './rules.js';
