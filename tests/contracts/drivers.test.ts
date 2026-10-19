/**
 * Contract test for the provider protocol drivers.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2 (Provider request
 * construction), §2.2a (the provider adapters' wire shapes, re-derived from the
 * pinned binary) and §2.3 (the local gateway).
 *
 * What this test pins:
 *   - the first-party **two path variants** (`/v1/messages` and
 *     `/v1/messages?beta=true`) and the header set;
 *   - the target's **retry rule** and the `x-should-retry` header;
 *   - the **SSE** parsing, including the chunk-boundary case, the cumulative
 *     usage rule, and the **tolerance** of the extended event vocabulary;
 *   - the default **`parseResponse`** branch set and the non-enumerable
 *     `_request_id` / `_workspace_id` it attaches;
 *   - each of the **eight routes**' concrete wire shape: Bedrock's body
 *     mutations, its path rewrite and its binary eventstream, Vertex's
 *     `rawPredict` / `streamRawPredict` selection and its regional hosts,
 *     Foundry's mutual exclusions and its deployment-name body, the
 *     Mantle/Google/AWS shapes, and the gateway's workspace-id rejection,
 *     `count_tokens` handling, SSE re-framing and upstream hop;
 *   - the per-driver **beta dialect** translation and the trimming of a
 *     per-dialect beta list;
 *   - the **non-streaming timeout** and the `600000` ms cap;
 *   - the two **seams** a transport depends on: the SigV4 service name and the
 *     OAuth2 scope.
 *
 * The Bedrock, Vertex, Mantle and Foundry shapes are **REA-observed** (the
 * target's own bundled adapters), not inferred from the public SDKs; where the
 * two disagree, the audit wins.
 */

import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_MESSAGE_PATHS,
  AWS_REGION_REQUIRED_ERROR,
  BEDROCK_ANTHROPIC_VERSION,
  BEDROCK_COUNT_TOKENS_LOCAL_MESSAGE,
  FOUNDRY_CREDENTIALS_MUTUALLY_EXCLUSIVE_ERROR,
  FOUNDRY_MISSING_CREDENTIALS_ERROR,
  FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR,
  FOUNDRY_MISSING_BASE_URL_ERROR,
  GATEWAY_USER_AGENT,
  GATEWAY_WORKSPACE_ID_MESSAGE,
  NONSTREAMING_TIMEOUT_FALLBACK_MS,
  SDK_USER_AGENT,
  VERTEX_ANTHROPIC_VERSION,
  VERTEX_MISSING_PROJECT_ERROR,
  anthropicAwsDriver,
  anthropicDriver,
  anthropicGoogleCloudDriver,
  bedrockCountTokensLocally,
  bedrockDriver,
  bedrockRewritePath,
  bedrockSigningHeaders,
  createGatewayDriver,
  driverFor,
  estimateTokenCount,
  foundryDriver,
  gatewayCountTokensResponse,
  gatewayCountTokensUnsupported,
  gatewayErrorFrame,
  gatewayMoveBetaHeaderIntoBody,
  gatewayDriver,
  gatewayRejectsWorkspaceId,
  gatewayUpstreamRequest,
  gatewayWorkspaceIdRejection,
  listDrivers,
  mantleDriver,
  parseResponse,
  reframeAsSse,
  rewriteBedrockBody,
  vertexDriver,
  GatewayRequestError,
  type ProviderDriver,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponseLike,
} from '../../src/provider/drivers/index.js';
import {
  isRecord,
  parseSseFrame,
  resolveRequestTimeout,
  splitCommaList,
  stripBetaSearchParam,
  translateBetaFlags,
  type ProviderEvent,
} from '../../src/provider/drivers/types.js';
import { ROUTE_NAMES, type ProviderRoute } from '../../src/provider/routes.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'claude-sonnet-4-5',
    maxTokens: 1024,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    stream: false,
    ...overrides,
  };
}

function bodyOf(driver: ProviderDriver, req: ProviderRequest, cred?: string): Record<string, unknown> {
  const built = driver.buildBody(req, cred);
  expect(isRecord(built.body)).toBe(true);
  return built.body as Record<string, unknown>;
}

function headersOf(driver: ProviderDriver, req: ProviderRequest, cred?: string): Record<string, string> {
  return driver.buildHeaders(req, cred);
}

function eventTypes(events: readonly ProviderEvent[]): string[] {
  return events.map((event) => event.type);
}

/**
 * Synthesize one AWS eventstream frame.
 *
 * The framing is: a 4-byte total length, a 4-byte headers length, a 4-byte
 * prelude CRC, the headers, the payload and a 4-byte message CRC. This implementation
 * does not verify the CRCs.
 */
function eventStreamFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = Buffer.from([0]);
  const totalLength = 12 + headers.length + body.length + 4;
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(totalLength, 0);
  prelude.writeUInt32BE(headers.length, 4);
  prelude.writeUInt32BE(0, 8);
  const messageCrc = Buffer.alloc(4);
  return Buffer.concat([prelude, headers, body, messageCrc]);
}

/** A Bedrock frame carrying an Anthropic event. */
function bedrockFrame(event: unknown): string {
  return eventStreamFrame({ chunk: JSON.stringify(event) }).toString('latin1');
}

/**
 * A response the default `parseResponse` accepts.
 *
 * The shape is the subset of the platform `Response` the SDK's own
 * `parseResponse` uses: the status, the headers, `json()` and `text()`.
 */
function fakeResponse(init: {
  status?: number;
  contentType?: string;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}): ProviderResponseLike {
  const headers = new Map<string, string>();
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    headers.set(key.toLowerCase(), value);
  }
  if (init.contentType !== undefined) headers.set('content-type', init.contentType);
  return {
    status: init.status ?? 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => init.body,
    text: async () => init.text ?? '',
  };
}

/* -------------------------------------------------------------------------- */
/* Step 1 — the first-party driver                                              */
/* -------------------------------------------------------------------------- */

describe('the first-party driver', () => {
  it('builds the standard path', () => {
    expect(anthropicDriver.buildUrl(request(), 'https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
  });

  it('builds the beta path variant when the request carries beta flags', () => {
    expect(anthropicDriver.buildUrl(request({ betaFlags: ['some-beta'] }), 'https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/messages?beta=true',
    );
  });

  it('keeps both path variants as first-class literals', () => {
    // **Observed** (audit §2.2a): the target's own path set contains both
    // `/v1/messages` and `/v1/messages?beta=true` as distinct literals, and
    // the audit explicitly corrects the earlier claim that the marker was a
    // conditional on the beta flags.
    expect(ANTHROPIC_MESSAGE_PATHS.messages).toBe('/v1/messages');
    expect(ANTHROPIC_MESSAGE_PATHS.betaMessages).toBe('/v1/messages?beta=true');
    expect(Object.keys(ANTHROPIC_MESSAGE_PATHS).sort()).toEqual(['betaMessages', 'messages']);
  });

  it('emits either path variant on demand, not only as a beta-flag consequence', () => {
    // The beta marker is a **distinct path variant**, so a request can name it
    // whether or not it carries beta flags.
    expect(
      anthropicDriver.buildUrl(request({ pathVariant: 'betaMessages' }), 'https://api.anthropic.com'),
    ).toBe('https://api.anthropic.com/v1/messages?beta=true');
    expect(
      anthropicDriver.buildUrl(request({ betaFlags: ['a'], pathVariant: 'messages' }), 'https://api.anthropic.com'),
    ).toBe('https://api.anthropic.com/v1/messages');
  });

  it('sets the anthropic version and the content type', () => {
    const headers = headersOf(anthropicDriver, request(), 'sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['content-type']).toBe('application/json');
  });

  it('sends the first-party user agent and the stainless headers', () => {
    // **Observed** (audit §2.2, `buildHeaders`): `User-Agent`
    // (`Anthropic/JS <version>`), `X-Stainless-Retry-Count` and
    // `X-Stainless-Timeout` (seconds).
    const headers = headersOf(anthropicDriver, request(), 'sk-test');
    expect(headers['user-agent']).toBe(SDK_USER_AGENT);
    expect(headers['user-agent']).toMatch(/^Anthropic\/JS \d+\.\d+\.\d+$/);
    expect(headers['x-stainless-retry-count']).toBe('0');
    expect(headers['x-stainless-timeout']).toBe(
      String(Math.ceil(resolveRequestTimeout(request(), undefined) / 1000)),
    );
    expect(Number(headers['x-stainless-timeout'])).toBeGreaterThan(0);
  });

  it('carries the explicit timeout in the stainless timeout header, in seconds', () => {
    const headers = headersOf(anthropicDriver, request({ timeout: 5_000 }), 'sk-test');
    expect(headers['x-stainless-timeout']).toBe('5');
  });

  it('sends an api key and never a bearer token', () => {
    const headers = headersOf(anthropicDriver, request({ credentialKind: 'apiKey' }), 'sk-test');
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['authorization']).toBeUndefined();
  });

  it('sends a bearer token and never an api key', () => {
    const headers = headersOf(anthropicDriver, request({ credentialKind: 'bearer' }), 'oauth-token');
    expect(headers['authorization']).toBe('Bearer oauth-token');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('sends no auth header at all when there is no credential', () => {
    // The driver never resolves a credential itself: it receives one, or none.
    const headers = headersOf(anthropicDriver, request(), undefined);
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
  });

  it('keeps the model and the stream flag in the body', () => {
    const body = bodyOf(anthropicDriver, request({ stream: true }));
    expect(body['model']).toBe('claude-sonnet-4-5');
    expect(body['stream']).toBe(true);
    expect(body['max_tokens']).toBe(1024);
    expect(body['messages']).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('carries a model name that collides with an Object.prototype member', () => {
    // A model name is caller-supplied data; a bare index would resolve
    // `Object.prototype.constructor` instead of reporting "absent".
    const body = bodyOf(anthropicDriver, request({ model: 'constructor' }));
    expect(body['model']).toBe('constructor');
    expect(bodyOf(anthropicDriver, request({ model: 'toString' }))['model']).toBe('toString');
  });

  it('sends a count-tokens body without the generation knobs', () => {
    // A count-tokens request carries the prompt and the tools, and none of
    // the knobs that only a generation request has.
    const body = bodyOf(
      anthropicDriver,
      request({
        operation: 'count_tokens',
        stream: true,
        temperature: 0.5,
        thinking: { type: 'enabled', budgetTokens: 1024 },
      }),
    );
    expect(Object.hasOwn(body, 'max_tokens')).toBe(false);
    expect(Object.hasOwn(body, 'stream')).toBe(false);
    expect(Object.hasOwn(body, 'temperature')).toBe(false);
    expect(Object.hasOwn(body, 'thinking')).toBe(false);
    expect(body['model']).toBe('claude-sonnet-4-5');
    expect(body['messages']).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

/* -------------------------------------------------------------------------- */
/* The header bag                                                               */
/* -------------------------------------------------------------------------- */

describe('the header bag', () => {
  it('writes a caller-supplied header name that collides with a prototype member', () => {
    // A header name is caller-supplied data: `'__proto__'` must not vanish
    // into the prototype chain and `'constructor'` must not shadow an
    // inherited member in a way a lookup cannot tell apart from an own one.
    //
    // `JSON.parse` is what creates an **own** `__proto__` member — an object
    // literal would set the prototype instead.
    const extra = JSON.parse('{"__proto__": "x"}') as Record<string, string>;
    const headers = headersOf(anthropicDriver, request({ extraHeaders: extra }));
    expect(Object.hasOwn(headers, '__proto__')).toBe(true);
    expect(headers['__proto__']).toBe('x');

    const named = headersOf(anthropicDriver, request({ extraHeaders: { constructor: 'yes' } }));
    expect(Object.hasOwn(named, 'constructor')).toBe(true);
    expect(named['constructor']).toBe('yes');
  });

  it('has no inherited member a lookup could mistake for an own one', () => {
    const headers = headersOf(anthropicDriver, request());
    expect(Object.getPrototypeOf(headers)).toBeNull();
    expect(Object.hasOwn(headers, 'toString')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 5 — the retry rule                                                     */
/* -------------------------------------------------------------------------- */

describe('the retry rule', () => {
  it('retries 408, 409, 429 and every 5xx', () => {
    for (const status of [408, 409, 429, 500, 502, 503, 529]) {
      expect(anthropicDriver.classifyError(status, { error: { message: 'nope' } }).retryable).toBe(true);
    }
  });

  it('does not retry 400, 401, 403 or 404', () => {
    for (const status of [400, 401, 403, 404]) {
      expect(anthropicDriver.classifyError(status, { error: { message: 'nope' } }).retryable).toBe(false);
    }
  });

  it('retries a 401 whose cached token has been invalidated', () => {
    // **Observed** (audit §2.2): the target retries on a `401` when the
    // response used a cached token that has not already been refreshed.
    const classified = anthropicDriver.classifyError(401, {
      error: { message: 'expired' },
      cached_token_refreshed: true,
    });
    expect(classified.retryable).toBe(true);
  });

  it('does not retry a 401 whose cached token was not refreshed', () => {
    expect(
      anthropicDriver.classifyError(401, { error: { message: 'expired' }, cached_token_refreshed: false })
        .retryable,
    ).toBe(false);
  });

  it('honours the x-should-retry header in both directions', () => {
    expect(
      anthropicDriver.classifyError(400, { error: { message: 'nope' } }, { headers: { 'x-should-retry': 'true' } })
        .retryable,
    ).toBe(true);
    expect(
      anthropicDriver.classifyError(503, { error: { message: 'nope' } }, { headers: { 'x-should-retry': 'false' } })
        .retryable,
    ).toBe(false);
  });

  it('reports the upstream message', () => {
    expect(anthropicDriver.classifyError(400, { error: { message: 'bad request' } }).message).toBe('bad request');
  });

  it('shares the rule set across the drivers', () => {
    for (const driver of listDrivers()) {
      expect(driver.classifyError(429, { error: { message: 'slow down' } }).retryable).toBe(true);
      expect(driver.classifyError(400, { error: { message: 'bad' } }).retryable).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Step 8 — the SSE parser                                                     */
/* -------------------------------------------------------------------------- */

describe('the SSE parser', () => {
  it('emits message_start once, a text delta per content block delta, and message_stop', () => {
    const stream = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');

    const { events } = anthropicDriver.parseStream(stream, undefined);
    expect(eventTypes(events)).toEqual(['message_start', 'text_delta', 'text_delta', 'message_stop']);
    expect(events[0]).toMatchObject({ type: 'message_start', messageId: 'msg_1', model: 'claude-sonnet-4-5' });
    expect(events[1]).toEqual({ type: 'text_delta', text: 'Hel' });
    expect(events[3]).toEqual({ type: 'message_stop', stopReason: 'end_turn' });
  });

  it('does not lose a frame that straddles a chunk boundary', () => {
    const frame = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n';
    const cut = Math.floor(frame.length / 2);

    const first = anthropicDriver.parseStream(frame.slice(0, cut), undefined);
    expect(first.events).toHaveLength(0);

    const second = anthropicDriver.parseStream(frame.slice(cut), first.state);
    expect(eventTypes(second.events)).toEqual(['text_delta']);
    expect(second.events[0]).toEqual({ type: 'text_delta', text: 'hi' });
  });

  it('emits an error event with the retryability derived from the status', () => {
    const overloaded = anthropicDriver.parseStream(
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded","status":529}}\n\n',
      undefined,
    );
    expect(overloaded.events[0]).toEqual({
      type: 'error',
      message: 'Overloaded',
      status: 529,
      retryable: true,
    });

    const invalid = anthropicDriver.parseStream(
      'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"bad","status":400}}\n\n',
      undefined,
    );
    expect(invalid.events[0]).toEqual({ type: 'error', message: 'bad', status: 400, retryable: false });
  });

  it('tolerates the extended event vocabulary instead of failing on it', () => {
    // **Observed** (audit §2.2): the pinned SDK's SSE parser accepts an
    // extended vocabulary — `agent.*`, `session.*`, `span.*`, `user.*`, plus
    // `event_start`, `event_delta`, `system.message` and a legacy `completion`.
    const extended = [
      'event: agent.message',
      'data: {"type":"agent.message","message":{"role":"assistant"}}',
      '',
      'event: session.status_running',
      'data: {"type":"session.status_running"}',
      '',
      'event: span.model_request_start',
      'data: {"type":"span.model_request_start"}',
      '',
      'event: user.interrupt',
      'data: {"type":"user.interrupt"}',
      '',
      'event: event_start',
      'data: {"type":"event_start"}',
      '',
      'event: event_delta',
      'data: {"type":"event_delta"}',
      '',
      'event: system.message',
      'data: {"type":"system.message"}',
      '',
      'event: completion',
      'data: {"type":"completion"}',
      '',
      '',
    ].join('\n');

    const { events } = anthropicDriver.parseStream(extended, undefined);
    // The stream does not fail: the extended events are tolerated rather than
    // raising an error event.
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
  });

  it('maps the tool-shaped extended events onto this implementation\'s tool events', () => {
    // The extended vocabulary is not merely tolerated: its tool-shaped events
    // are the only way the `tool_result` member of the event union is
    // reachable.
    const stream = [
      'event: agent.tool_use',
      'data: {"type":"agent.tool_use","tool_use_id":"toolu_x","name":"Read","input":{"path":"a.ts"}}',
      '',
      'event: agent.tool_result',
      'data: {"type":"agent.tool_result","tool_use_id":"toolu_x","content":"ok","is_error":false}',
      '',
      '',
    ].join('\n');

    const { events } = anthropicDriver.parseStream(stream, undefined);
    expect(eventTypes(events)).toEqual(['tool_use', 'tool_result']);
    expect(events[0]).toEqual({ type: 'tool_use', id: 'toolu_x', name: 'Read', input: { path: 'a.ts' } });
    expect(events[1]).toEqual({ type: 'tool_result', id: 'toolu_x', content: 'ok', isError: false });
  });

  it('keeps the core events that follow an extended one', () => {
    const stream = [
      'event: agent.message',
      'data: {"type":"agent.message"}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');
    const { events } = anthropicDriver.parseStream(stream, undefined);
    expect(eventTypes(events)).toEqual(['message_stop']);
  });

  it('tolerates a ping frame', () => {
    // A keep-alive `ping` is not one of the events the pinned SDK lists, so it
    // yields nothing — and it never fails the stream.
    const stream = [
      'event: ping',
      'data: {"type": "ping"}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');

    const { events } = anthropicDriver.parseStream(stream, undefined);
    expect(eventTypes(events)).toEqual(['message_stop']);
  });

  it('carries the cumulative usage rather than an accumulated one', () => {
    // **Observed**: the usage in a `message_delta` is cumulative, not
    // incremental — a driver that accumulates it double-counts. The wire's
    // `message_delta` carries **only** `output_tokens`, so the cumulative
    // counter is replaced **field-wise**: the `input_tokens` the
    // `message_start` reported survive the merge.
    const stream = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m","model":"m","usage":{"input_tokens":10,"output_tokens":1}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');

    const { events } = anthropicDriver.parseStream(stream, undefined);
    const stop = events[events.length - 1];
    expect(stop).toMatchObject({ type: 'message_stop', usage: { inputTokens: 10, outputTokens: 25 } });
    expect(stop).not.toMatchObject({ usage: { outputTokens: 26 } });
  });

  it('emits a tool use with the accumulated input', () => {
    const stream = [
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      '',
    ].join('\n');

    const { events } = anthropicDriver.parseStream(stream, undefined);
    expect(eventTypes(events)).toEqual(['tool_use']);
    expect(events[0]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.ts' } });
  });

  it('maps a whole message delivered over SSE', () => {
    const body = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { path: 'b.ts' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 4 },
    };
    const { events } = anthropicDriver.parseStream(`data: ${JSON.stringify(body)}\n\n`, undefined);
    expect(eventTypes(events)).toEqual(['message_start', 'text_delta', 'tool_use', 'message_stop']);
    expect(events[3]).toMatchObject({ type: 'message_stop', stopReason: 'tool_use' });
  });

  it('maps the message event\'s id and role', () => {
    const body = {
      id: 'msg_role',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    };
    const { events } = anthropicDriver.parseStream(`event: message\ndata: ${JSON.stringify(body)}\n\n`, undefined);
    expect(events[0]).toMatchObject({ type: 'message_start', messageId: 'msg_role', role: 'assistant' });
    expect(eventTypes(events)).toEqual(['message_start', 'text_delta', 'message_stop']);
  });

  it('parses a non-streaming body into the same events', () => {
    const { events } = anthropicDriver.parseNonStreaming({
      id: 'msg_3',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(eventTypes(events)).toEqual(['message_start', 'text_delta', 'message_stop']);
    expect(events[0]).toMatchObject({ messageId: 'msg_3', usage: { inputTokens: 1, outputTokens: 2 } });
  });
});

/* -------------------------------------------------------------------------- */
/* The frame parser                                                             */
/* -------------------------------------------------------------------------- */

describe('the SSE frame parser', () => {
  it('joins a multi-line data payload with a newline', () => {
    const frame = parseSseFrame('event: content_block_delta\ndata: {"type":"content_block_delta",\ndata: "index":0}');
    expect(frame?.data).toBe('{"type":"content_block_delta",\n"index":0}');
    expect(frame?.event).toBe('content_block_delta');
  });

  it('ignores the id and retry lines', () => {
    const frame = parseSseFrame('id: 42\nretry: 1000\ndata: {"type":"message_stop"}');
    expect(frame?.data).toBe('{"type":"message_stop"}');
    expect(frame?.event).toBeUndefined();
  });

  it('ignores a comment-only frame', () => {
    expect(parseSseFrame(': keep-alive')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The default parseResponse                                                    */
/* -------------------------------------------------------------------------- */

describe('the default parseResponse', () => {
  it('returns null for a 204', async () => {
    expect(await parseResponse(fakeResponse({ status: 204 }))).toBeNull();
  });

  it('returns the raw response for a binary response', async () => {
    const response = fakeResponse({ contentType: 'application/octet-stream' });
    expect(await parseResponse(response, { binaryResponse: true })).toBe(response);
  });

  it('parses a JSON body and attaches the request and workspace ids, non-enumerably', async () => {
    const response = fakeResponse({
      contentType: 'application/json',
      body: { id: 'msg_1', type: 'message', role: 'assistant' },
      headers: { 'request-id': 'req_123', 'anthropic-workspace-id': 'ws_9' },
    });

    const parsed = await parseResponse(response);
    expect(parsed).toEqual({ id: 'msg_1', type: 'message', role: 'assistant' });

    const body = parsed as Record<string, unknown>;
    // The identifiers are **not** part of the message: they must not be
    // enumerable.
    expect(Object.keys(body)).not.toContain('_request_id');
    expect(Object.keys(body)).not.toContain('_workspace_id');
    expect(body['_request_id']).toBe('req_123');
    expect(body['_workspace_id']).toBe('ws_9');
  });

  it('parses a JSON body whose content type carries a suffix', async () => {
    const response = fakeResponse({ contentType: 'application/vnd.api+json', body: { id: 'msg_2' } });
    expect(await parseResponse(response)).toEqual({ id: 'msg_2' });
  });

  it('returns undefined for a JSON body of length zero', async () => {
    const response = fakeResponse({
      contentType: 'application/json',
      headers: { 'content-length': '0' },
      body: { id: 'msg_3' },
    });
    expect(await parseResponse(response)).toBeUndefined();
  });

  it('falls back to the response text', async () => {
    const response = fakeResponse({ contentType: 'text/plain', text: 'not json at all' });
    expect(await parseResponse(response)).toBe('not json at all');
  });

  it('returns the SSE events for a streaming request', async () => {
    const response = fakeResponse({
      contentType: 'text/event-stream',
      text: 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","model":"m"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    });

    const stream = (await parseResponse(response, { stream: true })) as AsyncIterable<ProviderEvent>;
    const events: ProviderEvent[] = [];
    for await (const event of stream) events.push(event);
    expect(eventTypes(events)).toEqual(['message_start', 'message_stop']);
  });

  it('throws with the offending data and the raw chunk on a parse failure', () => {
    // **Observed** (audit §2.2): "a parse failure throws with the offending
    // data and raw chunk".
    expect(() => anthropicDriver.parseStream('event: message_stop\ndata: not-json\n\n', undefined)).toThrow(
      /not-json/,
    );
    let caught: unknown;
    try {
      anthropicDriver.parseStream('event: message_stop\ndata: not-json\n\n', undefined);
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain('not-json');
    expect(message).toContain('event: message_stop');
  });
});

/* -------------------------------------------------------------------------- */
/* Step 11 — the eight routes                                                   */
/* -------------------------------------------------------------------------- */

describe('the route set', () => {
  it('has a driver for each of the eight routes, and the driver names its route', () => {
    for (const route of ROUTE_NAMES) {
      expect(driverFor(route).route).toBe(route);
    }
    expect(listDrivers()).toHaveLength(8);
  });

  it('rejects a route that is not one of the eight', () => {
    expect(() => driverFor('constructor' as ProviderRoute)).toThrow(/unknown provider route/);
    expect(() => driverFor('nope' as ProviderRoute)).toThrow(/unknown provider route/);
  });
});

describe('the bedrock driver', () => {
  const bedrockRequest = (overrides: Partial<ProviderRequest> = {}): ProviderRequest =>
    request({ model: 'us.anthropic.claude-sonnet-4-5-v1:0', aws: { region: 'us-east-1' }, ...overrides });

  it('posts to the invoke path, and to the streaming path when the request streams', () => {
    expect(bedrockDriver.buildUrl(bedrockRequest())).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-v1:0/invoke',
    );
    expect(bedrockDriver.buildUrl(bedrockRequest({ stream: true }))).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-v1:0/invoke-with-response-stream',
    );
  });

  it('deletes the model and the stream flag from the body', () => {
    const body = bodyOf(bedrockDriver, bedrockRequest({ stream: true }));
    expect(Object.hasOwn(body, 'model')).toBe(false);
    expect(Object.hasOwn(body, 'stream')).toBe(false);
  });

  it('sets the anthropic version literal when the body does not carry one', () => {
    expect(bodyOf(bedrockDriver, bedrockRequest())['anthropic_version']).toBe(BEDROCK_ANTHROPIC_VERSION);
    expect(BEDROCK_ANTHROPIC_VERSION).toBe('bedrock-2023-05-31');
  });

  it('moves the anthropic-beta header into the body, split on commas and trimmed', () => {
    const built = bedrockDriver.buildBody(
      bedrockRequest({ betaFlags: [' first-beta ', 'second-beta'] }),
      undefined,
    );
    const body = built.body as Record<string, unknown>;
    expect(body['anthropic_beta']).toEqual(['first-beta', 'second-beta']);
    // "Moved": the header does not survive alongside the body field.
    expect(Object.hasOwn(built.headers, 'anthropic-beta')).toBe(false);
  });

  it('keeps an anthropic_beta the body already carries', () => {
    const rewritten = rewriteBedrockBody(
      { anthropic_beta: ['already-there'], model: 'm', stream: true },
      { path: '/v1/messages', model: 'm', stream: false },
    );
    expect(rewritten['anthropic_beta']).toEqual(['already-there']);
  });

  it('deletes the beta search parameter on the way out', () => {
    expect(stripBetaSearchParam('/v1/messages?beta=true')).toBe('/v1/messages');
    // A multi-valued parameter survives.
    expect(stripBetaSearchParam('/v1/messages?beta=true&x=1&x=2')).toBe('/v1/messages?x=1&x=2');
  });

  it('deletes the beta search parameter without re-encoding the rest of the query', () => {
    // A SigV4 signature covers the **canonical query**, so the surviving
    // parameters must keep their bytes.
    expect(stripBetaSearchParam('/v1/messages?beta=true&q=a%20b')).toBe('/v1/messages?q=a%20b');
    expect(stripBetaSearchParam('/v1/messages?beta=true&x=1&x=2')).toBe('/v1/messages?x=1&x=2');
    expect(stripBetaSearchParam('/v1/messages?beta=true&r=%2Fx&s=a+b')).toBe('/v1/messages?r=%2Fx&s=a+b');
    // A parameter whose name merely starts with `beta` survives.
    expect(stripBetaSearchParam('/v1/messages?beta=true&betax=1')).toBe('/v1/messages?betax=1');
  });

  it('rewrites the beta path variant to the same outbound path', () => {
    // The beta marker never reaches the wire: the rewritten path carries no
    // query at all.
    expect(bedrockDriver.buildUrl(bedrockRequest({ betaFlags: ['a'] }))).toBe(
      bedrockDriver.buildUrl(bedrockRequest()),
    );
  });

  it('rewrites exactly the three paths the target rewrites', () => {
    // **Observed** (audit §2.2a): "The rewritten paths are exactly
    // `/v1/complete`, `/v1/messages`, and `/v1/messages?beta=true`."
    expect(bedrockRewritePath('/v1/complete', { model: 'm', stream: false })).toBe('/model/m/invoke');
    expect(bedrockRewritePath('/v1/messages', { model: 'm', stream: false })).toBe('/model/m/invoke');
    expect(bedrockRewritePath('/v1/messages', { model: 'm', stream: true })).toBe(
      '/model/m/invoke-with-response-stream',
    );
    // The `beta` marker is deleted on the way out.
    expect(bedrockRewritePath('/v1/messages?beta=true', { model: 'm', stream: false })).toBe('/model/m/invoke');
    expect(() => bedrockRewritePath('/v1/nope', { model: 'm', stream: false })).toThrow(/rewrites only/);
  });

  it('throws the target\'s exact error for a body that is not a JSON object', () => {
    expect(() => rewriteBedrockBody('not-an-object', { path: '/v1/messages', model: 'm', stream: false })).toThrow(
      'Expected request body to be a JSON object for post /v1/messages',
    );
    expect(() => rewriteBedrockBody(null, { path: '/v1/messages', model: 'm', stream: false })).toThrow(
      /Expected request body to be a JSON object for post \/v1\/messages/,
    );
  });

  it('names the request\'s own path in the non-JSON-body error', () => {
    // The error is reachable **through the driver**, and it names the path the
    // request is actually posted to.
    expect(() => bedrockDriver.rewriteBody('not-an-object', bedrockRequest())).toThrow(
      'Expected request body to be a JSON object for post /model/us.anthropic.claude-sonnet-4-5-v1:0/invoke',
    );
  });

  it('throws the target\'s exact error for a missing region', () => {
    expect(() => bedrockDriver.buildUrl(request())).toThrow(AWS_REGION_REQUIRED_ERROR);
    expect(AWS_REGION_REQUIRED_ERROR).toBe(
      "Expected 'awsRegion' option to be passed to the client or the 'AWS_REGION' environment variable",
    );
  });

  it('lets a bearer token take precedence over SigV4', () => {
    const headers = headersOf(bedrockDriver, bedrockRequest({ credentialKind: 'bearer' }), 'bedrock-bearer');
    expect(headers['authorization']).toBe('Bearer bedrock-bearer');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['x-amz-date']).toBeUndefined();
  });

  it('suppresses SigV4 entirely for a bearer request', () => {
    const headers = headersOf(bedrockDriver, bedrockRequest({ credentialKind: 'bearer' }), 'bedrock-bearer');
    expect(Object.hasOwn(headers, 'x-amz-security-token')).toBe(false);
  });

  it('signs with the bedrock service name', () => {
    // The service name reaches the transport through the request's signing
    // context: a transport cannot learn it from the URL.
    const req = bedrockRequest();
    headersOf(bedrockDriver, req, undefined);
    expect(req.aws?.service).toBe('bedrock');
  });

  it('refuses an HTTP token count and counts locally instead', () => {
    // **Observed** (audit §2.2): the token-counting call has "a
    // Bedrock-specific local fallback" — Bedrock has no count-tokens
    // endpoint.
    const req = bedrockRequest({ operation: 'count_tokens' });
    expect(() => bedrockDriver.buildUrl(req)).toThrow(BEDROCK_COUNT_TOKENS_LOCAL_MESSAGE);
    expect(bedrockCountTokensLocally(req)).toEqual({ input_tokens: 2 });
  });

  it('replaces the host header and deletes the connection header when signing', () => {
    const signed = bedrockSigningHeaders(
      { host: 'stale.example', connection: 'keep-alive', 'content-type': 'application/json' },
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/m/invoke',
    );
    expect(signed['host']).toBe('bedrock-runtime.us-east-1.amazonaws.com');
    expect(Object.hasOwn(signed, 'connection')).toBe(false);
    expect(signed['content-type']).toBe('application/json');
  });

  it('decodes the binary eventstream rather than assuming SSE', () => {
    const frame = bedrockFrame({
      type: 'message_start',
      message: { id: 'msg_b', model: 'us.anthropic.claude-sonnet-4-5-v1:0' },
    });
    const { events } = bedrockDriver.parseStream(frame, undefined);
    expect(eventTypes(events)).toEqual(['message_start']);
    expect(events[0]).toMatchObject({ messageId: 'msg_b' });
  });

  it('decodes a frame that carries the base64 bytes member', () => {
    const payload = { bytes: Buffer.from(JSON.stringify({ type: 'message_stop' }), 'utf8').toString('base64') };
    const frame = eventStreamFrame(payload).toString('latin1');
    const { events } = bedrockDriver.parseStream(frame, undefined);
    expect(eventTypes(events)).toEqual(['message_stop']);
  });

  it('keeps a Bedrock frame that straddles a chunk boundary', () => {
    const frame = bedrockFrame({ type: 'message_stop' });
    const cut = Math.floor(frame.length / 2);
    const first = bedrockDriver.parseStream(frame.slice(0, cut), undefined);
    expect(first.events).toHaveLength(0);
    const second = bedrockDriver.parseStream(frame.slice(cut), first.state);
    expect(eventTypes(second.events)).toEqual(['message_stop']);
  });
});

describe('the vertex driver', () => {
  const vertexRequest = (overrides: Partial<ProviderRequest> = {}): ProviderRequest =>
    request({
      model: 'claude-haiku-4-5@20251001',
      vertex: { projectId: 'proj-1', location: 'us-central1' },
      ...overrides,
    });

  it('posts to the rawPredict path, and to streamRawPredict when the request streams', () => {
    expect(vertexDriver.buildUrl(vertexRequest(), 'https://us-aiplatform.googleapis.com')).toBe(
      'https://us-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict',
    );
    expect(vertexDriver.buildUrl(vertexRequest({ stream: true }), 'https://us-aiplatform.googleapis.com')).toBe(
      'https://us-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/anthropic/models/claude-haiku-4-5@20251001:streamRawPredict',
    );
  });

  it('keeps the stream flag in the body but deletes the model', () => {
    const body = bodyOf(vertexDriver, vertexRequest({ stream: true }));
    expect(Object.hasOwn(body, 'model')).toBe(false);
    expect(body['stream']).toBe(true);
  });

  it('sets the anthropic version literal', () => {
    expect(bodyOf(vertexDriver, vertexRequest())['anthropic_version']).toBe(VERTEX_ANTHROPIC_VERSION);
    expect(VERTEX_ANTHROPIC_VERSION).toBe('vertex-2023-10-16');
  });

  it('deletes the beta search parameter on the way out', () => {
    // The rewritten path carries no query at all.
    expect(vertexDriver.buildUrl(vertexRequest({ betaFlags: ['a'] }))).toBe(
      vertexDriver.buildUrl(vertexRequest()),
    );
  });

  it('routes count_tokens to the count-tokens model', () => {
    expect(vertexDriver.buildUrl(vertexRequest({ operation: 'count_tokens' }))).toBe(
      'https://aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/anthropic/models/count-tokens:rawPredict',
    );
  });

  it('uses the regional host convention', () => {
    // **Observed** (research §1): `global` → `aiplatform.googleapis.com`, `us`
    // → `aiplatform.us.rep.googleapis.com`, `eu` →
    // `aiplatform.eu.rep.googleapis.com`, otherwise
    // `{region}-aiplatform.googleapis.com`.
    const at = (region: string): string =>
      vertexDriver.buildUrl(vertexRequest({ vertex: { projectId: 'proj-1', location: 'us-central1', region } }));

    expect(at('global')).toBe(
      'https://aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict',
    );
    expect(at('us')).toBe(
      'https://aiplatform.us.rep.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict',
    );
    expect(at('eu')).toBe(
      'https://aiplatform.eu.rep.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict',
    );
    expect(at('asia-east1')).toBe(
      'https://asia-east1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/publishers/anthropic/models/claude-haiku-4-5@20251001:rawPredict',
    );
  });

  it('throws the target\'s exact error for a missing project', () => {
    expect(() => vertexDriver.buildUrl(request())).toThrow(VERTEX_MISSING_PROJECT_ERROR);
    expect(VERTEX_MISSING_PROJECT_ERROR).toBe(
      "No projectId was given and it could not be resolved from credentials. The client should be instantiated with the 'projectId' option or the 'ANTHROPIC_VERTEX_PROJECT_ID' environment variable should be set.",
    );
  });

  it('authenticates with a Google bearer and never an Anthropic api key', () => {
    const headers = headersOf(vertexDriver, vertexRequest(), 'ya29.token');
    expect(headers['authorization']).toBe('Bearer ya29.token');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('never sends an Anthropic api key, even when the request asks for one', () => {
    const headers = headersOf(vertexDriver, vertexRequest({ credentialKind: 'apiKey' }), 'sk-ant');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['authorization']).toBe('Bearer sk-ant');
  });

  it('publishes the Google OAuth2 scope for the transport', () => {
    // The scope has to have a home: the driver writes it into the request's
    // token context and the transport reads it there.
    const req = vertexRequest();
    headersOf(vertexDriver, req, 'ya29.token');
    expect(req.tokenScope).toBe('cloud-platform');
  });

  it('reads only one anthropic-beta header, so the flags share one header', () => {
    // Google Cloud reads only **one** `anthropic-beta` header and ignores the
    // rest, so multiple betas must travel in a single header.
    const headers = headersOf(vertexDriver, vertexRequest({ betaFlags: ['a', 'b'] }), 'ya29.token');
    expect(headers['anthropic-beta']).toBe('a,b');
  });
});

describe('the foundry driver', () => {
  it('posts to the anthropic path of the deployment', () => {
    const req = request({
      endpoint: {
        baseUrl: 'https://my-deployment.services.ai.azure.com',
        isVendorHost: true,
        suppliedBaseUrlVariables: ['ANTHROPIC_FOUNDRY_RESOURCE'],
      },
    });
    expect(foundryDriver.buildUrl(req)).toBe(
      'https://my-deployment.services.ai.azure.com/anthropic/v1/messages',
    );
  });

  it('builds the audited resource base url, with its trailing slash', () => {
    // **Observed** (audit §2.2a): the base URL is built as
    // `https://<resource>.services.ai.azure.com/anthropic/` — with a trailing
    // slash. The audited URL is the one the **driver** produces.
    const req = request({
      endpoint: {
        baseUrl: 'https://my-deployment.services.ai.azure.com',
        isVendorHost: true,
        suppliedBaseUrlVariables: ['ANTHROPIC_FOUNDRY_RESOURCE'],
      },
    });
    expect(foundryDriver.baseUrlFor(req)).toBe('https://my-deployment.services.ai.azure.com/anthropic/');
    expect(foundryDriver.baseUrlFor(request({ foundryResource: 'other-deployment' }))).toBe(
      'https://other-deployment.services.ai.azure.com/anthropic/',
    );
  });

  it('throws the target\'s exact error when a base url and a resource conflict', () => {
    const req = request({
      endpoint: {
        baseUrl: 'https://my-deployment.services.ai.azure.com',
        isVendorHost: true,
        suppliedBaseUrlVariables: ['ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE'],
        conflictingVariables: ['ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_RESOURCE'],
      },
    });
    expect(() => foundryDriver.buildUrl(req)).toThrow(FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR);
    expect(FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR).toBe('baseURL and resource are mutually exclusive');
  });

  it('throws the target\'s exact error when neither a base url nor a resource is given', () => {
    const req = request({
      endpoint: { baseUrl: 'https://{resource}.services.ai.azure.com', isVendorHost: true },
    });
    expect(() => foundryDriver.buildUrl(req)).toThrow(FOUNDRY_MISSING_BASE_URL_ERROR);
    expect(FOUNDRY_MISSING_BASE_URL_ERROR).toBe(
      "Must provide one of the 'baseURL' or 'resource' arguments, or the ANTHROPIC_FOUNDRY_RESOURCE environment variable",
    );
  });

  it('sends the deployment name as the model', () => {
    const body = bodyOf(foundryDriver, request({ model: 'my-deployment' }));
    expect(body['model']).toBe('my-deployment');
  });

  it('sends an api key or an Azure AD bearer, never both', () => {
    const apiKey = headersOf(foundryDriver, request({ credentialKind: 'apiKey' }), 'azure-key');
    expect(apiKey['x-api-key']).toBe('azure-key');
    expect(apiKey['authorization']).toBeUndefined();

    const bearer = headersOf(foundryDriver, request({ credentialKind: 'bearer' }), 'aad-token');
    expect(bearer['authorization']).toBe('Bearer aad-token');
    expect(bearer['x-api-key']).toBeUndefined();
  });

  it('throws the target\'s exact error when both credential sources are supplied', () => {
    // **Observed** (audit §2.2a): `apiKey` and `azureADTokenProvider` are
    // mutually exclusive.
    const req = request({
      credentialSources: { apiKey: 'azure-key', azureADToken: 'aad-token' },
    });
    expect(() => foundryDriver.buildHeaders(req, undefined)).toThrow(
      FOUNDRY_CREDENTIALS_MUTUALLY_EXCLUSIVE_ERROR,
    );
    expect(FOUNDRY_CREDENTIALS_MUTUALLY_EXCLUSIVE_ERROR).toBe(
      "The 'apiKey' and 'azureADTokenProvider' arguments are mutually exclusive; only one can be passed at a time.",
    );
  });

  it('throws the target\'s exact error when no credential source is supplied', () => {
    // The target's own message names `azureTokenProvider` while the parameter
    // is `azureADTokenProvider`; this implementation reproduces it verbatim.
    expect(() => foundryDriver.buildHeaders(request({ credentialSources: {} }), undefined)).toThrow(
      FOUNDRY_MISSING_CREDENTIALS_ERROR,
    );
    expect(FOUNDRY_MISSING_CREDENTIALS_ERROR).toBe(
      "Missing credentials. Please pass one of 'apiKey' and 'azureTokenProvider', or set the ANTHROPIC_FOUNDRY_API_KEY environment variable.",
    );
  });

  it('sends the credential the request\'s sources name', () => {
    const apiKey = headersOf(
      foundryDriver,
      request({ credentialSources: { apiKey: 'azure-key' } }),
      'resolved-key',
    );
    expect(apiKey['x-api-key']).toBe('azure-key');

    const bearer = headersOf(
      foundryDriver,
      request({ credentialKind: 'bearer', credentialSources: { azureADToken: 'aad-token' } }),
      'resolved-token',
    );
    expect(bearer['authorization']).toBe('Bearer aad-token');
  });

  it('publishes the Azure AD scope for the transport', () => {
    // The scope has to have a home: the driver writes it into the request's
    // token context and the transport reads it there.
    const req = request();
    headersOf(foundryDriver, req, 'azure-key');
    expect(req.tokenScope).toBe('https://ai.azure.com/.default');
  });

  it('exposes no models API', () => {
    // **Observed** (audit §2.2a): "The Foundry adapter exposes **no models
    // API** (`models` is `undefined`)." A Foundry connection's model list comes
    // from the catalog, not from the provider.
    expect('models' in foundryDriver).toBe(false);
  });
});

describe('the mantle driver', () => {
  it('posts to the anthropic path of the mantle base url', () => {
    expect(mantleDriver.buildUrl(request({ aws: { region: 'us-east-1' } }))).toBe(
      'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages',
    );
  });

  it('keeps the model and the stream flag in the body', () => {
    const body = bodyOf(mantleDriver, request({ stream: true, aws: { region: 'us-east-1' } }));
    expect(body['model']).toBe('claude-sonnet-4-5');
    expect(body['stream']).toBe(true);
  });

  it('travels the betas in the anthropic-beta header next to the anthropic version', () => {
    const headers = headersOf(mantleDriver, request({ betaFlags: ['a-beta'], aws: { region: 'us-east-1' } }), undefined);
    expect(headers['anthropic-beta']).toBe('a-beta');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('signs with the bedrock-mantle service name, not bedrock\'s', () => {
    // The service name is the one thing that makes Mantle a driver of its
    // own, so it reaches the transport through the request's signing context.
    const req = request({ aws: { region: 'us-east-1' } });
    headersOf(mantleDriver, req, undefined);
    expect(req.aws?.service).toBe('bedrock-mantle');
  });

  it('takes a bearer token when the request names one', () => {
    const headers = headersOf(
      mantleDriver,
      request({ credentialKind: 'bearer', aws: { region: 'us-east-1' } }),
      'mantle-bearer',
    );
    expect(headers['authorization']).toBe('Bearer mantle-bearer');
    expect(headers['x-api-key']).toBeUndefined();
  });
});

describe('the anthropic-on-aws and anthropic-on-google-cloud drivers', () => {
  it('carry a workspace id header', () => {
    const aws = headersOf(
      anthropicAwsDriver,
      request({ workspaceId: 'ws_1', aws: { region: 'us-east-1' } }),
      undefined,
    );
    expect(aws['anthropic-workspace-id']).toBe('ws_1');

    const google = headersOf(anthropicGoogleCloudDriver, request({ workspaceId: 'ws_2' }), undefined);
    expect(google['anthropic-workspace-id']).toBe('ws_2');
  });

  it('keep the anthropic-native body', () => {
    const body = bodyOf(anthropicGoogleCloudDriver, request({ stream: true }));
    expect(body['model']).toBe('claude-sonnet-4-5');
    expect(body['stream']).toBe(true);
  });

  it('authenticate the google route with a cloud-platform bearer', () => {
    const headers = headersOf(anthropicGoogleCloudDriver, request(), 'ya29.token');
    expect(headers['authorization']).toBe('Bearer ya29.token');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('authenticate the aws route with an AWS credential chain, not an api key', () => {
    const headers = headersOf(anthropicAwsDriver, request({ aws: { region: 'us-east-1' } }), undefined);
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
  });

  it('signs the aws route with its own service name', () => {
    const req = request({ aws: { region: 'us-east-1' } });
    headersOf(anthropicAwsDriver, req, undefined);
    expect(req.aws?.service).toBe('anthropic');
  });

  it('publishes the Google OAuth2 scope for the google route', () => {
    const req = request();
    headersOf(anthropicGoogleCloudDriver, req, 'ya29.token');
    expect(req.tokenScope).toBe('cloud-platform');
  });
});

describe('the gateway driver', () => {
  it('posts to the messages path and the count_tokens path', () => {
    expect(gatewayDriver.buildUrl(request(), 'https://gateway.example.com')).toBe(
      'https://gateway.example.com/v1/messages',
    );
    expect(gatewayDriver.buildUrl(request({ operation: 'count_tokens' }), 'https://gateway.example.com')).toBe(
      'https://gateway.example.com/v1/messages/count_tokens',
    );
  });

  it('extends the first-party user agent with the cc-gateway agent', () => {
    // **Observed** (audit §2.3): the gateway "sets or extends the user agent
    // to `cc-gateway/2.1.303`".
    const headers = headersOf(gatewayDriver, request(), 'jwt');
    expect(headers['user-agent']).toBe(`${SDK_USER_AGENT} cc-gateway/2.1.303`);
    expect(GATEWAY_USER_AGENT).toBe('cc-gateway/2.1.303');
  });

  it('extends an existing user agent rather than replacing it', () => {
    const driver = createGatewayDriver({ version: '9.9.9' });
    const headers = driver.buildHeaders(request({ extraHeaders: { 'user-agent': 'implementation/0.1.0' } }), 'jwt');
    expect(headers['user-agent']).toBe('implementation/0.1.0 cc-gateway/9.9.9');
  });

  it('rejects a request whose body carries a workspace id', () => {
    expect(gatewayRejectsWorkspaceId({ workspace_id: 'ws_1' })).toBe(true);
    expect(gatewayRejectsWorkspaceId({ other: 1 })).toBe(false);

    const rejection = gatewayWorkspaceIdRejection();
    expect(rejection.status).toBe(400);
    expect(rejection.type).toBe('invalid_request_error');
    expect(rejection.message).toBe(GATEWAY_WORKSPACE_ID_MESSAGE);

    let caught: unknown;
    try {
      gatewayDriver.buildBody(request({ workspaceId: 'ws_1' }), 'jwt');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayRequestError);
    expect((caught as GatewayRequestError).status).toBe(400);
    expect((caught as GatewayRequestError).type).toBe('invalid_request_error');
    expect((caught as GatewayRequestError).message).toBe(GATEWAY_WORKSPACE_ID_MESSAGE);
    expect(GATEWAY_WORKSPACE_ID_MESSAGE).toBe('workspace_id: not supported through the gateway');
  });

  it('never puts a workspace id into the body it builds', () => {
    // The gateway refuses a workspace id, so it does not write one into the
    // body and then reject its own request.
    const built = gatewayDriver.buildBody(request(), 'jwt');
    expect(Object.hasOwn(built.body as Record<string, unknown>, 'workspace_id')).toBe(false);
  });

  it('refuses a workspace-id request before it builds a body', () => {
    // The rejection happens **first**: the gateway does not build a body it is
    // going to refuse.
    let read = false;
    const req: ProviderRequest = {
      model: 'claude-sonnet-4-5',
      maxTokens: 1024,
      get messages(): ProviderMessage[] {
        read = true;
        return [{ role: 'user', content: 'hello' }];
      },
      tools: [],
      stream: false,
      workspaceId: 'ws_1',
    };

    expect(() => gatewayDriver.buildBody(req, 'jwt')).toThrow(GatewayRequestError);
    expect(read).toBe(false);
  });

  it('counts tokens locally for a Bedrock upstream', () => {
    const response = gatewayCountTokensResponse('bedrock', {
      messages: [{ role: 'user', content: 'a'.repeat(40) }],
    });
    expect(response.status).toBe(200);
    expect(response.body['input_tokens']).toBe(10);
  });

  it('estimates a token count from a text without materialising a copy of it', () => {
    expect(estimateTokenCount('a'.repeat(40))).toBe(10);
    expect(estimateTokenCount('')).toBe(0);
    expect(estimateTokenCount('abc')).toBe(1);
  });

  it('answers 501 not_supported with x-should-retry false for any other upstream', () => {
    const response = gatewayCountTokensResponse('vertex', { messages: [] });
    expect(response.status).toBe(501);
    expect(response.headers['x-should-retry']).toBe('false');
    expect(response.body).toMatchObject({ type: 'error', error: { type: 'not_supported' } });
    expect(gatewayCountTokensUnsupported().status).toBe(501);
  });

  it('re-frames the upstream stream as SSE with keep-alives and a rewritten model', () => {
    const upstream = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"upstream-model"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');

    const reframed = reframeAsSse(upstream, { wireModel: 'wire-model' });
    expect(reframed).toContain('"model":"wire-model"');
    expect(reframed).not.toContain('upstream-model');
    expect(reframed).toContain(': keep-alive');
    expect(reframed).toContain('event: message_stop');
  });

  it('emits an event: error frame on an upstream failure', () => {
    // **Observed** (audit §2.3): the gateway "emits `event: error` frames on
    // an upstream failure".
    const frame = gatewayErrorFrame('the upstream exploded', 502);
    expect(frame.startsWith('event: error\ndata: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);

    const payload = JSON.parse(frame.slice('event: error\ndata: '.length)) as Record<string, unknown>;
    expect(payload).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'the upstream exploded', status: 502 },
    });

    // The frame is a frame the SSE parser understands.
    const { events } = gatewayDriver.parseStream(frame, undefined);
    expect(events[0]).toMatchObject({ type: 'error', message: 'the upstream exploded', status: 502 });
  });

  it('moves the anthropic-beta header into the body for a Bedrock upstream', () => {
    const moved = gatewayMoveBetaHeaderIntoBody({}, { 'anthropic-beta': ' a , b ' });
    expect(moved['anthropic_beta']).toEqual(['a', 'b']);

    // The body field wins when it already carries one.
    const kept = gatewayMoveBetaHeaderIntoBody({ anthropic_beta: ['already'] }, { 'anthropic-beta': 'a' });
    expect(kept['anthropic_beta']).toEqual(['already']);
  });

  it('forwards to the upstream with the upstream\'s auth and base url', () => {
    // **Observed** (audit §2.3): the gateway "applies the upstream provider's
    // auth (`client.applyAuth(headers)`) and the provider's base URL".
    const req = request({
      credentialKind: 'bearer',
      betaFlags: ['a-beta'],
      aws: { region: 'us-east-1' },
    });

    const forwarded = gatewayUpstreamRequest(
      { driver: bedrockDriver, credential: 'bedrock-bearer' },
      req,
      { headers: { authorization: 'Bearer gateway-jwt', 'anthropic-beta': 'a-beta' } },
    );

    expect(forwarded.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/claude-sonnet-4-5/invoke',
    );
    // The upstream's auth replaces the gateway's own.
    expect(forwarded.headers['authorization']).toBe('Bearer bedrock-bearer');
    expect(forwarded.headers['x-api-key']).toBeUndefined();

    const body = forwarded.body as Record<string, unknown>;
    expect(body['anthropic_beta']).toEqual(['a-beta']);
    expect(body['anthropic_version']).toBe('bedrock-2023-05-31');
    expect(Object.hasOwn(body, 'model')).toBe(false);
  });

  it('never forwards the gateway\'s own credential to the upstream', () => {
    // An upstream without a credential of its own must not receive the
    // gateway's own auth.
    const req = request({ credentialKind: 'bearer', aws: { region: 'us-east-1' } });
    const forwarded = gatewayUpstreamRequest({ driver: bedrockDriver }, req, {
      headers: { authorization: 'Bearer gateway-jwt', 'x-api-key': 'gateway-key' },
    });
    expect(forwarded.headers['authorization']).toBeUndefined();
    expect(forwarded.headers['x-api-key']).toBeUndefined();
  });

  it('sends a count-tokens body without the generation knobs', () => {
    const body = bodyOf(
      gatewayDriver,
      request({ operation: 'count_tokens', stream: true, temperature: 0.5 }),
    );
    expect(Object.hasOwn(body, 'max_tokens')).toBe(false);
    expect(Object.hasOwn(body, 'stream')).toBe(false);
    expect(Object.hasOwn(body, 'temperature')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 13a / 13b — the beta dialects                                           */
/* -------------------------------------------------------------------------- */

describe('the beta dialects', () => {
  it('translates a beta name whose spelling differs per platform', () => {
    // Bedrock rejects the **whole** request for a flag it does not know, so a
    // driver must translate rather than copy the flag verbatim.
    expect(bedrockDriver.betaFlagsFor(['tool-search-tool-2025-10-19'])).toEqual(['advanced-tool-use-2025-11-20']);
    expect(anthropicDriver.betaFlagsFor(['tool-search-tool-2025-10-19'])).toEqual(['tool-search-tool-2025-10-19']);
  });

  it('translates the bedrock spelling back for the first-party routes', () => {
    expect(anthropicDriver.betaFlagsFor(['advanced-tool-use-2025-11-20'])).toEqual(['tool-search-tool-2025-10-19']);
    expect(gatewayDriver.betaFlagsFor(['advanced-tool-use-2025-11-20'])).toEqual(['tool-search-tool-2025-10-19']);
  });

  it('trims the per-dialect list before it is placed in the body array', () => {
    expect(bedrockDriver.betaFlagsFor(['  spaced  ', '', 'other'])).toEqual(['spaced', 'other']);

    const built = bedrockDriver.buildBody(
      request({ betaFlags: ['  spaced  ', 'other'], aws: { region: 'us-east-1' } }),
      undefined,
    );
    expect((built.body as Record<string, unknown>)['anthropic_beta']).toEqual(['spaced', 'other']);
  });

  it('drops a duplicate after the translation', () => {
    expect(
      translateBetaFlags(['tool-search-tool-2025-10-19', 'advanced-tool-use-2025-11-20'], 'bedrock'),
    ).toEqual(['advanced-tool-use-2025-11-20']);
  });

  it('splits a comma-separated beta header into trimmed parts', () => {
    expect(splitCommaList(' a , b ,, c ')).toEqual(['a', 'b', 'c']);
  });

  it('surfaces an upstream 400 for a rejected beta flag instead of retrying it', () => {
    // The beta-specific part: the flag that was **sent** is the Bedrock
    // spelling, and the upstream's rejection of it is surfaced verbatim.
    const built = bedrockDriver.buildBody(
      request({ betaFlags: ['tool-search-tool-2025-10-19'], aws: { region: 'us-east-1' } }),
      undefined,
    );
    const body = built.body as Record<string, unknown>;
    expect(body['anthropic_beta']).toEqual(['advanced-tool-use-2025-11-20']);

    const classified = bedrockDriver.classifyError(400, {
      error: { message: 'invalid beta flag: advanced-tool-use-2025-11-20' },
    });
    expect(classified.retryable).toBe(false);
    expect(classified.message).toBe('invalid beta flag: advanced-tool-use-2025-11-20');
  });
});

/* -------------------------------------------------------------------------- */
/* Step 13c / 13d — the non-streaming timeout                                   */
/* -------------------------------------------------------------------------- */

describe('the non-streaming timeout', () => {
  it('is derived from max_tokens', () => {
    const small = anthropicDriver.calculateNonstreamingTimeout(100, undefined);
    const large = anthropicDriver.calculateNonstreamingTimeout(10_000, undefined);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });

  it('never exceeds the 600000 ms fallback', () => {
    for (const driver of listDrivers()) {
      expect(driver.calculateNonstreamingTimeout(1_000_000, undefined)).toBe(NONSTREAMING_TIMEOUT_FALLBACK_MS);
      expect(driver.calculateNonstreamingTimeout(1_000_000, 10_000_000)).toBe(NONSTREAMING_TIMEOUT_FALLBACK_MS);
    }
    expect(NONSTREAMING_TIMEOUT_FALLBACK_MS).toBe(600_000);
  });

  it('is bounded by the model\'s own limit', () => {
    expect(anthropicDriver.calculateNonstreamingTimeout(100_000, 5_000)).toBe(5_000);
  });

  it('uses an explicit timeout unchanged', () => {
    expect(resolveRequestTimeout(request({ timeout: 1_234 }), 600_000)).toBe(1_234);
    expect(resolveRequestTimeout(request(), 600_000)).toBe(anthropicDriver.calculateNonstreamingTimeout(1024, 600_000));
  });
});
