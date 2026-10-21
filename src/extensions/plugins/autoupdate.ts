/**
 * The **plugin autoupdater** — the outcomes it reports, the reasons it defers,
 * and the failure codes it carries.
 *
 * Evidence: `chunk-wqmf3c8h.js:2646` (the classification `M`), `:4864` (the
 * pass `_Gr`), `:6125` (the command-source refresh `x`), `:8698` (the pass
 * itself), `chunk-4420d0hq.js:102585` (the update operation `dtt`), `:8161`
 * (the failure-code map `Zn`), `chunk-p9jh4s48.js:25526` (the entry-helper
 * codes `Jwo`), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-marketplace.md` §6.
 *
 * ## The two vocabularies
 *
 * The **update operation** reports one of four outcomes — `updated`,
 * `up_to_date`, `skipped`, `failed` — and the **autoupdater** maps those onto
 * its own vocabulary, which is richer:
 *
 * | The operation | The autoupdater |
 * |---|---|
 * | `updated` | the plugin id |
 * | `up_to_date` | nothing |
 * | `skipped` + `entry_helper_deferred` | a **deferred** block |
 * | `skipped` + a pinner | a **blocked-by-pinner** block |
 * | `failed` + a policy code | a **disabled-by-policy** block |
 * | `failed` + anything else | **failed** |
 *
 * ## The block types
 *
 * ```
 * autoupdate-deferred-entry-helper · autoupdate-blocked-by-pinner ·
 * autoupdate-disabled-by-policy · generic-error
 * ```
 *
 * The **blocked-by-pinner** block carries the version the plugin is **held at**,
 * the plugins that **pin** it, and the pins that are **disabled** — a disabled
 * pin does not hold the update back.
 *
 * ## The skip reasons — three
 *
 * ```
 * pinner_blocked · entry_helper_deferred · snapshot_file_refused
 * ```
 *
 * The target's own tree carries other `skipReason` values — `bare_repo`,
 * `git_error`, `not_git`, `too_large` and the rest — but they belong to the
 * **checkpoint** surface, not to plugins.
 *
 * ## The honest boundary
 *
 * This implementation has **no plugin registry**, so it never updates a
 * plugin. What it reproduces is the **protocol**: the outcomes, the reasons and
 * the codes, and the classification the target applies to them.
 */

import { isPlainObject } from '../skills/frontmatter.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The outcomes the **update operation** reports.
 */
export const PLUGIN_UPDATE_OUTCOMES = ['updated', 'up_to_date', 'skipped', 'failed'] as const;

/** One of the update operation's outcomes. */
export type PluginUpdateOutcome = (typeof PLUGIN_UPDATE_OUTCOMES)[number];

/**
 * The block types the **autoupdater** reports.
 */
export const AUTOUPDATE_BLOCK_TYPES = [
  'autoupdate-deferred-entry-helper',
  'autoupdate-blocked-by-pinner',
  'autoupdate-disabled-by-policy',
  'generic-error',
] as const;

/** One of the autoupdater's block types. */
export type AutoupdateBlockType = (typeof AUTOUPDATE_BLOCK_TYPES)[number];

/**
 * The reasons the update operation **skips** an update.
 */
export const AUTOUPDATE_SKIP_REASONS = [
  'pinner_blocked',
  'entry_helper_deferred',
  'snapshot_file_refused',
] as const;

/** One of the skip reasons. */
export type AutoupdateSkipReason = (typeof AUTOUPDATE_SKIP_REASONS)[number];

/**
 * The failure codes the **plugin surface** raises.
 *
 * The list is the target's own: the codes its failure-code map carries, the
 * entry-helper codes, and the ones a tree-wide scan finds the plugin surface
 * raising.
 */
export const AUTOUPDATE_FAILURE_CODES = [
  'already_in_goal_state',
  'ambiguous_marketplace',
  'builtin',
  'claudeai_identity_changed',
  'command_source_inactive',
  'command_source_refused',
  'command_source_skipped',
  'dependencies_not_installed',
  'dependencies_not_screened',
  'dependency_disabled',
  'dependency_missing',
  'dependency_pinned_version_unsatisfied',
  'dependency_policy_blocked',
  'dependency_resolution_failed',
  'dependency_version_conflict',
  'directory_binding_unreadable',
  'directory_commit_mismatch',
  'directory_identity_changed',
  'directory_listing_not_installable',
  'directory_name_held',
  'directory_not_in_session',
  'directory_off',
  'directory_unavailable',
  'enabled_at_project_scope',
  'entry_archive_url_changed',
  'entry_helper_changed',
  'entry_helper_declined',
  'entry_helper_deferred',
  'entry_helper_disabled_by_policy',
  'entry_helper_not_inlined',
  'entry_helper_organization_unanswered',
  'entry_helper_remote_policy_unconsented',
  'entry_helper_unconfirmed',
  'entry_helper_unshown',
  'governed_elsewhere',
  'install_records_unreadable',
  'installed_from_other_marketplace',
  'invalid_plugin_id',
  'invalid_source',
  'local_plugin_dirs_blocked',
  'local_source_no_location',
  'managed_name_locked',
  'marketplace_dir_missing',
  'marketplace_dir_unreadable',
  'marketplace_entry_path_refused',
  'marketplace_location_refused',
  'marketplace_not_available',
  'marketplace_policy_blocked',
  'not_cached',
  'not_found',
  'not_installed',
  'not_installed_at_scope',
  'npm_marketplace_disabled',
  'partial_failure',
  'plugin_directory_unavailable',
  'plugin_folder_held',
  'plugin_policy_blocked',
  'replace_failed',
  'replace_needs_fresh_listing',
  'replace_needs_full_id',
  'replace_unavailable',
  'required_by_dependents',
  'required_by_organization',
  'settings_flag_override',
  'settings_still_on',
  'settings_write_failed',
  'source_missing',
] as const;

/** One of the failure codes. */
export type AutoupdateFailureCode = (typeof AUTOUPDATE_FAILURE_CODES)[number];

/* -------------------------------------------------------------------------- */
/* The operation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The result of one plugin update.
 *
 * This is the shape the target's update operation returns.
 */
export interface PluginUpdateOperation {
  /** What the update did. */
  readonly outcome: PluginUpdateOutcome;
  /** The plugin's id, in `plugin@marketplace` form. */
  readonly pluginId?: string;
  /** The version the plugin was on. */
  readonly oldVersion?: string | null;
  /** The version the plugin is on now. */
  readonly newVersion?: string | null;
  /** The scope the update ran in. */
  readonly scope?: string;
  /** The message the operation reports. */
  readonly message?: string;
  /** Why the update was skipped. */
  readonly skipReason?: string;
  /** Why the update failed. */
  readonly failureCode?: string;
  /** The plugins that pin this one. */
  readonly blockedBy?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* The classification                                                           */
/* -------------------------------------------------------------------------- */

/** A block the autoupdater reports. */
export type AutoupdateBlock =
  | {
      readonly type: 'autoupdate-deferred-entry-helper';
      /** The plugin's id. */
      readonly source: string;
      /** The plugin's name. */
      readonly plugin: string;
      /** The message the operation reported. */
      readonly message?: string;
    }
  | {
      readonly type: 'autoupdate-blocked-by-pinner';
      /** The plugin's id. */
      readonly source: string;
      /** The plugin's name. */
      readonly plugin: string;
      /** The version the plugin is held at. */
      readonly heldAt?: string | null;
      /** The plugins that pin this one. */
      readonly blockedBy: readonly string[];
      /** The pins that are disabled, and so do not hold the update back. */
      readonly disabledPinners: readonly string[];
    }
  | {
      readonly type: 'autoupdate-disabled-by-policy';
      /** The plugin's id. */
      readonly source: string;
      /** The plugin's name. */
      readonly plugin: string;
      /** The message the operation reported. */
      readonly message?: string;
    }
  | {
      readonly type: 'generic-error';
      /** The plugin's id. */
      readonly source: string;
      /** The plugin's name. */
      readonly plugin: string;
      /** The error the autoupdater reports. */
      readonly error?: string;
    };

/**
 * What the autoupdater makes of one update.
 */
export interface AutoupdateClassification {
  /** The plugin that was updated. */
  readonly updated?: string;
  /** The block the autoupdater reports, when it reports one. */
  readonly blocked?: AutoupdateBlock;
  /** Whether the update failed. */
  readonly failed: boolean;
  /** Whether the plugin was not found, or was not cached. */
  readonly notFound: boolean;
  /** Whether the plugin's directory identity changed. */
  readonly directoryIdentityChanged: boolean;
  /** Whether the plugin's listing is not installable. */
  readonly directoryNotInstallable: boolean;
  /** Whether the plugin's directory is unavailable. */
  readonly directoryUnavailable: boolean;
  /** The plugin whose command source was skipped. */
  readonly commandSourceSkipped?: string;
}

/**
 * The name of a plugin id — the part before the `@`.
 */
function pluginNameOf(pluginId: string): string {
  const at = pluginId.lastIndexOf('@');
  return at <= 0 ? pluginId : pluginId.slice(0, at);
}

/**
 * The name of the built-in Directory marketplace.
 */
export const DIRECTORY_MARKETPLACE_NAME = 'anthropic-plugin-directory';

/**
 * The error the autoupdater reports when a Directory plugin's background
 * update failed.
 *
 * The target's own text.
 */
export const DIRECTORY_STUCK_MESSAGE =
  'The Anthropic Directory lists a different commit, but the background update failed, so this ' +
  'plugin is still on the old one. Choose "Update now" in /plugin → Installed to retry and see ' +
  'the error';

/** The failure codes the autoupdater reports as "not found". */
const NOT_FOUND_CODES = new Set(['not_found', 'not_cached']);

/** The failure codes the autoupdater reports as a policy refusal. */
const POLICY_CODES = new Set([
  'entry_helper_disabled_by_policy',
  'entry_helper_remote_policy_unconsented',
  'entry_helper_organization_unanswered',
  'plugin_policy_blocked',
]);

/** The options a classification takes. */
export interface AutoupdateOptions {
  /**
   * The pins that are **disabled**.
   *
   * A disabled pin does not hold an update back, so it is reported apart from
   * the pins that do.
   */
  readonly disabledPinners?: ReadonlySet<string>;
  /**
   * Whether the policy refuses a **command source**.
   *
   * The target's own rule: a `command_source_refused` failure is a policy
   * refusal only when the policy says so.
   */
  readonly policyRefusesCommandSource?: boolean;
}

/**
 * Classify one update the way the target's autoupdater classifies it.
 *
 * The function is pure: it takes the operation's result and the autoupdater's
 * options, and returns what the autoupdater reports.
 */
export function classifyAutoupdate(
  operation: PluginUpdateOperation,
  options: AutoupdateOptions = {},
): AutoupdateClassification {
  const disabledPinners = options.disabledPinners ?? new Set<string>();
  const source = operation.pluginId ?? '';
  const plugin = pluginNameOf(source);

  const base: AutoupdateClassification = {
    failed: false,
    notFound: false,
    directoryIdentityChanged: false,
    directoryNotInstallable: false,
    directoryUnavailable: false,
  };

  if (operation.outcome === 'updated') {
    return { ...base, updated: source };
  }
  if (operation.outcome === 'up_to_date') {
    return base;
  }

  if (operation.outcome === 'skipped') {
    if (operation.skipReason === 'entry_helper_deferred') {
      return {
        ...base,
        blocked: {
          type: 'autoupdate-deferred-entry-helper',
          source,
          plugin,
          ...(operation.message === undefined ? {} : { message: operation.message }),
        },
      };
    }
    const blockers = operation.blockedBy ?? [];
    if (blockers.length > 0) {
      return {
        ...base,
        blocked: {
          type: 'autoupdate-blocked-by-pinner',
          source,
          plugin,
          ...(operation.oldVersion === undefined ? {} : { heldAt: operation.oldVersion }),
          blockedBy: blockers.map((entry) => pluginNameOf(entry)),
          disabledPinners: blockers
            .filter((entry) => disabledPinners.has(entry))
            .map((entry) => pluginNameOf(entry)),
        },
      };
    }
    return base;
  }

  // The operation failed.
  const code = operation.failureCode;

  if (code !== undefined && NOT_FOUND_CODES.has(code)) {
    return { ...base, failed: true, notFound: true };
  }
  if (code === 'directory_identity_changed') {
    return { ...base, failed: true, directoryIdentityChanged: true };
  }
  if (code === 'directory_listing_not_installable') {
    return { ...base, failed: true, directoryNotInstallable: true };
  }
  if (
    code === 'directory_unavailable' ||
    code === 'marketplace_policy_blocked' ||
    code === 'directory_binding_unreadable'
  ) {
    return { ...base, failed: true, directoryUnavailable: true };
  }
  if (code === 'command_source_skipped') {
    return { ...base, commandSourceSkipped: source };
  }
  if (code !== undefined && POLICY_CODES.has(code)) {
    return {
      ...base,
      blocked: {
        type: 'autoupdate-disabled-by-policy',
        source,
        plugin,
        ...(operation.message === undefined ? {} : { message: operation.message }),
      },
    };
  }
  if (code === 'command_source_refused' && options.policyRefusesCommandSource === true) {
    return {
      ...base,
      blocked: {
        type: 'autoupdate-disabled-by-policy',
        source,
        plugin,
        ...(operation.message === undefined ? {} : { message: operation.message }),
      },
    };
  }
  if (code === 'entry_helper_not_inlined') {
    return {
      ...base,
      failed: true,
      blocked: {
        type: 'generic-error',
        source,
        plugin,
        ...(operation.message === undefined ? {} : { error: operation.message }),
      },
    };
  }

  // The target's own rule: a command source that is merely **inactive** is not
  // a failure; anything else is.
  if (code === 'command_source_inactive') {
    return base;
  }

  const failed: AutoupdateClassification = { ...base, failed: true };

  // A Directory plugin whose background update failed for no named reason is
  // reported as **stuck**: the catalogue lists a different commit, and the
  // plugin is still on the old one.
  if (
    source.endsWith(`@${DIRECTORY_MARKETPLACE_NAME}`) &&
    !failed.notFound &&
    !failed.directoryIdentityChanged &&
    !failed.directoryNotInstallable &&
    !failed.directoryUnavailable
  ) {
    return {
      ...failed,
      blocked: { type: 'generic-error', source, plugin, error: DIRECTORY_STUCK_MESSAGE },
    };
  }

  return failed;
}

/**
 * Whether a value is a plain object (not an array, not `null`).
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

/**
 * Read a plugin's update result out of a record the caller supplies.
 *
 * The record is caller-supplied data, so every member is read with an
 * **own-property** check.
 */
export function pluginUpdateOperationOf(record: unknown): PluginUpdateOperation | undefined {
  if (!isObject(record)) return undefined;
  const outcome = Object.hasOwn(record, 'outcome') ? record['outcome'] : undefined;
  if (
    outcome !== 'updated' &&
    outcome !== 'up_to_date' &&
    outcome !== 'skipped' &&
    outcome !== 'failed'
  ) {
    return undefined;
  }
  const stringOf = (key: string): string | undefined => {
    const value = Object.hasOwn(record, key) ? record[key] : undefined;
    return typeof value === 'string' ? value : undefined;
  };
  const blockedBy = Object.hasOwn(record, 'blockedBy') ? record['blockedBy'] : undefined;
  return {
    outcome,
    ...(stringOf('pluginId') === undefined ? {} : { pluginId: stringOf('pluginId') as string }),
    ...(stringOf('oldVersion') === undefined ? {} : { oldVersion: stringOf('oldVersion') as string }),
    ...(stringOf('newVersion') === undefined ? {} : { newVersion: stringOf('newVersion') as string }),
    ...(stringOf('scope') === undefined ? {} : { scope: stringOf('scope') as string }),
    ...(stringOf('message') === undefined ? {} : { message: stringOf('message') as string }),
    ...(stringOf('skipReason') === undefined ? {} : { skipReason: stringOf('skipReason') as string }),
    ...(stringOf('failureCode') === undefined
      ? {}
      : { failureCode: stringOf('failureCode') as string }),
    ...(Array.isArray(blockedBy)
      ? { blockedBy: blockedBy.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
  };
}
