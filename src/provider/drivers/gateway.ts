/**
 * The gateway protocol driver — and the local gateway's request policy.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.3 (the local
 * gateway) and §2.1 (the `gateway` client-factory branch).
 *
 * ## The observed wire shape
 *
 * `chunk-z6a1zj5w.js` contains a **first-party local gateway** that proxies
 * Anthropic-shaped traffic:
 *
 *   - it accepts `/v1/messages` and `/v1/messages/count_tokens`;
 *   - it sets or extends the user agent to `cc-gateway/2.1.303`;
 *   - it applies the upstream provider's auth and the provider's base URL;
 *   - it rejects a request whose body contains `workspace_id` with
 *     `400 invalid_request_error: "workspace_id: not supported through the
 *     gateway"`;
 *   - for a Bedrock upstream it computes `count_tokens` locally, and otherwise
 *     answers `501 not_supported` with `x-should-retry: false`;
 *   - for a streaming request it re-frames the SDK stream into SSE itself,
 *     injecting keep-alive comments, rewriting `message_start.message.model` to
 *     the wire model, and emitting `event: error` frames on an upstream
 *     failure;
 *   - it moves an `anthropic-beta` header into the request body for Bedrock
 *     upstreams.
 *
 * The relationship between the `gateway` **catalog route** (a pinned remote URL
 * and a JWT) and this **local gateway** is *not established* by the analysed
 * scope (audit §4, unknown 8). This implementation implements both halves of what the
 * audit records, and does not claim they are the same system.
 *
 * ## The version in the user agent
 *
 * The gateway's user agent carries the **pinned target's** version,
 * `cc-gateway/2.1.303`. The user agent is part of the observable wire
 * contract, so this implementation emits the target's string rather than its own; the
 * version is a constant so that a caller can override it.
 */

import {
  ANTHROPIC_VERSION,
  anthropicPathFor,
  buildAnthropicBody,
  buildAnthropicHeaders,
  calculateNonstreamingTimeoutMs,
  classifyErrorStatus,
  createStreamState,
  eventsFromMessage,
  isAnthropicStreamState,
  isRecord,
  joinUrl,
  ownString,
  parseSseChunk,
  parseSseFrame,
  resolveCredentialKind,
  splitCommaList,
  splitSseFrames,
  translateBetaFlags,
  type AnthropicStreamState,
  type CredentialKind,
  type ProviderDriver,
  type ProviderEvent,
  type ProviderRequest,
} from './types.js';
import type { ProviderRoute } from '../routes.js';

/** The gateway's version, as the target's user agent carries it. */
export const GATEWAY_VERSION = '2.1.303';

/** The user agent the gateway sets or extends. */
export const GATEWAY_USER_AGENT = `cc-gateway/${GATEWAY_VERSION}`;

/** The gateway's default base URL. */
export const GATEWAY_BASE_URL = 'https://api.anthropic.com';

/** The paths the gateway accepts. */
export const GATEWAY_PATHS = Object.freeze({
  messages: '/v1/messages',
  countTokens: '/v1/messages/count_tokens',
});

/** The gateway's rejection of a request that carries a workspace id. */
export const GATEWAY_WORKSPACE_ID_MESSAGE = 'workspace_id: not supported through the gateway';

/** The keep-alive comment the gateway injects between frames. */
export const GATEWAY_KEEP_ALIVE_COMMENT = ': keep-alive';

/**
 * A request the gateway refuses.
 *
 * The status and the error type are part of the observed contract, so they are
 * carried on the error rather than only in its message.
 */
export class GatewayRequestError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(status: number, type: string, message: string) {
    super(message);
    this.name = 'GatewayRequestError';
    this.status = status;
    this.type = type;
  }
}

/**
 * The gateway's rejection of a request whose body carries a workspace id.
 *
 * **Observed** (audit §2.3): `400 invalid_request_error: "workspace_id: not
 * supported through the gateway"`.
 */
export function gatewayWorkspaceIdRejection(): GatewayRequestError {
  return new GatewayRequestError(400, 'invalid_request_error', GATEWAY_WORKSPACE_ID_MESSAGE);
}

/**
 * Whether a body carries a `workspace_id`.
 *
 * The member name is caller-supplied data, so the check is an **own-property**
 * lookup: a body with no own `workspace_id` does not trip the rejection, and
 * an inherited member never counts.
 */
export function gatewayRejectsWorkspaceId(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return Object.hasOwn(body, 'workspace_id');
}

/**
 * The gateway's `count_tokens` answer for an upstream that cannot count.
 *
 * **Observed** (audit §2.3): it answers `501 not_supported` with
 * `x-should-retry: false`.
 */
export function gatewayCountTokensUnsupported(): {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
} {
  return {
    status: 501,
    body: {
      type: 'error',
      error: {
        type: 'not_supported',
        message: 'count_tokens is not supported by the upstream provider',
      },
    },
    headers: { 'x-should-retry': 'false' },
  };
}

/**
 * The number of characters per token this implementation assumes when it counts tokens
 * locally.
 *
 * **Implementation choice.** The target computes the count locally for a Bedrock
 * upstream; the audit does not record its estimator, so this implementation uses the
 * conventional four-characters-per-token approximation.
 */
export const LOCAL_TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

/**
 * Estimate the number of tokens of a text.
 *
 * The estimate is the local `count_tokens` the gateway computes for a Bedrock
 * upstream (audit §2.3).
 */
export function estimateTokenCount(text: string): number {
  if (typeof text !== 'string' || text === '') return 0;
  return Math.ceil(text.length / LOCAL_TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

/**
 * The gateway's `count_tokens` answer for an upstream.
 *
 * A **Bedrock** upstream is counted locally; every other upstream is answered
 * with `501 not_supported` and `x-should-retry: false` (audit §2.3).
 */
export function gatewayCountTokensResponse(
  upstream: ProviderRoute | undefined,
  request: { messages?: unknown; system?: unknown } = {},
): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
  if (upstream !== 'bedrock') {
    return gatewayCountTokensUnsupported();
  }
  let characters = 0;
  if (typeof request.system === 'string') characters += request.system.length;
  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message['content'];
    if (typeof content === 'string') {
      characters += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block)) continue;
      const text = ownString(block, 'text') ?? ownString(block, 'thinking');
      if (text !== undefined) characters += text.length;
    }
  }
  return {
    status: 200,
    body: { input_tokens: estimateTokenCount('x'.repeat(characters)) },
    headers: {},
  };
}

/**
 * The options the SSE re-framing takes.
 */
export interface GatewaySseOptions {
  /** The model to write into `message_start.message.model`. */
  wireModel: string;
  /** The keep-alive comment injected between frames. */
  keepAlive?: string;
}

/**
 * Re-frame an upstream SSE stream as the gateway's own SSE stream.
 *
 * **Observed** (audit §2.3): the gateway "re-frames the SDK stream into SSE
 * itself, injecting keep-alive comments, rewriting
 * `message_start.message.model` to the wire model, and emitting `event: error`
 * frames on upstream failure".
 *
 * Every other frame is passed through unchanged, so the extended event
 * vocabulary the pinned SDK accepts survives the re-framing.
 */
export function reframeAsSse(source: string, options: GatewaySseOptions): string {
  const keepAlive = options.keepAlive ?? GATEWAY_KEEP_ALIVE_COMMENT;
  const { frames } = splitSseFrames(source);

  const out: string[] = [];
  for (const frame of frames) {
    const parsed = parseSseFrame(frame);
    if (parsed === undefined) {
      // A comment-only frame (a keep-alive from the upstream) is passed through.
      out.push(`${frame}\n\n`);
      continue;
    }
    out.push(`${reframeFrame(parsed, options.wireModel)}\n\n`);
    if (keepAlive !== '') out.push(`${keepAlive}\n\n`);
  }
  return out.join('');
}

/**
 * Re-frame one upstream SSE frame.
 */
export function reframeFrame(frame: { event?: string; data: string; raw: string }, wireModel: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(frame.data);
  } catch {
    // A frame that is not JSON is passed through unchanged; the gateway does
    // not fail a stream over it.
    return frame.raw;
  }

  if (isRecord(payload) && ownString(payload, 'type') === 'message_start') {
    const message = payload['message'];
    if (isRecord(message)) {
      payload = { ...payload, message: { ...message, model: wireModel } };
    }
  }

  const data = JSON.stringify(payload);
  return frame.event !== undefined ? `event: ${frame.event}\ndata: ${data}` : `data: ${data}`;
}

/**
 * Build the SSE text of an upstream failure.
 *
 * **Observed** (audit §2.3): the gateway emits `event: error` frames on an
 * upstream failure.
 */
export function gatewayErrorFrame(message: string, status?: number): string {
  const payload: Record<string, unknown> = {
    type: 'error',
    error: {
      type: 'api_error',
      message,
      ...(status !== undefined ? { status } : {}),
    },
  };
  return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * The local gateway's Bedrock-upstream beta handling.
 *
 * **Observed** (audit §2.3): the gateway "moves an `anthropic-beta` header into
 * the request body for Bedrock upstreams". This implementation performs the move with
 * the same rule the Bedrock adapter uses: the header's value is split on `,`
 * and **trimmed**, and the body field is only set when the body does not
 * already carry `anthropic_beta`.
 */
export function gatewayMoveBetaHeaderIntoBody(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Record<string, unknown> {
  const betaHeader = headers['anthropic-beta'];
  if (betaHeader === undefined) return body;
  if (Object.hasOwn(body, 'anthropic_beta')) return body;
  return { ...body, anthropic_beta: splitCommaList(betaHeader) };
}

/**
 * The gateway driver.
 */
export const gatewayDriver: ProviderDriver = createGatewayDriver();

/**
 * Build a gateway driver.
 */
export function createGatewayDriver(overrides: { baseUrl?: string; version?: string } = {}): ProviderDriver {
  const base = overrides.baseUrl ?? GATEWAY_BASE_URL;
  const userAgent = overrides.version !== undefined ? `cc-gateway/${overrides.version}` : GATEWAY_USER_AGENT;

  const headerOptions = {
    // The gateway client authenticates with a bearer token (audit §2.1: the
    // gateway branch sets `Authorization: Bearer <jwt>`).
    credentialKind: 'bearer' as CredentialKind,
    betaDialect: 'gateway' as ProviderRoute,
  };

  const headersFor = (req: ProviderRequest, cred: string | undefined): Record<string, string> => {
    const headers = buildAnthropicHeaders(req, cred, {
      ...headerOptions,
      credentialKind: resolveCredentialKind(req, 'bearer'),
    });
    // The gateway **sets or extends** the user agent.
    const existing = headers['user-agent'];
    headers['user-agent'] = existing !== undefined && existing !== '' ? `${existing} ${userAgent}` : userAgent;
    return headers;
  };

  return {
    route: 'gateway',

    buildUrl(req: ProviderRequest, baseUrl?: string): string {
      const endpoint = baseUrl !== undefined && baseUrl.trim() !== '' ? baseUrl.trim() : base;
      const path = req.operation === 'count_tokens' ? GATEWAY_PATHS.countTokens : anthropicPathFor(req);
      return joinUrl(endpoint, path);
    },

    buildHeaders(req: ProviderRequest, cred: string | undefined): Record<string, string> {
      return headersFor(req, cred);
    },

    buildBody(req: ProviderRequest, cred: string | undefined): { body: unknown; headers: Record<string, string> } {
      const headers = headersFor(req, cred);
      const body = buildAnthropicBody(req);
      // A workspace id travels in the body of a first-party request, and the
      // gateway refuses it (audit §2.3).
      if (typeof req.workspaceId === 'string' && req.workspaceId !== '') {
        body['workspace_id'] = req.workspaceId;
      }
      if (gatewayRejectsWorkspaceId(body)) {
        throw gatewayWorkspaceIdRejection();
      }
      return { body, headers };
    },

    parseStream(chunk: string, state: unknown): { events: ProviderEvent[]; state: unknown } {
      const current: AnthropicStreamState = isAnthropicStreamState(state) ? state : createStreamState();
      return parseSseChunk(chunk, current);
    },

    parseNonStreaming(body: unknown): { events: ProviderEvent[] } {
      return { events: eventsFromMessage(body) };
    },

    classifyError(
      status: number,
      body: unknown,
      options?: { headers?: Record<string, string>; cachedTokenRefreshed?: boolean },
    ): { message: string; retryable: boolean } {
      return classifyErrorStatus(status, body, options ?? {});
    },

    calculateNonstreamingTimeout(maxTokens: number, modelLimit: number | undefined): number {
      return calculateNonstreamingTimeoutMs(maxTokens, modelLimit);
    },

    betaFlagsFor(flags: string[]): string[] {
      return translateBetaFlags(flags, 'gateway');
    },
  };
}

/**
 * The Anthropic version the gateway's upstream requests carry.
 *
 * Re-exported so that a caller of the local gateway does not have to reach
 * into the shared module.
 */
export const GATEWAY_ANTHROPIC_VERSION = ANTHROPIC_VERSION;
