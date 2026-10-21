/**
 * The **MCP channels** surface.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded
 * in `/home/shiva/opt/reference-agent-rea/analysis/findings-mcp-channels.md` —
 * every claim there carries a file and a byte offset. The milestone is
 * `CC-035` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * The target's whole channels surface is **one module**
 * (`chunk-sgtr8b3g.js` in the pinned build), and this module owns **one**
 * responsibility: the shapes that module holds — the capability, the message
 * form, the admission decisions, the session-list grammar, the allowlist and
 * the permission relay's rules.
 *
 * ## The capability
 *
 * A server declares the channel capability in its **`experimental`** map:
 *
 *   - `claude/channel` — the server may push inbound messages;
 *   - `claude/channel/permission` — the server may also answer a permission
 *     request the client sends it.
 *
 * The second is **separate**: a server that declares only the first is not
 * eligible for the permission relay.
 *
 * ## The message form
 *
 * The inbound message is a notification on `notifications/claude/channel`
 * whose params are `{content: string, meta?: Record<string, string>}`. The
 * message is delivered to the model as a **queued prompt** wrapped in a
 * `<channel source="…">` envelope, not as a transcript line.
 *
 * A **meta key** that is not an identifier (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) is
 * **dropped**, and the drop is logged with the count and the names.
 *
 * ## The admission decisions
 *
 * The gate decides whether a server may register its channel handlers. It has
 * **eight** decision kinds, in this order:
 *
 *   1. `capability` — the server did not declare `claude/channel`;
 *   2. `era` — the connection negotiated the **modern** protocol revision,
 *      which has no unsolicited-notification path;
 *   3. `provider` — the active route is not `firstParty`;
 *   4. `disabled` — the feature is off for this session;
 *   5. `policy` — the organisation's managed settings do not enable it;
 *   6. `session` — the server is not in this session's `--channels` list;
 *   7. `marketplace` — the plugin the session names is not the one installed;
 *   8. `allowlist` — the plugin (or the bare server) is not on the approved
 *      list.
 *
 * Four of them — `provider`, `disabled`, `capability` and `era` — are the
 * **hard revocations**: a skip of one of those **removes** the notification
 * handlers. A skip of one of the other four **preserves** handlers that were
 * already registered.
 *
 * ## The honest boundary
 *
 * This implementation has **no channel transport**: there is no server that
 * pushes, no admission pipeline in a live session and no channel registry. So
 * the **shapes** are implemented and the **operations** refuse:
 *
 *   - {@link registerChannelNotifications} and {@link requestChannelPermission}
 *     refuse, and each refusal **names the capability** it needed;
 *   - nothing here pretends that a server pushed a message.
 *
 * ## Implementation choices
 *
 * The target does not pin these, so they are named here:
 *
 *   - The **body neutraliser**. The target neutralises **every** recognised
 *     envelope tag before the body is wrapped, and its rules for the other
 *     tags belong to other surfaces. This implementation neutralises the
 *     **`channel`** tag only — which is the tag this surface can fake — so a
 *     body cannot open a nested `<channel>` envelope.
 *   - The **attribute escaping** reproduces the target's own escaping, which
 *     replaces `"` and `'` and nothing else.
 *   - The **plugin identity** a gate needs is supplied by the caller: this
 *     implementation has no plugin registry, so the gate takes a resolver and
 *     does the target's *decision* with what it is given.
 *   - The **alias map** the target uses to canonicalise a `builtin`
 *     marketplace plugin name is supplied by the caller as well; without one,
 *     the canonical name is the name itself.
 *   - The **policy tier** the target reads is `null` or an object. This
 *     implementation treats an absent tier as `null`, where the target would
 *     raise on `undefined`.
 */

import { readRecord } from './records.js';
import type { McpProtocolEra } from './protocol.js';
import type { ProviderRoute } from '../../provider/routes.js';

/* -------------------------------------------------------------------------- */
/* The capability                                                              */
/* -------------------------------------------------------------------------- */

/** The experimental capability a server declares to push inbound messages. */
export const CHANNEL_CAPABILITY = 'claude/channel';

/** The experimental capability a server declares to answer a permission request. */
export const CHANNEL_PERMISSION_CAPABILITY = 'claude/channel/permission';

/**
 * Whether a server declares an experimental capability.
 *
 * The target's own read is a **truthiness** test on the member, so an empty
 * object is a declaration and a `null` is not.
 */
export function declaresChannelCapability(capabilities: unknown, capability: string): boolean {
  const experimental = readRecord(readRecord(capabilities)?.['experimental']);
  return Boolean(experimental?.[capability]);
}

/* -------------------------------------------------------------------------- */
/* The methods                                                                 */
/* -------------------------------------------------------------------------- */

/** The method an inbound channel message arrives on. */
export const CHANNEL_MESSAGE_METHOD = 'notifications/claude/channel';

/** The method a channel's answer to a permission request arrives on. */
export const CHANNEL_PERMISSION_METHOD = 'notifications/claude/channel/permission';

/** The method a permission request is sent to a channel on. */
export const CHANNEL_PERMISSION_REQUEST_METHOD = 'notifications/claude/channel/permission_request';

/** The tag an inbound channel message is wrapped in. */
export const CHANNEL_MESSAGE_TAG = 'channel';

/* -------------------------------------------------------------------------- */
/* The message form                                                            */
/* -------------------------------------------------------------------------- */

/** The params of an inbound channel message. */
export interface ChannelMessageParams {
  /** The message's body. */
  content: string;
  /** The message's meta — every key becomes an attribute on the envelope. */
  meta?: Record<string, string>;
}

/** The params of a channel's answer to a permission request. */
export interface ChannelPermissionParams {
  /** The id of the request being answered. */
  request_id: string;
  /** The answer itself. */
  behavior: 'allow' | 'deny';
}

/**
 * Read the params of an inbound channel message.
 *
 * The target's schema is `{content: string, meta?: Record<string, string>}`:
 * a `content` that is not a string fails it, and a `meta` member that is not a
 * string fails it too.
 */
export function readChannelMessageParams(value: unknown): ChannelMessageParams | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const content = record['content'];
  if (typeof content !== 'string') return undefined;

  const rawMeta = record['meta'];
  if (rawMeta === undefined) return { content };

  const metaRecord = readRecord(rawMeta);
  if (!metaRecord) return undefined;
  const meta: Record<string, string> = {};
  for (const key of Object.keys(metaRecord)) {
    const member = metaRecord[key];
    if (typeof member !== 'string') return undefined;
    meta[key] = member;
  }
  return { content, meta };
}

/** Read the params of a channel's answer to a permission request. */
export function readChannelPermissionParams(value: unknown): ChannelPermissionParams | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const requestId = record['request_id'];
  const behavior = record['behavior'];
  if (typeof requestId !== 'string') return undefined;
  if (behavior !== 'allow' && behavior !== 'deny') return undefined;
  return { request_id: requestId, behavior };
}

/* -------------------------------------------------------------------------- */
/* The meta keys                                                               */
/* -------------------------------------------------------------------------- */

/** The shape a meta key must have to become an attribute. */
export const CHANNEL_META_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** The meta keys that were kept and the ones that were dropped. */
export interface ChannelMetaSplit {
  /** The keys that match the identifier rule, in their own order. */
  kept: [string, string][];
  /** The keys that do not, in their own order. */
  dropped: [string, string][];
}

/**
 * Split the meta keys on the identifier rule.
 *
 * The target's own rule drops a key that is not an identifier and **keeps**
 * the rest — the dropped key is named in a warning, not an error.
 */
export function splitChannelMeta(
  meta: Record<string, string> | undefined,
): ChannelMetaSplit {
  const kept: [string, string][] = [];
  const dropped: [string, string][] = [];
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (CHANNEL_META_KEY_PATTERN.test(key)) kept.push([key, value]);
    else dropped.push([key, value]);
  }
  return { kept, dropped };
}

/**
 * The warning the target logs when it drops meta keys.
 *
 * The target names the **count** and the **keys**, and it prints the rule's
 * own source.
 */
export function channelMetaDropWarning(
  serverName: string,
  dropped: readonly [string, string][],
): string {
  const names = dropped.map(([key]) => key).join(', ');
  return (
    `[channel] ${serverName}: dropped ${dropped.length} meta key(s) that don't match ` +
    `${CHANNEL_META_KEY_PATTERN.source}: ${names}`
  );
}

/* -------------------------------------------------------------------------- */
/* The envelope                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Escape a value for an attribute.
 *
 * The target's own escaping replaces the two quote characters and nothing
 * else — an `&`, a `<` and a `>` are left alone.
 */
function escapeAttributeValue(value: string): string {
  return value.replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/**
 * Escape a channel opener in a body.
 *
 * The target neutralises the recognised envelope tags before the body is
 * wrapped, and then escapes any surviving `<channel` a second time. The
 * effect this implementation reproduces is the one that matters here: a body
 * cannot open a nested `<channel>` envelope.
 */
function escapeChannelOpeners(body: string): string {
  return body.replace(/<(?![\\])(channel)(?![A-Za-z0-9_-])/giu, '<\\$1');
}

/**
 * Wrap an inbound channel message in its envelope.
 *
 * The envelope is the target's own:
 *
 * ```
 * <channel source="<server>" meta1="value1">
 * <body>
 * </channel>
 * ```
 *
 * The `source` comes first, then the **kept** meta keys in their own order.
 */
export function formatChannelMessage(
  serverName: string,
  content: string,
  meta?: Record<string, string>,
): string {
  const { kept } = splitChannelMeta(meta);
  const attributes = kept.map(([key, value]) => ` ${key}="${escapeAttributeValue(value)}"`).join('');
  const body = escapeChannelOpeners(content);
  return `<${CHANNEL_MESSAGE_TAG} source="${escapeAttributeValue(serverName)}"${attributes}>\n${body}\n</${CHANNEL_MESSAGE_TAG}>`;
}

/* -------------------------------------------------------------------------- */
/* The session list                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One entry of the session's channel list.
 *
 * A **server** entry names a manually configured MCP server; a **plugin**
 * entry names a plugin-provided channel, and carries the marketplace the
 * plugin came from. A `dev` entry is one the user named with
 * `--dangerously-load-development-channels`.
 */
export type ChannelEntry =
  | { kind: 'server'; name: string; dev?: boolean }
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean };

/**
 * The `--channels` value was not tagged.
 *
 * The target treats this as **fatal** and names the flag.
 */
export class ChannelEntryFormatError extends Error {
  /** The flag the value came from. */
  readonly flag: string;

  constructor(flag: string, values: readonly string[]) {
    super(
      `${flag} entries must be tagged: ${values.join(', ')}\n` +
        '  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\n' +
        '  server:<name>                — manually configured MCP server',
    );
    this.name = 'ChannelEntryFormatError';
    this.flag = flag;
  }
}

/**
 * Read the `--channels` values into the session's channel list.
 *
 * A value **must** be tagged:
 *
 *   - `plugin:<name>@<marketplace>` — a plugin-provided channel, allowlist
 *     enforced;
 *   - `server:<name>` — a manually configured MCP server.
 *
 * An untagged value — or a `plugin:` value with no marketplace — is fatal, and
 * the message names the flag the value came from.
 */
export function parseChannelEntries(values: readonly string[], flag: string): ChannelEntry[] {
  const entries: ChannelEntry[] = [];
  const untagged: string[] = [];

  for (const value of values) {
    if (value.startsWith('plugin:')) {
      const rest = value.slice('plugin:'.length);
      const separator = rest.indexOf('@');
      if (separator <= 0 || separator === rest.length - 1) {
        untagged.push(value);
        continue;
      }
      entries.push({
        kind: 'plugin',
        name: rest.slice(0, separator),
        marketplace: rest.slice(separator + 1),
      });
      continue;
    }
    if (value.startsWith('server:') && value.length > 'server:'.length) {
      entries.push({ kind: 'server', name: value.slice('server:'.length) });
      continue;
    }
    untagged.push(value);
  }

  if (untagged.length > 0) throw new ChannelEntryFormatError(flag, untagged);
  return entries;
}

/**
 * Find the session entry that names a server.
 *
 * A **server** entry matches on the exact server name. A **plugin** entry
 * matches when the server's name is the one the target gives a
 * plugin-provided server — `plugin:<pluginName>:<serverKey>` — and the
 * plugin name matches the entry's, either exactly or through the entry's
 * canonical name.
 *
 * The **server key** is not part of the match: one plugin entry covers every
 * server the plugin provides.
 */
export function findChannelEntry(
  serverName: string,
  entries: readonly ChannelEntry[],
  aliasMap?: ReadonlyMap<string, string>,
): ChannelEntry | undefined {
  const parts = serverName.split(':');
  return entries.find((entry) => {
    if (entry.kind === 'server') return serverName === entry.name;
    if (parts[0] !== 'plugin') return false;
    return parts[1] === entry.name || parts[1] === canonicalChannelPluginName(entry, aliasMap);
  });
}

/**
 * The canonical name of the plugin an entry names.
 *
 * The target canonicalises a name only for the `builtin` marketplace, where
 * the name may be an alias.
 */
function canonicalChannelPluginName(
  entry: ChannelEntry,
  aliasMap?: ReadonlyMap<string, string>,
): string {
  if (entry.kind !== 'plugin') return entry.name;
  if (entry.marketplace !== BUILTIN_MARKETPLACE) return entry.name;
  return aliasMap?.get(entry.name) ?? entry.name;
}

/* -------------------------------------------------------------------------- */
/* The allowlist                                                               */
/* -------------------------------------------------------------------------- */

/** One entry of the approved channel plugins list. */
export interface ChannelAllowlistEntry {
  /** The plugin's name. */
  plugin: string;
  /** The marketplace the plugin came from. */
  marketplace: string;
}

/** Where the effective allowlist came from. */
export type ChannelAllowlistSource = 'org' | 'ledger';

/** The effective allowlist and its source. */
export interface EffectiveChannelAllowlist {
  /** The entries themselves. */
  entries: readonly ChannelAllowlistEntry[];
  /** Where they came from. */
  source: ChannelAllowlistSource;
}

/**
 * The effective allowlist.
 *
 * When the organisation's managed settings carry the list it wins — **even
 * when it is empty**, which allows nothing. Otherwise the default ledger list
 * is used.
 */
export function getEffectiveChannelAllowlist(
  orgEntries: readonly ChannelAllowlistEntry[] | undefined,
  ledgerEntries: readonly ChannelAllowlistEntry[],
): EffectiveChannelAllowlist {
  if (orgEntries) return { entries: orgEntries, source: 'org' };
  return { entries: ledgerEntries, source: 'ledger' };
}

/* -------------------------------------------------------------------------- */
/* The policy block                                                            */
/* -------------------------------------------------------------------------- */

/** The subscription types the target knows. */
export type ChannelSubscriptionType = 'max' | 'pro' | 'team' | 'enterprise';

/** What the policy block needs to know about the session. */
export interface ChannelPolicyContext {
  /** Whether the session is a first-party (claude.ai) one. */
  isFirstPartySession?: boolean;
  /** The session's subscription type. */
  subscriptionType?: ChannelSubscriptionType | null;
}

/**
 * Whether the organisation's policy blocks the channels surface.
 *
 * The target's own rule:
 *
 *   - on a **first-party** session whose plan is `team` or `enterprise`, the
 *     managed settings must carry `channelsEnabled: true`;
 *   - on any **other** session, the managed settings must carry
 *     `channelsEnabled: true` whatever the plan is;
 *   - when the managed settings are absent, the surface is **not** blocked.
 */
export function isChannelsPolicyBlocked(
  policySettings: Record<string, unknown> | null | undefined,
  context: ChannelPolicyContext = {},
): boolean {
  const settings = policySettings ?? null;
  const enabled = settings?.['channelsEnabled'];
  if (context.isFirstPartySession === true) {
    const plan = context.subscriptionType ?? null;
    if (plan !== 'team' && plan !== 'enterprise') return false;
    return enabled !== true;
  }
  if (settings === null) return false;
  return enabled !== true;
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

/** The eight admission-decision kinds, in the target's order. */
export const CHANNEL_GATE_KINDS = [
  'capability',
  'era',
  'provider',
  'disabled',
  'policy',
  'session',
  'marketplace',
  'allowlist',
] as const;

/** One of the eight admission-decision kinds. */
export type ChannelGateKind = (typeof CHANNEL_GATE_KINDS)[number];

/**
 * The four **hard revocations**.
 *
 * A skip of one of these removes the notification handlers; a skip of one of
 * the other four preserves handlers that were already registered.
 */
export const CHANNEL_HARD_REVOCATION_KINDS = [
  'provider',
  'disabled',
  'capability',
  'era',
] as const;

/** Whether a skip of this kind is a hard revocation. */
export function isChannelGateHardRevocation(kind: ChannelGateKind): boolean {
  return (CHANNEL_HARD_REVOCATION_KINDS as readonly ChannelGateKind[]).includes(kind);
}

/** The gate's decision. */
export type ChannelGateDecision =
  | { action: 'register' }
  | { action: 'skip'; kind: ChannelGateKind; reason: string };

/** A plugin's identity: the name it is known by, and where it came from. */
export interface ChannelPluginIdentity {
  /** The plugin's name. */
  name: string;
  /** The marketplace it came from, when it came from one. */
  marketplace?: string;
}

/**
 * Resolves an installed plugin.
 *
 * The id is the plugin's own id — the plugin source, or `name@marketplace`.
 */
export type ChannelPluginResolver = (id: string) => ChannelPluginIdentity | undefined;

/** What the gate needs to know. */
export interface ChannelGateInput {
  /** The server's name. */
  serverName: string;
  /** The capabilities the server reported. */
  capabilities?: unknown;
  /** The plugin source the server came from, when it is plugin-sourced. */
  pluginSource?: string | undefined;
  /** The era the connection negotiated. */
  protocolEra: McpProtocolEra;
  /** The active provider route. */
  route: ProviderRoute;
  /** Whether the feature is off for this session. */
  channelsOffForSession: boolean;
  /** The managed settings, as the target reads them. */
  policySettings?: Record<string, unknown> | null;
  /** The session's channel entries. */
  sessionChannels: readonly ChannelEntry[];
  /** The organisation's allowlist, from the managed settings. */
  allowedChannelPlugins?: readonly ChannelAllowlistEntry[] | undefined;
  /** The default ledger allowlist. */
  ledgerAllowlist?: readonly ChannelAllowlistEntry[];
  /** The resolver for an installed plugin. */
  resolvePlugin?: ChannelPluginResolver;
  /**
   * The alias map the target uses to canonicalise a `builtin` marketplace
   * plugin name. Without one, the canonical name is the name itself.
   */
  aliasMap?: ReadonlyMap<string, string>;
  /** Whether the session is a first-party one. */
  isFirstPartySession?: boolean;
  /** The session's subscription type. */
  subscriptionType?: ChannelSubscriptionType | null;
}

/** The marketplace the target's own builtin plugins live in. */
const BUILTIN_MARKETPLACE = 'builtin';

/**
 * Split a plugin id into its name and its marketplace.
 *
 * The target splits at the **last** `@`; an id with no `@` has no
 * marketplace.
 */
export function parseChannelPluginId(id: string): ChannelPluginIdentity {
  const index = id.lastIndexOf('@');
  if (index < 0) return { name: id };
  return { name: id.slice(0, index), marketplace: id.slice(index + 1) };
}

/**
 * Whether the installed plugin is the one the session entry names.
 *
 * The target's rule: the installed plugin must come from the **same
 * marketplace** the entry names, and its **name** must match — exactly for a
 * `dev` entry, and case-insensitively otherwise.
 */
function isPluginNamedByChannelEntry(
  pluginSource: string | undefined,
  entry: ChannelEntry,
  resolvePlugin: ChannelPluginResolver,
  aliasMap: ReadonlyMap<string, string> | undefined,
): boolean {
  if (entry.kind !== 'plugin') return false;
  const installed = pluginSource ? resolvePlugin(pluginSource) : undefined;
  if (installed === undefined) return false;

  // The canonical name of the plugin the entry names.
  const canonical = canonicalChannelPluginName(entry, aliasMap);

  if (installed.marketplace === undefined) return false;
  if (installed.marketplace !== entry.marketplace) return false;
  if (entry.dev === true) return installed.name === canonical;
  return (
    installed.name === canonical || installed.name.toLowerCase() === canonical.toLowerCase()
  );
}

/**
 * Whether the allowlist holds the installed plugin.
 *
 * The target's rule: an entry matches when it names the same **marketplace**
 * and either the same **plugin name**, or — for a `builtin` marketplace — the
 * plugin's **alias**.
 */
function isOnChannelAllowlist(
  allowlist: readonly ChannelAllowlistEntry[],
  installed: ChannelPluginIdentity,
  aliasMap: ReadonlyMap<string, string> | undefined,
): boolean {
  return allowlist.some(
    (entry) =>
      entry.marketplace === installed.marketplace &&
      (entry.plugin === installed.name ||
        (entry.marketplace === BUILTIN_MARKETPLACE &&
          (aliasMap?.get(entry.plugin) ?? entry.plugin) === installed.name)),
  );
}

/**
 * Decide whether a server may register its channel handlers.
 *
 * The checks run in the target's own order, and the order is load-bearing:
 * the first check that fails is the one that is reported.
 */
export function gateChannelServer(input: ChannelGateInput): ChannelGateDecision {
  // 1. The capability.
  if (!declaresChannelCapability(input.capabilities, CHANNEL_CAPABILITY)) {
    return {
      action: 'skip',
      kind: 'capability',
      reason: 'server did not declare claude/channel capability',
    };
  }

  // 2. The era: the modern revision has no unsolicited-notification path.
  if (input.protocolEra === 'modern') {
    return {
      action: 'skip',
      kind: 'era',
      reason:
        'connection negotiated a modern protocol revision with no unsolicited notification path',
    };
  }

  // 3. The provider.
  if (input.route !== 'firstParty') {
    return {
      action: 'skip',
      kind: 'provider',
      reason: 'channels are not available on third-party providers',
    };
  }

  // 4. The feature switch.
  if (input.channelsOffForSession) {
    return {
      action: 'skip',
      kind: 'disabled',
      reason: 'channels feature is not currently available',
    };
  }

  // 5. The organisation's policy.
  if (
    isChannelsPolicyBlocked(input.policySettings, {
      isFirstPartySession: input.isFirstPartySession,
      subscriptionType: input.subscriptionType,
    })
  ) {
    return {
      action: 'skip',
      kind: 'policy',
      reason: 'channels not enabled by org policy (set channelsEnabled: true in managed settings)',
    };
  }

  // 6. The session list.
  const entry = findChannelEntry(input.serverName, input.sessionChannels, input.aliasMap);
  if (entry === undefined) {
    return {
      action: 'skip',
      kind: 'session',
      reason: `server ${input.serverName} not in --channels list for this session`,
    };
  }

  // 7. The marketplace, for a plugin entry.
  if (entry.kind === 'plugin') {
    const resolvePlugin = input.resolvePlugin ?? (() => undefined);
    const installed = input.pluginSource ? resolvePlugin(input.pluginSource) : undefined;
    const installedMarketplace = installed?.marketplace;
    if (
      installedMarketplace === undefined ||
      !isPluginNamedByChannelEntry(
        input.pluginSource,
        entry,
        resolvePlugin,
        input.aliasMap,
      )
    ) {
      const asked = `plugin:${entry.name}@${entry.marketplace}`;
      const from = installedMarketplace
        ? `${installed?.name}@${installedMarketplace}`
        : 'from an unknown source';
      return {
        action: 'skip',
        kind: 'marketplace',
        reason: `you asked for ${asked} but the installed plugin is ${from}`,
      };
    }

    // 8. The allowlist — a `dev` entry is exempt.
    if (entry.dev !== true) {
      const allowlist = getEffectiveChannelAllowlist(
        input.allowedChannelPlugins,
        input.ledgerAllowlist ?? [],
      );
      const identity: ChannelPluginIdentity = {
        name: installed?.name ?? entry.name,
        marketplace: installedMarketplace,
      };
      if (!isOnChannelAllowlist(allowlist.entries, identity, input.aliasMap)) {
        const label = `${identity.name}@${identity.marketplace}`;
        const reason =
          allowlist.source === 'org'
            ? `plugin ${label} is not on your org's approved channels list (set allowedChannelPlugins in managed settings)`
            : `plugin ${label} is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)`;
        return { action: 'skip', kind: 'allowlist', reason };
      }
    }
    return { action: 'register' };
  }

  // A bare server entry needs the development flag to be exempt.
  if (entry.dev !== true) {
    return {
      action: 'skip',
      kind: 'allowlist',
      reason: `server ${entry.name} is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)`,
    };
  }

  return { action: 'register' };
}

/* -------------------------------------------------------------------------- */
/* The permission relay                                                        */
/* -------------------------------------------------------------------------- */

/** The alphabet the request id is drawn from — twenty-five letters, no `l`. */
const REQUEST_ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz';

/**
 * The substrings a generated request id must not contain.
 *
 * This is the target's own list, and it is reproduced because the generated
 * id is **observable**: the target derives it deterministically from the tool
 * use id and the agent id, so the same pair always yields the same id.
 */
const REQUEST_ID_BLOCKED_SUBSTRINGS: readonly string[] = [
  'fuck',
  'shit',
  'cunt',
  'cock',
  'dick',
  'twat',
  'piss',
  'crap',
  'bitch',
  'whore',
  'ass',
  'tit',
  'cum',
  'fag',
  'dyke',
  'nig',
  'kike',
  'rape',
  'nazi',
  'damn',
  'poo',
  'pee',
  'wank',
  'anus',
];

/**
 * The target's FNV-1a hash, rendered into five characters.
 */
function deriveRequestIdCharacters(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash >>>= 0;
  let rendered = '';
  for (let index = 0; index < 5; index += 1) {
    rendered += REQUEST_ID_ALPHABET[hash % REQUEST_ID_ALPHABET.length];
    hash = Math.floor(hash / REQUEST_ID_ALPHABET.length);
  }
  return rendered;
}

/**
 * Derive the request id of a channel permission request.
 *
 * The target's own derivation: the seed is `${toolUseId}:${agentId}`, the hash
 * is FNV-1a rendered into five characters of the twenty-five-letter alphabet,
 * and a result that contains one of the blocked substrings is retried with the
 * suffix `:0` … `:9`.
 */
export function deriveChannelRequestId(toolUseId: string, agentId: string): string {
  const seed = `${toolUseId}:${agentId}`;
  let derived = deriveRequestIdCharacters(seed);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!REQUEST_ID_BLOCKED_SUBSTRINGS.some((blocked) => derived.includes(blocked))) {
      return derived;
    }
    derived = deriveRequestIdCharacters(`${seed}:${attempt}`);
  }
  return derived;
}

/** A channel's answer to a permission request. */
export interface ChannelPermissionAnswer {
  /** The answer itself. */
  behavior: 'allow' | 'deny';
  /** The server the answer came from. */
  fromServer: string;
}

/** The handler a pending request registers. */
export type ChannelPermissionHandler = (answer: ChannelPermissionAnswer) => void;

/**
 * The registry of the pending channel permission requests.
 *
 * The target's own rules:
 *
 *   - the id is matched **case-insensitively**, both when it is registered and
 *     when it is resolved;
 *   - an answer for an **unknown** id is dropped;
 *   - in a session that draws its ids at random, an id that was drawn **twice**
 *     is dropped with a warning, and the answer is ignored.
 */
export class ChannelPermissionRelay {
  readonly #pending = new Map<string, ChannelPermissionHandler>();
  readonly #drawn = new Set<string>();
  readonly #quietElephant: boolean;
  readonly #onWarning: ((message: string) => void) | undefined;

  constructor(options: { quietElephant?: boolean; onWarning?: (message: string) => void } = {}) {
    this.#quietElephant = options.quietElephant === true;
    this.#onWarning = options.onWarning;
  }

  /**
   * Register a pending request.
   *
   * The returned function cancels it.
   */
  onResponse(requestId: string, handler: ChannelPermissionHandler): () => void {
    const key = requestId.toLowerCase();
    if (this.#quietElephant) {
      if (this.#drawn.has(key)) {
        this.#pending.delete(key);
        this.#onWarning?.(
          'Channel permission relay: a request ID was drawn twice in one session; channel replies with that ID are ignored — answer in the terminal',
        );
        return () => undefined;
      }
      this.#drawn.add(key);
    }
    this.#pending.set(key, handler);
    return () => {
      this.#pending.delete(key);
    };
  }

  /**
   * Settle an answer.
   *
   * An answer for an id that is not pending is dropped, and the call says so.
   */
  resolve(requestId: string, behavior: 'allow' | 'deny', fromServer: string): boolean {
    const key = requestId.toLowerCase();
    const handler = this.#pending.get(key);
    if (handler === undefined) return false;
    this.#pending.delete(key);
    handler({ behavior, fromServer });
    return true;
  }

  /** The number of pending requests. */
  get pendingCount(): number {
    return this.#pending.size;
  }
}

/* -------------------------------------------------------------------------- */
/* The refusals                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The operation needed a channel transport this session does not have.
 */
export class ChannelTransportUnavailableError extends Error {
  /** The capability the operation needed. */
  readonly capability: string;
  /** The target's own telemetry code for the failure. */
  readonly telemetryCode: string;

  constructor(message: string, capability: string, telemetryCode: string) {
    super(message);
    this.name = 'ChannelTransportUnavailableError';
    this.capability = capability;
    this.telemetryCode = telemetryCode;
  }
}

/** The capability every channel operation needs. */
const CHANNEL_TRANSPORT_CAPABILITY = 'a channel-capable MCP server connection';

/**
 * Register a server's channel notification handlers.
 *
 * **There is no channel transport here.** The target registers the handlers on
 * a live MCP connection and the server pushes `notifications/claude/channel`
 * notifications into it; this implementation has neither a live connection nor
 * a notification path, so the call refuses and names the capability it needed.
 */
export function registerChannelNotifications(input: { serverName: string }): never {
  void input;
  throw new ChannelTransportUnavailableError(
    'Registering MCP channel notifications needs a channel-capable MCP server connection, which this session does not have, so the channel was not registered.',
    CHANNEL_TRANSPORT_CAPABILITY,
    'channel_registration_unavailable',
  );
}

/**
 * Ask a channel to answer a permission request.
 *
 * **There is no channel transport here.** The target sends the request on a
 * live MCP connection; this implementation has no such connection, so the call
 * refuses and names the capability it needed.
 */
export function requestChannelPermission(input: {
  serverName: string;
  requestId: string;
}): never {
  void input;
  throw new ChannelTransportUnavailableError(
    'Requesting a permission over an MCP channel needs a channel-capable MCP server connection, which this session does not have, so the request was not sent.',
    CHANNEL_TRANSPORT_CAPABILITY,
    'channel_permission_request_unavailable',
  );
}
