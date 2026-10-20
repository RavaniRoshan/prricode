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
 * ## The events
 *
 * The run produces the **same** events whatever the output format is, and the
 * writers in `src/cli/output.ts` decide how they are written. That is the
 * point of the two modules: the format is an output concern, and the run does
 * not know which format it is written in.
 *
 * **Implementation choice**: the event union is this implementation's own. The audit pins that the
 * `stream-json` format writes one object per event, and not what an event is.
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

import type { AgentRuntime } from '../agent/loop.js';
import { toolResultId, type SessionEvent } from '../session/event.js';

import type { HeadlessEvent } from './output.js';

export type { HeadlessEvent } from './output.js';

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

  yield {
    type: 'result',
    result: assistantText(turn.events),
    is_error: failed,
    stop_reason: turn.stopReason,
    session_id: options.sessionId,
    duration_ms: Math.max(0, now() - startedAt),
    ...(failed && message !== undefined ? { error: message } : {}),
  };
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
