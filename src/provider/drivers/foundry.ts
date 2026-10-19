/**
 * The Foundry (Microsoft Foundry / Azure AI) protocol driver.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2a — the target's
 * own bundled adapter (`chunk-m5c0c57d.js`), read directly from the pinned
 * binary.
 *
 * ## The observed wire shape
 *
 *   - `baseURL` and `resource` are **mutually exclusive**: supplying both
 *     throws `baseURL and resource are mutually exclusive`. Supplying neither
 *     throws `Must provide one of the 'baseURL' or 'resource' arguments, or the
 *     ANTHROPIC_FOUNDRY_RESOURCE environment variable`. With only a resource,
 *     the base URL is built as `https://<resource>.services.ai.azure.com/anthropic/`
 *     — **with a trailing slash**;
 *   - the body is Anthropic-native, but the body's `model` is the Azure
 *     **deployment name**, not a model id (the catalog's Foundry provider id is
 *     the deployment name, so the request already carries it);
 *   - auth is `x-api-key` **or** an Azure AD bearer with the
 *     `https://ai.azure.com/.default` scope, never both;
 *   - the API key may be supplied as an **async function** and `authHeaders`
 *     awaits it — this implementation receives the resolved key as the credential
 *     argument, so nothing has to be awaited here;
 *   - the adapter exposes **no models API** — this implementation's driver interface has
 *     no models member either, and a Foundry connection's model list comes from
 *     the catalog, not from the provider.
 *
 * The two error strings live in `src/provider/routes.ts` and are used here
 * verbatim.
 */

import {
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
  type AnthropicStreamState,
  type CredentialKind,
  type ProviderDriver,
  type ProviderEvent,
  type ProviderRequest,
} from './types.js';
import {
  FOUNDRY_MISSING_BASE_URL_ERROR,
  FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR,
  type ProviderRoute,
} from '../routes.js';

/** The base-URL environment variable of the Foundry route. */
export const FOUNDRY_BASE_URL_VARIABLE = 'ANTHROPIC_FOUNDRY_BASE_URL';

/** The resource environment variable of the Foundry route. */
export const FOUNDRY_RESOURCE_VARIABLE = 'ANTHROPIC_FOUNDRY_RESOURCE';

/** The path segment the Foundry Anthropic endpoint lives under. */
export const FOUNDRY_ANTHROPIC_PATH = '/anthropic';

/** The Azure AD scope a Foundry bearer token is acquired with. */
export const FOUNDRY_AZURE_AD_SCOPE = 'https://ai.azure.com/.default';

/** The host a Foundry resource name builds. */
export const FOUNDRY_RESOURCE_HOST_SUFFIX = '.services.ai.azure.com';

/**
 * The base URL a Foundry resource builds.
 *
 * **Observed** (audit §2.2a): the base URL is built as
 * `https://<resource>.services.ai.azure.com/anthropic/` — **with a trailing
 * slash**.
 */
export function foundryBaseUrlForResource(resource: string): string {
  return `https://${resource}${FOUNDRY_RESOURCE_HOST_SUFFIX}${FOUNDRY_ANTHROPIC_PATH}/`;
}

/**
 * The Anthropic base URL of a Foundry deployment.
 *
 * A base URL that already ends in `/anthropic` is kept (and given the trailing
 * slash); any other base URL gets the `/anthropic/` segment appended, because
 * the target's Foundry endpoint lives under it.
 */
export function foundryAnthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith(FOUNDRY_ANTHROPIC_PATH)) return `${trimmed}/`;
  return `${trimmed}${FOUNDRY_ANTHROPIC_PATH}/`;
}

/**
 * The Foundry driver.
 */
export const foundryDriver: ProviderDriver = createFoundryDriver();

/**
 * Build a Foundry driver.
 */
export function createFoundryDriver(overrides: { baseUrl?: string } = {}): ProviderDriver {
  const defaultBase = overrides.baseUrl ?? '';

  const headerOptions = {
    credentialKind: 'apiKey' as CredentialKind,
    betaDialect: 'foundry' as ProviderRoute,
  };

  const headersFor = (req: ProviderRequest, cred: string | undefined): Record<string, string> =>
    buildAnthropicHeaders(req, cred, {
      ...headerOptions,
      credentialKind: resolveCredentialKind(req, 'apiKey'),
    });

  return {
    route: 'foundry',

    buildUrl(req: ProviderRequest, baseUrl?: string): string {
      const endpoint = req.endpoint;
      const conflicting = endpoint?.conflictingVariables ?? [];
      if (conflicting.length > 0) {
        // **Observed** (audit §2.2a): the target refuses a base URL and a
        // resource together.
        throw new Error(FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR);
      }

      const supplied = endpoint?.suppliedBaseUrlVariables ?? [];
      const resourceSupplied = supplied.includes(FOUNDRY_RESOURCE_VARIABLE);
      const explicit = baseUrl !== undefined && baseUrl.trim() !== '' ? baseUrl.trim() : '';

      let base: string;
      if (explicit !== '') {
        if (resourceSupplied) {
          throw new Error(FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR);
        }
        base = explicit;
      } else {
        const resolved = endpoint?.baseUrl ?? defaultBase;
        if (resolved === '' || resolved.includes('{resource}')) {
          // **Observed** (audit §2.2a): the target's error for a client that was
          // given neither.
          throw new Error(FOUNDRY_MISSING_BASE_URL_ERROR);
        }
        base = resolved;
      }

      return joinUrl(foundryAnthropicBaseUrl(base), anthropicPathFor(req));
    },

    buildHeaders(req: ProviderRequest, cred: string | undefined): Record<string, string> {
      return headersFor(req, cred);
    },

    buildBody(req: ProviderRequest, cred: string | undefined): { body: unknown; headers: Record<string, string> } {
      const headers = headersFor(req, cred);
      // The body's `model` is the Azure **deployment name**, which the catalog
      // already resolved into `req.model`.
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
      return translateBetaFlags(flags, 'foundry');
    },
  };
}
