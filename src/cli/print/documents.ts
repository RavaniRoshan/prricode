/**
 * The documents of the print mode: the stream-json wire's SDK message kinds,
 * and the printer the `text` format prints through.
 *
 * Evidence: the reading of the target's own source recorded in
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-permissions-and-headless.md`
 * §2. Every claim that this file encodes carries a file and a byte offset
 * there.
 *
 * ## The stream-json documents
 *
 * **The document kinds are the target's own** (`chunk-pj5cyqhw.js:333857`,
 * `:261767`, `:239906`, `:352585`): one document per message, one per line —
 *
 *   - the `system`/`init` document first — always the first document on the
 *     wire, with the schema the target's source names: `apiKeySource`, `claude_code_version`,
 *     `cwd`, `tools`, `mcp_servers`, `model`, `permissionMode`,
 *     `slash_commands`, `output_style`, `skills`, `plugins`, `plugin_errors`;
 *   - the `assistant` document for the assistant's messages;
 *   - the `user` document for what the run turns back to the model;
 *   - the `result` document last — the target's own result document, built by
 *     `src/cli/headless.ts`, which is also where its type lives.
 *
 * **This implementation's records are its own** (`src/session/event.ts`), and
 * a record that produces no message document — the user's own prompt, a
 * permission decision, a compaction boundary — produces none, the way
 * `src/cli/headless.ts`'s projection already says. The wire therefore carries
 * the kinds the run emitted.
 *
 * ## The write mechanics
 *
 * The target's stream writer (`chunk-btsgvmny.js:29557`) holds a message
 * written before the init document and flushes it after, so the init document
 * is always the first document on the wire, and the writer is `S_e`
 * (`chunk-rrhrzgxv.js:11`): `JSON.stringify` with U+2028 and U+2029 escaped,
 * so one document is always one line.
 *
 * ## The text printer
 *
 * The printer the `text` format prints through is the target's own
 * (`chunk-e7w77ts3.js:445913`): the text of the result document at the end of
 * the turn, `Execution error` plus the failure's detail on stderr for the
 * execution-error variant, and each error variant's own line. A document
 * already printed is never printed twice, and the separator between two
 * prints is the target's own — a newline after a print that ended with one,
 * and two otherwise.
 */

import { randomUUID } from 'node:crypto';

import type { ResultDocument } from '../headless.js';
import type { OutputSink } from '../output.js';

/* -------------------------------------------------------------------------- */
/* The wire documents                                                          */
/* -------------------------------------------------------------------------- */

/** One content block of an assistant message. */
export type AssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

/** One content block of a user message: the tool result the run turned around. */
export interface UserContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error: boolean;
}

/**
 * The member set the target's assistant message carries — the API's own
 * message shape.
 */
export interface AssistantMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  content: readonly AssistantContentBlock[];
  model: string;
}

/**
 * The `system`/`init` document, first on the wire.
 *
 * **The target's own schema** — `chunk-pj5cyqhw.js:333857`, glossed in the
 * findings' record: `{type:"system", subtype:"init", agents?, apiKeySource,
 * startup_timing?, betas?, claude_code_version, cwd, tools, mcp_servers,
 * model, permissionMode, slash_commands, terminal_slash_commands?,
 * output_style, skills, plugins, plugin_errors, …}`. The optional members this
 * implementation cannot fill are absent; the member **order** is the schema's.
 */
export interface SystemInitDocument {
  type: 'system';
  subtype: 'init';
  /** Where the run's key comes from, in the target's own vocabulary. */
  apiKeySource: string;
  /** The version this implementation runs. */
  claude_code_version: string;
  /** The working directory the run was started in. */
  cwd: string;
  /** The tools the session offers. */
  tools: readonly string[];
  /** The MCP servers the session is configured with. */
  mcp_servers: readonly string[];
  /** The model the run runs on. */
  model: string;
  /** The permission mode the session starts in. */
  permissionMode: string;
  /** The slash commands the session offers. */
  slash_commands: readonly string[];
  /** The active output style's name. */
  output_style: string;
  /** The skills the session can invoke. */
  skills: readonly string[];
  /** The plugins the session has loaded. */
  plugins: readonly string[];
  /** The problems the plugins that failed to load reported. */
  plugin_errors: readonly string[];
}

/**
 * The `assistant` document — **the target's own kind**
 * (`chunk-pj5cyqhw.js:261767`):
 * `{type:"assistant", message, parent_tool_use_id, uuid, session_id}`. The
 * member **order** is the schema's, and `parent_tool_use_id` is `null` for a
 * document that is not a subagent's.
 */
export interface AssistantDocument {
  type: 'assistant';
  /** The API message the document carries. */
  message: AssistantMessage;
  /** The tool call this message belongs to, when one does. */
  parent_tool_use_id: null;
  /** The document's id. */
  uuid: string;
  /** The session the run belonged to. */
  session_id: string;
}

/**
 * The `user` document — **the target's own kind** (`chunk-pj5cyqhw.js:239906`):
 * `{type:"user", message, parent_tool_use_id, tool_use_result, uuid,
 * session_id}`. The `tool_use_result` member is what the target's user
 * document marks a tool result with.
 */
export interface UserDocument {
  type: 'user';
  /** The API message the document carries. */
  message: { role: 'user'; content: readonly UserContentBlock[] };
  /** The tool call this message belongs to, when one does. */
  parent_tool_use_id: null;
  /** The result the tool produced. */
  tool_use_result: unknown;
  /** The document's id. */
  uuid: string;
  /** The session the run belonged to. */
  session_id: string;
}

/**
 * One document a `stream-json` run writes: the SDK message kinds, with the
 * **result** document — the target's own, from `src/cli/headless.ts` — last.
 */
export type StreamJsonDocument = SystemInitDocument | AssistantDocument | UserDocument | ResultDocument;

/* -------------------------------------------------------------------------- */
/* The builders                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the `system`/`init` document.
 *
 * The input is the **session's own context** — the working directory, the
 * model, the mode, the tools, the slash commands, the output style, the
 * skills and the version — resolved by the caller the way the command does.
 * The members the run has no counterpart for — the MCP surface and plugins are
 * refused on this path (`docs/compatibility/command-surface.md`) — are the
 * empty list.
 */
export function buildSystemInitDocument(input: {
  /** Where the run's key comes from. */
  apiKeySource: string;
  /** The version this implementation runs. */
  version: string;
  /** The working directory the run was started in. */
  cwd: string;
  /** The tools the session offers. */
  tools: readonly string[];
  /** The MCP servers the session is configured with. */
  mcpServers?: readonly string[];
  /** The model the run runs on. */
  model: string;
  /** The permission mode the session starts in. */
  mode: string;
  /** The slash commands the session offers. */
  slashCommands: readonly string[];
  /** The active output style's name. */
  outputStyle: string;
  /** The skills the session can invoke. */
  skills: readonly string[];
  /** The plugins the session has loaded; refused on this path, so empty. */
  plugins?: readonly string[];
  /** The problems the failed plugins reported; none, for the same reason. */
  pluginErrors?: readonly string[];
}): SystemInitDocument {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: input.apiKeySource,
    claude_code_version: input.version,
    cwd: input.cwd,
    tools: [...input.tools],
    mcp_servers: [...(input.mcpServers ?? [])],
    model: input.model,
    permissionMode: input.mode,
    slash_commands: [...input.slashCommands],
    output_style: input.outputStyle,
    skills: [...input.skills],
    plugins: [...(input.plugins ?? [])],
    plugin_errors: [...(input.pluginErrors ?? [])],
  };
}

/**
 * Build the `assistant` document for one message the run emitted.
 *
 * The **message** member is the API's own message shape: the id the record
 * names, the role, the blocks, the model the run ran on.
 */
export function buildAssistantDocument(input: {
  id: string;
  model: string;
  content: readonly AssistantContentBlock[];
  sessionId: string;
}): AssistantDocument {
  return {
    type: 'assistant',
    message: {
      id: input.id,
      type: 'message',
      role: 'assistant',
      content: [...input.content],
      model: input.model,
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: input.sessionId,
  };
}

/**
 * Build the `user` document for a tool result the run turned around.
 *
 * The **`tool_use_result`** member carries the result the tool produced, the
 * way the target's user document marks a tool result with
 * (`chunk-pj5cyqhw.js:239906`).
 */
export function buildUserDocument(input: {
  content: readonly UserContentBlock[];
  toolUseResult: unknown;
  sessionId: string;
}): UserDocument {
  return {
    type: 'user',
    message: { role: 'user', content: [...input.content] },
    parent_tool_use_id: null,
    tool_use_result: input.toolUseResult,
    uuid: randomUUID(),
    session_id: input.sessionId,
  };
}

/**
 * One line of a `stream-json` output.
 *
 * **The target's own writer** — `S_e` (`chunk-rrhrzgxv.js:11`) is
 * `JSON.stringify` with U+2028 and U+2029 escaped, and the writer appends one
 * newline (`chunk-btsgvmny.js:29557`), so a document that carries either
 * separator still arrives as **one** line.
 */
export function streamJsonLine(value: unknown): string {
  return `${JSON.stringify(value)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')}\n`;
}

/* -------------------------------------------------------------------------- */
/* The text printer                                                            */
/* -------------------------------------------------------------------------- */

/** The limits the printer's own lines name, when a run carries them. */
export interface PrinterLimits {
  /** The turn limit a `error_max_turns` document names. */
  maxTurns?: number;
  /** The budget limit a `error_max_budget_usd` document names. */
  maxBudgetUsd?: number;
}

/**
 * The printer the `text` format prints through.
 *
 * **The target's own printer** (`chunk-e7w77ts3.js:445913`), read back from
 * the findings' record:
 *
 *   - a `success` document prints the **result's text**, with a trailing
 *     newline ensured — a result that already ends with one is not doubled;
 *   - an `error_during_execution` document writes the failure's detail on
 *     **stderr** when the run produced one, and prints `Execution error` on
 *     stdout — **without** a trailing newline: the printer writes `Or(s+r)`
 *     and the failure branch sets `r` to the bare word;
 *   - an `error_max_turns`, `error_max_budget_usd` or
 *     `error_max_structured_output_retries` document prints its own line;
 *   - a document already printed is never printed again (`lastPrinted`), and
 *     the separator before a later print is `\n` when the previous print ended
 *     with a newline and `\n\n` otherwise.
 *
 * The limits name the two subtleties the printer's lines carry; this
 * implementation has no turn-budget machinery, so the documents that name
 * those subtypes come from a caller and the printer formats them.
 */
export class TextResultPrinter {
  private readonly stdout: OutputSink;
  private readonly stderr: OutputSink;
  private readonly limits?: PrinterLimits;
  private lastPrinted: ResultDocument | undefined;
  private printedCount = 0;
  private endsWithNewline = false;

  constructor(input: { stdout: OutputSink; stderr: OutputSink; limits?: PrinterLimits }) {
    this.stdout = input.stdout;
    this.stderr = input.stderr;
    this.limits = input.limits;
  }

  /**
   * Print one result document.
   *
   * The second argument is the failure's detail when the run produced one on
   * **an event the run yielded** rather than inside the document; the
   * document's own `errors` member wins, the way the target's printer reads
   * the failure it was built with.
   */
  print(document: ResultDocument, detail?: string): void {
    if (document === this.lastPrinted) return;

    let line: string;
    switch (document.subtype) {
      case 'success': {
        const text = document.result ?? '';
        line = text.endsWith('\n') ? text : `${text}\n`;
        break;
      }
      case 'error_during_execution': {
        const failureDetail = document.errors?.[0] ?? detail;
        if (failureDetail !== undefined) this.stderr.write(`${failureDetail}\n`);
        line = 'Execution error';
        break;
      }
      case 'error_max_turns':
        line = `Error: Reached max turns (${this.limits?.maxTurns ?? 0})`;
        break;
      case 'error_max_budget_usd':
        line = `Error: Exceeded USD budget (${this.limits?.maxBudgetUsd ?? 0})`;
        break;
      case 'error_max_structured_output_retries':
        line = `Error: ${
          document.errors?.[0] ?? 'Failed to provide valid structured output after maximum retries'
        }`;
        break;
    }

    const separator = this.printedCount === 0 ? '' : this.endsWithNewline ? '\n' : '\n\n';
    this.stdout.write(`${separator}${line}`);
    this.lastPrinted = document;
    this.printedCount += 1;
    this.endsWithNewline = line.endsWith('\n');
  }
}
