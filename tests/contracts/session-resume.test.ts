/**
 * Contract test for the resume algorithm and the compaction boundary.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.6 (Sessions,
 * persistence, and resumption) and the `CC-009` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins: the branch that ends at the newest leaf rather than the branch
 * that was written last, the pairing of a `tool_result` with its `tool_call`,
 * the interrupted-turn walk, the resume point, the compaction marker and its
 * summary, the skipped — not deleted — pre-compact prefix, and the content
 * replacement that is applied on resume.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_SCHEMA_VERSION, SessionVersionError, type SessionEvent } from '../../src/session/event.js';
import { createSessionStore } from '../../src/session/store.js';
import {
  SESSION_RESUMED_TELEMETRY_EVENT,
  contextToProviderMessages,
  pairToolCalls,
  resumeAtMessage,
  resumeEvents,
  resumeSession,
  type ContextItem,
  type SessionResumedTelemetry,
} from '../../src/session/resume.js';
import { compact } from '../../src/session/compaction.js';

const CWD = '/home/user/project';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'session-resume-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

async function collect(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

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

function assistantMessage(id: string, text: string, ts: number, parentId?: string): SessionEvent {
  return {
    v: SESSION_SCHEMA_VERSION,
    t: 'assistant_message',
    ts,
    id,
    text,
    ...(parentId === undefined ? {} : { parentId }),
  };
}

function toolCall(id: string, name: string, input: unknown, ts: number, parentId?: string): SessionEvent {
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

function toolResult(id: string, toolUseId: string, content: unknown, ts: number, parentId?: string): SessionEvent {
  return {
    v: SESSION_SCHEMA_VERSION,
    t: 'tool_result',
    ts,
    id,
    envelope: { toolUseId, content, isError: false },
    ...(parentId === undefined ? {} : { parentId }),
  };
}

function providerEvent(id: string, ts: number, parentId?: string): SessionEvent {
  return {
    v: SESSION_SCHEMA_VERSION,
    t: 'provider_event',
    ts,
    id,
    event: { type: 'text_delta', text: 'partial' },
    ...(parentId === undefined ? {} : { parentId }),
  };
}

function permissionRequest(id: string, toolName: string, ts: number, parentId?: string): SessionEvent {
  return {
    v: SESSION_SCHEMA_VERSION,
    t: 'permission_request',
    ts,
    id,
    toolName,
    ...(parentId === undefined ? {} : { parentId }),
  };
}

function toolUseIds(context: ContextItem[]): string[] {
  const ids: string[] = [];
  for (const item of context) {
    if (item.type !== 'message') continue;
    for (const block of item.blocks) {
      if (block.type === 'tool_use') ids.push(block.id);
    }
  }
  return ids;
}

describe('the resume algorithm', () => {
  it('reconstructs the branch that ends at the newest leaf, not the one written last', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD });

    // Two children of one parent. The **later** one is written first: a
    // rewound branch stays in the file and must not win by being written last.
    const parent = assistantMessage('m1', 'thinking', 1100, 'm0');
    const later = toolCall('tc_later', 'Bash', { command: 'ls' }, 1300, 'm1');
    const earlier = toolCall('tc_earlier', 'Read', { path: 'a.txt' }, 1200, 'm1');

    await store.append(handle, userMessage('m0', 'hello', 1000));
    await store.append(handle, parent);
    await store.append(handle, later);
    await store.append(handle, earlier);

    const events = await collect(store.read(handle));
    const result = resumeEvents(events);

    expect(result.branch?.eventIds).toEqual(['m0', 'm1', 'tc_later']);
    expect(toolUseIds(result.context)).toEqual(['tc_later']);
  });

  it('wins a leaf tie with the one that was written last', () => {
    // Two leaves with the same timestamp. The tie is won by the one written
    // **last** — the rule this implementation documents, and the rule a rewound branch
    // depends on.
    const events: SessionEvent[] = [
      userMessage('m0', 'hello', 1000),
      assistantMessage('m1', 'thinking', 1100, 'm0'),
      toolCall('tc_first', 'Read', { path: 'a.txt' }, 1200, 'm1'),
      toolCall('tc_last', 'Read', { path: 'b.txt' }, 1200, 'm1'),
    ];

    const result = resumeEvents(events);
    expect(result.branch?.leafId).toBe('tc_last');
    expect(result.branch?.eventIds).toEqual(['m0', 'm1', 'tc_last']);
  });

  it('pairs a tool_result with the tool_call it answers', () => {
    const call = toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1000);
    const result = toolResult('res_1', 'toolu_1', 'the output', 1100);

    const pairing = pairToolCalls([call, result]);
    expect(pairing.pairs).toHaveLength(1);
    expect(pairing.pairs[0]?.call.id).toBe('toolu_1');
    expect(pairing.pairs[0]?.result?.id).toBe('res_1');
    // The pending id is removed the moment its result is seen.
    expect(pairing.pending).toEqual([]);
  });

  it('keeps a tool call whose result never arrived pending', () => {
    const call = toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1000);
    const pairing = pairToolCalls([call]);
    expect(pairing.pending).toEqual(['toolu_1']);
    expect(pairing.pairs[0]?.result).toBeUndefined();
  });

  it('reports an interrupted turn when a tool call was never answered', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
    ];

    const result = resumeEvents(events);
    expect(result.interrupted?.toolUseIds).toEqual(['toolu_1']);
    expect(result.resumePoint?.kind).toBe('assistant_tool_use');
  });

  it('reports no interruption when every tool call was answered', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', 'the output', 1200, 'toolu_1'),
      assistantMessage('m2', 'the file says hello', 1300, 'res_1'),
    ];

    const result = resumeEvents(events);
    expect(result.interrupted).toBeUndefined();
    expect(result.resumePoint?.kind).toBe('assistant_tool_use');
  });

  it('points the resume point at the last assistant message that carries a tool use', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', 'the output', 1200, 'toolu_1'),
      toolCall('toolu_2', 'Read', { path: 'b.txt' }, 1300, 'res_1'),
      toolResult('res_2', 'toolu_2', 'the other output', 1400, 'toolu_2'),
      assistantMessage('m3', 'both files say hello', 1500, 'res_2'),
    ];

    const result = resumeEvents(events);
    expect(result.resumePoint?.kind).toBe('assistant_tool_use');
    // The message that carries the **last** tool use, not the last message.
    expect(result.resumePoint?.index).toBe(3);
  });

  it('falls back to the last message when no assistant message carries a tool use', () => {
    const events = [
      userMessage('m0', 'hello', 1000),
      assistantMessage('m1', 'hi', 1100, 'm0'),
    ];

    const result = resumeEvents(events);
    expect(result.resumePoint?.kind).toBe('last_message');
    expect(result.resumePoint?.index).toBe(1);
  });

  it('groups the tool calls of one turn into one assistant message', () => {
    const events = [
      userMessage('m0', 'read both files', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolCall('toolu_2', 'Read', { path: 'b.txt' }, 1200, 'toolu_1'),
      toolResult('res_1', 'toolu_1', 'a', 1300, 'toolu_2'),
      toolResult('res_2', 'toolu_2', 'b', 1400, 'res_1'),
    ];

    const result = resumeEvents(events);
    const messages = result.context.filter((item) => item.type === 'message');
    expect(messages).toHaveLength(3);
    expect(messages[1]?.type === 'message' ? messages[1].role : undefined).toBe('assistant');
    expect(messages[1]?.type === 'message' ? messages[1].blocks.length : undefined).toBe(2);
    expect(messages[2]?.type === 'message' ? messages[2].blocks.length : undefined).toBe(2);
  });

  it('turns the context into the messages of a provider request', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', 'the output', 1200, 'toolu_1'),
    ];

    const messages = contextToProviderMessages(resumeEvents(events).context);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[2]?.role).toBe('user');
  });

  it('refuses to resume a record whose version it does not know', () => {
    const stale = {
      v: 2,
      t: 'user_message',
      ts: 1000,
      id: 'm0',
      text: 'hello',
    } as unknown as SessionEvent;

    expect(() => resumeEvents([stale])).toThrow(SessionVersionError);
  });
});

describe('the compaction boundary', () => {
  it('keeps the last keepLast events and emits a compaction marker with the summary', () => {
    const events = [
      userMessage('m0', 'one', 1000),
      assistantMessage('m1', 'two', 1100, 'm0'),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1200, 'm1'),
      toolResult('res_1', 'toolu_1', 'the output', 1300, 'toolu_1'),
      assistantMessage('m2', 'three', 1400, 'res_1'),
    ];

    const { events: compacted, summary } = compact(events, {
      keepLast: 2,
      summary: 'the earlier conversation',
      ts: 5000,
      id: 'cmp_1',
    });

    expect(summary).toBe('the earlier conversation');
    expect(compacted).toHaveLength(3);
    expect(compacted[0]?.t).toBe('compaction');
    expect(compacted[1]?.id).toBe('res_1');
    expect(compacted[2]?.id).toBe('m2');

    const marker = compacted[0];
    if (marker?.t !== 'compaction') throw new Error('expected a compaction marker');
    expect(marker.replacedFrom).toBe(3);
    expect(marker.id).toBe('cmp_1');
    expect(marker.ts).toBe(5000);
    // The marker hangs off the last pre-compact record, the way the target's
    // boundary line points at the last pre-compact message.
    expect(marker.parentId).toBe('toolu_1');
  });

  it('never produces a summary locally', () => {
    const events = [
      userMessage('m0', 'one', 1000),
      assistantMessage('m1', 'two', 1100, 'm0'),
    ];

    const { events: compacted, summary } = compact(events, { keepLast: 1 });
    expect(summary).toBeUndefined();
    // Without a summary there is no boundary to mark, and nothing is dropped.
    expect(compacted).toEqual(events);
  });

  it('skips the pre-compact prefix when reading and does not delete it from the file', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD });

    const events = [
      userMessage('m0', 'one', 1000),
      assistantMessage('m1', 'two', 1100, 'm0'),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1200, 'm1'),
      toolResult('res_1', 'toolu_1', 'the output', 1300, 'toolu_1'),
      assistantMessage('m2', 'three', 1400, 'res_1'),
    ];
    for (const event of events) await store.append(handle, event);

    const { events: compacted } = compact(events, {
      keepLast: 2,
      summary: 'the earlier conversation',
      ts: 5000,
      id: 'cmp_1',
    });
    const marker = compacted[0];
    if (marker === undefined) throw new Error('expected a compaction marker');
    await store.append(handle, marker);

    // The prefix is still in the file: the transcript is append-only.
    const raw = readFileSync(handle.path, 'utf8');
    const lines = raw.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(6);
    expect(raw).toContain('"m0"');
    expect(raw).toContain('"m1"');

    // The prefix is skipped when the session is read.
    const result = resumeEvents(await collect(store.read(handle)));
    expect(result.context[0]?.type).toBe('summary');
    expect(result.context[0]?.type === 'summary' ? result.context[0].text : undefined).toBe(
      'the earlier conversation',
    );
    expect(result.context).toHaveLength(3);
    expect(result.compaction?.replacedFrom).toBe(3);

    const messages = result.context.filter((item) => item.type === 'message');
    expect(messages).toHaveLength(2);
    expect(messages[0]?.type === 'message' ? messages[0].role : undefined).toBe('user');
    expect(messages[0]?.type === 'message' ? messages[0].blocks : undefined).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_1', content: 'the output', isError: false },
    ]);
    expect(messages[1]?.type === 'message' ? messages[1].role : undefined).toBe('assistant');
    expect(messages[1]?.type === 'message' ? messages[1].blocks : undefined).toEqual([
      { type: 'text', text: 'three' },
    ]);
  });

  it('walks through a boundary marker to the messages that came before it', () => {
    // A compacted conversation: the marker hangs off the last pre-compact
    // message, and the records that continue the conversation hang off the
    // marker. The branch is the **messages**: the marker is walked through.
    const marker: SessionEvent = {
      v: SESSION_SCHEMA_VERSION,
      t: 'compaction',
      ts: 1200,
      id: 'cmp_1',
      summary: 'the earlier conversation',
      replacedFrom: 2,
      parentId: 'm1',
    };
    const events: SessionEvent[] = [
      userMessage('m0', 'one', 1000),
      assistantMessage('m1', 'two', 1100, 'm0'),
      marker,
      userMessage('m2', 'three', 1300, 'cmp_1'),
      assistantMessage('m3', 'four', 1400, 'm2'),
    ];

    const result = resumeEvents(events);
    expect(result.context).toHaveLength(3);
    expect(result.context[0]?.type).toBe('summary');
    expect(result.context[0]?.type === 'summary' ? result.context[0].text : undefined).toBe(
      'the earlier conversation',
    );
    expect(result.branch?.eventIds).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('keeps every record the compaction kept when a non-message record sits in the compacted prefix', () => {
    // A `provider_event` in the compacted prefix shifts every index that is
    // counted over the *full* record list. The boundary must not drop a
    // message the compaction never claimed to replace.
    const events: SessionEvent[] = [
      userMessage('m0', 'one', 1000),
      providerEvent('p0', 1100, 'm0'),
      assistantMessage('m1', 'two', 1200, 'p0'),
      assistantMessage('m2', 'three', 1300, 'm1'),
      assistantMessage('m3', 'four', 1400, 'm2'),
    ];

    const { events: compacted } = compact(events, {
      keepLast: 2,
      summary: 'the earlier conversation',
      ts: 5000,
      id: 'cmp_1',
    });
    const marker = compacted[0];
    if (marker === undefined) throw new Error('expected a compaction marker');

    // The marker is appended to the transcript; the prefix stays in the file.
    const result = resumeEvents([...events, marker]);

    const messages = result.context.filter((item) => item.type === 'message');
    expect(messages.map((item) => (item.type === 'message' ? item.eventIds : []))).toEqual([
      ['m2'],
      ['m3'],
    ]);
  });

  it('applies a compaction whose parent is not a message', () => {
    // The last dropped record is a `provider_event`, so the marker's parent is
    // not a message. The marker is still reachable from the branch's parent
    // chain, so the compaction applies.
    const events: SessionEvent[] = [
      userMessage('m0', 'one', 1000),
      assistantMessage('m1', 'two', 1100, 'm0'),
      providerEvent('p0', 1200, 'm1'),
      assistantMessage('m2', 'three', 1300, 'p0'),
      assistantMessage('m3', 'four', 1400, 'm2'),
    ];

    const { events: compacted } = compact(events, {
      keepLast: 2,
      summary: 'the earlier conversation',
      ts: 5000,
      id: 'cmp_1',
    });
    const marker = compacted[0];
    if (marker === undefined) throw new Error('expected a compaction marker');
    if (marker.t !== 'compaction') throw new Error('expected a compaction marker');
    // The marker hangs off the last dropped **record**, which is not a message.
    expect(marker.parentId).toBe('p0');

    const result = resumeEvents([...events, marker]);
    expect(result.compaction).toBeDefined();
    expect(result.context[0]?.type).toBe('summary');
  });

  it('applies the compaction to the effective list the compaction returned', () => {
    const events: SessionEvent[] = [
      userMessage('m0', 'one', 1000),
      providerEvent('p0', 1100, 'm0'),
      assistantMessage('m1', 'two', 1200, 'p0'),
      assistantMessage('m2', 'three', 1300, 'm1'),
      assistantMessage('m3', 'four', 1400, 'm2'),
    ];

    const { events: compacted } = compact(events, {
      keepLast: 2,
      summary: 'the earlier conversation',
      ts: 5000,
      id: 'cmp_1',
    });

    // The effective list carries the marker and the tail; the prefix it
    // replaced is not in it, so nothing is skipped — the summary still leads.
    const result = resumeEvents(compacted);
    expect(result.context[0]?.type).toBe('summary');
    const messages = result.context.filter((item) => item.type === 'message');
    expect(messages.map((item) => (item.type === 'message' ? item.eventIds : []))).toEqual([
      ['m2'],
      ['m3'],
    ]);
  });

  it('applies the content replacement on resume so the payload does not return', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir, maxToolResultBytes: 64 });
    const handle = await store.create({ cwd: CWD });

    const payload = 'x'.repeat(4096);
    await store.append(handle, userMessage('m0', 'read the file', 1000));
    await store.append(handle, toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'));
    await store.append(
      handle,
      toolResult('res_1', 'toolu_1', payload, 1200, 'toolu_1'),
    );

    // The transcript keeps the payload; the context does not.
    expect(readFileSync(handle.path, 'utf8')).toContain(payload);

    const result = resumeEvents(await collect(store.read(handle)));

    const messages = result.context.filter((item) => item.type === 'message');
    const userMessageItem = messages[2];
    expect(userMessageItem?.type).toBe('message');
    if (userMessageItem?.type !== 'message') throw new Error('expected a message');
    const block = userMessageItem.blocks[0];
    expect(block?.type).toBe('tool_result');
    if (block?.type !== 'tool_result') throw new Error('expected a tool_result block');
    expect(block.content).not.toBe(payload);
    expect((block.content as { type?: string }).type).toBe('tool_result_stub');

    expect(result.replacements?.map((replacement) => replacement.targetId)).toEqual(['res_1']);
  });
});

describe('the structured state of a resumed transcript', () => {
  it('carries the state the target\'s resumed transcript carries', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', 'the output', 1200, 'toolu_1'),
      toolCall('toolu_2', 'Bash', { command: 'ls' }, 1300, 'res_1'),
    ];

    const result = resumeEvents(events);

    // The answered tool use agrees with the pairing rule: a tool use is
    // answered by the tool result with the same id.
    expect(result.answeredToolUseIds).toEqual(['toolu_1']);
    // The call that was never answered is deferred, and the rescue of it is
    // suppressed: the resume reports the interruption, it does not re-issue
    // the call.
    expect(result.deferredToolUse?.id).toBe('toolu_2');
    expect(result.deferredToolUse?.name).toBe('Bash');
    expect(result.deferredToolUse?.input).toEqual({ command: 'ls' });
    expect(result.rescueSuppressed).toBe(true);
    // The interruption state names the kind of the interruption.
    expect(result.turnInterruptionState?.kind).toBe('pending_tool_use');
    expect(result.turnInterruptionState?.toolUseIds).toEqual(['toolu_2']);
    // A session that was not in plan mode, and that was not a fork.
    expect(result.planModeOnResume).toBe(false);
    expect(result.resumedAsFork).toBe(false);
    expect(result.adoptedSessionId).toBeUndefined();
  });

  it('reports a superseded tool call and a turn that ended cleanly', () => {
    const events = [
      userMessage('m0', 'one', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      assistantMessage('m1', 'two', 1200, 'toolu_1'),
    ];

    const { events: compacted } = compact(events, {
      keepLast: 1,
      summary: 'the earlier conversation',
      ts: 5000,
      id: 'cmp_1',
    });
    const marker = compacted[0];
    if (marker === undefined) throw new Error('expected a compaction marker');

    const result = resumeEvents([...events, marker]);

    // The call the compaction replaced is superseded: it is in the transcript
    // and not in the context.
    expect(result.supersededToolUseIds).toEqual(['toolu_1']);
    expect(result.supersededToolNames).toEqual(['Read']);
    expect(result.answeredToolUseIds).toEqual([]);
    expect(result.turnInterruptionState?.kind).toBe('none');
    expect(result.rescueSuppressed).toBe(false);
  });

  it('carries the plan mode, the fork and the adopted id into the result', () => {
    const result = resumeEvents([userMessage('m0', 'hello', 1000)], {
      planModeOnResume: true,
      resumedAsFork: true,
      adoptedSessionId: 'forked-01',
    });

    expect(result.planModeOnResume).toBe(true);
    expect(result.resumedAsFork).toBe(true);
    expect(result.adoptedSessionId).toBe('forked-01');
  });

  it('turns a compaction summary into a user message', () => {
    const events: SessionEvent[] = [
      userMessage('m0', 'one', 1000),
      assistantMessage('m1', 'two', 1100, 'm0'),
    ];
    const { events: compacted } = compact(events, {
      keepLast: 1,
      summary: 'the earlier conversation',
      ts: 5000,
      id: 'cmp_1',
    });
    const marker = compacted[0];
    if (marker === undefined) throw new Error('expected a compaction marker');

    const messages = contextToProviderMessages(resumeEvents([...events, marker]).context);
    // The summary of the prefix has to reach the model, and the user turn is
    // where it belongs.
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content[0]).toEqual({ type: 'text', text: 'the earlier conversation' });
  });

  it('keeps the permission request in the context and does not send it to the provider', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      permissionRequest('perm_1', 'Read', 1100, 'm0'),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1200, 'perm_1'),
      toolResult('res_1', 'toolu_1', 'the output', 1300, 'toolu_1'),
    ];

    const result = resumeEvents(events);

    // The approval is part of the transcript and is read back.
    const requests = result.context.filter((item) => item.type === 'permission_request');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.type === 'permission_request' ? requests[0].toolName : undefined).toBe('Read');

    // The decision reaches the model through the tool result, so the
    // permission request is not part of a provider request.
    const messages = contextToProviderMessages(result.context);
    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('resuming at a message', () => {
  it('refuses a message that is not in the transcript', () => {
    const events = [userMessage('m0', 'hello', 1000)];

    const result = resumeAtMessage(events, 'nope');

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toBe('processing_error');
    expect(result.message).toBe('No message found with message.uuid of: nope');
  });

  it('refuses a resume that would discard part of a turn', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', 'the output', 1200, 'toolu_1'),
    ];

    // Resuming at the tool call would drop its answer.
    const result = resumeAtMessage(events, 'toolu_1');

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toBe('drop_guard_refused');
    expect(result.message).toContain(
      'resuming at toolu_1 would discard entries not attributable to turn toolu_1',
    );
    expect(result.message).toContain('res_1');
  });

  it('allows a resume that discards a whole turn', () => {
    const events = [
      userMessage('m0', 'read the file', 1000),
      toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'),
      toolResult('res_1', 'toolu_1', 'the output', 1200, 'toolu_1'),
    ];

    const result = resumeAtMessage(events, 'm0');

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected a resume');
    expect(result.events.map((event) => event.id)).toEqual(['m0']);
    expect(result.discardedEventIds).toEqual(['toolu_1', 'res_1']);
  });
});

describe('resuming a session', () => {
  it('emits the target\'s resume telemetry', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD, sessionId: 'session-01' });
    await store.append(handle, userMessage('m0', 'hello', 1000));

    const events: SessionResumedTelemetry[] = [];
    const result = await resumeSession({
      store,
      cwd: CWD,
      entrypoint: 'cli_flag',
      target: 'session-01',
      onTelemetry: (event) => events.push(event),
    });

    expect(result.status).toBe('resumed');
    expect(result.sessionId).toBe('session-01');
    expect(events).toHaveLength(1);
    const telemetry = events[0];
    if (telemetry?.success !== true) throw new Error('expected a success');
    expect(telemetry.name).toBe(SESSION_RESUMED_TELEMETRY_EVENT);
    expect(telemetry.name).toBe('tengu_session_resumed');
    expect(telemetry.entrypoint).toBe('cli_flag');
    expect(telemetry.resume_duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('reports a failed resume with the target\'s failure reason', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });

    const events: SessionResumedTelemetry[] = [];
    const result = await resumeSession({
      store,
      cwd: CWD,
      entrypoint: 'cli_flag',
      target: '123e4567-e89b-12d3-a456-426614174000',
      onTelemetry: (event) => events.push(event),
    });

    expect(result.status).toBe('failed');
    expect(result.failure?.reason).toBe('not_found_explicit_id');
    expect(result.failure?.message).toBe(
      'No conversation found with session ID: 123e4567-e89b-12d3-a456-426614174000',
    );
    const telemetry = events[0];
    if (telemetry?.success !== false) throw new Error('expected a failure');
    expect(telemetry.failure_reason).toBe('not_found_explicit_id');
    expect(telemetry.error_name).toBe('SessionResumeError');
  });

  it('refuses a resume at a message that is not there', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD, sessionId: 'session-01' });
    await store.append(handle, userMessage('m0', 'hello', 1000));

    const events: SessionResumedTelemetry[] = [];
    const result = await resumeSession({
      store,
      cwd: CWD,
      entrypoint: 'cli_flag',
      target: 'session-01',
      messageUuid: 'nope',
      onTelemetry: (event) => events.push(event),
    });

    expect(result.status).toBe('failed');
    expect(result.failure?.reason).toBe('processing_error');
    expect(result.failure?.message).toBe('No message found with message.uuid of: nope');
    const telemetry = events[0];
    if (telemetry?.success !== false) throw new Error('expected a failure');
    expect(telemetry.failure_reason).toBe('processing_error');
  });

  it('refuses a resume that the drop guard refuses', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD, sessionId: 'session-01' });
    await store.append(handle, userMessage('m0', 'read the file', 1000));
    await store.append(handle, toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'));
    await store.append(handle, toolResult('res_1', 'toolu_1', 'the output', 1200, 'toolu_1'));

    const events: SessionResumedTelemetry[] = [];
    const result = await resumeSession({
      store,
      cwd: CWD,
      entrypoint: 'cli_flag',
      target: 'session-01',
      messageUuid: 'toolu_1',
      onTelemetry: (event) => events.push(event),
    });

    expect(result.status).toBe('failed');
    expect(result.failure?.reason).toBe('drop_guard_refused');
    expect(result.failure?.message).toContain(
      'resuming at toolu_1 would discard entries not attributable to turn toolu_1',
    );
    const telemetry = events[0];
    if (telemetry?.success !== false) throw new Error('expected a failure');
    expect(telemetry.failure_reason).toBe('drop_guard_refused');
  });

  it('reports a transcript it cannot load', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD, sessionId: 'session-01' });
    // A record of a version this build does not know: the transcript cannot be
    // read, and the resume says so.
    writeFileSync(
      handle.path,
      '{"v":2,"t":"user_message","ts":1,"id":"m1","text":"hello"}\n',
      'utf8',
    );

    const result = await resumeSession({
      store,
      cwd: CWD,
      entrypoint: 'cli_flag',
      target: 'session-01',
    });

    expect(result.status).toBe('failed');
    expect(result.failure?.reason).toBe('load_error');
    expect(result.failure?.message).toContain('version');
  });

  it('resumes a transcript that is named by its path', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD, sessionId: 'session-01' });
    await store.append(handle, userMessage('m0', 'hello', 1000));

    const events: SessionResumedTelemetry[] = [];
    const result = await resumeSession({
      store,
      cwd: CWD,
      entrypoint: 'file',
      target: handle.path,
      onTelemetry: (event) => events.push(event),
    });

    expect(result.status).toBe('resumed');
    expect(result.sessionId).toBe('session-01');
    const telemetry = events[0];
    if (telemetry?.success !== true) throw new Error('expected a success');
    expect(telemetry.entrypoint).toBe('file');
  });

  it('attaches to a live session instead of replaying it', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD, sessionId: 'session-01' });
    await store.append(handle, userMessage('m0', 'hello', 1000));

    const result = await resumeSession({
      store,
      cwd: CWD,
      entrypoint: 'cli_flag',
      target: 'session-01',
      isLiveSession: (sessionId) => sessionId === 'session-01',
    });

    expect(result.status).toBe('attached');
    expect(result.sessionId).toBe('session-01');
    // The attached session can be forked.
    expect(result.canFork).toBe(true);
    expect(result.resume).toBeUndefined();
  });

  it('attaches to a live session named by its path', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD, sessionId: 'session-01' });
    await store.append(handle, userMessage('m0', 'hello', 1000));

    const result = await resumeSession({
      store,
      cwd: CWD,
      entrypoint: 'file',
      target: handle.path,
      isLiveSession: (sessionId) => sessionId === 'session-01',
    });

    expect(result.status).toBe('attached');
    expect(result.sessionId).toBe('session-01');
    expect(result.canFork).toBe(true);
  });

  it('loads a copy of a live session when the fork flag is set', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD, sessionId: 'session-01' });
    await store.append(handle, userMessage('m0', 'hello', 1000));

    const result = await resumeSession({
      store,
      cwd: CWD,
      entrypoint: 'cli_flag',
      target: 'session-01',
      forkSession: true,
      isLiveSession: () => true,
      idFactory: () => 'forked-01',
    });

    expect(result.status).toBe('resumed');
    expect(result.resumedAsFork).toBe(true);
    expect(result.adoptedSessionId).toBe('forked-01');
    expect(result.resume?.resumedAsFork).toBe(true);
    expect(result.resume?.adoptedSessionId).toBe('forked-01');
  });

  it('reports a state the worker could not read', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD, sessionId: 'session-01' });
    await store.append(handle, userMessage('m0', 'hello', 1000));

    const result = await resumeSession({
      store,
      cwd: CWD,
      entrypoint: 'print',
      target: 'session-01',
      readSessionState: () => {
        throw new Error('the state is unreadable');
      },
    });

    expect(result.status).toBe('failed');
    expect(result.failure?.reason).toBe('worker_state_unread');
  });

  it('carries the interruption kind on the print path', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD, sessionId: 'session-01' });
    await store.append(handle, userMessage('m0', 'read the file', 1000));
    await store.append(handle, toolCall('toolu_1', 'Read', { path: 'a.txt' }, 1100, 'm0'));

    const events: SessionResumedTelemetry[] = [];
    await resumeSession({
      store,
      cwd: CWD,
      entrypoint: 'print',
      target: 'session-01',
      onTelemetry: (event) => events.push(event),
    });

    const telemetry = events[0];
    if (telemetry?.success !== true) throw new Error('expected a success');
    expect(telemetry.interruption_kind).toBe('pending_tool_use');
  });
});
