/**
 * Contract test for the provider transport, the retry loop and the SigV4 signer.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2 (Provider request
 * construction — the retry rule, the `x-should-retry` header, the default
 * `parseResponse` branch set and the non-enumerable `_request_id` /
 * `_workspace_id`) and §2.2a (the provider adapters' wire shapes — the SigV4
 * service names, the `host` replacement, the `connection` deletion and the
 * preserved multi-valued query parameters).
 *
 * What this test pins:
 *   - the **transport**: a request built by a driver becomes a `fetch` call
 *     with that driver's URL, headers and body; a streaming response becomes
 *     `ProviderEvent[]`; a non-streaming JSON response is parsed and carries the
 *     non-enumerable `_request_id` / `_workspace_id`; a `204` and a
 *     `content-length: 0` response carry **no** body and produce no events;
 *   - the **credential rule**: the transport *receives* a credential, never
 *     resolves one, and never lets a secret reach a URL, an error message, a
 *     thrown error or a parsed body;
 *   - the **timeout**: the request runs under an `AbortController` that is
 *     combined with the caller's own signal, a request that never answers is
 *     abandoned with a named timeout error, and the driver's own `x-amz-date`
 *     wins over the transport's clock;
 *   - the **retry loop**: the retryable statuses, the `x-should-retry` header in
 *     **both** directions, the `retry-after` delay (the seconds form, the
 *     HTTP-date form and the cap that is its own), the retry budget (the
 *     driver's, the transport's and the default), and the cached-token `401`
 *     that triggers a token refresh and one more attempt — the refresh
 *     spending the budget like any other attempt;
 *   - the **signer**: the AWS SigV4 **test-suite vectors** (`get-vanilla`,
 *     `get-space`, the repeated-parameter case, the header-value
 *     normalisation and the session token), the canonical request **string**,
 *     the `host` replacement, the `connection` deletion, the byte-for-byte
 *     preservation of multi-valued query parameters, the SDK's double
 *     encoding of the path, and the service name the **driver** wrote into
 *     `req.aws.service`;
 *   - the **token-acquisition seam**: a Vertex or Foundry request's
 *     `tokenScope` reaches the `acquireToken` callback, an acquired token
 *     travels as a **bearer** token, and the scope is read after the driver's
 *     header step.
 *
 * No test here reaches the network: the transport's `fetch` is injected.
 */

import { describe, expect, it } from 'vitest';

import {
  anthropicDriver,
  bedrockDriver,
  foundryDriver,
  mantleDriver,
  parseResponse,
  vertexDriver,
  type ProviderDriver,
} from '../../src/provider/drivers/index.js';
import type { ProviderEvent, ProviderRequest } from '../../src/provider/drivers/types.js';
import { retryDelayMs, sendProviderRequest, tokenAcquirerFor } from '../../src/provider/transport/index.js';
import {
  buildCanonicalRequest,
  buildSignedHeaders,
  canonicalQueryString,
  canonicalUriPath,
} from '../../src/provider/transport/sigv4.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'claude-sonnet-4-5',
    maxTokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    stream: false,
    ...overrides,
  };
}

/** One recorded `fetch` call. */
interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
}

/**
 * A `fetch` that records its calls and answers with the queued responses.
 *
 * The queued responses are consumed in order; a call with no queued response
 * left is a test bug and throws.
 */
function fakeFetch(responses: readonly Response[]): FakeFetch {
  const calls: FetchCall[] = [];
  let index = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: headerRecord(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error('the fake fetch ran out of queued responses');
    return response;
  };

  return { fetchImpl, calls };
}

/** The header bag of a `fetch` init, lowercased. */
function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers === undefined) return record;
  if (headers instanceof Headers) {
    for (const [key, value] of headers.entries()) record[key.toLowerCase()] = value;
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) record[key.toLowerCase()] = value;
    return record;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    record[key.toLowerCase()] = value;
  }
  return record;
}

/** A JSON response. */
function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** An SSE response. */
function sseResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
  });
}

/** A whole Anthropic message, as the non-streaming endpoint returns it. */
function messageBody(text = 'hello'): Record<string, unknown> {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 7, output_tokens: 3 },
  };
}

/** A whole Anthropic SSE stream. */
const SSE_BODY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"usage":{"input_tokens":7,"output_tokens":1}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

/**
 * One AWS eventstream frame.
 *
 * The framing is the AWS one: a total length, a headers length, a prelude
 * CRC, the headers, the payload and a message CRC. This implementation does not verify
 * the CRCs, so they are zero here.
 */
function eventstreamFrame(payload: string): Uint8Array {
  const body = Buffer.from(payload, 'utf8');
  const totalLength = 12 + body.length + 4;
  const frame = Buffer.alloc(totalLength);
  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt32BE(0, 4);
  frame.writeUInt32BE(0, 8);
  body.copy(frame, 12);
  frame.writeUInt32BE(0, totalLength - 4);
  return new Uint8Array(frame);
}

/* -------------------------------------------------------------------------- */
/* The transport                                                                 */
/* -------------------------------------------------------------------------- */

describe('the provider transport', () => {
  it('turns a driver-built request into a fetch call with the driver URL, headers and body', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);

    const result = await sendProviderRequest(
      { driver: anthropicDriver, fetchImpl },
      request({ model: 'claude-sonnet-4-5', maxTokens: 64 }),
      'sk-test-secret',
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call?.method).toBe('POST');
    expect(call?.headers['x-api-key']).toBe('sk-test-secret');
    expect(call?.headers['anthropic-version']).toBe('2023-06-01');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.headers['accept']).toBe('application/json');

    const body = JSON.parse(call?.body ?? '{}') as Record<string, unknown>;
    expect(body['model']).toBe('claude-sonnet-4-5');
    expect(body['max_tokens']).toBe(64);
    expect(body['stream']).toBe(false);
    expect(Array.isArray(body['messages'])).toBe(true);

    expect(result.status).toBe(200);
  });

  it('turns a streaming response into the events of the driver parseStream', async () => {
    const { fetchImpl } = fakeFetch([sseResponse(SSE_BODY)]);

    const result = await sendProviderRequest(
      { driver: anthropicDriver, fetchImpl },
      request({ stream: true }),
      'sk-test-secret',
    );

    expect(result.events.map((event) => event.type)).toEqual([
      'message_start',
      'text_delta',
      'message_stop',
    ]);
    const text = result.events.find((event) => event.type === 'text_delta');
    expect(text).toEqual({ type: 'text_delta', text: 'hello' });
  });

  it('produces the same events as the default parseResponse for a stream', async () => {
    const { fetchImpl } = fakeFetch([sseResponse(SSE_BODY)]);

    const result = await sendProviderRequest(
      { driver: anthropicDriver, fetchImpl },
      request({ stream: true }),
      'sk-test-secret',
    );

    // The default `parseResponse` is the SSE parser the driver's own
    // `parseStream` uses (audit §2.2), so the two must agree.
    const parsed = await parseResponse(new Response(SSE_BODY, { headers: { 'content-type': 'text/event-stream' } }), {
      stream: true,
    });
    const expected: ProviderEvent[] = [];
    for await (const event of parsed as AsyncIterable<ProviderEvent>) expected.push(event);

    expect(result.events).toEqual(expected);
  });

  it('decodes a binary Bedrock eventstream into the driver events', async () => {
    // The Bedrock frame's payload carries a `chunk` member holding the JSON
    // blob of the Anthropic event (audit §2.2a).
    const frame = eventstreamFrame(
      JSON.stringify({
        chunk: JSON.stringify({
          type: 'message_start',
          message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [] },
        }),
      }),
    );
    const { fetchImpl } = fakeFetch([
      new Response(frame, { headers: { 'content-type': 'application/vnd.amazon.eventstream' } }),
    ]);

    const result = await sendProviderRequest(
      { driver: bedrockDriver, fetchImpl, awsCredentials: AWS_CREDENTIALS },
      bedrockRequest({ stream: true }),
    );

    expect(result.events.map((event) => event.type)).toEqual(['message_start']);
  });

  it('parses a non-streaming JSON response and keeps the non-enumerable request and workspace ids', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(messageBody(), { headers: { 'request-id': 'req_abc', 'anthropic-workspace-id': 'ws_1' } }),
    ]);

    const result = await sendProviderRequest({ driver: anthropicDriver, fetchImpl }, request(), 'sk-test-secret');

    const body = result.body as Record<string, unknown>;
    expect(body).toBeDefined();
    expect(body['_request_id']).toBe('req_abc');
    expect(body['_workspace_id']).toBe('ws_1');
    // The two ids are **not** part of the message: a consumer that serialises
    // the body must not write them onto the wire.
    expect(Object.keys(body)).not.toContain('_request_id');
    expect(Object.keys(body)).not.toContain('_workspace_id');
    expect(Object.prototype.propertyIsEnumerable.call(body, '_request_id')).toBe(false);
    expect(Object.prototype.propertyIsEnumerable.call(body, '_workspace_id')).toBe(false);

    expect(result.requestId).toBe('req_abc');
    expect(result.events.map((event) => event.type)).toEqual(['message_start', 'text_delta', 'message_stop']);
  });

  it('never puts a secret in the URL or in an error message', async () => {
    const secret = 'sk-super-secret-value';
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse({ error: { message: 'invalid api key' } }, { status: 401 }),
    ]);

    const result = await sendProviderRequest({ driver: anthropicDriver, fetchImpl }, request(), secret);

    expect(calls[0]?.url).not.toContain(secret);
    const message = result.events.map((event) => (event.type === 'error' ? event.message : '')).join(' ');
    expect(message).not.toContain(secret);
    expect(JSON.stringify(result.events)).not.toContain(secret);
  });

  it('never puts a secret in the parsed body of a response', async () => {
    const secret = 'sk-super-secret-value';
    const { fetchImpl } = fakeFetch([jsonResponse(messageBody())]);

    const result = await sendProviderRequest({ driver: anthropicDriver, fetchImpl }, request(), secret);

    expect(result.body).toBeDefined();
    expect(JSON.stringify(result.body)).not.toContain(secret);
  });

  it('never puts a secret in a thrown error', async () => {
    const secret = 'sk-super-secret-value';

    // A transport-level failure: the driver built a URL that cannot be
    // parsed. The transport's own error names the URL — and the URL never
    // carries a credential, because the transport never puts one there.
    const brokenDriver: ProviderDriver = {
      ...bedrockDriver,
      buildUrl: () => 'not a url at all',
    };
    const { fetchImpl } = fakeFetch([jsonResponse(messageBody())]);

    const error = await sendProviderRequest(
      { driver: brokenDriver, fetchImpl, awsCredentials: AWS_CREDENTIALS },
      bedrockRequest(),
      secret,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('not a url at all');
    expect((error as Error).message).not.toContain(secret);
  });

  it('never resolves a credential of its own and never puts a secret in a URL', async () => {
    const previous = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-environment-secret';
    try {
      const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);
      await sendProviderRequest({ driver: anthropicDriver, fetchImpl }, request());
      const call = calls[0];
      expect(call?.headers['x-api-key']).toBeUndefined();
      expect(call?.url).not.toContain('sk-environment-secret');
    } finally {
      if (previous === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = previous;
    }
  });

  it('produces no events for a 204 response', async () => {
    const { fetchImpl } = fakeFetch([new Response(null, { status: 204 })]);

    const result = await sendProviderRequest({ driver: anthropicDriver, fetchImpl }, request(), 'sk-test-secret');

    expect(result.status).toBe(204);
    expect(result.events).toEqual([]);
  });

  it('produces no events for a JSON response that carries content-length 0', async () => {
    const { fetchImpl } = fakeFetch([
      new Response('', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '0' } }),
    ]);

    const result = await sendProviderRequest({ driver: anthropicDriver, fetchImpl }, request(), 'sk-test-secret');

    expect(result.status).toBe(200);
    expect(result.events).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The request timeout                                                          */
/* -------------------------------------------------------------------------- */

describe('the request timeout', () => {
  it('gives up on a request that never answers and names the timeout', async () => {
    // A `fetch` that never settles: without a timeout the turn hangs forever.
    const fetchImpl: typeof fetch = () => new Promise<Response>(() => undefined);

    const error = await sendProviderRequest(
      { driver: anthropicDriver, fetchImpl, timeoutMs: 25 },
      request(),
      'sk-test-secret',
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('ProviderTimeoutError');
    expect((error as Error).message).toContain('timed out');
    expect((error as Error).message).toContain('25');
  });

  it('aborts the request when the timeout fires', async () => {
    let observed: AbortSignal | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    };

    await sendProviderRequest(
      { driver: anthropicDriver, fetchImpl, timeoutMs: 25 },
      request(),
      'sk-test-secret',
    ).catch(() => undefined);

    expect(observed).toBeDefined();
    expect(observed?.aborted).toBe(true);
  });

  it('cancels the request when the caller aborts', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      observed = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('the request was aborted')));
      });
    };

    const promise = sendProviderRequest(
      { driver: anthropicDriver, fetchImpl, signal: controller.signal, timeoutMs: 5_000 },
      request(),
      'sk-test-secret',
    );
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/);
    expect(observed?.aborted).toBe(true);
  });

  it('uses the request timeout when the request declares one', async () => {
    const fetchImpl: typeof fetch = () => new Promise<Response>(() => undefined);

    const error = await sendProviderRequest(
      { driver: anthropicDriver, fetchImpl, timeoutMs: 60_000 },
      request({ timeout: 30 }),
      'sk-test-secret',
    ).catch((thrown: unknown) => thrown);

    expect((error as Error).message).toContain('30');
  });
});

/* -------------------------------------------------------------------------- */
/* The retry loop                                                               */
/* -------------------------------------------------------------------------- */

/** A driver that declares its own retry budget. */
function driverWithRetries(maxRetries: number): ProviderDriver {
  const driver: ProviderDriver = { ...anthropicDriver, maxRetries };
  return driver;
}

/** A `500` response, `count` times over. */
function serverErrors(count: number): Response[] {
  return Array.from({ length: count }, () => jsonResponse({ error: { message: 'boom' } }, { status: 500 }));
}

describe('the retry budget', () => {
  it('honours the maxRetries the driver declares', async () => {
    const { fetchImpl, calls } = fakeFetch(serverErrors(3));

    const result = await sendProviderRequest(
      { driver: driverWithRetries(2), fetchImpl, sleep: async () => undefined },
      request(),
      'sk-test-secret',
    );

    // One attempt plus two retries.
    expect(calls).toHaveLength(3);
    expect(result.status).toBe(500);
  });

  it('falls back to the default budget when the driver declares none', async () => {
    const { fetchImpl, calls } = fakeFetch(serverErrors(4));

    const result = await sendProviderRequest(
      { driver: anthropicDriver, fetchImpl, sleep: async () => undefined },
      request(),
      'sk-test-secret',
    );

    // The default is two retries: one attempt plus two.
    expect(calls).toHaveLength(3);
    expect(result.status).toBe(500);
  });

  it('uses the transport option when the driver declares none', async () => {
    const { fetchImpl, calls } = fakeFetch(serverErrors(3));

    const result = await sendProviderRequest(
      { driver: anthropicDriver, fetchImpl, maxRetries: 1, sleep: async () => undefined },
      request(),
      'sk-test-secret',
    );

    expect(calls).toHaveLength(2);
    expect(result.status).toBe(500);
  });

  it('prefers the driver budget over the transport option', async () => {
    const { fetchImpl, calls } = fakeFetch(serverErrors(4));

    const result = await sendProviderRequest(
      { driver: driverWithRetries(2), fetchImpl, maxRetries: 0, sleep: async () => undefined },
      request(),
      'sk-test-secret',
    );

    expect(calls).toHaveLength(3);
    expect(result.status).toBe(500);
  });
});

describe('the retry loop', () => {
  it('retries a retryable status up to the driver maxRetries', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse({ error: { message: 'overloaded' } }, { status: 529 }),
      jsonResponse({ error: { message: 'overloaded' } }, { status: 529 }),
      jsonResponse(messageBody()),
    ]);
    const delays: number[] = [];

    const result = await sendProviderRequest(
      {
        driver: driverWithRetries(2),
        fetchImpl,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
      request(),
      'sk-test-secret',
    );

    expect(calls).toHaveLength(3);
    expect(result.status).toBe(200);
    expect(delays).toEqual([500, 1000]);
    // The retry count travels in the `x-stainless-retry-count` header.
    expect(calls[0]?.headers['x-stainless-retry-count']).toBe('0');
    expect(calls[1]?.headers['x-stainless-retry-count']).toBe('1');
    expect(calls[2]?.headers['x-stainless-retry-count']).toBe('2');
  });

  it('gives up when the retry budget is spent and returns the error', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse({ error: { message: 'boom' } }, { status: 500 }),
      jsonResponse({ error: { message: 'boom' } }, { status: 500 }),
    ]);

    const result = await sendProviderRequest(
      { driver: driverWithRetries(1), fetchImpl, sleep: async () => undefined },
      request(),
      'sk-test-secret',
    );

    expect(calls).toHaveLength(2);
    expect(result.status).toBe(500);
    expect(result.events[0]).toEqual({ type: 'error', message: 'boom', status: 500, retryable: true });
  });

  it('returns a non-retryable status immediately', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse({ error: { message: 'bad request' } }, { status: 400 }),
    ]);

    const result = await sendProviderRequest(
      { driver: driverWithRetries(3), fetchImpl, sleep: async () => undefined },
      request(),
      'sk-test-secret',
    );

    expect(calls).toHaveLength(1);
    expect(result.status).toBe(400);
    expect(result.events[0]).toEqual({ type: 'error', message: 'bad request', status: 400, retryable: false });
  });

  it('honours x-should-retry in both directions', async () => {
    const refused = fakeFetch([
      jsonResponse({ error: { message: 'do not retry' } }, { status: 500, headers: { 'x-should-retry': 'false' } }),
    ]);
    const refusedResult = await sendProviderRequest(
      { driver: driverWithRetries(3), fetchImpl: refused.fetchImpl, sleep: async () => undefined },
      request(),
      'sk-test-secret',
    );
    expect(refused.calls).toHaveLength(1);
    expect(refusedResult.status).toBe(500);

    const demanded = fakeFetch([
      jsonResponse({ error: { message: 'retry me' } }, { status: 400, headers: { 'x-should-retry': 'true' } }),
      jsonResponse(messageBody()),
    ]);
    const demandedResult = await sendProviderRequest(
      { driver: driverWithRetries(3), fetchImpl: demanded.fetchImpl, sleep: async () => undefined },
      request(),
      'sk-test-secret',
    );
    expect(demanded.calls).toHaveLength(2);
    expect(demandedResult.status).toBe(200);
  });

  it('honours the retry-after header in the delay', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse({ error: { message: 'slow down' } }, { status: 429, headers: { 'retry-after': '2' } }),
      jsonResponse(messageBody()),
    ]);
    const delays: number[] = [];

    await sendProviderRequest(
      {
        driver: driverWithRetries(1),
        fetchImpl,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
      request(),
      'sk-test-secret',
    );

    expect(delays).toEqual([2000]);
  });

  it('refreshes a cached token on a 401 and makes one more attempt', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse({ error: { message: 'token expired', cached_token_refreshed: true } }, { status: 401 }),
      jsonResponse(messageBody()),
    ]);
    const refreshes: string[] = [];

    const result = await sendProviderRequest(
      {
        driver: anthropicDriver,
        fetchImpl,
        sleep: async () => undefined,
        refreshCredential: async () => {
          refreshes.push('refreshed');
          return 'sk-fresh-secret';
        },
      },
      request(),
      'sk-stale-secret',
    );

    expect(refreshes).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers['x-api-key']).toBe('sk-stale-secret');
    expect(calls[1]?.headers['x-api-key']).toBe('sk-fresh-secret');
    expect(result.status).toBe(200);
  });

  it('does not refresh a cached token when the response says it must not be retried', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(
        { error: { message: 'token expired', cached_token_refreshed: true } },
        { status: 401, headers: { 'x-should-retry': 'false' } },
      ),
    ]);
    const refreshes: string[] = [];

    const result = await sendProviderRequest(
      {
        driver: anthropicDriver,
        fetchImpl,
        sleep: async () => undefined,
        refreshCredential: async () => {
          refreshes.push('refreshed');
          return 'sk-fresh-secret';
        },
      },
      request(),
      'sk-stale-secret',
    );

    expect(refreshes).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(result.status).toBe(401);
  });

  it('does not retry a 401 that carries no cached-token flag', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse({ error: { message: 'invalid api key' } }, { status: 401 }),
    ]);
    const refreshes: string[] = [];

    const result = await sendProviderRequest(
      {
        driver: anthropicDriver,
        fetchImpl,
        sleep: async () => undefined,
        refreshCredential: async () => {
          refreshes.push('refreshed');
          return 'sk-fresh-secret';
        },
      },
      request(),
      'sk-stale-secret',
    );

    expect(refreshes).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(result.status).toBe(401);
  });

  it('does not retry a second 401 once the cached token has been refreshed', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse({ error: { message: 'token expired', cached_token_refreshed: true } }, { status: 401 }),
      jsonResponse({ error: { message: 'token expired', cached_token_refreshed: true } }, { status: 401 }),
    ]);
    const refreshes: string[] = [];

    const result = await sendProviderRequest(
      {
        driver: anthropicDriver,
        fetchImpl,
        sleep: async () => undefined,
        refreshCredential: async () => {
          refreshes.push('refreshed');
          return 'sk-fresh-secret';
        },
      },
      request(),
      'sk-stale-secret',
    );

    expect(refreshes).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(result.status).toBe(401);
  });

  it('counts the cached-token refresh against the retry budget', async () => {
    // A budget of one: the refresh spends it, so the **retryable** response
    // that follows is the last one.
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse({ error: { message: 'token expired', cached_token_refreshed: true } }, { status: 401 }),
      jsonResponse({ error: { message: 'boom' } }, { status: 500 }),
      jsonResponse({ error: { message: 'boom' } }, { status: 500 }),
    ]);
    const refreshes: string[] = [];

    const result = await sendProviderRequest(
      {
        driver: driverWithRetries(1),
        fetchImpl,
        sleep: async () => undefined,
        refreshCredential: async () => {
          refreshes.push('refreshed');
          return 'sk-fresh-secret';
        },
      },
      request(),
      'sk-stale-secret',
    );

    expect(refreshes).toHaveLength(1);
    // The refresh was one attempt of the two the budget allows, so the `500`
    // that follows gets no third attempt.
    expect(calls).toHaveLength(2);
    expect(result.status).toBe(500);
  });

  it('retries a 401 that says it must be retried', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse({ error: { message: 'try again' } }, { status: 401, headers: { 'x-should-retry': 'true' } }),
      jsonResponse(messageBody()),
    ]);

    const result = await sendProviderRequest(
      { driver: driverWithRetries(1), fetchImpl, sleep: async () => undefined },
      request(),
      'sk-test-secret',
    );

    expect(calls).toHaveLength(2);
    expect(result.status).toBe(200);
  });

  it('refreshes a cached token on a 401 that says it must be retried', async () => {
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse(
        { error: { message: 'token expired', cached_token_refreshed: true } },
        { status: 401, headers: { 'x-should-retry': 'true' } },
      ),
      jsonResponse(messageBody()),
    ]);
    const refreshes: string[] = [];

    const result = await sendProviderRequest(
      {
        driver: anthropicDriver,
        fetchImpl,
        sleep: async () => undefined,
        refreshCredential: async () => {
          refreshes.push('refreshed');
          return 'sk-fresh-secret';
        },
      },
      request(),
      'sk-stale-secret',
    );

    expect(refreshes).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers['x-api-key']).toBe('sk-fresh-secret');
    expect(result.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* The retry delay                                                              */
/* -------------------------------------------------------------------------- */

describe('the retry delay', () => {
  it('is deterministic and grows with the attempt', () => {
    expect(retryDelayMs(0)).toBe(500);
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(2)).toBe(2000);
    expect(retryDelayMs(3)).toBe(4000);
    expect(retryDelayMs(4)).toBe(8000);
    expect(retryDelayMs(10)).toBe(8000);
    expect(retryDelayMs(0)).toBe(retryDelayMs(0));
  });

  it('honours a retry-after header', () => {
    expect(retryDelayMs(0, { status: 429, headers: new Headers({ 'retry-after': '3' }) })).toBe(3000);
    expect(retryDelayMs(0, { status: 429, headers: new Headers({ 'retry-after': 'nonsense' }) })).toBe(500);
  });

  it('reports no delay for a response that says it must not be retried', () => {
    expect(retryDelayMs(0, { status: 500, headers: new Headers({ 'x-should-retry': 'false' }) })).toBe(0);
  });

  it('computes the HTTP-date form of retry-after against an injectable clock', () => {
    const now = Date.UTC(2026, 0, 2, 3, 4, 5);
    const at = new Date(now + 30_000).toUTCString();

    // The answer is a function of the inputs: the clock is a parameter, not
    // a hidden read of the wall clock.
    expect(retryDelayMs(0, { status: 503, headers: new Headers({ 'retry-after': at }) }, now)).toBe(30_000);
    expect(retryDelayMs(0, { status: 503, headers: new Headers({ 'retry-after': at }) }, now + 10_000)).toBe(20_000);
    // A date in the past yields no delay at all.
    expect(
      retryDelayMs(0, { status: 503, headers: new Headers({ 'retry-after': at }) }, now + 60_000),
    ).toBe(0);
  });

  it('honours a retry-after that is longer than the backoff cap', () => {
    // Thirty seconds is longer than the backoff's eight-second cap, and the
    // server's explicit instruction is not truncated to it.
    expect(retryDelayMs(0, { status: 503, headers: new Headers({ 'retry-after': '30' }) })).toBe(30_000);
    // An hour is clamped to the `retry-after` cap — which is its own, larger
    // cap — and not to the backoff's eight seconds.
    expect(retryDelayMs(0, { status: 503, headers: new Headers({ 'retry-after': '3600' }) })).toBe(60_000);
  });

  it('derives the retry-after delay of an HTTP-date from the transport clock', async () => {
    const { fetchImpl } = fakeFetch([
      jsonResponse(
        { error: { message: 'slow down' } },
        { status: 503, headers: { 'retry-after': 'Fri, 02 Jan 2026 03:04:35 GMT' } },
      ),
      jsonResponse(messageBody()),
    ]);
    const delays: number[] = [];

    await sendProviderRequest(
      {
        driver: driverWithRetries(1),
        fetchImpl,
        now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
      request(),
      'sk-test-secret',
    );

    expect(delays).toEqual([30_000]);
  });
});

/* -------------------------------------------------------------------------- */
/* The SigV4 signer                                                             */
/* -------------------------------------------------------------------------- */

/** The AWS credentials a signed request is signed with. */
const AWS_CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG' };

/**
 * The credentials the AWS SigV4 **test suite** signs its vectors with.
 *
 * The suite's own vectors use the secret `…+bPxRfiCYEXAMPLEKEY`, and the
 * service name `service` (not a provider's).
 */
const SUITE_CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

/** The moment the AWS SigV4 test-suite vectors are signed at. */
const SUITE_DATE = new Date('2015-08-30T12:36:00Z');

/** The session token the suite's `post-sts-header-before` vector carries. */
const SUITE_SESSION_TOKEN =
  'AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==';

/** The empty payload's SHA-256 — the hash of every body-less vector. */
const EMPTY_PAYLOAD_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** A Bedrock request: the route that signs with the service `bedrock`. */
function bedrockRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return request({
    model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    aws: { region: 'us-east-1' },
    ...overrides,
  });
}

describe('the SigV4 signer', () => {
  it('reproduces the AWS test-suite get-vanilla vector', async () => {
    const input = {
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: { host: 'example.amazonaws.com' },
      service: 'service',
      region: 'us-east-1',
      accessKeyId: SUITE_CREDENTIALS.accessKeyId,
      secretAccessKey: SUITE_CREDENTIALS.secretAccessKey,
      date: SUITE_DATE,
    };

    // The canonical request **string** is pinned, not only the signature: a
    // signer with a wrong canonicalisation produces a different string, and
    // the string is where the difference is visible.
    const canonical = buildCanonicalRequest(input);
    expect(canonical.canonicalRequest).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        EMPTY_PAYLOAD_HASH,
      ].join('\n'),
    );

    const signed = await buildSignedHeaders(input);
    expect(signed['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('follows the SDK double encoding of the path, not the test suite', async () => {
    const input = {
      method: 'GET',
      url: new URL('https://example.amazonaws.com/example space/'),
      headers: { host: 'example.amazonaws.com' },
      service: 'service',
      region: 'us-east-1',
      accessKeyId: SUITE_CREDENTIALS.accessKeyId,
      secretAccessKey: SUITE_CREDENTIALS.secretAccessKey,
      date: SUITE_DATE,
    };

    // The wire path is `/example%20space/`; the canonical URI escapes it a
    // **second** time, as the AWS SDK does. The suite's `.creq` file encodes
    // the path only once (`/example%20space/`), and the suite's own README
    // flags the difference — this implementation follows the **SDK**, because the SDK
    // is what the target runs.
    const canonical = buildCanonicalRequest(input);
    expect(canonical.canonicalUri).toBe('/example%2520space/');
    expect(canonical.canonicalRequest).toBe(
      [
        'GET',
        '/example%2520space/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        EMPTY_PAYLOAD_HASH,
      ].join('\n'),
    );

    const signed = await buildSignedHeaders(input);
    expect(signed['authorization']).toContain(
      'Signature=446b817944c553435b35e813c261ff4e161fff982d1bacdef1c87f6785dd1662',
    );
    // The suite's own (single-encoded) value is deliberately **not** what
    // this implementation produces.
    expect(signed['authorization']).not.toContain(
      'Signature=652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741',
    );
  });

  it('sorts the canonical query by the encoded name, as the AWS SDK does', () => {
    // The decoded names are `aZ` and `a[`, and they sort that way round
    // (`Z` is 90, `[` is 91). The **encoded** names are `aZ` and `a%5B`,
    // and the percent sign (37) sorts first — so the two orders disagree,
    // and the SDK's order is the encoded one.
    const url = new URL('https://example.amazonaws.com/?aZ=1&a[=2');
    expect(canonicalQueryString(url)).toBe('a%5B=2&aZ=1');
  });

  it('reproduces the AWS test-suite repeated-parameter vector', async () => {    const input = {
      method: 'GET',
      url: new URL('https://example.amazonaws.com/?Param1=value2&Param1=Value1'),
      headers: { host: 'example.amazonaws.com' },
      service: 'service',
      region: 'us-east-1',
      accessKeyId: SUITE_CREDENTIALS.accessKeyId,
      secretAccessKey: SUITE_CREDENTIALS.secretAccessKey,
      date: SUITE_DATE,
    };

    // Both occurrences survive, and the pairs are sorted by the **encoded**
    // name and then by the encoded value.
    const canonical = buildCanonicalRequest(input);
    expect(canonical.canonicalQuery).toBe('Param1=Value1&Param1=value2');

    const signed = await buildSignedHeaders(input);
    expect(signed['authorization']).toContain(
      'Signature=eedbc4e291e521cf13422ffca22be7d2eb8146eecf653089df300a15b2382bd1',
    );
  });

  it('reproduces the AWS test-suite header-value normalisation vector', async () => {
    const input = {
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {
        host: 'example.amazonaws.com',
        'my-header1': 'value1',
        'my-header2': '"a   b   c"',
      },
      service: 'service',
      region: 'us-east-1',
      accessKeyId: SUITE_CREDENTIALS.accessKeyId,
      secretAccessKey: SUITE_CREDENTIALS.secretAccessKey,
      date: SUITE_DATE,
    };

    // A run of spaces collapses to **one** space, as the SDK does.
    const canonical = buildCanonicalRequest(input);
    expect(canonical.canonicalHeaders).toContain('my-header2:"a b c"\n');

    const signed = await buildSignedHeaders(input);
    expect(signed['authorization']).toContain(
      'Signature=acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736',
    );
  });

  it('reproduces the AWS test-suite session-token vector', async () => {
    const signed = await buildSignedHeaders({
      method: 'POST',
      url: new URL('https://example.amazonaws.com/'),
      headers: { host: 'example.amazonaws.com' },
      sessionToken: SUITE_SESSION_TOKEN,
      service: 'service',
      region: 'us-east-1',
      accessKeyId: SUITE_CREDENTIALS.accessKeyId,
      secretAccessKey: SUITE_CREDENTIALS.secretAccessKey,
      date: SUITE_DATE,
    });

    // The session token is a **signed** header, and it travels on the wire.
    expect(signed['x-amz-security-token']).toBe(SUITE_SESSION_TOKEN);
    expect(signed['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date;x-amz-security-token, ' +
        'Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead',
    );
  });

  it('never signs the headers the AWS SDK never signs', async () => {
    const canonical = buildCanonicalRequest({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {
        host: 'example.amazonaws.com',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'proxy-authorization': 'Basic a-secret',
        'sec-fetch-mode': 'cors',
        'user-agent': 'a-user-agent',
      },
      service: 'service',
      region: 'us-east-1',
      accessKeyId: SUITE_CREDENTIALS.accessKeyId,
      secretAccessKey: SUITE_CREDENTIALS.secretAccessKey,
      date: SUITE_DATE,
    });

    expect(canonical.signedHeaders).toBe('host;x-amz-date');
  });

  it('does not swallow a header named __proto__', async () => {
    // `JSON.parse` is what creates an **own** `__proto__` member — an object
    // literal would set the prototype instead.
    const headers = JSON.parse('{"__proto__": "a-value"}') as Record<string, string>;

    const signed = await buildSignedHeaders({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers,
      service: 'service',
      region: 'us-east-1',
      accessKeyId: SUITE_CREDENTIALS.accessKeyId,
      secretAccessKey: SUITE_CREDENTIALS.secretAccessKey,
      date: SUITE_DATE,
    });

    expect(Object.hasOwn(signed, '__proto__')).toBe(true);
    expect(signed['__proto__']).toBe('a-value');
  });

  it('replaces the host header with the URL host and deletes the connection header', async () => {
    const signed = await buildSignedHeaders({
      method: 'POST',
      url: new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke'),
      headers: {
        'content-type': 'application/json',
        host: 'stale.example.com',
        connection: 'keep-alive',
      },
      body: '{}',
      service: 'bedrock',
      region: 'us-east-1',
      accessKeyId: AWS_CREDENTIALS.accessKeyId,
      secretAccessKey: AWS_CREDENTIALS.secretAccessKey,
      date: new Date('2026-01-02T03:04:05Z'),
    });

    expect(signed['host']).toBe('bedrock-runtime.us-east-1.amazonaws.com');
    expect(Object.hasOwn(signed, 'connection')).toBe(false);
    expect(signed['x-amz-date']).toBe('20260102T030405Z');
    expect(signed['authorization']).toContain(
      'Credential=AKIDEXAMPLE/20260102/us-east-1/bedrock/aws4_request',
    );
    expect(signed['authorization']).toContain('SignedHeaders=');
    expect(signed['authorization']).toContain('Signature=');
    // The `host` header is part of the signature.
    expect(signed['authorization']).toContain('host');
  });

  it('signs the Bedrock model-id path the way the AWS SDK does', async () => {
    const input = {
      method: 'POST',
      url: new URL(
        'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke',
      ),
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-stainless-retry-count': '0',
        'x-stainless-timeout': '30',
      },
      body: '{"anthropic_version":"bedrock-2023-05-31","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}',
      service: 'bedrock',
      region: 'us-east-1',
      accessKeyId: SUITE_CREDENTIALS.accessKeyId,
      secretAccessKey: SUITE_CREDENTIALS.secretAccessKey,
      date: new Date('2026-01-02T03:04:05Z'),
    };

    // The model id travels as `…-v1%3A0` and is signed as `…-v1%253A0`: the
    // SDK's double encoding.
    const canonical = buildCanonicalRequest(input);
    expect(canonical.canonicalUri).toBe('/model/anthropic.claude-sonnet-4-5-20250929-v1%253A0/invoke');

    const signed = await buildSignedHeaders(input);
    expect(signed['authorization']).toContain(
      'Signature=65917f3f426a3a4dee35f35138c0f824354ec0c7957f16e73f20cde2e3c18896',
    );
  });

  it('signs with the service name the driver wrote into the request, not a constant', async () => {
    const bedrock = fakeFetch([jsonResponse(messageBody())]);
    await sendProviderRequest(
      { driver: bedrockDriver, fetchImpl: bedrock.fetchImpl, awsCredentials: AWS_CREDENTIALS },
      bedrockRequest(),
    );
    expect(bedrock.calls[0]?.headers['authorization']).toContain('/us-east-1/bedrock/aws4_request');

    const mantle = fakeFetch([jsonResponse(messageBody())]);
    await sendProviderRequest(
      { driver: mantleDriver, fetchImpl: mantle.fetchImpl, awsCredentials: AWS_CREDENTIALS },
      request({ model: 'claude-sonnet-4-5', aws: { region: 'us-east-1' } }),
    );
    expect(mantle.calls[0]?.headers['authorization']).toContain('/us-east-1/bedrock-mantle/aws4_request');
  });

  it('sends the signed host and drops the connection header on the wire', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);

    await sendProviderRequest(
      { driver: bedrockDriver, fetchImpl, awsCredentials: AWS_CREDENTIALS },
      bedrockRequest(),
    );

    // The AWS SDK escapes the values of the URI template's labels when it
    // builds the request path, so the model id travels percent-encoded.
    expect(calls[0]?.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke',
    );
    expect(calls[0]?.headers['host']).toBe('bedrock-runtime.us-east-1.amazonaws.com');
    expect(Object.hasOwn(calls[0]?.headers ?? {}, 'connection')).toBe(false);
  });

  it('signs the model-id path the way the target signs it', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);

    await sendProviderRequest(
      { driver: bedrockDriver, fetchImpl, awsCredentials: AWS_CREDENTIALS },
      bedrockRequest(),
    );

    // The request target carries the **encoded** model id …
    const sent = calls[0]?.url ?? '';
    expect(sent).toContain('/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke');
    // … and the canonical URI the signer used is the double-encoded form.
    expect(canonicalUriPath(new URL(sent))).toBe(
      '/model/anthropic.claude-sonnet-4-5-20250929-v1%253A0/invoke',
    );
  });

  it('signs with the x-amz-date the driver declared, not the transport clock', async () => {
    // A driver that declares the signing date on the request but does not
    // put it in the header set: the transport has to read it from the
    // request's signing context.
    const datedDriver: ProviderDriver = {
      ...bedrockDriver,
      buildHeaders(req, cred) {
        const headers = bedrockDriver.buildHeaders(req, cred);
        delete headers['x-amz-date'];
        return headers;
      },
    };
    const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);

    await sendProviderRequest(
      {
        driver: datedDriver,
        fetchImpl,
        awsCredentials: AWS_CREDENTIALS,
        now: () => Date.UTC(2030, 0, 1, 0, 0, 0),
      },
      bedrockRequest({ aws: { region: 'us-east-1', date: '20260102T030405Z' } }),
    );

    expect(calls[0]?.headers['x-amz-date']).toBe('20260102T030405Z');
    // The credential scope carries the same date stamp.
    expect(calls[0]?.headers['authorization']).toContain('Credential=AKIDEXAMPLE/20260102/us-east-1/bedrock/aws4_request');
  });

  it('sends the header set the body step produced, not the one the header step produced', async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);

    await sendProviderRequest(
      { driver: bedrockDriver, fetchImpl, awsCredentials: AWS_CREDENTIALS },
      bedrockRequest({ betaFlags: ['tool-search-tool-2025-10-19'] }),
    );

    // The Bedrock adapter *moves* the `anthropic-beta` header into the body
    // (audit §2.2a), so the header does not survive alongside the body field.
    expect(calls[0]?.headers['anthropic-beta']).toBeUndefined();
    const body = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['anthropic_beta']).toEqual(['advanced-tool-use-2025-11-20']);
  });

  it('preserves multi-valued query parameters byte-for-byte', async () => {
    const url = new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke?a=1&a=2&b=%20x');
    expect(canonicalQueryString(url)).toBe('a=1&a=2&b=%20x');
    // **Both** occurrences of `a` survive: a signer that dropped the second
    // one would produce the same string as the one-value query below.
    expect(canonicalQueryString(url).split('&').filter((pair) => pair.startsWith('a='))).toEqual(['a=1', 'a=2']);

    const signed = await buildSignedHeaders({
      method: 'POST',
      url,
      headers: {},
      body: '{}',
      service: 'bedrock',
      region: 'us-east-1',
      accessKeyId: AWS_CREDENTIALS.accessKeyId,
      secretAccessKey: AWS_CREDENTIALS.secretAccessKey,
      date: new Date('2026-01-02T03:04:05Z'),
    });

    // The query is covered by the signature: dropping one of the two values
    // changes it.
    const other = await buildSignedHeaders({
      method: 'POST',
      url: new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke?a=1&b=%20x'),
      headers: {},
      body: '{}',
      service: 'bedrock',
      region: 'us-east-1',
      accessKeyId: AWS_CREDENTIALS.accessKeyId,
      secretAccessKey: AWS_CREDENTIALS.secretAccessKey,
      date: new Date('2026-01-02T03:04:05Z'),
    });
    expect(signed['authorization']).not.toBe(other['authorization']);
  });

  it('signs the query of the URL it actually sent', async () => {
    // A driver whose URL carries a repeated parameter.
    const queryDriver: ProviderDriver = {
      ...bedrockDriver,
      buildUrl: () => 'https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke?a=1&a=2&b=%20x',
    };
    const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);

    await sendProviderRequest(
      { driver: queryDriver, fetchImpl, awsCredentials: AWS_CREDENTIALS },
      request({ model: 'm', aws: { region: 'us-east-1' } }),
    );

    const sent = calls[0]?.url ?? '';
    expect(sent).toContain('?a=1&a=2&b=%20x');
    // The canonical query is re-derived from the URL that was **sent**.
    expect(canonicalQueryString(new URL(sent))).toBe('a=1&a=2&b=%20x');
  });
});

/* -------------------------------------------------------------------------- */
/* The token-acquisition seam                                                   */
/* -------------------------------------------------------------------------- */

describe('the token-acquisition seam', () => {
  it('hands the Vertex scope to the token acquirer', async () => {
    const scopes: string[] = [];
    const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);

    await sendProviderRequest(
      {
        driver: vertexDriver,
        fetchImpl,
        acquireToken: async (scope) => {
          scopes.push(scope);
          return 'ya29.google-token';
        },
      },
      request({
        model: 'claude-sonnet-4-5',
        vertex: { projectId: 'proj-1', location: 'us-central1' },
      }),
    );

    expect(scopes).toEqual(['cloud-platform']);
    expect(calls[0]?.headers['authorization']).toBe('Bearer ya29.google-token');
    expect(calls[0]?.headers['x-api-key']).toBeUndefined();
  });

  it('hands the Azure AD scope to the token acquirer for a Foundry request', async () => {
    const scopes: string[] = [];
    const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);

    await sendProviderRequest(
      {
        driver: foundryDriver,
        fetchImpl,
        baseUrl: 'https://res.services.ai.azure.com/anthropic/',
        acquireToken: async (scope) => {
          scopes.push(scope);
          return 'azure-ad-token';
        },
      },
      request({ model: 'deployment-1' }),
    );

    expect(scopes).toEqual(['https://ai.azure.com/.default']);
    expect(calls[0]?.headers['authorization']).toBe('Bearer azure-ad-token');
    expect(calls[0]?.headers['x-api-key']).toBeUndefined();
  });

  it('does not acquire a token for a route that declares no scope', async () => {
    const scopes: string[] = [];
    const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);

    await sendProviderRequest(
      {
        driver: anthropicDriver,
        fetchImpl,
        acquireToken: async (scope) => {
          scopes.push(scope);
          return 'a-token';
        },
      },
      request(),
      'sk-test-secret',
    );

    expect(scopes).toEqual([]);
    expect(calls[0]?.headers['x-api-key']).toBe('sk-test-secret');
  });

  it('builds a token acquirer from a scope table without resolving an inherited member', () => {
    const acquirer = tokenAcquirerFor({ 'cloud-platform': 'a-token' });
    expect(acquirer('cloud-platform')).toBe('a-token');
    expect(acquirer('constructor')).toBeUndefined();
    expect(acquirer('toString')).toBeUndefined();
  });

  it('sends an acquired token as a bearer token even when the caller named an api key', async () => {
    // A driver that honours the request's credential kind faithfully: the
    // rule that an acquired token is a bearer token belongs in the
    // **transport**, not in each driver.
    const faithfulDriver: ProviderDriver = {
      ...anthropicDriver,
      buildHeaders(req, cred) {
        req.tokenScope = 'a-scope';
        return anthropicDriver.buildHeaders(req, cred);
      },
    };
    const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);

    await sendProviderRequest(
      {
        driver: faithfulDriver,
        fetchImpl,
        acquireToken: async () => 'an-acquired-token',
      },
      request({ credentialKind: 'apiKey' }),
    );

    // An acquired token is a **bearer** token by construction: the Azure AD
    // and Google tokens must never travel as an API key.
    expect(calls[0]?.headers['authorization']).toBe('Bearer an-acquired-token');
    expect(calls[0]?.headers['x-api-key']).toBeUndefined();
  });

  it('reads the token scope after the header step, so a driver that writes it there is honoured', async () => {
    const scopes: string[] = [];
    // The driver writes the scope in its **header** step only. A transport
    // that read the scope before that step would never acquire a token.
    const scopeInHeadersDriver: ProviderDriver = {
      ...anthropicDriver,
      buildHeaders(req, cred) {
        req.tokenScope = 'scope-from-the-header-step';
        return anthropicDriver.buildHeaders(req, cred);
      },
      buildBody(req, cred) {
        return { body: { model: req.model }, headers: {} };
      },
    };
    const { fetchImpl, calls } = fakeFetch([jsonResponse(messageBody())]);

    await sendProviderRequest(
      {
        driver: scopeInHeadersDriver,
        fetchImpl,
        acquireToken: async (scope) => {
          scopes.push(scope);
          return 'an-acquired-token';
        },
      },
      request(),
    );

    expect(scopes).toEqual(['scope-from-the-header-step']);
    expect(calls[0]?.headers['authorization']).toBe('Bearer an-acquired-token');
  });
});
