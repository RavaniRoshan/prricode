/**
 * The provider protocol drivers' entry point.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (the eight
 * routes the target declares) and §2.2a (each route's wire shape).
 *
 * ## The eight routes
 *
 * The target's route set is exactly eight names (audit §2.1), and this implementation
 * implements exactly those:
 *
 * | Route | Driver | Wire shape |
 * |---|---|---|
 * | `firstParty` | `anthropic.ts` | Anthropic-native |
 * | `gateway` | `gateway.ts` | first-party gateway, Anthropic-native |
 * | `bedrock` | `bedrock.ts` | Bedrock InvokeModel, binary eventstream |
 * | `foundry` | `foundry.ts` | Anthropic-native on Azure AI Foundry |
 * | `anthropicAws` | `anthropicAws.ts` | Anthropic-native on AWS |
 * | `anthropicGoogleCloud` | `anthropicGoogleCloud.ts` | Anthropic-native on Google Cloud |
 * | `mantle` | `mantle.ts` | Anthropic-native on Bedrock Mantle |
 * | `vertex` | `vertex.ts` | Vertex rawPredict / streamRawPredict |
 *
 * Four of them have a genuinely different wire shape and therefore their own
 * driver: **bedrock**, **vertex**, **foundry** and **gateway**. The other four
 * are the **Anthropic-native** shape and share one base
 * (`createAnthropicNativeDriver` in `anthropic.ts`), differing only in their
 * base URL, their auth mode, the workspace-id header and their beta dialect.
 *
 * ## The driver never resolves a credential
 *
 * A driver receives the credential (or `undefined`) as an argument. It reads no
 * environment variable, no file and no keychain: the single resolution point
 * is `resolveConnectionCredential` in `src/provider/registry.ts`.
 */

import { anthropicDriver } from './anthropic.js';
import { bedrockDriver } from './bedrock.js';
import { foundryDriver } from './foundry.js';
import { gatewayDriver } from './gateway.js';
import { mantleDriver } from './mantle.js';
import { anthropicAwsDriver } from './anthropicAws.js';
import { anthropicGoogleCloudDriver } from './anthropicGoogleCloud.js';
import { vertexDriver } from './vertex.js';
import { ROUTE_NAMES, type ProviderRoute } from '../routes.js';
import type { ProviderDriver } from './types.js';

/**
 * The driver of each route.
 *
 * A `Map` rather than a plain object, so that a lookup can never resolve an
 * inherited `Object.prototype` member.
 */
export const DRIVERS: ReadonlyMap<ProviderRoute, ProviderDriver> = new Map<ProviderRoute, ProviderDriver>([
  ['firstParty', anthropicDriver],
  ['gateway', gatewayDriver],
  ['bedrock', bedrockDriver],
  ['foundry', foundryDriver],
  ['anthropicAws', anthropicAwsDriver],
  ['anthropicGoogleCloud', anthropicGoogleCloudDriver],
  ['mantle', mantleDriver],
  ['vertex', vertexDriver],
]);

/**
 * The driver of a route.
 *
 * @throws when the route is not one of the eight the target declares.
 */
export function driverFor(route: ProviderRoute): ProviderDriver {
  const driver = DRIVERS.get(route);
  if (driver === undefined) {
    throw new Error(`unknown provider route "${String(route)}"`);
  }
  return driver;
}

/**
 * The drivers of the eight routes, in the route list's order.
 */
export function listDrivers(): ProviderDriver[] {
  return ROUTE_NAMES.map((route) => driverFor(route));
}

export { anthropicDriver, createAnthropicNativeDriver, createFirstPartyDriver } from './anthropic.js';
export {
  bedrockDriver,
  createBedrockDriver,
  rewriteBedrockBody,
  bedrockInvokePath,
  bedrockSigningHeaders,
  BEDROCK_ANTHROPIC_VERSION,
  BEDROCK_BASE_URL_TEMPLATE,
  BEDROCK_REWRITTEN_PATHS,
  BEDROCK_SIGV4_SERVICE,
} from './bedrock.js';
export {
  vertexDriver,
  createVertexDriver,
  vertexPredictPath,
  vertexCountTokensPath,
  VERTEX_ANTHROPIC_VERSION,
  VERTEX_BASE_URL,
  VERTEX_MISSING_PROJECT_ERROR,
} from './vertex.js';
export {
  foundryDriver,
  createFoundryDriver,
  foundryBaseUrlForResource,
  foundryAnthropicBaseUrl,
  FOUNDRY_AZURE_AD_SCOPE,
} from './foundry.js';
export {
  gatewayDriver,
  createGatewayDriver,
  gatewayWorkspaceIdRejection,
  gatewayRejectsWorkspaceId,
  gatewayCountTokensResponse,
  gatewayCountTokensUnsupported,
  gatewayErrorFrame,
  gatewayMoveBetaHeaderIntoBody,
  reframeAsSse,
  GatewayRequestError,
  GATEWAY_BASE_URL,
  GATEWAY_PATHS,
  GATEWAY_USER_AGENT,
  GATEWAY_VERSION,
  GATEWAY_WORKSPACE_ID_MESSAGE,
} from './gateway.js';
export { mantleDriver, createMantleDriver, MANTLE_BASE_URL_TEMPLATE, MANTLE_SIGV4_SERVICE } from './mantle.js';
export {
  anthropicAwsDriver,
  createAnthropicAwsDriver,
  ANTHROPIC_AWS_BASE_URL_TEMPLATE,
  ANTHROPIC_AWS_SIGV4_SERVICE,
} from './anthropicAws.js';
export {
  anthropicGoogleCloudDriver,
  createAnthropicGoogleCloudDriver,
  ANTHROPIC_GOOGLE_CLOUD_BASE_URL,
  ANTHROPIC_GOOGLE_CLOUD_SCOPE,
} from './anthropicGoogleCloud.js';

export {
  ANTHROPIC_BETA_HEADER,
  ANTHROPIC_MESSAGE_PATHS,
  ANTHROPIC_MESSAGE_PATH_VARIANTS,
  ANTHROPIC_VERSION,
  AWS_REGION_REQUIRED_ERROR,
  BETA_FLAG_TRANSLATIONS,
  BETA_SEARCH_PARAM,
  CACHED_TOKEN_REFRESHED_FLAG,
  CORE_SSE_EVENTS,
  EXTENDED_SSE_EVENTS,
  NONSTREAMING_TIMEOUT_FALLBACK_MS,
  RETRYABLE_STATUSES,
  WORKSPACE_ID_HEADER,
  calculateNonstreamingTimeoutMs,
  classifyErrorStatus,
  isKnownSseEvent,
  isRetryableStatus,
  resolveRequestTimeout,
  splitCommaList,
  stripBetaSearchParam,
  translateBetaFlags,
  translateBetaName,
} from './types.js';

export { FOUNDRY_MISSING_BASE_URL_ERROR, FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR } from '../routes.js';

export type {
  AnthropicBodyOptions,
  AnthropicHeaderOptions,
  AnthropicStreamState,
  AwsRequestContext,
  CredentialKind,
  ErrorClassificationOptions,
  ProviderContentBlock,
  ProviderDriver,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  ProviderTool,
  StopReason,
  Usage,
  VertexRequestContext,
} from './types.js';
