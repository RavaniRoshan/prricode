/**
 * The dialect seam — **one module per shape**, and a provider's own behaviour
 * layered on top as data.
 *
 * The API shape a provider speaks is a property of its **path**, not of its
 * name. There are three first-class shapes: `chat`, `messages` and
 * `responses`. Each of them has one module here, and the engine has one code
 * path per shape — never a branch on a provider's name.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §2.
 */

import type {
  ContentPart,
  Dialect as DialectName,
  ModelEntry,
  ModelMessage,
  ModelStreamEvent,
  ModelTool,
  ProviderEntry,
} from '../types.js';
import type { OverlayTarget } from '../overlays.js';

/** What the engine hands a shape when it builds a request. */
export interface DialectRequestInput {
  /** The provider the request goes to. */
  readonly provider: ProviderEntry;
  /** The model the request names. */
  readonly model: ModelEntry;
  /** The turn's messages. */
  readonly messages: readonly ModelMessage[];
  /** The tools the model may call. */
  readonly tools?: readonly ModelTool[];
  /** The ceiling on the answer's length. */
  readonly maxOutputTokens?: number;
  /** The temperature, when the turn asked for one. */
  readonly temperature?: number;
  /** What the selected overlay contributes. */
  readonly overlay: OverlayTarget;
  /** The credential, when the provider has one. */
  readonly credential?: { readonly secret: string };
}

/** The request a shape builds. */
export interface DialectRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** A shape's streaming parser. */
export interface StreamParser {
  /** Feed a piece of the reply; the events it completes are returned. */
  push(chunk: string): readonly ModelStreamEvent[];
  /** The reply is over; the events it completes are returned. */
  end(): readonly ModelStreamEvent[];
}

/** One shape. */
export interface Dialect {
  /** The shape's name. */
  readonly name: DialectName;
  /** The path a turn's request goes to, relative to the provider's base URL. */
  readonly requestPath: string;
  /** The path the model list is read from, relative to the provider's base URL. */
  readonly modelsPath: string;
  /** Build the request. */
  buildRequest(input: DialectRequestInput): DialectRequest;
  /** A parser for the shape's streamed reply. */
  createParser(): StreamParser;
  /** Read a model list out of the payload the endpoint returned. */
  parseModels(payload: unknown, provider: string): readonly ModelEntry[];
}

/**
 * Join a base URL and a path.
 *
 * The base URL keeps its own trailing slash out of the join, and the path
 * always begins with one, so the two are joined exactly once.
 */
export function joinEndpoint(base: string, suffix: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

/**
 * The text of a content part, for the shapes that carry text as a string.
 */
export function textOf(part: ContentPart): string {
  return part.text ?? '';
}
