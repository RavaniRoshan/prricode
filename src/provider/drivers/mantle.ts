/**
 * The Mantle protocol driver.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.2a — the target's
 * own bundled adapter (`chunk-1njnz05e.js`), read directly from the pinned
 * binary.
 *
 * ## The observed wire shape
 *
 *   - `POST <baseUrl>/v1/messages` with the **Anthropic-native body** — the
 *     model and the `stream` flag both stay in the body, unlike Bedrock;
 *   - the base URL is `https://bedrock-mantle.<region>.api.aws/anthropic`;
 *   - auth is a bearer token **or** SigV4 with the service name
 *     **`bedrock-mantle`** — the SigV4 service name differs from Bedrock's
 *     `bedrock`, which is the one thing that makes Mantle a separate driver
 *     rather than a Bedrock configuration;
 *   - betas travel in the `anthropic-beta` **header**, together with
 *     `anthropic-version: 2023-06-01`.
 *
 * The beta path marker is **not** stripped here: the audit records that only
 * the Bedrock and Vertex adapters strip the `beta` search parameter, and those
 * are the two adapters that *rewrite* the path.
 */

import { createAnthropicNativeDriver } from './anthropic.js';
import { AWS_REGION_REQUIRED_ERROR, resolveRegionTemplate } from './types.js';
import type { ProviderDriver } from './types.js';

/** The Mantle default base URL, with the region placeholder. */
export const MANTLE_BASE_URL_TEMPLATE = 'https://bedrock-mantle.{region}.api.aws/anthropic';

/** The SigV4 service name Mantle signs with. **Observed** (audit §2.2a). */
export const MANTLE_SIGV4_SERVICE = 'bedrock-mantle';

/**
 * The Mantle driver.
 *
 * The SigV4 service name is part of the driver's configuration, so it is
 * surfaced here rather than hidden in the shared base.
 */
export const mantleDriver: ProviderDriver = createMantleDriver();

/**
 * Build a Mantle driver.
 */
export function createMantleDriver(overrides: { baseUrl?: string } = {}): ProviderDriver {
  const base = createAnthropicNativeDriver({
    route: 'mantle',
    baseUrl: overrides.baseUrl ?? MANTLE_BASE_URL_TEMPLATE,
    // A bearer token **or** SigV4 — the default is SigV4, and a request that
    // names the bearer kind switches to the bearer path.
    credentialKind: 'awsSigV4',
    betaDialect: 'mantle',
    anthropicVersion: true,
    // The SigV4 service name is the one thing that makes Mantle a driver of
    // its own rather than a Bedrock configuration, so the driver writes it
    // into the request's signing context.
    sigV4Service: MANTLE_SIGV4_SERVICE,
  });

  return {
    ...base,
    buildUrl(req: Parameters<ProviderDriver['buildUrl']>[0], baseUrl?: string): string {
      const template = baseUrl !== undefined && baseUrl.trim() !== '' ? baseUrl.trim() : (overrides.baseUrl ?? MANTLE_BASE_URL_TEMPLATE);
      const resolved = resolveRegionTemplate(template, req.aws?.region);
      if (resolved.includes('{region}')) {
        // **Observed** (audit §2.2a): the target's missing-region error.
        throw new Error(AWS_REGION_REQUIRED_ERROR);
      }
      return base.buildUrl(req, resolved);
    },
  };
}
