/**
 * Settings loader — reads the five settings tiers from disk and reports what each
 * tier contributed, how it was read, and which tiers were suppressed or degraded.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.7.
 *
 * Observed behaviour this reproduces:
 *
 *   - Project settings live at `.claude/settings.json` and local settings at
 *     `.claude/settings.local.json`.
 *   - A project settings file that is a **symlink or hard link to a user settings
 *     path** is reported as "linked away" and is **not applied**.
 *   - The project tier is **skipped entirely** when the project settings path and
 *     the user settings path resolve to the same file; the `projectSettings` source
 *     is then reported with the read mode `as_read` rather than `none`.
 *   - Local settings are **merged over a legacy local settings file**, with the local
 *     file taking precedence.
 *   - Per-source read modes are `none`, `as_read` and `machine_admin`, and
 *     `policySettings` is read as `machine_admin`.
 *   - The "restrict personal config" restriction suppresses exactly the project-side
 *     sources (`projectSettings`, `localSettings`).
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The user settings file is `<configDir>/settings.json`; the machine policy file
 *     defaults to `<configDir>/managed-settings.json` and is read as
 *     `machine_admin`. The target reads the policy tier directly in its
 *     sandbox/policy module; the audit does not name the path, so the path is
 *     overridable through `policySettingsPath`.
 *   - The "legacy" local settings file defaults to `<configDir>/settings.local.json`,
 *     next to the user settings file, and is overridable through
 *     `legacyLocalSettingsPath`. The audit establishes the merge rule but not the
 *     path — **the path is a implementation choice, not observed**.
 *   - The legacy merge is applied at **block** granularity (a key defined by the
 *     local file replaces the legacy value entirely). The audit says only that local
 *     settings are "merged over a legacy local settings file, with the local file
 *     taking precedence"; the whole-block rule it states is about **tiers**, not
 *     about two files of the same tier. **The block granularity here is a reimplementation
 *     choice, not observed** — a key-level merge would satisfy the audit's wording
 *     equally well.
 *   - The project tier is not gated on project trust here; the target's `gateProject`
 *     decision is a trust question that belongs to the session layer.
 *
 * The sandbox configuration *writer* lives in `schema.ts` (the settings-document
 * module), not here: this file has one responsibility, reading the tiers. The
 * sandbox **policy** is read here, though: the tier that wins the `sandbox`
 * block decides the policy, and the rule that picks the tier is the one the
 * tiers module owns (`resolveBlock`), so there is only one copy of it.
 */

import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';

import { parseSettingsDocument } from './schema.js';
import { isSuppressed } from './scope.js';
import {
  SETTINGS_SOURCES,
  TIER_PRECEDENCE,
  SettingsTierEntry,
  mergeBlockwise,
  resolveBlock,
  type SettingsSource,
  type SettingsTier,
} from './tiers.js';
import { parseSandboxPolicy, type SandboxPolicy } from '../platform/sandbox/policy.js';

/** How a source's settings file was read. */
export type SettingsReadMode = 'none' | 'as_read' | 'machine_admin';

export interface SettingsLoadOptions {
  /** The working directory the project tiers are resolved against. */
  cwd: string;
  /** The configuration directory the user and policy tiers are resolved against. */
  configDir: string;
  /** Whether personal configuration is restricted (project-side tiers suppressed). */
  restricted: boolean;
  /** Override the machine policy settings path. */
  policySettingsPath?: string;
  /** Override the local settings path. */
  localSettingsPath?: string;
  /** Override the legacy local settings path. */
  legacyLocalSettingsPath?: string;
  /** The feature-flag tier, applied as an overlay of settings keys. */
  flagSettings?: Record<string, unknown>;
}

export interface SettingsLoadError {
  source: SettingsSource;
  path: string;
  severity: 'warning' | 'error';
  message: string;
}

export interface SettingsLoadResult {
  tiers: Map<SettingsSource, SettingsTier>;
  errors: SettingsLoadError[];
  readMode: Map<SettingsSource, SettingsReadMode>;
  linkedAway: SettingsSource[];
  /**
   * The sandbox policy the settings document carries.
   *
   * It is built out of the **merged** document — the tiers folded at block
   * granularity — so a higher tier's `sandbox` block applies as a whole over a
   * lower one, exactly as the audit states for a higher tier's block. A document
   * that says nothing about the sandbox yields the default policy.
   *
   * The member is **not** optional: a session always has a sandbox policy, and
   * there is therefore **one** meaning for "no policy" in the whole implementation — the
   * one the `Bash` tool gives it: a session whose *dependencies* carry no policy
   * has no sandbox at all. A caller never has to decide what an absent policy
   * means, because the loader never produces one.
   */
  readonly sandboxPolicy: SandboxPolicy;
}

type ReadStatus = 'missing' | 'ok' | 'invalid';

interface ReadOutcome {
  status: ReadStatus;
  document?: Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read and validate one settings file.
 *
 * A missing file is not an error. A file that cannot be read, is not valid JSON, or
 * violates the settings schema is an `error` and its tier does not apply.
 */
function readSettingsFile(
  filePath: string,
  source: SettingsSource,
  errors: SettingsLoadError[],
): ReadOutcome {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return { status: 'missing' };
    errors.push({
      source,
      path: filePath,
      severity: 'error',
      message: `unable to read settings file: ${errorMessage(error)}`,
    });
    return { status: 'invalid' };
  }

  if (raw.trim().length === 0) return { status: 'ok', document: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    errors.push({
      source,
      path: filePath,
      severity: 'error',
      message: `settings file is not valid JSON: ${errorMessage(error)}`,
    });
    return { status: 'invalid' };
  }

  if (!isPlainObject(parsed)) {
    errors.push({
      source,
      path: filePath,
      severity: 'error',
      message: 'settings file must contain a JSON object',
    });
    return { status: 'invalid' };
  }

  const result = parseSettingsDocument(parsed);
  if (!result.ok) {
    errors.push({
      source,
      path: filePath,
      severity: 'error',
      message: `settings file failed validation: ${result.issues.join('; ')}`,
    });
    return { status: 'invalid' };
  }

  return { status: 'ok', document: result.value };
}

function safeLstat(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

/** Whether two paths are the same file on disk (same device and inode). */
function sameFile(a: string, b: string): boolean {
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

/** Whether two paths resolve to the same real path. */
function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

type ProjectPathClass = 'absent' | 'linkedAway' | 'sameFile' | 'distinct';

/**
 * Classify the project settings path against the user settings path.
 *
 *   - `linkedAway` — the project settings file is a symlink or a hard link to the
 *     user settings file. The target reports it as "linked away" and does not apply
 *     it.
 *   - `sameFile` — the two paths resolve to the same file (for example when the
 *     project's `.claude` directory is the configuration directory). The target skips
 *     the project tier entirely, and reports the source as `as_read` rather than
 *     `none`.
 *   - `distinct` — an ordinary project settings file.
 */
export function classifyProjectSettingsPath(
  projectPath: string,
  userPath: string,
): ProjectPathClass {
  const stats = safeLstat(projectPath);
  if (!stats) return 'absent';

  const isLink = stats.isSymbolicLink() || stats.nlink > 1;
  if (isLink && sameFile(projectPath, userPath)) return 'linkedAway';
  if (sameRealPath(projectPath, userPath)) return 'sameFile';
  return 'distinct';
}

/**
 * The sandbox policy of the loaded tiers.
 *
 * The rule is the one the **tiers module owns**: the highest tier that defines a
 * `sandbox` block wins **as a whole**, and the block is never merged key by key
 * with a lower tier. The module that owns the precedence is asked, so there is
 * only one copy of the rule — and the scope-restriction machinery comes with it.
 *
 * A tier that says nothing about the sandbox yields this implementation's default policy.
 */
function sandboxPolicyOfTiers(tiers: Map<SettingsSource, SettingsTier>): SandboxPolicy {
  const block = resolveBlock(tiers, 'sandbox');
  return parseSandboxPolicy(block?.value);
}

/**
 * Read every settings tier and report what each one contributed.
 */
export function loadSettings(opts: SettingsLoadOptions): SettingsLoadResult {
  const cwd = path.resolve(opts.cwd);
  const configDir = path.resolve(opts.configDir);

  const collected = new Map<SettingsSource, SettingsTier>();
  const errors: SettingsLoadError[] = [];
  const readMode = new Map<SettingsSource, SettingsReadMode>();
  const linkedAway: SettingsSource[] = [];
  for (const source of SETTINGS_SOURCES) readMode.set(source, 'none');

  // --- policy tier: read as machine-administered policy. ---
  const policyPath = opts.policySettingsPath ?? path.join(configDir, 'managed-settings.json');
  const policy = readSettingsFile(policyPath, 'policySettings', errors);
  if (policy.status === 'ok') {
    collected.set('policySettings', new SettingsTierEntry('policySettings', policy.document));
    readMode.set('policySettings', 'machine_admin');
  } else if (policy.status === 'invalid') {
    readMode.set('policySettings', 'machine_admin');
  }

  // --- user tier. ---
  const userPath = path.join(configDir, 'settings.json');
  const user = readSettingsFile(userPath, 'userSettings', errors);
  if (user.status === 'ok') {
    collected.set('userSettings', new SettingsTierEntry('userSettings', user.document));
    readMode.set('userSettings', 'as_read');
  } else if (user.status === 'invalid') {
    readMode.set('userSettings', 'as_read');
  }

  // --- project tier: skipped when linked away or when it is the user settings file. ---
  const projectPath = path.join(cwd, '.claude', 'settings.json');
  if (!isSuppressed('projectSettings', opts.restricted)) {
    const classification = classifyProjectSettingsPath(projectPath, userPath);
    if (classification === 'linkedAway') {
      linkedAway.push('projectSettings');
      errors.push({
        source: 'projectSettings',
        path: projectPath,
        severity: 'warning',
        message: 'project settings are linked away to the user settings file and are not applied',
      });
    } else if (classification === 'sameFile') {
      // Skipped entirely, but the file was read — as the user settings.
      readMode.set('projectSettings', 'as_read');
      errors.push({
        source: 'projectSettings',
        path: projectPath,
        severity: 'warning',
        message:
          'project settings resolve to the same file as the user settings; the project tier is skipped',
      });
    } else {
      const project = readSettingsFile(projectPath, 'projectSettings', errors);
      if (project.status === 'ok') {
        collected.set('projectSettings', new SettingsTierEntry('projectSettings', project.document));
        readMode.set('projectSettings', 'as_read');
      } else if (project.status === 'invalid') {
        readMode.set('projectSettings', 'as_read');
      }
    }
  }

  // --- local tier: merged over the legacy local settings file. ---
  const localPath = opts.localSettingsPath ?? path.join(cwd, '.claude', 'settings.local.json');
  const legacyPath = opts.legacyLocalSettingsPath ?? path.join(configDir, 'settings.local.json');
  if (!isSuppressed('localSettings', opts.restricted)) {
    const legacy = readSettingsFile(legacyPath, 'localSettings', errors);
    const local = readSettingsFile(localPath, 'localSettings', errors);
    const documents: Record<string, unknown>[] = [];
    if (legacy.status === 'ok' && legacy.document) documents.push(legacy.document);
    if (local.status === 'ok' && local.document) documents.push(local.document);
    if (documents.length > 0) {
      // Implementation choice (not observed): the legacy file is merged at block granularity,
      // so a key the local file defines replaces the legacy value entirely.
      const merged = documents.reduce<Record<string, unknown>>(
        (accumulated, document) => mergeBlockwise(accumulated, document),
        {},
      );
      collected.set('localSettings', new SettingsTierEntry('localSettings', merged));
      readMode.set('localSettings', 'as_read');
    } else if (legacy.status === 'invalid' || local.status === 'invalid') {
      readMode.set('localSettings', 'as_read');
    }
  }

  // --- flag tier: an overlay of settings keys supplied by the caller. ---
  if (opts.flagSettings && Object.keys(opts.flagSettings).length > 0) {
    collected.set('flagSettings', new SettingsTierEntry('flagSettings', { ...opts.flagSettings }));
    readMode.set('flagSettings', 'as_read');
  }

  // The tier map is ordered by precedence so that iteration order is stable.
  const tiers = new Map<SettingsSource, SettingsTier>();
  for (const source of TIER_PRECEDENCE) {
    const tier = collected.get(source);
    if (tier) tiers.set(source, tier);
  }

  // The sandbox policy is read out of the tier that **wins** the `sandbox`
  // block, so the block applies as a whole.
  const sandboxPolicy = sandboxPolicyOfTiers(tiers);

  return { tiers, errors, readMode, linkedAway, sandboxPolicy };
}
