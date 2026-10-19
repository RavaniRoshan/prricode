/**
 * The Vertex protocol driver.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2a — the target's
 * own bundled adapter (`chunk-jdnh8sjs.js`), read directly from the pinned
 * binary.
 *
 * ## The observed wire shape
 *
 *   - the body version literal is `anthropic_version: "vertex-2023-10-16"`, set
 *     when the body does not already carry it;
 *   - the rewrite **deletes `model` from the body but keeps `stream`**, and
 *     selects the endpoint suffix from `body.stream`: `streamRawPredict` when
 *     true, `rawPredict` otherwise. The path becomes
 *     `<prefix>/projects/<projectId>/locations/<region>/publishers/anthropic/models/<model>:<suffix>`;
 *   - the `beta` search parameter is deleted;
 *   - `count_tokens` becomes
 *     `<prefix>/projects/<projectId>/locations/<region>/publishers/anthropic/models/count-tokens:rawPredict`;
 *   - a missing project throws `No projectId was given and it could not be
 *     resolved from credentials. The client should be instantiated with the
 *     'projectId' option or the 'ANTHROPIC_VERTEX_PROJECT_ID' environment
 *     variable should be set.`
 *   - auth is a Google OAuth2 bearer with the `cloud-platform` scope and
 *     **never** an Anthropic API key.
 *
 * The contrast with Bedrock is load-bearing and is the reason these are two
 * drivers rather than one: Bedrock **deletes** `stream` and Vertex **keeps** it.
 */

import {
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
  stripBetaSearchParam,
  translateBetaFlags,
  type AnthropicStreamState,
  type CredentialKind,
  type ProviderDriver,
  type ProviderEvent,
  type ProviderRequest,
} from './types.js';
import type { ProviderRoute } from '../routes.js';

/** The Vertex body version literal. **Observed** (audit §2.2a). */
export const VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16';

/** The Google OAuth2 scope Vertex authenticates with. */
export const VERTEX_GOOGLE_SCOPE = 'cloud-platform';

/** The Vertex default base URL. */
export const VERTEX_BASE_URL = 'https://aiplatform.googleapis.com';

/**
 * The error the target throws for a client that was given no project.
 *
 * **Observed** (audit §2.2a), verbatim.
 */
export const VERTEX_MISSING_PROJECT_ERROR =
  "No projectId was given and it could not be resolved from credentials. The client should be instantiated with the 'projectId' option or the 'ANTHROPIC_VERTEX_PROJECT_ID' environment variable should be set.";

/** The endpoint suffixes the Vertex adapter selects between. */
export const VERTEX_PREDICT_SUFFIXES = Object.freeze({
  /** The non-streaming suffix. */
  rawPredict: 'rawPredict',
  /** The streaming suffix. */
  streamRawPredict: 'streamRawPredict',
});

/** The model name the Vertex `count_tokens` endpoint uses. */
export const VERTEX_COUNT_TOKENS_MODEL = 'count-tokens';

/**
 * The path a Vertex request goes to.
 *
 * **Observed** (audit §2.2a): the path is
 * `<prefix>/projects/<projectId>/locations/<region>/publishers/anthropic/models/<model>:<suffix>`.
 */
export function vertexPredictPath(
  projectId: string,
  location: string,
  model: string,
  suffix: string,
): string {
  return `/v1/projects/${projectId}/locations/${location}/publishers/anthropic/models/${model}:${suffix}`;
}

/**
 * The path the Vertex `count_tokens` request goes to.
 *
 * **Observed** (audit §2.2a): `count_tokens` becomes
 * `<prefix>/projects/<projectId>/locations/<region>/publishers/anthropic/models/count-tokens:rawPredict`.
 */
export function vertexCountTokensPath(projectId: string, location: string): string {
  return vertexPredictPath(projectId, location, VERTEX_COUNT_TOKENS_MODEL, VERTEX_PREDICT_SUFFIXES.rawPredict);
}

/**
 * The Vertex driver.
 */
export const vertexDriver: ProviderDriver = createVertexDriver();

/**
 * Build a Vertex driver.
 */
export function createVertexDriver(overrides: { baseUrl?: string } = {}): ProviderDriver {
  const base = overrides.baseUrl ?? VERTEX_BASE_URL;

  const headerOptions = {
    // Vertex authenticates with a Google OAuth2 bearer and **never** with an
    // Anthropic API key (audit §2.2a), so the auth mode is fixed.
    credentialKind: 'bearer' as CredentialKind,
    betaDialect: 'vertex' as ProviderRoute,
  };

  const headersFor = (req: ProviderRequest, cred: string | undefined): Record<string, string> => {
    const kind = resolveCredentialKind(req, 'bearer');
    return buildAnthropicHeaders(req, cred, {
      ...headerOptions,
      // An `apiKey` credential is still a Google bearer token on Vertex: the
      // adapter never sends an Anthropic API key.
      credentialKind: kind === 'apiKey' ? 'bearer' : kind,
    });
  };

  return {
    route: 'vertex',

    buildUrl(req: ProviderRequest, baseUrl?: string): string {
      const endpoint = baseUrl !== undefined && baseUrl.trim() !== '' ? baseUrl.trim() : base;
      const vertex = req.vertex;
      if (vertex === undefined || typeof vertex.projectId !== 'string' || vertex.projectId.trim() === '') {
        // **Observed** (audit §2.2a): the target's exact error.
        throw new Error(VERTEX_MISSING_PROJECT_ERROR);
      }
      const projectId = vertex.projectId.trim();
      const location = typeof vertex.location === 'string' && vertex.location.trim() !== '' ? vertex.location.trim() : 'global';

      const path =
        req.operation === 'count_tokens'
          ? vertexCountTokensPath(projectId, location)
          : vertexPredictPath(
              projectId,
              location,
              req.model,
              req.stream ? VERTEX_PREDICT_SUFFIXES.streamRawPredict : VERTEX_PREDICT_SUFFIXES.rawPredict,
            );

      // The `beta` search parameter is deleted on the way out (audit §2.2a).
      return joinUrl(endpoint, stripBetaSearchParam(path));
    },

    buildHeaders(req: ProviderRequest, cred: string | undefined): Record<string, string> {
      return headersFor(req, cred);
    },

    buildBody(req: ProviderRequest, cred: string | undefined): { body: unknown; headers: Record<string, string> } {
      const headers = headersFor(req, cred);
      const body = buildAnthropicBody(req, {
        // The rewrite deletes `model` from the body but **keeps** `stream`.
        includeModel: false,
        includeStream: true,
        anthropicVersion: VERTEX_ANTHROPIC_VERSION,
      });
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
      return translateBetaFlags(flags, 'vertex');
    },
  };
}
