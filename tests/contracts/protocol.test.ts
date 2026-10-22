/**
 * The contract test for the protocol surface.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` — the transport, the
 * three frame kinds, the error shape, the method vocabulary, the session
 * lifecycle, the capability record, the approvals and the stages.
 *
 * **The milestone:** `CC-043` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What is measured, and how
 *
 * The test speaks the protocol **over a real pipe**: the server is a **real
 * child process** (`tests/fixtures/protocol-server.ts`) that reads its stdin
 * and writes its stdout, and the client is the same module the server is
 * built from. Nothing here is two objects calling each other in memory, and
 * the frames on the wire are the frames the specification describes.
 *
 * The malformed cases are measured on the **raw** pipe: the test writes bytes
 * the client would never write — a line that is not JSON, a response with
 * neither a result nor an error, a response with both, a frame over the size
 * limit — and reads the bytes the server sends back.
 *
 * What it pins:
 *
 *   - the transport: newline-delimited JSON, one object per line, and the
 *     8 MiB limit;
 *   - the three frame kinds, and what makes a frame unusable;
 *   - the refusals: not JSON, neither result nor error, both, over the limit,
 *     an unknown method, an unknown protocol version — each refused with a
 *     reason, never ignored, never a crash;
 *   - the ordering: an answer carries the id of the request it answers, and
 *     the ids are never reused;
 *   - the session lifecycle: create, status, cancel, dispose, and the
 *     `session/disposed` refusal that follows a dispose;
 *   - the turn lifecycle: the turn id at once, the events as notifications,
 *     the failure that is loud, and the abort that still ends the turn;
 *   - the capability record: one shape asked of anything, and the degradation
 *     contract — `enabled: false` with a reason that names what is missing;
 *   - the approvals: the attribution, the dropped answer, and the final
 *     denial;
 *   - the honest-report rule: every method answers with a result, an error
 *     with a reason, or a capability that is not enabled with a reason.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_FRAME_BYTES,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_METHODS,
  capabilityRecord,
  createDefaultCapabilityRegistry,
  createProtocolClient,
  createProtocolServer,
  encodeFrame,
  isReportableReason,
  readFrame,
  type ApprovalRequest,
  type CapabilityRecord,
  type PeerDiagnostic,
  type ProtocolClient,
} from '../../src/protocol/index.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const CHILD = path.join(FIXTURES, 'protocol-child.mjs');

/* -------------------------------------------------------------------------- */
/* The harness                                                                */
/* -------------------------------------------------------------------------- */

/** A waiter for one notification. */
interface NotificationWaiter {
  readonly method: string;
  readonly match: (params: unknown) => boolean;
  readonly resolve: (params: unknown) => void;
}

/** The notifications a client received, and the waiters for the ones it has not. */
class Notifications {
  readonly seen: Array<{ method: string; params: unknown }> = [];
  private readonly waiters: NotificationWaiter[] = [];

  handle = (method: string, params: unknown): void => {
    this.seen.push({ method, params });
    for (const waiter of [...this.waiters]) {
      if (waiter.method !== method) continue;
      if (!waiter.match(params)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(params);
    }
  };

  wait(
    method: string,
    match: (params: unknown) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<unknown> {
    const already = this.seen.find(
      (entry) => entry.method === method && match(entry.params),
    );
    if (already) return Promise.resolve(already.params);
    return new Promise<unknown>((resolve, reject) => {
      const waiter: NotificationWaiter = { method, match, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`the notification "${method}" did not arrive within ${timeoutMs} ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  count(method: string): number {
    return this.seen.filter((entry) => entry.method === method).length;
  }
}

/** The child process, the client over its pipes, and what they have seen. */
interface Harness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly client: ProtocolClient;
  readonly notifications: Notifications;
  readonly diagnostics: PeerDiagnostic[];
  readonly approvalRequests: ApprovalRequest[];
  stop(): void;
}

/** Start the test server as a real child process, and speak to it. */
function startHarness(): Harness {
  const child = spawn(process.execPath, [CHILD], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  const notifications = new Notifications();
  const diagnostics: PeerDiagnostic[] = [];
  const approvalRequests: ApprovalRequest[] = [];

  const client = createProtocolClient({
    input: child.stdout,
    output: child.stdin,
    identity: 'the-editor',
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    onApprovalRequest: (request) => {
      approvalRequests.push(request);
    },
    requestTimeoutMs: 5_000,
  });

  for (const method of [
    'event/message',
    'event/tool',
    'event/stage',
    'event/diagnostic',
    'turn/failed',
  ]) {
    client.onNotification(method, (params) => notifications.handle(method, params));
  }

  return {
    child,
    client,
    notifications,
    diagnostics,
    approvalRequests,
    stop(): void {
      client.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

/** The raw pipe: the child's bytes, with no client in between. */
interface RawHarness {
  readonly child: ChildProcessWithoutNullStreams;
  write(line: string): void;
  readLine(timeoutMs?: number): Promise<string>;
  stop(): void;
}

/** Start the test server and talk to it in raw bytes. */
function startRaw(): RawHarness {
  const child = spawn(process.execPath, [CHILD], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  const lines: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(line);
        else lines.push(line);
      }
      newline = buffer.indexOf('\n');
    }
  });

  return {
    child,
    write(line: string): void {
      child.stdin.write(line);
    },
    readLine(timeoutMs = 5_000): Promise<string> {
      const ready = lines.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise<string>((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`no line arrived within ${timeoutMs} ms`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
    },
    stop(): void {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

/** The children that are running, so that every test leaves none behind. */
const running: Array<{ stop(): void }> = [];

afterEach(() => {
  while (running.length > 0) running.pop()?.stop();
});

/** Start a harness and remember to stop it. */
function harness(): Harness {
  const started = startHarness();
  running.push(started);
  return started;
}

/** Start a raw harness and remember to stop it. */
function raw(): RawHarness {
  const started = startRaw();
  running.push(started);
  return started;
}

/** Whether a value is the capability record's shape. */
function isCapabilityRecord(value: unknown): value is CapabilityRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'enabled' in value &&
    'unsupported' in value
  );
}

/** The record a member of a value carries. */
function member(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/* -------------------------------------------------------------------------- */
/* The exchange, over a real pipe                                              */
/* -------------------------------------------------------------------------- */

describe('the protocol surface over a real pipe', () => {
  it('a test client and a test server talk to each other over a real pipe', async () => {
    const { client, child } = harness();
    // The server is a real process, and the pipe is a real pipe.
    expect(typeof child.pid).toBe('number');
    expect(child.pid).toBeGreaterThan(0);

    const created = await client.request<{
      sessionId: string;
      state: string;
      capabilities: Record<string, CapabilityRecord>;
    }>('session/create', { client: 'the-editor' });

    expect(created.sessionId).toMatch(/^session_/);
    expect(created.state).toBe('active');
    // The capability record for everything this agent can do, at once.
    expect(created.capabilities['protocol']?.enabled).toBe(true);
    expect(created.capabilities['protocol']?.unsupported).toBeNull();
  });

  it('an answer carries the id of the request it answers', async () => {
    const pipe = raw();
    pipe.write(
      `${JSON.stringify({
        v: '1',
        id: 4242,
        method: 'capability/describe',
        params: { capability: 'protocol' },
      })}\n`,
    );
    const line = await pipe.readLine();
    const frame = JSON.parse(line) as Record<string, unknown>;
    expect(frame['id']).toBe(4242);
    expect(frame['v']).toBe('1');
    expect(member(frame['result'], 'enabled')).toBe(true);
    expect(frame['error']).toBeUndefined();
  });

  it('the ids are never reused within a session', async () => {
    const { client } = harness();
    for (let index = 0; index < 6; index += 1) {
      await client.request('capability/describe', { capability: 'protocol' });
    }
    const ids = client.sentRequestIds.filter((id): id is number => typeof id === 'number');
    expect(ids.length).toBe(6);
    expect(new Set(ids).size).toBe(ids.length);
    // Strictly increasing: an id is never handed out twice, and never goes
    // backwards.
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]).toBeGreaterThan(ids[index - 1] as number);
    }
  });

  it('two requests in flight are answered with their own answers', async () => {
    const { client } = harness();
    const [protocol, session] = await Promise.all([
      client.request<CapabilityRecord>('capability/describe', { capability: 'protocol' }),
      client.request<CapabilityRecord>('capability/describe', { capability: 'session' }),
    ]);
    expect(protocol.enabled).toBe(true);
    expect(session.enabled).toBe(true);
  });

  it('a turn returns its id at once, and its events arrive as notifications', async () => {
    const { client, notifications } = harness();
    const created = await client.request<{ sessionId: string }>('session/create', {});
    const started = await client.request<{ turnId: string }>('turn/start', {
      sessionId: created.sessionId,
      prompt: 'hello',
    });
    expect(started.turnId).toMatch(/^turn_/);

    const ended = (await notifications.wait(
      'event/message',
      (params) => member(params, 'state') === 'completed',
    )) as Record<string, unknown>;
    expect(ended['turnId']).toBe(started.turnId);
    // The turn's progress arrived as notifications, and the turn's end is one
    // of them, carrying the final state.
    expect(notifications.count('event/message')).toBeGreaterThanOrEqual(1);
  });

  it('a stage that cannot run says so, in the shared shape', async () => {
    const { client, notifications } = harness();
    const created = await client.request<{ sessionId: string }>('session/create', {});
    await client.request<{ turnId: string }>('turn/start', {
      sessionId: created.sessionId,
      prompt: 'hello',
    });

    const advanced = (await notifications.wait(
      'event/stage',
      (params) => member(params, 'stageId') === 'build',
    )) as Record<string, unknown>;
    expect(advanced['state']).toBe('running');
    expect(advanced['enabled']).toBe(true);
    expect(advanced['unsupported']).toBeNull();

    const refused = (await notifications.wait(
      'event/stage',
      (params) => member(params, 'stageId') === 'ship',
    )) as Record<string, unknown>;
    // The stage that cannot run carries the shared pair, and the reason
    // names what is missing.
    expect(refused['enabled']).toBe(false);
    expect(isReportableReason(refused['unsupported'])).toBe(true);
  });

  it('a turn that fails fails loudly, and is not retried', async () => {
    const { client, notifications } = harness();
    const created = await client.request<{ sessionId: string }>('session/create', {});
    const started = await client.request<{ turnId: string }>('turn/start', {
      sessionId: created.sessionId,
      prompt: 'unavailable',
    });

    const failed = (await notifications.wait(
      'turn/failed',
      (params) => member(params, 'turnId') === started.turnId,
    )) as Record<string, unknown>;
    expect(failed['code']).toBe('model/unavailable');
    expect(typeof failed['message']).toBe('string');

    // The turn failed and nothing else was tried: no second turn, and no
    // silent fallback to another model.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(notifications.count('turn/failed')).toBe(1);
    expect(notifications.count('event/message')).toBe(0);
  });

  it('an aborted turn still ends, with the state it reached', async () => {
    const { client, notifications } = harness();
    const created = await client.request<{ sessionId: string }>('session/create', {});
    const started = await client.request<{ turnId: string }>('turn/start', {
      sessionId: created.sessionId,
      prompt: 'hold',
    });
    const aborted = await client.request<{ turnId: string; state: string }>('turn/abort', {
      sessionId: created.sessionId,
      turnId: started.turnId,
    });
    expect(aborted.turnId).toBe(started.turnId);
    expect(aborted.state).toBe('aborted');

    const ended = (await notifications.wait(
      'event/message',
      (params) => member(params, 'turnId') === started.turnId,
    )) as Record<string, unknown>;
    expect(ended['state']).toBe('aborted');

    // The session is idle again: the turn ended, and the session did not.
    const status = await client.request<{ state: string }>('session/status', {
      sessionId: created.sessionId,
    });
    expect(status.state).toBe('idle');
  });

  it('the two sides are peers: each direction allocates its own ids', async () => {
    const pipe = raw();
    // The client's request carries the id 1.
    pipe.write(
      `${JSON.stringify({
        v: '1',
        id: 1,
        method: 'tool/call',
        params: { name: 'write', arguments: { path: '/tmp/x' } },
      })}\n`,
    );

    // The server's own request — the approval — carries the id 1 as well,
    // and the two are told apart by their kind, not by their number.
    const asked = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(asked['method']).toBe('approval/request');
    expect(asked['id']).toBe(1);
    const askedParams = asked['params'] as Record<string, unknown>;
    expect(askedParams['requestId']).toBe('approval_1');
    expect(askedParams['tool']).toBe('write');
    expect(typeof askedParams['reason']).toBe('string');

    pipe.write(
      `${JSON.stringify({
        v: '1',
        id: 1,
        method: 'approval/answer',
        params: { requestId: 'approval_1', decision: 'allow' },
      })}\n`,
    );

    // Both answers carry the id of the request they answer, and neither
    // disturbs the other.
    const first = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(first['id']).toBe(1);
    expect(member(first['result'], 'answerer')).toBe('the-editor');

    const second = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(second['id']).toBe(1);
    expect(member(second['result'], 'content')).toBe('the file was written');
  });

  it('a disposed session refuses every later call', async () => {
    const { client } = harness();
    const created = await client.request<{ sessionId: string }>('session/create', {});
    const disposed = await client.request<{ state: string }>('session/dispose', {
      sessionId: created.sessionId,
    });
    expect(disposed.state).toBe('disposed');

    await expect(
      client.request('session/status', { sessionId: created.sessionId }),
    ).rejects.toMatchObject({ code: PROTOCOL_ERROR_CODES.sessionDisposed });
    await expect(
      client.request('turn/start', { sessionId: created.sessionId, prompt: 'hello' }),
    ).rejects.toMatchObject({ code: PROTOCOL_ERROR_CODES.sessionDisposed });
  });
});

/* -------------------------------------------------------------------------- */
/* The refusals                                                                */
/* -------------------------------------------------------------------------- */

describe('the malformed cases are refused with a reason', () => {
  it('a frame that is not JSON is refused, and the connection survives', async () => {
    const pipe = raw();
    pipe.write('this is not json at all\n');

    const line = await pipe.readLine();
    const frame = JSON.parse(line) as Record<string, unknown>;
    expect(frame['method']).toBe('event/diagnostic');
    const params = frame['params'] as Record<string, unknown>;
    expect(params['code']).toBe(PROTOCOL_ERROR_CODES.frameMalformed);
    expect(typeof params['message']).toBe('string');

    // The refusal was not a crash: the server is still serving.
    pipe.write(
      `${JSON.stringify({
        v: '1',
        id: 1,
        method: 'capability/describe',
        params: { capability: 'protocol' },
      })}\n`,
    );
    const answer = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(answer['id']).toBe(1);
    expect(member(answer['result'], 'enabled')).toBe(true);
  });

  it('a response with neither a result nor an error is refused', async () => {
    const pipe = raw();
    pipe.write(`${JSON.stringify({ v: '1', id: 7001 })}\n`);

    const frame = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(frame['id']).toBe(7001);
    const error = frame['error'] as Record<string, unknown>;
    expect(error['code']).toBe(PROTOCOL_ERROR_CODES.frameMalformed);
    expect(typeof error['message']).toBe('string');
    expect(frame['result']).toBeUndefined();
  });

  it('a response with both a result and an error is refused', async () => {
    const pipe = raw();
    pipe.write(
      `${JSON.stringify({ v: '1', id: 7002, result: { ok: true }, error: { code: 'x', message: 'y' } })}\n`,
    );

    const frame = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(frame['id']).toBe(7002);
    const error = frame['error'] as Record<string, unknown>;
    expect(error['code']).toBe(PROTOCOL_ERROR_CODES.frameMalformed);
    expect(frame['result']).toBeUndefined();
  });

  it('a frame over the size limit is refused rather than truncated', async () => {
    const pipe = raw();
    // One byte over the limit, on the wire.
    const oversized = JSON.stringify({
      v: '1',
      id: 1,
      method: 'capability/describe',
      params: { capability: 'protocol', padding: 'x'.repeat(MAX_FRAME_BYTES) },
    });
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(MAX_FRAME_BYTES);
    pipe.write(`${oversized}\n`);

    const frame = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(frame['method']).toBe('event/diagnostic');
    const params = frame['params'] as Record<string, unknown>;
    expect(params['code']).toBe(PROTOCOL_ERROR_CODES.frameTooLarge);

    // The connection survived the refusal.
    pipe.write(
      `${JSON.stringify({
        v: '1',
        id: 2,
        method: 'capability/describe',
        params: { capability: 'protocol' },
      })}\n`,
    );
    const answer = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(answer['id']).toBe(2);
  });

  it('a client refuses to put a frame over the size limit on the wire', async () => {
    const { client } = harness();
    await expect(
      client.request('capability/describe', {
        capability: 'protocol',
        padding: 'x'.repeat(MAX_FRAME_BYTES),
      }),
    ).rejects.toMatchObject({ code: PROTOCOL_ERROR_CODES.frameTooLarge });
  });

  it('an unknown method is refused with a reason', async () => {
    const pipe = raw();
    pipe.write(
      `${JSON.stringify({ v: '1', id: 8001, method: 'nonsense/method', params: {} })}\n`,
    );

    const frame = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(frame['id']).toBe(8001);
    const error = frame['error'] as Record<string, unknown>;
    expect(error['code']).toBe(PROTOCOL_ERROR_CODES.methodUnknown);
  });

  it('a client refuses to call a method that is not of the vocabulary', async () => {
    const { client } = harness();
    await expect(client.request('nonsense/method', {})).rejects.toThrow(
      /not a method of this protocol/,
    );
  });

  it('a notification-only method is refused when it is called', async () => {
    const pipe = raw();
    pipe.write(
      `${JSON.stringify({ v: '1', id: 8002, method: 'event/message', params: {} })}\n`,
    );

    const frame = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(frame['id']).toBe(8002);
    const error = frame['error'] as Record<string, unknown>;
    expect(error['code']).toBe(PROTOCOL_ERROR_CODES.methodNotificationOnly);
  });

  it('a method named after a prototype member is refused, not obeyed', async () => {
    const pipe = raw();
    pipe.write(`${JSON.stringify({ v: '1', id: 8100, method: '__proto__', params: {} })}\n`);

    const frame = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(frame['id']).toBe(8100);
    const error = frame['error'] as Record<string, unknown>;
    expect(error['code']).toBe(PROTOCOL_ERROR_CODES.methodUnknown);
  });

  it('an unknown protocol version is refused with the versions this build speaks', async () => {
    const pipe = raw();
    pipe.write(
      `${JSON.stringify({ v: '99', id: 9001, method: 'capability/describe', params: {} })}\n`,
    );

    const frame = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    expect(frame['id']).toBe(9001);
    const error = frame['error'] as Record<string, unknown>;
    expect(error['code']).toBe(PROTOCOL_ERROR_CODES.protocolUnsupported);
    const data = error['data'] as Record<string, unknown>;
    expect(data['supported']).toEqual(['1']);
  });

  it('a frame with no version at all is refused as malformed', async () => {
    const pipe = raw();
    pipe.write(`${JSON.stringify({ id: 9002, method: 'capability/describe' })}\n`);

    const frame = JSON.parse(await pipe.readLine()) as Record<string, unknown>;
    const error = frame['error'] as Record<string, unknown>;
    expect(error['code']).toBe(PROTOCOL_ERROR_CODES.frameMalformed);
  });
});

/* -------------------------------------------------------------------------- */
/* The capability record                                                       */
/* -------------------------------------------------------------------------- */

describe('the capability record', () => {
  it('one shape is asked of anything', async () => {
    const { client } = harness();
    for (const name of ['protocol', 'session', 'turn', 'tool', 'model', 'sandbox']) {
      const record = await client.request<CapabilityRecord>('capability/describe', {
        capability: name,
      });
      expect(typeof record.enabled).toBe('boolean');
      expect(record.unsupported === null || typeof record.unsupported === 'string').toBe(true);
      if (record.enabled) {
        expect(record.unsupported).toBeNull();
      } else {
        expect(isReportableReason(record.unsupported)).toBe(true);
      }
    }
  });

  it('a capability that cannot run names what is missing', async () => {
    const { client } = harness();
    const record = await client.request<CapabilityRecord>('capability/describe', {
      capability: 'computer-use',
    });
    expect(record.enabled).toBe(false);
    // A sentence that names what is missing — never empty, never a
    // placeholder.
    expect(isReportableReason(record.unsupported)).toBe(true);
    expect((record.unsupported as string).split(/\s+/).length).toBeGreaterThanOrEqual(2);
  });

  it('a capability nobody has is refused with a reason', async () => {
    const { client } = harness();
    await expect(
      client.request('capability/describe', { capability: 'no-such-capability' }),
    ).rejects.toMatchObject({ code: PROTOCOL_ERROR_CODES.capabilityUnknown });
  });

  it('a method whose capability is not enabled reports the record, not a success', async () => {
    const { client } = harness();
    // The test server has no model backend, so the `model` area is off.
    const answer = await client.request<CapabilityRecord>('model/list', {});
    expect(answer.enabled).toBe(false);
    expect(isReportableReason(answer.unsupported)).toBe(true);
  });

  it('the default registry reports every capability in the same shape', () => {
    const registry = createDefaultCapabilityRegistry();
    for (const name of registry.names()) {
      const record = registry.get(name);
      expect(record).toBeDefined();
      if (!record) continue;
      if (record.enabled) {
        expect(record.unsupported).toBeNull();
      } else {
        expect(isReportableReason(record.unsupported)).toBe(true);
      }
    }
  });

  it('a record that breaks the contract cannot be built', () => {
    expect(() => capabilityRecord(false, '')).toThrow();
    expect(() => capabilityRecord(false, 'unknown')).toThrow();
    expect(() => capabilityRecord(false, 'nope')).toThrow();
    expect(() => capabilityRecord(true, 'a reason that should not be there')).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* The approvals                                                               */
/* -------------------------------------------------------------------------- */

describe('the approvals', () => {
  it('an answer is attributed to the peer that gave it', async () => {
    const { client, approvalRequests } = harness();
    const created = await client.request<{ sessionId: string }>('session/create', {
      client: 'the-editor',
    });
    expect(created.sessionId).toBeTruthy();

    const call = client.request<{ content: string; answerer: string }>('tool/call', {
      name: 'write',
      arguments: { path: '/tmp/x' },
    });

    const request = await waitForApproval(approvalRequests);
    expect(request.tool).toBe('write');
    expect(request.reason).toBeTruthy();
    expect(request.requestId).toBeTruthy();

    const answer = await client.answerApproval(request.requestId, 'allow');
    // The answerer is the peer that gave the answer — the client, and not
    // the user it answered for.
    expect(answer.answerer).toBe('the-editor');
    expect(answer.decision).toBe('allow');

    const result = await call;
    expect(result.content).toBe('the file was written');
    expect(result.answerer).toBe('the-editor');
  });

  it('an answer for an unknown request id is dropped and reported', async () => {
    const { client } = harness();
    await expect(client.answerApproval('no-such-request', 'allow')).rejects.toMatchObject({
      code: PROTOCOL_ERROR_CODES.approvalUnknown,
    });
  });

  it('a denial is final', async () => {
    const { client, approvalRequests } = harness();
    const call = client.request('tool/call', { name: 'write', arguments: {} });
    const request = await waitForApproval(approvalRequests);
    const answer = await client.answerApproval(request.requestId, 'deny');
    expect(answer.decision).toBe('deny');

    await expect(call).rejects.toMatchObject({ code: PROTOCOL_ERROR_CODES.approvalDenied });

    // The denial is not re-opened: a second answer for the same request is
    // refused, and the decision stands.
    await expect(client.answerApproval(request.requestId, 'allow')).rejects.toMatchObject({
      code: PROTOCOL_ERROR_CODES.approvalDecided,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The honest-report rule                                                      */
/* -------------------------------------------------------------------------- */

describe('a method answers with a result, an error, or a capability that is not enabled', () => {
  it('every method of the vocabulary answers in one of the three ways', async () => {
    const { client } = harness();
    const created = await client.request<{ sessionId: string }>('session/create', {});
    const sessionId = created.sessionId;

    const calls: Array<{ method: string; params: unknown }> = [
      { method: 'session/status', params: { sessionId } },
      { method: 'session/cancel', params: { sessionId } },
      { method: 'turn/start', params: { sessionId, prompt: 'hello' } },
      { method: 'turn/abort', params: { sessionId, turnId: 'turn_1' } },
      { method: 'tool/list', params: {} },
      { method: 'tool/describe', params: { name: 'write' } },
      { method: 'model/list', params: {} },
      { method: 'model/describe', params: { model: 'some-model' } },
      { method: 'model/select', params: { model: 'some-model' } },
      { method: 'approval/pending', params: {} },
      { method: 'capability/describe', params: { capability: 'protocol' } },
    ];

    for (const call of calls) {
      let answered: 'result' | 'error' = 'error';
      let value: unknown;
      try {
        value = await client.request(call.method, call.params);
        answered = 'result';
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        // An error always carries a stable code and a reason.
        expect(typeof code).toBe('string');
        expect((error as Error).message.length).toBeGreaterThan(0);
      }
      expect(['result', 'error']).toContain(answered);
      if (answered === 'result') {
        expect(value).not.toBeUndefined();
        if (isCapabilityRecord(value) && !value.enabled) {
          // The third way: the capability is not enabled, and it says why.
          expect(isReportableReason(value.unsupported)).toBe(true);
        }
      }
    }
  });

  it('the methods of the vocabulary are the ones the specification names', () => {
    for (const method of [
      'session/create',
      'session/status',
      'session/cancel',
      'session/dispose',
      'turn/start',
      'turn/abort',
      'tool/list',
      'tool/describe',
      'tool/call',
      'model/list',
      'model/describe',
      'model/select',
      'approval/request',
      'approval/answer',
      'approval/pending',
      'capability/describe',
      'event/message',
      'event/tool',
      'event/stage',
      'event/diagnostic',
    ]) {
      expect(PROTOCOL_METHODS).toContain(method);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The transport, in the open                                                  */
/* -------------------------------------------------------------------------- */

describe('the transport', () => {
  it('a frame is one JSON object per line, and the line is terminated', () => {
    const line = encodeFrame({ v: '1', id: 1, method: 'capability/describe' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({ v: '1', id: 1, method: 'capability/describe' });
  });

  it('the size limit is eight mebibytes', () => {
    expect(MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
  });

  it('the three frame kinds are told apart by their members', () => {
    const request = readFrame({ v: '1', id: 1, method: 'turn/start' });
    expect(request.ok).toBe(true);
    if (request.ok) expect(request.parsed.kind).toBe('request');

    const response = readFrame({ v: '1', id: 1, result: { ok: true } });
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.parsed.kind).toBe('response');

    const notification = readFrame({ v: '1', method: 'event/message' });
    expect(notification.ok).toBe(true);
    if (notification.ok) expect(notification.parsed.kind).toBe('notification');
  });

  it('a frame that breaks the rules of the frame is refused', () => {
    for (const frame of [
      'not an object',
      { v: '1', id: 1, result: {}, error: { code: 'x', message: 'y' } },
      { v: '1', id: 1 },
      { v: '1' },
      { id: 1, method: 'turn/start' },
    ]) {
      const read = readFrame(frame);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error.code).toBe(PROTOCOL_ERROR_CODES.frameMalformed);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The server, in the open                                                     */
/* -------------------------------------------------------------------------- */

describe('the server', () => {
  it('a server with no turn runner reports the capability that is missing', () => {
    const registry = createDefaultCapabilityRegistry();
    expect(registry.get('turn')?.enabled).toBe(false);
    expect(isReportableReason(registry.get('turn')?.unsupported)).toBe(true);
    // The server owns the `turn` capability and follows the turn runner.
    const { input, output } = streams();
    const server = createProtocolServer({ input, output, capabilities: registry });
    expect(server.capabilities.get('turn')?.enabled).toBe(false);
    server.close();
  });

  it('a server with a turn runner enables the turn capability', () => {
    const { input, output } = streams();
    const server = createProtocolServer({
      input,
      output,
      turnHandler: async () => ({ state: 'completed' as const }),
    });
    expect(server.capabilities.get('turn')?.enabled).toBe(true);
    server.close();
  });
});

/** A pair of streams a server or a client can speak over. */
function streams(): { input: PassThrough; output: PassThrough } {
  return { input: new PassThrough(), output: new PassThrough() };
}

/** Wait for the approval the server asked about. */
async function waitForApproval(requests: ApprovalRequest[]): Promise<ApprovalRequest> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = requests[requests.length - 1];
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('no approval was asked for within 5000 ms');
}
