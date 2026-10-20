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
 *   2. The **wire shape** of the block is the observed one: a **success**
 *      carries **no** `is_error` member, and a **failure** carries
 *      `is_error: true`.
 *   3. The **three projection paths** — the **within-turn** builder
 *      (`toolResultBlock`), the **between-turns** load
 *      (`conversationFromEvents`) and the **cross-turn** projection
 *      (`contextToProviderMessages`) — produce the **same** content for the
 *      same transcript.
 *   4. A **content replacement** is honoured on **every** path: the
 *      transcript keeps the payload, and the context never sees it.
 *   5. The serialisation is **written once**: it is defined once in the whole
 *      source tree, and the agent module reaches it by import.
 *   6. The **edges** of the serialisation are pinned: an absent content, a
 *      `null` content, a value `JSON.stringify` cannot represent, a value it
 *      refuses, and a value that cannot be stringified at all.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { conversationFromEvents, toolResultBlock } from '../../src/agent/context.js';
import type { ProviderMessage } from '../../src/provider/drivers/types.js';
import {
  SESSION_SCHEMA_VERSION,
  type SessionEvent,
  type ToolResultStub,
} from '../../src/session/event.js';
import {
  applyContentReplacements,
  contextToProviderMessages,
  providerToolResultBlock,
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

/** The stub an oversized tool result is replaced by. */
const STUB: ToolResultStub = {
  type: 'tool_result_stub',
  originalBytes: 4096,
  message: 'The tool result was replaced by a stub.',
};

/** The payload of the oversized tool result the stub stands in for. */
const PAYLOAD = 'x'.repeat(4096);

/** A transcript whose one tool result was replaced by a stub. */
function replacedTranscript(): SessionEvent[] {
  return [
    userMessage('m0', 'read the file', 1000),
    toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
    toolResult('res_1', 'toolu_1', PAYLOAD, 1200, { parentId: 'toolu_1' }),
    contentReplacement('rep_1', 'res_1', STUB, 1300, 'res_1'),
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
  /** Whether the block carries the `is_error` member at all. */
  hasIsErrorMember: boolean;
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
        hasIsErrorMember: 'is_error' in block,
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

/* -------------------------------------------------------------------------- */
/* Reading the source tree                                                     */
/* -------------------------------------------------------------------------- */

/** Every TypeScript file under a directory. */
function sourceFilesUnder(directory: URL): string[] {
  const root = fileURLToPath(directory);
  const files: string[] = [];
  for (const relative of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!relative.endsWith('.ts')) continue;
    files.push(join(root, relative));
  }
  return files;
}

/** The path of a file, relative to the repository root. */
function relativePath(file: string): string {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  return file.startsWith(root) ? file.slice(root.length) : file;
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
    const events = replacedTranscript();

    const block = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));

    const content = block.content;
    expect(typeof content).toBe('string');
    if (typeof content !== 'string') throw new Error('expected a string content');
    expect(content).toBe(JSON.stringify(STUB));
    // The payload does not come back into the context.
    expect(content).not.toContain(PAYLOAD);
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
/* The wire shape of the block                                                 */
/* -------------------------------------------------------------------------- */

describe('the wire shape of a tool_result block', () => {
  it('carries no is_error member on a success', () => {
    const block = providerToolResultBlock('toolu_1', 'the output', false);

    expect(block.type).toBe('tool_result');
    expect('is_error' in block).toBe(false);
  });

  it('carries is_error: true on a failure', () => {
    const block = providerToolResultBlock('toolu_1', ERROR_ENVELOPE, true);

    expect(block.type).toBe('tool_result');
    if (block.type !== 'tool_result') throw new Error('expected a tool_result block');
    expect(block.is_error).toBe(true);
  });

  it('carries no is_error member on a success of the cross-turn projection', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', 'the output', 1200, { parentId: 'toolu_1' }),
    ];

    const block = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));

    expect(block.hasIsErrorMember).toBe(false);
  });

  it('carries is_error: true on a failure of the cross-turn projection', () => {
    const block = onlyToolResult(contextToProviderMessages(resumeEvents(failedTranscript()).context));

    expect(block.hasIsErrorMember).toBe(true);
    expect(block.isError).toBe(true);
  });

  it('carries no is_error member on a success of the between-turns load', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', 'the output', 1200, { parentId: 'toolu_1' }),
    ];

    const block = onlyToolResult(conversationFromEvents(events));

    expect(block.hasIsErrorMember).toBe(false);
  });

  it('carries is_error: true on a failure of the between-turns load', () => {
    const block = onlyToolResult(conversationFromEvents(failedTranscript()));

    expect(block.hasIsErrorMember).toBe(true);
    expect(block.isError).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The three projection paths                                                  */
/* -------------------------------------------------------------------------- */

describe('the three projection paths', () => {
  it('the within-turn builder agrees with the cross-turn projection', () => {
    const events = failedTranscript();
    const projected = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));

    const block = toolResultBlock('toolu_1', ERROR_ENVELOPE, true);
    expect(block.type).toBe('tool_result');
    if (block.type !== 'tool_result') throw new Error('expected a tool_result block');

    const content = block.content;
    expect(typeof content).toBe('string');
    if (typeof content !== 'string') throw new Error('expected a string content');
    expect(content).toBe(projected.content);
    // The concrete expected wire form — not the shared function compared with
    // itself.
    expect(content).toBe(JSON.stringify(ERROR_ENVELOPE));
    expect(block.is_error).toBe(true);
  });

  it('the between-turns load agrees with the cross-turn projection', () => {
    const events = failedTranscript();

    const betweenTurns = onlyToolResult(conversationFromEvents(events));
    const projected = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));

    expect(betweenTurns.content).toBe(projected.content);
    expect(betweenTurns.toolUseId).toBe(projected.toolUseId);
    expect(betweenTurns.isError).toBe(projected.isError);
    expect(typeof betweenTurns.content).toBe('string');
    expect(typeof projected.content).toBe('string');
  });

  it('the between-turns load and the within-turn builder agree on a successful result', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', { file: 'a.txt', lines: 3 }, 1200, {
        parentId: 'toolu_1',
      }),
    ];

    const betweenTurns = onlyToolResult(conversationFromEvents(events));
    const projected = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));
    const block = toolResultBlock('toolu_1', { file: 'a.txt', lines: 3 }, false);
    if (block.type !== 'tool_result') throw new Error('expected a tool_result block');

    expect(betweenTurns.content).toBe(projected.content);
    expect(block.content).toBe(projected.content);
    expect(typeof betweenTurns.content).toBe('string');
    expect(typeof projected.content).toBe('string');
  });
});

/* -------------------------------------------------------------------------- */
/* The content replacement on every path                                       */
/* -------------------------------------------------------------------------- */

describe('the content replacement', () => {
  it('stubs a replaced tool result on the between-turns load', () => {
    const block = onlyToolResult(conversationFromEvents(replacedTranscript()));

    const content = block.content;
    expect(typeof content).toBe('string');
    if (typeof content !== 'string') throw new Error('expected a string content');
    expect(content).toBe(JSON.stringify(STUB));
    // The 4096-byte payload does not reach the context.
    expect(content).not.toContain(PAYLOAD);
    expect(content.length).toBeLessThan(PAYLOAD.length);
  });

  it('stubs a replaced tool result on the cross-turn projection', () => {
    const block = onlyToolResult(contextToProviderMessages(resumeEvents(replacedTranscript()).context));

    const content = block.content;
    expect(typeof content).toBe('string');
    if (typeof content !== 'string') throw new Error('expected a string content');
    expect(content).toBe(JSON.stringify(STUB));
    expect(content).not.toContain(PAYLOAD);
  });

  it('stubs a replaced tool result the same way on every path', () => {
    const events = replacedTranscript();

    const betweenTurns = onlyToolResult(conversationFromEvents(events));
    const projected = onlyToolResult(contextToProviderMessages(resumeEvents(events).context));

    expect(betweenTurns.content).toBe(projected.content);
    expect(String(betweenTurns.content)).not.toContain(PAYLOAD);
    expect(String(projected.content)).not.toContain(PAYLOAD);
  });

  it('keeps the payload in the transcript and stubs only the context', () => {
    const events = replacedTranscript();

    const { events: replaced } = applyContentReplacements(events);

    // The transcript still holds the payload.
    const record = events[2];
    expect(record?.t === 'tool_result' ? record.envelope.content : undefined).toBe(PAYLOAD);
    // The projected copy holds the stub.
    const projected = replaced[2];
    expect(projected?.t === 'tool_result' ? projected.envelope.content : undefined).toEqual(STUB);
  });
});

/* -------------------------------------------------------------------------- */
/* The edges of the serialisation                                              */
/* -------------------------------------------------------------------------- */

describe('the edges of the tool-result serialisation', () => {
  it('projects an absent content as the empty string', () => {
    expect(toolResultContent(undefined)).toBe('');
  });

  it('projects a null content as its JSON serialization', () => {
    expect(toolResultContent(null)).toBe('null');
  });

  it('projects a value JSON.stringify cannot represent as its string form', () => {
    const marker = Symbol('the tool result');

    // `JSON.stringify` returns `undefined` for a symbol, and the string form
    // is what reaches the model.
    expect(JSON.stringify(marker)).toBeUndefined();
    expect(toolResultContent(marker)).toBe('Symbol(the tool result)');
  });

  it('projects a value JSON.stringify refuses as its string form', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(toolResultContent(circular)).toBe('[object Object]');
  });

  it('projects a value that cannot be stringified at all as a placeholder', () => {
    // A null-prototype value has no `toString` and no `valueOf`, so `String`
    // refuses it — and the refusal must not escape the serialisation.
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.self = hostile;

    expect(toolResultContent(hostile)).toBe('[unserializable tool result]');
  });

  it('never throws, whatever the content is', () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.self = hostile;

    const values: unknown[] = [
      undefined,
      null,
      0,
      '',
      false,
      Symbol('x'),
      () => undefined,
      hostile,
      { toJSON: () => ({ nested: true }) },
    ];
    for (const value of values) {
      expect(typeof toolResultContent(value)).toBe('string');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The serialisation is written once                                           */
/* -------------------------------------------------------------------------- */

describe('the tool-result serialisation', () => {
  it('is defined exactly once in the whole source tree', () => {
    // A **definition** of the serialiser — not an occurrence of `JSON.stringify`:
    // a second copy is a second definition, wherever it is written. The scan
    // matches the serialiser's **signature** — `(content: unknown): string` —
    // and its **name**, so it survives a reformat (the signature may be spread
    // over several lines) and a rename of the parameter, and it still finds a
    // copy that has neither.
    const patterns = [
      /function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*content\s*:\s*unknown\s*,?\s*\)\s*:\s*string\b/g,
      /function\s+toolResultContent\s*\(/g,
    ];

    const sites = new Set<string>();
    for (const file of sourceFilesUnder(new URL('../../src/', import.meta.url))) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          sites.add(`${relativePath(file)}@${match.index ?? -1}`);
        }
      }
    }

    expect([...sites]).toHaveLength(1);
    expect([...sites][0]).toContain('src/session/resume.ts');
  });

  it('is defined once under its own name, in the session module', () => {
    const definition = /function\s+toolResultContent\s*\(/g;

    const definitions: string[] = [];
    for (const file of sourceFilesUnder(new URL('../../src/', import.meta.url))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(definition)) {
        definitions.push(`${relativePath(file)}: ${match[0]}`);
      }
    }

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toContain('src/session/resume.ts');
  });

  it('builds the provider tool_result block in exactly one place', () => {
    const definition =
      /function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*toolUseId\s*:\s*string\s*,\s*content\s*:\s*unknown\s*,\s*isError\s*:\s*boolean\s*,?\s*\)\s*:\s*ProviderContentBlock\b/g;

    const definitions: string[] = [];
    for (const file of sourceFilesUnder(new URL('../../src/', import.meta.url))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(definition)) {
        definitions.push(`${relativePath(file)}: ${match[0]}`);
      }
    }

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toContain('src/session/resume.ts');
  });

  it('is reached by the agent module through the session module', () => {
    const agentSource = readFileSync(
      new URL('../../src/agent/context.ts', import.meta.url),
      'utf8',
    );

    // The agent module holds no serialisation of its own, and it reaches the
    // session module's by import.
    expect(agentSource).toMatch(
      /import\s*\{[^}]*\bproviderToolResultBlock\b[^}]*\}\s*from\s*'\.\.\/session\/resume\.js'/,
    );
    expect(agentSource).not.toMatch(/function\s+toolResultContent\b/);
  });
});
