/**
 * The hook runner: the exit-code contract, the result merge, and the seams the
 * permission layer uses.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("Hook event
 * matrix", "Hook outputs", "Hook sources") and
 * `docs/compatibility/extension-surface.md` ("The result merge rules", "The
 * exit-code contract"), and the `CC-012` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## The exit-code contract
 *
 *   - `0` is **success**: the JSON the hook wrote is applied.
 *   - `2` is a **blocking error** on a blockable event: the operation is
 *     refused with the hook's own text as the reason.
 *   - **anything else** is a **non-blocking error**: a notice, and the session
 *     stays usable.
 *
 * ## The merge rules
 *
 * When two hook results are combined:
 *
 *   - a **permission decision** is merged by **strictness** — the stricter
 *     decision wins and the reason comes from the stricter one;
 *   - `additionalContext` and `watchPaths` are **concatenated**; every other
 *     member takes the newer value;
 *   - the block reason is `permissionDecisionReason`, or `Blocked by hook` when
 *     the hook denied without giving a reason;
 *   - an `allow` decision carrying `updatedPermissions` **maps each
 *     permission**, and a `setMode` permission's mode is **normalized** before
 *     it is applied;
 *   - when a hook result is merged into a permission-request result, the result
 *     carries `permissionBehavior`, `hookPermissionDecisionReason` and
 *     `permissionRequestResult`, and the `updatedInput` **only when the
 *     behavior is `allow`**.
 *
 * ## The hooks run in parallel, and the `mcp_tool` hook is skipped early
 *
 * All the matching hooks of an event run **in parallel**; the results are
 * returned in the order the hooks were registered, so the merge is
 * deterministic.
 *
 * `SessionStart` and every `Setup` event fire **before** the session's MCP
 * servers are available, so an `mcp_tool` hook is **skipped** there.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - **The command hook runs through `/bin/sh -c`**, and the payload is
 *     written to its standard input as one JSON document. The payload the
 *     target hands a hook is not pinned by the audit, and the standard input
 *     is the channel the target's hook scripts read.
 *   - **The default hook timeout is 60 seconds.** The audit does not name it.
 *   - **A hook of a handler type this implementation cannot execute** (`http`, `prompt`,
 *     `agent`) is registered and surfaced but **not dispatched**; the runner
 *     reports it as a non-blocking notice that names the handler type and the
 *     hook, so a hook the user configured is never dropped in silence.
 *   - **A command hook is run without a shell of this implementation's own making**: the
 *     command is the user's, and `/bin/sh -c` is the shell the target's hooks
 *     are written for.
 *   - **The severity of a failure** comes from the hook's specification, or
 *     from the JSON the hook wrote. A failure of severity `stop` denies every
 *     tool call for the session — the permission layer's host gate, which is
 *     implemented in `src/permissions/decision.ts` and is **not** duplicated
 *     here.
 *   - **Every failure message names the hook it came from** — its `id` when
 *     it has one, and its `command` otherwise — so a session with several
 *     hooks of one event says which of them failed.
 *   - **`blocked` is true exactly when the result carries a `deny` decision**,
 *     whether the hook denied by exiting with `2` or by writing a deny
 *     decision and exiting with `0`.
 *   - **The `updatedPermissions` update is a map or a list.** The map form
 *     maps a permission name to `allow`, `deny`, `ask` or `remove`; the list
 *     form carries `{ type, rule, target }` entries and the
 *     `{ type: 'setMode', mode }` entry. In the map form the key `mode` (or
 *     `setMode`) changes the **mode** when its value names one of the seven
 *     modes, and is a **permission rule named `mode`** otherwise — so a rule
 *     literally named `mode` can be expressed.
 *   - **A `PreToolUse` hook's `allow` never overrides a deny or an ask rule,
 *     and a `PreToolUse` hook's `deny` holds in every mode, including
 *     `bypassPermissions`.** The target changed this behaviour in a later
 *     release without a deprecation warning; this implementation picks the stricter
 *     reading and applies it to both the `PreToolUse` and the
 *     `PermissionRequest` seam.
 */

import { spawn } from 'node:child_process';

import {
  normalizePermissionMode,
  type HostHookFailure,
  type PermissionMode,
  type ToolContext,
} from '../../permissions/decision.js';
import type { PermissionRequestHookApproval } from '../../permissions/prompts.js';

import { matchToolName } from './matcher.js';
import type { HookEvent, HookHandlerType, HookSeverity, HookSpec } from './registry.js';
import {
  BLOCKABLE_EVENTS,
  buildHookPayload,
  effectiveHandlerType,
  isPlainObject,
  matcherSubject,
  mcpServersAvailable,
  parseHookOutput,
  readField,
  type HookContext,
  type HookJsonOutput,
  type HookPayload,
} from './schema.js';

export type { HookContext, HookJsonOutput, HookPayload } from './schema.js';

/** The default timeout of a hook, in milliseconds. */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/** The reason a hook that denied without giving one is blocked with. */
export const BLOCKED_BY_HOOK_REASON = 'Blocked by hook';

/** The decision values a hook can carry. */
export type HookDecisionValue = 'allow' | 'ask' | 'defer' | 'deny';

/**
 * The strictness of a permission decision.
 *
 * The audit's table is `allow: 1`, `ask: 2`, `deny: 3`: the **stricter**
 * decision wins a merge, and the reason comes from the stricter one.
 */
export const DECISION_STRICTNESS = { allow: 1, ask: 2, deny: 3 } as const;

/**
 * The rank of every decision value; the higher the stricter.
 *
 * The ranks are **derived** from the audit's strictness table: the three
 * values the audit names keep their strictness, and `defer` sits between
 * `ask` and `deny` — the plan's combination order (`deny > defer > ask >
 * allow`). The ranks are scaled by two so that `defer` has a rank of its own
 * without changing the audit's numbers.
 */
export const DECISION_RANKS: Readonly<Record<HookDecisionValue, number>> = {
  allow: DECISION_STRICTNESS.allow * 2,
  ask: DECISION_STRICTNESS.ask * 2,
  defer: DECISION_STRICTNESS.ask * 2 + 1,
  deny: DECISION_STRICTNESS.deny * 2,
};

/**
 * The result of one hook.
 *
 * The members the plan fixes are `hookEventName`, `additionalContext`,
 * `retry`, `decision`, `continue` and `stopReason`; the rest are this implementation's
 * additions and are all optional.
 */
export interface HookResult {
  /** The event the hook ran for. */
  hookEventName: HookEvent;
  /** The extra context the hook wants to add to the model's context. */
  additionalContext?: string;
  /** Whether the agent should retry. */
  retry?: boolean;
  /** The hook's decision, for a permission request. */
  decision?: { behavior: 'allow' | 'deny'; reason?: string };
  /** Whether the session should continue. */
  continue?: boolean;
  /** The reason the session stopped. */
  stopReason?: string;
  /** The `PreToolUse` permission decision. */
  permissionDecision?: HookDecisionValue;
  /** The reason of the permission decision. */
  permissionDecisionReason?: string;
  /** The rewritten tool input. */
  updatedInput?: unknown;
  /** The paths the hook wants to watch. */
  watchPaths?: string[];
  /** The permissions the hook wants to change. */
  updatedPermissions?: unknown;
  /** The permission map the hook's updates were applied to. */
  permissions?: HookPermissionMap;
  /** The severity of a failure. */
  severity?: HookSeverity;
  /** The failure message. */
  error?: string;
  /** The exit code of the hook. */
  exitCode?: number;
  /** Whether the hook blocked the operation. */
  blocked?: boolean;
  /** The message the hook wants to show the user. */
  systemMessage?: string;
  /** The event-specific output the hook wrote. */
  hookSpecificOutput?: Record<string, unknown>;
  /** The `Elicitation` action. */
  action?: 'accept' | 'decline' | 'cancel';
  /** The `Elicitation` content. */
  content?: unknown;
  /** The permission request's own result. */
  permissionRequestResult?: unknown;
}

/** The outcome of running one hook. */
export interface HookCommandOutcome {
  /** The exit code of the hook. */
  exitCode: number;
  /** What the hook wrote to its standard output. */
  stdout: string;
  /** What the hook wrote to its standard error. */
  stderr: string;
  /** Whether the hook timed out. */
  timedOut?: boolean;
  /** Whether the hook could not be run at all. */
  failed?: boolean;
  /** Whether the hook was aborted. */
  aborted?: boolean;
  /**
   * Whether the hook reported an error.
   *
   * An `mcp_tool` hook's tool result carries `isError`, and it means the same
   * thing as a non-zero exit code of a command hook: a **non-blocking** error.
   */
  isError?: boolean;
  /** The signal that killed the hook. */
  signal?: string;
}

/** How one hook is run. */
export type HookRunner = (
  spec: HookSpec,
  payload: HookPayload,
  signal?: AbortSignal,
) => Promise<HookCommandOutcome>;

/** The options the runner runs with. */
export interface RunHooksOptions {
  /** The common fields of the payload. */
  context?: HookContext;
  /** How a `command` hook is run. Without it, the hook is run as a process. */
  runCommand?: HookRunner;
  /** How an `mcp_tool` hook is run. Without it, an `mcp_tool` hook cannot run. */
  callMcpTool?: HookRunner;
  /** The working directory of a command hook. */
  cwd?: string;
  /** The default timeout of a hook. */
  timeoutMs?: number;
  /** The permission map the hook's updates are applied to. */
  permissions?: HookPermissionMap;
}

/**
 * The permission state a hook may change.
 *
 * The three lists are the permission rule lists; the mode is the session's
 * permission mode.
 */
export interface HookPermissionMap {
  /** The allow rules. */
  allow: string[];
  /** The deny rules. */
  deny: string[];
  /** The ask rules. */
  ask: string[];
  /** The session's permission mode. */
  mode?: PermissionMode;
}

/** An empty permission map. */
export function emptyPermissionMap(): HookPermissionMap {
  return { allow: [], deny: [], ask: [] };
}

/** The permission modes a `setMode` update may name. */
const PERMISSION_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  'default',
  'manual',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto',
  'dontAsk',
]);

/**
 * Run the hooks of an event.
 *
 * The matching hooks run **in parallel**, and the results come back in the
 * order the hooks were given.
 *
 * A hook whose handler type this implementation does not dispatch is **not** dropped in
 * silence: it produces a non-blocking result that names the handler type and
 * the hook.
 */
export async function runHooks(
  specs: readonly HookSpec[],
  event: HookEvent,
  input: unknown,
  signal?: AbortSignal,
  options: RunHooksOptions = {},
): Promise<HookResult[]> {
  const payload = buildHookPayload(event, input, options.context);
  const subject = matcherSubject(event, payload);

  const matching = specs.filter((spec) => {
    if (spec.event !== event) return false;
    if (spec.matcher === undefined) return true;
    // A matcher needs a subject: without one there is nothing to match.
    if (subject === undefined) return false;
    return matchToolName(spec.matcher, subject);
  });

  const outcomes = await Promise.all(
    matching.map((spec) => {
      const handler = effectiveHandlerType(spec);
      if (!isDispatchable(handler)) {
        return Promise.resolve(undispatchedResult(event, spec, handler));
      }
      return runOne(spec, event, payload, signal, options);
    }),
  );
  return outcomes.filter((result): result is HookResult => result !== undefined);
}

/** Whether this implementation can dispatch a hook of this handler type. */
function isDispatchable(handler: HookHandlerType): boolean {
  return handler === 'command' || handler === 'mcp_tool';
}

/**
 * The result of a hook this implementation does not dispatch.
 *
 * The hook is **reported**, not dropped: the message names the handler type
 * and the hook, so a hook the user configured is never silently ignored.
 */
function undispatchedResult(
  event: HookEvent,
  spec: HookSpec,
  handler: HookHandlerType,
): HookResult {
  const result: HookResult = { hookEventName: event };
  result.severity = 'warning';
  result.error =
    `The '${handler}' handler type is not dispatched by this implementation, so the hook ${hookName(spec)} did not run.`;
  result.blocked = false;
  result.continue = true;
  return result;
}

/**
 * The name of a hook, for the messages the runner writes.
 *
 * It is the hook's `id` when it has one, and its `command` otherwise.
 */
function hookName(spec: HookSpec): string {
  const id = spec.id;
  if (typeof id === 'string' && id.length > 0) return `'${id}'`;
  return `'${spec.command}'`;
}

async function runOne(
  spec: HookSpec,
  event: HookEvent,
  payload: HookPayload,
  signal: AbortSignal | undefined,
  options: RunHooksOptions,
): Promise<HookResult | undefined> {
  const handler = effectiveHandlerType(spec);

  if (handler === 'mcp_tool') {
    // The MCP servers are not up yet at these events, so the hook is skipped.
    if (!mcpServersAvailable(event)) return undefined;
    const runner = options.callMcpTool;
    if (!runner) {
      const result: HookResult = { hookEventName: event };
      result.severity = 'error';
      result.error = `The mcp_tool hook ${hookName(spec)} could not run: no MCP server connection is available.`;
      result.continue = true;
      result.blocked = false;
      return result;
    }
    const outcome = await runner(spec, payload, signal);
    return interpretOutcome(event, spec, outcome);
  }

  const runner = options.runCommand;
  const outcome = runner
    ? await runner(spec, payload, signal)
    : await spawnHookCommand(spec, payload, signal, options);
  return interpretOutcome(event, spec, outcome);
}

/**
 * Turn the outcome of a hook into a result.
 *
 * The exit-code contract decides everything: `0` applies the JSON the hook
 * wrote, `2` blocks a blockable event, and anything else is a notice.
 */
function interpretOutcome(
  event: HookEvent,
  spec: HookSpec,
  outcome: HookCommandOutcome,
): HookResult {
  const result: HookResult = { hookEventName: event };

  if (outcome.exitCode === 0 && outcome.isError !== true) {
    result.exitCode = 0;
    const json = parseHookOutput(outcome.stdout);
    if (json) applyJson(result, json);
    // The hook blocked the operation exactly when it denied it, whichever way
    // it denied.
    result.blocked = effectiveDecision(result)?.value === 'deny';
    return result;
  }

  const reason = failureReason(spec, outcome);
  result.exitCode = outcome.exitCode;
  result.error = reason.message;
  result.severity = spec.severity ?? 'error';

  if (outcome.exitCode === 2 && outcome.isError !== true && BLOCKABLE_EVENTS.includes(event)) {
    // A blocking error: the operation is refused.
    result.blocked = true;
    result.continue = false;
    result.decision = { behavior: 'deny', reason: reason.text };
    result.permissionDecision = 'deny';
    result.permissionDecisionReason = reason.text;
    return result;
  }

  // A non-blocking error: a notice, and the session stays usable.
  result.blocked = false;
  result.continue = true;
  return result;
}

/**
 * The text of a failure, and the message that names the hook.
 */
interface FailureReason {
  /** The hook's own text, when it wrote one. */
  text: string;
  /** The message, which always names the hook. */
  message: string;
}

/**
 * The text of a failure.
 *
 * The message always **names the hook**: its `id` when it has one, and its
 * `command` otherwise. The hook's own text — what it wrote to its standard
 * error or its standard output — is the *reason* of the failure and is kept
 * apart from the message, because the block reason is the hook's own text.
 */
function failureReason(spec: HookSpec, outcome: HookCommandOutcome): FailureReason {
  const name = hookName(spec);
  const stderr = outcome.stderr.trim();
  const stdout = outcome.stdout.trim();

  if (outcome.aborted === true) {
    const text = 'The hook was aborted.';
    return {
      text,
      message:
        stderr.length > 0
          ? `The hook ${name} was aborted: ${stderr}`
          : `The hook ${name} was aborted.`,
    };
  }

  if (outcome.timedOut === true) {
    const text = 'The hook timed out.';
    return {
      text,
      message:
        stderr.length > 0
          ? `The hook ${name} timed out: ${stderr}`
          : `The hook ${name} timed out.`,
    };
  }

  if (stderr.length > 0) {
    return { text: stderr, message: `The hook ${name} failed: ${stderr}` };
  }
  if (stdout.length > 0) {
    return { text: stdout, message: `The hook ${name} failed: ${stdout}` };
  }
  if (outcome.failed === true) {
    const text = 'The hook could not be run.';
    return { text, message: `The hook ${name} could not be run.` };
  }
  const text = `The hook exited with code ${outcome.exitCode}.`;
  return { text, message: `The hook ${name} exited with code ${outcome.exitCode}.` };
}

/** Apply the JSON a hook wrote to its result. */
function applyJson(result: HookResult, json: HookJsonOutput): void {
  const record = json as unknown as Record<string, unknown>;

  const continues = readField(record, 'continue');
  if (typeof continues === 'boolean') result.continue = continues;

  const stopReason = readField(record, 'stopReason');
  if (typeof stopReason === 'string') result.stopReason = stopReason;

  const systemMessage = readField(record, 'systemMessage');
  if (typeof systemMessage === 'string') result.systemMessage = systemMessage;

  const additionalContext = readField(record, 'additionalContext');
  if (typeof additionalContext === 'string') result.additionalContext = additionalContext;

  const retry = readField(record, 'retry');
  if (typeof retry === 'boolean') result.retry = retry;

  const severity = readField(record, 'severity');
  if (isSeverity(severity)) result.severity = severity;

  const reason = readField(record, 'reason');
  const decision = readField(record, 'decision');
  if (typeof decision === 'string') {
    if (decision === 'block') {
      result.decision = {
        behavior: 'deny',
        ...(typeof reason === 'string' ? { reason } : {}),
      };
    } else if (decision === 'approve') {
      result.decision = { behavior: 'allow' };
    }
  } else if (isPlainObject(decision)) {
    const behavior = readField(decision, 'behavior');
    if (behavior === 'allow' || behavior === 'deny') {
      const decisionReason = readField(decision, 'reason');
      result.decision = {
        behavior,
        ...(typeof decisionReason === 'string' ? { reason: decisionReason } : {}),
      };
    }
  }

  if (Object.hasOwn(record, 'updatedInput')) {
    result.updatedInput = record['updatedInput'];
  }

  const watchPaths = readField(record, 'watchPaths');
  if (Array.isArray(watchPaths)) {
    result.watchPaths = watchPaths.filter((entry): entry is string => typeof entry === 'string');
  }

  if (Object.hasOwn(record, 'updatedPermissions')) {
    result.updatedPermissions = record['updatedPermissions'];
  }

  if (Object.hasOwn(record, 'permissionRequestResult')) {
    result.permissionRequestResult = record['permissionRequestResult'];
  }

  const specific = readField(record, 'hookSpecificOutput');
  if (isPlainObject(specific)) {
    result.hookSpecificOutput = specific;

    const permissionDecision = readField(specific, 'permissionDecision');
    if (
      permissionDecision === 'allow' ||
      permissionDecision === 'deny' ||
      permissionDecision === 'ask' ||
      permissionDecision === 'defer'
    ) {
      result.permissionDecision = permissionDecision;
    }

    const permissionDecisionReason = readField(specific, 'permissionDecisionReason');
    if (typeof permissionDecisionReason === 'string') {
      result.permissionDecisionReason = permissionDecisionReason;
    }

    if (Object.hasOwn(specific, 'updatedInput')) {
      result.updatedInput = specific['updatedInput'];
    }

    const action = readField(specific, 'action');
    if (action === 'accept' || action === 'decline' || action === 'cancel') {
      result.action = action;
    }

    const content = readField(specific, 'content');
    if (content !== undefined) {
      result.content = content;
    }
  }
}

function isSeverity(value: unknown): value is HookSeverity {
  return value === 'info' || value === 'warning' || value === 'error' || value === 'stop';
}

/**
 * Run a command hook as a process.
 *
 * The payload is written to the hook's standard input as one JSON document,
 * and the hook's standard output and standard error are collected.
 */
async function spawnHookCommand(
  spec: HookSpec,
  payload: HookPayload,
  signal: AbortSignal | undefined,
  options: RunHooksOptions,
): Promise<HookCommandOutcome> {
  const timeoutMs = spec.timeoutMs ?? options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const payloadCwd = readField(payload as unknown as Record<string, unknown>, 'cwd');
  const cwd = options.cwd ?? (typeof payloadCwd === 'string' ? payloadCwd : undefined);

  return new Promise<HookCommandOutcome>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const finish = (outcome: HookCommandOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // The abort listener is removed when the hook finishes: it closes over
      // the child process and its captured output, and an `AbortSignal` has no
      // `setMaxListeners`, so a listener that stayed would leak for the life
      // of the session.
      if (abortListener !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', abortListener);
        abortListener = undefined;
      }
      resolve(outcome);
    };

    let child;
    try {
      child = spawn('/bin/sh', ['-c', spec.command], {
        ...(cwd === undefined ? {} : { cwd }),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        exitCode: -1,
        stdout: '',
        stderr: `could not be started: ${String(error)}`,
        failed: true,
      });
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error: Error) => {
      finish({
        exitCode: -1,
        stdout,
        stderr: stderr.length > 0 ? `${stderr}\n${error.message}` : error.message,
        failed: true,
      });
    });

    child.on('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
      finish({
        exitCode: code ?? (closeSignal === null ? 0 : 128),
        stdout,
        stderr,
        ...(closeSignal === null ? {} : { signal: closeSignal }),
      });
    });

    // The hook may exit before it reads its input, so a broken pipe is not an
    // error of this implementation's own making.
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.end(`${JSON.stringify(payload)}\n`);
    } catch {
      // The pipe is already closed; the hook's exit code decides the outcome.
    }

    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        exitCode: -1,
        stdout,
        stderr,
        timedOut: true,
      });
    }, timeoutMs);

    if (signal) {
      const abort = (): void => {
        child.kill('SIGKILL');
        finish({
          exitCode: -1,
          stdout,
          stderr,
          failed: true,
          aborted: true,
        });
      };
      if (signal.aborted) abort();
      else {
        signal.addEventListener('abort', abort, { once: true });
        abortListener = abort;
      }
    }
  });
}

// --- the merge -------------------------------------------------------------------

/** The decision a result carries, with its reason. */
interface EffectiveDecision {
  value: HookDecisionValue;
  reason?: string;
}

/** The decision a result carries, if it carries one. */
function effectiveDecision(result: HookResult): EffectiveDecision | undefined {
  if (result.permissionDecision !== undefined) {
    // The reason belongs to the decision that carries it: a result whose
    // `permissionDecision` is set takes its reason from
    // `permissionDecisionReason` and from nowhere else, so the reason of a
    // looser decision can never survive a merge.
    const reason = result.permissionDecisionReason;
    return reason === undefined
      ? { value: result.permissionDecision }
      : { value: result.permissionDecision, reason };
  }
  const behavior = result.decision?.behavior;
  if (behavior === undefined) return undefined;
  const reason = result.decision?.reason;
  return reason === undefined ? { value: behavior } : { value: behavior, reason };
}

/** The rank of a decision value; the higher the stricter. */
function decisionRank(value: HookDecisionValue): number {
  return DECISION_RANKS[value];
}

/** The stricter of two decisions. */
function stricterDecision(
  left: EffectiveDecision | undefined,
  right: EffectiveDecision | undefined,
): EffectiveDecision | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return decisionRank(right.value) > decisionRank(left.value) ? right : left;
}

/**
 * Apply a result's own decision to it.
 *
 * The decision a result carries is either the `permissionDecision` or the
 * `decision`'s behavior; the two are kept in step, and the reason comes from
 * the decision that carries it.
 */
function withDecision(result: HookResult): HookResult {
  const decision = effectiveDecision(result);
  if (decision === undefined) return result;
  const merged: HookResult = { ...result };
  merged.permissionDecision = decision.value;
  if (decision.reason === undefined) {
    delete merged.permissionDecisionReason;
  } else {
    merged.permissionDecisionReason = decision.reason;
  }
  if (decision.value === 'allow' || decision.value === 'deny') {
    merged.decision = {
      behavior: decision.value,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    };
  } else {
    delete merged.decision;
  }
  return merged;
}

/**
 * Merge two hook results.
 *
 * The decision is merged by **strictness** and the reason comes from the
 * stricter one; `additionalContext` and `watchPaths` are **concatenated**;
 * every other member takes the newer value.
 */
function mergeTwo(older: HookResult, newer: HookResult): HookResult {
  const merged: HookResult = { ...older };

  const winner = stricterDecision(effectiveDecision(older), effectiveDecision(newer));
  if (winner !== undefined) {
    merged.permissionDecision = winner.value;
    if (winner.reason === undefined) {
      // The reason comes from the stricter decision, so the looser one's reason
      // does not survive.
      delete merged.permissionDecisionReason;
    } else {
      merged.permissionDecisionReason = winner.reason;
    }
  }

  if (newer.additionalContext !== undefined) {
    merged.additionalContext =
      older.additionalContext === undefined
        ? newer.additionalContext
        : `${older.additionalContext}\n${newer.additionalContext}`;
  }

  if (newer.watchPaths !== undefined) {
    merged.watchPaths =
      older.watchPaths === undefined ? [...newer.watchPaths] : [...older.watchPaths, ...newer.watchPaths];
  }

  if (newer.retry !== undefined) merged.retry = newer.retry;
  if (newer.continue !== undefined) merged.continue = newer.continue;
  if (newer.stopReason !== undefined) merged.stopReason = newer.stopReason;
  if (newer.updatedInput !== undefined) merged.updatedInput = newer.updatedInput;
  if (newer.updatedPermissions !== undefined) merged.updatedPermissions = newer.updatedPermissions;
  if (newer.severity !== undefined) merged.severity = newer.severity;
  if (newer.error !== undefined) merged.error = newer.error;
  if (newer.exitCode !== undefined) merged.exitCode = newer.exitCode;
  if (newer.blocked !== undefined) merged.blocked = newer.blocked;
  if (newer.systemMessage !== undefined) merged.systemMessage = newer.systemMessage;
  if (newer.hookSpecificOutput !== undefined) merged.hookSpecificOutput = newer.hookSpecificOutput;
  if (newer.action !== undefined) merged.action = newer.action;
  if (newer.content !== undefined) merged.content = newer.content;
  if (newer.permissionRequestResult !== undefined) {
    merged.permissionRequestResult = newer.permissionRequestResult;
  }

  return merged;
}

/**
 * Merge a group of hook results into one.
 *
 * The rules are the compatibility table's: the decision is merged by
 * strictness, the context lists are concatenated, and the block reason is
 * `permissionDecisionReason` — or `Blocked by hook` when the hook denied
 * without giving a reason.
 */
export function mergeHookResults(
  results: readonly HookResult[],
  options: { permissions?: HookPermissionMap } = {},
): HookResult | undefined {
  if (results.length === 0) return undefined;
  const first = results[0];
  if (first === undefined) return undefined;

  let merged: HookResult = { ...first };
  for (let i = 1; i < results.length; i += 1) {
    const next = results[i];
    if (next === undefined) continue;
    merged = mergeTwo(merged, next);
  }

  // The decision and its reason are kept in step, whether there was one result
  // or several.
  merged = withDecision(merged);

  // The operation is blocked exactly when the merged decision denies it.
  merged.blocked = effectiveDecision(merged)?.value === 'deny';

  const decision = effectiveDecision(merged);
  if (decision?.value === 'deny') {
    // The block reason is the hook's own reason, or `Blocked by hook` when the
    // hook denied without giving one.
    const reason = merged.permissionDecisionReason ?? BLOCKED_BY_HOOK_REASON;
    merged.permissionDecisionReason = reason;
    merged.decision = { behavior: 'deny', reason };
  }

  if (decision?.value === 'allow' && merged.updatedPermissions !== undefined) {
    merged.permissions = applyUpdatedPermissions(
      options.permissions ?? emptyPermissionMap(),
      merged.updatedPermissions,
    );
  }

  return merged;
}

/**
 * Apply a hook's permission updates to a permission map.
 *
 * The updates are read tolerantly: a **map** of permission names to values, or
 * a **list** of updates. A `setMode` update's mode is **normalized** before it
 * is applied, so the `manual` alias of `default` is stored as `default`; a
 * mode that is not one of the six is refused and the mode is left alone.
 *
 * In the **map** form the key `mode` (or `setMode`) changes the mode when its
 * value names one of the seven modes, and is a **permission rule named
 * `mode`** otherwise — so a rule literally named `mode` can be expressed.
 */
export function applyUpdatedPermissions(base: HookPermissionMap, updates: unknown): HookPermissionMap {
  const map: HookPermissionMap = {
    allow: [...base.allow],
    deny: [...base.deny],
    ask: [...base.ask],
  };
  if (base.mode !== undefined) map.mode = base.mode;

  if (Array.isArray(updates)) {
    for (const update of updates) applyUpdate(map, update);
    return map;
  }

  if (isPlainObject(updates)) {
    for (const key of Object.keys(updates)) {
      if (key === '__proto__') continue;
      const value = updates[key];
      if ((key === 'mode' || key === 'setMode') && typeof value === 'string') {
        if (PERMISSION_MODES.has(value)) {
          setMode(map, value);
          continue;
        }
        // The value does not name a mode, so the key is a permission rule
        // named `mode` — and it is handled like any other rule below.
      }
      if (value === 'remove') {
        removeRule(map, key);
        continue;
      }
      if (value === 'allow' || value === 'deny' || value === 'ask') {
        addRule(map, key, value);
      }
    }
  }

  return map;
}

function applyUpdate(map: HookPermissionMap, update: unknown): void {
  if (!isPlainObject(update)) return;
  const type = readField(update, 'type');
  if (type === 'setMode') {
    const mode = readField(update, 'mode');
    if (typeof mode === 'string') setMode(map, mode);
    return;
  }
  const rule = readField(update, 'rule');
  if (typeof rule !== 'string' || rule.length === 0) return;
  const target = readField(update, 'target') ?? readField(update, 'list') ?? readField(update, 'source');
  const list = target === 'deny' || target === 'ask' || target === 'allow' ? target : 'allow';
  if (type === 'remove') removeRule(map, rule, list);
  else if (type === 'add') addRule(map, rule, list);
}

function addRule(map: HookPermissionMap, rule: string, list: 'allow' | 'deny' | 'ask'): void {
  if (map[list].includes(rule)) return;
  map[list].push(rule);
}

function removeRule(map: HookPermissionMap, rule: string, list?: 'allow' | 'deny' | 'ask'): void {
  const lists: ('allow' | 'deny' | 'ask')[] = list === undefined ? ['allow', 'deny', 'ask'] : [list];
  for (const each of lists) {
    const index = map[each].indexOf(rule);
    if (index < 0) continue;
    map[each].splice(index, 1);
  }
}

/** Apply a mode, normalizing it first. */
function setMode(map: HookPermissionMap, mode: string): void {
  if (!PERMISSION_MODES.has(mode)) return;
  map.mode = normalizePermissionMode(mode as PermissionMode);
}

// --- the permission seams --------------------------------------------------------

/** The result of a permission request, as a hook's result is merged into it. */
export interface PermissionRequestResult {
  /** The behavior the hook decided. */
  permissionBehavior?: 'allow' | 'deny';
  /** The hook's reason. */
  hookPermissionDecisionReason?: string;
  /** The permission request's own result. */
  permissionRequestResult?: unknown;
  /** The rewritten input — only when the behavior is `allow`. */
  updatedInput?: unknown;
}

/**
 * Merge a hook's result into a permission request's result.
 *
 * The result carries `permissionBehavior`, `hookPermissionDecisionReason` and
 * `permissionRequestResult`, and the `updatedInput` **only when the behavior
 * is `allow`**.
 */
export function mergePermissionRequestResult(
  hook: HookResult,
  request: PermissionRequestResult = {},
): PermissionRequestResult {
  const decision = effectiveDecision(hook);
  if (decision === undefined) return { ...request };
  if (decision.value !== 'allow' && decision.value !== 'deny') return { ...request };

  const merged: PermissionRequestResult = { ...request };
  merged.permissionBehavior = decision.value;
  if (decision.reason !== undefined) {
    merged.hookPermissionDecisionReason = decision.reason;
  }
  const raw = hook.permissionRequestResult ?? request.permissionRequestResult;
  if (raw !== undefined) merged.permissionRequestResult = raw;

  if (decision.value === 'allow') {
    if (hook.updatedInput !== undefined) merged.updatedInput = hook.updatedInput;
  } else {
    delete merged.updatedInput;
  }

  return merged;
}

/**
 * The approval a group of hook results carries.
 *
 * The approval is the shape `createPermissionRequestHook` expects, so the
 * permission seam is **reused** rather than duplicated.
 */
export function mergePermissionRequestApproval(
  results: readonly HookResult[],
): PermissionRequestHookApproval | undefined {
  return mergeHookApproval(results, 'PermissionRequest');
}

/**
 * The approval a group of `PreToolUse` hook results carries.
 *
 * The shape is the same as the permission-request approval: the seam is
 * **reused** rather than duplicated.
 */
export function mergePreToolUseApproval(
  results: readonly HookResult[],
): PermissionRequestHookApproval | undefined {
  return mergeHookApproval(results, 'PreToolUse');
}

/** The approval a group of hook results carries, for one event. */
function mergeHookApproval(
  results: readonly HookResult[],
  event: HookEvent,
): PermissionRequestHookApproval | undefined {
  const merged = mergeHookResults(results);
  if (!merged) return undefined;
  const decision = effectiveDecision(merged);
  if (decision === undefined) return undefined;
  if (decision.value !== 'allow' && decision.value !== 'deny') return undefined;

  const approval: PermissionRequestHookApproval = {
    hookEventName: event,
    decision: {
      behavior: decision.value,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    },
  };
  if (merged.updatedInput !== undefined) approval.updatedInput = merged.updatedInput;
  return approval;
}

/**
 * The approval callback of the permission seam.
 *
 * The returned callback is the `approval` option of
 * `createPermissionRequestHook` in `src/permissions/prompts.ts`: it runs the
 * `PermissionRequest` hooks for the tool call and returns the strictest
 * decision they made.
 */
export function createHookApproval(
  specs: readonly HookSpec[],
  options: RunHooksOptions = {},
): (ctx: ToolContext) => Promise<PermissionRequestHookApproval | undefined> {
  return async (ctx: ToolContext): Promise<PermissionRequestHookApproval | undefined> => {
    const results = await runHooks(
      specs,
      'PermissionRequest',
      {
        tool_name: ctx.toolName,
        tool_input: ctx.input,
        tool_use_id: ctx.toolUseId,
        session_id: ctx.sessionId,
      },
      undefined,
      options,
    );
    return mergePermissionRequestApproval(results);
  };
}

/**
 * The approval callback of the `PreToolUse` seam.
 *
 * The returned callback is the `approval` option of
 * `createPermissionRequestHook` in `src/permissions/prompts.ts`: it runs the
 * `PreToolUse` hooks for the tool call and returns the strictest decision they
 * made.
 *
 * The precedence of the decision is the **permission layer's**, not this
 * module's: the seam is wired into `checkPermission` **after the deny list**
 * and **before the prompt**, so a `PreToolUse` hook's `allow` never overrides
 * a deny rule or an ask rule, and a `PreToolUse` hook's `deny` holds in every
 * mode, `bypassPermissions` included. This implementation picks the stricter of the
 * target's two behaviours and documents the choice.
 */
export function createPreToolUseApproval(
  specs: readonly HookSpec[],
  options: RunHooksOptions = {},
): (ctx: ToolContext) => Promise<PermissionRequestHookApproval | undefined> {
  return async (ctx: ToolContext): Promise<PermissionRequestHookApproval | undefined> => {
    const results = await runHooks(
      specs,
      'PreToolUse',
      {
        tool_name: ctx.toolName,
        tool_input: ctx.input,
        tool_use_id: ctx.toolUseId,
        session_id: ctx.sessionId,
      },
      undefined,
      options,
    );
    return mergePreToolUseApproval(results);
  };
}

/**
 * The host-level failure a group of hook results carries.
 *
 * A failure of severity `stop` denies every tool call for the session; the
 * permission layer implements that gate, and this function only reports it.
 */
export function hookFailureFromResults(results: readonly HookResult[]): HostHookFailure | undefined {
  for (const result of results) {
    if (result.severity !== 'stop') continue;
    return {
      severity: 'stop',
      ...(result.error === undefined ? {} : { message: result.error }),
    };
  }
  return undefined;
}
