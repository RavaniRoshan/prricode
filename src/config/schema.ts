/**
 * The settings document schema, and the writer that persists a settings document.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.7 (Configuration) and
 * §2.6 (permissions / sandbox) for the rule and sandbox shapes.
 *
 * The target's settings documents carry the keys the audit names:
 *
 *   - `permissions.allow`, `permissions.deny`, `permissions.ask` rule lists and
 *     `permissions.defaultMode`;
 *   - a `sandbox.filesystem` block with `allowRead`, `allowWrite`, `denyRead`,
 *     `denyWrite` and `credentials`;
 *   - `spellcheck`, which is a user-settings-only block;
 *   - `apiKeyHelper`, `otelHeadersHelper` and `autoMemoryDirectory`, which are read
 *     per tier;
 *   - the boolean flags `skipDangerousModePermissionPrompt` and
 *     `skipWorkflowUsageWarning`.
 *
 * The target **preserves unknown keys** — a settings file written by a newer release
 * keeps its extra keys — so the document schema is loose, never strict. A strict
 * schema would silently drop the very keys the target preserves.
 *
 * The writer implements the audit's "Config file security" rule: sandbox
 * configuration is written to `<configDir>/settings.json` with mode `0o600`, and path
 * entries are canonicalized (including symlink resolution) before being written.
 *
 * Implementation choices (the audit does not pin them):
 *
 *   - The shape of the `spellcheck` block is not observed, so it is modelled as a
 *     loose object with no invented fields.
 *   - `permissions.defaultMode` accepts the six permission modes the target knows.
 *     The target ignores `auto` and `bypassPermissions` when they come from a
 *     settings file; that decision belongs to the permission layer, not the schema.
 *   - `env` is modelled as a string map, which is the shape the target's own
 *     `settings.json` `env` block uses.
 *   - Canonicalization resolves the **deepest existing ancestor** of a path and
 *     re-appends the missing tail; the audit states that symlinks are resolved but
 *     not the algorithm.
 *   - Only a leading `~` or `~/` is expanded. The `~user` form is left alone: the
 *     home directory of another user is not resolved by this implementation.
 */

import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

/** The six permission modes the target knows. */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;

export const permissionModeSchema = z.enum(PERMISSION_MODES);

export const permissionsSchema = z.looseObject({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
  defaultMode: permissionModeSchema.optional(),
  additionalDirectories: z.array(z.string()).optional(),
});

export const sandboxFilesystemSchema = z.looseObject({
  allowRead: z.array(z.string()).optional(),
  allowWrite: z.array(z.string()).optional(),
  denyRead: z.array(z.string()).optional(),
  denyWrite: z.array(z.string()).optional(),
  credentials: z.array(z.string()).optional(),
});

export const sandboxSchema = z.looseObject({
  enabled: z.boolean().optional(),
  failIfUnavailable: z.boolean().optional(),
  allowUnsandboxedCommands: z.boolean().optional(),
  enabledPlatforms: z.array(z.string()).optional(),
  excludedCommands: z.array(z.string()).optional(),
  filesystem: sandboxFilesystemSchema.optional(),
});

/** The spellcheck block: user settings only, shape not observed. */
export const spellcheckSchema = z.looseObject({});

export const settingsDocumentSchema = z.looseObject({
  permissions: permissionsSchema.optional(),
  sandbox: sandboxSchema.optional(),
  spellcheck: spellcheckSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  apiKeyHelper: z.string().optional(),
  otelHeadersHelper: z.string().optional(),
  autoMemoryDirectory: z.string().optional(),
  skipDangerousModePermissionPrompt: z.boolean().optional(),
  skipWorkflowUsageWarning: z.boolean().optional(),
  model: z.string().optional(),
});

export type SettingsDocument = z.infer<typeof settingsDocumentSchema>;

export type SettingsParseResult =
  | { ok: true; value: SettingsDocument }
  | { ok: false; issues: string[] };

/**
 * Validate a parsed settings document. Unknown keys are preserved; a document that
 * violates a known key's shape fails with a list of issues.
 */
export function parseSettingsDocument(input: unknown): SettingsParseResult {
  const result = settingsDocumentSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return `${path.length > 0 ? path : '<root>'}: ${issue.message}`;
  });
  return { ok: false, issues };
}

// --- writing a settings document ---------------------------------------------

/** The path lists a sandbox filesystem block carries. */
export interface SandboxFilesystemPaths {
  allowRead?: string[];
  allowWrite?: string[];
  denyRead?: string[];
  denyWrite?: string[];
  credentials?: string[];
}

/** The sandbox block the target writes into the settings file. */
export interface SandboxSettings {
  enabled?: boolean;
  failIfUnavailable?: boolean;
  allowUnsandboxedCommands?: boolean;
  enabledPlatforms?: string[];
  excludedCommands?: string[];
  filesystem?: SandboxFilesystemPaths;
}

const FILESYSTEM_PATH_KEYS: readonly (keyof SandboxFilesystemPaths)[] = [
  'allowRead',
  'allowWrite',
  'denyRead',
  'denyWrite',
  'credentials',
];

/**
 * Expand a leading `~` or `~/`. The `~user` form is deliberately not expanded: the
 * home directory of another user is not resolved by this implementation.
 */
function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2));
  return input;
}

/**
 * Canonicalize a path entry: expand a leading `~`, make it absolute, and resolve
 * symlinks.
 *
 * A path that does not exist yet is canonicalized through its **deepest existing
 * ancestor**: the ancestor is resolved (so a symlinked directory in the path is
 * followed) and the missing tail is re-appended unchanged.
 */
export function canonicalizePath(input: string): string {
  const absolute = path.resolve(expandHome(input));
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Canonicalize every path entry of a sandbox block. The path lists are the only
 * part of the block that carries filesystem paths.
 */
export function canonicalizeSandboxPaths(sandbox: SandboxSettings): SandboxSettings {
  const filesystem = sandbox.filesystem;
  if (!filesystem) return { ...sandbox };
  const canonical: SandboxFilesystemPaths = { ...filesystem };
  for (const key of FILESYSTEM_PATH_KEYS) {
    const entries = filesystem[key];
    if (!entries) continue;
    canonical[key] = entries.map((entry) => canonicalizePath(entry));
  }
  return { ...sandbox, filesystem: canonical };
}

export interface SandboxSettingsWriteResult {
  /** The settings file the sandbox block was written to. */
  path: string;
  /** The whole settings document that was written. */
  document: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Write the sandbox configuration into `<configDir>/settings.json` with mode
 * `0o600`, after canonicalizing the block's path entries.
 *
 * The other keys of the settings file are preserved; only the `sandbox` block is
 * replaced. A settings file that cannot be parsed is never overwritten.
 */
export function writeSandboxSettings(opts: {
  configDir: string;
  sandbox: SandboxSettings;
}): SandboxSettingsWriteResult {
  const configDir = path.resolve(opts.configDir);
  const settingsPath = path.join(configDir, 'settings.json');

  let existing: Record<string, unknown> = {};
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    if (raw.trim().length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        throw new Error('the existing settings file does not contain a JSON object');
      }
      existing = parsed;
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw new Error(`refusing to overwrite ${settingsPath}: ${errorMessage(error)}`);
    }
  }

  const document: Record<string, unknown> = {
    ...existing,
    sandbox: canonicalizeSandboxPaths(opts.sandbox),
  };

  // The configuration directory holds a 0600 file, so it is created 0700 as
  // well — and an existing directory is narrowed to the same mode, because the
  // mode `mkdir` sets is filtered through the process's umask and a directory
  // that already existed may carry a wider one.
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);

  writeFileSync(settingsPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  // `mode` only applies when the file is created, so the mode is set explicitly.
  chmodSync(settingsPath, 0o600);

  return { path: settingsPath, document };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
