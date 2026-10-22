/**
 * The engine — **one engine speaks every provider**.
 *
 * The provider is data; this module is the single code path that reads it.
 * There is no branch on a provider's name anywhere below, and no rule that
 * asks what a particular model id contains: everything a provider or a model
 * wants is declared in the catalogue.
 *
 * The engine **never fakes success**. A turn either produces events, or it
 * fails with a reason that says which thing was missing. It **never falls back
 * silently**: the model a turn selected is the model it runs against, or the
 * turn fails loudly.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md).
 */

import { providerAvailability } from './availability.js';
import { dialectFor } from './dialects/index.js';
import { emptyOverlayTarget, applyOverlay, resolveOverlay } from './overlays.js';
import { resolveProvider, type ProviderRegistry } from './provider.js';
import type { ModelCatalogue } from './catalogue.js';
import type { Connection, CredentialResolution } from './credentials.js';
import type { ModelRef } from './selection.js';
import type {
  ModelEntry,
  ModelMessage,
  ModelStreamEvent,
  ModelTool,
  ProviderEntry,
} from './types.js';

/** What a turn asks the model for. */
export interface ModelTurnRequest {
  /** The turn's messages. */
  readonly messages: readonly ModelMessage[];
  /** The tools the model may call. */
  readonly tools?: readonly ModelTool[];
  /** The ceiling on the answer's length. */
  readonly maxOutputTokens?: number;
  /** The temperature, when the turn asked for one. */
  readonly temperature?: number;
  /** The signal that aborts the turn. */
  readonly signal?: AbortSignal;
}

/**
 * A failure of the model layer.
 *
 * The `code` is stable and machine-readable; the `reason` is a sentence that
 * names what was missing.
 */
export class ModelLayerError extends Error {
  /** The stable, machine-readable code. */
  readonly code: string;
  /** The sentence that says what was missing. */
  readonly reason: string;

  constructor(code: string, reason: string) {
    super(reason);
    this.name = 'ModelLayerError';
    this.code = code;
    this.reason = reason;
  }
}

/** How the engine is built. */
export interface ModelEngineOptions {
  /** The providers, as data. */
  readonly providers: ProviderRegistry;
  /** The catalogue: what each provider offers. */
  readonly catalogue: ModelCatalogue;
  /** How a provider's credential is resolved. */
  readonly resolveCredential: (provider: ProviderEntry) => Promise<CredentialResolution>;
  /** How a provider's connections are read. */
  readonly connections?: (provider: ProviderEntry) => readonly Connection[];
  /** The transport. The platform's own `fetch` by default. */
  readonly fetch?: typeof fetch;
}

/**
 * The refusal a model's capabilities earn.
 *
 * A capability the model does not have is **enforced, not ignored**: a model
 * that cannot take an attachment refuses it, in a form the user sees, rather
 * than silently dropping it from the request.
 */
function refuseUnsupported(model: ModelEntry, request: ModelTurnRequest): string | undefined {
  const where = `the model "${model.provider}/${model.id}"`;
  for (const message of request.messages) {
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (model.capabilities.input.includes(part.type)) continue;
      return `${where} cannot take a "${part.type}" attachment`;
    }
  }
  if (request.temperature !== undefined && !model.capabilities.temperature) {
    return `${where} does not take a temperature`;
  }
  if (request.tools && request.tools.length > 0 && !model.capabilities.tools) {
    return `${where} does not call tools`;
  }
  return undefined;
}

/** The engine. */
export class ModelEngine {
  readonly #providers: ProviderRegistry;
  readonly #catalogue: ModelCatalogue;
  readonly #resolveCredential: (provider: ProviderEntry) => Promise<CredentialResolution>;
  readonly #connections: ((provider: ProviderEntry) => readonly Connection[]) | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: ModelEngineOptions) {
    this.#providers = options.providers;
    this.#catalogue = options.catalogue;
    this.#resolveCredential = options.resolveCredential;
    this.#connections = options.connections;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * Run a turn against the selected model.
   *
   * The events are yielded as the reply arrives. A turn that cannot run
   * raises a `ModelLayerError` that says which thing was missing; nothing is
   * substituted and nothing is retried against another provider.
   */
  async *run(
    selection: ModelRef,
    request: ModelTurnRequest,
  ): AsyncGenerator<ModelStreamEvent, void, undefined> {
    const provider = resolveProvider(this.#providers, selection.provider);
    if (!provider) {
      throw new ModelLayerError(
        'model/provider-unknown',
        `there is no provider named "${selection.provider}"`,
      );
    }

    const model = this.#findModel(provider, selection.model);
    if (!model) {
      throw new ModelLayerError(
        'model/unavailable',
        `the model "${selection.provider}/${selection.model}" is not in the catalogue`,
      );
    }
    if (!model.enabled) {
      throw new ModelLayerError(
        'model/unavailable',
        `the model "${selection.provider}/${selection.model}" is turned off`,
      );
    }

    const connections = this.#connections ? this.#connections(provider) : [];
    const availability = providerAvailability(provider, connections);
    if (!availability.available) {
      throw new ModelLayerError('model/not-connected', availability.reason ?? 'the provider is not connected');
    }

    const overlayName = selection.overlay ?? 'default';
    const resolution = resolveOverlay(model, provider.dialect, overlayName);
    if (!resolution.ok) {
      throw new ModelLayerError('model/overlay-unknown', resolution.reason);
    }
    const overlay = emptyOverlayTarget();
    applyOverlay(overlay, resolution);

    const refusal = refuseUnsupported(model, request);
    if (refusal) {
      throw new ModelLayerError('model/capability-unsupported', refusal);
    }

    const credential = await this.#resolveCredential(provider);
    if (!credential.ok) {
      throw new ModelLayerError('model/credential-unresolved', credential.reason);
    }

    const dialect = dialectFor(provider.dialect);
    const built = dialect.buildRequest({
      provider,
      model,
      messages: request.messages,
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      overlay,
      ...(credential.secret === undefined ? {} : { credential: { secret: credential.secret } }),
    });

    let response: Response;
    try {
      response = await this.#fetch(built.url, {
        method: built.method,
        headers: built.headers,
        body: JSON.stringify(built.body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ModelLayerError(
        'model/endpoint-unreachable',
        `the endpoint "${built.url}" could not be reached: ${reason}`,
      );
    }

    if (!response.ok) {
      const detail = await readBodySafely(response);
      throw new ModelLayerError(
        'model/endpoint-refused',
        `the endpoint refused the request with ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }

    const parser = dialect.createParser();
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.push(decoder.decode(value, { stream: true }))) yield event;
      }
    }
    for (const event of parser.end()) yield event;
  }

  /** The model, from the catalogue or from the provider's own entry. */
  #findModel(provider: ProviderEntry, id: string): ModelEntry | undefined {
    const fromCatalogue = this.#catalogue.models(provider.id).find((model) => model.id === id);
    if (fromCatalogue) return fromCatalogue;
    return provider.models.find((model) => model.id === id);
  }
}

/** Read a refused response's body, without failing when it cannot be read. */
async function readBodySafely(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim().slice(0, 500);
  } catch {
    return '';
  }
}
