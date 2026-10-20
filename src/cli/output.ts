/**
 * The output contracts: the format vocabulary, the events a headless run
 * produces, the documents those events are written as, and the writers that put
 * them on the wire.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.10 (The command-line
 * surface) and the `CC-014` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What is observed and what is a implementation choice
 *
 * **Observed** (audit §2.10): "The **input format** is `text` or `stream-json`;
 * the **output format** is `text`, `json` or `stream-json`." and the headless
 * rule — "Headless mode is forced by a non-TTY stdout."
 *
 * **Established by reading the target's own source**: what each format writes.
 * The record is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-permissions-and-headless.md`
 * §2, and every claim there carries a file and a byte offset. The summary:
 *
 *   - `text` writes the result document's `result` text, plus a newline, and
 *     the failure's detail on stderr (`chunk-e7w77ts3.js:445913`);
 *   - `json` writes **exactly one** document — the **result** document
 *     (`chunk-e7w77ts3.js:529318`), and with `--verbose` a JSON **array** of
 *     every significant message instead;
 *   - `stream-json` writes **one document per line**, one per message, and the
 *     **last** document is the result document (`chunk-btsgvmny.js:29557`).
 *
 * **The result document is the target's own** — its member set, its member
 * order and its nested shapes — and it is built in `src/cli/headless.ts`,
 * because the document belongs to the run and not to the writer. The
 * **other** documents are this implementation's own: the target's stream-json
 * documents are the SDK message kinds (`system`/`init`, `assistant`, `user`,
 * `stream_event` and `result` — `chunk-pj5cyqhw.js:333857`, `:261767`,
 * `:239906`, `:352585`) and this implementation's events are not those
 * documents. The three places where this implementation knowingly differs
 * from the target are named in `docs/compatibility/command-surface.md`.
 *
 * ## The exit codes
 *
 * The audit records this implementation's two known ones: "`1` for a failed session lookup
 * and `2` for an argument error". They are named here so that a caller does not
 * have to remember the numbers:
 *
 *   - `EXIT_SUCCESS` — the run finished;
 *   - `EXIT_FAILURE` — the run failed (a provider error, a failed session
 *     lookup);
 *   - `EXIT_USAGE` — the arguments were wrong.
 *
 * ## The formats
 *
 *   - `text` — the assistant's text, and nothing else. The text of a failed run
 *     goes to **stderr**, so that stdout stays the answer and a pipeline can
 *     trust it.
 *   - `json` — **exactly one** JSON document: the result of the run. The
 *     document is written even when the run failed, because a machine reading
 *     the document has to be able to tell a success from a failure without
 *     parsing the exit code.
 *   - `stream-json` — **one JSON object per event**, one per line.
 *
 * The `json` document is written **after** the run. The `stream-json` objects
 * are written **as the events arrive** in the target — that is the difference
 * between the two formats, and it is the whole reason the target has both.
 * This implementation's own behavior is the **one-batch** limitation stated below.
 *
 * **A limitation, stated rather than hidden**: the runtime returns the turn's
 * records **when the turn is over**, so the events are produced in **one
 * batch** rather than one at a time. The `stream-json` format therefore writes
 * one object per event, but it writes them when the turn ends — the same
 * limitation `src/cli/headless.ts` records. The runtime's own contract is the
 * reason, and the runtime is not this milestone's to change.
 */

import { randomUUID } from 'node:crypto';

import { buildResultDocument, usageOf, type ResultDocument } from './headless.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The output formats, exactly as the audit names them.
 *
 * **Observed** (audit §2.10): "the **output format** is `text`, `json` or
 * `stream-json`".
 */
export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;

/** One of the three output formats. */
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/**
 * The input formats, exactly as the audit names them.
 *
 * **Observed** (audit §2.10): "The **input format** is `text` or `stream-json`".
 */
export const INPUT_FORMATS = ['text', 'stream-json'] as const;

/** One of the two input formats. */
export type InputFormat = (typeof INPUT_FORMATS)[number];

/**
 * Whether a value is one of the three output formats.
 *
 * The check is a membership test against the frozen list, so a value that is not
 * a format is not a format — an inherited member of `Object.prototype` is not in
 * the list and cannot be.
 */
export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === 'string' && (OUTPUT_FORMATS as readonly string[]).includes(value);
}

/**
 * Whether a value is one of the two input formats.
 */
export function isInputFormat(value: unknown): value is InputFormat {
  return typeof value === 'string' && (INPUT_FORMATS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* The exit codes                                                              */
/* -------------------------------------------------------------------------- */

/** The run finished. */
export const EXIT_SUCCESS = 0;

/** The run failed: a provider error, a failed session lookup. */
export const EXIT_FAILURE = 1;

/** The arguments were wrong. */
export const EXIT_USAGE = 2;

/**
 * The result a command returns.
 *
 * One definition, shared by every command in the CLI: the headless writer, the
 * provider manager, the catalog browser and the picker all return this record,
 * so a caller reads one shape whatever produced it.
 */
export interface CommandResult {
  /** The exit code: `0` success, `1` failure, `2` a usage error. */
  exitCode: number;
  /** The text written to stdout. */
  stdout: string;
  /** The text written to stderr. */
  stderr: string;
  /** The machine-readable payload, when the command produced one. */
  data?: unknown;
}

/* -------------------------------------------------------------------------- */
/* The events                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The events a headless run produces.
 *
 * The union is this implementation's own: the audit pins that the `stream-json` format
 * writes one object per event, and not what an event is. The five members cover
 * everything a turn produces — the assistant's text, the tool calls it made, the
 * results those calls produced, the errors, and the result of the run itself.
 *
 * The **result** member is not this implementation's own: it is the **target's**
 * result document, member for member and member for member in the target's own
 * order (`chunk-pj5cyqhw.js:171561`), so the `stream-json` format's **last**
 * document is the target's document. The document's type and the builder live in
 * `src/cli/headless.ts`.
 */
export type HeadlessEvent =
  /** The assistant produced text. */
  | { type: 'text'; text: string }
  /** The assistant asked for a tool to run. */
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  /** A tool produced a result. */
  | { type: 'tool_result'; id: string; content: unknown; is_error: boolean }
  /** Something failed. */
  | { type: 'error'; message: string }
  /** The run finished — the target's own result document. */
  | ResultDocument;

/**
 * The single document the `json` format writes.
 *
 * **The target's own document.** The member set, the member **order** and the
 * nested shapes are the target's; the record is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-permissions-and-headless.md`
 * §2. The type and the builder live in `src/cli/headless.ts`, because the
 * document belongs to the run and not to the writer.
 */
export type { ResultDocument } from './headless.js';

/* -------------------------------------------------------------------------- */
/* The sink                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A stream the output is written to.
 *
 * The shape is `process.stdout`'s and `process.stderr`'s, so the process's own
 * streams satisfy it without an adapter — and a test can supply a collector.
 */
export interface OutputSink {
  /** Write a chunk. */
  write(chunk: string): unknown;
}

/* -------------------------------------------------------------------------- */
/* The writers                                                                 */
/* -------------------------------------------------------------------------- */

/** The options the headless output is written with. */
export interface HeadlessOutputOptions {
  /** The events the run produced. */
  events: AsyncIterable<HeadlessEvent>;
  /** The format the output is written in. */
  format: OutputFormat;
  /** The stream the output goes to. */
  stdout: OutputSink;
  /** The stream the failures go to. */
  stderr: OutputSink;
}

/**
 * Write a headless run's events, and return the exit code the run ends with.
 *
 * The exit code is the run's own: `EXIT_SUCCESS` when the run finished and
 * `EXIT_FAILURE` when it did not. It is derived from the **result** event, so
 * the three formats agree on it — a machine reading the `json` document and a
 * machine reading the exit code see the same thing.
 */
export async function writeHeadlessOutput(options: HeadlessOutputOptions): Promise<number> {
  const { events, format, stdout, stderr } = options;

  let result: Extract<HeadlessEvent, { type: 'result' }> | undefined;
  let text = '';
  let failure: string | undefined;
  let wroteText = false;

  for await (const event of events) {
    switch (event.type) {
      case 'text':
        text += event.text;
        if (format === 'text') {
          stdout.write(event.text);
          wroteText = true;
        } else if (format === 'stream-json') stdout.write(`${JSON.stringify(event)}\n`);
        break;
      case 'tool_use':
      case 'tool_result':
        if (format === 'stream-json') stdout.write(`${JSON.stringify(event)}\n`);
        break;
      case 'error':
        failure = event.message;
        if (format === 'stream-json') stdout.write(`${JSON.stringify(event)}\n`);
        break;
      case 'result':
        result = event;
        if (format === 'stream-json') stdout.write(`${JSON.stringify(event)}\n`);
        break;
      default:
        break;
    }
  }

  // The exit code is the run's own, and it agrees with the document the `json`
  // format writes: a run that produced **no** result event failed — the
  // document says so, and so does the exit code.
  const failed = result === undefined || result.is_error === true || failure !== undefined;

  if (format === 'text') {
    // The text of a failed run goes to stderr, so stdout stays the answer. The
    // provider's own message is preferred over the generic one: the two formats
    // must not disagree about the same failure.
    if (failed) {
      stderr.write(`${failure ?? result?.errors?.[0] ?? 'The run failed.'}\n`);
    } else if (wroteText) {
      stdout.write('\n');
    }
  } else if (format === 'json') {
    // **Exactly one** document, whether the run succeeded or not.
    stdout.write(`${JSON.stringify(resultDocument(result, text, failure))}\n`);
  }

  return failed ? EXIT_FAILURE : EXIT_SUCCESS;
}

/**
 * The document the `json` format writes.
 *
 * The **target's own document**, built in the target's own member order
 * (`chunk-pj5cyqhw.js:171561`): the common members, then the variant members,
 * then `type`, `duration_ms` and `uuid`.
 *
 * A run that produced **no** result event still produces a document: the document
 * says the run failed, and says why, rather than leaving the reader with an
 * empty stdout. **This is a divergence from the target, and it is named**: the
 * target writes `Error: No messages returned from query` to **stderr**, writes
 * **nothing** to stdout and exits `1` (`chunk-e7w77ts3.js:529318`). The
 * divergence is pinned by a contract test this milestone does not own
 * (`tests/contracts/cli-surface.test.ts`).
 */
function resultDocument(
  result: Extract<HeadlessEvent, { type: 'result' }> | undefined,
  text: string,
  failure: string | undefined,
): ResultDocument {
  if (result === undefined) {
    return buildResultDocument({
      isError: true,
      result: text,
      errors: failure !== undefined ? [failure] : undefined,
      stopReason: null,
      sessionId: '',
      durationMs: 0,
      numTurns: 0,
      usage: usageOf(undefined),
      permissionDenials: [],
      uuid: randomUUID(),
    });
  }

  const errors = result.errors ?? (failure !== undefined ? [failure] : undefined);
  return buildResultDocument({
    isError: result.is_error,
    result: text,
    errors,
    stopReason: result.stop_reason,
    sessionId: result.session_id,
    durationMs: result.duration_ms,
    numTurns: result.num_turns,
    usage: result.usage,
    permissionDenials: result.permission_denials,
    uuid: result.uuid,
  });
}
