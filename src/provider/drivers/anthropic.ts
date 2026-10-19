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
  ANTHROPIC_MESSAGE_PATHS,
  anthropicPathFor,
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

/** The two first-party path variants, re-exported for a caller that wants them. */
export const FIRST_PARTY_PATHS = ANTHROPIC_MESSAGE_PATHS;

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
}

/**
 * Build a driver for an Anthropic-native route.
 *
 * The differences between the Anthropic-native routes are **configuration**,
 * not code: the base URL, the auth mode, the workspace header and the beta
 * dialect. The body, the header set and the parsers are the same shape.
 */
export function createAnthropicNativeDriver(config: AnthropicNativeDriverConfig): ProviderDriver {
  const defaultKind: CredentialKind = config.credentialKind ?? 'apiKey';
  const dialect: ProviderRoute = config.betaDialect ?? 'firstParty';

  const headerOptions: AnthropicHeaderOptions = {
    workspaceHeader: config.workspaceHeader === true,
    betaDialect: dialect,
    ...(config.anthropicVersion !== undefined ? { anthropicVersion: config.anthropicVersion } : {}),
  };

  return {
    route: config.route,

    buildUrl(req: ProviderRequest, baseUrl?: string): string {
      const base = baseUrl !== undefined && baseUrl.trim() !== '' ? baseUrl.trim() : config.baseUrl;
      return joinUrl(base, req.operation === 'count_tokens' ? '/v1/messages/count_tokens' : anthropicPathFor(req));
    },

    buildHeaders(req: ProviderRequest, cred: string | undefined): Record<string, string> {
      return buildAnthropicHeaders(req, cred, {
        ...headerOptions,
        credentialKind: resolveCredentialKind(req, defaultKind),
      });
    },

    buildBody(req: ProviderRequest, cred: string | undefined): { body: unknown; headers: Record<string, string> } {
      const headers = buildAnthropicHeaders(req, cred, {
        ...headerOptions,
        credentialKind: resolveCredentialKind(req, defaultKind),
      });
      const body = buildAnthropicBody(req);
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

/**
 * Build a first-party driver with a different base URL or auth default.
 *
 * The extension's connection registry may point a first-party connection at
 * another endpoint, so the base URL is configurable.
 */
export function createFirstPartyDriver(
  overrides: Partial<AnthropicNativeDriverConfig> = {},
): ProviderDriver {
  return createAnthropicNativeDriver({
    route: 'firstParty',
    baseUrl: FIRST_PARTY_BASE_URL,
    credentialKind: 'apiKey',
    betaDialect: 'firstParty',
    anthropicVersion: true,
    ...overrides,
  });
}
