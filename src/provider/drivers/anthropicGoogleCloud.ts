/**
 * The Anthropic-on-Google-Cloud protocol driver.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.1 (the client
 * factory's `anthropicGoogleCloud` branch, which constructs
 * `AnthropicGoogleCloud` from `chunk-7qjrjq0k.js`) and §2.2a.
 *
 * ## The observed wire shape
 *
 * The body is **Anthropic-native** and the route carries a **workspace id
 * header**; the auth is **Google cloud-platform** auth — an OAuth2 bearer with
 * the `cloud-platform` scope, never an Anthropic API key.
 */

import { createAnthropicNativeDriver } from './anthropic.js';
import type { ProviderDriver } from './types.js';

/** The Anthropic-on-Google-Cloud default base URL. */
export const ANTHROPIC_GOOGLE_CLOUD_BASE_URL = 'https://claude.googleapis.com';

/** The Google OAuth2 scope the route authenticates with. */
export const ANTHROPIC_GOOGLE_CLOUD_SCOPE = 'cloud-platform';

/**
 * The Anthropic-on-Google-Cloud driver.
 */
export const anthropicGoogleCloudDriver: ProviderDriver = createAnthropicGoogleCloudDriver();

/**
 * Build an Anthropic-on-Google-Cloud driver.
 */
export function createAnthropicGoogleCloudDriver(overrides: { baseUrl?: string } = {}): ProviderDriver {
  return createAnthropicNativeDriver({
    route: 'anthropicGoogleCloud',
    baseUrl: overrides.baseUrl ?? ANTHROPIC_GOOGLE_CLOUD_BASE_URL,
    // Google cloud-platform auth: an OAuth2 bearer, never an Anthropic API key.
    credentialKind: 'bearer',
    workspaceHeader: true,
    betaDialect: 'anthropicGoogleCloud',
    anthropicVersion: true,
    // The Google OAuth2 scope the bearer token is acquired with. The driver
    // writes it into the request's token context; the transport reads it when
    // it acquires the token.
    tokenScope: ANTHROPIC_GOOGLE_CLOUD_SCOPE,
  });
}
