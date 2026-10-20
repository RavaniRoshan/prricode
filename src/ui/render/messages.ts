/**
 * The message-list renderer.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions) and
 * the `CC-015` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 * The audit records **no** TUI drawing at all — §2.10 is the argument parser,
 * not a terminal — so everything this module draws is a **implementation choice**.
 *
 * ## What this module is
 *
 * The UI is a **renderer over the runtime**, not a second implementation: it
 * reads the same `SessionEvent` records the headless path reads and turns them
 * into the blocks the terminal shows. The renderer is **pure** — it reads no
 * clock, touches no terminal and touches no filesystem — and that is what makes
 * it testable at all.
 *
 * ## The blocks
 *
 * The plan fixes the shape of the list:
 *
 *   - **one block per assistant message**, and
 *   - **one block per tool call**, carrying the tool's **result**.
 *
 * A block is a **string**: the renderer produces the text the terminal shows,
 * and the UI decides how to colour it. The blocks are separated in the returned
 * array, so a consumer can lay them out one per line-group without parsing
 * the text.
 *
 * The other record kinds are **not** blocks:
 *
 *   - a `user_message` is the user's own prompt, and the input line shows it;
 *   - a `provider_event` is the raw stream;
 *   - a `compaction` and a `content_replacement` are boundary markers.
 *
 * A `tool_result` and a `permission_request` are **not** blocks either: they
 * belong to the tool call they answer, and they are folded into that call's
 * block.
 *
 * A `tool_result` with **no** tool call is the one exception: it is reported
 * as a block of its own. The audit records that the target *normalizes* the
 * `tool_use` / `tool_result` sequence and **reports** a mismatch
 * (`tengu_tool_use_tool_result_mismatch_error`), so the pairing invariant is
 * checked and not merely assumed — and a renderer that dropped the mismatch
 * silently would be assuming it.
 *
 * ## A denied tool call is marked
 *
 * A denial is the one thing in the list a reader must not be able to miss, and
 * the plan requires the block to carry the decision's **source** and its
 * **reason type**: *who* refused the call (a rule, a hook, the classifier, the
 * user) and *what kind* of refusal it was (`rule`, `safetyCheck`, `other`).
 * The marker names both:
 *
 * ```
 * ⏺ Bash(rm -rf /)
 *   ⎿ denied (source: user_reject, reason type: rule)
 *   ⎿ Permission rule 'rm -rf *' from localSettings denies this Bash call.
 * ```
 *
 * The source and the reason type come from the decision that **decided** the
 * call: the tool result's own envelope carries it as the summary the model
 * observes, and a `permission_request` record is the log of the checks that
 * led to it. When the runtime checks a call **twice** — which it does when a
 * hook rewrites the input — the **strictest** of the two decisions is the one
 * that decided the call, and the marker carries that one.
 *
 * ## A sandboxed run shows its status
 *
 * The `Bash` tool reports whether the command ran **inside** the sandbox, the
 * reason it did not, the reason the sandbox **never came up**, the exemptions
 * that applied, how far they reach, and what the backend's **availability
 * probe** reported. The block shows all of them, because "the command ran"
 * and "the command ran *confined*" are different facts and a reader must not
 * have to guess which one happened. The availability report is not redundant
 * either: on the unconfined path it is the **only** carrier of *why the
 * backend was not used*.
 *
 * ## The strictness rule is shared, and it fails closed
 *
 * A call can be checked twice — the runtime checks the input, and checks it
 * again when a hook rewrote it — and the **strictest** of the two decisions
 * is the one that decided the call. The rule that says which one is stricter
 * belongs to the **permission layer** (`permissionStrictness`, in
 * `src/permissions/decision.ts`), and the renderer **shares** it rather than
 * copying it: the renderer already depends on the permission vocabulary, and
 * a second copy could only drift. The shared rule **fails closed** — a
 * behavior outside the closed vocabulary, which the types forbid but a caller
 * can still build at runtime, is the **strictest** one, and the renderer
 * treats a call it cannot read as a denial rather than as an approval.
 *
 * ## Caller-supplied data is data
 *
 * A **tool name** and a **tool input** are caller-supplied: they come from a
 * model, and a model can call a tool `constructor` or `__proto__`. Every
 * lookup of a caller-supplied key in a plain object is therefore guarded with
 * `Object.hasOwn`, and the tables the renderer looks names up in are **Maps**,
 * so a name can never resolve to an inherited member of `Object.prototype`.
 *
 * A tool's **result** is caller-supplied too — the model chooses what the tool
 * printed — so every string that reaches the terminal is **stripped** of its
 * control sequences by the shared stripper (`./markdown.ts`), the same one the
 * markdown renderer uses.
 *
 * The strip is **per path**, and each path strips for itself: the result
 * reader, the block renderer and the summary reader each strip their own
 * input. The paths mask each other — the block renderer strips the result
 * lines the reader produced — so the contract test pins each path's stripped
 * text **exactly**, on its own, rather than looking at the finished block
 * and hoping the right layer did the work.
 *
 * ## What is observed and what is a implementation choice
 *
 * The audit pins the permission **vocabulary** — the behaviors, the sources and
 * the reason types — and the tool-result **metadata**. It says nothing about
 * how the terminal draws a message, so the following are **implementation choices**, and
 * they are marked as such below:
 *
 *   - the **block format**: the block markers (`⏺` and `⎿`), the indentation
 *     and the truncation limits;
 *   - the **denial marker's wording**: `denied (source: …, reason type: …)`;
 *   - the **sandbox status lines**: `sandboxed`, `not sandboxed: …`,
 *     `sandbox not established: …`, `sandbox backend available`,
 *     `sandbox backend unavailable: …`, `sandbox availability warning: …`,
 *     `sandbox exemptions: …` and `sandbox exemption scope: …`;
 *   - the **tool-summary fields** the summary names;
 *   - the **unmatched-result report**: `unmatched tool result`.
 */

import { permissionStrictness, type PermissionDecision } from '../../permissions/decision.js';
import { isRecord, ownBoolean, ownNumber, ownString } from '../../session/event.js';
import type { SessionEvent } from '../../session/event.js';
import type { ToolResultEnvelope } from '../../tools/runner.js';

import { renderMarkdown, stripControlSequences } from './markdown.js';

/* -------------------------------------------------------------------------- */
/* The constants                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The marker in front of a message.
 *
 * **Implementation choice.** The audit records no marker; the shape is this implementation's own.
 */
export const MESSAGE_MARKER = '⏺';

/**
 * The marker in front of a tool result line.
 *
 * **Implementation choice**, like the message marker.
 */
export const RESULT_MARKER = '⎿';

/**
 * The marker in front of a user's own prompt.
 *
 * **Implementation choice**, like the message marker.
 */
export const USER_MARKER = '>';

/**
 * The indentation of a result line.
 *
 * **Implementation choice**, like the markers.
 */
export const RESULT_INDENT = '  ';

/**
 * The largest number of result lines a tool block shows.
 *
 * **Implementation choice.** A command that prints without bound must not push the rest
 * of the conversation off the screen.
 */
export const MAX_RESULT_LINES = 50;

/**
 * The largest number of characters a tool block shows.
 *
 * **Implementation choice**, for the same reason.
 */
export const MAX_BLOCK_CHARS = 4000;

/**
 * The largest number of characters a tool summary shows.
 *
 * **Implementation choice.**
 */
export const MAX_SUMMARY_CHARS = 80;

/**
 * The label of a tool result that has no tool call.
 *
 * **Implementation choice.** The audit records that the target *reports* a
 * `tool_use` / `tool_result` mismatch (§2.5); the wording of the report is
 * this implementation's own.
 */
export const UNMATCHED_RESULT_LABEL = 'unmatched tool result';

/**
 * The field of a tool's input that names the call.
 *
 * The table is a **Map** and not a plain object, because a tool name is
 * caller-supplied data: `KNOWN_INPUT_FIELDS.get('constructor')` reaches
 * `undefined`, while a plain object would reach `Object.prototype.constructor`.
 *
 * The table is **exported** so that the contract test can pin the property
 * itself: the behaviour of a `Map` and of a plain object happens to agree on
 * every input the renderer accepts, so only the table's own type can tell the
 * two apart.
 */
export const KNOWN_INPUT_FIELDS: ReadonlyMap<string, string> = new Map<string, string>([
  ['Bash', 'command'],
  ['Edit', 'file_path'],
  ['Glob', 'pattern'],
  ['Grep', 'pattern'],
  ['NotebookEdit', 'notebook_path'],
  ['Read', 'file_path'],
  ['Task', 'description'],
  ['TodoWrite', 'todos'],
  ['WebFetch', 'url'],
  ['Write', 'file_path'],
]);

/* -------------------------------------------------------------------------- */
/* The small readers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Read an own array of strings.
 *
 * **Own-property** on purpose, like every other reader in this repository: a
 * member name in a tool's output is caller-supplied data, and `Object.prototype`
 * carries members called `constructor` and `toString`.
 */
function ownStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const member of value) {
    if (typeof member === 'string') out.push(member);
  }
  return out;
}

/**
 * Read an own object member.
 *
 * **Own-property** on purpose, like every other reader in this repository: a
 * member name in a tool's output is caller-supplied data, and
 * `Object.prototype` carries members called `constructor` and `toString`. A
 * member that is not an object is not a member the reader can read: the
 * reader reads the object's **own** members.
 */
function ownRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

/**
 * Split text into lines, dropping the trailing empty line.
 *
 * The result never carries a trailing empty line, so a block does not end with
 * a stray marker.
 *
 * The text is **stripped** first: it comes from a tool's output, which the
 * model chose, and an escape sequence in it would reach the terminal.
 */
function splitLines(text: string): string[] {
  const lines = stripControlSequences(text).split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * A compact JSON rendering of a value.
 *
 * The renderer builds the JSON **itself** rather than calling
 * `JSON.stringify`: `JSON.stringify` calls a `toJSON` method when the value
 * has one, and a tool's output is caller-supplied data. Members that are
 * functions, symbols or `undefined` are skipped.
 *
 * Every string is **stripped** of its control sequences for the same reason:
 * the value came from the model.
 */
function compactJson(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(stripControlSequences(value));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (depth >= 3) return '…';
    const members = value.map((member) => compactJson(member, depth + 1));
    return `[${members.join(', ')}]`;
  }
  if (isRecord(value)) {
    if (depth >= 3) return '…';
    const members: string[] = [];
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(value, key)) continue;
      const member = value[key];
      const kind = typeof member;
      if (kind === 'function' || kind === 'symbol' || kind === 'undefined') continue;
      members.push(`${JSON.stringify(key)}: ${compactJson(member, depth + 1)}`);
    }
    return `{${members.join(', ')}}`;
  }
  return '…';
}

/**
 * Collapse text into one line and cap it.
 *
 * The text is **stripped** first: a tool's input is caller-supplied, and the
 * summary of a call is shown on the terminal.
 */
function oneLine(text: string): string {
  const collapsed = stripControlSequences(text).replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_SUMMARY_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/* -------------------------------------------------------------------------- */
/* The tool summary                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The summary of a tool call: the part that names it.
 *
 * A tool this implementation knows is summarised by the field that names the call — the
 * command of a `Bash` call, the path of a `Read` call — and any other tool is
 * summarised by its input as compact JSON. The lookup is guarded and the table
 * is a `Map`, so a caller-supplied tool name cannot reach an inherited member.
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  const field = KNOWN_INPUT_FIELDS.get(toolName);
  if (field !== undefined && isRecord(input)) {
    const value = ownString(input, field);
    if (value !== undefined) return oneLine(value);
  }
  if (typeof input === 'string') return oneLine(input);
  if (input === undefined) return '';
  if (isRecord(input) || Array.isArray(input)) return oneLine(compactJson(input));
  return oneLine(String(input));
}

/* -------------------------------------------------------------------------- */
/* The tool result                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The lines of a tool result.
 *
 * The `Bash` tool's output carries the sandbox's own report, so it is read
 * first: a run that did **not** happen inside the sandbox must not look like
 * one that did.
 *
 * Every string here came from the **model** — a tool's output is the model's
 * to choose — so every line is stripped of its control sequences before it
 * can reach the terminal.
 */
function contentLines(envelope: ToolResultEnvelope): string[] {
  const content = envelope.content;

  if (isRecord(content)) {
    if (ownBoolean(content, 'sandboxed') !== undefined) return bashLines(content);

    const type = ownString(content, 'type');
    if (type === 'error') {
      const message = ownString(content, 'message');
      const code = ownNumber(content, 'errorCode');
      if (message !== undefined) {
        const text = stripControlSequences(message);
        return code === undefined ? [text] : [`${text} (error code ${code})`];
      }
    }
    if (type === 'text') {
      const text = ownString(content, 'text');
      if (text !== undefined) return splitLines(text);
    }
  }

  if (typeof content === 'string') {
    const lines = splitLines(content);
    return envelope.isError ? lines.map((line) => `error: ${line}`) : lines;
  }

  return splitLines(compactJson(content));
}

/**
 * The lines of a `Bash` tool's output.
 *
 * The shape is the tool's own (`src/tools/builtins/bash.ts`): `{ type, text,
 * stdout, stderr, exitCode, truncated, sandboxed, sandboxReason,
 * sandboxEstablishmentReason, sandboxExemptions, sandboxExemptionScope,
 * sandboxAvailability, timedOut }`.
 *
 * Every member but the first is **optional**, and the tool is not the only
 * writer of this shape: a reader that required a member would break on a
 * result that does not carry it. So each member is read on its own, and a
 * member that is absent is simply not shown.
 *
 * Two members are **not** shown, and the reasons are the shape's own:
 *
 *   - `type` is the shape's **tag** — it is what says the content is a `Bash`
 *     output at all, and not a fact about the run. The **caller**
 *     (`contentLines`) reads it to tell an error from a text result;
 *   - `text` is the **same content** as `stdout`, and is read only as the
 *     fallback for a result that carries `stdout` alone.
 *
 * The **availability report** (`sandboxAvailability`) **is** shown: on the
 * unconfined path it is the **only** carrier of *why the backend was not
 * used*, so a reader must not have to guess.
 *
 * **Implementation choice.** The wording of the status lines is this implementation's own.
 */
function bashLines(content: Record<string, unknown>): string[] {
  const lines: string[] = [];

  const sandboxed = ownBoolean(content, 'sandboxed') === true;
  const reason = ownString(content, 'sandboxReason');
  if (sandboxed) {
    lines.push('sandboxed');
  } else if (reason !== undefined && reason !== '') {
    lines.push(`not sandboxed: ${reason}`);
  } else {
    lines.push('not sandboxed');
  }

  // The sandbox **never came up**: the backend could not be established, so
  // the run was unconfined for a reason the policy never gave.
  const establishment = ownString(content, 'sandboxEstablishmentReason');
  if (establishment !== undefined && establishment !== '') {
    lines.push(`sandbox not established: ${establishment}`);
  }

  // The **backend's own report**: whether it can run on this host at all. It
  // is the only carrier of *why the backend was not used*, so it is shown.
  const availability = ownRecord(content, 'sandboxAvailability');
  if (availability !== undefined) {
    const available = ownBoolean(availability, 'available') === true;
    const why = ownString(availability, 'reason');
    if (available) {
      lines.push('sandbox backend available');
    } else if (why !== undefined && why !== '') {
      lines.push(`sandbox backend unavailable: ${why}`);
    } else {
      lines.push('sandbox backend unavailable');
    }
    const warning = ownString(availability, 'warning');
    if (warning !== undefined && warning !== '') {
      lines.push(`sandbox availability warning: ${warning}`);
    }
  }

  const exemptions = ownStringArray(content, 'sandboxExemptions');
  if (exemptions !== undefined && exemptions.length > 0) {
    lines.push(`sandbox exemptions: ${exemptions.join(', ')}`);
  }

  // The **reach** of the exemption list: `all` means the list exempts every
  // command, which is a hazard the reader must see.
  const scope = ownString(content, 'sandboxExemptionScope');
  if (scope !== undefined && scope !== '') {
    lines.push(`sandbox exemption scope: ${scope}`);
  }

  const exitCode = ownNumber(content, 'exitCode');
  if (exitCode !== undefined) lines.push(`exit code ${exitCode}`);
  if (ownBoolean(content, 'timedOut') === true) lines.push('timed out');
  if (ownBoolean(content, 'truncated') === true) lines.push('output truncated');

  const stdout = ownString(content, 'stdout') ?? ownString(content, 'text');
  if (stdout !== undefined) lines.push(...splitLines(stdout));

  const stderr = ownString(content, 'stderr');
  if (stderr !== undefined && stderr.trim() !== '') {
    for (const line of splitLines(stderr)) lines.push(`stderr: ${line}`);
  }

  return lines;
}

/**
 * The lines of a tool call's result, including the denial marker.
 *
 * A **denial** is marked with the decision's **source** and its **reason
 * type**, so a reader can tell who refused the call and what kind of refusal
 * it was.
 *
 * The decision that **decided** the call comes first: the tool result's own
 * envelope carries it as the summary the model observes, and a
 * `permission_request` record is the log of the checks that led to it. The
 * record is the fallback, and it is the record that carries the **reason
 * text** — the envelope's summary has none.
 */
export function toolResultLines(
  envelope: ToolResultEnvelope | undefined,
  decision: PermissionDecision | undefined,
): string[] {
  const lines: string[] = [];

  const envelopeDecision = envelope?.permissionDecision;
  const denied = decision?.behavior === 'deny' || envelopeDecision?.decision === 'deny';
  if (denied) {
    // The decision that refused the call: the envelope's summary when it
    // refused it, and the strictest record otherwise.
    const deciding = envelopeDecision?.decision === 'deny' ? envelopeDecision : decision;
    const source = deciding?.source ?? envelopeDecision?.source ?? decision?.source ?? 'unknown';
    const reasonType =
      deciding?.reasonType ?? envelopeDecision?.reasonType ?? decision?.reasonType ?? 'other';
    lines.push(`denied (source: ${source}, reason type: ${reasonType})`);
    const reason = decision?.reason;
    if (reason !== undefined && reason !== '') lines.push(stripControlSequences(reason));
  }

  if (envelope !== undefined) lines.push(...contentLines(envelope));
  return lines;
}

/* -------------------------------------------------------------------------- */
/* The blocks                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A block of text: the marker in front of the first line, and the rest of the
 * text under it.
 */
function blockWithMarker(marker: string, text: string): string {
  const rendered = renderMarkdown(text);
  if (rendered === '') return marker;
  const lines = rendered.split('\n');
  const first = lines[0];
  const head = first === undefined ? marker : `${marker} ${first}`;
  const rest = lines.slice(1);
  return rest.length === 0 ? head : `${head}\n${rest.join('\n')}`;
}

/**
 * The block of an assistant message.
 *
 * The text is rendered as markdown, because that is what a model emits.
 */
export function renderAssistantBlock(text: string): string {
  return blockWithMarker(MESSAGE_MARKER, text);
}

/**
 * The block of a user's own prompt.
 *
 * **Implementation choice.** The prompt is shown with a `>` marker, which is how a
 * terminal shows what was typed at it.
 */
export function renderUserBlock(text: string): string {
  return blockWithMarker(USER_MARKER, text);
}

/**
 * The block of a tool call.
 *
 * The header names the tool and the call; the result lines are indented under
 * it. The lines are capped, and the cap is **announced** rather than silent.
 *
 * Both the summary and the lines are **stripped**: they are caller-supplied,
 * and the block is what the terminal shows. The summary is tested **after** it
 * is stripped, so a summary that is *only* an escape sequence is an empty
 * summary — and an empty summary has no parentheses at all.
 *
 * **Implementation choice.** The block's shape — the marker, the indent and the result
 * marker — is this implementation's own.
 */
export function renderToolBlock(
  toolName: string,
  summary: string,
  lines: string[],
): string {
  const name = stripControlSequences(toolName);
  const summaryText = stripControlSequences(summary);
  const call = summaryText === '' ? name : `${name}(${summaryText})`;
  const header = `${MESSAGE_MARKER} ${call}`;
  if (lines.length === 0) return header;

  let shown = lines.map((line) => stripControlSequences(line));
  let truncated = false;
  if (shown.length > MAX_RESULT_LINES) {
    shown = shown.slice(0, MAX_RESULT_LINES);
    truncated = true;
  }
  let body = shown.join('\n');
  if (body.length > MAX_BLOCK_CHARS) {
    body = `${body.slice(0, MAX_BLOCK_CHARS - 1)}…`;
    truncated = true;
  }
  if (truncated) body = `${body}\n… (truncated)`;

  const indented = body
    .split('\n')
    .map((line) => `${RESULT_INDENT}${RESULT_MARKER} ${line}`);
  return [header, ...indented].join('\n');
}

/* -------------------------------------------------------------------------- */
/* The entries                                                                 */
/* -------------------------------------------------------------------------- */

/** One entry of the list: an assistant message, a tool call, a user prompt. */
type Entry =
  | { kind: 'assistant'; text: string }
  | { kind: 'user'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      envelope: ToolResultEnvelope | undefined;
      decision: PermissionDecision | undefined;
    }
  | { kind: 'unmatched'; toolUseId: string };

/**
 * The stricter of two decisions.
 *
 * A `deny` wins over everything, an `ask` wins over an `allow`, and two
 * `allow`s are the first one.
 *
 * The rule is the permission layer's **own** (`permissionStrictness`, in
 * `src/permissions/decision.ts`), and it is **shared** rather than copied: the
 * renderer already depends on the permission vocabulary — the decision type
 * and the reason the prompt shows — so a second copy of the rule could only
 * drift. The shared rule **fails closed**: a behavior outside the closed
 * vocabulary, which the types forbid but a caller can still build at runtime,
 * is the **strictest** one, and the renderer treats it as such.
 */
function stricterDecision(
  first: PermissionDecision | undefined,
  second: PermissionDecision | undefined,
): PermissionDecision | undefined {
  if (first === undefined) return second === undefined ? undefined : closedDecision(second);
  if (second === undefined) return closedDecision(first);
  if (permissionStrictness(second.behavior) > permissionStrictness(first.behavior)) {
    return closedDecision(second);
  }
  return closedDecision(first);
}

/**
 * The decision, with its behavior inside the closed vocabulary.
 *
 * A behavior outside the vocabulary is the **strictest** one — the shared
 * rule fails closed — and the strictest behavior is `deny`. Normalising it
 * is what makes the failure **visible**: the call is marked as a denial
 * instead of being shown as a call that was allowed.
 */
function closedDecision(decision: PermissionDecision): PermissionDecision {
  if (decision.behavior === 'allow' || decision.behavior === 'ask' || decision.behavior === 'deny') {
    return decision;
  }
  return { ...decision, behavior: 'deny' };
}

/**
 * Fold the records into the entries of the list.
 *
 * A `tool_result` answers the tool call whose id is the envelope's
 * `toolUseId`, and a `permission_request` belongs to the **most recent** tool
 * call of the same tool — whether or not that call already carries a
 * decision, because a call that is checked twice folds both requests into it
 * and keeps the stricter one.
 *
 * A call may be checked **twice**: the runtime checks the input, and checks it
 * again when a hook rewrote it. The two requests are folded into the same
 * call, and the **strictest** of the two decisions is the one that decided it.
 *
 * The **user's own prompts** are folded in only when the caller asks for them:
 * the plan's `renderMessages` is the list of what the **model** produced, and
 * the app's own view of the conversation also shows what the user said.
 */
function fold(events: SessionEvent[], includeUserMessages: boolean): Entry[] {
  const entries: Entry[] = [];
  const byId = new Map<string, Extract<Entry, { kind: 'tool' }>>();
  const openCalls: Extract<Entry, { kind: 'tool' }>[] = [];

  for (const event of events) {
    switch (event.t) {
      case 'assistant_message': {
        entries.push({ kind: 'assistant', text: event.text });
        break;
      }
      case 'user_message': {
        if (!includeUserMessages) break;
        entries.push({ kind: 'user', text: event.text });
        break;
      }
      case 'tool_call': {
        const entry: Extract<Entry, { kind: 'tool' }> = {
          kind: 'tool',
          id: event.id,
          name: event.name,
          input: event.input,
          envelope: undefined,
          decision: undefined,
        };
        entries.push(entry);
        byId.set(event.id, entry);
        openCalls.push(entry);
        break;
      }
      case 'tool_result': {
        const entry = byId.get(event.envelope.toolUseId);
        if (entry === undefined) {
          // The pairing invariant is **checked**, not assumed: the audit
          // records that the target reports the mismatch, so this implementation reports
          // it too rather than dropping the result in silence.
          entries.push({ kind: 'unmatched', toolUseId: event.envelope.toolUseId });
          break;
        }
        entry.envelope = event.envelope;
        break;
      }
      case 'permission_request': {
        // The most recent call of the same tool: the prompt belongs to the
        // call it was asked about. A call that was checked twice collects both
        // requests, and keeps the stricter decision — so a call that already
        // carries a decision collects this one too.
        for (let index = openCalls.length - 1; index >= 0; index -= 1) {
          const candidate = openCalls[index];
          if (candidate === undefined) continue;
          if (candidate.name !== event.toolName) continue;
          candidate.decision = stricterDecision(candidate.decision, event.decision);
          break;
        }
        break;
      }
      default:
        // A provider event, a compaction and a content replacement are not
        // blocks of the message list.
        break;
    }
  }

  return entries;
}

/* -------------------------------------------------------------------------- */
/* The entry points                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Render the message list.
 *
 * The function is **pure**: it reads no clock, touches no terminal and touches
 * no filesystem.
 *
 * The list is:
 *
 *   - **one block per assistant message**, and
 *   - **one block per tool call**, carrying the tool's result and, when the
 *     call was denied, the decision's source and reason type.
 *
 * A tool result with **no** tool call is reported as a block of its own, so a
 * pairing failure is visible rather than assumed away.
 *
 * The user's own prompts are **not** blocks of this list: they are what the
 * input line shows. `renderConversation` is the app's fuller view, which shows
 * them too — and it is built on **this** function's blocks, so the shipped
 * view and the plan's contract cannot drift apart.
 */
export function renderMessages(events: SessionEvent[]): string[] {
  if (!Array.isArray(events)) return [];
  const entries = fold(events, false);
  return entries.map((entry) => renderEntry(entry));
}

/**
 * A user's own prompt, and where it belongs.
 *
 * The `modelIndex` is the number of the **model's** blocks that came before
 * the prompt, so the prompt can be shown in the place it was said.
 */
type UserPrompt = Extract<Entry, { kind: 'user' }> & {
  /** The number of the model's blocks that came before the prompt. */
  readonly modelIndex: number;
};

/**
 * The user's own prompts, and where each of them belongs.
 *
 * The count is the number of the **model's** entries that came before the
 * prompt, and every model entry is exactly one model block — so the count is
 * the index the prompt's block has to be shown at.
 */
function userPrompts(folded: Entry[]): UserPrompt[] {
  const prompts: UserPrompt[] = [];
  let modelIndex = 0;
  for (const entry of folded) {
    if (entry.kind === 'user') {
      prompts.push({ ...entry, modelIndex });
      continue;
    }
    modelIndex += 1;
  }
  return prompts;
}

/**
 * Render the whole conversation: the user's prompts and the model's blocks.
 *
 * **Implementation choice.** The plan fixes `renderMessages` as the list of what the
 * model produced; the app also shows what the user said, in the order it was
 * said, so this is the view the app mounts.
 *
 * The conversation is built **on** the plan's contract, and it is built on it
 * **structurally**: the model's blocks are `renderMessages`' own blocks, taken
 * from `renderMessages` and from nothing else. The prompts are placed by the
 * count of the model's entries that came before them, so a prompt sits where
 * it was said. The shipped view and the plan's contract therefore cannot
 * drift apart — there is no second copy of the model's blocks to drift.
 */
export function renderConversation(events: SessionEvent[]): string[] {
  if (!Array.isArray(events)) return [];
  const folded = fold(events, true);
  const entries = userPrompts(folded);
  const model = renderMessages(events);

  const blocks: string[] = [];
  let index = 0;
  for (const entry of entries) {
    while (index < entry.modelIndex) {
      const block = model[index];
      index += 1;
      if (block !== undefined) blocks.push(block);
    }
    blocks.push(renderUserBlock(entry.text));
  }
  while (index < model.length) {
    const block = model[index];
    index += 1;
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

/**
 * Render one entry into a block.
 */
function renderEntry(entry: Entry): string {
  if (entry.kind === 'assistant') return renderAssistantBlock(entry.text);
  if (entry.kind === 'user') return renderUserBlock(entry.text);
  if (entry.kind === 'unmatched') return renderUnmatchedResult(entry.toolUseId);
  const summary = summarizeToolInput(entry.name, entry.input);
  const lines = toolResultLines(entry.envelope, entry.decision);
  return renderToolBlock(entry.name, summary, lines);
}

/**
 * The block of a tool result that has no tool call.
 *
 * **Implementation choice.** The report's wording is this implementation's own; the audit
 * records only that the target reports the mismatch.
 */
function renderUnmatchedResult(toolUseId: string): string {
  const id = stripControlSequences(toolUseId);
  return [
    `${MESSAGE_MARKER} ${UNMATCHED_RESULT_LABEL}`,
    `${RESULT_INDENT}${RESULT_MARKER} toolUseId: ${id}`,
  ].join('\n');
}
