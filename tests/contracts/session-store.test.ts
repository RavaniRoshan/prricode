/**
 * Contract test for the session store: the append-only JSONL transcript, the
 * layout under the configuration root, the reader's tolerance of a torn final
 * line, the version guard, the oversized-tool-result replacement, and the
 * carried-prompt policy.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.6 (Sessions,
 * persistence, and resumption) and the `CC-009` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The test pins: one JSON object per line, the events read back in order, the
 * `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl` layout, the encoded
 * project directory name, the discarded torn final line, the refused unknown
 * record version, the stored stub of an oversized tool result, and every
 * outcome of the carried-prompt vocabulary.
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SESSION_SCHEMA_VERSION,
  SessionVersionError,
  type SessionEvent,
} from '../../src/session/event.js';
import {
  CARRIED_PROMPT_TELEMETRY_EVENT,
  MAX_PROJECT_DIRECTORY_LENGTH,
  createCarriedPromptStore,
  createSessionStore,
  projectDirectoryName,
  type SessionHandle,
} from '../../src/session/store.js';

const CWD = '/home/user/project';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'session-store-'));
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

function toolResult(id: string, toolUseId: string, content: unknown, ts: number): SessionEvent {
  return {
    v: SESSION_SCHEMA_VERSION,
    t: 'tool_result',
    ts,
    id,
    envelope: { toolUseId, content, isError: false },
  };
}

describe('the session store', () => {
  it('writes one JSON object per line and reads the same events back in order', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD });

    await store.append(handle, userMessage('m1', 'hello', 1));
    await store.append(handle, assistantMessage('m2', 'hi', 2));
    await store.append(handle, toolResult('m3', 'toolu_1', 'the output', 3));

    const raw = readFileSync(handle.path, 'utf8');
    const lines = raw.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    expect(lines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(['m1', 'm2', 'm3']);

    const events = await collect(store.read(handle));
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.id)).toEqual(['m1', 'm2', 'm3']);
    expect(events[0]).toEqual(userMessage('m1', 'hello', 1));
    expect(events[2]).toEqual(toolResult('m3', 'toolu_1', 'the output', 3));
  });

  it('keeps the transcript under <configDir>/projects/<encoded-cwd>/<sessionId>.jsonl', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD, sessionId: 'session-01' });

    const expected = path.join(
      configDir,
      'projects',
      projectDirectoryName(CWD),
      'session-01.jsonl',
    );
    expect(handle.path).toBe(expected);
    expect(handle.sessionId).toBe('session-01');
    expect(existsSync(expected)).toBe(true);
  });

  it('derives the project directory name from the working directory path', () => {
    expect(projectDirectoryName('/home/user/project')).toBe('-home-user-project');
    expect(projectDirectoryName('/')).toBe('-');
  });

  it('truncates a long project directory name and appends a hash of the full path', () => {
    const first = `/very/${'a'.repeat(400)}`;
    const second = `/very/${'b'.repeat(400)}`;

    const name = projectDirectoryName(first);
    expect(name.length).toBeLessThanOrEqual(MAX_PROJECT_DIRECTORY_LENGTH);
    expect(name).not.toBe(projectDirectoryName(second));

    // The hash is of the **full** path, so two long paths that share a prefix
    // still get different names.
    expect(name).not.toBe(projectDirectoryName(`/very/${'a'.repeat(399)}b`));
  });

  it('discards a torn final line and keeps the records before it', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD });

    await store.append(handle, userMessage('m1', 'hello', 1));
    // A process killed mid-append leaves a partial line.
    appendFileSync(handle.path, '{"v":1,"t":"assistant_message","ts":2,"id":"m2","te', 'utf8');

    const events = await collect(store.read(handle));
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('m1');
  });

  it('keeps a final record that is complete but carries no trailing newline', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD });

    await store.append(handle, userMessage('m1', 'hello', 1));
    appendFileSync(
      handle.path,
      '{"v":1,"t":"assistant_message","ts":2,"id":"m2","text":"hi"}',
      'utf8',
    );

    const events = await collect(store.read(handle));
    expect(events.map((event) => event.id)).toEqual(['m1', 'm2']);
  });

  it('refuses a record whose version it does not know, and names both versions', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD });

    writeFileSync(
      handle.path,
      '{"v":2,"t":"user_message","ts":1,"id":"m1","text":"hello"}\n',
      'utf8',
    );

    const failure = await collect(store.read(handle)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SessionVersionError);
    const versionError = failure as SessionVersionError;
    expect(versionError.found).toBe(2);
    expect(versionError.supported).toBe(SESSION_SCHEMA_VERSION);
    expect(versionError.message).toContain('2');
    expect(versionError.message).toContain(String(SESSION_SCHEMA_VERSION));

    // The record is **refused**, not dropped: the read raises instead of
    // yielding an empty list.
    expect(versionError).toBeInstanceOf(Error);
  });

  it('sees a format change per record, not only on the first one', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });
    const handle = await store.create({ cwd: CWD });

    writeFileSync(
      handle.path,
      [
        '{"v":1,"t":"user_message","ts":1,"id":"m1","text":"hello"}',
        '{"v":3,"t":"assistant_message","ts":2,"id":"m2","text":"hi"}',
        '',
      ].join('\n'),
      'utf8',
    );

    const failure = await collect(store.read(handle)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SessionVersionError);
    expect((failure as SessionVersionError).found).toBe(3);
  });

  it('stores an oversized tool result as a stub plus a content-replacement entry', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir, maxToolResultBytes: 128 });
    const handle = await store.create({ cwd: CWD });

    const payload = 'x'.repeat(4096);
    await store.append(
      handle,
      toolResult('r1', 'toolu_1', payload, 1),
    );

    const raw = readFileSync(handle.path, 'utf8');
    expect(raw).not.toContain(payload);

    const events = await collect(store.read(handle));
    expect(events).toHaveLength(2);

    const stored = events[0];
    expect(stored?.t).toBe('tool_result');
    if (stored?.t !== 'tool_result') throw new Error('expected a tool_result record');
    const content = stored.envelope.content as { type?: string; originalBytes?: number };
    expect(content.type).toBe('tool_result_stub');
    expect(content.originalBytes).toBeGreaterThan(4096);

    const replacement = events[1];
    expect(replacement?.t).toBe('content_replacement');
    if (replacement?.t !== 'content_replacement') throw new Error('expected a content_replacement record');
    expect(replacement.targetId).toBe('r1');
  });

  it('keeps a tool result that is under the limit verbatim', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir, maxToolResultBytes: 4096 });
    const handle = await store.create({ cwd: CWD });

    await store.append(handle, toolResult('r1', 'toolu_1', 'small', 1));

    const events = await collect(store.read(handle));
    expect(events).toHaveLength(1);
    if (events[0]?.t !== 'tool_result') throw new Error('expected a tool_result record');
    expect(events[0].envelope.content).toBe('small');
  });

  it('treats a caller-supplied session id as data, never as an inherited member', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });

    const handle = await store.create({ cwd: CWD, sessionId: 'constructor' });
    expect(handle.sessionId).toBe('constructor');
    expect(handle.path.endsWith(path.join('projects', projectDirectoryName(CWD), 'constructor.jsonl'))).toBe(true);

    const summaries = await store.list({ cwd: CWD });
    expect(summaries.map((summary) => summary.sessionId)).toEqual(['constructor']);
  });

  it('refuses a session id that would escape the project directory', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });

    await expect(store.create({ cwd: CWD, sessionId: '../escape' })).rejects.toThrow();
    await expect(store.create({ cwd: CWD, sessionId: 'nested/id' })).rejects.toThrow();
    await expect(store.create({ cwd: CWD, sessionId: '' })).rejects.toThrow();
  });

  it('lists the sessions of a working directory, newest first', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const store = createSessionStore({ configDir });

    const older = await store.create({ cwd: CWD, sessionId: 'older' });
    await store.append(older, userMessage('m1', 'hello', 1000));
    const newer = await store.create({ cwd: CWD, sessionId: 'newer' });
    await store.append(newer, userMessage('m1', 'hello', 2000));

    const summaries = await store.list({ cwd: CWD });
    expect(summaries.map((summary) => summary.sessionId)).toEqual(['newer', 'older']);
    expect(summaries[0]?.messageCount).toBe(1);
    expect(summaries[0]?.startedAt).toBe(2000);
    expect(summaries[0]?.updatedAt).toBe(2000);

    const limited = await store.list({ cwd: CWD, limit: 1 });
    expect(limited.map((summary) => summary.sessionId)).toEqual(['newer']);
  });
});

describe('the carried prompts', () => {
  it('returns a prompt that is bound to the same session, fresh, and undelivered', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const prompts = createCarriedPromptStore({ configDir, maxAgeMs: 60_000, now: () => 10_000 });

    await prompts.put({ id: 'p1', sessionId: 's1', prompt: 'carry me', createdAt: 9_500 });

    const taken = await prompts.take({ id: 'p1', sessionId: 's1', now: 10_000 });
    expect(taken.outcome).toBe('bound');
    expect(taken.prompt?.prompt).toBe('carry me');
    expect(taken.telemetry).toBe(CARRIED_PROMPT_TELEMETRY_EVENT);
    expect(taken.telemetry).toBe('tengu_carried_prompts_taken');
  });

  it('reports every outcome of the vocabulary', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const prompts = createCarriedPromptStore({ configDir, maxAgeMs: 1_000, now: () => 10_000 });

    await prompts.put({ id: 'other-session', sessionId: 's2', prompt: 'x', createdAt: 9_500 });
    await prompts.put({ id: 'job', sessionId: 's1', prompt: 'x', createdAt: 9_500, jobHasRun: true });
    await prompts.put({ id: 'old', sessionId: 's1', prompt: 'x', createdAt: 1_000 });
    await prompts.put({ id: 'future', sessionId: 's1', prompt: 'x', createdAt: 20_000 });
    await prompts.put({ id: 'delivered', sessionId: 's1', prompt: 'x', createdAt: 9_500, perhapsDelivered: true });
    await prompts.put({ id: 'altered', sessionId: 's1', prompt: 'x', createdAt: 9_500, altered: true });

    const outcomes = new Map<string, string>();
    for (const id of ['absent', 'other-session', 'job', 'old', 'future', 'delivered', 'altered']) {
      const taken = await prompts.take({ id, sessionId: 's1', now: 10_000 });
      outcomes.set(id, taken.outcome);
    }

    expect(outcomes.get('absent')).toBe('no_row');
    expect(outcomes.get('other-session')).toBe('no_row');
    expect(outcomes.get('job')).toBe('job_has_run');
    expect(outcomes.get('old')).toBe('too_old');
    expect(outcomes.get('future')).toBe('future_dated');
    expect(outcomes.get('delivered')).toBe('sent');
    expect(outcomes.get('altered')).toBe('altered');
  });

  it('does not deliver a prompt twice', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const prompts = createCarriedPromptStore({ configDir, maxAgeMs: 60_000, now: () => 10_000 });

    await prompts.put({ id: 'p1', sessionId: 's1', prompt: 'once', createdAt: 9_500 });

    const first = await prompts.take({ id: 'p1', sessionId: 's1', now: 10_000 });
    expect(first.outcome).toBe('bound');

    const second = await prompts.take({ id: 'p1', sessionId: 's1', now: 10_000 });
    expect(second.outcome).toBe('sent');
    expect(second.prompt).toBeUndefined();
  });

  it('emits the target\'s telemetry event with the outcome', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const events: { name: string; outcome: string; id: string }[] = [];
    const prompts = createCarriedPromptStore({
      configDir,
      maxAgeMs: 60_000,
      now: () => 10_000,
      onTelemetry: (event) => events.push({ ...event }),
    });

    await prompts.put({ id: 'p1', sessionId: 's1', prompt: 'carry me', createdAt: 9_500 });
    await prompts.take({ id: 'p1', sessionId: 's1', now: 10_000 });
    await prompts.take({ id: 'absent', sessionId: 's1', now: 10_000 });

    expect(events).toHaveLength(2);
    expect(events[0]?.name).toBe('tengu_carried_prompts_taken');
    expect(events[0]?.outcome).toBe('bound');
    expect(events[1]?.outcome).toBe('no_row');
  });

  it('keeps the carried prompts append-only', async () => {
    const configDir = path.join(makeRoot(), 'config');
    const prompts = createCarriedPromptStore({ configDir, maxAgeMs: 60_000, now: () => 10_000 });

    await prompts.put({ id: 'p1', sessionId: 's1', prompt: 'once', createdAt: 9_500 });
    await prompts.take({ id: 'p1', sessionId: 's1', now: 10_000 });

    const raw = readFileSync(path.join(configDir, 'carried-prompts.jsonl'), 'utf8');
    const lines = raw.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(2);

    const rows = await prompts.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deliveredAt).toBe(10_000);
  });
});
