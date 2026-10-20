/**
 * The plugin manifest: what a plugin declares, and how a broken manifest is
 * reported.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("The plugin
 * manifest schema is observed") and `docs/compatibility/extension-surface.md`
 * ("The manifest schema").
 *
 * ## The two groups of keys
 *
 * | Group | Keys |
 * |---|---|
 * | **directory** | `commands`, `agents`, `skills`, `outputStyles`, `themes`, `workflows`, `monitors` |
 * | **file** | `mcpServers`, `lspServers`, `hooks` |
 *
 * "Each key may be declared at the **top level** or under **`experimental`**, and
 * a value may be a **single path string** or an **array of path strings**.
 * `commands` may additionally be an **object** whose entries carry a `source`
 * path."
 *
 * "A manifest that is not a JSON object is `broken` with the reason *"it is not
 * a JSON object"*. A plugin can present **several manifest candidates** (for
 * example `.claude-plugin/plugin.json`). A plugin is `ok` when a **`SKILL.md`
 * exists at the plugin root**."
 *
 * ## Implementation choices (the audit does not pin them)
 *
 *   - The **candidate order** is `.claude-plugin/plugin.json` first, then
 *     `plugin.json`. The audit names the first one as an example; this implementation's
 *     list is the order it tries them in.
 *   - A key declared in **both** places contributes **both** values: the
 *     `experimental` block adds to the top-level declaration rather than
 *     replacing it. The audit says each key "may be declared at the top level
 *     or under `experimental`", and does not say what happens when both
 *     declare it.
 *   - A value that is neither a string nor an array of strings is **ignored**
 *     and recorded as a problem, rather than failing the whole manifest. A
 *     manifest is broken only when it is not a JSON object.
 *   - The **reason** a plugin with no `SKILL.md` at its root is broken is the
 *     implementation's; the audit pins only the "it is not a JSON object" reason.
 *
 * ## The path boundary (a implementation choice)
 *
 * A manifest is **untrusted input**: it arrives from a marketplace or a shared
 * repository, and every path it declares is resolved against the plugin root.
 * The target's behavior here is **unobserved** — the audit says nothing about
 * a plugin reaching outside its own root — so the refusal is a **implementation
 * choice**. The plan's Global Constraint requires that "permissions, **path
 * boundaries**, shell execution, approval prompts, and credential redaction
 * are enforced by **implementation-owned** code, independent of model instructions", so
 * the boundary is enforced here, in this implementation's own code.
 *
 * The rule is: a declared path is used only when it is **inside the plugin
 * root**, where "inside" means
 *
 *   - the path, resolved against the plugin root, is the root itself or lies
 *     under it — the comparison is made on the **lexically resolved** path, so
 *     a `../` escape is refused before anything is read; and
 *   - the path, with **every symlink resolved** (`realpath`), is still the
 *     root itself or under it — so a symlink inside the root that points
 *     outside it is refused too.
 *
 * A refused path is reported with a **named reason**:
 * `PLUGIN_PATH_OUTSIDE_ROOT_REASON` for the lexical escape and
 * `PLUGIN_PATH_SYMLINK_OUTSIDE_ROOT_REASON` for the symlink escape.
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

import { isPlainObject } from '../skills/frontmatter.js';

/**
 * The manifest keys that declare **directories**.
 *
 * A directory holds content: a skill per subdirectory, a command per `.md`
 * file, and so on.
 */
export const PLUGIN_DIRECTORY_KEYS = [
  'commands',
  'agents',
  'skills',
  'outputStyles',
  'themes',
  'workflows',
  'monitors',
] as const;

/** One of the directory keys. */
export type PluginDirectoryKey = (typeof PLUGIN_DIRECTORY_KEYS)[number];

/**
 * The manifest keys that declare **files**.
 */
export const PLUGIN_FILE_KEYS = ['mcpServers', 'lspServers', 'hooks'] as const;

/** One of the file keys. */
export type PluginFileKey = (typeof PLUGIN_FILE_KEYS)[number];

/**
 * The manifest candidates a plugin may present.
 *
 * The audit names `.claude-plugin/plugin.json` as an example.
 */
export const PLUGIN_MANIFEST_CANDIDATES = [
  '.claude-plugin/plugin.json',
  'plugin.json',
] as const;

/**
 * The reason a manifest that is not a JSON object is broken.
 */
export const PLUGIN_MANIFEST_NOT_AN_OBJECT_REASON = 'it is not a JSON object';

/**
 * The reason a plugin with no `SKILL.md` at its root is broken.
 *
 * Implementation choice — the audit pins only the "not a JSON object" reason.
 */
export const PLUGIN_MISSING_SKILL_REASON = 'it has no SKILL.md at its root';

/**
 * The reason a plugin with no manifest at all is broken.
 *
 * Implementation choice — the audit pins only the "not a JSON object" reason.
 */
export const PLUGIN_MISSING_MANIFEST_REASON = 'it has no plugin manifest';

/**
 * One entry of the manifest's `commands` object.
 *
 * An entry with a `source` points at a file; an entry with `content` and no
 * `source` is an **inline** command.
 */
export interface PluginCommandEntry {
  /** The metadata key. */
  key: string;
  /** The path of the command file, relative to the plugin root. */
  source?: string;
  /** The inline content of the command. */
  content?: string;
}

/** A parsed plugin manifest. */
export interface PluginManifest {
  /** The manifest's declared name. */
  name?: string;
  /** The manifest's declared version. */
  version?: string;
  /** The manifest's declared description. */
  description?: string;
  /** The directory content, by key. */
  directories: Partial<Record<PluginDirectoryKey, string[]>>;
  /** The file content, by key. */
  files: Partial<Record<PluginFileKey, string[]>>;
  /** The command entries the manifest declares. */
  commands: PluginCommandEntry[];
  /** The path the manifest was read from. */
  manifestPath: string;
  /**
   * The problems the manifest carries.
   *
   * The **parse** problems first, and then the paths the **containment**
   * refused — so the record is self-describing: a consumer that reads only
   * the manifest sees that a declared path was dropped, and why.
   */
  problems: string[];
}

/** The result of parsing a manifest. */
export interface PluginManifestParse {
  /** Whether the manifest is usable. */
  ok: boolean;
  /** The parsed manifest, when it is usable. */
  manifest?: PluginManifest;
  /** The reason the manifest is broken, when it is. */
  reason?: string;
}

/**
 * The reason a manifest-declared path is refused because it leaves the plugin
 * root.
 *
 * Implementation choice — see the file header.
 */
export const PLUGIN_PATH_OUTSIDE_ROOT_REASON = 'it resolves outside the plugin root';

/**
 * The reason a manifest-declared path is refused because a symlink inside the
 * plugin root points outside it.
 *
 * Implementation choice — see the file header.
 */
export const PLUGIN_PATH_SYMLINK_OUTSIDE_ROOT_REASON =
  'it is a symlink that resolves outside the plugin root';

/** The result of resolving a manifest-declared path against the plugin root. */
export interface PluginPathResolution {
  /** Whether the path may be used. */
  ok: boolean;
  /** The absolute path, resolved against the plugin root. */
  path: string;
  /** The path with every symlink resolved, when the path exists. */
  real?: string;
  /** The reason the path was refused, when it was. */
  reason?: string;
}

/**
 * The real path of a path, or `undefined` when it cannot be resolved.
 */
function realPathOrUndefined(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Whether a path is a root itself or lies under it.
 */
function isUnder(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(prefix);
}

/**
 * Resolve a manifest-declared path against the plugin root and refuse it when
 * it leaves the root.
 *
 * The path is refused when it escapes the root **lexically** (`../outside`),
 * and when a **symlink** inside the root points outside it — the second check
 * is made on the `realpath` of the path, so a link cannot smuggle a path out
 * of the root. A path that does not exist is *not* refused here: the caller
 * reports that separately.
 *
 * Implementation choice — see the file header.
 */
export function resolvePluginPath(root: string, declared: string): PluginPathResolution {
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, declared);

  if (!isUnder(rootPath, resolved)) {
    return { ok: false, path: resolved, reason: PLUGIN_PATH_OUTSIDE_ROOT_REASON };
  }

  const real = realPathOrUndefined(resolved);
  if (real === undefined) {
    // The path does not exist; the caller reports that itself.
    return { ok: true, path: resolved };
  }

  const rootReal = realPathOrUndefined(rootPath) ?? rootPath;
  if (!isUnder(rootReal, real)) {
    return { ok: false, path: resolved, reason: PLUGIN_PATH_SYMLINK_OUTSIDE_ROOT_REASON };
  }

  return { ok: true, path: resolved, real };
}

/**
 * Read the paths a manifest value declares.
 *
 * A value may be a single path string or an array of path strings. Anything
 * else is ignored and reported as a problem.
 */
function readPaths(value: unknown, key: string, problems: string[]): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const paths: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        paths.push(entry);
        continue;
      }
      problems.push(`the ${key} value has an entry that is not a path`);
    }
    return paths;
  }
  problems.push(`the ${key} value is not a path`);
  return [];
}

/**
 * Read the command entries a `commands` object declares.
 *
 * An entry carries a `source` (a path) or `content` (an inline command).
 */
function readCommandEntries(value: unknown, problems: string[]): PluginCommandEntry[] {
  const entries: PluginCommandEntry[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isPlainObject(entry)) {
      problems.push(`the commands entry "${key}" is not an object`);
      continue;
    }
    const source = entry['source'];
    const content = entry['content'];
    entries.push({
      key,
      ...(typeof source === 'string' ? { source } : {}),
      ...(typeof content === 'string' ? { content } : {}),
    });
  }
  return entries;
}

/**
 * Read a value out of a manifest.
 *
 * The lookup is an **own-property** check: a manifest is caller-supplied data,
 * so a key that names an inherited member of `Object.prototype` yields
 * `undefined` rather than the inherited member.
 */
function ownValue(document: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(document, key) ? document[key] : undefined;
}

/**
 * Parse a plugin manifest.
 *
 * A manifest that is not a JSON object is broken with the reason *"it is not a
 * JSON object"*.
 */
export function parsePluginManifest(raw: unknown, manifestPath: string): PluginManifestParse {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: PLUGIN_MANIFEST_NOT_AN_OBJECT_REASON };
  }

  const problems: string[] = [];
  // The two records are **null-prototype** objects: a manifest key is
  // caller-supplied data, so a consumer reading `directories['constructor']`
  // must get `undefined` rather than an inherited member of
  // `Object.prototype`.
  const directories = Object.create(null) as Partial<
    Record<PluginDirectoryKey, string[]>
  >;
  const files = Object.create(null) as Partial<Record<PluginFileKey, string[]>>;
  let commands: PluginCommandEntry[] = [];

  const experimental = Object.hasOwn(raw, 'experimental') ? raw['experimental'] : undefined;
  const experimentalBlock = isPlainObject(experimental) ? experimental : undefined;

  for (const key of PLUGIN_DIRECTORY_KEYS) {
    const paths: string[] = [];

    const topLevel = Object.hasOwn(raw, key) ? raw[key] : undefined;
    if (topLevel !== undefined) {
      if (key === 'commands' && isPlainObject(topLevel)) {
        commands = readCommandEntries(topLevel, problems);
      } else {
        paths.push(...readPaths(topLevel, key, problems));
      }
    }

    const experimentalValue =
      experimentalBlock && Object.hasOwn(experimentalBlock, key)
        ? experimentalBlock[key]
        : undefined;
    if (experimentalValue !== undefined) {
      if (key === 'commands' && isPlainObject(experimentalValue)) {
        commands = [...commands, ...readCommandEntries(experimentalValue, problems)];
      } else {
        paths.push(...readPaths(experimentalValue, key, problems));
      }
    }

    if (paths.length > 0) directories[key] = paths;
  }

  for (const key of PLUGIN_FILE_KEYS) {
    const paths: string[] = [];

    const topLevel = Object.hasOwn(raw, key) ? raw[key] : undefined;
    if (topLevel !== undefined) paths.push(...readPaths(topLevel, key, problems));

    const experimentalValue =
      experimentalBlock && Object.hasOwn(experimentalBlock, key)
        ? experimentalBlock[key]
        : undefined;
    if (experimentalValue !== undefined) {
      paths.push(...readPaths(experimentalValue, key, problems));
    }

    if (paths.length > 0) files[key] = paths;
  }

  const name = ownValue(raw, 'name');
  const version = ownValue(raw, 'version');
  const description = ownValue(raw, 'description');

  return {
    ok: true,
    manifest: {
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof version === 'string' ? { version } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      directories,
      files,
      commands,
      manifestPath,
      problems,
    },
  };
}
