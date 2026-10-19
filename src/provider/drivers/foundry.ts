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
 *   - `apiKey` and `azureADTokenProvider` are **mutually exclusive** as well:
 *     supplying both throws `The 'apiKey' and 'azureADTokenProvider' arguments
 *     are mutually exclusive; only one can be passed at a time.` and supplying
 *     neither throws `Missing credentials. Please pass one of 'apiKey' and
 *     'azureTokenProvider', or set the ANTHROPIC_FOUNDRY_API_KEY environment
 *     variable.` (the target's own message names `azureTokenProvider` while
 *     the parameter is `azureADTokenProvider` — this implementation reproduces it
 *     verbatim);
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
 * The two base-URL error strings live in `src/provider/routes.ts` and are used
 * here verbatim; the two **credential** error strings are the adapter's own and
 * live here.
 *
 * ## The base URL is the route layer's business
 *
 * The **audited** base URL — `https://<resource>.services.ai.azure.com/anthropic/`,
 * with the trailing slash — is what the request path is appended to. The
 * route-policy layer (`src/provider/routes.ts`) resolves the Foundry route's
 * base URL to exactly that string, so the driver does not rebuild it: the
 * `baseUrl` argument of `buildUrl` is the **resolved** route base URL, not a
 * second user-supplied value.
 *
 * The target's mutual-exclusion rule is about the **user's** two inputs — a
 * base URL and a resource — and the route layer reports that conflict in
 * `conflictingVariables`; the driver raises the target's own error from it.
 *
 * ## The credential sources are the driver's business
 *
 * The target validates its credential **options** when the client is built.
 * This implementation's driver receives one *resolved* credential per request, so the
 * **set** of sources travels on the request (`ProviderRequest
 * .credentialSources`) and the driver validates it: an API key and an Azure AD
 * token are never both sent, and a request that declares no source at all is
 * refused with the target's own message.
 */

import {
  anthropicPathFor,
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

/**
 * The base-URL environment variable of the Foundry route.
 *
 * The driver reads it to apply the target's mutual-exclusion rule: the base
 * URL and the resource are **mutually exclusive** (audit §2.2a).
 */
export const FOUNDRY_BASE_URL_VARIABLE = 'ANTHROPIC_FOUNDRY_BASE_URL';

/**
 * The resource environment variable of the Foundry route.
 *
 * The driver reads it to apply the target's mutual-exclusion rule, the same
 * way it reads `FOUNDRY_BASE_URL_VARIABLE`.
 */
export const FOUNDRY_RESOURCE_VARIABLE = 'ANTHROPIC_FOUNDRY_RESOURCE';

/** The path segment the Foundry Anthropic endpoint lives under. */
export const FOUNDRY_ANTHROPIC_PATH = '/anthropic';

/** The Azure AD scope a Foundry bearer token is acquired with. */
export const FOUNDRY_AZURE_AD_SCOPE = 'https://ai.azure.com/.default';

/** The host a Foundry resource name builds. */
export const FOUNDRY_RESOURCE_HOST_SUFFIX = '.services.ai.azure.com';

/**
 * The target's error for an API key **and** an Azure AD token provider.
 *
 * **Observed** (audit §2.2a), verbatim.
 */
export const FOUNDRY_CREDENTIALS_MUTUALLY_EXCLUSIVE_ERROR =
  "The 'apiKey' and 'azureADTokenProvider' arguments are mutually exclusive; only one can be passed at a time.";

/**
 * The target's error for **neither** an API key nor an Azure AD token
 * provider.
 *
 * **Observed** (audit §2.2a), verbatim — including the target's own spelling
 * of the parameter (`azureTokenProvider`, not `azureADTokenProvider`).
 */
export const FOUNDRY_MISSING_CREDENTIALS_ERROR =
  "Missing credentials. Please pass one of 'apiKey' and 'azureTokenProvider', or set the ANTHROPIC_FOUNDRY_API_KEY environment variable.";

/**
 * The base URL a Foundry resource builds.
 *
 * **Observed** (audit §2.2a): the base URL is built as
 * `https://<resource>.services.ai.azure.com/anthropic/` — **with a trailing
 * slash**.
 *
 * This is the builder the driver uses: the resource name is turned into the
 * **audited** base URL, and the request path is appended to it.
 *
 * The resource name is interpolated **unencoded**, as the target does.
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
 *
 * The extra `baseUrlFor` member is the driver's **audited** base URL — the URL
 * the request path is appended to — so that the shape the target builds is
 * observable on the driver and not only in a helper.
 */
export interface FoundryDriver extends ProviderDriver {
  /** The base URL the request path is appended to. */
  baseUrlFor(req: ProviderRequest, baseUrl?: string): string;
}

/**
 * The Foundry driver.
 */
export const foundryDriver: FoundryDriver = createFoundryDriver();

/**
 * Build a Foundry driver.
 */
export function createFoundryDriver(overrides: { baseUrl?: string } = {}): FoundryDriver {
  const defaultBase = overrides.baseUrl ?? '';

  const headerOptions = {
    credentialKind: 'apiKey' as CredentialKind,
    betaDialect: 'foundry' as ProviderRoute,
  };

  /**
   * The credential the request authenticates with.
   *
   * The request's **credential sources** are authoritative when it declares
   * them; the resolved credential argument is the fallback.
   */
  const credentialFor = (req: ProviderRequest, cred: string | undefined): string | undefined => {
    const sources = req.credentialSources;
    if (sources === undefined) return cred;
    const kind = resolveCredentialKind(req, 'apiKey');
    if (kind === 'bearer') {
      return typeof sources.azureADToken === 'string' && sources.azureADToken !== ''
        ? sources.azureADToken
        : cred;
    }
    return typeof sources.apiKey === 'string' && sources.apiKey !== '' ? sources.apiKey : cred;
  };

  /**
   * The target's credential rules: an API key and an Azure AD token provider
   * are mutually exclusive, and one of them is required.
   */
  const validateCredentialSources = (req: ProviderRequest): void => {
    const sources = req.credentialSources;
    if (sources === undefined) return;
    const hasApiKey = typeof sources.apiKey === 'string' && sources.apiKey !== '';
    const hasAzureToken = typeof sources.azureADToken === 'string' && sources.azureADToken !== '';
    if (hasApiKey && hasAzureToken) {
      throw new Error(FOUNDRY_CREDENTIALS_MUTUALLY_EXCLUSIVE_ERROR);
    }
    if (!hasApiKey && !hasAzureToken) {
      throw new Error(FOUNDRY_MISSING_CREDENTIALS_ERROR);
    }
  };

  const headersFor = (req: ProviderRequest, cred: string | undefined): Record<string, string> => {
    // The Azure AD scope the bearer token is acquired with reaches the
    // transport through the request's token context.
    applyTokenScope(req, FOUNDRY_AZURE_AD_SCOPE);
    return buildAnthropicHeaders(req, credentialFor(req, cred), {
      ...headerOptions,
      credentialKind: resolveCredentialKind(req, 'apiKey'),
    });
  };

  /**
   * The base URL of a request — the **audited** one.
   *
   * The `baseUrl` argument is the **resolved** route base URL (the one the
   * route-policy layer resolved), not a second user-supplied value: the
   * mutual-exclusion rule is about the *user's* two inputs, and the route
   * layer reports that conflict in `conflictingVariables`.
   */
  const baseUrlFor = (req: ProviderRequest, baseUrl?: string): string => {
    const endpoint = req.endpoint;
    const conflicting = endpoint?.conflictingVariables ?? [];
    if (conflicting.length > 0) {
      // **Observed** (audit §2.2a): the target refuses a base URL and a
      // resource together.
      throw new Error(FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR);
    }

    // The same rule, for a request that carries the supplied variables
    // without the route layer's report: the two Foundry base-URL variables are
    // mutually exclusive under the target's own rule (audit §2.2a).
    const supplied = endpoint?.suppliedBaseUrlVariables ?? [];
    if (supplied.includes(FOUNDRY_BASE_URL_VARIABLE) && supplied.includes(FOUNDRY_RESOURCE_VARIABLE)) {
      throw new Error(FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR);
    }

    // The connection's own **resource name** builds the audited base URL.
    const resource = req.foundryResource;
    if (resource !== undefined && resource !== '') {
      return foundryBaseUrlForResource(resource);
    }

    // The **resolved** base URL is the audited one already: the route layer
    // resolves the resource variable to
    // `https://<resource>.services.ai.azure.com/anthropic/`, with the trailing
    // slash, so the driver only has to make sure the `/anthropic/` segment is
    // there.
    const resolved =
      baseUrl !== undefined && baseUrl.trim() !== ''
        ? baseUrl.trim()
        : (endpoint?.baseUrl ?? defaultBase);
    if (resolved === '' || resolved.includes('{resource}')) {
      // **Observed** (audit §2.2a): the target's error for a client that was
      // given neither.
      throw new Error(FOUNDRY_MISSING_BASE_URL_ERROR);
    }
    return foundryAnthropicBaseUrl(resolved);
  };

  return {
    route: 'foundry',

    buildUrl(req: ProviderRequest, baseUrl?: string): string {
      return joinUrl(baseUrlFor(req, baseUrl), anthropicPathFor(req));
    },

    baseUrlFor,

    buildHeaders(req: ProviderRequest, cred: string | undefined): Record<string, string> {
      validateCredentialSources(req);
      return headersFor(req, cred);
    },

    buildBody(req: ProviderRequest, cred: string | undefined): { body: unknown; headers: Record<string, string> } {
      validateCredentialSources(req);
      const headers = headersFor(req, cred);
      // The body's `model` is the Azure **deployment name**, which the catalog
      // already resolved into `req.model`.
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
      return translateBetaFlags(flags, 'foundry');
    },
  };
}
