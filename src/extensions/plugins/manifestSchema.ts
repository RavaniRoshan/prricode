/**
 * The **plugin manifest schema** — the keys a plugin's `plugin.json` may declare,
 * their types, and their defaults.
 *
 * Evidence: `chunk-c9s0jh80.js:102436` (the schema `BJ`) and its seventeen
 * sub-schemas — `Nh` `:83882`, `zh` `:86833`, `Hh` `:87974`, `Kh` `:88671`,
 * `$h` `:89122`, `rl` `:89828`, `sl` `:90888`, `Vh` `:91378`, `qh` `:95232`,
 * `Jh` `:92057`, `Qh` `:99532`, `al` `:99151`, `sy` `:100819`, `iy` `:101000`,
 * `Xh` `:94690`, `ry` `:100653`, `ay` `:101917` — together with the path shapes
 * at `:80773`–`:81220` and the name rule at `:83337`. The record is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-marketplace.md` §3.
 *
 * ## The twenty-nine keys
 *
 * The target's manifest is **one object schema composed of seventeen
 * sub-schemas**. The keys, with the type each one carries:
 *
 * | Group | Keys |
 * |---|---|
 * | **identity** | `name`, `displayName`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `defaultEnabled`, `dependencies`, `metadata` |
 * | **content** | `hooks`, `commands`, `agents`, `skills`, `outputStyles`, `themes`, `workflows`, `channels`, `mcpServers`, `lspServers`, `monitors`, `settings`, `types`, `userConfig`, `binaries` |
 * | **experimental** | `experimental` |
 *
 * plus `$schema`, which the target's schema declares on its own.
 *
 * ## The defaults
 *
 * Only two of the twenty-nine carry a default the target's own text names:
 *
 * - `defaultEnabled` — **true**;
 * - the catalogue entry's `strict` — **true** (that one lives in
 *   `./catalogue.ts`, because it is the entry's key and not the manifest's).
 *
 * The **`experimental`** block is the target's own: its declared shape is
 * `{themes?, syntaxHighlighting?, monitors?, outputStyles?, evals?}`, and it
 * **passes through** the keys it does not declare.
 *
 * ## The path rule
 *
 * **Every** path a manifest declares is **relative to the plugin root** and
 * **starts with `./`** — the target's path schema is `string().startsWith("./")`.
 * A skill directory may also be `"."`.
 *
 * ## The honest boundary
 *
 * This implementation reads and validates a manifest; it does **not** install
 * one. A manifest whose content is declared is *understood*, not *installed*.
 */

import { isPlainObject } from '../skills/frontmatter.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

/** The group a manifest key belongs to. */
export type PluginManifestKeyGroup = 'identity' | 'content' | 'experimental';

/**
 * One manifest key, with the type the target's schema gives it.
 */
export interface PluginManifestKeySpec {
  /** The key's name, as the manifest spells it. */
  readonly key: string;
  /** The type the target's schema gives the key. */
  readonly type: string;
  /** Whether the key must be present. */
  readonly required: boolean;
  /** The default the target's own text names, when it names one. */
  readonly default?: string;
  /** The group the key belongs to. */
  readonly group: PluginManifestKeyGroup;
}

/**
 * The manifest keys, in the target's own order — the identity group, then the
 * content group, then the experimental one.
 */
export const PLUGIN_MANIFEST_KEY_SPECS: readonly PluginManifestKeySpec[] = Object.freeze([
  { key: '$schema', type: 'string', required: false, group: 'identity' },
  { key: 'name', type: 'string', required: true, group: 'identity' },
  { key: 'displayName', type: 'string', required: false, group: 'identity' },
  { key: 'version', type: 'string', required: false, group: 'identity' },
  { key: 'description', type: 'string', required: false, group: 'identity' },
  { key: 'author', type: 'object', required: false, group: 'identity' },
  { key: 'homepage', type: 'string (a URL)', required: false, group: 'identity' },
  { key: 'repository', type: 'string', required: false, group: 'identity' },
  { key: 'license', type: 'string', required: false, group: 'identity' },
  { key: 'keywords', type: 'string[]', required: false, group: 'identity' },
  {
    key: 'defaultEnabled',
    type: 'boolean',
    required: false,
    default: 'true',
    group: 'identity',
  },
  { key: 'dependencies', type: '(string | {name, marketplace?})[]', required: false, group: 'identity' },
  { key: 'metadata', type: 'object', required: false, group: 'identity' },
  { key: 'hooks', type: 'path | hooks | array', required: false, group: 'content' },
  { key: 'commands', type: 'path | path[] | object', required: false, group: 'content' },
  { key: 'agents', type: 'path | path[]', required: false, group: 'content' },
  { key: 'skills', type: 'path | path[]', required: false, group: 'content' },
  { key: 'outputStyles', type: 'path | path[]', required: false, group: 'content' },
  { key: 'themes', type: 'path | path[]', required: false, group: 'content' },
  { key: 'workflows', type: 'path | path[]', required: false, group: 'content' },
  { key: 'channels', type: 'object[]', required: false, group: 'content' },
  { key: 'mcpServers', type: 'path | object | array', required: false, group: 'content' },
  { key: 'lspServers', type: 'path | object | array', required: false, group: 'content' },
  { key: 'monitors', type: 'path | monitors[]', required: false, group: 'content' },
  { key: 'settings', type: 'object', required: false, group: 'content' },
  { key: 'types', type: 'string (a .d.ts path)', required: false, group: 'content' },
  { key: 'userConfig', type: 'object', required: false, group: 'content' },
  { key: 'binaries', type: 'object', required: false, group: 'content' },
  { key: 'experimental', type: 'object', required: false, group: 'experimental' },
]);

/** The manifest keys, by name. */
export const PLUGIN_MANIFEST_KEYS: readonly string[] = Object.freeze(
  PLUGIN_MANIFEST_KEY_SPECS.map((spec) => spec.key),
);

/**
 * The keys the target's **`experimental`** block declares.
 *
 * The block passes the other keys through.
 */
export const PLUGIN_MANIFEST_EXPERIMENTAL_KEYS: readonly string[] = Object.freeze([
  'themes',
  'syntaxHighlighting',
  'monitors',
  'outputStyles',
  'evals',
]);

/* -------------------------------------------------------------------------- */
/* The validation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The result of validating a plugin manifest.
 */
export interface PluginManifestValidation {
  /** Whether the manifest is one the target's schema accepts. */
  readonly ok: boolean;
  /** The problems the manifest carries, in the order they were found. */
  readonly problems: string[];
  /** The keys the manifest declares that the schema does not. */
  readonly unknownKeys: readonly string[];
}

/** The reason a manifest that is not an object is refused. */
export const PLUGIN_MANIFEST_NOT_AN_OBJECT_REASON = 'it is not a JSON object';

/**
 * The reason a plugin name that carries a space is refused.
 *
 * The target's own wording.
 */
export const PLUGIN_NAME_HAS_SPACE_REASON =
  'Plugin name cannot contain spaces. Use kebab-case (e.g., "my-plugin")';

/**
 * The reason an empty plugin name is refused.
 *
 * The target's own wording.
 */
export const PLUGIN_NAME_EMPTY_REASON = 'Plugin name cannot be empty';

/**
 * The reason a plugin name that carries a control or a bidirectional-formatting
 * character is refused.
 *
 * The target's own wording.
 */
export const PLUGIN_NAME_HAS_CONTROL_REASON =
  'Plugin name cannot contain control or bidirectional-formatting characters';

/** The control and bidirectional-formatting characters the target refuses. */
const CONTROL_OR_BIDI = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * Read a value out of an object.
 *
 * The lookup is an **own-property** check: a manifest is caller-supplied data,
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

/** Whether a value is a string or an array of strings. */
function isStringOrStringArray(value: unknown): boolean {
  return isString(value) || isStringArray(value);
}

/**
 * The type check of each manifest key.
 *
 * The checks are the target's own shapes, at the level the target's schema
 * states them.
 */
const KEY_CHECKS: Readonly<Record<string, (value: unknown) => boolean>> = {
  '$schema': isString,
  name: isString,
  displayName: isString,
  version: isString,
  description: isString,
  author: (value) => isPlainObject(value) && isString(ownValue(value, 'name')),
  homepage: isString,
  repository: isString,
  license: isString,
  keywords: isStringArray,
  defaultEnabled: (value) => typeof value === 'boolean',
  dependencies: (value) =>
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isString(entry) ||
        (isPlainObject(entry) && isString(ownValue(entry, 'name'))),
    ),
  metadata: (value) => isPlainObject(value),
  hooks: (value) => isStringOrStringArray(value) || isPlainObject(value),
  commands: (value) => isStringOrStringArray(value) || isPlainObject(value),
  agents: isStringOrStringArray,
  skills: isStringOrStringArray,
  outputStyles: isStringOrStringArray,
  themes: isStringOrStringArray,
  workflows: isStringOrStringArray,
  channels: (value) => Array.isArray(value) && value.every((entry) => isPlainObject(entry)),
  mcpServers: (value) => isStringOrStringArray(value) || isPlainObject(value),
  lspServers: (value) => isStringOrStringArray(value) || isPlainObject(value),
  monitors: (value) => isString(value) || Array.isArray(value),
  settings: (value) => isPlainObject(value),
  types: isString,
  userConfig: (value) => isPlainObject(value),
  binaries: (value) => isPlainObject(value),
  experimental: (value) => isPlainObject(value),
};

/**
 * Validate a plugin manifest against the target's schema.
 *
 * The manifest is **not** a JSON object → the manifest is refused with the
 * target's own reason. A key the schema does not declare → the key is refused
 * and **named**. A key whose type is wrong → the key is refused and **named**.
 */
export function validatePluginManifest(raw: unknown): PluginManifestValidation {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      problems: [PLUGIN_MANIFEST_NOT_AN_OBJECT_REASON],
      unknownKeys: [],
    };
  }

  const problems: string[] = [];
  const unknownKeys: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!PLUGIN_MANIFEST_KEYS.includes(key)) {
      unknownKeys.push(key);
      problems.push(`the key "${key}" is not one the plugin manifest declares`);
    }
  }

  const name = ownValue(raw, 'name');
  if (name === undefined) {
    problems.push(`the plugin manifest has no "name"`);
  } else if (!isString(name)) {
    problems.push(`the "name" is not a string`);
  } else if (name.length === 0) {
    problems.push(PLUGIN_NAME_EMPTY_REASON);
  } else if (name.includes(' ')) {
    problems.push(PLUGIN_NAME_HAS_SPACE_REASON);
  } else if (CONTROL_OR_BIDI.test(name)) {
    problems.push(PLUGIN_NAME_HAS_CONTROL_REASON);
  }

  for (const spec of PLUGIN_MANIFEST_KEY_SPECS) {
    if (spec.key === 'name') continue;
    const value = ownValue(raw, spec.key);
    if (value === undefined) continue;
    const check = KEY_CHECKS[spec.key];
    if (check === undefined) continue;
    if (!check(value)) {
      problems.push(`the "${spec.key}" is not ${spec.type}`);
    }
  }

  return { ok: problems.length === 0, problems, unknownKeys };
}

/**
 * The default value of a manifest key, when the target names one.
 */
export function pluginManifestDefault(key: string): string | undefined {
  const spec = PLUGIN_MANIFEST_KEY_SPECS.find((entry) => entry.key === key);
  return spec?.default;
}
