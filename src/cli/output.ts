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
 * **Implementation choice**: the **shape of the documents**. The audit pins the three
 * formats and the fact that the `json` format writes **one** document and the
 * `stream-json` format writes **one object per event**; it does not record what a
 * document contains. The documents below are therefore this implementation's own, and they
 * are labelled as such here so that nothing reads them as a compatibility claim.
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
 * The `json` document is written **after** the run, and the `stream-json`
 * objects are written **as the events arrive**: that is the difference between
 * the two formats, and it is the whole reason the target has both.
 */

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
  /** The run finished. */
  | {
      type: 'result';
      result: string;
      is_error: boolean;
      stop_reason: string;
      session_id: string;
      duration_ms: number;
      /** The failure's message, when the run failed. */
      error?: string;
    };

/**
 * The single document the `json` format writes.
 *
 * **Implementation choice.** The audit pins that the `json` format writes one document
 * and not what the document contains. The members below are this implementation's own:
 * `type` and `subtype` say what happened, `is_error` says whether it was a
 * failure, `result` is the assistant's text, and `session_id`, `duration_ms` and
 * `stop_reason` say which session ran, for how long, and why it stopped.
 */
export interface ResultDocument {
  /** The document's type. */
  type: 'result';
  /** Whether the run succeeded. */
  subtype: 'success' | 'error';
  /** Whether the run failed. */
  is_error: boolean;
  /** The session the run belonged to. */
  session_id: string;
  /** The assistant's text. */
  result: string;
  /** How long the run took, in milliseconds. */
  duration_ms: number;
  /** Why the run stopped. */
  stop_reason: string;
  /** The failure's message, when the run failed. */
  error?: string;
}

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

  const failed = result?.is_error === true || (result === undefined && failure !== undefined);

  if (format === 'text') {
    // The text of a failed run goes to stderr, so stdout stays the answer.
    if (failed) {
      stderr.write(`${failure ?? 'The run failed.'}\n`);
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
 * A run that produced no result event still produces a document: the document
 * says the run failed, and says why, rather than leaving the reader with an
 * empty stdout.
 */
function resultDocument(
  result: Extract<HeadlessEvent, { type: 'result' }> | undefined,
  text: string,
  failure: string | undefined,
): ResultDocument {
  if (result === undefined) {
    const document: ResultDocument = {
      type: 'result',
      subtype: 'error',
      is_error: true,
      session_id: '',
      result: text,
      duration_ms: 0,
      stop_reason: 'error',
    };
    if (failure !== undefined) document.error = failure;
    return document;
  }

  const document: ResultDocument = {
    type: 'result',
    subtype: result.is_error ? 'error' : 'success',
    is_error: result.is_error,
    session_id: result.session_id,
    result: text,
    duration_ms: result.duration_ms,
    stop_reason: result.stop_reason,
  };
  const message = failure ?? result.error;
  if (result.is_error && message !== undefined) document.error = message;
  return document;
}

/**
 * Read the JSON documents a stream of output carries.
 *
 * The documents are written **one per line**, so the reader splits on the line
 * breaks and parses each line. It is the reader a machine uses to check the
 * `json` format's contract — **exactly one** document — and to count the
 * `stream-json` format's objects.
 */
export function readJsonDocuments(text: string): unknown[] {
  const documents: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    documents.push(JSON.parse(trimmed));
  }
  return documents;
}
