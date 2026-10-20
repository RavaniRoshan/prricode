/**
 * The agent runtime: the turn cycle, the permission integration, the abort path
 * and the persistence of everything the turn produces.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch), §2.5 (Permissions) and §2.6 (Sessions, persistence, and resumption),
 * and the `CC-010` and `CC-010b` milestones of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## The cycle
 *
 * The runtime drives one turn:
 *
 * ```
 * provider request → streamed events → tool call → permission check → tool run
 *   → tool result → a second provider request that carries the tool result
 * ```
 *
 * and it **persists every event through the store as it goes**. The turn ends
 * when the provider reports a stop reason with no pending tool call.
 *
 * The tool calls of one assistant message do **not** all run one after the
 * other: the scheduler is per tool, and the rule is below.
 *
 * The audit records the pieces: "the agent turn is a streaming
 * `beta.messages.create`" and "response events are consumed as `stream_event`s"
 * (§2.4); "permission decisions are threaded back to the model through the tool
 * result, so the model observes the decision and its reason type" (§2.4); and
 * the session's transcript is the append-only JSONL log (§2.6).
 *
 * ## The scheduling is the target's observed rule
 *
 * The runtime schedules the tool calls of one assistant message **per tool,
 * not per message**:
 *
 *   - every tool declares whether it is **concurrency safe**;
 *   - the **concurrency-safe** calls of one assistant message run **in
 *     parallel** — several are in flight at once;
 *   - a call that is **not** concurrency safe runs **alone** and is a
 *     **barrier**: the queue stops at it, and nothing else starts until it has
 *     finished;
 *   - the **next provider request** is issued only after **every** call of
 *     that assistant message has produced its result;
 *   - the results are **emitted** in block order for the non-safe calls and in
 *     **completion order** for the concurrency-safe ones.
 *
 * The evidence is the target's own scheduler — the executor `Rs` in
 * `chunk-ehmvy572.js` — and the record is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-tool-scheduling.md`.
 * The REA closed the audit's open question: whether the tool calls of one
 * assistant message run in parallel or in sequence, and where the next request
 * is issued. The answer is the rule above.
 *
 * **A tool that does not declare the flag is not concurrency safe.** That is
 * the target's own default, and it is what the built-in tools rely on: `Glob`,
 * `Grep`, `Read` and `WebFetch` declare the flag, `Bash` declares it **only
 * for a read-only command**, and every other built-in tool declares nothing.
 *
 * ## The permission integration
 *
 * A tool call is **permission-checked before it runs**, and the decision is
 * honoured:
 *
 *   - `allow` — the tool runs.
 *   - `deny` — the tool does **not** run. The refusal is **answered**: the
 *     call produces a `<tool_use_error>` tool result that carries the decision
 *     and its reason type, and the turn ends with the refusal recorded.
 *   - `ask` — the runtime **cannot prompt**: there is no user interface in this
 *     milestone, so the call is **refused** rather than run, and the refusal is
 *     answered the same way. The CLI and UI tasks (`CC-014`, `CC-015`) supply
 *     the prompt through the `approveAsk` dependency, and the permission
 *     service's own `canUseTool` prompt is the second seam.
 *
 * A tool name that is **not registered** is a refusal, not a crash — and it is
 * answered with the same error result. It produces **no** `permission_request`
 * record: no permission was ever asked for it.
 *
 * **Two checks are consulted, and the stricter verdict governs.** The tool's
 * own check (`ToolDefinition.checkPermissions`) and the session's permission
 * service (`checkPermission`) are both consulted for every call:
 *
 *   - a `deny` from either one blocks the call;
 *   - an `ask` from either one refuses it — with **one** exception: the
 *     service's *generic* "no rule matched" prompt (`noRuleMatched`) does not
 *     override a call the tool's own check allowed, because that prompt carries
 *     no rule. Every other `ask` — an ask rule, a mode-level refusal, a safety
 *     check — restricts the call;
 *   - two `allow`s are the tool's own.
 *
 * **The two checks are two checks, not one check run twice.** By default the
 * runtime's service runs with the runtime's own options — an empty rule set in
 * the `default` mode, and **no hook** — while the built-in tools carry the
 * session's rules, the session's mode and the session's `PermissionRequest`
 * hook. The service's default verdict is therefore the *generic* "no rule
 * matched" prompt, and the `PermissionRequest` hook of `permissionOptions()`
 * fires **once** per call — in the runtime's own service call. A caller that
 * binds the same hook and the same rules to both sees the hook twice, but that
 * is the caller's doing: the two runs are two different checks, and the
 * duplication cannot widen a decision (the stricter verdict governs, and a
 * rewrite is re-checked).
 *
 * ## The session key
 *
 * The runtime keeps one handle per session, and the key is **injective** for
 * the pair it names. The working directory and the session id are both
 * caller-supplied, so the key is `JSON.stringify([cwd, sessionId])`: a
 * separator character inside either of them cannot make two different pairs
 * share one transcript.
 *
 * ## A rewrite is re-checked in full
 *
 * A hook may rewrite a tool's input. The rewritten input is a **new** call, so
 * the **whole** check runs again with the effective input: the tool's own
 * `recheckPermission` (the same rules, the same mode, the same safety check and
 * the same hook semantics) **and** the session's permission service, both run
 * with the effective input. The re-check may only **restrict** the call — a
 * `stricter` verdict wins — so a rewrite cannot escape the ask list, the allow
 * scope or the mode dispatch.
 *
 * ## The abort path
 *
 * The abort signal is an `AbortSignal` passed to `runTurn(input, signal?)`.
 * When it fires:
 *
 *   - the loop stops, wherever it is — mid-stream, between two tool calls, or
 *     during a tool;
 *   - a `provider_event` with `type: 'error'` and `retryable: false` is
 *     appended, so the transcript says why the turn stopped;
 *   - the turn returns `stopReason: 'aborted'`.
 *
 * An abort **during** a tool stops the turn as well: the tool's result is
 * **not** appended and **not** sent back to the provider. The tool executor's
 * contract carries no signal, so the runtime cannot cancel a tool that is
 * already running — it stops waiting for it and discards its result.
 *
 * ## The stop reasons
 *
 * `TurnResult.stopReason` is the plan's five-member union. The provider's own
 * stop reason is mapped onto it:
 *
 * | provider | runtime | why |
 * |---|---|---|
 * | `end_turn` | `end_turn` | the provider finished with no tool call |
 * | `max_tokens` | `max_tokens` | the provider's output was truncated |
 * | `tool_use` | `tool_use` | the provider ended its turn with a pending call |
 * | `stop_sequence` | `end_turn` | **implementation choice**: the turn finished with no pending tool call, and `end_turn` is the union's member for that |
 * | `refusal` | `end_turn` | **implementation choice**: the same — a refusal is a completed turn, not a failure of the runtime |
 *
 * The provider's exact stop reason is preserved in
 * `TurnResult.providerStopReason`, so a `stop_sequence` and a `refusal` remain
 * distinguishable to a caller even though the runtime's five-member union
 * cannot express them.
 *
 * **A refusal has no stop reason of its own.** A refused call is answered with
 * a tool result, and the turn's stop reason is the mapped reason of the round
 * that ended it — so a provider that stopped with `max_tokens` and was refused
 * a call is reported as `max_tokens`, not as `tool_use`.
 *
 * ## What the runtime records
 *
 * Every provider event becomes a `provider_event` record; the prompt becomes a
 * `user_message`; the assistant's text becomes an `assistant_message`; every
 * tool call becomes a `tool_call`; every permission decision becomes a
 * `permission_request`; and every tool result that reached the provider becomes
 * a `tool_result`.
 *
 * **A refused call is answered with a `tool_result` record.** The answer is the
 * `<tool_use_error>` wrapper the target produces. The audit states that a call
 * which is "refused by an isolation latch", "refused by a permission rule" or
 * "routed elsewhere" produces "a `tool_result` whose content is a
 * `<tool_use_error>…</tool_use_error>` wrapper with `is_error: true`" (§2.4),
 * and that "permission decisions are threaded back to the model through the tool
 * result, so the model observes the decision and its reason type" (§2.4). The
 * implementation answers the same way: the runner's envelope already carries the
 * decision, the reason type, the remedy and the user's own feedback, and the
 * runtime wraps its content in the `<tool_use_error>` wrapper.
 *
 * The transcript therefore reads **`tool_call` → `permission_request` →
 * `tool_result`**, and the `tool_result` is a real answer. The
 * `permission_request` record is written **when the decision is made** — before
 * the tool runs — and it is written only when a permission was actually asked:
 * a call to a tool the registry does not hold is a `tool_result` and nothing
 * else.
 *
 * **Implementation choice**: this implementation ends the turn after a refusal. The audit pins the
 * *answer* — a `<tool_use_error>` tool result — and not whether the turn
 * continues, so the answer is carried in the transcript and reaches the model
 * in the session's next request.
 *
 * A refusal **inside a group of concurrency-safe calls** ends the turn when the
 * group is over: the calls that ran beside it have produced their results, and
 * those results are in the transcript. The calls queued **behind** the group do
 * not run.
 *
 * ## An oversized tool result is stubbed too
 *
 * The content-replacement mechanism exists so that an oversized tool result
 * does not come back into the **context**. The store writes the payload
 * **verbatim** and a content-replacement record beside it, and the two
 * **projection** paths — the between-turns load (`conversationFromEvents`) and
 * the cross-turn projection (`resumeEvents`) — apply the replacement when they
 * project the transcript.
 *
 * The **within-turn** push applies it as well. The turn the tool ran is the
 * turn an oversized payload matters most in: it is the turn that would blow up.
 * So the block the runtime pushes into its next request carries the **stub**
 * when the content is over the limit, and the content as it is when it is not.
 *
 * The **rule** is the store's own — `contentReplacementStub`, reached by
 * import — and the **limit** is the store's own limit, read from
 * `SessionStore.maxToolResultBytes`. There is therefore one rule, and the
 * within-turn block, the between-turns load and the cross-turn projection
 * carry the same content for the same transcript.
 *
 * The stub's **wire form** — the stub's own JSON,
 * `{"type":"tool_result_stub", …}` — is a **implementation choice**: the audit pins that
 * the oversized payload does not come back into the context, and not what the
 * stub looks like on the wire. The same label sits on the stub's type in
 * `src/session/event.ts` and on the rule in `src/session/store.ts`.
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - the **output-token budget** of a request that does not name one;
 *   - the **number of tool rounds** a turn may run before the runtime gives up;
 *   - the way a tool result's content is carried into the request (a string as
 *     it is, anything else as its JSON serialization);
 *   - the **wording** of the `<tool_use_error>` wrapper's parts — the audit
 *     pins the wrapper, not what is written inside it;
 *   - the fact that a call whose **input validation** failed is reported back
 *     to the provider as an error result (the audit records the target's
 *     `<tool_use_error>` for a validation failure, and the tool runner owns the
 *     content of that result), while a call that was **refused** is answered
 *     with a `<tool_use_error>` wrapper of its own;
 *   - the **stub's wire form**, and the fact that the within-turn push applies
 *     the store's stub rule — see the section above.
 */

import { randomUUID } from 'node:crypto';

import type {
  CheckPermissionOptions,
  PermissionDecision,
  ToolContext,
} from '../permissions/decision.js';
import type {
  ProviderContentBlock,
  ProviderDriver,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  StopReason,
  Usage,
} from '../provider/drivers/types.js';
import { SESSION_SCHEMA_VERSION, type SessionEvent } from '../session/event.js';
import {
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  contentReplacementStub,
  type SessionHandle,
  type SessionStore,
} from '../session/store.js';
import type { ToolDefinition, ToolRegistry, ToolRecheck } from '../tools/registry.js';
import { isToolConcurrencySafe } from '../tools/registry.js';
import { runTool, withLegacyEnvelopeNames, type ToolResultEnvelope } from '../tools/runner.js';

import {
  buildProviderRequest,
  buildProviderTools,
  conversationFromEvents,
  pushAssistant,
  pushToolResults,
  pushUserText,
  streamingSourceOf,
  toolContextFor,
  toolResultBlock,
  type ProviderTurnSource,
} from './context.js';
import { scheduleToolCalls, toolCallsFrom, type ToolCall } from './dispatch.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/** The session's permission service. */
type PermissionChecker = typeof import('../permissions/decision.js').checkPermission;

/** One turn's input. */
export interface TurnInput {
  /** The user's prompt. */
  prompt: string;
  /** The session the turn belongs to. */
  sessionId: string;
  /** The model the turn runs on. */
  model: string;
}

/**
 * Why a turn stopped.
 *
 * The five members are the plan's.
 */
export type TurnStopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'aborted' | 'error';

/**
 * A permission denial the turn recorded.
 *
 * The **runtime's** record of a call a permission rule refused. The headless
 * result document carries it in the target's wire shape
 * (`tool_name`, `tool_use_id`, `tool_input`); the mapping lives in
 * `src/cli/headless.ts`, so the runtime does not know the wire.
 */
export interface TurnPermissionDenial {
  /** The tool the call named. */
  toolName: string;
  /** The id of the call. */
  toolUseId: string;
  /** The input the call would have run. */
  input: unknown;
}

/**
 * The token usage a turn accumulated.
 *
 * The **runtime's** accounting: the provider's own numbers, summed over the
 * turn's rounds. The headless result document carries it in the target's wire
 * shape; the mapping lives in `src/cli/headless.ts`.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** One turn's result. */
export interface TurnResult {
  /** The records the turn appended, in the order they were appended. */
  events: SessionEvent[];
  /** Why the turn stopped. */
  stopReason: TurnStopReason;
  /**
   * The provider's own stop reason, when it reported one.
   *
   * It preserves what the runtime's five-member union cannot express: a
   * `stop_sequence` and a `refusal` both map onto `end_turn`, and this member
   * keeps them apart.
   */
  providerStopReason?: StopReason;
  /**
   * Why the turn stopped, in words.
   *
   * It is **optional**: a turn that stopped well has nothing to explain. A turn
   * that failed names its cause — the store's reason, the provider's error, the
   * tool's failure — so a caller that reads only the result can tell a session
   * that could not be opened from a provider that failed.
   */
  message?: string;
  /**
   * The number of provider rounds the turn made.
   *
   * The target's result document carries the count as `num_turns`
   * (`chunk-pj5cyqhw.js:326977`), and the target's own builder sets it to the
   * number of turns the loop ran (`chunk-e7w77ts3.js:353540`).
   */
  numTurns?: number;
  /** The token usage the turn accumulated. */
  usage?: TurnUsage;
  /** The calls a permission rule refused. */
  permissionDenials?: TurnPermissionDenial[];
}

/** The agent runtime. */
export interface AgentRuntime {
  /** Run one turn. */
  runTurn(input: TurnInput, signal?: AbortSignal): Promise<TurnResult>;
}

/* -------------------------------------------------------------------------- */
/* The dependencies                                                            */
/* -------------------------------------------------------------------------- */

/** The dependencies the runtime is built with. */
export interface AgentRuntimeDeps {
  /**
   * The provider driver.
   *
   * The driver builds the request — its URL, its headers, its body — and a
   * driver that declares itself the turn's transport (it carries the
   * `TURN_SOURCE` marker) is also the turn **source**. A caller that keeps the
   * transport elsewhere supplies a `source` instead.
   */
  driver: ProviderDriver;
  /** The tools the model may call. */
  registry: ToolRegistry;
  /** The store the turn's records are appended to. */
  store: SessionStore;
  /**
   * The session's permission service.
   *
   * It is consulted for every tool call, and the stricter of its verdict and
   * the tool's own verdict governs the call.
   */
  permission: PermissionChecker;
  /** The transport, when the driver does not declare itself one. */
  source?: ProviderTurnSource;
  /**
   * The options the permission service is called with.
   *
   * The default is an empty rule set in the `default` mode, which asks for
   * approval for everything: a call that no rule covers is refused rather than
   * run. The CLI task supplies the session's real rules and mode.
   */
  permissionOptions?: CheckPermissionOptions;

  /**
   * The `PreToolUse` seam the runtime's own permission service consults.
   *
   * The runtime's service is called with `permissionOptions()`, and the options
   * a caller does not supply carry **no** seam — so a turn that goes through the
   * runtime's own check is not gated by the `PreToolUse` hooks unless the caller
   * supplies the seam. The CLI supplies it; this dependency lets a caller that
   * does not supply `permissionOptions` supply the seam instead.
   */
  preToolUseHook?: (
    ctx: ToolContext,
  ) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>;
  /**
   * The `PermissionRequest` seam, for the same reason.
   */
  hook?: (
    ctx: ToolContext,
  ) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>;
  /**
   * The prompt.
   *
   * The runtime has no user interface, so an `ask` is refused. The CLI and UI
   * tasks supply the prompt here, and the decision it returns settles the call.
   */
  approveAsk?: (ctx: ToolContext, decision: PermissionDecision) => Promise<PermissionDecision | undefined>;
  /** The working directory. Defaults to the process's. */
  cwd?: string;
  /** The system prompt. The runtime sends none unless the caller names one. */
  system?: string;
  /** The output-token budget of a request. */
  maxTokens?: number;
  /** The number of tool rounds a turn may run. */
  maxTurns?: number;
  /** The clock. */
  now?: () => number;
  /** The id factory of the records the runtime writes. */
  idFactory?: () => string;
}

/* -------------------------------------------------------------------------- */
/* The constants                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The output-token budget a request asks for when the caller names none.
 *
 * **Implementation choice.**
 */
export const DEFAULT_MAX_TOKENS = 4096;

/**
 * The number of tool rounds a turn may run before the runtime gives up.
 *
 * **Implementation choice.** The bound is a guard against a model that asks for a tool
 * forever; the audit does not record a bound of the target's.
 */
export const DEFAULT_MAX_TURNS = 32;

/**
 * The message of the error event an abort appends.
 *
 * **Implementation choice.** The audit does not record a wording of the target's.
 */
export const ABORTED_MESSAGE = 'The turn was aborted before it finished.';

/**
 * The key a session's handle is kept under.
 *
 * The working directory and the session id are both **caller-supplied** data,
 * so the key is the JSON encoding of the pair: a separator character inside
 * either of them cannot make two different pairs share one transcript. The key
 * is a `Map` key, and the map is the only lookup — it is never an index into
 * an object, so none of the `Object.prototype` hazards apply.
 */
export function sessionKeyOf(cwd: string, sessionId: string): string {
  return JSON.stringify([cwd, sessionId]);
}

/* -------------------------------------------------------------------------- */
/* The runtime                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create the agent runtime.
 *
 * The runtime keeps the handle of every session it opened, so a second turn on
 * the same session **reuses** the handle: the session is created once, and the
 * transcript is one file.
 */
export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const now = deps.now ?? (() => Date.now());
  const idFactory = deps.idFactory ?? (() => randomUUID());
  const cwd = deps.cwd ?? process.cwd();
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const source = deps.source ?? streamingSourceOf(deps.driver);

  /** The handles of the sessions this runtime has opened. */
  const handles = new Map<string, SessionHandle>();

  async function handleFor(sessionId: string): Promise<SessionHandle> {
    const key = sessionKeyOf(cwd, sessionId);
    const existing = handles.get(key);
    if (existing !== undefined) return existing;
    const handle = await deps.store.create({ cwd, sessionId });
    handles.set(key, handle);
    return handle;
  }

  /** The base of a record: the version, the clock and the id. */
  function base(): { v: typeof SESSION_SCHEMA_VERSION; ts: number; id: string } {
    return { v: SESSION_SCHEMA_VERSION, ts: now(), id: idFactory() };
  }

  /** The options the permission service is called with. */
  function permissionOptions(): CheckPermissionOptions {
    // The caller's options are **copied**, never mutated: the caller may hand
    // the same object to two runtimes, and a seam applied to it here would be
    // visible to the other.
    const supplied = deps.permissionOptions;
    const options: CheckPermissionOptions = {
      ...(supplied ?? { rules: { allow: [], deny: [], ask: [], cwd }, mode: 'default' }),
    };
    // The seams are applied on **every** path, not only on the default one: a
    // caller that supplies `permissionOptions` without them still gets them
    // from the dependencies. A seam the caller supplied **in the options**
    // wins over the dependency — the options are the more specific statement.
    if (options.preToolUseHook === undefined && deps.preToolUseHook !== undefined) {
      options.preToolUseHook = deps.preToolUseHook;
    }
    if (options.hook === undefined && deps.hook !== undefined) {
      options.hook = deps.hook;
    }
    return options;
  }

  async function runTurn(input: TurnInput, signal?: AbortSignal): Promise<TurnResult> {
    const events: SessionEvent[] = [];

    /**
     * The turn's own accounting.
     *
     * The three members are the ones the target's result document carries
     * (`num_turns`, `usage` and `permission_denials`); the runtime produces the
     * numbers and the headless module shapes them into the document.
     */
    let numTurns = 0;
    const usage: TurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const permissionDenials: TurnPermissionDenial[] = [];

    /** The turn's result, with the turn's own accounting attached. */
    const accounted = (
      result: Omit<TurnResult, 'numTurns' | 'usage' | 'permissionDenials'>,
    ): TurnResult => ({
      ...result,
      numTurns,
      usage: { ...usage },
      permissionDenials: [...permissionDenials],
    });

    let handle: SessionHandle;
    try {
      handle = await handleFor(input.sessionId);
    } catch (error) {
      // The session could not be opened: there is nowhere to record the turn,
      // so the turn reports the store's own reason instead of a bare `error`.
      return accounted({
        events,
        stopReason: 'error',
        message: `The session '${input.sessionId}' could not be opened: ${messageOf(error)}`,
      });
    }

    /**
     * The chain the records go through.
     *
     * A tool call that runs beside another one produces its records at the
     * same time, and the store's append is asynchronous. The chain keeps the
     * transcript's order the order the records were produced in.
     */
    let appendChain: Promise<void> = Promise.resolve();

    const append = async (event: SessionEvent): Promise<void> => {
      // The records go through a **chain**, so the transcript's order is the
      // order the records were produced in — even when several tool calls run
      // at the same time and produce their records at the same time.
      const next = appendChain.then(() => deps.store.append(handle, event));
      appendChain = next.then(
        () => undefined,
        () => undefined,
      );
      await next;
      events.push(event);
    };

    /** The turn stopped because the signal fired. */
    const aborted = async (): Promise<TurnResult> => {
      await appendSafely({
        ...base(),
        t: 'provider_event',
        event: { type: 'error', message: ABORTED_MESSAGE, retryable: false },
      });
      return accounted({ events, stopReason: 'aborted', message: ABORTED_MESSAGE });
    };

    /** The turn failed. */
    const failed = async (message: string): Promise<TurnResult> => {
      await appendSafely({
        ...base(),
        t: 'provider_event',
        event: { type: 'error', message, retryable: false },
      });
      return accounted({ events, stopReason: 'error', message });
    };

    /**
     * Append a record, and survive a store that cannot take it.
     *
     * The last record of a turn is the one that says why the turn stopped: a
     * store that refuses it must not stop the runtime from reporting the
     * reason.
     */
    const appendSafely = async (event: SessionEvent): Promise<void> => {
      try {
        await append(event);
      } catch {
        // The transcript could not take the record. The turn still reports why
        // it stopped.
      }
    };

    /**
     * Record the decision a call was governed by.
     *
     * The record is written **when the decision is made**, which is before the
     * tool runs: the chronology of a call is the check, the execution and the
     * result, and the decision belongs to the check. A call that was never
     * checked — a tool the registry does not hold — produces no record at all,
     * because no permission was ever asked for it.
     */
    const recordDecision = async (
      toolName: string,
      decision: PermissionDecision,
    ): Promise<void> => {
      await appendSafely({ ...base(), t: 'permission_request', toolName, decision });
    };

    try {
      // The conversation is projected from the transcript **before** the prompt
      // is appended: the transcript is the source of truth, and the prompt is
      // the one message this turn adds.
      const conversation = await loadConversation(handle);

      // The prompt is recorded first: the turn exists in the transcript even
      // when the provider never answers it.
      await append({ ...base(), t: 'user_message', text: input.prompt });
      pushUserText(conversation, input.prompt);

      for (let round = 0; round < maxTurns; round += 1) {
        if (isAborted(signal)) return aborted();

        const request = buildProviderRequest({
          model: input.model,
          maxTokens,
          messages: conversation,
          tools: buildProviderTools(deps.registry),
          system: deps.system,
        });

        const collected = await collect(request, signal, append);
        if (collected.kind === 'aborted') return aborted();
        if (collected.kind === 'error') {
          return failed(collected.message ?? `The provider request for '${input.model}' failed.`);
        }

        const summary = summarise(collected.events);

        // The round is a provider request: it counts as a turn, and its usage
        // joins the turn's total. The stream's `message_stop` carries the
        // **cumulative** usage of the request, so the last one is the round's.
        numTurns += 1;
        if (summary.usage !== undefined) {
          usage.inputTokens += summary.usage.inputTokens ?? 0;
          usage.outputTokens += summary.usage.outputTokens ?? 0;
          usage.cacheCreationInputTokens += summary.usage.cacheCreationInputTokens ?? 0;
          usage.cacheReadInputTokens += summary.usage.cacheReadInputTokens ?? 0;
        }

        // The provider reported an error: the turn ends with it.
        if (summary.error !== undefined) {
          return accounted({
            events,
            stopReason: 'error',
            providerStopReason: summary.stopReason,
            message: summary.error.message,
          });
        }

        if (summary.text !== '') {
          await append({ ...base(), t: 'assistant_message', text: summary.text });
        }

        // No pending tool call: the turn ends with the provider's stop reason.
        if (summary.calls.length === 0) {
          return accounted({
            events,
            stopReason: mapStopReason(summary.stopReason),
            providerStopReason: summary.stopReason,
          });
        }

        // The tool calls of this assistant message. A provider that sends an
        // **empty** tool-use id gets one minted here, so the id the record, the
        // context, the envelope, the answer and the request all carry is the
        // same one — the call and its answer pair up.
        const calls = summary.calls.map((call) =>
          call.id !== '' ? call : { ...call, id: idFactory() },
        );

        // The tool calls of this assistant message. The target's scheduler is
        // **per tool**: a call whose tool declares itself concurrency safe runs
        // beside the other safe calls of the message, and a call that is not
        // concurrency safe runs alone and is a barrier — see the module header.
        const groups = scheduleToolCalls(calls, isConcurrencySafeCall);
        const byId = new Map<string, ToolCall>();
        for (const call of calls) byId.set(call.id, call);
        const resultBlocks: ProviderContentBlock[] = [];
        let refused = false;

        /**
         * Run one call and record its result.
         *
         * The call's result is pushed into the round's blocks **when it
         * finishes**, so the results of the concurrency-safe calls are emitted
         * in **completion order** — the order they were produced in.
         */
        const runCall = async (call: ToolCall): Promise<CallOutcome> => {
          const outcome = await dispatchCall(call, input.sessionId, signal, recordDecision);
          if (outcome.kind === 'aborted') {
            // The tool was abandoned: its result is neither appended nor sent
            // back to the provider.
            return { kind: 'aborted', name: call.name };
          }

          const envelope = outcome.envelope;
          if (envelope === undefined) {
            return {
              kind: 'failed',
              name: call.name,
              message: `The ${call.name} call produced no result.`,
            };
          }

          if (outcome.kind === 'failed') {
            return {
              kind: 'failed',
              name: call.name,
              message: outcome.message ?? `The ${call.name} call failed.`,
            };
          }

          // The answer the model observes: the call's own result, or — for a
          // refusal — the `<tool_use_error>` wrapper the target produces.
          const answer = outcome.kind === 'refused' ? refusalEnvelope(envelope) : envelope;

          // A call a permission rule refused is a **denial** the turn records:
          // the target's result document carries the denials in its
          // `permission_denials` member, and this is where the runtime learns
          // of them. A call the registry does not hold is not a denial — no
          // permission was ever asked for it.
          if (outcome.kind === 'refused' && isPermissionDenial(envelope)) {
            permissionDenials.push({
              toolName: call.name,
              toolUseId: call.id,
              input: call.input,
            });
          }

          // The **within-turn** push is stubbed too. The content-replacement
          // mechanism exists so that an oversized tool result does not come
          // back into the **context**, and the turn the tool ran is the turn it
          // matters most in: the payload is in the transcript, and the model
          // sees the stub.
          //
          // The rule is the store's own — `contentReplacementStub`, reached by
          // import — and the limit is the store's own limit, so the within-turn
          // block, the between-turns load and the cross-turn projection carry
          // the same content for the same transcript.
          const stub = contentReplacementStub(
            answer.content,
            deps.store.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES,
          );
          resultBlocks.push(toolResultBlock(call.id, stub ?? answer.content, answer.isError));

          await append({ ...base(), t: 'tool_result', envelope: answer });

          return { kind: outcome.kind, name: call.name };
        };

        for (const group of groups) {
          if (isAborted(signal)) return aborted();

          const groupCalls: ToolCall[] = [];
          for (const id of group.ids) {
            const call = byId.get(id);
            if (call !== undefined) groupCalls.push(call);
          }

          // The calls of the group are recorded before they run, so the
          // transcript carries the whole message's calls before any of them
          // produced a result.
          for (const call of groupCalls) {
            await append({
              ...base(),
              t: 'tool_call',
              id: call.id,
              name: call.name,
              input: call.input,
            });
          }

          if (group.parallel) {
            // The concurrency-safe calls run **together**. Each one appends its
            // own result when it finishes, so the results are emitted in
            // **completion order** — the order the calls produced them.
            const outcomes = await Promise.all(groupCalls.map((call) => runCall(call)));
            for (const outcome of outcomes) {
              if (outcome.kind === 'aborted') return aborted();
              if (outcome.kind === 'failed') {
                return failed(outcome.message ?? `The ${outcome.name} call failed.`);
              }
              if (outcome.kind === 'refused') refused = true;
            }
          } else {
            // The call that is not concurrency safe runs **alone**.
            for (const call of groupCalls) {
              const outcome = await runCall(call);
              if (outcome.kind === 'aborted') return aborted();
              if (outcome.kind === 'failed') {
                return failed(outcome.message ?? `The ${outcome.name} call failed.`);
              }
              if (outcome.kind === 'refused') {
                refused = true;
                break;
              }
            }
          }

          if (refused) {
            // The turn ends with the refusal, and the calls queued behind it do
            // not run.
            break;
          }
        }

        if (refused) {
          // The turn ends with the refusal. The stop reason is the provider's
          // own, mapped: a provider that stopped with `max_tokens` is reported
          // as `max_tokens`, not as `tool_use`.
          return accounted({
            events,
            stopReason: mapStopReason(summary.stopReason),
            providerStopReason: summary.stopReason,
          });
        }

        // The assistant's message and the results go into the conversation, and
        // the **next** request carries them.
        pushAssistant(conversation, assistantBlocks(summary.text, calls));
        pushToolResults(conversation, resultBlocks);
      }

      return failed(
        `The turn ran more than ${maxTurns} tool rounds for the model '${input.model}', so it was stopped.`,
      );
    } catch (error) {
      return failed(messageOf(error));
    }
  }

  /**
   * The conversation of a session, projected from its transcript.
   */
  async function loadConversation(handle: SessionHandle): Promise<ProviderMessage[]> {
    const records: SessionEvent[] = [];
    for await (const event of deps.store.read(handle)) records.push(event);
    return conversationFromEvents(records);
  }

  /**
   * Whether a call may run beside another call.
   *
   * The flag is the **tool's own**, read per call: a tool that declares
   * itself concurrency safe says so, and a tool that declares nothing is not
   * concurrency safe — the target's own default. A tool the registry does not
   * hold is not concurrency safe either: there is no definition to read.
   */
  function isConcurrencySafeCall(call: ToolCall): boolean {
    return isToolConcurrencySafe(deps.registry.get(call.name), call.input);
  }

  /**
   * Run one tool call.
   *
   * The call goes through the runner, which owns the order — **check
   * permissions → validate input → execute → wrap the result** — and which owns
   * the path re-resolution of the file-mutating tools. The runtime decides what
   * the runner's permission check sees: the tool's own verdict and the
   * session's verdict, combined.
   */
  async function dispatchCall(
    call: ToolCall,
    sessionId: string,
    signal: AbortSignal | undefined,
    recordDecision: DecisionRecorder,
  ): Promise<DispatchOutcome> {
    const holder: DecisionHolder = { decision: undefined };
    const ctx = toolContextFor(call, sessionId);

    const raced = await raceAbort(
      runTool(wrappedRegistry(holder, call.name, recordDecision), call.name, call.input, ctx, {
        approveAsk: deps.approveAsk,
        cwd,
      }),
      signal,
    );

    if (raced.kind === 'aborted') {
      // The tool was abandoned: its result is neither appended nor sent back to
      // the provider.
      return { kind: 'aborted' };
    }

    const envelope = raced.value;
    const kind = envelope.non_execution_kind;

    if (kind === 'permission_denied' || kind === 'permission_unresolved' || kind === 'unknown_tool') {
      // A denial, an unresolved approval and an unknown tool are **refusals**:
      // the call did not run, and the turn ends with it. The refusal is
      // answered with the `<tool_use_error>` the target produces.
      return { kind: 'refused', envelope };
    }

    if (kind === 'permission_check_failed') {
      // The permission service itself failed: the runtime failed.
      return {
        kind: 'failed',
        envelope,
        message:
          errorMessageOf(envelope) ?? `The permission check for '${call.name}' failed.`,
      };
    }

    // The tool ran — or the call failed inside it, which the model observes.
    return { kind: 'ran', envelope };
  }

  /**
   * A registry whose tools carry the runtime's permission integration.
   *
   * The wrapper is what makes the **session's** permission service part of the
   * check the runner performs, and what makes a rewritten input run the whole
   * check again.
   */
  function wrappedRegistry(
    holder: DecisionHolder,
    calledName: string,
    recordDecision: DecisionRecorder,
  ): ToolRegistry {
    return {
      register(): void {
        throw new Error('The agent runtime does not register tools.');
      },
      get(name: string): ToolDefinition | undefined {
        const tool = deps.registry.get(name);
        return tool === undefined
          ? undefined
          : wrapTool(tool, holder, calledName, recordDecision);
      },
      list(): readonly ToolDefinition[] {
        return deps.registry
          .list()
          .map((tool) => wrapTool(tool, holder, calledName, recordDecision));
      },
    };
  }

  function wrapTool(
    tool: ToolDefinition,
    holder: DecisionHolder,
    calledName: string,
    recordDecision: DecisionRecorder,
  ): ToolDefinition {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      mutatesFiles: tool.mutatesFiles,
      checkPermissions: async (input: unknown, ctx: ToolContext): Promise<PermissionDecision | undefined> => {
        const own = await tool.checkPermissions(input, ctx);
        if (own !== undefined && own.behavior === 'deny') {
          // A denial stands on its own: the session's service is not consulted
          // for a call the tool already refused.
          holder.decision = own;
          await recordDecision(calledName, own);
          return own;
        }
        const service = await deps.permission(ctx, permissionOptions());
        const effective = combineDecisions(own, service);
        holder.decision = effective;
        if (effective !== undefined) await recordDecision(calledName, effective);
        return effective;
      },
      recheckPermission: async (input: unknown, ctx: ToolContext): Promise<ToolRecheck> => {
        // The **whole** check, run again with the effective (rewritten) input:
        // the tool's own re-check and the session's service, both with the
        // rewritten input. The re-check may only restrict the call.
        const own = await tool.recheckPermission(input, ctx);
        const service = await deps.permission(ctx, permissionOptions());
        const effective = combineDecisions(own.decision, service);
        const governed = stricterDecision(holder.decision, effective);
        holder.decision = governed;
        if (effective !== undefined) await recordDecision(calledName, governed ?? effective);
        const recheck: ToolRecheck = { decision: effective };
        if (own.approvedPath !== undefined) recheck.approvedPath = own.approvedPath;
        return recheck;
      },
      validateInput: (input: unknown, ctx: ToolContext) => tool.validateInput(input, ctx),
      execute: (input: unknown, ctx: ToolContext) => tool.execute(input, ctx),
    };
  }

  /**
   * Consume the provider's stream.
   *
   * Every event is appended to the transcript **as it arrives**, and the stream
   * is abandoned when the signal fires.
   */
  async function collect(
    request: ProviderRequest,
    signal: AbortSignal | undefined,
    append: (event: SessionEvent) => Promise<void>,
  ): Promise<Collected> {
    const events: ProviderEvent[] = [];
    if (source === undefined) {
      return {
        kind: 'error',
        events,
        message:
          "The provider driver cannot send a request: it carries no turn source. Mark the driver with TURN_SOURCE, or supply the runtime's 'source' dependency.",
      };
    }

    let stream: unknown;
    try {
      stream = source.send(request, signal);
    } catch (error) {
      return { kind: 'error', events, message: messageOf(error) };
    }

    if (!isAsyncIterable(stream)) {
      // A named failure: the transport is not a transport. The old code let
      // the "…is not iterable" of the runtime speak for itself.
      return {
        kind: 'error',
        events,
        message: `The provider driver's 'send' member must return an async iterable of provider events; it returned ${describeReturned(stream)}.`,
      };
    }

    let iterator: AsyncIterator<ProviderEvent>;
    try {
      iterator = stream[Symbol.asyncIterator]();
    } catch (error) {
      return { kind: 'error', events, message: messageOf(error) };
    }

    try {
      for (;;) {
        const next = await raceAbort(iterator.next(), signal);
        if (next.kind === 'aborted') {
          await closeIterator(iterator);
          return { kind: 'aborted', events };
        }
        if (next.value.done) break;
        const event = next.value.value;
        events.push(event);
        await append({ ...base(), t: 'provider_event', event });
      }
    } catch (error) {
      await closeIterator(iterator);
      return { kind: 'error', events, message: messageOf(error) };
    }

    return { kind: 'ok', events };
  }

  return { runTurn };
}

/* -------------------------------------------------------------------------- */
/* The outcomes                                                                */
/* -------------------------------------------------------------------------- */

/** The outcome of one tool call. */
interface CallOutcome {
  /** What happened to the call. */
  kind: 'ran' | 'refused' | 'failed' | 'aborted';
  /** The name of the tool the call named. */
  name: string;
  /** The runner's envelope, when the call produced one. */
  envelope?: ToolResultEnvelope;
  /** The message of a failure. */
  message?: string;
}

/**
 * The outcome of the dispatch of one tool call.
 *
 * It is the call's outcome without the tool's name: the name belongs to the
 * call, and the dispatch knows it.
 */
type DispatchOutcome = Omit<CallOutcome, 'name'>;

/**
 * Records the decision a call was governed by.
 *
 * The recorder is called **when the decision is made**, so the transcript's
 * chronology is the check, the execution and the result.
 */
type DecisionRecorder = (toolName: string, decision: PermissionDecision) => Promise<void>;

/** The holder of the decision a call was governed by. */
interface DecisionHolder {
  decision: PermissionDecision | undefined;
}

/** The outcome of consuming the provider's stream. */
interface Collected {
  /** What happened to the stream. */
  kind: 'ok' | 'aborted' | 'error';
  /** The events the stream produced. */
  events: ProviderEvent[];
  /** The message of a failure. */
  message?: string;
}

/** The summary of a provider turn's events. */
interface TurnSummary {
  /** The text the assistant produced. */
  text: string;
  /** The tool calls the assistant made. */
  calls: ToolCall[];
  /** The provider's stop reason. */
  stopReason: StopReason | undefined;
  /** The error the provider reported, when it reported one. */
  error: Extract<ProviderEvent, { type: 'error' }> | undefined;
  /**
   * The cumulative usage the stream reported.
   *
   * The wire's `message_delta` usage is **cumulative**, so the last
   * `message_stop` of the round carries the round's total.
   */
  usage: Usage | undefined;
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Summarise the events of a provider turn.
 */
function summarise(events: ProviderEvent[]): TurnSummary {
  let text = '';
  let stopReason: StopReason | undefined;
  let error: Extract<ProviderEvent, { type: 'error' }> | undefined;
  let usage: Usage | undefined;
  for (const event of events) {
    switch (event.type) {
      case 'text_delta':
        text += event.text;
        break;
      case 'message_stop':
        stopReason = event.stopReason;
        // The stream's usage is cumulative, so the last one is the round's total.
        if (event.usage !== undefined) usage = event.usage;
        break;
      case 'error':
        error = event;
        break;
      default:
        break;
    }
  }
  return { text, calls: toolCallsFrom(events), stopReason, error, usage };
}

/**
 * Whether a refused call is a **permission denial**.
 *
 * The target's result document carries the calls a permission rule refused in
 * its `permission_denials` member. Two refusals are denials: the call a rule
 * **denied**, and the call that **asked** and had nobody to ask — with no
 * prompt surface an ask is terminal, so it is an implicit denial. A call the
 * registry does not hold is not a denial: no permission was ever asked for it.
 */
function isPermissionDenial(envelope: ToolResultEnvelope): boolean {
  const kind = envelope.non_execution_kind;
  if (kind === 'permission_denied' || kind === 'permission_unresolved') return true;
  return envelope.permission_decision?.decision === 'deny';
}

/**
 * The blocks of the assistant's message.
 *
 * The text it produced and the tool calls it made, in that order. The calls
 * are the ones of the round, so a minted tool-use id is the one the request
 * carries.
 */
function assistantBlocks(text: string, calls: ToolCall[]): ProviderContentBlock[] {
  const blocks: ProviderContentBlock[] = [];
  if (text !== '') blocks.push({ type: 'text', text });
  for (const call of calls) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
  }
  return blocks;
}

/**
 * Map the provider's stop reason onto the runtime's.
 *
 * `stop_sequence` and `refusal` map onto `end_turn`: both are a turn that
 * finished with **no pending tool call**, and `end_turn` is the union's member
 * for that. The provider's exact reason is kept in `providerStopReason`.
 */
export function mapStopReason(reason: StopReason | undefined): TurnStopReason {
  switch (reason) {
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
      return 'tool_use';
    case 'end_turn':
    case 'stop_sequence':
    case 'refusal':
    case undefined:
    default:
      return 'end_turn';
  }
}

/**
 * Combine the tool's own verdict with the session's verdict.
 *
 * The **stricter** verdict governs: a `deny` from either one blocks the call,
 * and an `ask` from either one refuses it — with the one exception of the
 * service's *generic* "no rule matched" prompt, which carries no rule and
 * therefore does not override a call the tool's own check allowed.
 *
 * The rewrite rides along: the effective input is the rewritten one, whichever
 * of the two verdicts carries it.
 */
export function combineDecisions(
  toolDecision: PermissionDecision | undefined,
  serviceDecision: PermissionDecision | undefined,
): PermissionDecision | undefined {
  if (toolDecision === undefined) return serviceDecision;
  if (serviceDecision === undefined) return toolDecision;

  if (toolDecision.behavior === 'deny') return withRewrite(toolDecision, serviceDecision);
  if (serviceDecision.behavior === 'deny') return withRewrite(serviceDecision, toolDecision);

  const asks: PermissionDecision[] = [];
  if (toolDecision.behavior === 'ask') asks.push(toolDecision);
  if (serviceDecision.behavior === 'ask') asks.push(serviceDecision);

  if (asks.length === 0) return withRewrite(toolDecision, serviceDecision);

  const only = asks.length === 1 ? asks[0] : undefined;
  if (only !== undefined && only.noRuleMatched === true && toolDecision.behavior === 'allow') {
    return withRewrite(toolDecision, serviceDecision);
  }

  const first = asks[0];
  return first === undefined ? toolDecision : withRewrite(first, toolDecision);
}

/**
 * The stricter of two decisions.
 *
 * A `deny` wins over everything, an `ask` wins over an `allow`, and two
 * `allow`s are the first one.
 */
export function stricterDecision(
  first: PermissionDecision | undefined,
  second: PermissionDecision | undefined,
): PermissionDecision | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  if (first.behavior === 'deny') return first;
  if (second.behavior === 'deny') return second;
  if (first.behavior === 'ask') return first;
  if (second.behavior === 'ask') return second;
  return first;
}

/** A decision with the rewrite of the other decision, when it carries one. */
function withRewrite(
  chosen: PermissionDecision,
  other: PermissionDecision,
): PermissionDecision {
  if (chosen.updatedInput !== undefined) return chosen;
  if (other.updatedInput === undefined) return chosen;
  return { ...chosen, updatedInput: other.updatedInput };
}

/**
 * The decision an envelope carries.
 *
 * The envelope carries the decision as a summary — the behavior, the source and
 * the reason type — which is what a record of the decision needs.
 */
export function decisionFromEnvelope(envelope: ToolResultEnvelope): PermissionDecision | undefined {
  const summary = envelope.permission_decision;
  if (summary === undefined) return undefined;
  const decision: PermissionDecision = {
    behavior: summary.decision,
    source: summary.source,
    reasonType: summary.reason_type ?? 'other',
  };
  const message = errorMessageOf(envelope);
  if (message !== undefined) decision.reason = message;
  return decision;
}

/**
 * The answer a refusal produces.
 *
 * The audit records that a call which is refused by a permission rule — or by
 * an isolation latch, or routed elsewhere — produces "a `tool_result` whose
 * content is a `<tool_use_error>…</tool_use_error>` wrapper with `is_error:
 * true`" (§2.4), and that "permission decisions are threaded back to the model
 * through the tool result, so the model observes the decision and its reason
 * type" (§2.4).
 *
 * The wrapper is built from the envelope the tool runner already produced: the
 * runner's decision, its reason type, its remedy and the user's own feedback
 * all ride along, and the content becomes the wrapper.
 */
export function refusalEnvelope(envelope: ToolResultEnvelope): ToolResultEnvelope {
  return withLegacyEnvelopeNames({ ...envelope, content: toolUseErrorContent(envelope), isError: true });
}

/**
 * The content of the `<tool_use_error>` wrapper.
 *
 * **Implementation choice**: the audit pins the wrapper, not what is written inside it.
 * The parts are the reason the refusal was reported with, the decision and its
 * reason type, the remedy and the user's own feedback — so the model observes
 * the decision and its reason type.
 */
export function toolUseErrorContent(envelope: ToolResultEnvelope): string {
  const decision = decisionFromEnvelope(envelope);
  const parts: string[] = [
    decision?.reason ?? errorMessageOf(envelope) ?? 'The tool call did not run.',
  ];
  if (decision !== undefined) {
    parts.push(
      `The permission decision was '${decision.behavior}' (source: ${decision.source}, reason type: ${decision.reasonType}).`,
    );
  }
  if (envelope.remedy !== undefined) parts.push(envelope.remedy);
  if (envelope.user_feedback !== undefined) parts.push(`The user said: ${envelope.user_feedback}`);
  return `<tool_use_error>${parts.join(' ')}</tool_use_error>`;
}

/** The message of an error envelope, when the envelope carries one. */
function errorMessageOf(envelope: ToolResultEnvelope): string | undefined {
  const content = envelope.content;
  if (typeof content !== 'object' || content === null || Array.isArray(content)) return undefined;
  const record = content as Record<string, unknown>;
  if (!Object.hasOwn(record, 'message')) return undefined;
  const message = record['message'];
  return typeof message === 'string' ? message : undefined;
}

/**
 * Whether a value is an async iterable of provider events.
 *
 * The member is the well-known `Symbol.asyncIterator`, so the lookup is a read
 * of a fixed member rather than of a caller-supplied key.
 */
function isAsyncIterable(value: unknown): value is AsyncIterable<ProviderEvent> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  return typeof candidate === 'function';
}

/** What a `send` member returned, in words. */
function describeReturned(value: unknown): string {
  if (value instanceof Promise) return 'a promise';
  if (value === null) return 'null';
  return `a value of type ${typeof value}`;
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Whether the abort signal has fired.
 *
 * The signal's `aborted` member is read through a function on purpose: a direct
 * read of the member is narrowed by the type checker after the first check, and
 * the narrowing is wrong — the signal fires *later*, not before the check.
 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/* -------------------------------------------------------------------------- */
/* The abort race                                                              */
/* -------------------------------------------------------------------------- */

/** The outcome of a race against the abort signal. */
type Race<T> = { kind: 'aborted' } | { kind: 'value'; value: T };

/**
 * Race a promise against the abort signal.
 *
 * The promise is never abandoned silently: its rejection is still handled, so a
 * failure that arrives after the abort does not become an unhandled rejection.
 */
async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<Race<T>> {
  if (signal === undefined) return { kind: 'value', value: await promise };
  if (signal.aborted) return { kind: 'aborted' };
  return new Promise<Race<T>>((resolve, reject) => {
    const onAbort = (): void => {
      resolve({ kind: 'aborted' });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ kind: 'value', value });
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Close a stream that is being abandoned. */
async function closeIterator(iterator: AsyncIterator<ProviderEvent>): Promise<void> {
  try {
    if (typeof iterator.return === 'function') await iterator.return(undefined);
  } catch {
    // The stream is being abandoned; a failure to close it changes nothing.
  }
}
