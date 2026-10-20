/**
 * The message-list renderer.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.10 (The
 * command-line surface) and §2.5 (Permissions), and the `CC-015` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
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
 * The source and the reason type come from the `permission_request` record
 * when the transcript carries one — it is the full decision — and from the
 * tool result's own envelope otherwise.
 *
 * ## A sandboxed run shows its status
 *
 * The `Bash` tool reports whether the command ran **inside** the sandbox, the
 * reason it did not, and the exemptions that applied. The block shows all
 * three, because "the command ran" and "the command ran *confined*" are
 * different facts and a reader must not have to guess which one happened.
 *
 * ## Caller-supplied data is data
 *
 * A **tool name** and a **tool input** are caller-supplied: they come from a
 * model, and a model can call a tool `constructor` or `__proto__`. Every
 * lookup of a caller-supplied key in a plain object is therefore guarded with
 * `Object.hasOwn`, and the tables the renderer looks names up in are **Maps**,
 * so a name can never resolve to an inherited member of `Object.prototype`.
 *
 * ## What is observed and what is a implementation choice
 *
 * The audit pins the permission **vocabulary** — the behaviors, the sources and
 * the reason types — and the tool-result **metadata**. It says nothing about
 * how the terminal draws a message, so the block markers (`⏺` and `⎿`), the
 * indentation, the truncation limits and the tool-summary fields are **implementation
 * choices**, and they are marked as such below.
 */

import type { PermissionDecision } from '../../permissions/decision.js';
import { isRecord, ownBoolean, ownNumber, ownString } from '../../session/event.js';
import type { SessionEvent } from '../../session/event.js';
import type { ToolResultEnvelope } from '../../tools/runner.js';

import { renderMarkdown } from './markdown.js';

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
 * The field of a tool's input that names the call.
 *
 * The table is a **Map** and not a plain object, because a tool name is
 * caller-supplied data: `KNOWN_INPUT_FIELDS.get('constructor')` reaches
 * `undefined`, while a plain object would reach `Object.prototype.constructor`.
 */
const KNOWN_INPUT_FIELDS: ReadonlyMap<string, string> = new Map<string, string>([
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
 * Split text into lines, dropping the trailing empty line.
 *
 * The result never carries a trailing empty line, so a block does not end with
 * a stray marker.
 */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
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
 */
function compactJson(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
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
 */
function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
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
        return code === undefined ? [message] : [`${message} (error code ${code})`];
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
 * The shape is the tool's own: `{ type, text, stdout, stderr, exitCode,
 * truncated, sandboxed, sandboxReason, sandboxExemptions }`.
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

  const exemptions = ownStringArray(content, 'sandboxExemptions');
  if (exemptions !== undefined && exemptions.length > 0) {
    lines.push(`sandbox exemptions: ${exemptions.join(', ')}`);
  }

  const exitCode = ownNumber(content, 'exitCode');
  if (exitCode !== undefined) lines.push(`exit code ${exitCode}`);
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
 */
export function toolResultLines(
  envelope: ToolResultEnvelope | undefined,
  decision: PermissionDecision | undefined,
): string[] {
  const lines: string[] = [];

  const envelopeDecision = envelope?.permissionDecision;
  const denied = decision?.behavior === 'deny' || envelopeDecision?.decision === 'deny';
  if (denied) {
    const source = decision?.source ?? envelopeDecision?.source ?? 'unknown';
    const reasonType = decision?.reasonType ?? envelopeDecision?.reasonType ?? 'other';
    lines.push(`denied (source: ${source}, reason type: ${reasonType})`);
    const reason = decision?.reason;
    if (reason !== undefined && reason !== '') lines.push(reason);
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
 */
export function renderToolBlock(
  toolName: string,
  summary: string,
  lines: string[],
): string {
  const call = summary === '' ? toolName : `${toolName}(${summary})`;
  const header = `${MESSAGE_MARKER} ${call}`;
  if (lines.length === 0) return header;

  let shown = lines;
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

/** One entry of the list: an assistant message, a tool call, or a user prompt. */
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
      /** Whether a permission request has already been folded into this call. */
      requested: boolean;
    };

/**
 * Fold the records into the entries of the list.
 *
 * A `tool_result` answers the tool call whose id is the envelope's
 * `toolUseId`, and a `permission_request` belongs to the most recent tool call
 * of the same tool that has no decision yet.
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
          requested: false,
        };
        entries.push(entry);
        byId.set(event.id, entry);
        openCalls.push(entry);
        break;
      }
      case 'tool_result': {
        const entry = byId.get(event.envelope.toolUseId);
        if (entry === undefined) break;
        entry.envelope = event.envelope;
        break;
      }
      case 'permission_request': {
        // The most recent open call of the same tool: the prompt belongs to the
        // call it was asked about.
        for (let index = openCalls.length - 1; index >= 0; index -= 1) {
          const candidate = openCalls[index];
          if (candidate === undefined) continue;
          if (candidate.name !== event.toolName) continue;
          if (candidate.requested) continue;
          candidate.requested = true;
          candidate.decision = event.decision;
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
 * The user's own prompts are **not** blocks of this list: they are what the
 * input line shows. `renderConversation` is the app's fuller view, which shows
 * them too.
 */
export function renderMessages(events: SessionEvent[]): string[] {
  return renderEntries(events, false);
}

/**
 * Render the whole conversation: the user's prompts and the model's blocks.
 *
 * **Implementation choice.** The plan fixes `renderMessages` as the list of what the
 * model produced; the app also shows what the user said, in the order it was
 * said, so this is the view the app mounts.
 */
export function renderConversation(events: SessionEvent[]): string[] {
  return renderEntries(events, true);
}

/**
 * Render the entries into blocks.
 */
function renderEntries(events: SessionEvent[], includeUserMessages: boolean): string[] {
  if (!Array.isArray(events)) return [];
  const blocks: string[] = [];
  for (const entry of fold(events, includeUserMessages)) {
    if (entry.kind === 'assistant') {
      blocks.push(renderAssistantBlock(entry.text));
      continue;
    }
    if (entry.kind === 'user') {
      blocks.push(renderUserBlock(entry.text));
      continue;
    }
    const summary = summarizeToolInput(entry.name, entry.input);
    const lines = toolResultLines(entry.envelope, entry.decision);
    blocks.push(renderToolBlock(entry.name, summary, lines));
  }
  return blocks;
}
