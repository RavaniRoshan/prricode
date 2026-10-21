/**
 * The MCP channels surface: the capability, the message form, the admission
 * decisions, the `--channels` grammar, the allowlist and the permission relay.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded
 * in `/home/shiva/opt/reference-agent-rea/analysis/findings-mcp-channels.md` —
 * every claim there carries a file and a byte offset. The milestone is
 * `CC-035` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The honest boundary.** This implementation has **no channel transport**:
 * there is no server that pushes, no admission pipeline in a live session and
 * no channel registry. So the surface is **recorded and shaped, never faked**:
 *
 *   - the capability's form, the message form, the admission decisions, the
 *     `--channels` grammar, the allowlist and the permission relay's rules are
 *     implemented;
 *   - the operations that would need a live channel-capable MCP server
 *     **refuse**, and the refusal **names the capability** it needs.
 *
 * **The count is the record's, corrected.** The baseline record listed **seven**
 * admission-decision kinds and the milestone brief said **six**; the target's
 * own gate holds **eight** — the record omitted `capability`, which is the
 * first check the gate makes.
 */

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_CAPABILITY,
  CHANNEL_GATE_KINDS,
  CHANNEL_HARD_REVOCATION_KINDS,
  CHANNEL_MESSAGE_METHOD,
  CHANNEL_MESSAGE_TAG,
  CHANNEL_META_KEY_PATTERN,
  CHANNEL_PERMISSION_CAPABILITY,
  CHANNEL_PERMISSION_METHOD,
  CHANNEL_PERMISSION_REQUEST_METHOD,
  ChannelPermissionRelay,
  ChannelTransportUnavailableError,
  declaresChannelCapability,
  deriveChannelRequestId,
  formatChannelMessage,
  gateChannelServer,
  getEffectiveChannelAllowlist,
  isChannelGateHardRevocation,
  isChannelsPolicyBlocked,
  parseChannelEntries,
  readChannelMessageParams,
  readChannelPermissionParams,
  registerChannelNotifications,
  requestChannelPermission,
  splitChannelMeta,
  type ChannelAllowlistEntry,
  type ChannelEntry,
  type ChannelGateInput,
  type ChannelPluginIdentity,
} from '../../src/extensions/mcp/channels.js';

/* -------------------------------------------------------------------------- */
/* The fixtures                                                                */
/* -------------------------------------------------------------------------- */

/** The capabilities of a server that declares the channel capability. */
const CHANNEL_CAPABILITIES = { experimental: { 'claude/channel': {} } };

/** The capabilities of a server that declares both channel capabilities. */
const CHANNEL_PERMISSION_CAPABILITIES = {
  experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
};

/** A session list holding one plugin entry. */
const PLUGIN_ENTRY: ChannelEntry = {
  kind: 'plugin',
  name: 'telegram',
  marketplace: 'anthropic',
};

/**
 * The name the target gives a plugin-provided MCP server.
 *
 * The target names it `plugin:<pluginName>:<serverKey>`, and a plugin entry
 * in the session list covers every server the plugin provides.
 */
const PLUGIN_SERVER_NAME = 'plugin:telegram:my-server';

/** A session list holding one server entry. */
const SERVER_ENTRY: ChannelEntry = { kind: 'server', name: 'my-server' };

/**
 * The input of a gate that would register.
 *
 * A **bare** server entry needs the development flag to be exempt from the
 * allowlist, so the fixture that satisfies every check carries one.
 */
function registering(overrides: Partial<ChannelGateInput> = {}): ChannelGateInput {
  return {
    serverName: 'my-server',
    capabilities: CHANNEL_CAPABILITIES,
    protocolEra: 'legacy',
    route: 'firstParty',
    channelsOffForSession: false,
    policySettings: { channelsEnabled: true },
    sessionChannels: [{ kind: 'server', name: 'my-server', dev: true }],
    ledgerAllowlist: [],
    resolvePlugin: () => undefined,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The capability                                                              */
/* -------------------------------------------------------------------------- */

describe('the channel capability', () => {
  it('names the two capabilities the target declares', () => {
    expect(CHANNEL_CAPABILITY).toBe('claude/channel');
    expect(CHANNEL_PERMISSION_CAPABILITY).toBe('claude/channel/permission');
  });

  it('names the three methods the target uses', () => {
    expect(CHANNEL_MESSAGE_METHOD).toBe('notifications/claude/channel');
    expect(CHANNEL_PERMISSION_METHOD).toBe('notifications/claude/channel/permission');
    expect(CHANNEL_PERMISSION_REQUEST_METHOD).toBe(
      'notifications/claude/channel/permission_request',
    );
  });

  it('reads the capability out of the experimental map', () => {
    expect(declaresChannelCapability(CHANNEL_CAPABILITIES, CHANNEL_CAPABILITY)).toBe(true);
    expect(
      declaresChannelCapability(CHANNEL_PERMISSION_CAPABILITIES, CHANNEL_PERMISSION_CAPABILITY),
    ).toBe(true);
  });

  it('reads a server that declares no channel capability as declaring none', () => {
    expect(declaresChannelCapability({}, CHANNEL_CAPABILITY)).toBe(false);
    expect(declaresChannelCapability({ experimental: {} }, CHANNEL_CAPABILITY)).toBe(false);
    expect(declaresChannelCapability(undefined, CHANNEL_CAPABILITY)).toBe(false);
    // The target's own read is a truthiness test, so an empty object is a
    // declaration and a null is not.
    expect(
      declaresChannelCapability({ experimental: { 'claude/channel': null } }, CHANNEL_CAPABILITY),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The admission decisions                                                     */
/* -------------------------------------------------------------------------- */

describe('the admission decisions', () => {
  it('holds exactly eight kinds, in the target\'s order', () => {
    expect(CHANNEL_GATE_KINDS).toEqual([
      'capability',
      'era',
      'provider',
      'disabled',
      'policy',
      'session',
      'marketplace',
      'allowlist',
    ]);
    expect(CHANNEL_GATE_KINDS).toHaveLength(8);
  });

  it('holds exactly four hard revocations', () => {
    expect(CHANNEL_HARD_REVOCATION_KINDS).toEqual([
      'provider',
      'disabled',
      'capability',
      'era',
    ]);
    expect(CHANNEL_HARD_REVOCATION_KINDS).toHaveLength(4);
  });

  it('tells the hard revocations from the soft ones', () => {
    for (const kind of CHANNEL_HARD_REVOCATION_KINDS) {
      expect(isChannelGateHardRevocation(kind)).toBe(true);
    }
    for (const kind of ['policy', 'session', 'marketplace', 'allowlist'] as const) {
      expect(isChannelGateHardRevocation(kind)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

describe('the channel gate', () => {
  it('registers a server that satisfies every check', () => {
    expect(gateChannelServer(registering())).toEqual({ action: 'register' });
  });

  it('skips a server that did not declare the capability', () => {
    const decision = gateChannelServer(registering({ capabilities: {} }));
    expect(decision).toEqual({
      action: 'skip',
      kind: 'capability',
      reason: 'server did not declare claude/channel capability',
    });
  });

  it('skips a connection that negotiated the modern protocol revision', () => {
    const decision = gateChannelServer(registering({ protocolEra: 'modern' }));
    expect(decision).toEqual({
      action: 'skip',
      kind: 'era',
      reason:
        'connection negotiated a modern protocol revision with no unsolicited notification path',
    });
  });

  it('skips a third-party provider', () => {
    const decision = gateChannelServer(registering({ route: 'bedrock' }));
    expect(decision).toEqual({
      action: 'skip',
      kind: 'provider',
      reason: 'channels are not available on third-party providers',
    });
  });

  it('skips a session in which the feature is off', () => {
    const decision = gateChannelServer(registering({ channelsOffForSession: true }));
    expect(decision).toEqual({
      action: 'skip',
      kind: 'disabled',
      reason: 'channels feature is not currently available',
    });
  });

  it('skips a session the org policy has not enabled', () => {
    const decision = gateChannelServer(registering({ policySettings: { channelsEnabled: false } }));
    expect(decision).toEqual({
      action: 'skip',
      kind: 'policy',
      reason: 'channels not enabled by org policy (set channelsEnabled: true in managed settings)',
    });
  });

  it('skips a server that is not in the session list', () => {
    const decision = gateChannelServer(registering({ serverName: 'other-server' }));
    expect(decision).toEqual({
      action: 'skip',
      kind: 'session',
      reason: 'server other-server not in --channels list for this session',
    });
  });

  it('skips a plugin that is not the one installed', () => {
    const decision = gateChannelServer(
      registering({
        serverName: PLUGIN_SERVER_NAME,
        sessionChannels: [PLUGIN_ENTRY],
        pluginSource: 'other@elsewhere',
        resolvePlugin: (id: string): ChannelPluginIdentity | undefined =>
          id === 'other@elsewhere' ? { name: 'other', marketplace: 'elsewhere' } : undefined,
      }),
    );
    expect(decision).toEqual({
      action: 'skip',
      kind: 'marketplace',
      reason:
        'you asked for plugin:telegram@anthropic but the installed plugin is other@elsewhere',
    });
  });

  it('skips a plugin that came from an unknown source', () => {
    const decision = gateChannelServer(
      registering({
        serverName: PLUGIN_SERVER_NAME,
        sessionChannels: [PLUGIN_ENTRY],
        pluginSource: 'telegram',
        resolvePlugin: (): ChannelPluginIdentity | undefined => undefined,
      }),
    );
    expect(decision).toEqual({
      action: 'skip',
      kind: 'marketplace',
      reason:
        'you asked for plugin:telegram@anthropic but the installed plugin is from an unknown source',
    });
  });

  it('skips a plugin that is not on the approved list', () => {
    const decision = gateChannelServer(
      registering({
        serverName: PLUGIN_SERVER_NAME,
        sessionChannels: [PLUGIN_ENTRY],
        pluginSource: 'telegram@anthropic',
        resolvePlugin: (): ChannelPluginIdentity => ({ name: 'telegram', marketplace: 'anthropic' }),
      }),
    );
    expect(decision).toEqual({
      action: 'skip',
      kind: 'allowlist',
      reason:
        'plugin telegram@anthropic is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)',
    });
  });

  it('names the org\'s own list when the org set one', () => {
    const decision = gateChannelServer(
      registering({
        serverName: PLUGIN_SERVER_NAME,
        sessionChannels: [PLUGIN_ENTRY],
        pluginSource: 'telegram@anthropic',
        resolvePlugin: (): ChannelPluginIdentity => ({ name: 'telegram', marketplace: 'anthropic' }),
        allowedChannelPlugins: [],
      }),
    );
    expect(decision).toEqual({
      action: 'skip',
      kind: 'allowlist',
      reason:
        'plugin telegram@anthropic is not on your org\'s approved channels list (set allowedChannelPlugins in managed settings)',
    });
  });

  it('registers a plugin that is on the approved list', () => {
    const decision = gateChannelServer(
      registering({
        serverName: PLUGIN_SERVER_NAME,
        sessionChannels: [PLUGIN_ENTRY],
        pluginSource: 'telegram@anthropic',
        resolvePlugin: (): ChannelPluginIdentity => ({ name: 'telegram', marketplace: 'anthropic' }),
        allowedChannelPlugins: [{ plugin: 'telegram', marketplace: 'anthropic' }],
      }),
    );
    expect(decision).toEqual({ action: 'register' });
  });

  it('registers a development entry without an allowlist', () => {
    const decision = gateChannelServer(
      registering({
        serverName: PLUGIN_SERVER_NAME,
        sessionChannels: [{ kind: 'plugin', name: 'telegram', marketplace: 'anthropic', dev: true }],
        pluginSource: 'telegram@anthropic',
        resolvePlugin: (): ChannelPluginIdentity => ({ name: 'telegram', marketplace: 'anthropic' }),
      }),
    );
    expect(decision).toEqual({ action: 'register' });
  });

  it('skips a bare server entry that is not a development entry', () => {
    const decision = gateChannelServer(registering({ sessionChannels: [SERVER_ENTRY] }));
    expect(decision).toEqual({
      action: 'skip',
      kind: 'allowlist',
      reason:
        'server my-server is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)',
    });
  });

  it('registers a bare server entry that is a development entry', () => {
    const decision = gateChannelServer(
      registering({
        sessionChannels: [{ kind: 'server', name: 'my-server', dev: true }],
      }),
    );
    expect(decision).toEqual({ action: 'register' });
  });

  it('checks the capability before anything else', () => {
    // Every other check would also fail; the capability is the first.
    const decision = gateChannelServer(
      registering({ capabilities: {}, protocolEra: 'modern', route: 'bedrock' }),
    );
    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') expect(decision.kind).toBe('capability');
  });
});

/* -------------------------------------------------------------------------- */
/* The policy block                                                            */
/* -------------------------------------------------------------------------- */

describe('the channel policy block', () => {
  it('blocks a non-first-party session whose policy does not enable channels', () => {
    expect(isChannelsPolicyBlocked({ channelsEnabled: false })).toBe(true);
    expect(isChannelsPolicyBlocked({})).toBe(true);
    expect(isChannelsPolicyBlocked({ channelsEnabled: true })).toBe(false);
  });

  it('does not block when the managed settings are absent', () => {
    expect(isChannelsPolicyBlocked(null)).toBe(false);
  });

  it('blocks a first-party team or enterprise session that did not opt in', () => {
    expect(
      isChannelsPolicyBlocked(
        { channelsEnabled: false },
        { isFirstPartySession: true, subscriptionType: 'team' },
      ),
    ).toBe(true);
    expect(
      isChannelsPolicyBlocked(
        { channelsEnabled: true },
        { isFirstPartySession: true, subscriptionType: 'enterprise' },
      ),
    ).toBe(false);
  });

  it('does not block a first-party session on another plan', () => {
    expect(
      isChannelsPolicyBlocked(
        { channelsEnabled: false },
        { isFirstPartySession: true, subscriptionType: 'max' },
      ),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The `--channels` grammar                                                    */
/* -------------------------------------------------------------------------- */

describe('the --channels grammar', () => {
  it('reads a server entry', () => {
    expect(parseChannelEntries(['server:my-server'], '--channels')).toEqual([
      { kind: 'server', name: 'my-server' },
    ]);
  });

  it('reads a plugin entry', () => {
    expect(parseChannelEntries(['plugin:telegram@anthropic'], '--channels')).toEqual([
      { kind: 'plugin', name: 'telegram', marketplace: 'anthropic' },
    ]);
  });

  it('refuses an untagged entry', () => {
    expect(() => parseChannelEntries(['my-server'], '--channels')).toThrow(
      '--channels entries must be tagged: my-server\n' +
        '  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\n' +
        '  server:<name>                — manually configured MCP server',
    );
  });

  it('refuses a plugin entry with no marketplace', () => {
    expect(() => parseChannelEntries(['plugin:telegram'], '--channels')).toThrow(
      '--channels entries must be tagged: plugin:telegram',
    );
  });

  it('names the flag it was given', () => {
    expect(() =>
      parseChannelEntries(['my-server'], '--dangerously-load-development-channels'),
    ).toThrow('--dangerously-load-development-channels entries must be tagged: my-server');
  });
});

/* -------------------------------------------------------------------------- */
/* The message form                                                            */
/* -------------------------------------------------------------------------- */

describe('the channel message form', () => {
  it('reads a message that carries content', () => {
    expect(readChannelMessageParams({ content: 'hello' })).toEqual({ content: 'hello' });
  });

  it('reads a message that carries meta', () => {
    expect(readChannelMessageParams({ content: 'hello', meta: { chat_id: '1' } })).toEqual({
      content: 'hello',
      meta: { chat_id: '1' },
    });
  });

  it('refuses a message with no content', () => {
    expect(readChannelMessageParams({})).toBeUndefined();
    expect(readChannelMessageParams({ content: 42 })).toBeUndefined();
    expect(readChannelMessageParams(undefined)).toBeUndefined();
  });

  it('refuses a meta member that is not a string', () => {
    expect(readChannelMessageParams({ content: 'hello', meta: { chat_id: 7 } })).toBeUndefined();
  });

  it('reads a permission answer', () => {
    expect(readChannelPermissionParams({ request_id: 'abc', behavior: 'allow' })).toEqual({
      request_id: 'abc',
      behavior: 'allow',
    });
    expect(readChannelPermissionParams({ request_id: 'abc', behavior: 'deny' })).toEqual({
      request_id: 'abc',
      behavior: 'deny',
    });
  });

  it('refuses a permission answer that is not one of the two behaviours', () => {
    expect(readChannelPermissionParams({ request_id: 'abc', behavior: 'maybe' })).toBeUndefined();
    expect(readChannelPermissionParams({ request_id: 'abc' })).toBeUndefined();
  });

  it('splits the meta keys on the identifier rule', () => {
    expect(CHANNEL_META_KEY_PATTERN.test('chat_id')).toBe(true);
    expect(CHANNEL_META_KEY_PATTERN.test('_x')).toBe(true);
    expect(CHANNEL_META_KEY_PATTERN.test('9x')).toBe(false);
    expect(CHANNEL_META_KEY_PATTERN.test('a-b')).toBe(false);

    const split = splitChannelMeta({ chat_id: '1', 'bad-key': '2', 'also bad': '3' });
    expect(split.kept).toEqual([['chat_id', '1']]);
    expect(split.dropped.map(([key]) => key)).toEqual(['bad-key', 'also bad']);
  });

  it('wraps a message in the channel envelope', () => {
    expect(formatChannelMessage('my-server', 'hello', { chat_id: '1' })).toBe(
      '<channel source="my-server" chat_id="1">\nhello\n</channel>',
    );
  });

  it('drops a meta key that is not an identifier', () => {
    const wrapped = formatChannelMessage('my-server', 'hello', { chat_id: '1', 'bad-key': '2' });
    expect(wrapped).toBe('<channel source="my-server" chat_id="1">\nhello\n</channel>');
  });

  it('escapes the attribute values', () => {
    expect(formatChannelMessage('my-server', 'hello', { q: 'a"b' })).toContain('q="a&quot;b"');
  });

  it('escapes a channel opener in the body', () => {
    expect(formatChannelMessage('my-server', '<channel source="other">x</channel>')).toContain(
      '<\\channel source="other">',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The allowlist                                                               */
/* -------------------------------------------------------------------------- */

describe('the effective channel allowlist', () => {
  it('prefers the org list', () => {
    const entries: ChannelAllowlistEntry[] = [{ plugin: 'a', marketplace: 'anthropic' }];
    expect(getEffectiveChannelAllowlist(entries, [])).toEqual({ entries, source: 'org' });
  });

  it('falls back to the ledger', () => {
    const entries: ChannelAllowlistEntry[] = [{ plugin: 'b', marketplace: 'anthropic' }];
    expect(getEffectiveChannelAllowlist(undefined, entries)).toEqual({ entries, source: 'ledger' });
  });

  it('treats an empty org list as an org list that allows nothing', () => {
    expect(getEffectiveChannelAllowlist([], [{ plugin: 'b', marketplace: 'anthropic' }])).toEqual({
      entries: [],
      source: 'org',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The permission relay                                                        */
/* -------------------------------------------------------------------------- */

describe('the channel permission relay', () => {
  it('derives a five-character request id from the tool use and the agent', () => {
    const id = deriveChannelRequestId('toolu_123', 'agent-1');
    expect(id).toHaveLength(5);
    expect(id).toMatch(/^[abcdefghijkmnopqrstuvwxyz]{5}$/);
  });

  it('derives the same id for the same seed', () => {
    expect(deriveChannelRequestId('toolu_123', 'agent-1')).toBe(
      deriveChannelRequestId('toolu_123', 'agent-1'),
    );
  });

  it('derives a different id for a different seed', () => {
    expect(deriveChannelRequestId('toolu_123', 'agent-1')).not.toBe(
      deriveChannelRequestId('toolu_124', 'agent-1'),
    );
  });

  it('resolves an answer against the pending request', () => {
    const relay = new ChannelPermissionRelay();
    const seen: unknown[] = [];
    relay.onResponse('AbC123', (answer) => seen.push(answer));
    expect(relay.resolve('abc123', 'allow', 'my-server')).toBe(true);
    expect(seen).toEqual([{ behavior: 'allow', fromServer: 'my-server' }]);
  });

  it('drops an answer for an unknown request id', () => {
    const relay = new ChannelPermissionRelay();
    expect(relay.resolve('nope', 'allow', 'my-server')).toBe(false);
  });

  it('drops an answer after the request was cancelled', () => {
    const relay = new ChannelPermissionRelay();
    const cancel = relay.onResponse('abc', () => undefined);
    cancel();
    expect(relay.resolve('abc', 'allow', 'my-server')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The refusals                                                                */
/* -------------------------------------------------------------------------- */

describe('the channel refusals', () => {
  it('refuses to register notifications and names the capability', () => {
    try {
      registerChannelNotifications({ serverName: 'my-server' });
      expect.unreachable('the registration should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelTransportUnavailableError);
      const refusal = error as ChannelTransportUnavailableError;
      expect(refusal.capability).toBe('a channel-capable MCP server connection');
      expect(refusal.message).toContain('a channel-capable MCP server connection');
    }
  });

  it('refuses to request a permission and names the capability', () => {
    try {
      requestChannelPermission({ serverName: 'my-server', requestId: 'abc' });
      expect.unreachable('the request should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ChannelTransportUnavailableError);
      const refusal = error as ChannelTransportUnavailableError;
      expect(refusal.capability).toBe('a channel-capable MCP server connection');
      expect(refusal.message).toContain('a channel-capable MCP server connection');
    }
  });
});
