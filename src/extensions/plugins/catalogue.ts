/**
 * The **marketplace catalogue** — the shape of a `marketplace.json`, and the shape
 * of the entries it lists.
 *
 * Evidence: `chunk-c9s0jh80.js:128721` (the marketplace manifest `wze`),
 * `:124812` (the catalogue entry `P8n`), `:120783` (the settings-declared entry
 * `fy`), `:126147` (the entry parser `yy`), `:129000` (`metadata.pluginRoot`),
 * `:83337` (the plugin-name rule), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-marketplace.md` §5.
 *
 * ## The marketplace manifest — ten keys
 *
 * | Key | Type | Required? |
 * |---|---|---|
 * | `$schema` | string | no |
 * | `name` | string, validated | **yes** |
 * | `version` | string | no |
 * | `description` | string | no |
 * | `owner` | object `{name, email?, url?}` | **yes** |
 * | `plugins` | entry[] | **yes** |
 * | `forceRemoveDeletedPlugins` | boolean | no |
 * | `metadata` | object `{pluginRoot?, version?, description?}` | no |
 * | `allowCrossMarketplaceDependenciesOn` | string[] | no |
 * | `renames` | `Record<string, string \| null>` | no |
 *
 * The `renames` map is **append-only**: it maps an old plugin name to the
 * current one, or to `null` when the plugin was removed. The target parses it
 * with a **catch**, so a malformed map is **dropped** rather than refused — the
 * manifest still loads.
 *
 * ## The catalogue entry
 *
 * The entry is the **whole plugin manifest, every key optional**, plus the
 * entry's own keys:
 *
 * | Key | Type | Default |
 * |---|---|---|
 * | `name` | string | — (required) |
 * | `source` | the plugin source | — (required) |
 * | `headers` | `Record<string, string>` | — |
 * | `headersHelper` | string | — |
 * | `category` | string | — |
 * | `tags` | string[] | — |
 * | `strict` | boolean | **true** |
 * | `relevance` | `{topic?, signals?}` | — |
 *
 * ## The entry that does not parse
 *
 * The target **stubs** an entry it cannot parse, and **keeps** it: the entry
 * becomes `{name, source: {source: "unsupported", error?}, strict: true}`. The
 * stub exists so that the delisting check does not read the entry as removed.
 * An entry with **no name** is **dropped** instead — there is nothing to stub.
 *
 * ## The honest boundary
 *
 * This implementation **reads** a catalogue; it does **not** serve one, and it
 * installs nothing from one. The catalogue's *shape* is reproduced exactly;
 * the marketplace behind it is not.
 */

import { isPlainObject } from '../skills/frontmatter.js';

import { PLUGIN_MANIFEST_KEYS } from './manifestSchema.js';
import {
  isUnknownPluginSourceType,
  parsePluginSource,
  type PluginSource,
} from './pluginSources.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The keys a marketplace manifest may declare, in the target's own order.
 */
export const MARKETPLACE_MANIFEST_KEYS = [
  '$schema',
  'name',
  'version',
  'description',
  'owner',
  'plugins',
  'forceRemoveDeletedPlugins',
  'metadata',
  'allowCrossMarketplaceDependenciesOn',
  'renames',
] as const;

/** One of the marketplace manifest's keys. */
export type MarketplaceManifestKey = (typeof MARKETPLACE_MANIFEST_KEYS)[number];

/**
 * The keys a catalogue entry adds to the plugin manifest's own keys.
 */
export const MARKETPLACE_CATALOGUE_ENTRY_KEYS = [
  'name',
  'source',
  'headers',
  'headersHelper',
  'category',
  'tags',
  'strict',
  'relevance',
] as const;

/** One of the catalogue entry's own keys. */
export type MarketplaceCatalogueEntryKey = (typeof MARKETPLACE_CATALOGUE_ENTRY_KEYS)[number];

/** The maintainer of a marketplace. */
export interface MarketplaceOwner {
  /** The display name. */
  readonly name: string;
  /** The contact address. */
  readonly email?: string;
  /** The contact URL. */
  readonly url?: string;
}

/** The optional metadata a marketplace manifest carries. */
export interface MarketplaceMetadata {
  /** The base directory the bare source names resolve under. */
  readonly pluginRoot?: string;
  /** The marketplace's version. */
  readonly version?: string;
  /** The marketplace's description. */
  readonly description?: string;
}

/** One entry of a marketplace's catalogue. */
export interface MarketplaceCatalogueEntry {
  /** The plugin's name. */
  readonly name: string;
  /** Where the plugin comes from. */
  readonly source: PluginSource;
  /** The plugin's version. */
  readonly version?: string;
  /** The plugin's description. */
  readonly description?: string;
  /** Whether the manifest must be present in the plugin's folder. */
  readonly strict: boolean;
  /** The headers the download carries. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The command that prints the headers. */
  readonly headersHelper?: string;
  /** The category the entry is filed under. */
  readonly category?: string;
  /** The tags the entry is found by. */
  readonly tags?: readonly string[];
  /** The keys the entry declares that the plugin manifest does not. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** A parsed marketplace manifest. */
export interface MarketplaceManifest {
  /** The marketplace's name. */
  readonly name: string;
  /** The marketplace's version. */
  readonly version?: string;
  /** The marketplace's description. */
  readonly description?: string;
  /** The maintainer. */
  readonly owner: MarketplaceOwner;
  /** The catalogue. */
  readonly plugins: readonly MarketplaceCatalogueEntry[];
  /** Whether a plugin removed from the catalogue is uninstalled. */
  readonly forceRemoveDeletedPlugins?: boolean;
  /** The optional metadata. */
  readonly metadata?: MarketplaceMetadata;
  /** The marketplaces whose plugins may be installed as dependencies. */
  readonly allowCrossMarketplaceDependenciesOn?: readonly string[];
  /** The append-only rename map. */
  readonly renames?: Readonly<Record<string, string | null>>;
  /** The problems the manifest carries. */
  readonly problems: readonly string[];
}

/** The result of parsing a marketplace manifest. */
export interface MarketplaceManifestParse {
  /** Whether the manifest is usable. */
  readonly ok: boolean;
  /** The parsed manifest, when it is usable. */
  readonly manifest?: MarketplaceManifest;
  /** The reason the manifest was refused, when it was. */
  readonly reason?: string;
  /** The problems the manifest carries. */
  readonly problems: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read a value out of an object.
 *
 * The lookup is an **own-property** check: a catalogue is caller-supplied data,
 * so a key that names an inherited member of `Object.prototype` yields
 * `undefined` rather than the inherited member.
 */
function ownValue(document: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(document, key) ? document[key] : undefined;
}

/** Whether a value is a string. */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Whether a value is an array of strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** The control and bidirectional-formatting characters the target refuses. */
const CONTROL_OR_BIDI = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * Whether a plugin name is one the target accepts.
 *
 * The target's own rule: at least one character, no space, and no control or
 * bidirectional-formatting character.
 */
export function isAcceptablePluginName(name: unknown): name is string {
  if (!isString(name)) return false;
  if (name.length === 0) return false;
  if (name.includes(' ')) return false;
  return !CONTROL_OR_BIDI.test(name);
}

/* -------------------------------------------------------------------------- */
/* The entries                                                                  */
/* -------------------------------------------------------------------------- */

/** The result of parsing one catalogue entry. */
export interface MarketplaceCatalogueEntryParse {
  /** Whether the entry is one the target accepts. */
  readonly ok: boolean;
  /** The parsed entry, when it is one. */
  readonly entry?: MarketplaceCatalogueEntry;
  /** The reason the entry was refused, when it was. */
  readonly reason?: string;
}

/**
 * Parse one catalogue entry.
 *
 * The entry is the plugin manifest with every key optional, plus the entry's
 * own keys. `strict` defaults to **true** — the target's own default.
 */
export function parseMarketplaceCatalogueEntry(raw: unknown): MarketplaceCatalogueEntryParse {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'the entry is not an object' };
  }

  const name = ownValue(raw, 'name');
  if (!isAcceptablePluginName(name)) {
    return { ok: false, reason: 'the entry has no acceptable name' };
  }

  if (!Object.hasOwn(raw, 'source')) {
    return { ok: false, reason: 'the entry has no source' };
  }
  const source = parsePluginSource(ownValue(raw, 'source'));
  if (!source.ok || source.source === undefined) {
    return { ok: false, reason: source.reason ?? 'the entry has no source' };
  }

  const strict = ownValue(raw, 'strict');
  if (strict !== undefined && typeof strict !== 'boolean') {
    return { ok: false, reason: 'the "strict" is not a boolean' };
  }

  const version = ownValue(raw, 'version');
  const description = ownValue(raw, 'description');
  const category = ownValue(raw, 'category');
  const headers = ownValue(raw, 'headers');
  const headersHelper = ownValue(raw, 'headersHelper');
  const tags = ownValue(raw, 'tags');

  if (version !== undefined && !isString(version)) {
    return { ok: false, reason: 'the "version" is not a string' };
  }
  if (description !== undefined && !isString(description)) {
    return { ok: false, reason: 'the "description" is not a string' };
  }
  if (category !== undefined && !isString(category)) {
    return { ok: false, reason: 'the "category" is not a string' };
  }
  if (headersHelper !== undefined && !isString(headersHelper)) {
    return { ok: false, reason: 'the "headersHelper" is not a string' };
  }
  if (tags !== undefined && !isStringArray(tags)) {
    return { ok: false, reason: 'the "tags" is not an array of strings' };
  }
  if (
    headers !== undefined &&
    (!isPlainObject(headers) || !Object.values(headers).every((entry) => isString(entry)))
  ) {
    return { ok: false, reason: 'the "headers" is not a map of strings' };
  }

  // The keys the entry declares that are neither the entry's own nor the
  // manifest's — the target keeps them, and this implementation keeps them too.
  const extra: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (MARKETPLACE_CATALOGUE_ENTRY_KEYS.includes(key as MarketplaceCatalogueEntryKey)) continue;
    if (PLUGIN_MANIFEST_KEYS.includes(key)) continue;
    extra[key] = raw[key];
  }

  return {
    ok: true,
    entry: {
      name,
      source: source.source,
      strict: strict === undefined ? true : strict,
      ...(typeof version === 'string' ? { version } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(typeof category === 'string' ? { category } : {}),
      ...(isPlainObject(headers)
        ? { headers: headers as Readonly<Record<string, string>> }
        : {}),
      ...(typeof headersHelper === 'string' ? { headersHelper } : {}),
      ...(isStringArray(tags) ? { tags } : {}),
      extra,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The manifest                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parse a marketplace manifest.
 *
 * The manifest is **not** an object → it is refused. It has **no name** → it is
 * refused. It has **no owner** → it is refused. Its `plugins` is **not** an
 * array → it is refused.
 *
 * An **entry** that does not parse is **stubbed** when it has a name, and
 * **dropped** when it has none — the target's own rule.
 */
export function parseMarketplaceManifest(raw: unknown): MarketplaceManifestParse {
  const problems: string[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'it is not a JSON object', problems };
  }

  const name = ownValue(raw, 'name');
  if (!isAcceptablePluginName(name)) {
    return { ok: false, reason: 'the marketplace manifest has no acceptable name', problems };
  }

  const owner = ownValue(raw, 'owner');
  if (!isPlainObject(owner) || !isString(ownValue(owner, 'name'))) {
    return { ok: false, reason: 'the marketplace manifest has no owner', problems };
  }
  const ownerEmail = ownValue(owner, 'email');
  const ownerUrl = ownValue(owner, 'url');

  const rawPlugins = ownValue(raw, 'plugins');
  if (!Array.isArray(rawPlugins)) {
    return { ok: false, reason: 'the marketplace manifest has no plugins', problems };
  }

  const plugins: MarketplaceCatalogueEntry[] = [];
  for (const [index, rawEntry] of rawPlugins.entries()) {
    const parsed = parseMarketplaceCatalogueEntry(rawEntry);
    if (parsed.ok && parsed.entry !== undefined) {
      plugins.push(parsed.entry);
      continue;
    }
    const entryName = isPlainObject(rawEntry) ? ownValue(rawEntry, 'name') : undefined;
    if (isAcceptablePluginName(entryName)) {
      // The target's **stub**: the entry stays in the catalogue so that the
      // delisting check does not read it as removed. A source whose *type* the
      // target does not know carries **no reason**; a known type whose fields
      // are wrong carries the reason.
      const unknownType = isPlainObject(rawEntry) ? isUnknownPluginSourceType(ownValue(rawEntry, 'source')) : false;
      plugins.push({
        name: entryName,
        source: {
          source: 'unsupported',
          ...(unknownType || parsed.reason === undefined ? {} : { error: parsed.reason }),
        },
        strict: true,
        extra: Object.create(null) as Record<string, unknown>,
      });
      problems.push(`the entry "${entryName}" was stubbed: ${parsed.reason ?? 'it does not parse'}`);
      continue;
    }
    problems.push(`the entry at index ${index} was dropped: ${parsed.reason ?? 'it does not parse'}`);
  }

  const version = ownValue(raw, 'version');
  const description = ownValue(raw, 'description');
  const forceRemove = ownValue(raw, 'forceRemoveDeletedPlugins');
  const metadata = ownValue(raw, 'metadata');
  const crossMarketplace = ownValue(raw, 'allowCrossMarketplaceDependenciesOn');
  const renames = ownValue(raw, 'renames');

  if (version !== undefined && !isString(version)) {
    problems.push('the "version" is not a string');
  }
  if (description !== undefined && !isString(description)) {
    problems.push('the "description" is not a string');
  }
  if (forceRemove !== undefined && typeof forceRemove !== 'boolean') {
    problems.push('the "forceRemoveDeletedPlugins" is not a boolean');
  }
  if (
    crossMarketplace !== undefined &&
    !isStringArray(crossMarketplace)
  ) {
    problems.push('the "allowCrossMarketplaceDependenciesOn" is not an array of strings');
  }

  let metadataValue: MarketplaceMetadata | undefined;
  if (metadata !== undefined) {
    if (!isPlainObject(metadata)) {
      problems.push('the "metadata" is not an object');
    } else {
      const pluginRoot = ownValue(metadata, 'pluginRoot');
      const metadataVersion = ownValue(metadata, 'version');
      const metadataDescription = ownValue(metadata, 'description');
      metadataValue = {
        ...(isString(pluginRoot) ? { pluginRoot } : {}),
        ...(isString(metadataVersion) ? { version: metadataVersion } : {}),
        ...(isString(metadataDescription) ? { description: metadataDescription } : {}),
      };
    }
  }

  let renamesValue: Record<string, string | null> | undefined;
  if (renames !== undefined) {
    // The target parses this map with a **catch**: a malformed map is dropped,
    // and the manifest still loads.
    if (isPlainObject(renames)) {
      const parsed: Record<string, string | null> = Object.create(null) as Record<
        string,
        string | null
      >;
      for (const [key, value] of Object.entries(renames)) {
        if (value === null || isString(value)) parsed[key] = value;
        else problems.push(`the rename "${key}" is not a name or null`);
      }
      renamesValue = parsed;
    } else {
      problems.push('the "renames" is not a map; it was dropped');
    }
  }

  return {
    ok: true,
    problems,
    manifest: {
      name,
      owner: {
        name: ownValue(owner, 'name') as string,
        ...(isString(ownerEmail) ? { email: ownerEmail } : {}),
        ...(isString(ownerUrl) ? { url: ownerUrl } : {}),
      },
      plugins,
      ...(isString(version) ? { version } : {}),
      ...(isString(description) ? { description } : {}),
      ...(typeof forceRemove === 'boolean' ? { forceRemoveDeletedPlugins: forceRemove } : {}),
      ...(metadataValue === undefined ? {} : { metadata: metadataValue }),
      ...(isStringArray(crossMarketplace)
        ? { allowCrossMarketplaceDependenciesOn: crossMarketplace }
        : {}),
      ...(renamesValue === undefined ? {} : { renames: renamesValue }),
      problems,
    },
  };
}
