/**
 * Scope separation for settings.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.7.
 *
 * The target deliberately scopes several capabilities to a single tier or to an
 * explicit union of tiers:
 *
 *   - `spellcheck` is **user settings only**; a spellcheck block in project or local
 *     settings is ignored and the product tells the user to set it in user settings.
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
 *
 * Implementation choices (the audit does not pin them):
 *
 *   - The audit does not say which of the two boolean flags uses which union, so the
 *     mapping below is a reimplementation decision. The *shape* — an explicit union of sources,
 *     and one union that is policy+user only — is observed.
 *   - `me(source)` returns the personal scope a source contributes, or `null` when
 *     the source has no personal scope (policy and flag settings) or is suppressed by
 *     the "restrict personal config" restriction. `isSuppressed` answers the separate
 *     question "is this source suppressed right now?".
 */

import {
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
 * `D_` — source enumeration order.
 */
export const SOURCE_ENUMERATION_ORDER: readonly SettingsSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
];

/** The scope map the target pairs with `D_`. */
export const SCOPE_BY_SOURCE: Readonly<Record<'userSettings' | 'projectSettings' | 'localSettings', SettingsScope>> =
  {
    userSettings: 'user',
    projectSettings: 'project',
    localSettings: 'local',
  };

/** The sources that carry a personal scope. */
export const PERSONAL_SOURCES: readonly SettingsSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
];

/**
 * The scope of a source, ignoring the restriction. Policy and flag settings have no
 * personal scope and therefore report `null`.
 */
export function scopeFor(source: SettingsSource): SettingsScope | null {
  switch (source) {
    case 'userSettings':
      return 'user';
    case 'projectSettings':
      return 'project';
    case 'localSettings':
      return 'local';
    default:
      return null;
  }
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
  const document = documentOf(tiers.get(source), source);
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
 */
export function readPerTier(tiers: SettingsTierMap, key: string): SettingsTier[] {
  const found: SettingsTier[] = [];
  for (const source of TIER_PRECEDENCE) {
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
 */
export function readBooleanFlag(
  tiers: SettingsTierMap,
  key: string,
  sources?: readonly SettingsSource[],
): SettingsTier | undefined {
  const union = sources ?? BOOLEAN_FLAG_SOURCE_SETS[key] ?? BOOLEAN_FLAG_SOURCES;
  return readFromSources(tiers, key, union)[0];
}
