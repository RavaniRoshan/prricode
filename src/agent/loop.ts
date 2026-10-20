/**
 * The agent runtime: the turn cycle, the permission integration, the abort path
 * and the persistence of everything the turn produces.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and tool
 * dispatch), §2.5 (Permissions) and §2.6 (Sessions, persistence, and resumption),
 * and the `CC-010` milestone of
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
 * The audit records the pieces: "the agent turn is a streaming
 * `beta.messages.create`" and "response events are consumed as `stream_event`s"
 * (§2.4); "permission decisions are threaded back to the model through the tool
 * result, so the model observes the decision and its reason type" (§2.4); and
 * the session's transcript is the append-only JSONL log (§2.6).
 *
 * ## The dispatch order is a implementation choice
 *
 * The runtime runs the tool calls of one assistant message **in the order they
 * appear**, and it appends each result **before** the next provider request is
 * issued.
 *
 * **That is a implementation choice, not an observed target behaviour.** The audit is
 * explicit (§2.4, "Partial", and §4 item 4): "the exact **scheduling of
 * concurrent tool calls** — whether several `tool_use` blocks in one assistant
 * message run in parallel or in sequence, and the point at which the next model
 * request is issued — was not traced". It is one of the three bounded REA
 * residuals. This implementation therefore runs them sequentially because the plan says
 * so, and the module says so rather than claiming the target does.
 *
 * ## The permission integration
 *
 * A tool call is **permission-checked before it runs**, and the decision is
 * honoured:
 *
 *   - `allow` — the tool runs.
 *   - `deny` — the tool does **not** run. The turn ends with the refusal
 *     recorded, and **no** tool result is sent back to the provider as if the
 *     tool had run.
 *   - `ask` — the runtime **cannot prompt**: there is no user interface in this
 *     milestone, so the call is **refused** rather than run, and the refusal is
 *     recorded. The CLI and UI tasks (`CC-014`, `CC-015`) supply the prompt
 *     through the `approveAsk` dependency, and the permission service's own
 *     `canUseTool` prompt is the second seam.
 *
 * A tool name that is **not registered** is a refusal, not a crash.
 *
 * **Two checks are consulted, and the stricter verdict governs.** The tool's
 * own check (`ToolDefinition.checkPermissions`) and the session's permission
 * service (`checkPermission`) are both consulted for every call:
 *
 *   - a `deny` from either one blocks the call;
 *   - an `ask` from either one refuses it — with **one** exception: the
 *     service's *generic* "no rule matched" prompt (`reasonKind:
 *     'noRuleMatch'`) does not override a call the tool's own check allowed,
 *     because that prompt carries no rule. Every other `ask` — an ask rule, a
 *     mode-level refusal, a safety check — restricts the call;
 *   - two `allow`s are the tool's own.
 *
 * For this implementation's built-in tools the two checks are the *same* check — the tool
 * holds the session's rules and mode, and the prompt — so the session's
 * `PermissionRequest` hook is invoked twice per call. The duplication cannot
 * widen a decision (the stricter verdict governs and a rewrite is re-checked),
 * but a caller that wants the hook to fire **once** binds the runtime's
 * `permission` service to a hook-free variant and lets the tool's own check
 * carry the hook and the prompt.
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
 * | `tool_use` | `tool_use` | the turn ended with a pending call — a denial or a refusal, so no result was produced |
 * | `stop_sequence` | `end_turn` | **implementation choice**: the turn finished with no pending tool call, and `end_turn` is the union's member for that |
 * | `refusal` | `end_turn` | **implementation choice**: the same — a refusal is a completed turn, not a failure of the runtime |
 *
 * The provider's exact stop reason is preserved in
 * `TurnResult.providerStopReason`, so a `stop_sequence` and a `refusal` remain
 * distinguishable to a caller even though the runtime's five-member union
 * cannot express them.
 *
 * ## What the runtime records
 *
 * Every provider event becomes a `provider_event` record; the prompt becomes a
 * `user_message`; the assistant's text becomes an `assistant_message`; every
 * tool call becomes a `tool_call`; every permission decision becomes a
 * `permission_request`; and every tool result that reached the provider becomes
 * a `tool_result`.
 *
 * **A refused call produces no `tool_result` record.** The result was never
 * sent to the provider, so recording one would claim a conversation that did
 * not happen — and the transcript is replayed to the model when the session is
 * resumed. The refusal is in the transcript as the `permission_request`
 * record. (This is a **divergence from the target**, which answers a denied
 * call with a `<tool_use_error>` tool result; this implementation ends the turn instead,
 * and the header says so rather than claiming the target does.)
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - the **output-token budget** of a request that does not name one;
 *   - the **number of tool rounds** a turn may run before the runtime gives up;
 *   - the way a tool result's content is carried into the request (a string as
 *     it is, anything else as its JSON serialization);
 *   - the fact that a call whose **input validation** failed is reported back
 *     to the provider as an error result (the audit records the target's
 *     `<tool_use_error>` for a validation failure), while a call that was
 *     **refused** ends the turn.
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
} from '../provider/drivers/types.js';
import { SESSION_SCHEMA_VERSION, type SessionEvent } from '../session/event.js';
import type { SessionHandle, SessionStore } from '../session/store.js';
import type { ToolDefinition, ToolRegistry, ToolRecheck } from '../tools/registry.js';
import { runTool, type ToolResultEnvelope } from '../tools/runner.js';

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
import { callsInPlan, groupToolCalls, toolCallsFrom, type ToolCall } from './dispatch.js';

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
   * driver that carries a `send` member is also the turn **source**. A caller
   * that keeps the transport elsewhere supplies a `source` instead.
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
  /** The transport, when the driver does not carry one. */
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

  /**
   * The key a session's handle is kept under.
   *
   * The session id is **caller-supplied** data, so it is never a bare index
   * into an object: the key is a `Map` key, and the map is the only lookup.
   */
  function sessionKey(sessionId: string): string {
    return `${cwd}\u0000${sessionId}`;
  }

  async function handleFor(sessionId: string): Promise<SessionHandle> {
    const key = sessionKey(sessionId);
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
    if (deps.permissionOptions !== undefined) return deps.permissionOptions;
    return { rules: { allow: [], deny: [], ask: [], cwd }, mode: 'default' };
  }

  async function runTurn(input: TurnInput, signal?: AbortSignal): Promise<TurnResult> {
    const events: SessionEvent[] = [];

    let handle: SessionHandle;
    try {
      handle = await handleFor(input.sessionId);
    } catch {
      // The session could not be opened: there is nowhere to record the turn.
      return { events, stopReason: 'error' };
    }

    const append = async (event: SessionEvent): Promise<void> => {
      await deps.store.append(handle, event);
      events.push(event);
    };

    /** The turn stopped because the signal fired. */
    const aborted = async (): Promise<TurnResult> => {
      await appendSafely({
        ...base(),
        t: 'provider_event',
        event: { type: 'error', message: ABORTED_MESSAGE, retryable: false },
      });
      return { events, stopReason: 'aborted' };
    };

    /** The turn failed. */
    const failed = async (message: string): Promise<TurnResult> => {
      await appendSafely({
        ...base(),
        t: 'provider_event',
        event: { type: 'error', message, retryable: false },
      });
      return { events, stopReason: 'error' };
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
        if (collected.kind === 'error') return failed(collected.message ?? 'The provider request failed.');

        const summary = summarise(collected.events);

        // The provider reported an error: the turn ends with it.
        if (summary.error !== undefined) {
          return {
            events,
            stopReason: 'error',
            providerStopReason: summary.stopReason,
          };
        }

        if (summary.text !== '') {
          await append({ ...base(), t: 'assistant_message', text: summary.text });
        }

        // No pending tool call: the turn ends with the provider's stop reason.
        if (summary.calls.length === 0) {
          return {
            events,
            stopReason: mapStopReason(summary.stopReason),
            providerStopReason: summary.stopReason,
          };
        }

        // The tool calls of this assistant message. **Implementation choice**: they run
        // in the order they appear — see the module header.
        const plan = groupToolCalls(summary.calls);
        const order = callsInPlan(summary.calls, plan);
        const resultBlocks: ProviderContentBlock[] = [];
        let refused = false;

        for (const call of order) {
          if (isAborted(signal)) return aborted();

          await append({
            ...base(),
            t: 'tool_call',
            id: call.id !== '' ? call.id : idFactory(),
            name: call.name,
            input: call.input,
          });

          const outcome = await dispatchCall(call, input.sessionId, signal);
          if (outcome.kind === 'aborted') return aborted();

          const envelope = outcome.envelope;
          if (envelope === undefined) {
            return failed('The tool call produced no result.');
          }

          await append({
            ...base(),
            t: 'permission_request',
            toolName: call.name,
            decision: outcome.decision,
          });

          if (outcome.kind === 'refused') {
            // The call did not run. No result is sent back to the provider as if
            // it had, and the turn ends here.
            refused = true;
            break;
          }
          if (outcome.kind === 'failed') {
            return failed(outcome.message ?? 'The tool call failed.');
          }

          await append({ ...base(), t: 'tool_result', envelope });
          resultBlocks.push(toolResultBlock(call.id, envelope.content, envelope.isError));
        }

        if (refused) {
          // The conversation keeps the assistant's text but not the unanswered
          // call: a request that carries a tool call nothing answers is not
          // well-formed.
          if (summary.text !== '') {
            pushAssistant(conversation, [{ type: 'text', text: summary.text }]);
          }
          return {
            events,
            stopReason: 'tool_use',
            providerStopReason: summary.stopReason,
          };
        }

        // The assistant's message and the results go into the conversation, and
        // the **next** request carries them.
        pushAssistant(conversation, assistantBlocks(summary));
        pushToolResults(conversation, resultBlocks);
      }

      return failed(`The turn ran more than ${maxTurns} tool rounds, so it was stopped.`);
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
  ): Promise<CallOutcome> {
    const holder: DecisionHolder = { decision: undefined };
    const ctx = toolContextFor(call, sessionId);

    const raced = await raceAbort(
      runTool(wrappedRegistry(holder), call.name, call.input, ctx, {
        approveAsk: deps.approveAsk,
        cwd,
      }),
      signal,
    );

    if (raced.kind === 'aborted') {
      // The tool was abandoned: its result is neither appended nor sent back to
      // the provider.
      return { kind: 'aborted', decision: holder.decision };
    }

    const envelope = raced.value;
    const kind = envelope.nonExecutionKind;

    if (kind === 'permission_denied' || kind === 'permission_unresolved' || kind === 'unknown_tool') {
      // A denial, an unresolved approval and an unknown tool are **refusals**:
      // the call did not run, and the turn ends with it.
      return {
        kind: 'refused',
        envelope,
        decision: recordedDecision(holder.decision, envelope),
      };
    }

    if (kind === 'permission_check_failed') {
      // The permission service itself failed: the runtime failed.
      return {
        kind: 'failed',
        envelope,
        decision: recordedDecision(holder.decision, envelope),
        message: errorMessageOf(envelope) ?? 'The permission check failed.',
      };
    }

    // The tool ran — or the call failed inside it, which the model observes.
    return {
      kind: 'ran',
      envelope,
      decision: recordedDecision(holder.decision, envelope),
    };
  }

  /**
   * A registry whose tools carry the runtime's permission integration.
   *
   * The wrapper is what makes the **session's** permission service part of the
   * check the runner performs, and what makes a rewritten input run the whole
   * check again.
   */
  function wrappedRegistry(holder: DecisionHolder): ToolRegistry {
    return {
      register(): void {
        throw new Error('The agent runtime does not register tools.');
      },
      get(name: string): ToolDefinition | undefined {
        const tool = deps.registry.get(name);
        return tool === undefined ? undefined : wrapTool(tool, holder);
      },
      list(): readonly ToolDefinition[] {
        return deps.registry.list().map((tool) => wrapTool(tool, holder));
      },
    };
  }

  function wrapTool(tool: ToolDefinition, holder: DecisionHolder): ToolDefinition {
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
          return own;
        }
        const service = await deps.permission(ctx, permissionOptions());
        const effective = combineDecisions(own, service);
        holder.decision = effective;
        return effective;
      },
      recheckPermission: async (input: unknown, ctx: ToolContext): Promise<ToolRecheck> => {
        // The **whole** check, run again with the effective (rewritten) input:
        // the tool's own re-check and the session's service, both with the
        // rewritten input. The re-check may only restrict the call.
        const own = await tool.recheckPermission(input, ctx);
        const service = await deps.permission(ctx, permissionOptions());
        const effective = combineDecisions(own.decision, service);
        holder.decision = stricterDecision(holder.decision, effective);
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
        message: 'The provider driver cannot send a request: it carries no turn source.',
      };
    }

    let iterator: AsyncIterator<ProviderEvent>;
    try {
      iterator = source.send(request, signal)[Symbol.asyncIterator]();
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
  /** The runner's envelope, when the call produced one. */
  envelope?: ToolResultEnvelope;
  /** The decision that governed the call. */
  decision: PermissionDecision | undefined;
  /** The message of a failure. */
  message?: string;
}

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
  error: ProviderEvent | undefined;
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
  let error: ProviderEvent | undefined;
  for (const event of events) {
    switch (event.type) {
      case 'text_delta':
        text += event.text;
        break;
      case 'message_stop':
        stopReason = event.stopReason;
        break;
      case 'error':
        error = event;
        break;
      default:
        break;
    }
  }
  return { text, calls: toolCallsFrom(events), stopReason, error };
}

/**
 * The blocks of the assistant's message.
 *
 * The text it produced and the tool calls it made, in that order.
 */
function assistantBlocks(summary: TurnSummary): ProviderContentBlock[] {
  const blocks: ProviderContentBlock[] = [];
  if (summary.text !== '') blocks.push({ type: 'text', text: summary.text });
  for (const call of summary.calls) {
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
  if (only !== undefined && only.reasonKind === 'noRuleMatch' && toolDecision.behavior === 'allow') {
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
  const summary = envelope.permissionDecision;
  if (summary === undefined) return undefined;
  const decision: PermissionDecision = {
    behavior: summary.decision,
    source: summary.source,
    reasonType: summary.reasonType ?? 'other',
  };
  const message = errorMessageOf(envelope);
  if (message !== undefined) decision.reason = message;
  return decision;
}

/**
 * The decision the transcript records.
 *
 * The envelope carries the decision that **governed** the call — the one an
 * approval settled, when the prompt resolved an `ask` — so its summary wins
 * over the decision the runtime computed before the call ran.
 */
export function recordedDecision(
  computed: PermissionDecision | undefined,
  envelope: ToolResultEnvelope,
): PermissionDecision | undefined {
  if (computed === undefined) return decisionFromEnvelope(envelope);
  const summary = envelope.permissionDecision;
  if (summary === undefined) return computed;
  return {
    ...computed,
    behavior: summary.decision,
    source: summary.source,
    reasonType: summary.reasonType ?? computed.reasonType,
  };
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
