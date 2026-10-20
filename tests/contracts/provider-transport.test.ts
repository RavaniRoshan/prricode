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
 *     non-enumerable `_request_id` / `_workspace_id`;
 *   - the **credential rule**: the transport *receives* a credential, never
 *     resolves one, and never lets a secret reach a URL or an error message;
 *   - the **retry loop**: the retryable statuses, the `x-should-retry` header in
 *     **both** directions, the `retry-after` delay, the retry budget, and the
 *     cached-token `401` that triggers a token refresh and one more attempt;
 *   - the **signer**: the `host` replacement, the `connection` deletion, the
 *     byte-for-byte preservation of multi-valued query parameters, and the
 *     service name the **driver** wrote into `req.aws.service`;
 *   - the **token-acquisition seam**: a Vertex or Foundry request's
 *     `tokenScope` reaches the `acquireToken` callback.
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
import { buildSignedHeaders, canonicalQueryString } from '../../src/provider/transport/sigv4.js';

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
});

/* -------------------------------------------------------------------------- */
/* The retry loop                                                               */
/* -------------------------------------------------------------------------- */

/** A driver that declares its own retry budget. */
function driverWithRetries(maxRetries: number): ProviderDriver {
  const driver: ProviderDriver & { maxRetries: number } = { ...anthropicDriver, maxRetries };
  return driver;
}

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
});

/* -------------------------------------------------------------------------- */
/* The SigV4 signer                                                             */
/* -------------------------------------------------------------------------- */

/** The AWS credentials a signed request is signed with. */
const AWS_CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG' };

/** A Bedrock request: the route that signs with the service `bedrock`. */
function bedrockRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return request({
    model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    aws: { region: 'us-east-1' },
    ...overrides,
  });
}

describe('the SigV4 signer', () => {
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

    expect(calls[0]?.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-5-20250929-v1:0/invoke',
    );
    expect(calls[0]?.headers['host']).toBe('bedrock-runtime.us-east-1.amazonaws.com');
    expect(Object.hasOwn(calls[0]?.headers ?? {}, 'connection')).toBe(false);
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
});
