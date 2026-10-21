/**
 * The **plugin source protocol** — the ways a plugin can be installed from.
 *
 * Evidence: `chunk-c9s0jh80.js:116671` (the schema `bl`), `:115476` (the archive
 * schema `my`), `:126841` (the named set `Sy`), `chunk-4jsg44k7.js:4481234` (the
 * canonical kind `iss`), `:4481100` (the cache `Ult`), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-marketplace.md` §2.
 *
 * ## What a plugin source is
 *
 * A **source** says where a plugin's files come from. The target's schema is a
 * **union**, not a discriminated union, because the first member is a bare
 * **path string**:
 *
 * | The source | What it is |
 * |---|---|
 * | a path string | the plugin root, relative to the marketplace root |
 * | `npm` | an npm package — `package`, `version?`, `registry?` |
 * | `url` | a git repository — `url`, `ref?`, `sha?` |
 * | `github` | a GitHub repository — `repo`, `ref?`, `sha?` |
 * | `git-subdir` | a subdirectory of a larger repository — `url`, `path`, `ref?`, `sha?` |
 * | `archive` | a zip archive over HTTPS — `url`, `sha256?` |
 * | `command` | a local command that prints the plugin's directory — `command`, `timeout?`, `mode?` |
 * | `unsupported` | **a parse-time placeholder**, never authored by hand |
 *
 * The `sha` is a **full 40-character lowercase git commit SHA**; the `sha256` is a
 * **64-character hex digest**; the archive's URL must be `https` and must not
 * point at a loopback, link-local or cloud-metadata host; the command must be
 * **printable ASCII** with no runs of four or more spaces.
 *
 * ## The two vocabularies
 *
 * The target has **two** lists over the same union, and they are not the same
 * list:
 *
 * - the **named** types — `Sy` — are the seven `npm`, `url`, `github`,
 *   `git-subdir`, `archive`, `command`, `unsupported`;
 * - the **canonical kinds** — `iss` — are the eight `local`, `npm`, `github`,
 *   `git`, `subdir`, `archive`, `command`, `unknown`. A path becomes `local`, a
 *   `url` becomes `git`, a `git-subdir` becomes `subdir`, and anything the
 *   target does not know becomes `unknown`.
 *
 * The kind is also the **directory name** the plugin is cached under.
 *
 * ## The honest boundary
 *
 * This implementation has **no plugin registry and no account**, so it can
 * neither fetch nor install a plugin. Every source therefore names **the
 * capability it would need**, and says so when it is invoked. The vocabulary of
 * those capabilities is the target's own split of the work — a clone, a registry
 * client, an archive download, a command runner, the local filesystem.
 */

import { isPlainObject } from '../skills/frontmatter.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The source types the target names.
 *
 * `unsupported` is the target's **parse-time placeholder**: the schema rewrites
 * an unparseable source into it so that the entry stays in the catalogue and is
 * not read as removed.
 */
export const PLUGIN_SOURCE_TYPES = [
  'npm',
  'url',
  'github',
  'git-subdir',
  'archive',
  'command',
  'unsupported',
] as const;

/** One of the source types the target names. */
export type PluginSourceType = (typeof PLUGIN_SOURCE_TYPES)[number];

/**
 * The canonical kinds the target's cache names a plugin's directory after.
 */
export const PLUGIN_SOURCE_KINDS = [
  'local',
  'npm',
  'github',
  'git',
  'subdir',
  'archive',
  'command',
  'unknown',
] as const;

/** One of the canonical kinds. */
export type PluginSourceKind = (typeof PLUGIN_SOURCE_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* The shapes                                                                   */
/* -------------------------------------------------------------------------- */

/** A plugin installed from an npm package. */
export interface PluginNpmSource {
  /** The discriminator. */
  readonly source: 'npm';
  /** The package name, or anything the npm client accepts as one. */
  readonly package: string;
  /** The version or the range. */
  readonly version?: string;
  /** The registry the package is fetched from. */
  readonly registry?: string;
}

/** A plugin installed from a git repository by URL. */
export interface PluginUrlSource {
  /** The discriminator. */
  readonly source: 'url';
  /** The repository URL. */
  readonly url: string;
  /** The branch or the tag. */
  readonly ref?: string;
  /** The commit SHA. */
  readonly sha?: string;
}

/** A plugin installed from a GitHub repository. */
export interface PluginGithubSource {
  /** The discriminator. */
  readonly source: 'github';
  /** The repository, in `owner/repo` form. */
  readonly repo: string;
  /** The branch or the tag. */
  readonly ref?: string;
  /** The commit SHA. */
  readonly sha?: string;
}

/** A plugin installed from a subdirectory of a larger repository. */
export interface PluginGitSubdirSource {
  /** The discriminator. */
  readonly source: 'git-subdir';
  /** The repository URL. */
  readonly url: string;
  /** The subdirectory that holds the plugin. */
  readonly path: string;
  /** The branch or the tag. */
  readonly ref?: string;
  /** The commit SHA. */
  readonly sha?: string;
}

/** A plugin installed from a zip archive. */
export interface PluginArchiveSource {
  /** The discriminator. */
  readonly source: 'archive';
  /** The archive's URL. */
  readonly url: string;
  /** The digest the download is verified against. */
  readonly sha256?: string;
}

/** A plugin produced by a locally installed tool. */
export interface PluginCommandSource {
  /** The discriminator. */
  readonly source: 'command';
  /** The command that prints the plugin's directory. */
  readonly command: string;
  /** The seconds the command may run for. */
  readonly timeout?: number;
  /** Whether the directory is copied into the cache or linked in place. */
  readonly mode?: 'copy' | 'link';
}

/** The placeholder the target writes for a source it cannot parse. */
export interface PluginUnsupportedSource {
  /** The discriminator. */
  readonly source: 'unsupported';
  /** Why the source could not be parsed. */
  readonly error?: string;
}

/** The source types that name their own kind. */
export type PluginSourceObject =
  | PluginNpmSource
  | PluginUrlSource
  | PluginGithubSource
  | PluginGitSubdirSource
  | PluginArchiveSource
  | PluginCommandSource
  | PluginUnsupportedSource;

/**
 * A plugin source.
 *
 * A **string** is a path — either a relative path that starts with `./`, or a
 * **bare name** that the marketplace's `metadata.pluginRoot` resolves.
 */
export type PluginSource = string | PluginSourceObject;

/* -------------------------------------------------------------------------- */
/* The capabilities                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The capability a plugin source needs before it can be installed.
 */
export type PluginSourceCapability =
  | 'filesystem'
  | 'npm-registry'
  | 'git-clone'
  | 'sparse-git-clone'
  | 'https-archive'
  | 'command-runner'
  | 'unsupported-source';

/** The capability of each source type. */
const SOURCE_CAPABILITIES: Readonly<Record<PluginSourceType, PluginSourceCapability>> = {
  npm: 'npm-registry',
  url: 'git-clone',
  github: 'git-clone',
  'git-subdir': 'sparse-git-clone',
  archive: 'https-archive',
  command: 'command-runner',
  unsupported: 'unsupported-source',
};

/**
 * The capability a plugin source needs.
 *
 * A path needs the **local filesystem**; every other source names the client it
 * would take.
 */
export function pluginSourceCapability(source: PluginSource): PluginSourceCapability {
  if (typeof source === 'string') return 'filesystem';
  if (!Object.hasOwn(SOURCE_CAPABILITIES, source.source)) return 'unsupported-source';
  return SOURCE_CAPABILITIES[source.source];
}

/* -------------------------------------------------------------------------- */
/* The canonical kind                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The canonical kind of a plugin source.
 *
 * The target's own rule: a path is `local`, a `url` is `git`, a `git-subdir` is
 * `subdir`, an `archive` is `archive`, and a source the target does not know is
 * `unknown`.
 */
export function pluginSourceKind(source: PluginSource): PluginSourceKind {
  if (typeof source === 'string') return 'local';
  switch (source.source) {
    case 'npm':
      return 'npm';
    case 'github':
      return 'github';
    case 'url':
      return 'git';
    case 'git-subdir':
      return 'subdir';
    case 'archive':
      return 'archive';
    case 'command':
      return 'command';
    default:
      return 'unknown';
  }
}

/**
 * A one-line description of a plugin source.
 *
 * **Implementation choice** — the target names a source by its *kind* and its
 * cache directory, not by a description; this is a description this
 * implementation's own refusals use.
 */
export function describePluginSource(source: PluginSource): string {
  if (typeof source === 'string') return source;
  switch (source.source) {
    case 'npm':
      return `npm:${source.package}`;
    case 'url':
      return `url:${source.url}`;
    case 'github':
      return `github:${source.repo}`;
    case 'git-subdir':
      return `git-subdir:${source.url}#${source.path}`;
    case 'archive':
      return `archive:${source.url}`;
    case 'command':
      return `command:${source.command}`;
    case 'unsupported':
      return source.error === undefined
        ? 'unsupported'
        : `unsupported: ${source.error}`;
    default:
      return 'unknown';
  }
}

/* -------------------------------------------------------------------------- */
/* The validation                                                               */
/* -------------------------------------------------------------------------- */

/** The full-commit-SHA shape the target's `sha` fields carry. */
const COMMIT_SHA = /^[a-f0-9]{40}$/;

/** The digest shape the target's `sha256` field carries. */
const SHA256 = /^[a-f0-9A-F]{64}$/;

/** The target's rule for a printable command: ASCII, and no run of four spaces. */
const PRINTABLE_COMMAND = /[^\x20-\x7E]| {4,}/;

/** The bare-source-name shape the target's `metadata.pluginRoot` resolves. */
const BARE_SOURCE_NAME = /^[A-Za-z0-9][-A-Za-z0-9._]*$/;

/**
 * Read a value out of an object.
 *
 * The lookup is an **own-property** check: a source is caller-supplied data, so
 * a key that names an inherited member of `Object.prototype` yields `undefined`
 * rather than the inherited member.
 */
function ownValue(document: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(document, key) ? document[key] : undefined;
}

/**
 * Whether a path is one the target's schema accepts.
 *
 * A path is either **relative** — it starts with `./` — or a **bare name**,
 * which the marketplace's `metadata.pluginRoot` resolves. A bare name that
 * carries a `..` segment is refused.
 */
export function isAcceptablePluginSourcePath(path: string): boolean {
  if (path.startsWith('./')) return true;
  if (!BARE_SOURCE_NAME.test(path)) return false;
  return !path.includes('..');
}

/**
 * Whether a source's **type** is one the target does not know.
 *
 * The target distinguishes the two refusals — a source whose *type* is unknown
 * and a known type whose *fields* are wrong — and this is the first of them.
 */
export function isUnknownPluginSourceType(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  const kind = ownValue(raw, 'source');
  if (typeof kind !== 'string') return false;
  return !(PLUGIN_SOURCE_TYPES as readonly string[]).includes(kind);
}

/**
 * The result of parsing a plugin source.
 */
export interface PluginSourceParse {
  /** Whether the source is one the target's schema accepts. */
  readonly ok: boolean;
  /** The parsed source, when it is one. */
  readonly source?: PluginSource;
  /** The reason the source was refused, when it was. */
  readonly reason?: string;
  /**
   * Whether the source's **type** is one the target does not know.
   *
   * The target distinguishes the two refusals: a source whose *type* is unknown
   * is a **stub** with no reason at all, while a known type whose *fields* are
   * wrong is a stub that carries the reason.
   */
  readonly unknownType?: boolean;
}

/**
 * Parse a plugin source.
 *
 * The checks are the target's own: the archive's URL must be `https`, the
 * digests must have the shapes the target's schema names, the command must be
 * printable ASCII, and the `git-subdir` path must not be empty.
 */
export function parsePluginSource(raw: unknown): PluginSourceParse {
  if (typeof raw === 'string') {
    if (!isAcceptablePluginSourcePath(raw)) {
      return { ok: false, reason: `the source path "${raw}" is not one the target accepts` };
    }
    return { ok: true, source: raw };
  }

  if (!isPlainObject(raw)) {
    return { ok: false, reason: 'the source is not an object' };
  }

  const kind = ownValue(raw, 'source');
  if (typeof kind !== 'string') {
    return { ok: false, reason: 'the source has no "source" key' };
  }

  switch (kind) {
    case 'npm': {
      const pkg = ownValue(raw, 'package');
      if (typeof pkg !== 'string' || pkg === '') {
        return { ok: false, reason: 'an npm source has no package' };
      }
      const version = ownValue(raw, 'version');
      const registry = ownValue(raw, 'registry');
      return {
        ok: true,
        source: {
          source: 'npm',
          package: pkg,
          ...(typeof version === 'string' ? { version } : {}),
          ...(typeof registry === 'string' ? { registry } : {}),
        },
      };
    }
    case 'url':
    case 'github': {
      const key = kind === 'url' ? 'url' : 'repo';
      const value = ownValue(raw, key);
      if (typeof value !== 'string' || value === '') {
        return { ok: false, reason: `a ${kind} source has no ${key}` };
      }
      const ref = ownValue(raw, 'ref');
      const sha = ownValue(raw, 'sha');
      if (sha !== undefined && (typeof sha !== 'string' || !COMMIT_SHA.test(sha))) {
        return { ok: false, reason: 'the sha is not a full 40-character commit SHA' };
      }
      if (kind === 'url') {
        return {
          ok: true,
          source: {
            source: 'url',
            url: value,
            ...(typeof ref === 'string' ? { ref } : {}),
            ...(typeof sha === 'string' ? { sha } : {}),
          },
        };
      }
      return {
        ok: true,
        source: {
          source: 'github',
          repo: value,
          ...(typeof ref === 'string' ? { ref } : {}),
          ...(typeof sha === 'string' ? { sha } : {}),
        },
      };
    }
    case 'git-subdir': {
      const url = ownValue(raw, 'url');
      const subpath = ownValue(raw, 'path');
      if (typeof url !== 'string' || url === '') {
        return { ok: false, reason: 'a git-subdir source has no url' };
      }
      if (typeof subpath !== 'string' || subpath === '') {
        return { ok: false, reason: 'a git-subdir source has no path' };
      }
      const ref = ownValue(raw, 'ref');
      const sha = ownValue(raw, 'sha');
      if (sha !== undefined && (typeof sha !== 'string' || !COMMIT_SHA.test(sha))) {
        return { ok: false, reason: 'the sha is not a full 40-character commit SHA' };
      }
      return {
        ok: true,
        source: {
          source: 'git-subdir',
          url,
          path: subpath,
          ...(typeof ref === 'string' ? { ref } : {}),
          ...(typeof sha === 'string' ? { sha } : {}),
        },
      };
    }
    case 'archive': {
      const url = ownValue(raw, 'url');
      if (typeof url !== 'string' || url === '') {
        return { ok: false, reason: 'an archive source has no url' };
      }
      if (!url.startsWith('https://')) {
        return { ok: false, reason: 'an archive url must use https' };
      }
      const digest = ownValue(raw, 'sha256');
      if (digest !== undefined && (typeof digest !== 'string' || !SHA256.test(digest))) {
        return { ok: false, reason: 'the sha256 is not a 64-character hex digest' };
      }
      return {
        ok: true,
        source: {
          source: 'archive',
          url,
          ...(typeof digest === 'string' ? { sha256: digest } : {}),
        },
      };
    }
    case 'command': {
      const command = ownValue(raw, 'command');
      if (typeof command !== 'string' || command === '') {
        return { ok: false, reason: 'a command source has no command' };
      }
      if (PRINTABLE_COMMAND.test(command)) {
        return {
          ok: false,
          reason: 'a command must be printable ASCII with no runs of four or more spaces',
        };
      }
      const timeout = ownValue(raw, 'timeout');
      if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0)) {
        return { ok: false, reason: 'the timeout is not a positive number of seconds' };
      }
      const mode = ownValue(raw, 'mode');
      if (mode !== undefined && mode !== 'copy' && mode !== 'link') {
        return { ok: false, reason: 'the mode is neither copy nor link' };
      }
      return {
        ok: true,
        source: {
          source: 'command',
          command,
          ...(typeof timeout === 'number' ? { timeout } : {}),
          ...(mode === 'copy' || mode === 'link' ? { mode } : {}),
        },
      };
    }
    case 'unsupported': {
      const error = ownValue(raw, 'error');
      return {
        ok: true,
        source: {
          source: 'unsupported',
          ...(typeof error === 'string' ? { error } : {}),
        },
      };
    }
    default:
      return {
        ok: false,
        reason: `the source type "${kind}" is not one the target knows`,
        unknownType: true,
      };
  }
}
