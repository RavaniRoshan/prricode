/**
 * Contract test for the model layer.
 *
 * **The specification:** [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md).
 * The specification is the contract; this test pins what it promises, and the
 * conformance document records the readings taken where the specification left
 * a choice open.
 *
 * **Owning task:** `CC-044`.
 *
 * What this test pins:
 *
 *   - **a provider is data**: the entry carries the dialect, the endpoint, the
 *     credential *reference*, the headers and the models — and the entry never
 *     carries a secret;
 *   - **the dialect seam**: one code path per shape, and a provider's own
 *     behaviour layered on top as data;
 *   - **the catalogue's load order**: a local override, then the fetched list,
 *     then the shipped snapshot — and a fetch that returns the same bytes
 *     changes nothing;
 *   - **the overlays**: an effort, a thinking toggle and a token budget, each
 *     applied from the *catalogue's* spelling, and re-spelled when the
 *     effective dialect changes;
 *   - **the credentials**: a store keyed by *integration*, in three kinds, with
 *     the connections **derived** and the environment a first-class peer of a
 *     stored key;
 *   - **"connected" is one predicate**, and the whole picker follows from it;
 *   - **the selection grammar** `provider/model#overlay`, the precedence, the
 *     three persistence stores, and the loud failure when a named model is not
 *     available;
 *   - **the whole path** — the request, the streaming reply, the tool calls and
 *     the model list — against a **real HTTP server on a real port** that
 *     speaks both shapes, and against a backend that **fails**.
 *
 * **No vendor is named anywhere in this file.** The model ids are the
 * catalogue's own data and are deliberately neutral, and the shapes are named
 * by their capability.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DIALECTS,
  isDialect,
  type CatalogueDocument,
  type ContentPart,
  type Dialect,
  type ModelEntry,
  type ModelMessage,
  type ModelTool,
  type Overlay,
  type ProviderEntry,
} from '../../src/model/types.js';
import {
  DEFAULT_OVERLAY_NAME,
  applyOverlay,
  emptyOverlayTarget,
  findOverlay,
  overlayNames,
  resolveOverlay,
  withOverlay,
} from '../../src/model/overlays.js';
import { ProviderTable, aliasProvider, resolveProvider } from '../../src/model/provider.js';
import { ModelCatalogue, mergeCatalogues } from '../../src/model/catalogue.js';
import {
  MemoryCredentialStore,
  connectionIdentity,
  createEncryptedFileSecretStore,
  createKeychainSecretStore,
  deriveConnections,
  resolveProviderCredential,
  type Integration,
  type StoredCredential,
} from '../../src/model/credentials.js';
import { providerAvailability } from '../../src/model/availability.js';
import {
  formatModelRef,
  modelSatisfies,
  parseModelRef,
  selectModel,
  type ModelRef,
} from '../../src/model/selection.js';
import {
  DurableModelChoice,
  ModelPreferenceStore,
  createFileSessionRecordCarrier,
} from '../../src/model/preferences.js';
import { ModelEngine, ModelLayerError } from '../../src/model/engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A neutral model id. The engine must know nothing about what a model id contains. */
const ALPHA = 'alpha';
const BETA = 'beta';

/** The capabilities every fixture model carries unless it says otherwise. */
function capabilities(overrides: Partial<ModelEntry['capabilities']> = {}): ModelEntry['capabilities'] {
  return {
    input: ['text'],
    output: ['text'],
    temperature: true,
    tools: true,
    ...overrides,
  };
}

/** A model that carries no overlay and no reasoning support. */
function plainModel(id: string, provider: string): ModelEntry {
  return {
    id,
    provider,
    capabilities: capabilities(),
    overlays: [],
    reasoning: {},
    enabled: true,
  };
}

/**
 * A model that offers all three reasoning controls.
 *
 * The spellings are deliberately **different on every dialect**, so a test that
 * asserts where a field lands cannot pass by accident: the engine has to pick
 * the spelling of the *effective* dialect.
 */
function reasoningModel(id: string, provider: string): ModelEntry {
  const effort = (level: string): Overlay => ({
    kind: 'effort',
    name: level,
    effort: level,
    spellings: {
      chat: { fields: { reasoning_effort: level } },
      messages: { body: { output_config: { effort: level } } },
      responses: { fields: { reasoning: { effort: level } } },
    },
  });
  const toggle = (on: boolean): Overlay => ({
    kind: 'toggle',
    name: on ? 'thinking-on' : 'thinking-off',
    enabled: on,
    spellings: {
      chat: { fields: { thinking: on } },
      messages: { fields: { thinking: { type: on ? 'enabled' : 'disabled' } } },
      responses: { fields: { thinking: on } },
    },
  });
  const budget = (tokens: number): Overlay => ({
    kind: 'budget_tokens',
    name: `budget-${tokens}`,
    tokens,
    spellings: {
      chat: { fields: { max_reasoning_tokens: tokens } },
      messages: { fields: { thinking: { budget_tokens: tokens } } },
      responses: { fields: { max_output_tokens: tokens } },
    },
  });
  return {
    id,
    provider,
    capabilities: capabilities(),
    overlays: [effort('low'), effort('high'), toggle(true), toggle(false), budget(2048)],
    reasoning: {
      effort: { values: ['low', 'high'] },
      toggle: true,
      budget: { min: 256, max: 8192 },
    },
    enabled: true,
  };
}

/** A catalogue document holding one provider's models. */
function document(provider: string, models: readonly ModelEntry[]): CatalogueDocument {
  return { providers: [{ provider, models }] };
}

// ---------------------------------------------------------------------------
// The fake backend — a real HTTP server on a real port
// ---------------------------------------------------------------------------

/** A request the fake backend received. */
interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

interface FakeBackend {
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** The body of the last request, or `undefined` when nothing was sent. */
  lastRequest(): RecordedRequest | undefined;
  close(): Promise<void>;
}

interface FakeBackendOptions {
  /** The shape the backend answers on. */
  readonly dialect: Dialect;
  /** The model list the backend reports. */
  readonly models?: readonly ModelEntry[];
  /** When set, the backend refuses every request with this status. */
  readonly refuseWith?: number;
}

/** Read a request body as text. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The `data:` payload of a streamed reply, as one SSE frame. */
function sse(event: string | undefined, data: unknown): string {
  const head = event === undefined ? '' : `event: ${event}\n`;
  return `${head}data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Start a real HTTP server that speaks one of the two shapes.
 *
 * It is a **server**, not a stubbed function: the engine reaches it through
 * the platform's own `fetch`, over a real socket, on a real port.
 */
async function startFakeBackend(options: FakeBackendOptions): Promise<FakeBackend> {
  const requests: RecordedRequest[] = [];

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const raw = await readBody(request);
    let body: unknown;
    try {
      body = raw === '' ? undefined : JSON.parse(raw);
    } catch {
      body = raw;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers[name] = value;
    }
    requests.push({ method: request.method ?? '', path: request.url ?? '', headers, body });

    if (options.refuseWith !== undefined) {
      response.writeHead(options.refuseWith, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'the backend refused the request' } }));
      return;
    }

    const url = request.url ?? '';

    if (request.method === 'GET' && url.endsWith('/models')) {
      const models = options.models ?? [plainModel(ALPHA, 'fake')];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: models }));
      return;
    }

    if (request.method === 'POST' && url.endsWith('/chat/completions')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sse(undefined, { choices: [{ delta: { content: 'hello ' } }] }));
      response.write(
        sse(undefined, {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path":"a"}' } },
                ],
              },
            },
          ],
        }),
      );
      response.write(
        sse(undefined, {
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      );
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }

    if (request.method === 'POST' && url.endsWith('/messages')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 11 } } }),
      );
      response.write(
        sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      response.write(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello ' },
        }),
      );
      response.write(
        sse('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} },
        }),
      );
      response.write(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' },
        }),
      );
      response.write(sse('content_block_stop', { type: 'content_block_stop', index: 1 }));
      response.write(
        sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 7 },
        }),
      );
      response.write(sse('message_stop', { type: 'message_stop' }));
      response.end();
      return;
    }

    if (request.method === 'POST' && url.endsWith('/responses')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'hello ' }),
      );
      response.write(
        sse('response.output_item.added', {
          type: 'response.output_item.added',
          item: { type: 'function_call', id: 'call_1', call_id: 'call_1', name: 'read', arguments: '' },
        }),
      );
      response.write(
        sse('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: 'call_1',
          delta: '{"path":"a"}',
        }),
      );
      response.write(
        sse('response.completed', {
          type: 'response.completed',
          response: { usage: { input_tokens: 11, output_tokens: 7 } },
        }),
      );
      response.end();
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'no such path' } }));
  };

  const server: Server = createServer((request, response) => {
    void handler(request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    lastRequest: () => requests[requests.length - 1],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** A provider whose endpoint is the fake backend's. */
function fakeProvider(
  id: string,
  dialect: Dialect,
  endpoint: string,
  overrides: Partial<ProviderEntry> = {},
): ProviderEntry {
  return {
    id,
    dialect,
    endpoint,
    credential: { kind: 'none' },
    headers: {},
    models: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. A provider is data, and one engine speaks it
// ---------------------------------------------------------------------------

describe('a provider is data, and one engine speaks it', () => {
  it('names the three shapes and nothing else', () => {
    expect([...DIALECTS]).toEqual(['chat', 'messages', 'responses']);
    expect(isDialect('chat')).toBe(true);
    expect(isDialect('nonsense')).toBe(false);
  });

  it('carries the identity, the shape, the endpoint, the credential reference, the headers and the models', () => {
    const provider: ProviderEntry = {
      id: 'house',
      dialect: 'chat',
      endpoint: 'https://example.invalid/v1',
      credential: { kind: 'integration', integration: 'house-key' },
      headers: { 'x-house': 'yes' },
      models: [plainModel(ALPHA, 'house')],
    };
    expect(provider.id).toBe('house');
    expect(provider.dialect).toBe('chat');
    expect(provider.endpoint).toBe('https://example.invalid/v1');
    expect(provider.credential).toEqual({ kind: 'integration', integration: 'house-key' });
    expect(provider.headers).toEqual({ 'x-house': 'yes' });
    expect(provider.models).toHaveLength(1);
  });

  it('never carries a secret', () => {
    // The provider record's *only* credential member is a reference, and the
    // reference is an integration name — never a key, never a token.
    const provider = fakeProvider('house', 'chat', 'https://example.invalid/v1', {
      credential: { kind: 'integration', integration: 'house-key' },
    });
    const serialised = JSON.stringify(provider);
    expect(serialised).not.toMatch(/secret|token|apiKey|password/i);
    expect(Object.keys(provider)).not.toContain('apiKey');
    expect(Object.keys(provider)).not.toContain('secret');
  });

  it('registers providers as data, and adding one is not editing a registry', () => {
    const table = new ProviderTable();
    table.register(fakeProvider('one', 'chat', 'https://one.invalid/v1'));
    table.register(fakeProvider('two', 'messages', 'https://two.invalid/v1'));
    expect(table.list().map((provider) => provider.id)).toEqual(['one', 'two']);
    expect(table.get('two')?.dialect).toBe('messages');
    expect(table.get('missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. The dialect seam
// ---------------------------------------------------------------------------

describe('the dialect seam — not a vendor switch', () => {
  it('is a property of the path, so one provider may speak any of the three', () => {
    const table = new ProviderTable();
    for (const dialect of DIALECTS) {
      table.register(fakeProvider(`p-${dialect}`, dialect, `https://${dialect}.invalid/v1`));
    }
    expect(table.list().map((provider) => provider.dialect)).toEqual([...DIALECTS]);
  });

  it('addresses a first-party shape as a compatible one, with its own endpoint and credential', () => {
    // The alias changes the endpoint and the credential, and nothing else.
    const canonical = fakeProvider('first', 'messages', 'https://first.invalid/v1', {
      credential: { kind: 'integration', integration: 'first-key' },
      headers: { 'x-first': '1' },
      models: [plainModel(ALPHA, 'first')],
    });
    const alias = fakeProvider('gateway', 'messages', 'https://gateway.invalid/v1', {
      credential: { kind: 'integration', integration: 'gateway-key' },
    });
    const resolved = aliasProvider(alias, canonical);
    expect(resolved.id).toBe('gateway');
    expect(resolved.endpoint).toBe('https://gateway.invalid/v1');
    expect(resolved.credential).toEqual({ kind: 'integration', integration: 'gateway-key' });
    expect(resolved.models.map((model) => model.id)).toEqual([ALPHA]);
    expect(resolved.models[0]?.provider).toBe('gateway');
    expect(resolved.aliasOf).toBe('first');
  });

  it('resolves an alias through the registry', () => {
    const table = new ProviderTable();
    table.register(
      fakeProvider('first', 'messages', 'https://first.invalid/v1', {
        models: [plainModel(ALPHA, 'first')],
      }),
    );
    table.register(
      fakeProvider('gateway', 'messages', 'https://gateway.invalid/v1', {
        aliasOf: 'first',
      }),
    );
    const resolved = resolveProvider(table, 'gateway');
    expect(resolved?.models.map((model) => model.id)).toEqual([ALPHA]);
    expect(resolved?.endpoint).toBe('https://gateway.invalid/v1');
  });

  it('re-spells an alias that speaks another shape', () => {
    // The canonical provider speaks one shape and the alias speaks another.
    // The models are the canonical's, and the overlays are spelled for the
    // shape the alias actually speaks.
    const canonical = fakeProvider('first', 'chat', 'https://first.invalid/v1', {
      models: [reasoningModel(ALPHA, 'first')],
    });
    const alias = fakeProvider('gateway', 'messages', 'https://gateway.invalid/v1', {
      aliasOf: 'first',
    });
    const resolved = aliasProvider(alias, canonical);
    const model = resolved.models[0];
    expect(model).toBeDefined();
    if (!model) throw new Error('unreachable');
    const resolution = resolveOverlay(model, resolved.dialect, 'high');
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(resolution.reason);
    expect(resolution.spelling.body).toEqual({ output_config: { effort: 'high' } });
  });
});

// ---------------------------------------------------------------------------
// 3. The catalogue
// ---------------------------------------------------------------------------

describe('the catalogue', () => {
  it('merges a local override over a fetched list over a shipped snapshot', () => {
    const merged = mergeCatalogues({
      local: document('house', [{ ...plainModel('local-only', 'house'), enabled: true }]),
      fetched: document('house', [plainModel('fetched-only', 'house')]),
      snapshot: document('house', [plainModel('snapshot-only', 'house')]),
    });
    const ids = merged.providers[0]?.models.map((model) => model.id) ?? [];
    expect(ids).toContain('local-only');
    expect(ids).toContain('fetched-only');
    expect(ids).toContain('snapshot-only');
  });

  it('lets the local override win over the fetched list for the same model', () => {
    const merged = mergeCatalogues({
      local: document('house', [{ ...plainModel(ALPHA, 'house'), enabled: false }]),
      fetched: document('house', [plainModel(ALPHA, 'house')]),
      snapshot: document('house', [plainModel(ALPHA, 'house')]),
    });
    const model = merged.providers[0]?.models.find((entry) => entry.id === ALPHA);
    expect(model?.enabled).toBe(false);
  });

  it('keeps a provider that reports nothing in the catalogue, from the snapshot', () => {
    const merged = mergeCatalogues({
      fetched: document('other', [plainModel(BETA, 'other')]),
      snapshot: document('house', [plainModel(ALPHA, 'house')]),
    });
    const house = merged.providers.find((entry) => entry.provider === 'house');
    expect(house?.models.map((model) => model.id)).toEqual([ALPHA]);
  });

  it('fetches the catalogue from a connected provider', async () => {
    const backend = await startFakeBackend({
      dialect: 'chat',
      models: [plainModel(ALPHA, 'fake'), plainModel(BETA, 'fake')],
    });
    try {
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', []),
        fetchProvider: async (provider) => {
          const response = await fetch(`${provider.endpoint}/models`, {
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`the endpoint refused with ${response.status}`);
          return { bytes: await response.text() };
        },
      });
      const provider = fakeProvider('fake', 'chat', backend.url);
      const result = await catalogue.refresh(provider);
      expect(result.changed).toBe(true);
      expect(catalogue.models('fake').map((model) => model.id)).toEqual([ALPHA, BETA]);
    } finally {
      await backend.close();
    }
  });

  it('changes nothing when a fetch returns the same bytes', async () => {
    let bytes = '{"data":[]}';
    let fetches = 0;
    const catalogue = new ModelCatalogue({
      snapshot: document('fake', []),
      fetchProvider: async () => {
        fetches += 1;
        return { bytes };
      },
    });
    const seen: string[] = [];
    catalogue.subscribe((event) => seen.push(event.provider));

    const first = await catalogue.refresh(fakeProvider('fake', 'chat', 'https://fake.invalid/v1'));
    expect(first.changed).toBe(true);
    const cached = catalogue.fetchedBytes('fake');
    expect(cached).toBe(bytes);

    bytes = '{"data":[]}';
    const second = await catalogue.refresh(fakeProvider('fake', 'chat', 'https://fake.invalid/v1'));
    expect(second.changed).toBe(false);
    expect(catalogue.fetchedBytes('fake')).toBe(cached);
    expect(seen).toEqual(['fake']);
    expect(fetches).toBe(2);
  });

  it('does not wake a watcher when nothing changed', async () => {
    const catalogue = new ModelCatalogue({
      snapshot: document('fake', []),
      fetchProvider: async () => ({ bytes: '{"data":[]}' }),
    });
    const wakes: string[] = [];
    catalogue.subscribe((event) => wakes.push(event.provider));
    await catalogue.refresh(fakeProvider('fake', 'chat', 'https://fake.invalid/v1'));
    await catalogue.refresh(fakeProvider('fake', 'chat', 'https://fake.invalid/v1'));
    expect(wakes).toEqual(['fake']);
  });

  it('degrades with a reason when the fetch fails', async () => {
    const catalogue = new ModelCatalogue({
      snapshot: document('fake', [plainModel(ALPHA, 'fake')]),
      fetchProvider: async () => {
        throw new Error('the endpoint refused with 500');
      },
    });
    const result = await catalogue.refresh(fakeProvider('fake', 'chat', 'https://fake.invalid/v1'));
    expect(result.changed).toBe(false);
    expect(result.reason).toBeTruthy();
    // The snapshot still stands: a provider that reports nothing does not empty the catalogue.
    expect(catalogue.models('fake').map((model) => model.id)).toEqual([ALPHA]);
  });
});

// ---------------------------------------------------------------------------
// 4. The overlays
// ---------------------------------------------------------------------------

describe('the overlays — where the effort lives', () => {
  it('applies an effort, a thinking toggle and a token budget, all three, from the catalogue', () => {
    const model = reasoningModel(ALPHA, 'house');
    const target = emptyOverlayTarget();

    for (const name of ['high', 'thinking-on', 'budget-2048']) {
      const resolution = resolveOverlay(model, 'chat', name);
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) throw new Error(resolution.reason);
      applyOverlay(target, resolution);
    }

    expect(target.fields).toEqual({
      reasoning_effort: 'high',
      thinking: true,
      max_reasoning_tokens: 2048,
    });
  });

  it('takes the spelling from the catalogue, not from a rule in the code', () => {
    // The same model, the same overlay, two shapes — and two *different*
    // spellings, both of them the catalogue's.
    const model = reasoningModel(ALPHA, 'house');
    const onChat = resolveOverlay(model, 'chat', 'high');
    const onMessages = resolveOverlay(model, 'messages', 'high');
    expect(onChat.ok && onMessages.ok).toBe(true);
    if (!onChat.ok || !onMessages.ok) throw new Error('unreachable');
    expect(onChat.spelling.fields).toEqual({ reasoning_effort: 'high' });
    expect(onMessages.spelling.body).toEqual({ output_config: { effort: 'high' } });
  });

  it('re-spells the overlays when the effective dialect changes', () => {
    const model = reasoningModel(ALPHA, 'house');
    const onResponses = resolveOverlay(model, 'responses', 'high');
    expect(onResponses.ok).toBe(true);
    if (!onResponses.ok) throw new Error(onResponses.reason);
    expect(onResponses.spelling.fields).toEqual({ reasoning: { effort: 'high' } });
  });

  it('refuses an overlay the model does not offer, with a reason', () => {
    const model = plainModel(ALPHA, 'house');
    const resolution = resolveOverlay(model, 'chat', 'high');
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.reason).toContain('high');
  });

  it('refuses an effort the model does not declare, even when the overlay exists', () => {
    const model: ModelEntry = {
      ...plainModel(ALPHA, 'house'),
      overlays: [
        {
          kind: 'effort',
          name: 'extreme',
          effort: 'extreme',
          spellings: { chat: { fields: { reasoning_effort: 'extreme' } } },
        },
      ],
    };
    const resolution = resolveOverlay(model, 'chat', 'extreme');
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.reason).toContain('extreme');
  });

  it('refuses a toggle and a budget the model does not declare', () => {
    const model: ModelEntry = {
      ...plainModel(ALPHA, 'house'),
      overlays: [
        {
          kind: 'toggle',
          name: 'thinking-on',
          enabled: true,
          spellings: { chat: { fields: { thinking: true } } },
        },
        {
          kind: 'budget_tokens',
          name: 'budget-2048',
          tokens: 2048,
          spellings: { chat: { fields: { max_reasoning_tokens: 2048 } } },
        },
      ],
    };
    expect(resolveOverlay(model, 'chat', 'thinking-on').ok).toBe(false);
    expect(resolveOverlay(model, 'chat', 'budget-2048').ok).toBe(false);
  });

  it('refuses a budget outside the declared range', () => {
    const model = reasoningModel(ALPHA, 'house');
    const tooLarge: ModelEntry = {
      ...model,
      overlays: [
        ...model.overlays,
        {
          kind: 'budget_tokens',
          name: 'budget-huge',
          tokens: 999_999,
          spellings: { chat: { fields: { max_reasoning_tokens: 999_999 } } },
        },
      ],
    };
    expect(resolveOverlay(tooLarge, 'chat', 'budget-huge').ok).toBe(false);
  });

  it('treats the pseudo-overlay "default" as no overlay at all', () => {
    const model = reasoningModel(ALPHA, 'house');
    const resolution = resolveOverlay(model, 'chat', DEFAULT_OVERLAY_NAME);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(resolution.reason);
    expect(resolution.overlay).toBeUndefined();
    const target = emptyOverlayTarget();
    applyOverlay(target, resolution);
    expect(target.fields).toEqual({});
    expect(target.headers).toEqual({});
    expect(target.body).toEqual({});
  });

  it('carries a user-defined named overlay with its own fields, headers and body', () => {
    const model = plainModel(ALPHA, 'house');
    const named: Overlay = {
      kind: 'named',
      name: 'house-mode',
      spellings: {
        chat: {
          fields: { house: true },
          headers: { 'x-house-mode': 'on' },
          body: { house: { depth: 2 } },
        },
      },
    };
    const withIt = withOverlay(model, named);
    const resolution = resolveOverlay(withIt, 'chat', 'house-mode');
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(resolution.reason);
    const target = emptyOverlayTarget();
    applyOverlay(target, resolution);
    expect(target.fields).toEqual({ house: true });
    expect(target.headers).toEqual({ 'x-house-mode': 'on' });
    expect(target.body).toEqual({ house: { depth: 2 } });
    // The catalogue's own entry is untouched: an overlay is added, not written back.
    expect(model.overlays).toHaveLength(0);
  });

  it('lists the overlays a model offers on a shape', () => {
    const model = reasoningModel(ALPHA, 'house');
    expect(overlayNames(model, 'chat')).toContain('high');
    expect(overlayNames(model, 'chat')).toContain('thinking-on');
    expect(findOverlay(model, 'high')?.kind).toBe('effort');
  });

  it('writes a catalogue-supplied key as data, never as a prototype', () => {
    // The catalogue may be fetched from a remote provider, so its keys are
    // data. A key named `__proto__` must not reach the prototype of the
    // object it is written into.
    const fields = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const model: ModelEntry = {
      ...plainModel(ALPHA, 'house'),
      overlays: [
        { kind: 'named', name: 'sneaky', spellings: { chat: { fields } } },
      ],
    };
    const resolution = resolveOverlay(model, 'chat', 'sneaky');
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(resolution.reason);
    const target = emptyOverlayTarget();
    applyOverlay(target, resolution);
    expect(Object.getPrototypeOf(target.fields)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. The credentials
// ---------------------------------------------------------------------------

describe('the credentials', () => {
  const integration: Integration = { id: 'house', env: ['HOUSE_KEY', 'HOUSE_OTHER'] };

  function storedCredential(overrides: Partial<StoredCredential> = {}): StoredCredential {
    return {
      id: 'cred-1',
      integration: 'house',
      kind: 'key',
      label: 'primary',
      createdAt: 1_000,
      secret: 'secret-value',
      ...overrides,
    };
  }

  it('keys the store by the integration, not by the provider', () => {
    const store = new MemoryCredentialStore();
    store.put(storedCredential());
    expect(store.list('house')).toHaveLength(1);
    expect(store.list('other')).toHaveLength(0);
  });

  it('holds the three kinds, and the third carries no secret at all', () => {
    const store = new MemoryCredentialStore();
    store.put(storedCredential({ id: 'k', kind: 'key', secret: 'a-secret' }));
    store.put(
      storedCredential({
        id: 'o',
        kind: 'oauth',
        secret: undefined,
        grant: { accessToken: 'access', refreshToken: 'refresh' },
      }),
    );
    store.put(storedCredential({ id: 'e', kind: 'external', secret: undefined, reference: 'ref-1' }));
    const kinds = store.list('house').map((credential) => credential.kind);
    expect(kinds).toEqual(['key', 'oauth', 'external']);
    const external = store.list('house').find((credential) => credential.id === 'e');
    expect(external?.secret).toBeUndefined();
    expect(external?.reference).toBe('ref-1');
  });

  it('derives the connections: the stored credentials first, newest first', () => {
    const store = new MemoryCredentialStore();
    store.put(storedCredential({ id: 'older', createdAt: 1 }));
    store.put(storedCredential({ id: 'newer', createdAt: 2 }));
    const connections = deriveConnections(integration, store, {});
    expect(connections.map((connection) => connectionIdentity(connection))).toEqual([
      'credential:newer',
      'credential:older',
    ]);
  });

  it('treats the environment as a first-class peer of a stored key', () => {
    const store = new MemoryCredentialStore();
    store.put(storedCredential({ id: 'stored' }));
    const connections = deriveConnections(integration, store, { HOUSE_KEY: 'from-the-environment' });
    expect(connections.map((connection) => connectionIdentity(connection))).toEqual([
      'credential:stored',
      'env:HOUSE_KEY',
    ]);
    const fromEnvironment = connections.find((connection) => connection.kind === 'env');
    expect(fromEnvironment?.kind).toBe('env');
  });

  it('makes the first connection the active one', () => {
    const store = new MemoryCredentialStore();
    store.put(storedCredential({ id: 'stored' }));
    const connections = deriveConnections(integration, store, { HOUSE_KEY: 'x' });
    expect(connectionIdentity(connections[0]!)).toBe('credential:stored');
  });

  it('uses the environment alone when nothing is stored', () => {
    const store = new MemoryCredentialStore();
    const connections = deriveConnections(integration, store, { HOUSE_OTHER: 'x' });
    expect(connections.map((connection) => connectionIdentity(connection))).toEqual(['env:HOUSE_OTHER']);
  });

  it('ignores an environment variable that is not set', () => {
    const store = new MemoryCredentialStore();
    const connections = deriveConnections(integration, store, { HOUSE_KEY: '' });
    expect(connections).toHaveLength(0);
  });

  it('resolves a reference to a secret and reports where the secret came from', async () => {
    const store = new MemoryCredentialStore();
    store.put(storedCredential({ id: 'stored' }));
    const backend = {
      lookup: async (): Promise<{ found: boolean; value?: string }> => ({
        found: true,
        value: 'from-the-keychain',
      }),
    };
    const secretStore = createKeychainSecretStore(backend, 'house');
    const resolution = await resolveProviderCredential(
      { kind: 'integration', integration: 'house' },
      { id: 'house', env: [] },
      store,
      secretStore,
      {},
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(resolution.reason);
    expect(resolution.secret).toBe('from-the-keychain');
    expect(resolution.source).toBe('keychain');
  });

  it('resolves an environment connection to the value of the variable', async () => {
    const store = new MemoryCredentialStore();
    const resolution = await resolveProviderCredential(
      { kind: 'integration', integration: 'house' },
      integration,
      store,
      createKeychainSecretStore({ lookup: async () => ({ found: false }) }, 'house'),
      { HOUSE_KEY: 'from-the-environment' },
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(resolution.reason);
    expect(resolution.secret).toBe('from-the-environment');
    expect(resolution.source).toBe('environment');
  });

  it('refuses an external reference, because this layer holds no secret for it', async () => {
    const store = new MemoryCredentialStore();
    store.put(storedCredential({ id: 'e', kind: 'external', secret: undefined, reference: 'ref-1' }));
    const resolution = await resolveProviderCredential(
      { kind: 'integration', integration: 'house' },
      { id: 'house', env: [] },
      store,
      createKeychainSecretStore({ lookup: async () => ({ found: false }) }, 'house'),
      {},
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.reason).toContain('ref-1');
  });

  it('refuses when the secret cannot be resolved, with a reason', async () => {
    const store = new MemoryCredentialStore();
    store.put(storedCredential({ id: 'stored' }));
    const resolution = await resolveProviderCredential(
      { kind: 'integration', integration: 'house' },
      { id: 'house', env: [] },
      store,
      createKeychainSecretStore({ lookup: async () => ({ found: false }) }, 'house'),
      {},
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('unreachable');
    expect(resolution.reason.length).toBeGreaterThan(0);
  });

  it('falls back to an encrypted file when the operating system store is not available', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'model-secret-'));
    try {
      const file = path.join(directory, 'secrets.enc');
      const store = createEncryptedFileSecretStore(file, 'a-passphrase');
      await store.write('cred-1', 'a-secret');
      expect(await store.read('cred-1')).toBe('a-secret');
      expect(store.source).toBe('encrypted-file');
      // The secret is not readable as plain text on disk.
      const raw = await readFile(file, 'utf8');
      expect(raw).not.toContain('a-secret');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. "Connected" is one predicate
// ---------------------------------------------------------------------------

describe('"connected" is one predicate', () => {
  const provider = fakeProvider('house', 'chat', 'https://house.invalid/v1', {
    credential: { kind: 'integration', integration: 'house' },
  });

  it('is unavailable when the provider is disabled', () => {
    const availability = providerAvailability(provider, [], { disabled: true });
    expect(availability.available).toBe(false);
    expect(availability.reason).toBeTruthy();
  });

  it('is unavailable when the connection has changed since it was last checked', () => {
    const availability = providerAvailability(
      provider,
      [{ kind: 'env', name: 'HOUSE_KEY' }],
      { checkedConnection: 'credential:old' },
    );
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('changed');
  });

  it('is available when the connection has not changed', () => {
    const availability = providerAvailability(
      provider,
      [{ kind: 'env', name: 'HOUSE_KEY' }],
      { checkedConnection: 'env:HOUSE_KEY' },
    );
    expect(availability.available).toBe(true);
  });

  it('is unavailable when the integration has no connection', () => {
    const availability = providerAvailability(provider, []);
    expect(availability.available).toBe(false);
    expect(availability.reason).toBeTruthy();
  });

  it('is available when the provider is force-enabled, even with no connection', () => {
    const availability = providerAvailability(provider, [], { forceEnabled: true });
    expect(availability.available).toBe(true);
  });

  it('is available when the provider has no integration at all', () => {
    const without = fakeProvider('open', 'chat', 'https://open.invalid/v1');
    expect(providerAvailability(without, []).available).toBe(true);
  });

  it('does not let a force-enabled provider survive a changed connection', () => {
    const availability = providerAvailability(provider, [], {
      forceEnabled: true,
      checkedConnection: 'credential:old',
    });
    expect(availability.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Choosing a model
// ---------------------------------------------------------------------------

describe('choosing a model', () => {
  const alpha = plainModel(ALPHA, 'house');
  const beta = plainModel(BETA, 'house');

  it('reads the grammar provider/model#overlay', () => {
    expect(parseModelRef('house/alpha')).toEqual({ provider: 'house', model: 'alpha' });
    expect(parseModelRef('house/alpha#high')).toEqual({
      provider: 'house',
      model: 'alpha',
      overlay: 'high',
    });
    expect(parseModelRef('house/alpha')).not.toBeUndefined();
    expect(parseModelRef('alpha')).toBeUndefined();
    expect(parseModelRef('house/alpha#')).toBeUndefined();
  });

  it('writes the grammar back', () => {
    expect(formatModelRef({ provider: 'house', model: 'alpha' })).toBe('house/alpha');
    expect(formatModelRef({ provider: 'house', model: 'alpha', overlay: 'high' })).toBe('house/alpha#high');
  });

  it('takes the remembered model first, then the agent, the command line, the configuration and the last used', () => {
    const sources = {
      remembered: 'house/alpha',
      agent: 'house/beta',
      commandLine: 'house/alpha',
      configured: 'house/beta',
      lastUsed: 'house/alpha',
    };
    expect(selectModel({ sources, available: [alpha, beta] })).toMatchObject({
      ok: true,
      source: 'remembered',
    });
    expect(
      selectModel({ sources: { ...sources, remembered: undefined }, available: [alpha, beta] }),
    ).toMatchObject({ ok: true, source: 'agent' });
    expect(
      selectModel({
        sources: { ...sources, remembered: undefined, agent: undefined },
        available: [alpha, beta],
      }),
    ).toMatchObject({ ok: true, source: 'command-line' });
    expect(
      selectModel({
        sources: {
          ...sources,
          remembered: undefined,
          agent: undefined,
          commandLine: undefined,
        },
        available: [alpha, beta],
      }),
    ).toMatchObject({ ok: true, source: 'configured' });
    expect(
      selectModel({
        sources: {
          ...sources,
          remembered: undefined,
          agent: undefined,
          commandLine: undefined,
          configured: undefined,
        },
        available: [alpha, beta],
      }),
    ).toMatchObject({ ok: true, source: 'last-used' });
  });

  it('falls back to the first available model that can hold text', () => {
    const result = selectModel({ sources: {}, available: [alpha, beta] });
    expect(result).toMatchObject({ ok: true, source: 'first-available' });
    expect(result.ok && result.ref.model).toBe(ALPHA);
  });

  it('fails loudly when a named model is not available, and never falls back', () => {
    const result = selectModel({ sources: { commandLine: 'house/gamma' }, available: [alpha, beta] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('gamma');
    expect(result.attempted?.model).toBe('gamma');
  });

  it('refuses a model reference that is not one', () => {
    const result = selectModel({ sources: { commandLine: 'nonsense' }, available: [alpha] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('provider/model');
  });

  it('filters by capability and by effort', () => {
    const reasoning = reasoningModel(ALPHA, 'house');
    expect(modelSatisfies(reasoning, { effort: 'high' })).toBe(true);
    expect(modelSatisfies(reasoning, { effort: 'extreme' })).toBe(false);
    expect(modelSatisfies(reasoning, { tools: true })).toBe(true);
    expect(modelSatisfies(plainModel(BETA, 'house'), { tools: true })).toBe(true);
    expect(
      modelSatisfies({ ...plainModel(BETA, 'house'), capabilities: capabilities({ tools: false }) }, {
        tools: true,
      }),
    ).toBe(false);
    expect(
      modelSatisfies({ ...plainModel(BETA, 'house'), capabilities: capabilities({ input: ['text'] }) }, {
        input: ['image'],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. The persistence
// ---------------------------------------------------------------------------

describe('the persistence — three separate stores', () => {
  it('keeps the user interface preferences, and writes them atomically', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'model-prefs-'));
    try {
      const file = path.join(directory, 'model.json');
      const store = new ModelPreferenceStore(file);
      store.write({
        recent: [{ provider: 'house', model: ALPHA }],
        favorites: [{ provider: 'house', model: BETA }],
        overlays: { 'house/alpha': 'high' },
      });
      const read = store.read();
      expect(read.recent).toEqual([{ provider: 'house', model: ALPHA }]);
      expect(read.favorites).toEqual([{ provider: 'house', model: BETA }]);
      expect(read.overlays['house/alpha']).toBe('high');
      // The write left no temporary file behind: it was a rename.
      const { readdir } = await import('node:fs/promises');
      expect((await readdir(directory)).filter((name) => name !== 'model.json')).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('watches the preferences for an edit made elsewhere', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'model-prefs-'));
    try {
      const file = path.join(directory, 'model.json');
      const store = new ModelPreferenceStore(file);
      store.write({ recent: [], favorites: [], overlays: {} });
      const seen: string[] = [];
      const stop = store.watch((preferences) => seen.push(preferences.recent[0]?.model ?? ''));
      try {
        await writeFile(file, JSON.stringify({ recent: [{ provider: 'house', model: BETA }] }));
        const deadline = Date.now() + 5_000;
        while (seen.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(seen).toEqual([BETA]);
      } finally {
        stop();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the durable choice on the session own record', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'model-session-'));
    try {
      const carrier = createFileSessionRecordCarrier({ dir: directory });
      const choice = new DurableModelChoice(carrier);
      await choice.write('session-1', { provider: 'house', model: ALPHA, overlay: 'high' });
      expect(await choice.read('session-1')).toEqual({
        provider: 'house',
        model: ALPHA,
        overlay: 'high',
      });
      expect(await choice.read('session-2')).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9. One model, many providers — and the choice is never made for the user
// ---------------------------------------------------------------------------

describe('one model, many providers', () => {
  it('carries the same model under many providers, and chooses none of them', () => {
    const here = plainModel(ALPHA, 'here');
    const there = plainModel(ALPHA, 'there');
    const available = [here, there];
    const result = selectModel({ sources: { configured: 'there/alpha' }, available });
    expect(result).toMatchObject({ ok: true, source: 'configured' });
    expect(result.ok && result.ref.provider).toBe('there');
  });

  it('never falls back to another provider when the chosen one is gone', () => {
    const available = [plainModel(ALPHA, 'here')];
    const result = selectModel({ sources: { configured: 'there/alpha' }, available });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('there/alpha');
  });
});

// ---------------------------------------------------------------------------
// 10. The whole path, against a fake backend that speaks both shapes
// ---------------------------------------------------------------------------

describe('the whole path, against a fake backend', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];
  const tools: ModelTool[] = [
    { name: 'read', description: 'reads a file', parameters: { type: 'object' } },
  ];

  function engineFor(
    provider: ProviderEntry,
    catalogue: ModelCatalogue,
    overrides: { secret?: string } = {},
  ): ModelEngine {
    return new ModelEngine({
      providers: (() => {
        const table = new ProviderTable();
        table.register(provider);
        return table;
      })(),
      catalogue,
      resolveCredential: async () =>
        overrides.secret === undefined
          ? { ok: false, reason: 'no credential is configured for this provider' }
          : { ok: true, connection: { kind: 'env', name: 'HOUSE_KEY' }, secret: overrides.secret, source: 'environment' },
    });
  }

  it('sends a chat request, streams the reply, and reads the tool call', async () => {
    const backend = await startFakeBackend({ dialect: 'chat' });
    try {
      const provider = fakeProvider('fake', 'chat', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', [plainModel(ALPHA, 'fake')]),
      });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      const events = [];
      for await (const event of engine.run({ provider: 'fake', model: ALPHA }, { messages, tools })) {
        events.push(event);
      }
      const request = backend.lastRequest();
      expect(request?.path).toBe('/v1/chat/completions');
      expect(request?.headers.authorization).toBe('Bearer a-secret');
      expect((request?.body as { model: string }).model).toBe(ALPHA);
      expect((request?.body as { messages: unknown[] }).messages).toHaveLength(1);
      expect((request?.body as { tools: unknown[] }).tools).toHaveLength(1);

      const text = events
        .filter((event) => event.type === 'text')
        .map((event) => (event as { text: string }).text)
        .join('');
      expect(text).toBe('hello ');
      const call = events.find((event) => event.type === 'tool-call');
      expect(call).toMatchObject({ type: 'tool-call' });
      if (!call || call.type !== 'tool-call') throw new Error('unreachable');
      expect(call.call.name).toBe('read');
      expect(call.call.arguments).toEqual({ path: 'a' });
      expect(events.some((event) => event.type === 'usage')).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'end' });
    } finally {
      await backend.close();
    }
  });

  it('sends a messages request, streams the reply, and assembles the streamed tool call', async () => {
    const backend = await startFakeBackend({ dialect: 'messages' });
    try {
      const provider = fakeProvider('fake', 'messages', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', [plainModel(ALPHA, 'fake')]),
      });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      const events = [];
      for await (const event of engine.run({ provider: 'fake', model: ALPHA }, { messages, tools })) {
        events.push(event);
      }
      const request = backend.lastRequest();
      expect(request?.path).toBe('/v1/messages');
      expect(request?.headers['x-api-key']).toBe('a-secret');
      const call = events.find((event) => event.type === 'tool-call');
      if (!call || call.type !== 'tool-call') throw new Error('unreachable');
      expect(call.call.name).toBe('read');
      expect(call.call.arguments).toEqual({ path: 'a' });
      expect(events.at(-1)).toMatchObject({ type: 'end' });
    } finally {
      await backend.close();
    }
  });

  it('puts the overlay on the wire, in the spelling of the effective shape', async () => {
    const backend = await startFakeBackend({ dialect: 'messages' });
    try {
      const provider = fakeProvider('fake', 'messages', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', [reasoningModel(ALPHA, 'fake')]),
      });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      const events = [];
      for await (const event of engine.run(
        { provider: 'fake', model: ALPHA, overlay: 'high' },
        { messages },
      )) {
        events.push(event);
      }
      const body = backend.lastRequest()?.body as { output_config?: unknown };
      expect(body.output_config).toEqual({ effort: 'high' });
    } finally {
      await backend.close();
    }
  });

  it('sends a responses request, streams the reply, and reads the tool call', async () => {
    const backend = await startFakeBackend({ dialect: 'responses' });
    try {
      const provider = fakeProvider('fake', 'responses', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', [plainModel(ALPHA, 'fake')]),
      });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      const events = [];
      for await (const event of engine.run({ provider: 'fake', model: ALPHA }, { messages, tools })) {
        events.push(event);
      }
      const request = backend.lastRequest();
      expect(request?.path).toBe('/v1/responses');
      expect(request?.headers.authorization).toBe('Bearer a-secret');
      const call = events.find((event) => event.type === 'tool-call');
      if (!call || call.type !== 'tool-call') throw new Error('unreachable');
      expect(call.call.name).toBe('read');
      expect(call.call.arguments).toEqual({ path: 'a' });
      expect(events.at(-1)).toMatchObject({ type: 'end' });
    } finally {
      await backend.close();
    }
  });

  it("sends no overlay at all when the pseudo-overlay 'default' is chosen", async () => {
    const backend = await startFakeBackend({ dialect: 'chat' });
    try {
      const provider = fakeProvider('fake', 'chat', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', [reasoningModel(ALPHA, 'fake')]),
      });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      for await (const _event of engine.run(
        { provider: 'fake', model: ALPHA, overlay: DEFAULT_OVERLAY_NAME },
        { messages },
      )) {
        // The turn runs; nothing else is asserted here.
      }
      const body = backend.lastRequest()?.body as Record<string, unknown>;
      expect(body['reasoning_effort']).toBeUndefined();
      expect(body['thinking']).toBeUndefined();
      expect(body['max_reasoning_tokens']).toBeUndefined();
    } finally {
      await backend.close();
    }
  });

  it("puts the provider's own headers and the overlay's headers on the wire", async () => {
    const backend = await startFakeBackend({ dialect: 'chat' });
    try {
      const provider = fakeProvider('fake', 'chat', backend.url, { headers: { 'x-house': '1' } });
      const model = withOverlay(reasoningModel(ALPHA, 'fake'), {
        kind: 'named',
        name: 'house-mode',
        spellings: { chat: { headers: { 'x-house-mode': 'on' } } },
      });
      const catalogue = new ModelCatalogue({ snapshot: document('fake', [model]) });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      for await (const _event of engine.run(
        { provider: 'fake', model: ALPHA, overlay: 'house-mode' },
        { messages },
      )) {
        // The turn runs; the request is what is asserted.
      }
      const headers = backend.lastRequest()?.headers ?? {};
      expect(headers['x-house']).toBe('1');
      expect(headers['x-house-mode']).toBe('on');
    } finally {
      await backend.close();
    }
  });

  it('never falls back silently: a model that is gone fails, and no other provider is tried', async () => {
    const backend = await startFakeBackend({ dialect: 'chat' });
    try {
      const provider = fakeProvider('fake', 'chat', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', [plainModel(BETA, 'fake')]),
      });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      const failure = await collectFailure(engine, { provider: 'fake', model: ALPHA });
      expect(failure.code).toBe('model/unavailable');
      // Nothing was sent: the turn failed before it reached the wire.
      expect(backend.requests).toHaveLength(0);
    } finally {
      await backend.close();
    }
  });

  it('carries a tool answer and an assistant tool call back to the endpoint', async () => {
    const backend = await startFakeBackend({ dialect: 'messages' });
    try {
      const provider = fakeProvider('fake', 'messages', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', [plainModel(ALPHA, 'fake')]),
      });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      const turn: ModelMessage[] = [
        { role: 'user', content: 'read a' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }],
        },
        { role: 'tool', content: 'the file', toolCallId: 'call_1' },
      ];
      for await (const _event of engine.run({ provider: 'fake', model: ALPHA }, { messages: turn })) {
        // The turn runs; the request is what is asserted.
      }
      const body = backend.lastRequest()?.body as { messages: Record<string, unknown>[] };
      expect(body.messages).toHaveLength(3);
      expect(body.messages[1]?.content).toEqual([
        { type: 'text', text: '' },
        { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a' } },
      ]);
      expect(body.messages[2]?.content).toEqual([
        { type: 'tool_result', tool_use_id: 'call_1', content: 'the file' },
      ]);
    } finally {
      await backend.close();
    }
  });

  it('reads the model list from the provider', async () => {
    const backend = await startFakeBackend({
      dialect: 'chat',
      models: [plainModel(ALPHA, 'fake'), plainModel(BETA, 'fake')],
    });
    try {
      const provider = fakeProvider('fake', 'chat', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', []),
        fetchProvider: async (entry) => {
          const response = await fetch(`${entry.endpoint}/models`);
          return { bytes: await response.text() };
        },
      });
      await catalogue.refresh(provider);
      expect(catalogue.models('fake').map((model) => model.id)).toEqual([ALPHA, BETA]);
      expect(backend.requests.some((request) => request.path.endsWith('/models'))).toBe(true);
    } finally {
      await backend.close();
    }
  });

  it('refuses a provider that is not connected, with the reason', async () => {
    const provider = fakeProvider('fake', 'chat', 'https://fake.invalid/v1', {
      credential: { kind: 'integration', integration: 'fake' },
    });
    const catalogue = new ModelCatalogue({ snapshot: document('fake', [plainModel(ALPHA, 'fake')]) });
    const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
    const failure = await collectFailure(engine, { provider: 'fake', model: ALPHA });
    expect(failure.code).toBe('model/not-connected');
    expect(failure.reason.length).toBeGreaterThan(0);
  });

  it('refuses a model that has become unavailable, with the reason', async () => {
    const backend = await startFakeBackend({ dialect: 'chat' });
    try {
      const provider = fakeProvider('fake', 'chat', backend.url);
      const catalogue = new ModelCatalogue({ snapshot: document('fake', []) });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      const failure = await collectFailure(engine, { provider: 'fake', model: ALPHA });
      expect(failure.code).toBe('model/unavailable');
      expect(failure.reason).toContain(ALPHA);
    } finally {
      await backend.close();
    }
  });

  it('refuses an endpoint that refuses, with the reason', async () => {
    const backend = await startFakeBackend({ dialect: 'chat', refuseWith: 503 });
    try {
      const provider = fakeProvider('fake', 'chat', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', [plainModel(ALPHA, 'fake')]),
      });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      const failure = await collectFailure(engine, { provider: 'fake', model: ALPHA });
      expect(failure.code).toBe('model/endpoint-refused');
      expect(failure.reason).toContain('503');
    } finally {
      await backend.close();
    }
  });

  it('refuses a credential that cannot be resolved, with the reason', async () => {
    const backend = await startFakeBackend({ dialect: 'chat' });
    try {
      const provider = fakeProvider('fake', 'chat', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', [plainModel(ALPHA, 'fake')]),
      });
      const engine = engineFor(provider, catalogue);
      const failure = await collectFailure(engine, { provider: 'fake', model: ALPHA });
      expect(failure.code).toBe('model/credential-unresolved');
      expect(failure.reason.length).toBeGreaterThan(0);
    } finally {
      await backend.close();
    }
  });

  it('refuses an attachment the model cannot take, rather than dropping it', async () => {
    const backend = await startFakeBackend({ dialect: 'chat' });
    try {
      const provider = fakeProvider('fake', 'chat', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', [plainModel(ALPHA, 'fake')]),
      });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      const attachment: ContentPart = { type: 'image', data: 'AAAA', mediaType: 'image/png' };
      const failure = await collectFailure(engine, { provider: 'fake', model: ALPHA }, {
        messages: [{ role: 'user', content: [attachment] }],
      });
      expect(failure.code).toBe('model/capability-unsupported');
      expect(failure.reason).toContain('image');
    } finally {
      await backend.close();
    }
  });

  it('refuses an overlay the model does not offer, with the reason', async () => {
    const backend = await startFakeBackend({ dialect: 'chat' });
    try {
      const provider = fakeProvider('fake', 'chat', backend.url);
      const catalogue = new ModelCatalogue({
        snapshot: document('fake', [plainModel(ALPHA, 'fake')]),
      });
      const engine = engineFor(provider, catalogue, { secret: 'a-secret' });
      const failure = await collectFailure(engine, { provider: 'fake', model: ALPHA, overlay: 'high' });
      expect(failure.code).toBe('model/overlay-unknown');
      expect(failure.reason).toContain('high');
    } finally {
      await backend.close();
    }
  });
});

/** Run an engine and collect the failure it raises, or `undefined` when it does not. */
async function collectFailure(
  engine: ModelEngine,
  selection: ModelRef,
  request: { messages: readonly ModelMessage[]; tools?: readonly ModelTool[] } = {
    messages: [{ role: 'user', content: 'hello' }],
  },
): Promise<ModelLayerError> {
  try {
    for await (const _event of engine.run(selection, request)) {
      // The engine must fail before it produces anything.
    }
  } catch (error) {
    if (error instanceof ModelLayerError) return error;
    throw error;
  }
  throw new Error('the engine did not fail');
}
