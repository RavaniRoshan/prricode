/**
 * The headless mode: the turn a print run makes, and the events that turn
 * produces.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.10 (The command-line
 * surface) and the `CC-014` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What the headless mode is
 *
 * **Observed** (audit §2.10): "Headless mode is forced by a non-TTY stdout. The
 * headless decision is `--print` (or `-p`), `--init-only`, `--sdk-url`, **or
 * `!process.stdout.isTTY`**." The decision itself belongs to the parser
 * (`src/cli/args.ts`); this module is what a headless run **does** once the
 * decision is made.
 *
 * The rule is the target's own: `chunk-0y0ptpy9.js:3856` reads
 * `return n||t||o||!process.stdout.isTTY` over `--print`/`-p`, `--init-only`,
 * `--sdk-url` and the stdout's TTY-ness.
 *
 * ## The documents a run writes
 *
 * **Established by reading the target's source.** The record is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-permissions-and-headless.md`
 * §2, and every claim there carries a file and a byte offset.
 *
 * | Format | stdout |
 * |---|---|
 * | `text` | the result document's `result` text, plus a newline |
 * | `json` | **exactly one** document: the **result** document |
 * | `stream-json` | **one document per line**, one per message, the **result** last |
 *
 * The **result document** is the target's own, and this module builds it: the
 * member set, the member **order** and the nested shapes are the target's
 * (`chunk-pj5cyqhw.js:300922` for the success variant, `:326977` for the error
 * variant, `:178563` for the `usage` object and `:288789` for a
 * `permission_denials` entry). The target builds the document by spreading the
 * **common** members, then the **variant** members, then `type`, `duration_ms`
 * and `uuid` (`chunk-pj5cyqhw.js:171561`), and this module does the same, so
 * the members arrive on the wire in the target's order.
 *
 * **One deliberate divergence, named.** The target's error variant's `subtype`
 * is one of `error_during_execution`, `error_max_turns`, `error_max_budget_usd`
 * and `error_max_structured_output_retries`; this implementation's is `error`.
 * The value is pinned by a contract test this milestone does not own
 * (`tests/contracts/cli-surface.test.ts`), and the divergence is recorded in
 * `docs/compatibility/command-surface.md`.
 *
 * ## The events
 *
 * The run produces the **same** events whatever the output format is, and the
 * writers in `src/cli/output.ts` decide how they are written. That is the
 * point of the two modules: the format is an output concern, and the run does
 * not know which format it is written in.
 *
 * **Implementation choice**: the event union is this implementation's own. The audit pins that the
 * `stream-json` format writes one object per event, and not what an event is.
 * The target's own stream-json documents are the SDK message kinds —
 * `system`/`init`, `assistant`, `user`, `stream_event` and `result`
 * (`chunk-pj5cyqhw.js:333857`, `:261767`, `:239906`, `:352585`) — and this
 * implementation's events are not those documents. The **result** document is
 * the target's, because the target's `json` format writes exactly that
 * document.
 *
 * ## The turn is the runtime's
 *
 * The headless mode runs **one turn** through the agent runtime
 * (`src/agent/loop.ts`) and does not implement a second turn loop. The runtime
 * is the one that runs the provider request, dispatches the tool calls, records
 * the transcript and answers the refusals; the headless mode only reads the
 * records the turn produced and turns them into events.
 *
 * **A limitation, stated rather than hidden**: the runtime returns the turn's
 * records **when the turn is over**, so the events are produced in one batch
 * rather than one at a time. The `stream-json` format therefore writes one
 * object per event, but it writes them when the turn ends. The runtime's own
 * contract is the reason, and the runtime is not this milestone's to change.
 *
 * ## The stream-json input
 *
 * **Implementation choice.** The audit records that the input format is `text` or
 * `stream-json`, that `--input-format=stream-json` requires
 * `--output-format=stream-json` and that it requires `--print` — and **nothing**
 * about the shape of a document. This implementation reads the shape the target's own SDK
 * protocol uses: the standard input carries **JSON documents**, one per line,
 * and each of them is a **user message** whose content is a string or an array
 * of `{type: 'text', text}` blocks.
 *
 * **A limitation, stated rather than hidden**: this implementation's headless run makes
 * **one** turn, so a stream-json input that carries several user messages
 * contributes the text of all of them to that one turn. The target's
 * stream-json input drives a **persistent session**, one turn per message; that
 * session model is a later milestone's surface.
 */

import { randomUUID } from 'node:crypto';

import type { AgentRuntime, TurnPermissionDenial, TurnUsage } from '../agent/loop.js';
import { builtinCatalog, findModel } from '../provider/catalog.js';
import {
  UNKNOWN_MODEL_COST_TELEMETRY_EVENT,
  catalogCostsOf,
  costOf,
  telemetryModelId,
  type ModelCostRecord,
  type ModelUsage as ProviderModelUsage,
} from '../provider/cost.js';
import { toolResultId, type SessionEvent } from '../session/event.js';
import { raiseTelemetryEvent } from '../telemetry/emitter.js';

import type { HeadlessEvent } from './output.js';

export type { HeadlessEvent } from './output.js';

/* -------------------------------------------------------------------------- */
/* The documents                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The token usage the target's result document carries.
 *
 * **The target's own shape** — `chunk-pj5cyqhw.js:178563` is the schema and
 * `chunk-05nax923.js:11` is the target's **zeroed** usage object, which is the
 * value a run that spent no tokens carries. The member **order** is the
 * zeroed object's, because that is the order the target puts on the wire.
 */
export interface HeadlessUsage {
  /** The thinking tokens, counted inside `output_tokens`. */
  output_tokens_details: { thinking_tokens: number };
  /** The input tokens the run spent. */
  input_tokens: number;
  /** The tokens written to the cache. */
  cache_creation_input_tokens: number;
  /** The tokens read from the cache. */
  cache_read_input_tokens: number;
  /** The output tokens the run spent. */
  output_tokens: number;
  /** The server-side tool requests the run made. */
  server_tool_use: { web_search_requests: number; web_fetch_requests: number };
  /** The service tier the run was served on. */
  service_tier: string;
  /** The cache writes, by their time to live. */
  cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
  /** The geography the inference ran in. */
  inference_geo: string;
  /** The per-iteration usage, when the request ran several iterations. */
  iterations: unknown[];
  /** The speed the request ran at. */
  speed: string;
  /** The outcome of a fallback-credit token the request presented. */
  fallback_credit: unknown;
}

/**
 * The usage of one model, as the target's `modelUsage` records it.
 *
 * The target's own shape — `chunk-pj5cyqhw.js:180551`.
 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
  canonicalModel?: string;
  provider?: string;
  costBasis?: 'list' | 'managed' | 'unknown';
}

/**
 * A permission denial the target's result document carries.
 *
 * The target's own shape — `chunk-pj5cyqhw.js:288789`:
 * `{tool_name, tool_use_id, tool_input}`.
 */
export interface PermissionDenial {
  /** The tool the refused call named. */
  tool_name: string;
  /** The id of the refused call. */
  tool_use_id: string;
  /** The input the refused call would have run. */
  tool_input: Record<string, unknown>;
}

/**
 * The result document — the `json` format's **one** document, and the
 * `stream-json` format's **last**.
 *
 * **The target's own document.** The member set and the member **order** are
 * the target's: the target builds it by spreading the **common** members, then
 * the **variant** members, and then `type`, `duration_ms` and `uuid`
 * (`chunk-pj5cyqhw.js:171561`), and this module does the same.
 *
 * The members this implementation cannot fill are the target's own defaults:
 * `total_cost_usd` is `0` (this implementation has no cost model — the
 * target's own zeroed result carries `0` too, `chunk-05nax923.js:1868`),
 * `modelUsage` is the empty record (the same member, the same default), and
 * `duration_api_ms` is `0` (this implementation does not time the provider's
 * requests separately from the turn).
 */
export interface ResultDocument {
  /** Whether the run failed. */
  is_error: boolean;
  /** The time the run spent in provider requests. */
  duration_api_ms: number;
  /** The number of provider rounds the run made. */
  num_turns: number;
  /** The provider's own stop reason, when it reported one. */
  stop_reason: string | null;
  /** The session the run belonged to. */
  session_id: string;
  /** The cost the run incurred. */
  total_cost_usd: number;
  /** The token usage the run spent. */
  usage: HeadlessUsage;
  /** The usage, per model. */
  modelUsage: Record<string, ModelUsage>;
  /** The calls a permission rule refused. */
  permission_denials: PermissionDenial[];
  /** What the run was. */
  subtype: 'success' | 'error';
  /** The assistant's text. */
  result: string;
  /** The failures, when the run failed. */
  errors?: string[];
  /** The document's type. */
  type: 'result';
  /** How long the run took. */
  duration_ms: number;
  /** The document's id. */
  uuid: string;
}

/**
 * The target's **zeroed** usage object.
 *
 * `chunk-05nax923.js:11` — the usage a run that spent no tokens carries. The
 * member order is that object's, because that is the order the target puts on
 * the wire.
 */
export const ZERO_USAGE: HeadlessUsage = {
  output_tokens_details: { thinking_tokens: 0 },
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
  fallback_credit: null,
};

/**
 * The usage a turn's accounting maps onto.
 *
 * The **runtime's** numbers — `src/agent/loop.ts` — in the target's wire
 * shape. The members the runtime does not know stay at the target's own
 * zeroed values.
 */
export function usageOf(usage: TurnUsage | undefined): HeadlessUsage {
  return {
    ...ZERO_USAGE,
    output_tokens_details: { ...ZERO_USAGE.output_tokens_details },
    server_tool_use: { ...ZERO_USAGE.server_tool_use },
    cache_creation: { ...ZERO_USAGE.cache_creation },
    iterations: [...ZERO_USAGE.iterations],
    ...(usage === undefined
      ? {}
      : {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_creation_input_tokens: usage.cacheCreationInputTokens,
          cache_read_input_tokens: usage.cacheReadInputTokens,
        }),
  };
}

/**
 * The denials a turn's accounting maps onto.
 *
 * The **runtime's** records — `src/agent/loop.ts` — in the target's wire
 * shape (`chunk-pj5cyqhw.js:288789`).
 */
export function denialsOf(
  denials: readonly TurnPermissionDenial[] | undefined,
): PermissionDenial[] {
  if (denials === undefined) return [];
  return denials.map((denial) => ({
    tool_name: denial.toolName,
    tool_use_id: denial.toolUseId,
    tool_input: isPlainRecord(denial.input) ? denial.input : {},
  }));
}

/** Whether a value is a plain record. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The cost of a turn, and the per-model record the result document carries.
 *
 * The target prices the turn out of the **catalog**, and a model the catalog does
 * not know leaves the cost **unmeasured** — the target records
 * `tengu_unknown_model_cost` and says so, with the **model** and its **short
 * name** (`chunk-dt3pd9ft.js:268732`).
 *
 * This implementation records the same event, with the same two properties: the
 * **model** is the id the run asked for, and the **short name** is the
 * **canonical** id the catalog knows it by — absent when the catalog does not
 * know the model at all, which is the target's own rule for an absent id.
 */
export function costOfTurn(
  model: string,
  usage: TurnUsage | undefined,
  onTelemetry?: (event: unknown) => void,
): { totalCostUsd: number; modelUsage: Record<string, ModelUsage> } {
  if (usage === undefined) return { totalCostUsd: 0, modelUsage: {} };

  const costs = catalogCostsOf(builtinCatalog, model);
  if (costs === undefined) {
    raiseTelemetryEvent(
      {
        name: UNKNOWN_MODEL_COST_TELEMETRY_EVENT,
        model: telemetryModelId(model),
        shortName: telemetryModelId(findModel(builtinCatalog, model)?.id),
      },
      onTelemetry,
    );
    return { totalCostUsd: 0, modelUsage: {} };
  }

  const providerUsage: ProviderModelUsage = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
  };
  const cost = costOf(costs, providerUsage);

  const record: ModelCostRecord = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    webSearchRequests: 0,
    costUSD: cost,
    contextWindow: 0,
    maxOutputTokens: 0,
    canonicalModel: model,
    provider: '',
    costBasis: 'list',
  };

  return { totalCostUsd: cost, modelUsage: { [model]: toModelUsage(record) } };
}

/** The target's `modelUsage` member, from the ledger's record. */
function toModelUsage(record: ModelCostRecord): ModelUsage {
  return {
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadInputTokens: record.cacheReadInputTokens,
    cacheCreationInputTokens: record.cacheCreationInputTokens,
    webSearchRequests: record.webSearchRequests,
    costUSD: record.costUSD,
    contextWindow: record.contextWindow,
    maxOutputTokens: record.maxOutputTokens,
    canonicalModel: record.canonicalModel,
    provider: record.provider,
    costBasis: record.costBasis,
  };
}

/**
 * Build the result document.
 *
 * The **common** members, then the **variant** members, then `type`,
 * `duration_ms` and `uuid` — the target's own order
 * (`chunk-pj5cyqhw.js:171561`).
 */
export function buildResultDocument(input: {
  /** Whether the run failed. */
  isError: boolean;
  /** The assistant's text. */
  result: string;
  /** The failures, when the run failed. */
  errors?: readonly string[];
  /** The provider's own stop reason. */
  stopReason: string | null;
  /** The session the run belonged to. */
  sessionId: string;
  /** How long the run took. */
  durationMs: number;
  /** The number of provider rounds the run made. */
  numTurns: number;
  /** The token usage the run spent. */
  usage: HeadlessUsage;
  /** The cost the run incurred, in US dollars. */
  totalCostUsd?: number;
  /** The usage, per model. */
  modelUsage?: Record<string, ModelUsage>;
  /** The calls a permission rule refused. */
  permissionDenials: PermissionDenial[];
  /** The document's id. */
  uuid: string;
}): ResultDocument {
  const common = {
    is_error: input.isError,
    duration_api_ms: 0,
    num_turns: input.numTurns,
    stop_reason: input.stopReason,
    session_id: input.sessionId,
    total_cost_usd: input.totalCostUsd ?? 0,
    usage: input.usage,
    modelUsage: input.modelUsage ?? ({} as Record<string, ModelUsage>),
    permission_denials: input.permissionDenials,
  };
  const variant = input.isError
    ? {
        subtype: 'error' as const,
        result: input.result,
        ...(input.errors !== undefined ? { errors: [...input.errors] } : {}),
      }
    : { subtype: 'success' as const, result: input.result };
  return {
    ...common,
    ...variant,
    type: 'result',
    duration_ms: input.durationMs,
    uuid: input.uuid,
  };
}

/* -------------------------------------------------------------------------- */
/* The options                                                                 */
/* -------------------------------------------------------------------------- */

/** The options a headless run runs with. */
export interface HeadlessOptions {
  /** The prompt the turn runs. */
  prompt: string;
  /** The session the turn belongs to. */
  sessionId: string;
  /** The model the turn runs on. */
  model: string;
  /** The runtime that runs the turn. */
  runtime: AgentRuntime;
  /** The signal that stops the turn. */
  signal?: AbortSignal;
  /** The clock, for the run's duration. */
  now?: () => number;
  /**
   * The telemetry sink.
   *
   * The turn records `tengu_unknown_model_cost` when the model has no price,
   * and the sink is where the event goes. It is optional: a caller with no
   * telemetry pipeline simply does not receive the event.
   */
  telemetry?: (event: unknown) => void;
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Run one turn and yield the events it produced.
 *
 * The run yields the events of the turn in the order the transcript recorded
 * them, and the **result** of the run last. The result event is what the exit
 * code is derived from, so a caller that reads the events and a caller that
 * reads the exit code see the same thing.
 */
export async function* runHeadless(options: HeadlessOptions): AsyncIterable<HeadlessEvent> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const turn = await options.runtime.runTurn(
    { prompt: options.prompt, sessionId: options.sessionId, model: options.model },
    options.signal,
  );

  for (const record of turn.events) {
    for (const event of eventsOf(record)) yield event;
  }

  const failed = turn.stopReason === 'error' || turn.stopReason === 'aborted';
  const message = turn.message;

  // The result event **is** the target's result document: the same members, in
  // the same order, so the `stream-json` format's last document is the target's
  // document and the `json` format's one document is the same object.
  yield buildResultDocument({
    isError: failed,
    result: assistantText(turn.events),
    errors: failed && message !== undefined ? [message] : undefined,
    // The **provider's** stop reason, when it reported one: the target's result
    // document carries the provider's own reason, and it is nullable
    // (`chunk-pj5cyqhw.js:326977`).
    stopReason: turn.providerStopReason ?? null,
    sessionId: options.sessionId,
    durationMs: Math.max(0, now() - startedAt),
    numTurns: turn.numTurns ?? 0,
    usage: usageOf(turn.usage),
    ...costOfTurn(options.model, turn.usage, options.telemetry),
    permissionDenials: denialsOf(turn.permissionDenials),
    uuid: randomUUID(),
  });
}

/* -------------------------------------------------------------------------- */
/* The stream-json input                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of reading a `stream-json` input.
 *
 * The two cases are: the input carried text, or the input carried something the
 * implementation cannot read. The second is an **error**, not an empty prompt: a
 * document this implementation cannot read must not become a run with no prompt.
 */
export type StreamJsonRead =
  /** The input carried text. */
  | { kind: 'ok'; prompt: string }
  /** The input carried a line that is not JSON, or a document with no text. */
  | { kind: 'invalid'; message: string };

/**
 * Read the prompt a `stream-json` input carries.
 *
 * The standard input carries **JSON documents**, one per line. Each document is
 * a **user message**: its `message.content` — or its own `content` — is either
 * a string or an array of `{type: 'text', text}` blocks. The text of every
 * document is the prompt of the one turn this implementation makes.
 *
 * **Implementation choice.** The audit records the input format and not the shape of a
 * document; the shape read here is the one the target's SDK protocol uses, and
 * this implementation says so rather than pretending the audit settled it.
 */
export function readStreamJsonInput(text: string): StreamJsonRead {
  const documents: string[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        kind: 'invalid',
        message: 'Error: the stream-json input carries a line that is not JSON.',
      };
    }

    const content = contentOf(parsed);
    if (content === undefined) {
      return {
        kind: 'invalid',
        message: 'Error: the stream-json input carries a document with no text.',
      };
    }
    documents.push(content);
  }

  return { kind: 'ok', prompt: documents.join('\n') };
}

/**
 * The text a document carries, when it carries any.
 *
 * The document is read through **own-property** checks only, so a document that
 * names an inherited member of `Object.prototype` is a document with no text
 * rather than a crash.
 */
function contentOf(document: unknown): string | undefined {
  if (typeof document !== 'object' || document === null) return undefined;
  const record = document as Record<string, unknown>;

  const message = ownValue(record, 'message');
  if (typeof message === 'object' && message !== null) {
    const content = ownValue(message as Record<string, unknown>, 'content');
    const text = textOf(content);
    if (text !== undefined) return text;
  }

  return textOf(ownValue(record, 'content'));
}

/**
 * The value of an **own** property.
 *
 * The lookup is guarded, so a key that names an inherited member of
 * `Object.prototype` (`constructor`, `toString`, `__proto__`, …) is reported as
 * absent rather than resolving to the inherited member.
 */
function ownValue(record: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(record, key)) return undefined;
  return record[key];
}

/** The text a content value carries: a string, or the text blocks of an array. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;

  const parts: string[] = [];
  for (const block of value) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (ownValue(record, 'type') !== 'text') continue;
    const text = ownValue(record, 'text');
    if (typeof text !== 'string') continue;
    parts.push(text);
  }
  return parts.join('');
}

/* -------------------------------------------------------------------------- */
/* The mapping                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The events one transcript record produces.
 *
 * A record that produces no event — the user's own prompt, a permission
 * decision, a compaction boundary — produces none: the headless mode reports
 * what the model produced and what the tools did, and the rest of the
 * transcript is the transcript's own business.
 */
function eventsOf(record: SessionEvent): HeadlessEvent[] {
  switch (record.t) {
    case 'assistant_message':
      return [{ type: 'text', text: record.text }];
    case 'tool_call':
      return [{ type: 'tool_use', id: record.id, name: record.name, input: record.input }];
    case 'tool_result':
      return [
        {
          type: 'tool_result',
          id: toolResultId(record.envelope),
          content: record.envelope.content,
          is_error: record.envelope.isError,
        },
      ];
    case 'provider_event':
      if (record.event.type === 'error') {
        return [{ type: 'error', message: record.event.message }];
      }
      return [];
    default:
      return [];
  }
}

/** The assistant's text, over the records of a turn. */
function assistantText(records: readonly SessionEvent[]): string {
  let text = '';
  for (const record of records) {
    if (record.t === 'assistant_message') text += record.text;
  }
  return text;
}
