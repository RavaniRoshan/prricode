/**
 * Contract test for the **five authentication flows**.
 *
 * Evidence: the pinned reference build `2.1.303`, read from its own bundled
 * source — `chunk-1kkch1sj.js` (`claude auth login|status|logout`),
 * `chunk-f2n7zke5.js` (`claude mcp login|logout`), `chunk-f8pz14g5.js` (the MCP
 * server classifier), `chunk-dmqgh1rk.js` (`claude mcp xaa` and `claude mcp add`),
 * `chunk-3kc8svea.js` (the SEP-990 OIDC engine), `chunk-dvjkd4rv.js` (the OAuth
 * endpoint table and the scope vocabulary), `chunk-9y799w6p.js` (the command tree),
 * `chunk-c9s0jh80.js` (the managed-settings keys), `chunk-grnjpsdz.js` (the
 * trusted-device gate) and `chunk-68z1nb51.js` (the environment-variable
 * registry). Every claim below carries a file and a byte offset in the findings
 * file `/home/shiva/opt/reference-agent-rea/analysis/findings-auth-flows.md`.
 *
 * What this test pins:
 *   - the **five** flows, by the target's own names;
 *   - each flow's **credential kinds** and where each one is stored;
 *   - each flow's **state machine** — the states the target's own machine has;
 *   - the **discriminators**: the login method, the MCP server kind, the MCP
 *     auth source, and the flow detector;
 *   - the **validation** the target performs, with its exact messages;
 *   - the **refusal**: this build has no account and no login, so every flow
 *     refuses when it is invoked, and every refusal names the capability it
 *     needed.
 *
 * The honest boundary: this implementation ships **no OAuth client, no device
 * flow, no OIDC provider and no token store**. It reproduces the *shapes* — the
 * discriminators, the states, the validation, the credential kinds — and refuses
 * the rest by name. Nothing here pretends to authenticate.
 */

import { describe, expect, it } from 'vitest';

import {
  AUTH_CREDENTIALS,
  AUTH_FLOW_KINDS,
  AUTH_FLOWS,
  CREDENTIAL_STORE,
  FIRST_PARTY_AUTH_METHODS,
  LOGIN_METHODS,
  MCP_BLOCKED_LOCAL_OAUTH_HOSTS,
  authIssuerKey,
  beginAuthFlow,
  classifyFirstPartyAuth,
  classifyLoginMethod,
  classifyMcpAuthSource,
  classifyMcpServerAuth,
  detectAuthFlows,
  idTokenCacheExpiryMs,
  idTokenExpiryMs,
  isCachedIdTokenUsable,
  validateCallbackPort,
  validateCustomOAuthUrl,
  validateLoginFlags,
  validateRefreshTokenScopes,
  validateSignInScopes,
  validateXaaClientSecret,
  validateXaaIssuer,
  validateXaaServerRequirements,
  type AuthCredentialKind,
  type AuthFlowKind,
  type McpServerShape,
} from '../../src/provider/credentials.js';
import {
  connectionAuthRefusal,
  createProviderRegistry,
  resolveConnectionCredential,
  type Connection,
} from '../../src/provider/registry.js';

describe('the five authentication flows', () => {
  it('names exactly five', () => {
    expect([...AUTH_FLOW_KINDS]).toEqual([
      'firstParty',
      'local',
      'mcp',
      'sep990',
      'hostDeviceOrg',
    ]);
  });

  it('gives every flow a descriptor with a capability and a refusal', () => {
    for (const kind of AUTH_FLOW_KINDS) {
      const flow = AUTH_FLOWS[kind];
      expect(flow.kind).toBe(kind);
      expect(flow.targetNames.length).toBeGreaterThan(0);
      expect(flow.credentialKinds.length).toBeGreaterThan(0);
      expect(flow.states.length).toBeGreaterThan(0);
      expect(flow.requiredCapability.length).toBeGreaterThan(0);
      expect(flow.refusal).toContain(flow.requiredCapability);
    }
  });

  it('refuses every flow by name, and names the capability it needed', () => {
    const capabilities = new Set<string>();
    for (const kind of AUTH_FLOW_KINDS) {
      const refusal = beginAuthFlow(kind);
      expect(refusal.kind).toBe(kind);
      expect(refusal.message.length).toBeGreaterThan(0);
      expect(refusal.message).toContain(refusal.capability);
      expect(refusal.capability).toBe(AUTH_FLOWS[kind].requiredCapability);
      capabilities.add(refusal.capability);
    }
    // Five flows, five distinct capabilities: a refusal that named the same
    // capability twice would not say which flow needed it.
    expect(capabilities.size).toBe(AUTH_FLOW_KINDS.length);
  });

  it('refuses an unknown flow rather than guessing one', () => {
    expect(() => beginAuthFlow('nope' as AuthFlowKind)).toThrow(/unknown authentication flow/);
  });
});

describe('the credential kinds and their storage', () => {
  it('carries the kinds the target stores, and where each one lives', () => {
    const byKind = new Map(AUTH_CREDENTIALS.map((c) => [c.kind, c]));
    const kinds = [...byKind.keys()];
    expect(kinds).toContain<AuthCredentialKind>('oauth');
    expect(kinds).toContain<AuthCredentialKind>('apiKey');
    expect(kinds).toContain<AuthCredentialKind>('idToken');
    expect(kinds).toContain<AuthCredentialKind>('clientSecret');
    expect(kinds).toContain<AuthCredentialKind>('hostEnv');
    expect(kinds).toContain<AuthCredentialKind>('trustedDevice');

    // The target's own record keys, in the credential store it writes.
    expect(byKind.get('oauth')?.recordKey).toBe('claudeAiOauth');
    expect(byKind.get('idToken')?.recordKey).toBe('mcpXaaIdp');
    expect(byKind.get('clientSecret')?.recordKey).toBe('mcpXaaIdpConfig');
    expect(byKind.get('trustedDevice')?.recordKey).toBe('trustedDeviceToken');

    // The trusted-device token is an environment variable first, and the
    // target's name is `CLAUDE_TRUSTED_DEVICE_TOKEN` — not
    // `CLAUDE_CODE_TRUSTED_DEVICE_TOKEN`.
    expect(byKind.get('trustedDevice')?.environmentVariable).toBe('CLAUDE_TRUSTED_DEVICE_TOKEN');
    expect(byKind.get('hostEnv')?.environmentVariable).toBe('CLAUDE_CODE_HOST_AUTH_ENV_VAR');
    expect(byKind.get('oauth')?.environmentVariable).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('stores a credential kind exactly once, and never names a secret', () => {
    const seen = new Set<AuthCredentialKind>();
    for (const credential of AUTH_CREDENTIALS) {
      expect(seen.has(credential.kind)).toBe(false);
      seen.add(credential.kind);
      // A descriptor carries a *name*, never a value.
      expect(Object.values(credential).join(' ')).not.toMatch(/sk-ant-|Bearer\s/);
    }
  });

  it('gives every flow at least one credential kind it can produce', () => {
    for (const kind of AUTH_FLOW_KINDS) {
      const flow = AUTH_FLOWS[kind];
      const known = new Set(AUTH_CREDENTIALS.map((c) => c.kind));
      for (const credentialKind of flow.credentialKinds) {
        expect(known.has(credentialKind)).toBe(true);
      }
    }
  });
});

describe('the state machines', () => {
  it('carries the first-party states the target has', () => {
    const states = AUTH_FLOWS.firstParty.states;
    for (const state of [
      'idle',
      'ready_to_start',
      'waiting_for_login',
      'polling',
      'about_to_retry',
      'success',
      'storage_failed',
      'error',
      'account_on_hold',
      'confirm_account',
    ]) {
      expect(states).toContain(state);
    }
  });

  it('carries the SEP-990 states the target has', () => {
    const states = AUTH_FLOWS.sep990.states;
    for (const state of ['url_input', 'connecting', 'trust_prompt', 'polling', 'token_cached']) {
      expect(states).toContain(state);
    }
  });

  it('carries the MCP states the target has', () => {
    const states = AUTH_FLOWS.mcp.states;
    for (const state of [
      'server_not_found',
      'server_pending_approval',
      'server_rejected',
      'server_config_error',
      'unsupported_transport',
      'anthropic_hosted',
      'claudeai_proxy',
      'no_login_required',
      'awaiting_redirect',
      'cancelled',
      'succeeded',
    ]) {
      expect(states).toContain(state);
    }
  });

  it('carries the host/device/org states the target has', () => {
    const states = AUTH_FLOWS.hostDeviceOrg.states;
    for (const state of [
      'host_managed',
      'device_enrollment_required',
      'device_enrollment_disabled',
      'org_pinned',
      'not_applicable',
    ]) {
      expect(states).toContain(state);
    }
  });

  it('gives the two OAuth-bearing flows the same sign-in states', () => {
    // The first-party flow and the local flow are the same machine over a
    // different endpoint table, so they share their states.
    expect([...AUTH_FLOWS.local.states]).toEqual([...AUTH_FLOWS.firstParty.states]);
  });
});

describe('the login-method discriminator', () => {
  it('names exactly the three methods the target forces', () => {
    expect([...LOGIN_METHODS]).toEqual(['claudeai', 'console', 'gateway']);
  });

  it('prefers the forced method over the flags', () => {
    const forced = classifyLoginMethod({ declared: 'console', console: false, claudeai: true });
    expect(forced.method).toBe('console');
    expect(forced.forced).toBe(true);
  });

  it('uses the flags when nothing is forced', () => {
    expect(classifyLoginMethod({}).method).toBe('claudeai');
    expect(classifyLoginMethod({ console: true }).method).toBe('console');
    expect(classifyLoginMethod({ claudeai: true }).method).toBe('claudeai');
  });

  it('suppresses a declared gateway when the host does not manage the machine', () => {
    const decision = classifyLoginMethod({ declared: 'gateway', console: true });
    expect(decision.forced).toBe(false);
    expect(decision.method).toBe('console');
  });

  it('forces the gateway when the host application manages the machine', () => {
    const decision = classifyLoginMethod({ declared: 'gateway', hostManaged: true });
    expect(decision.forced).toBe(true);
    expect(decision.method).toBe('gateway');
  });

  it('reports a declared method that disagrees with the chosen one', () => {
    const decision = classifyLoginMethod({ declared: 'gateway', console: false });
    expect(decision.method).toBe('claudeai');
    expect(decision.contradicted).toBe(true);
  });

  it('reports no disagreement when the declared method is the chosen one', () => {
    const decision = classifyLoginMethod({ declared: 'claudeai' });
    expect(decision.contradicted).toBe(false);
    const consoleDecision = classifyLoginMethod({ declared: 'console' });
    expect(consoleDecision.contradicted).toBe(false);
  });
});

describe('the MCP server discriminator', () => {
  it('classifies a claude.ai connector', () => {
    const result = classifyMcpServerAuth('connector', {
      type: 'claudeai-proxy',
      url: 'https://mcp.example.com/mcp',
    });
    expect(result.kind).toBe('claudeai-proxy');
  });

  it('classifies a stdio server as an unsupported transport', () => {
    const result = classifyMcpServerAuth('local', { type: 'stdio', command: 'npx' } as McpServerShape);
    expect(result.kind).toBe('unsupported-transport');
    expect(result.transport).toBe('stdio');
  });

  it('classifies an Anthropic-hosted server, and says why', () => {
    const result = classifyMcpServerAuth('gmail', {
      type: 'http',
      url: 'https://gmail.mcp.claude.com/mcp',
    });
    expect(result.kind).toBe('anthropic-hosted');
    expect(result.message).toContain("is Anthropic-hosted and doesn't support local OAuth");
  });

  it('classifies an ordinary remote server as oauth', () => {
    const result = classifyMcpServerAuth('sentry', {
      type: 'http',
      url: 'https://mcp.sentry.dev/mcp',
    });
    expect(result.kind).toBe('oauth');
  });

  it('lists the blocked hosts the target blocks by default', () => {
    expect([...MCP_BLOCKED_LOCAL_OAUTH_HOSTS]).toEqual([
      'microsoft365.mcp.claude.com',
      'gmail.mcp.claude.com',
      'gcal.mcp.claude.com',
    ]);
  });
});

describe('the MCP auth-source discriminator', () => {
  const remote: McpServerShape = { type: 'http', url: 'https://mcp.sentry.dev/mcp' };

  it('reports a static Authorization header', () => {
    expect(
      classifyMcpAuthSource({ ...remote, headers: { Authorization: 'Bearer x' } }, {
        firstPartyRoute: false,
        hasFirstPartyToken: false,
        hasDesignCredential: false,
      }),
    ).toBe('static_auth_header');
  });

  it('reports the first-party credential', () => {
    expect(
      classifyMcpAuthSource(
        { type: 'http', url: 'https://api.anthropic.com/v1/pages/mcp' },
        {
          firstPartyRoute: true,
          hasFirstPartyToken: true,
          hasDesignCredential: false,
        },
      ),
    ).toBe('first_party_auth');
  });

  it('reports the design credential', () => {
    expect(
      classifyMcpAuthSource(
        { type: 'http', url: 'https://api.anthropic.com/v1/design/pages' },
        {
          firstPartyRoute: true,
          hasFirstPartyToken: false,
          hasDesignCredential: true,
        },
      ),
    ).toBe('first_party_design_auth');
  });

  it('reports that there is no other source', () => {
    expect(
      classifyMcpAuthSource(remote, {
        firstPartyRoute: false,
        hasFirstPartyToken: false,
        hasDesignCredential: false,
      }),
    ).toBe('none');
  });

  it('does not treat a first-party-looking host on another path as first-party', () => {
    expect(
      classifyMcpAuthSource(
        { type: 'http', url: 'https://api.anthropic.com/v1/messages' },
        { firstPartyRoute: true, hasFirstPartyToken: true },
      ),
    ).toBe('none');
  });
});

describe('the flow detector', () => {
  it('reports the first-party flow when nothing else applies', () => {
    expect(detectAuthFlows({ env: {} })).toEqual(['firstParty']);
  });

  it('reports the local flow when the local endpoint variables are set', () => {
    const flows = detectAuthFlows({
      env: { CLAUDE_LOCAL_OAUTH_API_BASE: 'http://localhost:8000' },
    });
    expect(flows).toContain('local');
    expect(flows).toContain('firstParty');
  });

  it('reports the SEP-990 flow when the IdP is configured', () => {
    const flows = detectAuthFlows({
      env: {},
      xaaIdp: { issuer: 'https://idp.example.com', clientId: 'abc' },
    });
    expect(flows).toContain('sep990');
  });

  it('reports the host/device/org flow when the host supplies a credential', () => {
    const flows = detectAuthFlows({
      env: { CLAUDE_CODE_HOST_AUTH_ENV_VAR: 'MY_HOST_TOKEN' },
    });
    expect(flows).toContain('hostDeviceOrg');
  });

  it('reports the host/device/org flow for a trusted device token', () => {
    const flows = detectAuthFlows({ env: { CLAUDE_TRUSTED_DEVICE_TOKEN: 'tok' } });
    expect(flows).toContain('hostDeviceOrg');
  });

  it('reports the host/device/org flow when an organization is pinned', () => {
    const flows = detectAuthFlows({ env: {}, forceLoginOrgUUID: 'uuid-1' });
    expect(flows).toContain('hostDeviceOrg');
  });

  it('never reports the same flow twice', () => {
    const flows = detectAuthFlows({
      env: {
        CLAUDE_LOCAL_OAUTH_API_BASE: 'http://localhost:8000',
        CLAUDE_TRUSTED_DEVICE_TOKEN: 'tok',
      },
      xaaIdp: { issuer: 'https://idp.example.com', clientId: 'abc' },
    });
    expect(new Set(flows).size).toBe(flows.length);
  });
});

describe('the validation the target performs', () => {
  it('requires an https issuer, except on loopback', () => {
    expect(validateXaaIssuer('https://idp.example.com')).toBeUndefined();
    expect(validateXaaIssuer('http://localhost:8080')).toBeUndefined();
    expect(validateXaaIssuer('http://127.0.0.1:8080')).toBeUndefined();
    expect(validateXaaIssuer('http://idp.example.com')).toContain('must use https://');
    expect(validateXaaIssuer('not a url')).toContain('must be a valid URL');
  });

  it('bounds the callback port', () => {
    expect(validateCallbackPort(8080)).toBeUndefined();
    expect(validateCallbackPort(0)).toContain('[1, 65535]');
    expect(validateCallbackPort(65536)).toContain('[1, 65535]');
    expect(validateCallbackPort(1.5)).toContain('[1, 65535]');
    expect(validateCallbackPort(undefined)).toBeUndefined();
  });

  it('reads the IdP client secret from the environment, never the command line', () => {
    expect(validateXaaClientSecret(true, {})).toContain('MCP_XAA_IDP_CLIENT_SECRET');
    expect(validateXaaClientSecret(true, { MCP_XAA_IDP_CLIENT_SECRET: 's' })).toBeUndefined();
    expect(validateXaaClientSecret(false, {})).toBeUndefined();
  });

  it('lists every requirement an --xaa server is missing', () => {
    const message = validateXaaServerRequirements({
      enabled: true,
      clientId: undefined,
      clientSecret: undefined,
      idpConfigured: false,
    });
    expect(message).toContain('--client-id');
    expect(message).toContain('--client-secret');
    expect(message).toContain("'claude mcp xaa setup'");
  });

  it('refuses --console together with --claudeai', () => {
    expect(validateLoginFlags({ console: true, claudeai: true })).toContain(
      '--console and --claudeai cannot be used together',
    );
    expect(validateLoginFlags({ console: true })).toBeUndefined();
    expect(validateLoginFlags({})).toBeUndefined();
  });

  it('refuses a custom OAuth URL that is not on the approved list', () => {
    expect(validateCustomOAuthUrl(undefined)).toBeUndefined();
    expect(validateCustomOAuthUrl('https://claude.fedstart.com')).toBeUndefined();
    expect(validateCustomOAuthUrl('https://evil.example.com')).toContain(
      'CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint',
    );
  });

  it('requires scopes with a refresh token', () => {
    expect(validateRefreshTokenScopes(undefined)).toContain('CLAUDE_CODE_OAUTH_SCOPES is required');
    expect(validateRefreshTokenScopes('user:inference')).toBeUndefined();
  });

  it('refuses a sign-in that cannot be refreshed', () => {
    expect(validateSignInScopes(['user:profile'], true, 1)).toContain(
      "didn't grant inference access",
    );
    expect(validateSignInScopes(['user:inference'], false, 1)).toContain(
      'without a refresh token',
    );
    expect(
      validateSignInScopes(['user:inference'], true, Number.NaN),
    ).toContain("without the token's expiry");
    expect(validateSignInScopes(['user:inference'], true, 1)).toBeUndefined();
  });
});

describe('the first-party credential-kind discriminator', () => {
  it('names exactly the six kinds the target reports', () => {
    expect([...FIRST_PARTY_AUTH_METHODS]).toEqual([
      'none',
      'third_party',
      'claude.ai',
      'api_key_helper',
      'oauth_token',
      'api_key',
    ]);
  });

  it('reports a third-party session', () => {
    expect(classifyFirstPartyAuth({ thirdParty: true }).authMethod).toBe('third_party');
  });

  it('reports a gateway session with no login as none', () => {
    expect(
      classifyFirstPartyAuth({ thirdParty: true, gatewayWithoutLogin: true }).authMethod,
    ).toBe('none');
  });

  it('reports the subscription sign-in', () => {
    expect(classifyFirstPartyAuth({ tokenSource: 'claude.ai' }).authMethod).toBe('claude.ai');
  });

  it('reports the key helper', () => {
    expect(classifyFirstPartyAuth({ tokenSource: 'apiKeyHelper' }).authMethod).toBe(
      'api_key_helper',
    );
    expect(
      classifyFirstPartyAuth({ apiKeySource: 'apiKeyHelper', helperWithoutToken: true })
        .authMethod,
    ).toBe('api_key_helper');
  });

  it('reports an OAuth token that is neither of the two above', () => {
    expect(classifyFirstPartyAuth({ tokenSource: 'something-else' }).authMethod).toBe(
      'oauth_token',
    );
  });

  it('reports an API key', () => {
    expect(classifyFirstPartyAuth({ apiKeySource: 'ANTHROPIC_API_KEY' }).authMethod).toBe(
      'api_key',
    );
    expect(classifyFirstPartyAuth({ environmentApiKey: true }).authMethod).toBe('api_key');
    expect(classifyFirstPartyAuth({ apiKeySource: '/login managed key' }).authMethod).toBe(
      'api_key',
    );
  });

  it('reports nothing when nothing is configured', () => {
    const decision = classifyFirstPartyAuth({});
    expect(decision.authMethod).toBe('none');
    expect(decision.loggedIn).toBe(false);
  });

  it('counts a third-party session as signed in', () => {
    expect(classifyFirstPartyAuth({ thirdParty: true }).loggedIn).toBe(true);
  });

  it('does not count a gateway session with no login as signed in', () => {
    expect(
      classifyFirstPartyAuth({ thirdParty: true, gatewayWithoutLogin: true }).loggedIn,
    ).toBe(false);
  });
});

describe('the credential store shape', () => {
  it('names the file, the mode and the ceiling the target uses', () => {
    expect(CREDENTIAL_STORE.fileName).toBe('.credentials.json');
    expect(CREDENTIAL_STORE.mode).toBe(0o600);
    expect(CREDENTIAL_STORE.maxBytes).toBe(1_048_576);
  });

  it('reports the states a read can have', () => {
    expect([...CREDENTIAL_STORE.states]).toEqual([
      'absent',
      'read-failed',
      'corrupt',
      'refused-symlink',
      'present',
    ]);
  });

  it('names the record keys and the single-credential file suffixes', () => {
    expect(CREDENTIAL_STORE.recordKeys).toContain('claudeAiOauth');
    expect(CREDENTIAL_STORE.recordKeys).toContain('mcpXaaIdp');
    expect(CREDENTIAL_STORE.recordKeys).toContain('mcpXaaIdpConfig');
    expect(CREDENTIAL_STORE.recordKeys).toContain('trustedDeviceToken');
    expect([...CREDENTIAL_STORE.fileSuffixes]).toEqual([
      '.oauth_token',
      '.api_key',
      '.session_ingress_token',
    ]);
  });
});

describe('the pure helpers', () => {
  it('normalises an issuer the way the target keys its cache', () => {
    expect(authIssuerKey('https://IDP.example.com/')).toBe('https://idp.example.com/');
    expect(authIssuerKey('https://idp.example.com///')).toBe('https://idp.example.com/');
    expect(authIssuerKey('https://idp.example.com/oidc/')).toBe('https://idp.example.com/oidc');
    expect(authIssuerKey('not a url/')).toBe('not a url');
  });

  it('reads the expiry out of an id_token, and falls back to an hour', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString('base64url');
    const jwt = `header.${payload}.signature`;
    expect(idTokenExpiryMs(jwt)).toBe(1_700_000_000 * 1000);
    expect(idTokenExpiryMs('not-a-jwt')).toBeUndefined();
    expect(idTokenCacheExpiryMs('not-a-jwt', 1_000_000)).toBe(1_000_000 + 3_600_000);
  });

  it('treats a cached id_token with less than a minute left as absent', () => {
    const now = 1_000_000;
    expect(isCachedIdTokenUsable({ idToken: 't', expiresAt: now + 120_000 }, now)).toBe(true);
    expect(isCachedIdTokenUsable({ idToken: 't', expiresAt: now + 30_000 }, now)).toBe(false);
    expect(isCachedIdTokenUsable(undefined, now)).toBe(false);
  });
});

describe('a connection that names an auth flow', () => {
  const connection: Connection = {
    id: 'c1',
    name: 'c1',
    route: 'firstParty',
    credential: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
    catalogSource: 'builtin',
    enabled: true,
    authFlow: 'firstParty',
  };

  it('refuses to resolve a credential for a flow this build cannot run', async () => {
    const registry = createProviderRegistry([connection]);
    await expect(resolveConnectionCredential(connection)).rejects.toThrow(
      /authentication flow|first-party/i,
    );
    expect(registry.list()).toHaveLength(1);
  });

  it('names the capability the flow needed', () => {
    const refusal = connectionAuthRefusal(connection);
    expect(refusal).toBeDefined();
    expect(refusal?.message).toContain(AUTH_FLOWS.firstParty.requiredCapability);
  });

  it('leaves a connection with no flow exactly as it was', async () => {
    const plain: Connection = { ...connection, authFlow: undefined };
    expect(connectionAuthRefusal(plain)).toBeUndefined();
    const resolved = await resolveConnectionCredential(plain, {
      ANTHROPIC_API_KEY: 'sk-test',
    });
    expect(resolved.present).toBe(true);
  });
});
