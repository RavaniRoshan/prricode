/**
 * The **marketplace source protocol** — the ways a marketplace can be reached.
 *
 * Evidence: `chunk-c9s0jh80.js:105243` (the schema `hl`), `:102839` (the set
 * `pl`), `:114636` (the policy-list schema `ar`), `:112023` (the sanitiser
 * `dy`), `chunk-4jsg44k7.js:4156876` (the canonical form `K1`), `:4155409` (the
 * description `HPt`), `:4217775` (the loader `Wrt`), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-marketplace.md` §1.
 *
 * ## What a marketplace source is
 *
 * A **source** says where a marketplace's catalogue comes from. The target's
 * schema is a **discriminated union** on the key `source`, with **ten**
 * declarable members:
 *
 * | The source | What it is |
 * |---|---|
 * | `url` | the catalogue is fetched over HTTP — `url`, `headers?`, `headersHelper?` |
 * | `github` | the catalogue is cloned — `repo`, `ref?`, `path?`, `sparsePaths?`, `skipLfs?` |
 * | `git` | the catalogue is cloned — `url`, `ref?`, `path?`, `sparsePaths?`, `skipLfs?` |
 * | `npm` | the catalogue is in an npm package — `package`, `version?`, `registry?` |
 * | `file` | a local `marketplace.json` — `path` |
 * | `directory` | a local directory holding `.claude-plugin/marketplace.json` — `path` |
 * | `skills-dir` | a **policy-list sentinel** — no other field |
 * | `hostPattern` | a **policy-list sentinel** — `hostPattern` |
 * | `pathPattern` | a **policy-list sentinel** — `pathPattern` |
 * | `settings` | a catalogue declared inline in a settings file — `name`, `plugins`, `owner?` |
 *
 * The **policy lists** — the managed-settings allowlist and blocklist — carry
 * **one** more member, `pluginDirectory`, the built-in Directory marketplace.
 * The target's own description says it *"cannot be added or declared anywhere
 * else"*.
 *
 * Two more source values are accepted by the target's own switch but are
 * **runtime-only** — the runtime produces them, nobody authors them:
 * `claudeai` (a plugin synced from the account) and `pluginDirectory`.
 *
 * ## The honest boundary
 *
 * This implementation has **no marketplace server and no account**, so it can
 * reach no catalogue at all. Every source therefore names **the capability it
 * would need** — a clone, an HTTP fetch, a registry client, the local
 * filesystem, the settings file — and says so when it is invoked. The `npm`
 * source is refused with the target's own words, because the target refuses it
 * too: *"NPM marketplace sources not yet implemented"*.
 */

import { isPlainObject } from '../skills/frontmatter.js';

import type { PluginSource } from './pluginSources.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The source types a marketplace may be declared with.
 *
 * The order is the target's own — the order of the union's members.
 */
export const MARKETPLACE_SOURCE_TYPES = [
  'url',
  'github',
  'git',
  'npm',
  'file',
  'directory',
  'skills-dir',
  'hostPattern',
  'pathPattern',
  'settings',
] as const;

/** One of the source types a marketplace may be declared with. */
export type MarketplaceSourceType = (typeof MARKETPLACE_SOURCE_TYPES)[number];

/**
 * The source types the **policy lists** carry.
 *
 * The managed-settings allowlist and blocklist carry one more member than the
 * declarable vocabulary: the built-in Directory marketplace.
 */
export const MARKETPLACE_POLICY_SOURCE_TYPES = [
  'pluginDirectory',
  ...MARKETPLACE_SOURCE_TYPES,
] as const;

/** One of the policy-list source types. */
export type MarketplacePolicySourceType = (typeof MARKETPLACE_POLICY_SOURCE_TYPES)[number];

/**
 * The source values the target's runtime produces and nobody authors.
 */
export const MARKETPLACE_RUNTIME_SOURCE_TYPES = ['claudeai', 'pluginDirectory'] as const;

/* -------------------------------------------------------------------------- */
/* The shapes                                                                   */
/* -------------------------------------------------------------------------- */

/** A catalogue fetched over HTTP. */
export interface MarketplaceUrlSource {
  /** The discriminator. */
  readonly source: 'url';
  /** The catalogue's URL. */
  readonly url: string;
  /** The headers the fetch carries. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The command that prints the headers. */
  readonly headersHelper?: string;
}

/** A catalogue cloned from a GitHub repository. */
export interface MarketplaceGithubSource {
  /** The discriminator. */
  readonly source: 'github';
  /** The repository, in `owner/repo` form. */
  readonly repo: string;
  /** The branch or the tag. */
  readonly ref?: string;
  /** The path to the catalogue within the repository. */
  readonly path?: string;
  /** The directories a sparse checkout keeps. */
  readonly sparsePaths?: readonly string[];
  /** Accepted for compatibility; the target's own git never fetches LFS content. */
  readonly skipLfs?: boolean;
}

/** A catalogue cloned from a git repository. */
export interface MarketplaceGitSource {
  /** The discriminator. */
  readonly source: 'git';
  /** The repository URL. */
  readonly url: string;
  /** The branch or the tag. */
  readonly ref?: string;
  /** The path to the catalogue within the repository. */
  readonly path?: string;
  /** The directories a sparse checkout keeps. */
  readonly sparsePaths?: readonly string[];
  /** Accepted for compatibility; the target's own git never fetches LFS content. */
  readonly skipLfs?: boolean;
}

/** A catalogue in an npm package. */
export interface MarketplaceNpmSource {
  /** The discriminator. */
  readonly source: 'npm';
  /** The package. */
  readonly package: string;
  /** The version or the range. */
  readonly version?: string;
  /** The registry the package is fetched from. */
  readonly registry?: string;
}

/** A catalogue in a local file. */
export interface MarketplaceFileSource {
  /** The discriminator. */
  readonly source: 'file';
  /** The path to the catalogue. */
  readonly path: string;
}

/** A catalogue in a local directory. */
export interface MarketplaceDirectorySource {
  /** The discriminator. */
  readonly source: 'directory';
  /** The path to the directory. */
  readonly path: string;
}

/** The policy-list sentinel for the local skills directory. */
export interface MarketplaceSkillsDirSource {
  /** The discriminator. */
  readonly source: 'skills-dir';
}

/** The policy-list sentinel that matches a host. */
export interface MarketplaceHostPatternSource {
  /** The discriminator. */
  readonly source: 'hostPattern';
  /** The pattern the host is matched against. */
  readonly hostPattern: string;
}

/** The policy-list sentinel that matches a path. */
export interface MarketplacePathPatternSource {
  /** The discriminator. */
  readonly source: 'pathPattern';
  /** The pattern the path is matched against. */
  readonly pathPattern: string;
}

/** A catalogue declared inline in a settings file. */
export interface MarketplaceSettingsSource {
  /** The discriminator. */
  readonly source: 'settings';
  /** The marketplace's name. */
  readonly name: string;
  /** The plugin entries the settings file declares. */
  readonly plugins: readonly MarketplaceSettingsEntry[];
  /** The maintainer. */
  readonly owner?: MarketplaceOwner;
}

/** The maintainer of a marketplace or a plugin. */
export interface MarketplaceOwner {
  /** The display name. */
  readonly name: string;
  /** The contact address. */
  readonly email?: string;
  /** The contact URL. */
  readonly url?: string;
}

/**
 * A plugin entry declared inline in a settings file.
 *
 * The target's settings-declared entry carries the entry's own name, its
 * source, and a little more — and it carries **two** refinements: the source
 * may not be a relative path, and it may not be the `unsupported` placeholder.
 */
export interface MarketplaceSettingsEntry {
  /** The plugin's name. */
  readonly name: string;
  /** Where the plugin comes from. */
  readonly source: PluginSource;
  /** The plugin's description. */
  readonly description?: string;
  /** The plugin's version. */
  readonly version?: string;
  /** Whether the manifest must be present in the plugin's folder. */
  readonly strict?: boolean;
  /** The headers the download carries. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The command that prints the headers. */
  readonly headersHelper?: string;
}

/**
 * A plugin synced from the account.
 *
 * A **runtime-only** source: the runtime produces it, nobody authors it.
 */
export interface MarketplaceClaudeAiSource {
  /** The discriminator. */
  readonly source: 'claudeai';
}

/**
 * The built-in Directory marketplace.
 *
 * A **runtime-only** source outside the policy lists.
 */
export interface MarketplacePluginDirectorySource {
  /** The discriminator. */
  readonly source: 'pluginDirectory';
}

/** A marketplace source. */
export type MarketplaceSource =
  | MarketplaceUrlSource
  | MarketplaceGithubSource
  | MarketplaceGitSource
  | MarketplaceNpmSource
  | MarketplaceFileSource
  | MarketplaceDirectorySource
  | MarketplaceSkillsDirSource
  | MarketplaceHostPatternSource
  | MarketplacePathPatternSource
  | MarketplaceSettingsSource
  | MarketplaceClaudeAiSource
  | MarketplacePluginDirectorySource;

/* -------------------------------------------------------------------------- */
/* The capabilities                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The capability a marketplace source needs before its catalogue can be read.
 */
export type MarketplaceSourceCapability =
  | 'http-fetch'
  | 'git-clone'
  | 'npm-registry'
  | 'filesystem'
  | 'skills-directory'
  | 'policy-list'
  | 'settings-file'
  | 'builtin-directory'
  | 'account-sync';

/** The capability of each source type. */
const SOURCE_CAPABILITIES: Readonly<Record<string, MarketplaceSourceCapability>> = {
  url: 'http-fetch',
  github: 'git-clone',
  git: 'git-clone',
  npm: 'npm-registry',
  file: 'filesystem',
  directory: 'filesystem',
  'skills-dir': 'skills-directory',
  hostPattern: 'policy-list',
  pathPattern: 'policy-list',
  settings: 'settings-file',
  pluginDirectory: 'builtin-directory',
  claudeai: 'account-sync',
};

/**
 * The capability a marketplace source needs.
 *
 * A source the target does not know needs the **policy list** — a source that
 * is not on the list is refused before anything is fetched.
 */
export function marketplaceSourceCapability(source: MarketplaceSource): MarketplaceSourceCapability {
  const kind = (source as { source: string }).source;
  if (!Object.hasOwn(SOURCE_CAPABILITIES, kind)) return 'policy-list';
  return SOURCE_CAPABILITIES[kind] as MarketplaceSourceCapability;
}

/* -------------------------------------------------------------------------- */
/* The discrimination                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The source type of a value, when it is one the target's schema declares.
 *
 * The lookup is an **own-property** check, and the type is checked against the
 * target's own vocabulary — so a caller-supplied `constructor` or `toString`
 * never resolves to a source type.
 */
export function marketplaceSourceType(value: unknown): MarketplaceSourceType | undefined {
  if (!isPlainObject(value)) return undefined;
  const kind = Object.hasOwn(value, 'source') ? value['source'] : undefined;
  if (typeof kind !== 'string') return undefined;
  return (MARKETPLACE_SOURCE_TYPES as readonly string[]).includes(kind)
    ? (kind as MarketplaceSourceType)
    : undefined;
}

/* -------------------------------------------------------------------------- */
/* The canonical form                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The query-parameter names whose values the target masks.
 */
const MASKED_QUERY_PARAMETERS = new Set([
  'ref',
  'branch',
  'tag',
  'path',
  'file',
  'file_path',
  'version',
  'format',
]);

/**
 * The sanitised form of a URL.
 *
 * The target's own rule: the **credentials** are stripped, and the **value** of
 * a query parameter whose name is one the target treats as sensitive is
 * replaced by `***` — the parameter's *name* is kept, so the shape of the URL
 * survives.
 *
 * **What was not established:** the target's sanitiser drops the fragment of a
 * URL that also carries a query. This implementation keeps it; the difference
 * is visible only for a URL with both.
 */
export function sanitizeMarketplaceUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.host === '') return url;

  parsed.username = '';
  parsed.password = '';

  const parameters = parsed.searchParams;
  for (const name of [...parameters.keys()]) {
    if (MASKED_QUERY_PARAMETERS.has(name.toLowerCase())) parameters.set(name, '***');
  }
  return parsed.toString();
}

/**
 * The canonical form of a marketplace source.
 *
 * The target's own form, for every source it names — and the target's own
 * fallbacks: `"unknown source"` for a source it does not know.
 */
export function formatMarketplaceSource(source: MarketplaceSource): string {
  switch (source.source) {
    case 'github':
      return `github:${source.repo}${source.ref === undefined ? '' : `@${source.ref}`}`;
    case 'url':
      return sanitizeMarketplaceUrl(source.url);
    case 'git':
      return `git:${sanitizeMarketplaceUrl(source.url)}${source.ref === undefined ? '' : `@${source.ref}`}`;
    case 'npm':
      return `npm:${source.package}`;
    case 'file':
      return `file:${source.path}`;
    case 'directory':
      return `dir:${source.path}`;
    case 'hostPattern':
      return `hostPattern:${source.hostPattern}`;
    case 'pathPattern':
      return `pathPattern:${source.pathPattern}`;
    case 'skills-dir':
      return 'skills-dir';
    case 'settings':
      return `settings:${source.name} (${source.plugins.length} ${
        source.plugins.length === 1 ? 'plugin' : 'plugins'
      })`;
    case 'claudeai':
      return 'claude.ai';
    case 'pluginDirectory':
      return 'Anthropic Directory';
    default:
      return 'unknown source';
  }
}

/**
 * The description of a marketplace source.
 *
 * The target describes **eight** of the source types; the other four — `npm`,
 * `skills-dir`, `hostPattern` and `pathPattern` — fall through to the target's
 * own `"Unknown source"`.
 */
export function describeMarketplaceSource(source: MarketplaceSource): string {
  switch (source.source) {
    case 'github':
      return source.repo;
    case 'url':
      return sanitizeMarketplaceUrl(source.url);
    case 'git':
      return sanitizeMarketplaceUrl(source.url);
    case 'directory':
      return source.path;
    case 'file':
      return source.path;
    case 'settings':
      return `settings:${source.name}`;
    case 'claudeai':
      return 'claude.ai';
    case 'pluginDirectory':
      return 'Built in';
    default:
      return 'Unknown source';
  }
}

/* -------------------------------------------------------------------------- */
/* The refusal                                                                  */
/* -------------------------------------------------------------------------- */

/** The result of resolving a marketplace source. */
export type MarketplaceSourceResolution =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** The capability the source needs. */
      readonly capability: MarketplaceSourceCapability;
      /** Why the source was refused. */
      readonly reason: string;
    };

/**
 * The target's own refusal for an npm marketplace source.
 *
 * The target throws exactly this text (`chunk-4jsg44k7.js:4217775`).
 */
export const MARKETPLACE_NPM_NOT_IMPLEMENTED = 'NPM marketplace sources not yet implemented';

/**
 * Resolve a marketplace source.
 *
 * This implementation has **no marketplace server**, so every source is
 * refused — and the refusal names **the capability the source would need**,
 * so a caller can tell a clone from a fetch from a registry client.
 */
export function resolveMarketplaceSource(source: MarketplaceSource): MarketplaceSourceResolution {
  const capability = marketplaceSourceCapability(source);
  const kind = (source as { source: string }).source;

  if (kind === 'npm') {
    return {
      ok: false,
      capability,
      reason:
        `${MARKETPLACE_NPM_NOT_IMPLEMENTED}: reaching an npm marketplace source needs an ` +
        `${capability}, which this implementation does not have.`,
    };
  }

  return {
    ok: false,
    capability,
    reason:
      `reaching a "${kind}" marketplace source needs a ${capability}; this implementation has ` +
      `no marketplace server, so it refuses.`,
  };
}
