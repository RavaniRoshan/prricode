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

import {
  buildAssistantDocument,
  buildUserDocument,
  streamJsonLine,
  TextResultPrinter,
  type StreamJsonDocument,
  type SystemInitDocument,
} from './print/documents.js';
import type { ResultDocument } from './headless.js';

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
 * The union is this implementation's own: the run turns the turn's transcript
 * records into these (`src/cli/headless.ts`), and the writers decide what the
 * output formats write from them. The five members cover everything a turn
 * produces — the assistant's text, the tool calls it made, the results those
 * calls produced, the errors, and the result of the run itself.
 *
 * The **result** member is not this implementation's own: it is the **target's**
 * result document, member for member in the target's own
 * order (`chunk-pj5cyqhw.js:171561`), so the `stream-json` format's **last**
 * document is the target's document. The document's type and the builder live in
 * `src/cli/headless.ts`.
 *
 * What the `stream-json` format **writes** from these events is the SDK
 * message kinds the target's own source names — `system`/`init` first, the
 * assistant's text and tool calls inside `assistant` documents, the tool
 * results inside `user` documents, and the `result` document last. The
 * mapping lives in the writer below; the builders live in
 * `src/cli/print/documents.ts`.
 */
export type HeadlessEvent =
  /** The assistant produced text, from the record the transcript named. */
  | { type: 'text'; id: string; text: string }
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
  /**
   * The `system`/`init` document the run is wired with.
   *
   * The `stream-json` output always begins with it, and the command that wires
   * the run always builds one from the session's context
   * (`src/cli/print/documents.ts`); a `stream-json` call without one is
   * refused.
   */
  init?: SystemInitDocument;
  /**
   * The session the run belonged to — the SDK message documents'
   * `session_id`. The result document carries its own.
   */
  sessionId?: string;
  /** The model the run ran on — the assistant documents' `model`. */
  model?: string;
}

/**
 * Write a headless run's events, and return the exit code the run ends with.
 *
 * **The target's own switch** (`chunk-e7w77ts3.js:529318`), read back from the
 * findings' record:
 *
 *   - the `json` format writes **exactly one** document — the result document,
 *     `JSON.stringify(result) + "\n"`;
 *   - the `stream-json` format writes **one document per line**, one per
 *     message, the `system`/`init` document first (`chunk-btsgvmny.js:29557`),
 *     the **result** document last;
 *   - the `text` format prints the result document through the target's own
 *     printer (`chunk-e7w77ts3.js:445913`) — the result's text at the end of
 *     the turn, the format's own line for a failure;
 *   - the exit code is the result document's `is_error`;
 *   - a run that produced **no** result document writes
 *     `Error: No messages returned from query` to **stderr**, writes
 *     **nothing** to stdout, and exits `1`.
 *
 * NULL RESULT BETWEEN EVENTS: a turn that threw — the runtime that never came
 * back with records — is the same no-result case, and the writer applies the
 * same rule for it.
 */
export async function writeHeadlessOutput(options: HeadlessOutputOptions): Promise<number> {
  const { events, format, stdout, stderr, init, sessionId, model } = options;

  // The stream-json wire always begins with the init document (`src/cli/print/documents.ts`),
  // and the command always wires one. A caller without one has built no
  // stream, and the writer refuses rather than writing one that starts
  // elsewhere.
  if (format === 'stream-json' && init === undefined) {
    throw new Error('the stream-json output writes the run\'s init document, and none was supplied');
  }

  const printer = new TextResultPrinter({ stdout, stderr });

  // The target's own hold, read the other way round: the init document is
  // flushed before the **first** message document reaches the wire, so the
  // init document is always first — and a run that yielded nothing, the
  // no-result case below, writes nothing at all.
  let pendingInit: SystemInitDocument | undefined = init;
  const writeStream = (document: StreamJsonDocument): void => {
    if (pendingInit !== undefined) {
      stdout.write(streamJsonLine(pendingInit));
      pendingInit = undefined;
    }
    stdout.write(streamJsonLine(document));
  };

  let result: ResultDocument | undefined;
  let failure: string | undefined;

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'text':
          if (format === 'stream-json') {
            // The assistant's text arrives inside the SDK's `assistant`
            // document (`chunk-pj5cyqhw.js:261767`).
            writeStream(
              buildAssistantDocument({
                id: event.id,
                model: model ?? '',
                content: [{ type: 'text', text: event.text }],
                sessionId: sessionId ?? '',
              }),
            );
          }
          break;
        case 'tool_use':
          if (format === 'stream-json') {
            writeStream(
              buildAssistantDocument({
                id: event.id,
                model: model ?? '',
                content: [{ type: 'tool_use', id: event.id, name: event.name, input: event.input }],
                sessionId: sessionId ?? '',
              }),
            );
          }
          break;
        case 'tool_result':
          if (format === 'stream-json') {
            // The result turns around inside the SDK's `user` document
            // (`chunk-pj5cyqhw.js:239906`), marked with `tool_use_result`.
            writeStream(
              buildUserDocument({
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: event.id,
                    content: event.content,
                    is_error: event.is_error,
                  },
                ],
                toolUseResult: event.content,
                sessionId: sessionId ?? '',
              }),
            );
          }
          break;
        case 'error':
          failure = event.message;
          break;
        case 'result':
          result = event;
          if (format === 'stream-json') writeStream(event);
          break;
      }
    }
  } catch {
    // The turn produced no records — the runtime never came back. This is the
    // no-result case the target's own switch names: the line on stderr,
    // nothing on stdout, exit `1`.
    return exitForNoResult(stderr);
  }

  return exitAfterRun(stdout, stderr, printer, format, result, failure);
}

/**
 * The exit code and the writing that surround a run the writer consumed.
 *
 * Split from {@link writeHeadlessOutput} so the no-result rule reads once.
 */
function exitAfterRun(
  stdout: OutputSink,
  stderr: OutputSink,
  printer: TextResultPrinter,
  format: OutputFormat,
  result: ResultDocument | undefined,
  failure: string | undefined,
): number {
  if (result === undefined) return exitForNoResult(stderr);

  if (format === 'text') {
    // The printer prints the result document once — the one-batch run's own
    // turn-end is the run's end (`src/cli/headless.ts` states the runtime's
    // contract).
    printer.print(result, failure);
  } else if (format === 'json') {
    // **Exactly one** document: the run's own result document, written as the
    // run built it.
    stdout.write(`${JSON.stringify(result)}\n`);
  }

  return (result.is_error) ? EXIT_FAILURE : EXIT_SUCCESS;
}

/**
 * The no-result case: `Error: No messages returned from query` on stderr,
 * nothing on stdout, exit `1` (`chunk-e7w77ts3.js:529318`).
 */
function exitForNoResult(stderr: OutputSink): number {
  stderr.write('Error: No messages returned from query\n');
  return EXIT_FAILURE;
}
