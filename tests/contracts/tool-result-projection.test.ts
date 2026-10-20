/**
 * Contract test for the projected tool-result content.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.4 (Agent loop and
 * tool dispatch) — "the block is `{ tool_use_id, type: "tool_result",
 * content: <string> }` with `is_error: true` added for a failure" — and the
 * `CC-009b` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What this test pins
 *
 *   1. A projected tool result's content is **always a string** — for a
 *      successful result, for an **error envelope**, and for a
 *      content-replacement stub. A failed tool leaves the transcript with an
 *      envelope whose content is an **object**
 *      (`{type:"error", message:…, errorCode:…}`); the projection used to pass
 *      it through raw, so the request *after* a failed tool carried a
 *      `tool_result` whose content was an object, and the observed wire shape
 *      is `{tool_use_id, type:"tool_result", content:<string>}`.
 *   2. The **live path** (`conversationFromEvents`) and the **cross-turn
 *      projection** (`contextToProviderMessages`) produce the **same** content
 *      for the same transcript — and so does the within-turn block the runtime
 *      sends (`toolResultBlock`).
 *   3. The serialisation is **written once**: the session module owns it and
 *      the agent module reaches it by import, so the two paths cannot drift.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { conversationFromEvents, toolResultBlock } from '../../src/agent/context.js';
import type { ProviderMessage } from '../../src/provider/drivers/types.js';
import {
  SESSION_SCHEMA_VERSION,
  type SessionEvent,
  type ToolResultStub,
} from '../../src/session/event.js';
import {
  contextToProviderMessages,
  resumeEvents,
  toolResultContent,
} from '../../src/session/resume.js';

/* -------------------------------------------------------------------------- */
/* The transcript                                                              */
/* -------------------------------------------------------------------------- */

function userMessage(id: string, text: string, ts: number, parentId?: string): SessionEvent {
  return {
    v: SESSION_SCHEMA_VERSION,
    t: 'user_message',
    ts,
    id,
    text,
    ...(parentId === undefined ? {} : { parentId }),
  };
}

function toolCall(
  id: string,
  name: string,
  input: unknown,
  ts: number,
  parentId?: string,
): SessionEvent {
  return {
    v: SESSION_SCHEMA_VERSION,
    t: 'tool_call',
    ts,
    id,
    name,
    input,
    ...(parentId === undefined ? {} : { parentId }),
  };
}

function toolResult(
  id: string,
  toolUseId: string,
  content: unknown,
  ts: number,
  options: { isError?: boolean; parentId?: string } = {},
): SessionEvent {
  return {
    v: SESSION_SCHEMA_VERSION,
    t: 'tool_result',
    ts,
    id,
    envelope: { toolUseId, content, isError: options.isError === true },
    ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
  };
}

function contentReplacement(
  id: string,
  targetId: string,
  replacement: ToolResultStub,
  ts: number,
  parentId?: string,
): SessionEvent {
  return {
    v: SESSION_SCHEMA_VERSION,
    t: 'content_replacement',
    ts,
    id,
    targetId,
    replacement,
    ...(parentId === undefined ? {} : { parentId }),
  };
}

/** The error envelope the tool runner leaves behind when a call fails. */
const ERROR_ENVELOPE = {
  type: 'error',
  message: 'the tool exploded',
  errorCode: 12,
} as const;

/** A transcript whose one tool call failed. */
function failedTranscript(): SessionEvent[] {
  return [
    userMessage('m0', 'read the file', 1000),
    toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
    toolResult('res_1', 'toolu_1', ERROR_ENVELOPE, 1200, {
      isError: true,
      parentId: 'toolu_1',
    }),
  ];
}

/* -------------------------------------------------------------------------- */
/* Reading the projection                                                      */
/* -------------------------------------------------------------------------- */

/** One projected tool result. */
interface ProjectedToolResult {
  /** The tool use the result answers. */
  toolUseId: string;
  /** The content, as the projection carried it. */
  content: unknown;
  /** Whether the result is an error. */
  isError: boolean;
}

/** The tool-result blocks of a set of provider messages. */
function toolResultsOf(messages: ProviderMessage[]): ProjectedToolResult[] {
  const blocks: ProjectedToolResult[] = [];
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      blocks.push({
        toolUseId: block.tool_use_id,
        content: block.content,
        isError: block.is_error === true,
      });
    }
  }
  return blocks;
}

/** The one tool-result block of a set of provider messages. */
function onlyToolResult(messages: ProviderMessage[]): ProjectedToolResult {
  const blocks = toolResultsOf(messages);
  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  if (block === undefined) throw new Error('expected exactly one tool_result block');
  return block;
}

/** How many times a string appears in a source. */
function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let index = source.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* The projection                                                              */
/* -------------------------------------------------------------------------- */

describe('the projected tool-result content', () => {
  it("projects a failed tool's error envelope as a string, not as the object", () => {
    const messages = contextToProviderMessages(resumeEvents(failedTranscript()).context);
    const block = onlyToolResult(messages);

    const content = block.content;
    expect(typeof content).toBe('string');
    // The envelope's object does not reach the wire.
    expect(content).not.toBe(ERROR_ENVELOPE);
    if (typeof content !== 'string') throw new Error('expected a string content');
    expect(content).toBe(JSON.stringify(ERROR_ENVELOPE));
    expect(block.isError).toBe(true);
  });

  it("projects a successful tool's string result as it is", () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', 'the output', 1200, { parentId: 'toolu_1' }),
    ];

    const block = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));

    expect(block.content).toBe('the output');
    expect(block.isError).toBe(false);
  });

  it("projects a successful tool's structured result as its JSON serialization", () => {
    const output = { file: 'a.txt', lines: 3 };
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', output, 1200, { parentId: 'toolu_1' }),
    ];

    const block = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));

    const content = block.content;
    expect(typeof content).toBe('string');
    if (typeof content !== 'string') throw new Error('expected a string content');
    expect(content).toBe(JSON.stringify(output));
  });

  it('projects a content-replacement stub as a string', () => {
    const payload = 'x'.repeat(4096);
    const stub: ToolResultStub = {
      type: 'tool_result_stub',
      originalBytes: payload.length,
      message: 'The tool result was replaced by a stub.',
    };
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', payload, 1200, { parentId: 'toolu_1' }),
      contentReplacement('rep_1', 'res_1', stub, 1300, 'res_1'),
    ];

    const block = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));

    const content = block.content;
    expect(typeof content).toBe('string');
    if (typeof content !== 'string') throw new Error('expected a string content');
    expect(content).toBe(JSON.stringify(stub));
    // The payload does not come back into the context.
    expect(content).not.toContain(payload);
  });

  it('projects every tool result of a transcript as a string', () => {
    const events = [
      userMessage('m0', 'read two files', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolCall('toolu_2', 'Read', { path: 'b.txt' }, 1110, 'toolu_1'),
      toolResult('res_1', 'toolu_1', 'the output', 1200, { parentId: 'toolu_2' }),
      toolResult('res_2', 'toolu_2', ERROR_ENVELOPE, 1210, {
        isError: true,
        parentId: 'res_1',
      }),
    ];

    const blocks = toolResultsOf(contextToProviderMessages(resumeEvents(events).context));

    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(typeof block.content).toBe('string');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The two paths                                                               */
/* -------------------------------------------------------------------------- */

describe('the two projection paths', () => {
  it('the live path and the cross-turn projection produce the same tool_result content', () => {
    const events = failedTranscript();

    const live = onlyToolResult(conversationFromEvents(events));
    const projected = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));

    expect(live.content).toBe(projected.content);
    expect(live.toolUseId).toBe(projected.toolUseId);
    expect(live.isError).toBe(projected.isError);
    expect(typeof live.content).toBe('string');
    expect(typeof projected.content).toBe('string');
  });

  it('the live path and the cross-turn projection agree on a successful result', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', { file: 'a.txt', lines: 3 }, 1200, {
        parentId: 'toolu_1',
      }),
    ];

    const live = onlyToolResult(conversationFromEvents(events));
    const projected = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));

    expect(live.content).toBe(projected.content);
    expect(typeof live.content).toBe('string');
    expect(typeof projected.content).toBe('string');
  });

  it('the within-turn tool result block agrees with the projection', () => {
    const events = failedTranscript();
    const projected = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));

    const block = toolResultBlock('toolu_1', ERROR_ENVELOPE, true);
    expect(block.type).toBe('tool_result');
    if (block.type !== 'tool_result') throw new Error('expected a tool_result block');

    const content = block.content;
    expect(typeof content).toBe('string');
    if (typeof content !== 'string') throw new Error('expected a string content');
    expect(content).toBe(projected.content);
    expect(content).toBe(JSON.stringify(ERROR_ENVELOPE));
    expect(content).toBe(toolResultContent(ERROR_ENVELOPE));
  });

  it('the serialisation is written once, and the agent module reaches it by import', () => {
    const resumeSource = readFileSync(
      new URL('../../src/session/resume.ts', import.meta.url),
      'utf8',
    );
    const agentSource = readFileSync(
      new URL('../../src/agent/context.ts', import.meta.url),
      'utf8',
    );

    // The shared serialisation is written once: inside `toolResultContent`.
    expect(countOccurrences(resumeSource, 'export function toolResultContent(')).toBe(1);
    const start = resumeSource.indexOf('export function toolResultContent(');
    expect(start).toBeGreaterThan(-1);
    const body = resumeSource.slice(start, resumeSource.indexOf('\n}', start));
    expect(countOccurrences(body, 'JSON.stringify(')).toBe(1);

    // The agent module has no serialisation of its own.
    expect(countOccurrences(agentSource, 'JSON.stringify(')).toBe(0);

    // And it reaches the session module's by import.
    expect(agentSource).toMatch(
      /import\s*\{[^}]*\btoolResultContent\b[^}]*\}\s*from\s*'\.\.\/session\/resume\.js'/,
    );
  });
});
