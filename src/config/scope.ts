/**
 * Scope separation for settings.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.7.
 *
 * The target deliberately scopes several capabilities to a single tier or to an
 * explicit union of tiers:
 *
 *   - `spellcheck` is **user settings only**; a spellcheck block in project or local
 *     settings is ignored and the product tells the user to set it in user settings
 *     ("a spellcheck block in project or local settings is ignored, whatever else is
 *     configured; set it in your user settings instead").
 *   - `otelHeadersHelper`, `apiKeyHelper` and `autoMemoryDirectory` are read **per
 *     tier** and reported together with the tier that supplied them.
 *   - Boolean flags such as `skipDangerousModePermissionPrompt` and
 *     `skipWorkflowUsageWarning` are read from an **explicit union** of sources; the
 *     audit records one union as "user, local, flag, and policy" and one variant that
 *     deliberately reads only `policySettings` and `userSettings`.
 *
 * The target's source enumeration order is `D_` =
 * ["userSettings", "projectSettings", "localSettings"], with the scope map
 * `{userSettings: "user", projectSettings: "project", localSettings: "local"}`.
 * `SCOPE_BY_SOURCE` is the single source of truth for that map: `scopeFor` reads it
 * rather than duplicating the mapping.
 *
 * Implementation choices (the audit does not pin them):
 *
 *   - The audit does not say which of the two boolean flags uses which union, so the
 *     mapping below is a reimplementation decision. The *shape* — an explicit union of sources,
 *     and one union that is policy+user only — is observed.
 *   - A union is a *membership* set; the winner inside it is the highest precedence
 *     member, not the first one listed. The audit lists the union in ascending
 *     precedence, so this implementation reads it highest-first.
 */

import {
  KEY_SCOPE_RESTRICTIONS,
  PROJECT_SIDE_SOURCES,
  TIER_PRECEDENCE,
  documentOf,
  type SettingsSource,
  type SettingsTier,
  type SettingsTierMap,
} from './tiers.js';

/** The personal scopes the target maps its sources onto. */
export type SettingsScope = 'user' | 'project' | 'local';

/**
 * `D_` — the source enumeration order, as observed in the target.
 */
export const SOURCE_ENUMERATION_ORDER: readonly SettingsSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
];

/**
 * The scope map the target pairs with `D_`. This is the single source of truth for
 * the mapping: `scopeFor` reads it.
 */
export const SCOPE_BY_SOURCE: Readonly<
  Record<'userSettings' | 'projectSettings' | 'localSettings', SettingsScope>
> = {
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'local',
};

/**
 * The scope of a source, ignoring the restriction. Policy and flag settings have no
 * personal scope and therefore report `null`.
 */
export function scopeFor(source: SettingsSource): SettingsScope | null {
  if (source === 'policySettings' || source === 'flagSettings') return null;
  return SCOPE_BY_SOURCE[source];
}

/**
 * The scope a source contributes right now.
 *
 * Returns `null` for the project-side sources when personal configuration is
 * restricted — that is exactly the set the target suppresses.
 */
export function me(source: SettingsSource, restricted: boolean): SettingsScope | null {
  if (isSuppressed(source, restricted)) return null;
  return scopeFor(source);
}

/** Whether the "restrict personal config" restriction suppresses a source. */
export function isSuppressed(source: SettingsSource, restricted: boolean): boolean {
  return restricted && PROJECT_SIDE_SOURCES.includes(source);
}

function lookupKey(tiers: SettingsTierMap, source: SettingsSource, key: string): SettingsTier | undefined {
  if (!tiers.has(source)) return undefined;
  const document = documentOf(tiers.get(source));
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
  const record = document as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return { source, value: record[key] };
}

/**
 * Read a key that is scoped to **user settings only** (for example `spellcheck`).
 * A project or local definition of the same key is ignored, exactly as the target
 * ignores a spellcheck block in project or local settings.
 */
export function readUserOnly(tiers: SettingsTierMap, key: string): SettingsTier | undefined {
  return lookupKey(tiers, 'userSettings', key);
}

/**
 * Read a key **per tier** and report the tier that supplied it.
 *
 * Used for `otelHeadersHelper`, `apiKeyHelper` and `autoMemoryDirectory`, which the
 * target reads per tier. The result is ordered highest precedence first.
 *
 * A key with an observed scope restriction (`spellcheck`) only reports the tiers the
 * restriction allows, so this agrees with `resolveBlock`.
 */
export function readPerTier(tiers: SettingsTierMap, key: string): SettingsTier[] {
  const allowed = KEY_SCOPE_RESTRICTIONS[key];
  const found: SettingsTier[] = [];
  for (const source of TIER_PRECEDENCE) {
    if (allowed && !allowed.includes(source)) continue;
    const tier = lookupKey(tiers, source, key);
    if (tier) found.push(tier);
  }
  return found;
}

/**
 * Read a key from an explicit union of sources. The union is a *membership* set; the
 * winner inside the set is the highest precedence source, not the first listed.
 */
export function readFromSources(
  tiers: SettingsTierMap,
  key: string,
  sources: readonly SettingsSource[],
): SettingsTier[] {
  const members = new Set<SettingsSource>(sources);
  return readPerTier(tiers, key).filter((tier) => members.has(tier.source));
}

/**
 * The explicit source union for a boolean flag such as `skipWorkflowUsageWarning`.
 * The audit records the union as "user, local, flag, and policy".
 */
export const BOOLEAN_FLAG_SOURCES: readonly SettingsSource[] = [
  'userSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
];

/**
 * The explicit source union for a boolean flag that the target deliberately limits to
 * the machine policy and the user's own settings.
 */
export const POLICY_AND_USER_SOURCES: readonly SettingsSource[] = ['policySettings', 'userSettings'];

/**
 * Which union each observed boolean flag is read from.
 *
 * The audit observes both unions but not their assignment to a particular flag, so
 * the assignment below is a reimplementation decision.
 */
export const BOOLEAN_FLAG_SOURCE_SETS: Readonly<Record<string, readonly SettingsSource[]>> = {
  skipWorkflowUsageWarning: BOOLEAN_FLAG_SOURCES,
  skipDangerousModePermissionPrompt: POLICY_AND_USER_SOURCES,
};

/**
 * Read a boolean flag from its explicit source union and report the tier that
 * supplied the value.
 *
 * The union must be explicit: either the caller passes one, or the key is registered
 * in `BOOLEAN_FLAG_SOURCE_SETS`. A key with no registered union is an error rather
 * than a silent widening to the general union — a flag that the target reads from
 * the policy and the user settings only must never pick up a local or flag value.
 */
export function readBooleanFlag(
  tiers: SettingsTierMap,
  key: string,
  sources?: readonly SettingsSource[],
): SettingsTier | undefined {
  const union = sources ?? BOOLEAN_FLAG_SOURCE_SETS[key];
  if (!union) {
    throw new Error(
      `no explicit source union for the boolean flag "${key}"; pass one or register it in BOOLEAN_FLAG_SOURCE_SETS`,
    );
  }
  return readFromSources(tiers, key, union)[0];
}
