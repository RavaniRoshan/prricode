/**
 * Contract test for the endpoint catalogue, the egress rules and the corporate
 * proxy.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded in
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-endpoint-catalogue.md` —
 * every claim there carries a file and a byte offset. The milestone is `CC-038`
 * of `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 * Conformance table: `docs/compatibility/provider-catalog.md`.
 *
 * What this test pins:
 *
 *   - **the catalogue itself**: the eleven services, in the target's declaration
 *     order, with their toggle keys, their group labels and every endpoint each
 *     one carries — the hosts, the paths, the origins, the CSP directives, the
 *     `firewallAlso` companions and the platform restriction;
 *   - **the host constants**: the twenty-odd hosts the catalogue and the egress
 *     rules are built from, spelled out here so a typo cannot pass;
 *   - **the rules that decide**: which services a configuration leaves enabled,
 *     which hosts the firewall list carries, which endpoints the renderer and
 *     the subprocess get, and the label a requirement is reported under;
 *   - **the egress-entry grammar**: the target's own `host[:port]` parser, its
 *     accepted and rejected forms, and the two helpers built on it;
 *   - **the corporate proxy**: the environment-variable precedence, the
 *     `no_proxy` matcher, the target's own error text, the helper's TTL, and the
 *     helper's configuration shape;
 *   - **the honest boundary**: the two operations that this implementation
 *     cannot perform — installing a corporate proxy agent, and enforcing the
 *     target's egress firewall — refuse, and each refusal names the capability
 *     it needed.
 */

import { describe, expect, it } from 'vitest';

import {
  CorporateProxyCapabilityError,
  DEPENDENCY_INSTALL_DOMAINS,
  EGRESS_CORE_GROUP_LABEL,
  EGRESS_ENTRY_GRAMMAR,
  EGRESS_HOSTS,
  EGRESS_SERVICE_KEYS,
  EGRESS_SERVICES,
  GATEWAY_INTERNAL_NETWORKS_ERROR_CODE,
  MINIMAL_EGRESS_DOMAINS,
  PROXY_AUTH_HELPER_PROJECT_MESSAGE,
  PROXY_AUTH_HELPER_TTL_MS,
  PROXY_ENVIRONMENT_VARIABLES,
  PROXY_SETTING_REFUSED_MESSAGE,
  computeEgressRequirements,
  dropPortScopedEgressEntries,
  egressAddress,
  egressHostsForService,
  egressRequirementLabel,
  egressServiceLabel,
  egressSubprocessHosts,
  enabledEgressServices,
  firewallHostsForEgressServices,
  installCorporateProxyAgent,
  isAnthropicFirstPartyHost,
  isAnthropicHost,
  matchesNoProxy,
  parseEgressHostEntry,
  proxyAuthHelperTtl,
  proxyUrlError,
  readProxyAuthHelperConfig,
  rendererEgressRules,
  resolveEgressEndpoints,
  resolveNoProxy,
  resolveProxyUrl,
  stripEgressEntryPort,
  validateGatewayInternalNetworks,
  type EgressHostContext,
  type EgressServiceKey,
} from '../../src/provider/routes.js';

import {
  EGRESS_FIREWALL_CAPABILITY,
  EgressFirewallCapabilityError,
  enforceSandboxEgress,
  evaluateSandboxEgress,
  parseSandboxHostEntry,
  readSandboxNetworkPolicy,
  sandboxHostEntryMatches,
  sandboxHostMatches,
} from '../../src/platform/sandbox/policy.js';

/* -------------------------------------------------------------------------- */
/* The catalogue                                                               */
/* -------------------------------------------------------------------------- */

describe('the endpoint catalogue', () => {
  it('holds eleven services, in the target\'s declaration order', () => {
    expect(EGRESS_SERVICE_KEYS).toEqual([
      'vm-bundle',
      'model-catalog',
      'updater',
      'sentry',
      'datadog-rum',
      'anthropic-telemetry',
      'connector-favicons',
      'artifact-sandbox',
      'mcp-app-sandbox',
      'spellcheck-dictionary',
      'dictation',
    ]);
    expect(EGRESS_SERVICES).toHaveLength(11);
    expect(EGRESS_SERVICES.map((service) => service.key)).toEqual([...EGRESS_SERVICE_KEYS]);
  });

  it('binds each service to its toggle key and its group label', () => {
    const byKey = new Map(EGRESS_SERVICES.map((service) => [service.key, service]));
    const toggleOf = (key: EgressServiceKey): string | null => byKey.get(key)?.toggleKey ?? null;
    const labelOf = (key: EgressServiceKey): string | undefined => byKey.get(key)?.label;

    expect(toggleOf('vm-bundle')).toBeNull();
    expect(toggleOf('model-catalog')).toBeNull();
    expect(toggleOf('dictation')).toBeNull();
    expect(toggleOf('updater')).toBe('disableAutoUpdates');
    expect(toggleOf('sentry')).toBe('disableEssentialTelemetry');
    expect(toggleOf('datadog-rum')).toBe('disableEssentialTelemetry');
    expect(toggleOf('anthropic-telemetry')).toBe('disableNonessentialTelemetry');
    expect(toggleOf('connector-favicons')).toBe('disableNonessentialServices');
    expect(toggleOf('artifact-sandbox')).toBe('disableNonessentialServices');
    expect(toggleOf('mcp-app-sandbox')).toBe('disableNonessentialServices');
    expect(toggleOf('spellcheck-dictionary')).toBe('disableNonessentialServices');

    expect(labelOf('vm-bundle')).toBe(EGRESS_CORE_GROUP_LABEL);
    expect(labelOf('model-catalog')).toBe(EGRESS_CORE_GROUP_LABEL);
    expect(labelOf('dictation')).toBe(EGRESS_CORE_GROUP_LABEL);
    expect(labelOf('updater')).toBe('Auto-updates');
    expect(labelOf('sentry')).toBe('Essential telemetry');
    expect(labelOf('datadog-rum')).toBe('Essential telemetry');
    expect(labelOf('anthropic-telemetry')).toBe('Nonessential telemetry');
    expect(labelOf('connector-favicons')).toBe('Nonessential services');
    expect(labelOf('artifact-sandbox')).toBe('Nonessential services');
    expect(labelOf('mcp-app-sandbox')).toBe('Nonessential services');
    expect(labelOf('spellcheck-dictionary')).toBe('Nonessential services');
  });

  it('names the group labels the target declares', () => {
    expect(EGRESS_CORE_GROUP_LABEL).toBe('Core (VM bundle + PRRICODE CLI binary)');
  });

  it('lists the host constants the catalogue is built from', () => {
    expect(EGRESS_HOSTS.VM_BUNDLE_HOST).toBe('downloads.claude.ai');
    expect(EGRESS_HOSTS.UPDATE_FEED_HOST).toBe('releases.claude.com');
    expect(EGRESS_HOSTS.ANTHROPIC_API_HOST).toBe('api.anthropic.com');
    expect(EGRESS_HOSTS.CLAUDE_AI_HOST).toBe('claude.ai');
    expect(EGRESS_HOSTS.GCS_SIGNED_URL_HOST).toBe('storage.googleapis.com');
    expect(EGRESS_HOSTS.PLATFORM_CLAUDE_HOST).toBe('platform.claude.com');
    expect(EGRESS_HOSTS.FAVICON_PROXY_HOST).toBe('www.google.com');
    expect(EGRESS_HOSTS.GSTATIC_WILDCARD).toBe('*.gstatic.com');
    expect(EGRESS_HOSTS.ARTIFACT_IFRAME_HOST).toBe('www.claudeusercontent.com');
    expect(EGRESS_HOSTS.FRAME_ARTIFACT_CONTENT_HOSTS).toEqual([
      '*.frame.claudeusercontent.com',
      '*.frame.staging.claudeusercontent.com',
    ]);
    expect(EGRESS_HOSTS.MCP_APP_SANDBOX_WILDCARD_HOST).toBe('*.claudemcpcontent.com');
    expect(EGRESS_HOSTS.MCP_APP_SANDBOX_BASE_HOST).toBe('sandbox.claudemcpcontent.com');
    expect(EGRESS_HOSTS.ANTHROPIC_ASSETS_HOST).toBe('assets.claude.ai');
    expect(EGRESS_HOSTS.SENTRY_WILDCARD_HOST).toBe('*.sentry.io');
    expect(EGRESS_HOSTS.SENTRY_INGEST_HOST).toBe('o1158394.ingest.us.sentry.io');
    expect(EGRESS_HOSTS.SPELLCHECK_DICTIONARY_HOST).toBe('redirector.gvt1.com');
    expect(EGRESS_HOSTS.SPELLCHECK_DICTIONARY_WILDCARD).toBe('*.gvt1.com');
    expect(EGRESS_HOSTS.MICROSOFT_LOGIN_HOST).toBe('login.microsoftonline.com');
    expect(EGRESS_HOSTS.GOOGLE_ACCOUNTS_HOST).toBe('accounts.google.com');
    expect(EGRESS_HOSTS.GOOGLE_OAUTH2_HOST).toBe('oauth2.googleapis.com');
    expect(EGRESS_HOSTS.GOOGLE_STS_HOST).toBe('sts.googleapis.com');
    expect(EGRESS_HOSTS.GOOGLE_IAMCRED_HOST).toBe('iamcredentials.googleapis.com');
    expect(EGRESS_HOSTS.DATADOG_INTAKE_HOSTS).toEqual([
      'browser-intake-datadoghq.com',
      'browser-intake-us3-datadoghq.com',
      'browser-intake-us5-datadoghq.com',
      'browser-intake-ap1-datadoghq.com',
      'browser-intake-ap2-datadoghq.com',
      'browser-intake-datadoghq.eu',
      'browser-intake-ddog-gov.com',
    ]);
    expect(EGRESS_HOSTS.VERTEX_AUTH_HOSTS).toEqual([
      'oauth2.googleapis.com',
      'sts.googleapis.com',
      'accounts.google.com',
      'iamcredentials.googleapis.com',
    ]);
    expect(MINIMAL_EGRESS_DOMAINS).toEqual([
      '*.anthropic.com',
      'anthropic.com',
      'claude.com',
      '*.claude.com',
    ]);
    expect(DEPENDENCY_INSTALL_DOMAINS).toHaveLength(19);
    expect(DEPENDENCY_INSTALL_DOMAINS).toContain('registry.npmjs.org');
    expect(DEPENDENCY_INSTALL_DOMAINS).toContain('pypi.org');
  });

  it('carries the two core services, both on the VM bundle host', () => {
    const context: EgressHostContext = { anthropicHost: 'claude.ai' };
    const bundle = resolveEgressEndpoints('vm-bundle', context);
    expect(bundle).toHaveLength(1);
    expect(bundle[0]).toMatchObject({
      host: 'downloads.claude.ai',
      origin: 'main',
    });

    const catalog = resolveEgressEndpoints('model-catalog', context);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ host: 'downloads.claude.ai', origin: 'main' });
  });

  it('carries the updater service in both of its forms', () => {
    const viaUpdatesHost = resolveEgressEndpoints('updater', {
      anthropicHost: 'claude.ai',
      updateViaUpdatesHost: true,
    });
    expect(viaUpdatesHost).toHaveLength(2);
    expect(viaUpdatesHost[0]).toMatchObject({
      host: 'releases.claude.com',
      path: '/api/desktop/',
      pathSuffix: '/update',
      origin: 'main',
    });
    expect(viaUpdatesHost[1]).toMatchObject({
      host: 'downloads.claude.ai',
      path: '/releases/',
      followRedirects: true,
      origin: 'main',
    });

    const viaApi = resolveEgressEndpoints('updater', {
      anthropicHost: 'claude.ai',
      updateViaUpdatesHost: false,
    });
    expect(viaApi).toHaveLength(3);
    expect(viaApi[0]).toMatchObject({
      host: 'claude.ai',
      path: '/api/desktop/',
      pathSuffix: '/update',
      origin: 'renderer',
    });
    expect(viaApi[1]).toMatchObject({
      host: 'api.anthropic.com',
      path: '/api/desktop/',
      pathSuffix: '/update',
      origin: 'renderer',
    });
    expect(viaApi[2]).toMatchObject({
      host: 'downloads.claude.ai',
      path: '/releases/',
      followRedirects: true,
      origin: 'main',
    });
  });

  it('carries the sentry service, with its ingest companion', () => {
    const endpoints = resolveEgressEndpoints('sentry', { anthropicHost: 'claude.ai' });
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]).toMatchObject({
      host: '*.sentry.io',
      origin: 'renderer',
      firewallAlso: ['*.ingest.us.sentry.io'],
    });
    expect(endpoints[1]).toMatchObject({ host: 'sentry.io', origin: 'renderer' });
  });

  it('carries the datadog service, with the seven intake hosts', () => {
    const endpoints = resolveEgressEndpoints('datadog-rum', { anthropicHost: 'claude.ai' });
    expect(endpoints).toHaveLength(8);
    expect(endpoints[0]).toMatchObject({
      host: 'claude.ai',
      path: '/api/v2/rum',
      exactPath: true,
      origin: 'renderer',
      undeliveredAs503: true,
    });
    expect(endpoints.slice(1).map((endpoint) => endpoint.host)).toEqual([
      'browser-intake-datadoghq.com',
      'browser-intake-us3-datadoghq.com',
      'browser-intake-us5-datadoghq.com',
      'browser-intake-ap1-datadoghq.com',
      'browser-intake-ap2-datadoghq.com',
      'browser-intake-datadoghq.eu',
      'browser-intake-ddog-gov.com',
    ]);
  });

  it('carries the anthropic telemetry service, with its subprocess leg', () => {
    const endpoints = resolveEgressEndpoints('anthropic-telemetry', { anthropicHost: 'claude.ai' });
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]).toMatchObject({
      host: 'claude.ai',
      path: '/api/event_logging/',
      origin: 'renderer',
    });
    expect(endpoints[1]).toMatchObject({
      host: 'api.anthropic.com',
      path: '/api/event_logging/',
      origin: 'subprocess',
    });
  });

  it('carries the favicon, artifact, MCP-app and spellcheck services', () => {
    const favicons = resolveEgressEndpoints('connector-favicons', { anthropicHost: 'claude.ai' });
    expect(favicons).toHaveLength(2);
    expect(favicons[0]).toMatchObject({
      host: 'www.google.com',
      path: '/s2/favicons',
      followRedirects: true,
      origin: 'renderer',
      cspDirective: 'img-src',
    });
    expect(favicons[1]).toMatchObject({
      host: '*.gstatic.com',
      path: '/faviconV2',
      origin: 'renderer',
      cspDirective: 'img-src',
    });

    const artifact = resolveEgressEndpoints('artifact-sandbox', { anthropicHost: 'claude.ai' });
    expect(artifact).toHaveLength(1);
    expect(artifact[0]).toMatchObject({
      host: 'www.claudeusercontent.com',
      origin: 'renderer',
      cspDirective: 'frame-src',
      firewallAlso: ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'cdn.jsdelivr.net'],
    });

    const mcpApp = resolveEgressEndpoints('mcp-app-sandbox', { anthropicHost: 'claude.ai' });
    expect(mcpApp).toHaveLength(1);
    expect(mcpApp[0]).toMatchObject({
      host: '*.claudemcpcontent.com',
      origin: 'renderer',
      cspDirective: 'frame-src',
      firewallAlso: ['assets.claude.ai'],
    });

    const spellcheck = resolveEgressEndpoints('spellcheck-dictionary', { anthropicHost: 'claude.ai' });
    expect(spellcheck).toHaveLength(1);
    expect(spellcheck[0]).toMatchObject({
      host: 'redirector.gvt1.com',
      origin: 'main',
      platforms: ['linux'],
      firewallAlso: ['*.gvt1.com'],
    });
  });

  it('honours the artifact iframe host override and the dictation context', () => {
    const artifact = resolveEgressEndpoints('artifact-sandbox', {
      anthropicHost: 'claude.ai',
      artifactIframeHost: 'renderer.internal.example',
    });
    expect(artifact[0]?.host).toBe('renderer.internal.example');

    expect(resolveEgressEndpoints('dictation', { anthropicHost: 'claude.ai' })).toEqual([]);
    const dictation = resolveEgressEndpoints('dictation', {
      anthropicHost: 'claude.ai',
      dictationCsp: { host: 'dictation.example', scheme: 'wss://' },
    });
    expect(dictation).toHaveLength(1);
    expect(dictation[0]).toMatchObject({
      host: 'dictation.example',
      origin: 'renderer',
      cspDirective: 'connect-src',
      cspScheme: 'wss://',
    });
  });

  it('filters an endpoint by the platform the context names', () => {
    const onLinux = resolveEgressEndpoints('spellcheck-dictionary', {
      anthropicHost: 'claude.ai',
      platform: 'linux',
    });
    expect(onLinux).toHaveLength(1);

    const onDarwin = resolveEgressEndpoints('spellcheck-dictionary', {
      anthropicHost: 'claude.ai',
      platform: 'darwin',
    });
    expect(onDarwin).toEqual([]);

    // No platform at all: the target does not filter.
    expect(
      resolveEgressEndpoints('spellcheck-dictionary', { anthropicHost: 'claude.ai' }),
    ).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The rules that decide                                                       */
/* -------------------------------------------------------------------------- */

describe('the egress rules', () => {
  it('lists the service hosts and their firewall companions', () => {
    const hosts = egressHostsForService('artifact-sandbox', { anthropicHost: 'claude.ai' });
    expect(hosts).toEqual([
      'www.claudeusercontent.com',
      'cdnjs.cloudflare.com',
      'fonts.googleapis.com',
      'cdn.jsdelivr.net',
    ]);
  });

  it('leaves a service enabled until its own toggle is exactly true', () => {
    expect(enabledEgressServices({})).toEqual([...EGRESS_SERVICE_KEYS]);

    expect(enabledEgressServices({ disableAutoUpdates: true })).not.toContain('updater');
    expect(enabledEgressServices({ disableAutoUpdates: false })).toContain('updater');
    expect(enabledEgressServices({ disableAutoUpdates: 'true' })).toContain('updater');
    expect(enabledEgressServices({ disableAutoUpdates: 1 })).toContain('updater');

    expect(enabledEgressServices({ telemetry: { disableEssential: true } })).not.toContain('sentry');
    expect(enabledEgressServices({ telemetry: { disableEssential: true } })).not.toContain(
      'datadog-rum',
    );
    expect(
      enabledEgressServices({ telemetry: { disableNonessential: true } }),
    ).not.toContain('anthropic-telemetry');
    expect(
      enabledEgressServices({ telemetry: { disableNonessentialServices: true } }),
    ).not.toContain('connector-favicons');
  });

  it('prefers the nested form of a toggle over the flat one', () => {
    // The nested value wins even when it does not disable: the flat value is
    // then never consulted.
    expect(
      enabledEgressServices({ telemetry: { disableEssential: false }, disableEssentialTelemetry: true }),
    ).toContain('sentry');
    // The nested value wins even when it does disable.
    expect(
      enabledEgressServices({ telemetry: { disableEssential: true }, disableEssentialTelemetry: false }),
    ).not.toContain('sentry');
    // The auto-update toggle reads `autoUpdate.disabled` first.
    expect(enabledEgressServices({ autoUpdate: { disabled: true } })).not.toContain('updater');
    expect(
      enabledEgressServices({ autoUpdate: { disabled: false }, disableAutoUpdates: true }),
    ).toContain('updater');
  });

  it('never disables a service that has no toggle', () => {
    const enabled = enabledEgressServices({
      disableAutoUpdates: true,
      disableEssentialTelemetry: true,
      disableNonessentialTelemetry: true,
      disableNonessentialServices: true,
    });
    expect(enabled).toEqual(['vm-bundle', 'model-catalog', 'dictation']);
  });

  it('pairs every firewall host with the toggle that governs it', () => {
    const hosts = firewallHostsForEgressServices(
      { telemetry: { disableNonessentialServices: true } },
      { anthropicHost: 'claude.ai', updateViaUpdatesHost: true },
    );
    const byHost = new Map<string, string | null>();
    for (const entry of hosts) {
      if (!byHost.has(entry.host)) byHost.set(entry.host, entry.toggleKey);
    }
    expect(byHost.get('downloads.claude.ai')).toBeNull();
    expect(byHost.get('releases.claude.com')).toBe('disableAutoUpdates');
    expect(byHost.get('*.sentry.io')).toBe('disableEssentialTelemetry');
    // The datadog service comes before the telemetry service, so the first
    // entry for the first-party host is the datadog one.
    expect(byHost.get('claude.ai')).toBe('disableEssentialTelemetry');
    // A disabled service contributes nothing at all.
    expect(byHost.has('www.google.com')).toBe(false);
  });

  it('names the subprocess hosts apart from the renderer ones', () => {
    const subprocess = egressSubprocessHosts({}, { anthropicHost: 'claude.ai' });
    expect(subprocess).toEqual(['api.anthropic.com']);
  });

  it('reduces the renderer endpoints to their rules', () => {
    const rules = rendererEgressRules(['updater', 'datadog-rum'], {
      anthropicHost: 'claude.ai',
      updateViaUpdatesHost: false,
    });
    expect(rules).toEqual([
      {
        host: 'claude.ai',
        path: '/api/desktop/',
        pathSuffix: '/update',
      },
      {
        host: 'api.anthropic.com',
        path: '/api/desktop/',
        pathSuffix: '/update',
      },
      {
        host: 'claude.ai',
        path: '/api/v2/rum',
        exactPath: true,
        undeliveredAs503: true,
      },
      { host: 'browser-intake-datadoghq.com' },
      { host: 'browser-intake-us3-datadoghq.com' },
      { host: 'browser-intake-us5-datadoghq.com' },
      { host: 'browser-intake-ap1-datadoghq.com' },
      { host: 'browser-intake-ap2-datadoghq.com' },
      { host: 'browser-intake-datadoghq.eu' },
      { host: 'browser-intake-ddog-gov.com' },
    ]);
  });

  it('reports the label a requirement is filed under', () => {
    expect(egressServiceLabel(null)).toBe(EGRESS_CORE_GROUP_LABEL);
    expect(egressServiceLabel('disableAutoUpdates')).toBe('Auto-updates');
    expect(egressServiceLabel('disableEssentialTelemetry')).toBe('Essential telemetry');
    expect(egressServiceLabel('disableNonessentialTelemetry')).toBe('Nonessential telemetry');
    expect(egressServiceLabel('disableNonessentialServices')).toBe('Nonessential services');
    expect(egressServiceLabel('disableNothing' as never)).toBeUndefined();

    expect(egressRequirementLabel('core')).toBe(EGRESS_CORE_GROUP_LABEL);
    expect(egressRequirementLabel('disableEssentialTelemetry')).toBe('Essential telemetry');
  });

  it('computes the egress requirements, de-duplicated by host', () => {
    const requirements = computeEgressRequirements(
      {},
      { anthropicHost: 'claude.ai', updateViaUpdatesHost: true },
    );
    const hosts = requirements.map((requirement) => requirement.host);
    expect(new Set(hosts).size).toBe(hosts.length);
    expect(hosts).toContain('downloads.claude.ai');
    expect(hosts).toContain('releases.claude.com');

    const byHost = new Map(requirements.map((requirement) => [requirement.host, requirement.fieldKey]));
    expect(byHost.get('downloads.claude.ai')).toBe('core');
    expect(byHost.get('releases.claude.com')).toBe('disableAutoUpdates');
    expect(byHost.get('*.sentry.io')).toBe('disableEssentialTelemetry');
  });

  it('normalises an egress address and recognises the vendor hosts', () => {
    expect(egressAddress('https://api.anthropic.com')).toBe('api.anthropic.com');
    expect(egressAddress('http://proxy.example.com:8080')).toBe('http://proxy.example.com:8080');
    expect(egressAddress(undefined)).toBeUndefined();

    expect(isAnthropicHost('api.anthropic.com')).toBe(true);
    expect(isAnthropicHost('anthropic.com')).toBe(true);
    expect(isAnthropicHost('notanthropic.com')).toBe(false);
    expect(isAnthropicFirstPartyHost('claude.ai')).toBe(true);
    expect(isAnthropicFirstPartyHost('a.claude.com')).toBe(true);
    // The first-party set is `anthropic.com`, `claude.ai` and `claude.com`, and
    // a subdomain of one of them is a first-party host too.
    expect(isAnthropicFirstPartyHost('api.anthropic.com')).toBe(true);
    expect(isAnthropicFirstPartyHost('example.com')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The egress-entry grammar                                                    */
/* -------------------------------------------------------------------------- */

describe('the egress-entry grammar', () => {
  it('states the target\'s own grammar', () => {
    expect(EGRESS_ENTRY_GRAMMAR).toBe(
      '`*`, `localhost`, `host[:port]`, or `*.host[:port]` (port 1-65535; no port on bare `*`; no scheme, path, or IPv6 literal)',
    );
  });

  it('parses the forms the target accepts', () => {
    expect(parseEgressHostEntry('*')).toEqual({ host: '*' });
    expect(parseEgressHostEntry('localhost')).toEqual({ host: 'localhost' });
    expect(parseEgressHostEntry('example.com')).toEqual({ host: 'example.com' });
    expect(parseEgressHostEntry('EXAMPLE.com')).toEqual({ host: 'example.com' });
    expect(parseEgressHostEntry('*.example.com')).toEqual({ host: '*.example.com' });
    expect(parseEgressHostEntry('example.com:443')).toEqual({ host: 'example.com', port: 443 });
    expect(parseEgressHostEntry('*.example.com:8443')).toEqual({
      host: '*.example.com',
      port: 8443,
    });
  });

  it('refuses the forms the target refuses', () => {
    expect(parseEgressHostEntry('*:443')).toBeNull();
    expect(parseEgressHostEntry('example')).toBeNull();
    expect(parseEgressHostEntry('example.com:0')).toBeNull();
    expect(parseEgressHostEntry('example.com:65536')).toBeNull();
    expect(parseEgressHostEntry('example.com:99999')).toBeNull();
    expect(parseEgressHostEntry('http://example.com')).toBeNull();
    expect(parseEgressHostEntry('example.com/path')).toBeNull();
    expect(parseEgressHostEntry('[::1]')).toBeNull();
    expect(parseEgressHostEntry('')).toBeNull();
  });

  it('strips the port and drops the port-scoped entries', () => {
    expect(stripEgressEntryPort('example.com:443')).toBe('example.com');
    expect(stripEgressEntryPort('example.com')).toBe('example.com');
    expect(stripEgressEntryPort('not a host')).toBe('not a host');
    expect(
      dropPortScopedEgressEntries(['example.com', 'example.com:443', 'other.com:8443', 'nonsense']),
    ).toEqual(['example.com', 'nonsense']);
  });
});

/* -------------------------------------------------------------------------- */
/* The enterprise gateway's internal-network allowlist                          */
/* -------------------------------------------------------------------------- */

describe("the enterprise gateway's internal-network allowlist", () => {
  it('accepts a public block and returns it in the canonical form', () => {
    const result = validateGatewayInternalNetworks(['8.8.8.0/24']);
    expect(result.ok).toBe(true);
    expect(result.networks).toEqual(['8.8.8.0/24']);
    expect(result.reason).toBeUndefined();
  });

  it('accepts an empty list and an absent one', () => {
    expect(validateGatewayInternalNetworks([]).ok).toBe(true);
    expect(validateGatewayInternalNetworks(undefined).ok).toBe(true);
    expect(validateGatewayInternalNetworks(undefined).networks).toEqual([]);
  });

  it('refuses a list that could not be read', () => {
    const result = validateGatewayInternalNetworks(['(unreadable)']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      'is not a list of CIDR strings; sign-in is refused until it is fixed',
    );
    expect(result.message).toBe(
      'gatewayInternalNetworks in managed settings is not a list of CIDR strings; sign-in is refused until it is fixed.',
    );
  });

  it('refuses a block that is not a first-address /prefix in /8../32', () => {
    const expected =
      'entry "8.8.8.5/24" is not an IPv4 block written as first-address/prefix, ' +
      '/8 to /32 (like 203.0.113.0/24, but your own)';
    expect(validateGatewayInternalNetworks(['8.8.8.5/24']).reason).toBe(expected);
    expect(validateGatewayInternalNetworks(['8.8.8.0/7']).reason).toContain(
      'entry "8.8.8.0/7" is not an IPv4 block',
    );
    expect(validateGatewayInternalNetworks(['8.8.8.0/33']).reason).toContain(
      'entry "8.8.8.0/33" is not an IPv4 block',
    );
    expect(validateGatewayInternalNetworks(['not-an-address/24']).reason).toContain(
      'is not an IPv4 block',
    );
  });

  it('refuses a block that overlaps the private address space', () => {
    expect(validateGatewayInternalNetworks(['10.0.0.0/8']).reason).toBe(
      'entry "10.0.0.0/8" overlaps private address space (10.0.0.0/8), where /login accepts a ' +
        'gateway without this key; declare only the public block your network is numbered from',
    );
    expect(validateGatewayInternalNetworks(['100.64.0.0/10']).reason).toContain(
      'overlaps private address space (100.64.0.0/10)',
    );
  });

  it('refuses a block that overlaps a documentation, a shared or a reserved range', () => {
    expect(validateGatewayInternalNetworks(['192.0.2.0/24']).reason).toBe(
      'entry "192.0.2.0/24" overlaps 192.0.2.0/24, a documentation example range that is no one\'s network',
    );
    expect(validateGatewayInternalNetworks(['198.18.0.0/15']).reason).toBe(
      'entry "198.18.0.0/15" overlaps 198.18.0.0/15, which VPN and NAT64 clients use locally',
    );
    expect(validateGatewayInternalNetworks(['0.0.0.0/8']).reason).toBe(
      'entry "0.0.0.0/8" overlaps 0.0.0.0/8, reserved address space no network is numbered from',
    );
    // A reserved range whose prefix is shorter than /8 is refused by the
    // prefix rule first, which is the target's own order.
    expect(validateGatewayInternalNetworks(['224.0.0.0/4']).reason).toContain(
      'is not an IPv4 block written as first-address/prefix',
    );
  });

  it('refuses more than four blocks', () => {
    const result = validateGatewayInternalNetworks([
      '8.8.8.0/24',
      '9.9.9.0/24',
      '11.11.11.0/24',
      '12.12.12.0/24',
      '13.13.13.0/24',
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('lists 5 blocks; at most 4 are accepted');
  });

  it('refuses two blocks that overlap each other', () => {
    const result = validateGatewayInternalNetworks(['8.8.0.0/16', '8.8.4.0/24']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('entries "8.8.0.0/16" and "8.8.4.0/24" overlap; list disjoint blocks');
  });

  it('de-duplicates a repeated block', () => {
    const result = validateGatewayInternalNetworks(['8.8.8.0/24', '8.8.8.0/24']);
    expect(result.ok).toBe(true);
    expect(result.networks).toEqual(['8.8.8.0/24']);
  });

  it('names the code the target raises for an invalid list', () => {
    expect(GATEWAY_INTERNAL_NETWORKS_ERROR_CODE).toBe(
      'gateway login: invalid gatewayInternalNetworks',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The corporate proxy                                                          */
/* -------------------------------------------------------------------------- */

describe('the corporate proxy', () => {
  it('reads the proxy variable in the target\'s order', () => {
    expect(PROXY_ENVIRONMENT_VARIABLES).toEqual([
      'https_proxy',
      'HTTPS_PROXY',
      'http_proxy',
      'HTTP_PROXY',
    ]);
    expect(resolveProxyUrl({ HTTPS_PROXY: 'http://a.example' })).toEqual({
      value: 'http://a.example',
      source: 'HTTPS_PROXY',
    });
    expect(
      resolveProxyUrl({ https_proxy: 'http://lower.example', HTTPS_PROXY: 'http://upper.example' }),
    ).toEqual({ value: 'http://lower.example', source: 'https_proxy' });
    expect(
      resolveProxyUrl({ http_proxy: 'http://plain.example', HTTP_PROXY: 'http://upper.example' }),
    ).toEqual({ value: 'http://plain.example', source: 'http_proxy' });
    expect(resolveProxyUrl({})).toBeUndefined();
  });

  it('reads the bypass list the target\'s way', () => {
    expect(resolveNoProxy({ no_proxy: 'a.example' })).toBe('a.example');
    expect(resolveNoProxy({ NO_PROXY: 'b.example' })).toBe('b.example');
    expect(resolveNoProxy({ no_proxy: 'a.example', NO_PROXY: 'b.example' })).toBe(
      'a.example,b.example',
    );
    expect(resolveNoProxy({ no_proxy: 'same.example', NO_PROXY: 'same.example' })).toBe(
      'same.example',
    );
    expect(resolveNoProxy({ no_proxy: '*' })).toBe('*');
    expect(resolveNoProxy({})).toBeUndefined();
  });

  it('matches a host against the bypass list the target\'s way', () => {
    expect(matchesNoProxy('https://a.example/x', '*')).toBe(true);
    expect(matchesNoProxy('https://a.example/x', undefined)).toBe(false);
    expect(matchesNoProxy('https://a.example/x', 'a.example')).toBe(true);
    expect(matchesNoProxy('https://a.example/x', 'b.example')).toBe(false);
    expect(matchesNoProxy('https://a.example/x', '*.example')).toBe(false);
    // A leading dot is the target's only wildcard form in the bypass list.
    expect(matchesNoProxy('https://a.example/x', '.example')).toBe(true);
    expect(matchesNoProxy('https://a.example/x', '.other.example')).toBe(false);
    // An entry with a colon is compared against `host:port`.
    expect(matchesNoProxy('https://a.example/x', 'a.example:443')).toBe(true);
    expect(matchesNoProxy('https://a.example:8443/x', 'a.example:443')).toBe(false);
    expect(matchesNoProxy('http://a.example/x', 'a.example:80')).toBe(true);
    // The list is split on commas and whitespace.
    expect(matchesNoProxy('https://a.example/x', 'b.example, a.example')).toBe(true);
  });

  it('states the target\'s own message for a proxy URL that does not parse', () => {
    expect(proxyUrlError('HTTPS_PROXY', 'not a url')).toBe(
      'Invalid proxy URL in HTTPS_PROXY: "not a url" cannot be parsed as a URL.\n' +
        'Proxy settings must be a complete URL including the scheme, e.g. "http://proxy.example.com:8080".\n' +
        'Fix or unset HTTPS_PROXY and restart PRRICODE.',
    );
  });

  it('caches the proxy-auth helper for five minutes by default', () => {
    expect(PROXY_AUTH_HELPER_TTL_MS).toBe(300000);
    expect(proxyAuthHelperTtl({})).toBe(300000);
    expect(proxyAuthHelperTtl({ CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS: '1000' })).toBe(1000);
    expect(proxyAuthHelperTtl({ CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS: '-1' })).toBe(300000);
    expect(proxyAuthHelperTtl({ CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS: 'nonsense' })).toBe(300000);
  });

  it('reads the proxy-auth helper out of the settings tiers', () => {
    const tiers = new Map<string, unknown>([
      ['userSettings', { proxyAuthHelper: 'get-token' }],
      ['projectSettings', { proxyAuthHelper: 'get-token' }],
    ]);
    const config = readProxyAuthHelperConfig(tiers as never);
    expect(config.helper).toBe('get-token');
    expect(config.fromProjectOrLocal).toBe(true);
    expect(config.sources).toBe('personAndPolicy');

    const policy = new Map<string, unknown>([
      ['policySettings', { proxyAuthHelper: 'policy-token' }],
      ['userSettings', { proxyAuthHelper: 'user-token' }],
    ]);
    const policyConfig = readProxyAuthHelperConfig(policy as never);
    expect(policyConfig.helper).toBe('policy-token');
    expect(policyConfig.fromProjectOrLocal).toBe(false);
  });

  it('names the two messages the target prints', () => {
    expect(PROXY_AUTH_HELPER_PROJECT_MESSAGE).toBe(
      'a proxy helper set by this project is not run by this command\n',
    );
    expect(PROXY_SETTING_REFUSED_MESSAGE).toBe('Error: the proxy setting named above is refused.');
  });

  it('refuses to install a corporate proxy agent, and names the capability', () => {
    expect(() => installCorporateProxyAgent({ HTTPS_PROXY: 'http://proxy.example:8080' })).toThrow(
      CorporateProxyCapabilityError,
    );
    try {
      installCorporateProxyAgent({ HTTPS_PROXY: 'http://proxy.example:8080' });
      expect.unreachable('the install must refuse');
    } catch (error) {
      const refusal = error as CorporateProxyCapabilityError;
      expect(refusal.code).toBe('corporate_proxy_unavailable');
      expect(refusal.capability).toContain('proxy');
      expect(refusal.message).toContain(refusal.capability);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The sandbox network policy                                                  */
/* -------------------------------------------------------------------------- */

describe('the sandbox network policy', () => {
  it('matches a host against an allowlist entry the target\'s way', () => {
    expect(sandboxHostMatches('api.github.com', 'api.github.com')).toBe(true);
    expect(sandboxHostMatches('API.GitHub.com', 'api.github.com')).toBe(true);
    expect(sandboxHostMatches('a.corp.com', '*.corp.com')).toBe(true);
    expect(sandboxHostMatches('a.b.corp.com', '*.corp.com')).toBe(true);
    expect(sandboxHostMatches('corp.com', '*.corp.com')).toBe(false);
    expect(sandboxHostMatches('anything', '*')).toBe(true);
    // A wildcard entry never matches an address literal.
    expect(sandboxHostMatches('127.0.0.1', '*.0.0.1')).toBe(false);
  });

  it('parses an entry into its host and its port', () => {
    expect(parseSandboxHostEntry('api.github.com')).toEqual({
      hostPattern: 'api.github.com',
      port: undefined,
    });
    expect(parseSandboxHostEntry('api.github.com:443')).toEqual({
      hostPattern: 'api.github.com',
      port: 443,
    });
  });

  it('restricts an entry to its port when it carries one', () => {
    expect(sandboxHostEntryMatches('api.github.com', 443, 'api.github.com:443')).toBe(true);
    expect(sandboxHostEntryMatches('api.github.com', 8443, 'api.github.com:443')).toBe(false);
    expect(sandboxHostEntryMatches('api.github.com', 8443, 'api.github.com')).toBe(true);
  });

  it('lets the deny list win over the allow list', () => {
    const policy = readSandboxNetworkPolicy({
      sandbox: {
        network: {
          allowedDomains: ['*.corp.com', 'api.github.com'],
          deniedDomains: ['secret.corp.com'],
        },
      },
    });
    expect(policy.allowedDomains).toEqual(['*.corp.com', 'api.github.com']);
    expect(policy.deniedDomains).toEqual(['secret.corp.com']);

    expect(evaluateSandboxEgress({ host: 'api.github.com', port: 443 }, policy).allowed).toBe(true);
    expect(evaluateSandboxEgress({ host: 'a.corp.com', port: 443 }, policy).allowed).toBe(true);
    const denied = evaluateSandboxEgress({ host: 'secret.corp.com', port: 443 }, policy);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('secret.corp.com');
  });

  it('denies a host the allowlist does not carry', () => {
    const policy = readSandboxNetworkPolicy({
      sandbox: { network: { allowedDomains: ['api.github.com'] } },
    });
    const decision = evaluateSandboxEgress({ host: 'evil.example', port: 443 }, policy);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('evil.example');
  });

  it('refuses to enforce the egress firewall, and names the capability', () => {
    expect(() =>
      enforceSandboxEgress({ host: 'api.github.com', port: 443 }, readSandboxNetworkPolicy({})),
    ).toThrow(EgressFirewallCapabilityError);
    try {
      enforceSandboxEgress(
        { host: 'api.github.com', port: 443 },
        readSandboxNetworkPolicy({}),
      );
      expect.unreachable('the enforcement must refuse');
    } catch (error) {
      const refusal = error as EgressFirewallCapabilityError;
      expect(refusal.code).toBe('egress_firewall_unavailable');
      expect(refusal.capability).toBe(EGRESS_FIREWALL_CAPABILITY);
      expect(refusal.message).toContain(EGRESS_FIREWALL_CAPABILITY);
    }
  });
});
