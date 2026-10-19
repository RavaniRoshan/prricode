/**
 * The Anthropic-native protocol driver — the first-party route, and the shared
 * base the other Anthropic-shaped routes are built from.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2 (Provider request
 * construction) and §2.2a (the provider adapters' wire shapes).
 *
 * ## The first-party route
 *
 * **Observed** (audit §2.2): the client posts to `/v1/messages`, and "a beta
 * variant posts to `/v1/messages?beta=true`". The `buildHeaders` step sends
 * `anthropic-version: 2023-06-01`, `Accept: application/json`, and the auth
 * headers, and the body carries `model` and `stream`.
 *
 * **The two path variants are both implemented** (audit §2.2a): the target's own
 * path set contains `/v1/messages` **and** `/v1/messages?beta=true` as
 * distinct literals, and the Bedrock and Vertex adapters both strip the `beta`
 * search parameter on the way out. This implementation therefore keeps the two literals
 * in one table (`ANTHROPIC_MESSAGE_PATHS`) rather than splicing a marker into a
 * conditional, and only the *rewriting* adapters drop the marker.
 *
 * ## The shared base
 *
 * `createAnthropicNativeDriver` builds a driver for a route whose wire shape is
 * the Anthropic-native one. It is used by:
 *
 *   - `mantle` — `POST <baseUrl>/v1/messages` with the Anthropic-native body,
 *     the base URL `https://bedrock-mantle.<region>.api.aws/anthropic`, and
 *     auth by bearer token or SigV4 with the service name `bedrock-mantle`;
 *   - `anthropicAws` — the Anthropic-native body with a workspace id header and
 *     an AWS credential chain;
 *   - `anthropicGoogleCloud` — the Anthropic-native body with a workspace id
 *     header and Google cloud-platform auth.
 *
 * `firstParty` itself is one of them, with the first-party defaults.
 */

import {
  anthropicPathFor,
  applySigV4Service,
  applyTokenScope,
  buildAnthropicBody,
  buildAnthropicHeaders,
  calculateNonstreamingTimeoutMs,
  classifyErrorStatus,
  createStreamState,
  eventsFromMessage,
  isAnthropicStreamState,
  joinUrl,
  parseSseChunk,
  resolveCredentialKind,
  translateBetaFlags,
  type AnthropicHeaderOptions,
  type AnthropicStreamState,
  type CredentialKind,
  type ProviderDriver,
  type ProviderEvent,
  type ProviderRequest,
} from './types.js';
import type { ProviderRoute } from '../routes.js';

/** The first-party default base URL. */
export const FIRST_PARTY_BASE_URL = 'https://api.anthropic.com';

/**
 * How an Anthropic-native route is configured.
 */
export interface AnthropicNativeDriverConfig {
  /** The route the driver serves. */
  route: ProviderRoute;
  /** The route's default base URL. */
  baseUrl: string;
  /** The auth mode used when a request does not name one. */
  credentialKind?: CredentialKind;
  /** Whether the `anthropic-workspace-id` header is sent. */
  workspaceHeader?: boolean;
  /** The route whose beta spelling this route uses. */
  betaDialect?: ProviderRoute;
  /** Whether the `anthropic-version` header is sent. Default `true`. */
  anthropicVersion?: boolean;
  /**
   * The SigV4 **service name** the route signs with.
   *
   * The service name is the one thing a transport cannot learn from the rest
   * of the request, so the driver writes it into the request's signing context
   * (see `AwsRequestContext.service`).
   */
  sigV4Service?: string;
  /**
   * The OAuth2 **scope** the route's bearer token is acquired with.
   *
   * The driver writes it into the request's token context, and the transport
   * reads it when it acquires the token (see `ProviderRequest.tokenScope`).
   */
  tokenScope?: string;
}

/**
 * Build a driver for an Anthropic-native route.
 *
 * The differences between the Anthropic-native routes are **configuration**,
 * not code: the base URL, the auth mode, the workspace header, the beta
 * dialect, the SigV4 service name and the OAuth2 scope. The body, the header
 * set and the parsers are the same shape.
 */
export function createAnthropicNativeDriver(config: AnthropicNativeDriverConfig): ProviderDriver {
  const defaultKind: CredentialKind = config.credentialKind ?? 'apiKey';
  const dialect: ProviderRoute = config.betaDialect ?? 'firstParty';

  const headerOptions: AnthropicHeaderOptions = {
    workspaceHeader: config.workspaceHeader === true,
    betaDialect: dialect,
    ...(config.anthropicVersion !== undefined ? { anthropicVersion: config.anthropicVersion } : {}),
  };

  const headersFor = (req: ProviderRequest, cred: string | undefined): Record<string, string> => {
    const kind = resolveCredentialKind(req, defaultKind);
    // The route's own seams: the SigV4 service name and the OAuth2 scope.
    // Both are written into the request, so that the transport — which signs
    // and acquires the token — reads them from the request it is handed.
    if (config.sigV4Service !== undefined && kind === 'awsSigV4') {
      applySigV4Service(req, config.sigV4Service);
    }
    if (config.tokenScope !== undefined) {
      applyTokenScope(req, config.tokenScope);
    }
    return buildAnthropicHeaders(req, cred, {
      ...headerOptions,
      credentialKind: kind,
    });
  };

  return {
    route: config.route,

    buildUrl(req: ProviderRequest, baseUrl?: string): string {
      const base = baseUrl !== undefined && baseUrl.trim() !== '' ? baseUrl.trim() : config.baseUrl;
      return joinUrl(base, req.operation === 'count_tokens' ? '/v1/messages/count_tokens' : anthropicPathFor(req));
    },

    buildHeaders(req: ProviderRequest, cred: string | undefined): Record<string, string> {
      return headersFor(req, cred);
    },

    buildBody(req: ProviderRequest, cred: string | undefined): { body: unknown; headers: Record<string, string> } {
      const headers = headersFor(req, cred);
      const body = buildAnthropicBody(req, { countTokens: req.operation === 'count_tokens' });
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
      return translateBetaFlags(flags, dialect);
    },
  };
}

/**
 * The first-party driver.
 *
 * **Observed** (audit §2.1, §2.2): the first-party client is the plain
 * Anthropic client with an API key or an OAuth token; its default base URL is
 * the Anthropic API host.
 */
export const anthropicDriver: ProviderDriver = createAnthropicNativeDriver({
  route: 'firstParty',
  baseUrl: FIRST_PARTY_BASE_URL,
  credentialKind: 'apiKey',
  betaDialect: 'firstParty',
  anthropicVersion: true,
});
