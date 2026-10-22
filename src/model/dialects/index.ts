/**
 * The dialect registry.
 *
 * One module per shape, and the engine reaches them **only** through this
 * registry — so there is exactly one code path per shape and no branch on a
 * provider's name anywhere in the engine.
 */

import { chatDialect } from './chat.js';
import { messagesDialect } from './messages.js';
import { responsesDialect } from './responses.js';
import type { Dialect } from './types.js';

export { chatDialect, messagesDialect, responsesDialect };
export { createSseReader, type SseEvent, type SseReader } from './sse.js';
export {
  joinEndpoint,
  type DialectRequest,
  type DialectRequestInput,
  type StreamParser,
} from './types.js';

import type { Dialect as DialectName } from '../types.js';

/** Every shape, by name. */
const DIALECT_MODULES: Readonly<Record<DialectName, Dialect>> = Object.freeze({
  chat: chatDialect,
  messages: messagesDialect,
  responses: responsesDialect,
});

/** The module for one shape. */
export function dialectFor(name: DialectName): Dialect {
  return DIALECT_MODULES[name];
}

/**
 * A fetcher that reads a provider's model list from its own endpoint.
 *
 * The path is the shape's own, so a provider that speaks one shape is read
 * at that shape's path and no other.
 */
export function createModelListFetcher(
  fetchImpl: typeof fetch = fetch,
): (provider: { readonly endpoint: string; readonly dialect: DialectName }) => Promise<{
  readonly bytes: string;
}> {
  return async (provider) => {
    const dialect = dialectFor(provider.dialect);
    const base = provider.endpoint.endsWith('/')
      ? provider.endpoint.slice(0, -1)
      : provider.endpoint;
    const response = await fetchImpl(`${base}${dialect.modelsPath}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`the endpoint refused with ${response.status}`);
    }
    return { bytes: await response.text() };
  };
}
