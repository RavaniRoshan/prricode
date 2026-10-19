/**
 * The Anthropic-on-AWS protocol driver.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (the client
 * factory's `anthropicAws` branch, which constructs `AnthropicAws` from
 * `chunk-a3dhk724.js`) and §2.2a.
 *
 * ## The observed wire shape
 *
 * The body is **Anthropic-native** and the route carries a **workspace id
 * header**; the auth is an **AWS credential chain**.
 *
 * The audit does not record a SigV4 **service name** for this route — it names
 * one only for Bedrock (`bedrock`) and Mantle (`bedrock-mantle`). This implementation
 * therefore uses `anthropic` and **labels it as a implementation choice** rather than
 * claiming it is observed. A caller that knows the deployment's service name
 * passes it through the request's signing context.
 */

import { createAnthropicNativeDriver } from './anthropic.js';
import type { ProviderDriver } from './types.js';

/** The Anthropic-on-AWS default base URL, with the region placeholder. */
export const ANTHROPIC_AWS_BASE_URL_TEMPLATE = 'https://aws-external-anthropic.{region}.amazonaws.com';

/**
 * The SigV4 service name this implementation signs with.
 *
 * **Implementation choice** — the audit records no service name for this route.
 */
export const ANTHROPIC_AWS_SIGV4_SERVICE = 'anthropic';

/**
 * The Anthropic-on-AWS driver.
 */
export const anthropicAwsDriver: ProviderDriver = createAnthropicAwsDriver();

/**
 * Build an Anthropic-on-AWS driver.
 */
export function createAnthropicAwsDriver(overrides: { baseUrl?: string } = {}): ProviderDriver {
  return createAnthropicNativeDriver({
    route: 'anthropicAws',
    baseUrl: overrides.baseUrl ?? ANTHROPIC_AWS_BASE_URL_TEMPLATE,
    // The AWS credential chain.
    credentialKind: 'awsSigV4',
    // The route carries a workspace id header.
    workspaceHeader: true,
    betaDialect: 'anthropicAws',
    anthropicVersion: true,
    // The SigV4 service name the driver writes into the request's signing
    // context, so that the transport signs for this route and not for
    // another one.
    sigV4Service: ANTHROPIC_AWS_SIGV4_SERVICE,
  });
}
