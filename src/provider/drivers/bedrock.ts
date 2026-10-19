/**
 * The Bedrock protocol driver.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2a — the target's
 * own bundled adapter (`chunk-1njnz05e.js`), read directly from the pinned
 * binary. The audit wins over the public SDKs wherever they disagree.
 *
 * ## The observed wire shape
 *
 *   - the body version literal is `anthropic_version: "bedrock-2023-05-31"`,
 *     and the adapter **sets it** when the body does not already carry it;
 *   - the rewritten paths are exactly `/v1/complete`, `/v1/messages` and
 *     `/v1/messages?beta=true`;
 *   - the `anthropic-beta` **header** is moved into the body's `anthropic_beta`
 *     array, split on `,` and **trimmed** — and only when the body does not
 *     already carry `anthropic_beta`;
 *   - the rewrite **deletes `model` and `stream` from the body** and rewrites
 *     the path to `/model/<model>/invoke` or
 *     `/model/<model>/invoke-with-response-stream`, chosen by the body's
 *     `stream` flag;
 *   - it **deletes the `beta` search parameter**;
 *   - a request whose body is not a JSON object throws
 *     `Expected request body to be a JSON object for post <path>`;
 *   - auth is SigV4 with the service `bedrock`, the region `awsRegion`, the
 *     `host` header replaced by the URL's host, the `connection` header
 *     deleted, and multi-valued query parameters preserved — **unless** a
 *     Bedrock bearer token is present, which takes precedence and suppresses
 *     SigV4;
 *   - a missing region throws `Expected 'awsRegion' option to be passed to the
 *     client or the 'AWS_REGION' environment variable`.
 *
 * ## Streaming is not SSE
 *
 * Bedrock's streaming response is a **binary**
 * `application/vnd.amazon.eventstream` whose frames carry a `chunk` member
 * holding a JSON blob of the Anthropic event (audit §2.2a). A driver that
 * assumes SSE here fails on every Bedrock stream, so `parseStream` decodes the
 * eventstream frames instead.
 *
 * The chunk a caller passes in is the **latin1** text of the raw bytes (one
 * character per byte), because the transport hands the driver a byte buffer and
 * latin1 is the only encoding that round-trips every byte value. The parse
 * state accumulates the undecoded remainder, so a frame that straddles two
 * chunks is not lost.
 */

import {
  ANTHROPIC_BETA_HEADER,
  AWS_REGION_REQUIRED_ERROR,
  applyAwsSigningContext,
  applyAwsSigningHeaders,
  buildAnthropicBody,
  buildAnthropicHeaders,
  calculateNonstreamingTimeoutMs,
  classifyErrorStatus,
  createStreamState,
  eventsFromMessage,
  eventsFromSseFrame,
  isAnthropicStreamState,
  isRecord,
  joinUrl,
  resolveCredentialKind,
  resolveRegionTemplate,
  splitCommaList,
  stripBetaSearchParam,
  translateBetaFlags,
  type AnthropicStreamState,
  type CredentialKind,
  type ProviderDriver,
  type ProviderEvent,
  type ProviderRequest,
} from './types.js';
import type { ProviderRoute } from '../routes.js';

/** The Bedrock body version literal. **Observed** (audit §2.2a). */
export const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31';

/** The SigV4 service name Bedrock signs with. **Observed** (audit §2.2a). */
export const BEDROCK_SIGV4_SERVICE = 'bedrock';

/** The Bedrock default base URL, with the region placeholder. */
export const BEDROCK_BASE_URL_TEMPLATE = 'https://bedrock-runtime.{region}.amazonaws.com';

/**
 * The paths the Bedrock adapter rewrites.
 *
 * **Observed** (audit §2.2a): "The rewritten paths are exactly `/v1/complete`,
 * `/v1/messages`, and `/v1/messages?beta=true`."
 */
export const BEDROCK_REWRITTEN_PATHS: readonly string[] = Object.freeze([
  '/v1/complete',
  '/v1/messages',
  '/v1/messages?beta=true',
]);

/**
 * The error the target throws for a request body that is not a JSON object.
 *
 * **Observed** (audit §2.2a): "A request whose body is not a JSON object throws
 * `Expected request body to be a JSON object for post <path>`."
 */
export function bedrockNonObjectBodyError(path: string): Error {
  return new Error(`Expected request body to be a JSON object for post ${path}`);
}

/**
 * The body mutation the Bedrock adapter applies.
 *
 * The function is exported so that the mutation is observable on its own: the
 * driver calls it, and a test calls it with a body that is not a JSON object to
 * observe the target's exact error.
 */
export function rewriteBedrockBody(
  body: unknown,
  options: { path: string; model: string; stream: boolean },
): Record<string, unknown> {
  if (!isRecord(body)) {
    throw bedrockNonObjectBodyError(options.path);
  }

  const rewritten: Record<string, unknown> = { ...body };
  // The rewrite deletes `model` and `stream` from the body.
  delete rewritten['model'];
  delete rewritten['stream'];

  if (!Object.hasOwn(rewritten, 'anthropic_version')) {
    rewritten['anthropic_version'] = BEDROCK_ANTHROPIC_VERSION;
  }

  return rewritten;
}

/**
 * The path a Bedrock request goes to.
 *
 * **Observed** (audit §2.2a): the path is `/model/<model>/invoke`, or
 * `/model/<model>/invoke-with-response-stream` when the body asked to stream.
 */
export function bedrockInvokePath(model: string, stream: boolean): string {
  return stream ? `/model/${model}/invoke-with-response-stream` : `/model/${model}/invoke`;
}

/**
 * The Bedrock driver.
 */
export const bedrockDriver: ProviderDriver = createBedrockDriver();

/**
 * Build a Bedrock driver.
 *
 * The route's base URL is configurable so that the extension's registry may
 * point a Bedrock connection at another endpoint.
 */
export function createBedrockDriver(overrides: { baseUrl?: string } = {}): ProviderDriver {
  const baseTemplate = overrides.baseUrl ?? BEDROCK_BASE_URL_TEMPLATE;

  const headerOptions = {
    credentialKind: 'awsSigV4' as CredentialKind,
    betaDialect: 'bedrock' as ProviderRoute,
  };

  const headersFor = (req: ProviderRequest, cred: string | undefined): Record<string, string> =>
    buildAnthropicHeaders(req, cred, {
      ...headerOptions,
      credentialKind: resolveCredentialKind(req, 'awsSigV4'),
    });

  return {
    route: 'bedrock',

    buildUrl(req: ProviderRequest, baseUrl?: string): string {
      const template = baseUrl !== undefined && baseUrl.trim() !== '' ? baseUrl.trim() : baseTemplate;
      const region = req.aws?.region;
      const base = resolveRegionTemplate(template, region);
      if (base.includes('{region}')) {
        // **Observed** (audit §2.2a): a missing region throws the target's own
        // message.
        throw new Error(AWS_REGION_REQUIRED_ERROR);
      }
      // The `beta` search parameter is deleted on the way out (audit §2.2a).
      const path = stripBetaSearchParam(bedrockInvokePath(req.model, req.stream));
      return joinUrl(base, path);
    },

    buildHeaders(req: ProviderRequest, cred: string | undefined): Record<string, string> {
      return headersFor(req, cred);
    },

    buildBody(req: ProviderRequest, cred: string | undefined): { body: unknown; headers: Record<string, string> } {
      const headers = headersFor(req, cred);

      // The `anthropic-beta` **header** is moved into the body's
      // `anthropic_beta` array (audit §2.2a). "Moved" is taken literally: the
      // header does not survive alongside the body field.
      let betaHeader: string | undefined;
      if (Object.hasOwn(headers, ANTHROPIC_BETA_HEADER)) {
        betaHeader = headers[ANTHROPIC_BETA_HEADER];
        delete headers[ANTHROPIC_BETA_HEADER];
      }

      const source = buildAnthropicBody(req, {
        includeModel: false,
        includeStream: false,
      });
      // The rewrite owns the body mutation, including the version literal.
      const body = rewriteBedrockBody(source, {
        path: '/v1/messages',
        model: req.model,
        stream: req.stream,
      });

      // ...and only when the body does not already carry `anthropic_beta`.
      if (!Object.hasOwn(body, 'anthropic_beta') && betaHeader !== undefined) {
        body['anthropic_beta'] = splitCommaList(betaHeader);
      }

      return { body, headers };
    },

    parseStream(chunk: string, state: unknown): { events: ProviderEvent[]; state: unknown } {
      const current: BedrockStreamState = isBedrockStreamState(state) ? state : createBedrockStreamState();
      return parseBedrockEventStream(chunk, current);
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
      return translateBetaFlags(flags, 'bedrock');
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The binary eventstream                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The parse state of a Bedrock eventstream.
 *
 * It carries the same Anthropic stream state — the tool blocks that are still
 * accumulating their input — plus the **undecoded remainder** of the byte
 * stream.
 */
export interface BedrockStreamState extends AnthropicStreamState {
  /** The undecoded remainder of the byte stream, as latin1 text. */
  bytes: string;
}

/** A fresh Bedrock eventstream state. */
export function createBedrockStreamState(): BedrockStreamState {
  return { ...createStreamState(), bytes: '' };
}

/** Whether an opaque parse state is a Bedrock eventstream state. */
export function isBedrockStreamState(state: unknown): state is BedrockStreamState {
  return isAnthropicStreamState(state) && typeof (state as BedrockStreamState).bytes === 'string';
}

/**
 * Decode a chunk of a Bedrock eventstream.
 *
 * The chunk is the latin1 text of the raw bytes. The frames are decoded, each
 * frame's Anthropic event is mapped, and the undecoded remainder is carried
 * forward.
 */
export function parseBedrockEventStream(
  chunk: string,
  state: BedrockStreamState,
): { events: ProviderEvent[]; state: BedrockStreamState } {
  const buffer = state.bytes + chunk;
  const bytes = Buffer.from(buffer, 'latin1');
  const { frames, rest } = splitEventStreamFrames(bytes);

  const events: ProviderEvent[] = [];
  const next: BedrockStreamState = {
    ...state,
    bytes: rest.toString('latin1'),
  };

  for (const frame of frames) {
    const event = frameToAnthropicEvent(frame);
    if (event === undefined) continue;
    events.push(...eventsFromAnthropicEvent(event, next));
  }

  return { events, state: next };
}

/**
 * Split an eventstream byte buffer into frames and the remainder.
 *
 * The framing is the AWS one: a 4-byte total length, a 4-byte headers length,
 * a 4-byte prelude CRC, the headers, the payload and a 4-byte message CRC.
 *
 * This implementation does **not** verify the CRCs: the target's own decoder is the
 * authority on that, and a mismatch is not a behaviour the audit records.
 */
export function splitEventStreamFrames(bytes: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let offset = 0;

  while (offset + 12 <= bytes.length) {
    const totalLength = bytes.readUInt32BE(offset);
    if (totalLength < 16 || offset + totalLength > bytes.length) break;
    const headersLength = bytes.readUInt32BE(offset + 4);
    const payloadStart = offset + 12 + headersLength;
    const payloadEnd = offset + totalLength - 4;
    if (headersLength > totalLength || payloadStart > payloadEnd) break;
    frames.push(bytes.subarray(payloadStart, payloadEnd));
    offset += totalLength;
  }

  return { frames, rest: bytes.subarray(offset) };
}

/**
 * The Anthropic event a Bedrock frame carries.
 *
 * The frame's payload is a JSON object with a `chunk` member (audit §2.2a);
 * the `bytes` member that the AWS models use is accepted as well, because both
 * spellings appear in the wild for the same endpoint.
 */
export function frameToAnthropicEvent(frame: Buffer): unknown {
  const text = frame.toString('utf8');
  if (text.trim() === '') return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;

  const chunk = Object.hasOwn(payload, 'chunk') ? payload['chunk'] : undefined;
  if (typeof chunk === 'string') {
    try {
      return JSON.parse(chunk);
    } catch {
      return undefined;
    }
  }
  if (isRecord(chunk)) return chunk;

  const bytes = Object.hasOwn(payload, 'bytes') ? payload['bytes'] : undefined;
  if (typeof bytes === 'string') {
    try {
      return JSON.parse(Buffer.from(bytes, 'base64').toString('utf8'));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Map a decoded Anthropic event onto this implementation's events.
 *
 * The mapping is the same one the SSE parser uses, so a Bedrock stream and an
 * SSE stream produce the same events.
 */
export function eventsFromAnthropicEvent(payload: unknown, state: AnthropicStreamState): ProviderEvent[] {
  // The Bedrock stream carries the same Anthropic event objects as SSE, so the
  // SSE frame mapping is reused through a synthetic frame.
  return eventsFromSseFrame({ data: JSON.stringify(payload), raw: JSON.stringify(payload) }, state);
}

/**
 * The SigV4 header mutations the Bedrock adapter applies.
 *
 * **Observed** (audit §2.2a): "the `host` header replaced by the URL's host,
 * the `connection` header deleted, and multi-valued query parameters
 * preserved".
 */
export function bedrockSigningHeaders(headers: Record<string, string>, url: string): Record<string, string> {
  return applyAwsSigningHeaders(headers, url);
}

/**
 * The signing context a Bedrock request needs.
 *
 * Exported so that a caller can see what the driver requires: a region, and —
 * when the transport computed them — the SigV4 date, session token and
 * authorization header.
 */
export function bedrockSigningContext(
  headers: Record<string, string>,
  req: ProviderRequest,
): Record<string, string> {
  const result = { ...headers };
  applyAwsSigningContext(result, req);
  return result;
}
