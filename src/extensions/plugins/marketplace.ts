/**
 * The plugin marketplace install flow.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("The plugin
 * marketplace install flow is observed") and
 * `docs/compatibility/extension-surface.md` ("The marketplace install flow").
 *
 * ## The result
 *
 * The result of `installPluginFromMarketplace` carries
 * `{ success, message, depNote, installedDisabled, installedDisabledByDefault,
 * enableHint, otherProjectsNote }`.
 *
 * - The install records the plugin's **version**, the **install source**
 *   (`ui-suggestion` or `ui-discover`), the **trigger** and the **surface**.
 * - The install can **succeed while the plugin stays disabled**. The result
 *   distinguishes the two reasons: `installedDisabledByDefault` is reported as
 *   `by-default` and `installedDisabled` (a setting turned it off) as
 *   `in-settings`.
 * - A successful install returns an **enable hint** — `enable it in /plugin` or
 *   `enable it in /plugin or run: <command>`.
 * - A **refused** install is distinct from a **failed** one. A refusal is logged
 *   at `info` level with `installPluginFromMarketplace refused for <plugin>:
 *   <reason>` and a failure reason of `command-source-refused` — the install is
 *   refused when the **command source** is not trusted — while a genuine failure
 *   is logged at `error` level with `failed`. The telemetry carries the reason
 *   (`failureCode`, `command-source-refused`, or `unexpected-error`), an
 *   `errorKind`, the plugin id, the marketplace name, the trigger and the
 *   surface.
 * - A **stray orphan marker** left in a staged plugin is removed, with the
 *   warning `Could not drop a stray orphan marker from the staged plugin:
 *   <reason>`.
 * - A version transition is computed as a `{ from, to }` pair.
 *
 * ## Implementation choices (the audit does not pin them)
 *
 *   - The **orphan marker** is a file named `.orphan` at the staged plugin's
 *     root. The audit names the marker and the warning but not the file.
 *   - The **refusal reason** in the log message is `untrusted command source:
 *     <source>`; the audit pins the message's shape, not the reason's text.
 *   - The **failure** log message is `installPluginFromMarketplace failed for
 *     <plugin>: <message>`; the audit pins the level and the word `failed`.
 *   - The **enable hint** with a command is `enable it in /plugin or run:
 *     <command>`.
 *   - The **disable reason** is reported both as a structured field
 *     (`disableReason`) and as the token `by-default` / `in-settings` inside the
 *     result's message, because the audit says the result "reports" the reason
 *     without saying where.
 */

import { existsSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/** Where an install came from. */
export type PluginInstallSource = 'ui-suggestion' | 'ui-discover';

/** A plugin the marketplace offers. */
export interface MarketplacePlugin {
  /** The plugin's id, unique in its marketplace. */
  id: string;
  /** The plugin's name. */
  name: string;
  /** The plugin's version. */
  version?: string;
  /** The command sources the plugin declares. */
  commandSources?: readonly string[];
  /** The plugins this one depends on. */
  dependencies?: readonly string[];
}

/** The request an install runs for. */
export interface PluginInstallRequest {
  /** The plugin being installed. */
  plugin: MarketplacePlugin;
  /** The marketplace the plugin came from. */
  marketplace: string;
  /** Where the install came from. */
  installSource: PluginInstallSource;
  /** What triggered the install. */
  trigger: string;
  /** The surface the install happened on. */
  surface: string;
  /** The command sources the host trusts. */
  trustedCommandSources?: readonly string[];
  /** The version that was installed before, when there was one. */
  fromVersion?: string;
  /** Whether a setting disabled the plugin. */
  disabledInSettings?: boolean;
  /** Whether the plugin is disabled by default. */
  disabledByDefault?: boolean;
  /** The command that enables the plugin. */
  enableCommand?: string;
  /** The staged plugin directory. */
  stagedPath?: string;
  /** Whether the plugin is also installed for other projects. */
  otherProjects?: boolean;
  /** The failure that stopped the install, when there is one. */
  failure?: { code?: string; kind?: string; message: string };
}

/** The telemetry an install carries. */
export interface PluginInstallTelemetry {
  /** The plugin's id. */
  pluginId: string;
  /** The marketplace's name. */
  marketplace: string;
  /** What triggered the install. */
  trigger: string;
  /** The surface the install happened on. */
  surface: string;
  /** Why the install failed. */
  reason?: 'failureCode' | 'command-source-refused' | 'unexpected-error';
  /** The specific failure code, when the reason is `failureCode`. */
  failureCode?: string;
  /** The kind of the error. */
  errorKind?: string;
}

/** The level a log record carries. */
export type PluginLogLevel = 'info' | 'warn' | 'error';

/** A log record the install flow raises. */
export interface PluginLogRecord {
  /** The level of the record. */
  level: PluginLogLevel;
  /** The message of the record. */
  message: string;
  /** The telemetry the record carries, when it carries one. */
  telemetry?: PluginInstallTelemetry;
}

/** Why a plugin stays disabled after a successful install. */
export type PluginDisableReason = 'by-default' | 'in-settings';

/** The result of an install. */
export interface PluginInstallResult {
  /** Whether the install succeeded. */
  success: boolean;
  /** The message the user sees. */
  message: string;
  /** The note about the plugin's dependencies. */
  depNote?: string;
  /** Whether a setting left the plugin disabled. */
  installedDisabled: boolean;
  /** Whether the plugin's own default left it disabled. */
  installedDisabledByDefault: boolean;
  /** Why the plugin stays disabled. */
  disableReason?: PluginDisableReason;
  /** The hint that tells the user how to turn the plugin on. */
  enableHint?: string;
  /** The note about the plugin's other projects. */
  otherProjectsNote?: string;
  /** The version transition the install caused. */
  versionTransition?: { from: string | null; to: string | null };
  /** Whether the install was **refused** rather than failed. */
  refused?: boolean;
  /** The reason the install did not happen. */
  failureReason?: 'command-source-refused' | 'failed';
  /** The telemetry the install carried. */
  telemetry?: PluginInstallTelemetry;
}

/** The record an install leaves behind. */
export interface PluginInstallRecord {
  /** The plugin's id. */
  pluginId: string;
  /** The version that was installed. */
  version: string | null;
  /** Where the install came from. */
  installSource: PluginInstallSource;
  /** What triggered the install. */
  trigger: string;
  /** The surface the install happened on. */
  surface: string;
}

/**
 * The stray orphan marker a staged plugin may carry.
 *
 * Implementation choice — see the file header.
 */
export const PLUGIN_ORPHAN_MARKER = '.orphan';

/**
 * The warning the target raises when the orphan marker cannot be dropped.
 */
export const PLUGIN_ORPHAN_MARKER_WARNING =
  'Could not drop a stray orphan marker from the staged plugin:';

/**
 * Drop the stray orphan marker from a staged plugin.
 *
 * The marker is removed silently when it can be removed; when it cannot, the
 * warning the target raises is returned.
 */
export function dropOrphanMarker(stagedPath: string): string | undefined {
  const marker = path.join(stagedPath, PLUGIN_ORPHAN_MARKER);
  if (!existsSync(marker)) return undefined;

  try {
    if (statSync(marker).isDirectory()) {
      // A directory marker is empty when it can be dropped.
      rmdirSync(marker);
    } else {
      unlinkSync(marker);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `${PLUGIN_ORPHAN_MARKER_WARNING} ${reason}`;
  }

  return undefined;
}

/**
 * The command source of the plugin that is not trusted, if there is one.
 */
function untrustedCommandSource(
  plugin: MarketplacePlugin,
  trusted: readonly string[] | undefined,
): string | undefined {
  const sources = plugin.commandSources ?? [];
  for (const source of sources) {
    if (!trusted?.includes(source)) return source;
  }
  return undefined;
}

/**
 * The enable hint of a successful install.
 */
export function enableHint(enableCommand: string | undefined): string {
  if (enableCommand === undefined) return 'enable it in /plugin';
  return `enable it in /plugin or run: ${enableCommand}`;
}

/**
 * The version transition an install causes.
 */
export function versionTransition(
  fromVersion: string | undefined,
  toVersion: string | undefined,
): { from: string | null; to: string | null } {
  return { from: fromVersion ?? null, to: toVersion ?? null };
}

/**
 * Run an install.
 *
 * The function is pure with respect to the filesystem apart from the orphan
 * marker it drops, and it returns the records it raised so that the caller can
 * log them.
 */
export function installPluginFromMarketplace(request: PluginInstallRequest): {
  result: PluginInstallResult;
  logs: PluginLogRecord[];
  record?: PluginInstallRecord;
} {
  const logs: PluginLogRecord[] = [];
  const { plugin, marketplace, installSource, trigger, surface } = request;

  const telemetry: PluginInstallTelemetry = {
    pluginId: plugin.id,
    marketplace,
    trigger,
    surface,
  };

  const transition = versionTransition(request.fromVersion, plugin.version);

  // The **refusal**: the command source is not trusted.
  const untrusted = untrustedCommandSource(plugin, request.trustedCommandSources);
  if (untrusted !== undefined) {
    telemetry.reason = 'command-source-refused';
    telemetry.errorKind = 'command-source';

    const message = `installPluginFromMarketplace refused for ${plugin.name}: untrusted command source: ${untrusted}`;
    logs.push({ level: 'info', message, telemetry });

    return {
      result: {
        success: false,
        message,
        installedDisabled: false,
        installedDisabledByDefault: false,
        refused: true,
        failureReason: 'command-source-refused',
        versionTransition: transition,
        telemetry,
      },
      logs,
    };
  }

  // The **failure**: the install itself went wrong.
  if (request.failure) {
    const { code, kind, message: failureMessage } = request.failure;
    telemetry.reason = code === undefined ? 'unexpected-error' : 'failureCode';
    telemetry.errorKind = kind ?? 'install-failed';
    if (code !== undefined) telemetry.failureCode = code;

    const message = `installPluginFromMarketplace failed for ${plugin.name}: ${failureMessage}`;
    logs.push({ level: 'error', message, telemetry });

    return {
      result: {
        success: false,
        message,
        installedDisabled: false,
        installedDisabledByDefault: false,
        refused: false,
        failureReason: 'failed',
        versionTransition: transition,
        telemetry,
      },
      logs,
    };
  }

  // The **success**.
  if (request.stagedPath !== undefined) {
    const warning = dropOrphanMarker(request.stagedPath);
    if (warning !== undefined) logs.push({ level: 'warn', message: warning });
  }

  const installedDisabled = request.disabledInSettings === true;
  const installedDisabledByDefault = request.disabledByDefault === true;
  const disableReason: PluginDisableReason | undefined = installedDisabled
    ? 'in-settings'
    : installedDisabledByDefault
      ? 'by-default'
      : undefined;

  const version = plugin.version ?? 'unknown';
  let message = `Installed ${plugin.name} ${version}.`;
  if (disableReason === 'in-settings') {
    message += ' The plugin stays disabled by a setting (in-settings).';
  } else if (disableReason === 'by-default') {
    message += ' The plugin stays disabled by default (by-default).';
  }

  const dependencies = plugin.dependencies ?? [];
  const depNote =
    dependencies.length > 0
      ? `This plugin needs ${dependencies.join(', ')}.`
      : undefined;

  const otherProjectsNote = request.otherProjects === true
    ? 'This plugin is also installed for your other projects.'
    : undefined;

  const result: PluginInstallResult = {
    success: true,
    message,
    installedDisabled,
    installedDisabledByDefault,
    ...(disableReason === undefined ? {} : { disableReason }),
    enableHint: enableHint(request.enableCommand),
    versionTransition: transition,
    ...(depNote === undefined ? {} : { depNote }),
    ...(otherProjectsNote === undefined ? {} : { otherProjectsNote }),
  };

  const record: PluginInstallRecord = {
    pluginId: plugin.id,
    version: plugin.version ?? null,
    installSource,
    trigger,
    surface,
  };

  return { result, logs, record };
}
