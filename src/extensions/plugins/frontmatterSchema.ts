/**
 * The **frontmatter schemas** — the keys a skill, an agent and an output style may
 * declare in their frontmatter, their types, and their defaults.
 *
 * Evidence: `chunk-4jsg44k7.js:724143` (the skill base `fbo`), `:725756` (the
 * skill `pbo`), `:728221` (the agent `cBe`), `:730964` (the output style `mbo`),
 * `:731474` (the three schemas `gbo`), `:724072` (the type shorthands `uBe`,
 * `Nm`, `uP`, `EI`), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-marketplace.md` §4.
 *
 * ## The three schemas
 *
 * The target parses three kinds of frontmatter, and **all three are strict** —
 * a key the schema does not declare is an **error**, which the target reports
 * and moves past:
 *
 * | The file | The keys |
 * |---|---|
 * | a **skill** (`SKILL.md`) | **42** |
 * | an **agent** (`agents/*.md`) | **22** |
 * | an **output style** (`output-styles/*.md`) | **4** |
 *
 * ## The types
 *
 * The target has three shorthands for the value types:
 *
 * - the **scalar** — `string | number | boolean | null`;
 * - the **list** — the scalar, or an array of strings;
 * - the **free** — any value.
 *
 * ## The defaults
 *
 * - a skill's `name` — the file's name, without its extension;
 * - a skill's `shell` — **bash**, on every platform;
 * - an agent's `observeSubagents` — **true**;
 * - an output style's `name` — the file's name.
 *
 * The other defaults the target's descriptions name — the `autoCompactWindow`
 * bounds, the `memory` scope, the `isolation` value — are values the target
 * names in prose rather than defaults the schema applies, and they are
 * recorded in the key list below.
 *
 * ## The two lists that are **not** the schema
 *
 * The target keeps two other lists of frontmatter keys:
 *
 * - the **62-key** normalisation list (`chunk-gdvkvrkd.js:4198`), used to fold
 *   a key for telemetry;
 * - the **42-key** skill declared-field list (`chunk-081t8575.js:100908`), used
 *   for the same telemetry.
 *
 * Both are **supersets** of the schema keys and carry keys no schema declares
 * — `type`, `originSessionId`, `evals`, `compatibility`,
 * `hide-from-slash-command-tool` — so they are **not** the schema, and a
 * frontmatter that carries one of them is refused by the schema and not by the
 * telemetry list.
 */

import { isPlainObject } from '../skills/frontmatter.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

/** The kinds of frontmatter the target parses. */
export const FRONTMATTER_KINDS = ['skill', 'agent', 'output-style'] as const;

/** One of the kinds of frontmatter the target parses. */
export type FrontmatterKind = (typeof FRONTMATTER_KINDS)[number];

/**
 * The value types the target's frontmatter schemas use.
 */
export type FrontmatterValueType =
  | 'scalar'
  | 'list'
  | 'free'
  | 'inline-or-fork'
  | 'number';

/**
 * One frontmatter key, with the type the target's schema gives it.
 */
export interface FrontmatterKeySpec {
  /** The key's name, as the frontmatter spells it. */
  readonly key: string;
  /** The type the target's schema gives the key. */
  readonly type: FrontmatterValueType;
  /** Whether the key must be present. */
  readonly required: boolean;
  /** The default the target's own text names, when it names one. */
  readonly default?: string;
}

/**
 * The keys a skill's frontmatter may declare — **42**.
 *
 * The first thirteen are the target's base schema; the rest extend it.
 */
export const SKILL_FRONTMATTER_KEYS: readonly FrontmatterKeySpec[] = Object.freeze([
  { key: 'name', type: 'scalar', required: false, default: 'the file name, without its extension' },
  { key: 'description', type: 'scalar', required: false },
  { key: 'model', type: 'scalar', required: false },
  { key: 'allowed-tools', type: 'list', required: false },
  { key: 'disallowed-tools', type: 'list', required: false },
  { key: 'disallowedTools', type: 'list', required: false },
  { key: 'argument-hint', type: 'scalar', required: false },
  { key: 'arguments', type: 'list', required: false },
  { key: 'disable-model-invocation', type: 'scalar', required: false },
  { key: 'user-invocable', type: 'scalar', required: false },
  { key: 'effort', type: 'scalar', required: false },
  { key: 'shell', type: 'scalar', required: false, default: 'bash' },
  { key: 'version', type: 'scalar', required: false },
  { key: 'when_to_use', type: 'scalar', required: false },
  { key: 'paths', type: 'list', required: false },
  { key: 'hooks', type: 'free', required: false },
  { key: 'context', type: 'inline-or-fork', required: false },
  { key: 'agent', type: 'scalar', required: false },
  { key: 'background', type: 'scalar', required: false },
  { key: 'fallback', type: 'scalar', required: false },
  { key: 'created_by', type: 'scalar', required: false },
  { key: 'improved_by', type: 'scalar', required: false },
  { key: 'mcpServers', type: 'free', required: false },
  { key: 'lspServers', type: 'free', required: false },
  { key: 'agents', type: 'free', required: false },
  { key: 'outputStyles', type: 'free', required: false },
  { key: 'themes', type: 'free', required: false },
  { key: 'workflows', type: 'free', required: false },
  { key: 'channels', type: 'free', required: false },
  { key: 'monitors', type: 'free', required: false },
  { key: 'settings', type: 'free', required: false },
  { key: 'userConfig', type: 'free', required: false },
  { key: 'defaultEnabled', type: 'free', required: false },
  { key: 'experimental', type: 'free', required: false },
  { key: 'dependencies', type: 'free', required: false },
  { key: 'metadata', type: 'free', required: false },
  { key: 'displayName', type: 'free', required: false },
  { key: 'author', type: 'free', required: false },
  { key: 'homepage', type: 'free', required: false },
  { key: 'repository', type: 'free', required: false },
  { key: 'license', type: 'free', required: false },
  { key: 'keywords', type: 'free', required: false },
]);

/**
 * The keys an agent's frontmatter may declare — **22**.
 */
export const AGENT_FRONTMATTER_KEYS: readonly FrontmatterKeySpec[] = Object.freeze([
  { key: 'name', type: 'scalar', required: true },
  { key: 'description', type: 'scalar', required: true },
  { key: 'model', type: 'scalar', required: false },
  { key: 'tools', type: 'list', required: false },
  { key: 'disallowedTools', type: 'list', required: false },
  { key: 'color', type: 'scalar', required: false },
  { key: 'effort', type: 'scalar', required: false },
  { key: 'permissionMode', type: 'scalar', required: false },
  { key: 'mcpServers', type: 'free', required: false },
  { key: 'hooks', type: 'free', required: false },
  { key: 'maxTurns', type: 'number', required: false },
  { key: 'autoCompactWindow', type: 'number', required: false },
  { key: 'skills', type: 'list', required: false },
  { key: 'initialPrompt', type: 'scalar', required: false },
  { key: 'memory', type: 'scalar', required: false },
  { key: 'background', type: 'scalar', required: false },
  { key: 'omitClaudeMd', type: 'scalar', required: false },
  { key: 'isolation', type: 'scalar', required: false },
  { key: 'observer', type: 'scalar', required: false },
  { key: 'observerMessage', type: 'scalar', required: false },
  { key: 'observeSubagents', type: 'scalar', required: false, default: 'true' },
  { key: 'experimental', type: 'free', required: false },
]);

/**
 * The keys an output style's frontmatter may declare — **4**.
 */
export const OUTPUT_STYLE_FRONTMATTER_KEYS: readonly FrontmatterKeySpec[] = Object.freeze([
  { key: 'name', type: 'scalar', required: false, default: 'the file name' },
  { key: 'description', type: 'scalar', required: false },
  { key: 'keep-coding-instructions', type: 'scalar', required: false },
  { key: 'force-for-plugin', type: 'scalar', required: false },
]);

/** The key list of each kind of frontmatter. */
export const FRONTMATTER_KEY_SPECS: Readonly<Record<FrontmatterKind, readonly FrontmatterKeySpec[]>> =
  Object.freeze({
    skill: SKILL_FRONTMATTER_KEYS,
    agent: AGENT_FRONTMATTER_KEYS,
    'output-style': OUTPUT_STYLE_FRONTMATTER_KEYS,
  });

/* -------------------------------------------------------------------------- */
/* The validation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The result of validating a frontmatter.
 */
export interface FrontmatterValidation {
  /** Whether the frontmatter is one the target's schema accepts. */
  readonly ok: boolean;
  /** The problems the frontmatter carries. */
  readonly problems: string[];
  /** The keys the frontmatter declares that the schema does not. */
  readonly unknownKeys: readonly string[];
}

/** Whether a value is a scalar — the target's `string | number | boolean | null`. */
function isScalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  );
}

/** Whether a value is the target's list — a scalar, or an array of strings. */
function isList(value: unknown): boolean {
  if (isScalar(value)) return true;
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Validate a frontmatter against the target's schema for its kind.
 *
 * The schema is **strict**: a key it does not declare is an error, and the
 * target reports it and moves past — so the frontmatter is **not** discarded,
 * only the unknown key is named.
 */
export function validateFrontmatter(
  kind: FrontmatterKind,
  raw: unknown,
): FrontmatterValidation {
  const specs = FRONTMATTER_KEY_SPECS[kind];
  const problems: string[] = [];
  const unknownKeys: string[] = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      problems: ['the frontmatter is not a table'],
      unknownKeys: [],
    };
  }

  for (const key of Object.keys(raw)) {
    if (!specs.some((spec) => spec.key === key)) {
      unknownKeys.push(key);
      problems.push(`the key "${key}" is not one the ${kind} frontmatter declares`);
    }
  }

  for (const spec of specs) {
    const value = Object.hasOwn(raw, spec.key) ? raw[spec.key] : undefined;
    if (value === undefined) {
      if (spec.required) problems.push(`the ${kind} frontmatter has no "${spec.key}"`);
      continue;
    }
    if (spec.type === 'scalar' && !isScalar(value)) {
      problems.push(`the "${spec.key}" is not a string, a number, a boolean or null`);
      continue;
    }
    if (spec.type === 'list' && !isList(value)) {
      problems.push(`the "${spec.key}" is not a string, a number, a boolean, null or a list of strings`);
      continue;
    }
    if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      problems.push(`the "${spec.key}" is not a number`);
      continue;
    }
    if (spec.type === 'inline-or-fork' && value !== null && value !== 'inline' && value !== 'fork') {
      problems.push(`the "${spec.key}" is neither inline nor fork`);
    }
  }

  return { ok: problems.length === 0, problems, unknownKeys };
}

/**
 * The default value of a frontmatter key, when the target names one.
 */
export function frontmatterDefault(
  kind: FrontmatterKind,
  key: string,
): string | undefined {
  return FRONTMATTER_KEY_SPECS[kind].find((spec) => spec.key === key)?.default;
}
