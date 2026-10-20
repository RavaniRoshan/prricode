/**
 * The skill override modes and the resolution that picks one.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("The skill
 * override resolution is observed") and `docs/compatibility/extension-surface.md`
 * ("The override modes").
 *
 * ## The four modes
 *
 * ```
 * on                  fully enabled
 * name-only           mentioned by name only, not auto-invoked
 * user-invocable-only only the user can invoke it
 * off                 disabled
 * ```
 *
 * ## The resolution order
 *
 * "The override for a skill is resolved by searching, in order: the **merged
 * settings** `skillOverrides`, then the **session's** `skillOverrides`, and
 * then the `skillOverrides` of the `policySettings` and `flagSettings` tiers.
 * The first source that defines the skill wins."
 *
 * The merged settings are the **merged** keys of the settings tier model, so
 * they resolve through `MERGED_KEY_ORDER` (`localSettings`, `projectSettings`,
 * `userSettings`, highest first) — the plan's Step 6 names that constant
 * explicitly, and `src/config/tiers.ts` owns it.
 *
 * ## The session store
 *
 * "A per-session store holds `{ read, brought, skillOverrides }`: `read` is
 * whether the skills have been read, `brought` is the set of skills that were
 * brought in, and `skillOverrides` is the session's own overrides."
 *
 * ## Implementation choices (the audit does not pin them)
 *
 *   - An override whose value is **not one of the four modes** is treated as
 *     *undefined*, so the next source in the order is consulted. The audit
 *     says the lookup is null-safe, and a value this implementation cannot interpret is
 *     as good as absent.
 *   - The session's own override map is a **null-prototype object**, so a skill
 *     named `__proto__` can never reach `Object.prototype` through it. The
 *     target "guards against `__proto__` as a skill name", and this implementation refuses
 *     the name outright: `setOverride('__proto__', …)` throws.
 */

import {
  MERGED_KEY_ORDER,
  documentOf,
  mergeMergedSettings,
  type SettingsTierMap,
} from '../../config/tiers.js';

import { isPlainObject } from './frontmatter.js';
import { isSafeLookupName } from './source.js';

/**
 * The four override modes, exactly.
 */
export const SKILL_OVERRIDE_MODES = ['on', 'name-only', 'user-invocable-only', 'off'] as const;

/** One of the four override modes. */
export type SkillOverrideMode = (typeof SKILL_OVERRIDE_MODES)[number];

const MODE_SET: ReadonlySet<string> = new Set<string>(SKILL_OVERRIDE_MODES);

/** Whether a value is one of the four override modes. */
export function isSkillOverrideMode(value: unknown): value is SkillOverrideMode {
  return typeof value === 'string' && MODE_SET.has(value);
}

/**
 * An override this implementation refuses to store.
 *
 * The target guards against `__proto__` as a skill name, so this implementation refuses
 * it loudly rather than storing a key that would reach a prototype.
 */
export class SkillOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillOverrideError';
  }
}

/**
 * The per-session skill store.
 *
 * `read` is whether the skills have been read, `brought` is the set of skills
 * that were brought in, and `skillOverrides` is the session's own overrides.
 */
export interface SkillSessionStore {
  /** Whether the skills have been read. */
  read: boolean;
  /** The skills that were brought into the session. */
  brought: Set<string>;
  /** The session's own overrides. */
  skillOverrides: Record<string, SkillOverrideMode>;
  /** Mark the skills as read. */
  markRead(): void;
  /** Record that a skill was brought into the session. */
  bring(name: string): void;
  /** Record the session's own override for a skill. */
  setOverride(name: string, mode: SkillOverrideMode): void;
}

/** The initial state of a session store. */
export interface SkillSessionState {
  read?: boolean;
  brought?: Iterable<string>;
  skillOverrides?: Record<string, SkillOverrideMode>;
}

/**
 * Create a per-session skill store.
 *
 * The override map is a **null-prototype** object: a skill name is
 * caller-supplied data, so it can never reach an inherited member of
 * `Object.prototype` through the map.
 */
export function createSkillSessionStore(state: SkillSessionState = {}): SkillSessionStore {
  const overrides = Object.create(null) as Record<string, SkillOverrideMode>;
  for (const [name, mode] of Object.entries(state.skillOverrides ?? {})) {
    if (!isSafeLookupName(name)) continue;
    if (!isSkillOverrideMode(mode)) continue;
    overrides[name] = mode;
  }

  const brought = new Set<string>(state.brought ?? []);

  const store: SkillSessionStore = {
    read: state.read ?? false,
    brought,
    skillOverrides: overrides,
    markRead(): void {
      store.read = true;
    },
    bring(name: string): void {
      brought.add(name);
    },
    setOverride(name: string, mode: SkillOverrideMode): void {
      if (!isSafeLookupName(name)) {
        throw new SkillOverrideError(`"${name}" is not a skill name.`);
      }
      if (!isSkillOverrideMode(mode)) {
        throw new SkillOverrideError(`"${String(mode)}" is not a skill override mode.`);
      }
      overrides[name] = mode;
    },
  };

  return store;
}

/**
 * Whether a skill may be invoked, and whether the session may invoke it on its
 * own.
 *
 * Implementation choice (the audit gives the modes' meanings but not a machine-readable
 * form of them):
 *
 * | Mode | Invocable | Auto-invocable |
 * |---|---|---|
 * | `on` | yes | yes |
 * | `name-only` | no — it is mentioned by name only | no |
 * | `user-invocable-only` | yes — by the user | no |
 * | `off` | no | no |
 */
export interface SkillInvocability {
  /** Whether the skill may be invoked at all. */
  invocable: boolean;
  /** Whether the session may invoke it without the user asking. */
  autoInvocable: boolean;
}

/** The invocability a mode implies. */
export function skillInvocability(mode: SkillOverrideMode): SkillInvocability {
  switch (mode) {
    case 'on':
      return { invocable: true, autoInvocable: true };
    case 'name-only':
      return { invocable: false, autoInvocable: false };
    case 'user-invocable-only':
      return { invocable: true, autoInvocable: false };
    case 'off':
      return { invocable: false, autoInvocable: false };
  }
}

/**
 * The context the override resolution runs in.
 */
export interface SkillOverrideContext {
  /** The settings tiers. */
  tiers?: SettingsTierMap;
  /** The session's own store. */
  session?: SkillSessionStore;
  /**
   * The merged settings document.
   *
   * When the caller does not supply one, it is computed from the tiers through
   * `MERGED_KEY_ORDER`.
   */
  mergedSettings?: Record<string, unknown>;
}

/**
 * Read an override for a skill out of a map of overrides.
 *
 * The lookup is an **own-property** check: a skill name is caller-supplied
 * data, so it never resolves an inherited member of `Object.prototype`.
 */
function modeFromMap(map: unknown, name: string): SkillOverrideMode | undefined {
  if (!isPlainObject(map)) return undefined;
  if (!Object.hasOwn(map, name)) return undefined;
  const mode = map[name];
  return isSkillOverrideMode(mode) ? mode : undefined;
}

/**
 * Read an override for a skill out of a settings **document**.
 *
 * The document's `skillOverrides` block is read with an own-property check, so
 * a document that carries no `skillOverrides` block yields no override.
 */
function modeFromDocument(document: unknown, name: string): SkillOverrideMode | undefined {
  if (!isPlainObject(document)) return undefined;
  if (!Object.hasOwn(document, 'skillOverrides')) return undefined;
  return modeFromMap(document['skillOverrides'], name);
}

/**
 * The merged settings document for a tier map.
 *
 * The merged keys resolve through `MERGED_KEY_ORDER`, so a local tier beats a
 * project tier, which beats a user tier — per **leaf**, so two tiers that each
 * define a different skill both survive.
 */
export function mergedSkillSettings(tiers: SettingsTierMap): Record<string, unknown> {
  return mergeMergedSettings(tiers);
}

/**
 * Resolve the override for a skill.
 *
 * The sources are searched in the target's order — the **merged settings**, then
 * the **session**, then the `policySettings` tier and the `flagSettings` tier —
 * and the first source that defines the skill wins. A lookup that finds
 * nothing yields no override rather than throwing.
 */
export function resolveSkillOverrideMode(
  name: string,
  context: SkillOverrideContext = {},
): SkillOverrideMode | undefined {
  if (!isSafeLookupName(name)) return undefined;

  const merged =
    context.mergedSettings ??
    (context.tiers ? mergedSkillSettings(context.tiers) : undefined);

  const fromMerged = modeFromDocument(merged, name);
  if (fromMerged !== undefined) return fromMerged;

  const fromSession = modeFromMap(context.session?.skillOverrides, name);
  if (fromSession !== undefined) return fromSession;

  const tiers = context.tiers;
  if (tiers) {
    const fromPolicy = modeFromDocument(documentOf(tiers.get('policySettings')), name);
    if (fromPolicy !== undefined) return fromPolicy;

    const fromFlags = modeFromDocument(documentOf(tiers.get('flagSettings')), name);
    if (fromFlags !== undefined) return fromFlags;
  }

  return undefined;
}

/**
 * The merged-key order the override resolution uses.
 *
 * Re-exported so a consumer of the extension surface does not have to reach
 * into the configuration module for it.
 */
export { MERGED_KEY_ORDER };
