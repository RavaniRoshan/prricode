/**
 * The settings document schema.
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
 * Implementation choices (the audit does not pin them):
 *
 *   - The shape of the `spellcheck` block is not observed, so it is modelled as a
 *     loose object with no invented fields.
 *   - `permissions.defaultMode` accepts the six permission modes the target knows.
 *     The target ignores `auto` and `bypassPermissions` when they come from a
 *     settings file; that decision belongs to the permission layer, not the schema.
 *   - `env` is modelled as a string map, which is the shape the target's own
 *     `settings.json` `env` block uses.
 */

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
