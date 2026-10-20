/**
 * The settings document schema, and the writer that persists a settings document.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.7 (Configuration) and
 * §2.6 (permissions / sandbox) for the rule and sandbox shapes, and — for the
 * **document** itself — the target's own settings schema, read out of the pinned
 * build at `chunk-c9s0jh80.js` (the settings-shape factory `cc()` at offset
 * `253478`; its 183 top-level keys run from `253945` to `323785`).
 *
 * ## What this module is
 *
 * The audit covers the **merge algorithm** — which tier wins a key. It does not
 * cover the **shape of the document**: which keys the target accepts, what type
 * each one has, and what it means. That is what this module is.
 *
 * The target builds the whole document with one helper — `Mr(schema, { NAME: … })`
 * — and every key carries the target's own `.describe()` prose, so the target
 * states in its own words what each setting is for. That prose is reproduced
 * here, with the target's **product name** replaced by `PRRICODE`; the key
 * **names**, the **types**, the **defaults** and the target's **environment
 * variable names**, **model ids** and **API hosts** are reproduced exactly,
 * because they are the data the implementation has to speak to.
 *
 * ## The three documents
 *
 * | document | keys | where it comes from |
 * |---|---|---|
 * | the **settings document** | **183** top-level keys, plus the **7** gated-block keys, plus `permissions` (**7** + the gated `disableAutoMode`) and `sandbox` (**16**) | `chunk-c9s0jh80.js:253945`–`323785` |
 * | the **workspace config** | **28** keys | `chunk-z6a1zj5w.js:1015027` (`WorkspaceConfig`) |
 * | the **flat managed config** | **22** top-level keys | `chunk-z6a1zj5w.js:1116122` (`FlatManagedConfig`) |
 *
 * The two sibling documents are **separate documents with their own keys**, not
 * a variant of the settings document: the workspace config is the
 * managed-config surface for a third-party distribution, and the flat managed
 * config is the *flat* (dot-path) form of the managed configuration. The
 * settings document is neither.
 *
 * ## Unknown keys are preserved
 *
 * The target's document schema is `cc(…)` + `.passthrough()`: a settings file
 * written by a newer release keeps its extra keys, and a strict schema would
 * silently drop the very keys the target preserves. The document schema is
 * therefore **loose**, and so are the sibling documents' objects.
 *
 * ## The defaults are applied when a key is read, not when a document is parsed
 *
 * The target's schema carries **no** defaults: `cc()` returns a shape whose
 * members are `.optional()` and nothing more. The default of a key lives in the
 * code that *reads* the key, and the target's own `.describe()` prose states it
 * for the keys that have one. {@link SETTINGS_DEFAULTS} records those, and
 * {@link settingsDefault} reads them. A key that is **not** in the table has
 * **no** default — which is not the same as a default of `false`, and the table
 * never says `false` for a key the target leaves unset.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The **permission rule** validator is reproduced structurally (a rule is
 *     `Tool` or `Tool(content)`, the content is not empty, the tool name is not
 *     empty, and a name that carries no underscore starts with an upper-case
 *     letter). The target's per-tool rule validators — the `Bash(npm:*)` prefix
 *     rules, the path rules, the MCP rules — are **not** reproduced: they live
 *     in the permission engine, not in the document schema.
 *   - The shapes this implementation could not read are modelled as **loose
 *     objects**: they accept what the target accepts and reject a value of the
 *     wrong *kind*, but they do not reject a member of the wrong shape inside
 *     them. The keys that are affected are named in the conformance document.
 *   - `permissions.defaultMode` accepts `manual` as an **alias** for `default`
 *     and normalizes it, exactly as the target's own schema does.
 *   - `sandbox.enabledPlatforms` is accepted even though the target's own
 *     `sandbox` schema does not name it: the target's policy code reads it from
 *     the raw block, and the audit names it as one of the five keys the sandbox
 *     block carries.
 *   - The spellcheck block is modelled with the four keys the target's own
 *     `.describe()` text names, and stays **loose** so a newer key survives.
 *   - `env` is a string map, which is the shape the target's own `env` block
 *     uses.
 *   - Canonicalization resolves the **deepest existing ancestor** of a path and
 *   re-appends the missing tail; the audit states that symlinks are resolved but
 *   not the algorithm.
 *   - Only a leading `~` or `~/` is expanded. The `~user` form is left alone: the
 *   home directory of another user is not resolved by this implementation.
 */

import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

// --- the permission modes ---------------------------------------------------

/** The six permission modes the target knows. */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * The aliases the target's own schema accepts.
 *
 * `manual` is an alias for `default`: the target's permission-mode helper maps
 * it before the value is compared with the six modes, so a settings file that
 * says `"manual"` is a `default` mode, not an unknown one.
 */
export const PERMISSION_MODE_ALIASES: Readonly<Record<string, PermissionMode>> = {
  manual: 'default',
};

/**
 * Normalize a permission mode: the alias becomes the mode it stands for, and a
 * value that names no mode is left alone so that the schema rejects it.
 */
export function normalizePermissionModeValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (Object.hasOwn(PERMISSION_MODE_ALIASES, value)) return PERMISSION_MODE_ALIASES[value];
  return value;
}

export const permissionModeSchema = z.preprocess(
  normalizePermissionModeValue,
  z.enum(PERMISSION_MODES),
);

// --- the permission rules ---------------------------------------------------

/**
 * A permission rule.
 *
 * The rule is `Tool` or `Tool(content)`. The content is literal — the target
 * states that "parentheses inside the content are literal" — and it is not
 * empty. A tool name that carries no underscore starts with an upper-case
 * letter.
 */
export const permissionRuleSchema = z.string().superRefine((rule, ctx) => {
  const trimmed = rule.trim();
  if (trimmed.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Permission rule cannot be empty' });
    return;
  }
  const open = trimmed.indexOf('(');
  if (open === -1) {
    if (trimmed.endsWith(')')) {
      ctx.addIssue({ code: 'custom', message: 'Malformed Tool(content) rule' });
      return;
    }
    checkToolName(trimmed, ctx);
    return;
  }
  if (!trimmed.endsWith(')')) {
    ctx.addIssue({ code: 'custom', message: 'Malformed Tool(content) rule' });
    return;
  }
  const toolName = trimmed.slice(0, open);
  const content = trimmed.slice(open + 1, -1);
  if (toolName.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Empty parentheses with no tool name' });
    return;
  }
  if (content.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Empty parentheses' });
    return;
  }
  checkToolName(toolName, ctx);
});

/** The tool-name half of a permission rule. */
function checkToolName(toolName: string, ctx: z.RefinementCtx): void {
  if (toolName.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Tool name cannot be empty' });
    return;
  }
  if (!toolName.includes('_') && toolName[0] !== toolName[0]?.toUpperCase()) {
    ctx.addIssue({ code: 'custom', message: 'Tool names must start with uppercase' });
  }
}

// --- the permissions block --------------------------------------------------

/**
 * The `permissions` block: **seven** keys.
 *
 * The audit names four of them (`allow`, `deny`, `ask`, `defaultMode`); the
 * target's own schema names seven.
 */
export const permissionsSchema = z.looseObject({
  allow: z
    .array(permissionRuleSchema)
    .optional()
    .describe('List of permission rules for allowed operations'),
  deny: z
    .array(permissionRuleSchema)
    .optional()
    .describe('List of permission rules for denied operations'),
  ask: z
    .array(permissionRuleSchema)
    .optional()
    .describe('List of permission rules that should always prompt for confirmation'),
  defaultMode: permissionModeSchema
    .optional()
    .describe(
      "Default permission mode when PRRICODE needs access ('manual' is accepted as an alias for 'default')",
    ),
  disableBypassPermissionsMode: z
    .literal('disable')
    .optional()
    .describe('Disable the ability to bypass permission prompts'),
  blockReadsOutsideWorkingDirectories: z
    .boolean()
    .optional()
    .describe(
      'Refuse file-tool reads (Read, Grep, Glob, LSP) outside the working directories in every permission mode; true in any settings source wins. Also set when the user picks "block" on the one-time auto-mode prompt for a read outside the working directories.',
    ),
  additionalDirectories: z
    .array(z.string())
    .optional()
    .describe('Additional directories to include in the permission scope'),
  // The `autoMode` gated block contributes this key to the **permissions**
  // shape; it is the same key the top level carries.
  disableAutoMode: z
    .literal('disable')
    .optional()
    .describe('Disable auto mode'),
});

// --- the sandbox block ------------------------------------------------------

/** One explicit AWS credential pair. */
export const sandboxAwsPairSchema = z.looseObject({
  accessKeyIdVar: z.string().optional(),
  secretAccessKeyVar: z.string().optional(),
  sessionTokenVar: z.string().optional(),
});

/** The SigV4 policies the proxy applies to shapes it cannot re-sign. */
export const sandboxSigv4Schema = z.looseObject({
  streaming: z.enum(['deny', 'passthrough']).optional(),
  presigned: z.enum(['deny', 'passthrough']).optional(),
  sigv4a: z.enum(['deny', 'passthrough']).optional(),
});

/** The `sandbox.ripgrep` block. */
export const sandboxRipgrepSchema = z.looseObject({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
});

/** One masked credential file or directory. */
export const sandboxCredentialFileSchema = z.looseObject({
  path: z.string().min(1).optional(),
  mode: z.enum(['deny', 'mask']).optional(),
  extract: z.string().optional(),
  onExtractNoMatch: z.enum(['warn', 'deny', 'ignore']).optional(),
  decode: z.enum(['jwt']).optional(),
  maskClaims: z.array(z.string()).optional(),
  maskDuplicates: z.boolean().optional(),
  injectHosts: z.array(z.string()).optional(),
});

/** One masked environment variable. */
export const sandboxCredentialEnvVarSchema = z.looseObject({
  name: z.string().optional(),
  mode: z.enum(['deny', 'mask']).optional(),
  extract: z.string().optional(),
  onExtractNoMatch: z.enum(['warn', 'deny', 'ignore']).optional(),
  decode: z.enum(['jwt']).optional(),
  maskClaims: z.array(z.string()).optional(),
  injectHosts: z.array(z.string()).optional(),
});

/** The `sandbox.network` block. */
export const sandboxNetworkSchema = z.looseObject({
  allowedDomains: z.array(z.string()).optional().describe("Domains sandboxed commands may reach without a prompt (wildcards such as *.example.com supported). Merged with WebFetch(domain:…) allow rules and across settings sources. When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, values from project settings (.claude/settings.json and .claude/settings.local.json) are ignored. With network.allowManagedDomainsOnly, only managed settings supply it."),
  deniedDomains: z.array(z.string()).optional().describe("Domains that are always blocked, even if matched by allowedDomains. Supports the same wildcard syntax as allowedDomains. Merged from all settings sources regardless of allowManagedDomainsOnly."),
  strictAllowlist: z.boolean().optional().describe("When true, the sandbox runtime deterministically denies hosts not in allowedDomains instead of prompting. Enforced for sandboxed commands only — in-process tools such as WebFetch are not gated by this setting. Only honored from user, managed/policy, or CLI (--settings) settings — project settings (.claude/settings.json and .claude/settings.local.json) are ignored, and while it is on their allowedDomains and WebFetch(domain:…) allow rules are left out of the allowlist."),
  allowManagedDomainsOnly: z.boolean().optional().describe("When true (and set in managed settings), only allowedDomains and WebFetch(domain:...) allow rules from managed settings are respected. User, project, local, and flag settings domains are ignored. Denied domains are still respected from all sources."),
  allowUnixSockets: z.array(z.string()).optional().describe("macOS only: Unix socket paths to allow. Ignored on Linux (seccomp cannot filter by path). Merged across settings sources. When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, values from project settings (.claude/settings.json and .claude/settings.local.json) are ignored."),
  allowAllUnixSockets: z.boolean().optional().describe("If true, allow all Unix sockets (disables blocking on both platforms). When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, true from project settings (.claude/settings.json and .claude/settings.local.json) is ignored (false there still applies)."),
  allowLocalBinding: z.boolean().optional().describe("macOS only: If true, sandboxed commands can bind to localhost ports. When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, true from project settings (.claude/settings.json and .claude/settings.local.json) is ignored (false there still applies)."),
  allowMachLookup: z.array(z.string()).optional().describe("macOS only: Additional XPC/Mach service names to allow looking up. Supports trailing-wildcard prefix matching (e.g., \"com.apple.coresimulator.*\"). Needed for tools that communicate via XPC such as the iOS Simulator or Playwright. Merged across settings sources. When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, values from project settings (.claude/settings.json and .claude/settings.local.json) are ignored."),
  httpProxyPort: z.number().int().optional().describe("Local TCP port of your own HTTP proxy for sandboxed traffic, used instead of the proxy PRRICODE runs. When managed settings or a --settings file set allowUnsandboxedCommands: false, network.deniedDomains or a WebFetch(domain:…) deny rule, when managed settings set network.allowManagedDomainsOnly: true, or when managed, --settings or user settings set network.strictAllowlist: true, values from project settings (.claude/settings.json and .claude/settings.local.json) are ignored. With network.allowManagedDomainsOnly, only managed settings may set it."),
  socksProxyPort: z.number().int().optional().describe("Local TCP port of your own SOCKS5 proxy for sandboxed traffic, used instead of the proxy PRRICODE runs. When managed settings or a --settings file set allowUnsandboxedCommands: false, network.deniedDomains or a WebFetch(domain:…) deny rule, when managed settings set network.allowManagedDomainsOnly: true, or when managed, --settings or user settings set network.strictAllowlist: true, values from project settings (.claude/settings.json and .claude/settings.local.json) are ignored. With network.allowManagedDomainsOnly, only managed settings may set it."),
  tlsTerminate: z.boolean().optional().describe("[EXPERIMENTAL] Enable in-process TLS termination so the per-request filter can see HTTPS request bodies. Provide a CA cert+key, or omit both to have sandbox-runtime generate an ephemeral one for the session. On native Windows an ephemeral CA cannot pass the sandbox trust check, so omitting the paths uses a persistent CA managed by the sandbox runtime (set up and trusted via /sandbox install); configured paths are passed to the sandbox runtime verbatim, which rejects a bad or incomplete pair at sandbox initialization. Only honored from user, managed/policy, or CLI (`--settings`) settings — project settings (.claude/settings.json and .claude/settings.local.json) are ignored."),
});

/** The `sandbox.filesystem` block. */
export const sandboxFilesystemSchema = z.looseObject({
  allowWrite: z.array(z.string()).optional().describe("Additional paths to allow writing within the sandbox. Merged with paths from Edit(...) allow permission rules. When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, values from project settings (.claude/settings.json and .claude/settings.local.json) are ignored. When managed settings or a --settings file set filesystem.denyRead, a Read(…) deny rule or a credentials.files entry (deny or mask), a value from project settings (.claude/settings.json and .claude/settings.local.json) under or equal to a denied path, or spelled as a glob or a network path (UNC or automount), is ignored. A value inside a directory sandboxed commands can already write is re-checked before every command and dropped once it has been re-pointed into a denied read path."),
  denyWrite: z.array(z.string()).optional().describe("Additional paths to deny writing within the sandbox. Merged with paths from Edit(...) deny permission rules."),
  denyRead: z.array(z.string()).optional().describe("Additional paths to deny reading within the sandbox. Merged with paths from Read(...) deny permission rules."),
  allowRead: z.array(z.string()).optional().describe("Paths to re-allow reading within denyRead regions. Takes precedence over denyRead for matching paths. When managed settings or a --settings file set allowUnsandboxedCommands: false, filesystem.denyRead, a Read(…) deny rule or a credentials.files entry (deny or mask), or managed settings set network.allowManagedDomainsOnly: true, a value from project settings (.claude/settings.json and .claude/settings.local.json) that would re-open a path managed, --settings or user settings deny reading is ignored, as is one spelled as a glob or a network path (UNC or automount); one carving out of the project's own denyRead still applies. A value inside a directory sandboxed commands can write is re-checked before every command and dropped once it has been re-pointed into a denied path."),
  allowManagedReadPathsOnly: z.boolean().optional().describe("When true (set in managed settings), only allowRead paths from policySettings are used."),
  disabled: z.boolean().optional().describe("macOS and Linux/WSL only: skip filesystem isolation entirely while keeping network and seccomp isolation. Ignored on native Windows, where the sandboxed process runs as a separate user with no inherent rights, so skipping the filesystem rules would withhold every access grant rather than loosen them — filesystem isolation stays on there. Sandboxed commands get unrestricted read/write access to the host filesystem; network egress is still confined to network.allowedDomains. Intended for deployments whose goal is egress control rather than filesystem containment. Does not change Bash prompting: sandbox.autoAllowBashIfSandboxed is independent and still defaults to true, so set it to false to keep prompting for sandboxed commands. Drops the read protection from filesystem.denyRead and credentials.files deny entries for sandboxed commands, since both are enforced by the filesystem layer this turns off; credentials.files mask entries (sentinel binds) and credentials.envVars deny/mask are unaffected. Only honored from user, managed/policy, or CLI (`--settings`) settings — project settings (.claude/settings.json and .claude/settings.local.json) are ignored. If managed settings configure sandbox.filesystem at all, or list any sandbox.credentials.files deny entry, only managed settings can set this: an admin who deployed filesystem restrictions must not have them switched off by a user-writable file. (sandbox.credentials.envVars and credentials.files mask entries do not pin it — env scrubbing and sentinel binds are independent of the filesystem layer and survive this setting.) When unset, filesystem isolation stays on."),
});

/** The `sandbox.credentials` block. */
export const sandboxCredentialsSchema = z.looseObject({
  files: z.array(sandboxCredentialFileSchema).optional().describe("Credential files or directories to protect. `deny` blocks reads inside the sandbox; `mask` substitutes a sentinel inside the sandbox (whole-file, or per-`extract` capture) and injects the real value at the proxy. On macOS and Windows `mask` degrades to `deny`."),
  envVars: z.array(sandboxCredentialEnvVarSchema).optional().describe("Environment variables to protect. `deny` unsets the variable for sandboxed commands; `mask` substitutes a sentinel inside the sandbox and injects the real value at the proxy."),
  allowPlaintextInject: z.boolean().optional().describe("Allow sentinel→real substitution on the plain-HTTP proxy path. Defaults to false: without TLS termination the upstream identity is unverified and the credential travels in cleartext. Set only for trusted-network test fixtures. Only honored from user, managed/policy, or CLI (`--settings`) settings — project settings (.claude/settings.json and .claude/settings.local.json) are ignored."),
  awsPairs: z.array(sandboxAwsPairSchema).optional().describe("Explicit groupings of masked env vars into AWS credential pairs for SigV4 re-signing, for non-standard variable names. The conventional AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN trio is paired automatically when masked. Only honored from user, managed/policy, or CLI (`--settings`) settings — project settings (.claude/settings.json and .claude/settings.local.json) are ignored. A member is only usable when its env var is forwarded as a whole-value `mask` entry (an entry carrying `extract` or `decode` does not qualify — re-signing needs the whole real value). A pair whose key id or secret member is unusable never re-signs: it is dropped, unless it names a conventional AWS variable, in which case it is forwarded as an inert suppressor so implicit auto-pairing stays overridden. A pair whose ONLY unusable member is the session token still re-signs, without an x-amz-security-token (temporary-credential requests fail upstream until the entry is fixed)."),
  sigv4: sandboxSigv4Schema.optional().describe("Policies for AWS SigV4 request shapes the proxy cannot re-sign (streaming, presigned, sigv4a) when they reference a masked credential pair: `deny` (default) or `passthrough`. Only honored from user, managed/policy, or CLI (`--settings`) settings — project settings (.claude/settings.json and .claude/settings.local.json) are ignored."),
});

/**
 * The `sandbox` block: **sixteen** keys.
 *
 * Fifteen are named by the target's own schema; the sixteenth,
 * `enabledPlatforms`, is read by the target's policy code from the raw block
 * and is named by the audit as one of the five keys the sandbox block carries.
 */
export const sandboxSchema = z.looseObject({
  enabled: z.boolean().optional().describe("Run Bash commands inside the sandbox. Default: false. When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, and managed, --settings or user settings set true, false from project settings (.claude/settings.json and .claude/settings.local.json) is ignored (true there still applies)."),
  enabledPlatforms: z.array(z.string()).optional(),
  failIfUnavailable: z.boolean().optional().describe("Exit with an error at startup if sandbox.enabled is true but the sandbox cannot start (missing dependencies or unsupported platform). When false (default), a warning is shown and commands run unsandboxed. Intended for managed-settings deployments that require sandboxing as a hard gate. When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, and managed, --settings or user settings set true, false from project settings (.claude/settings.json and .claude/settings.local.json) is ignored (true there still applies)."),
  autoAllowBashIfSandboxed: z.boolean().optional(),
  allowUnsandboxedCommands: z.boolean().optional().describe("Allow commands to run outside the sandbox via the dangerouslyDisableSandbox parameter. When false, the dangerouslyDisableSandbox parameter is completely ignored and all commands must run sandboxed. Default: true. A false in managed, --settings or user settings holds whatever project settings (.claude/settings.json and .claude/settings.local.json) say (false there still applies)."),
  network: sandboxNetworkSchema.optional(),
  filesystem: sandboxFilesystemSchema.optional(),
  credentials: sandboxCredentialsSchema.optional(),
  ignoreViolations: z.record(z.string(), z.array(z.string())).optional().describe("Sandbox violations to leave unreported: a map of command patterns (\"*\" for every command) to the filesystem paths whose violations are ignored. Merged across settings sources. When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, values from project settings (.claude/settings.json and .claude/settings.local.json) are ignored."),
  enableWeakerNestedSandbox: z.boolean().optional().describe("Linux only: Run without the fresh /proc mount, for hosts such as unprivileged Docker containers that cannot create one. **Reduces security** — the host /proc stays readable by sandboxed commands. Default: false. When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, true from project settings (.claude/settings.json and .claude/settings.local.json) is ignored (false there still applies)."),
  enableWeakerNetworkIsolation: z.boolean().optional().describe("macOS only: Allow access to com.apple.trustd.agent in the sandbox. Needed for Go-based CLI tools (gh, gcloud, terraform, etc.) to verify TLS certificates when using httpProxyPort with a MITM proxy and custom CA. **Reduces security** — opens a potential data exfiltration vector through the trustd service. Default: false. When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, true from project settings (.claude/settings.json and .claude/settings.local.json) is ignored (false there still applies)."),
  allowAppleEvents: z.boolean().optional().describe("macOS only: Allow sandboxed commands to send Apple Events (and look up the appleeventsd Mach service). Needed for `open`, `osascript`, and browser-based auth flows that open URLs. **Removes code-execution isolation** — sandboxed commands can launch other applications unsandboxed with no user prompt, and can script running apps (e.g. Terminal) subject to the user's per-app TCC automation consent. Only honored from user, managed/policy, or CLI (--settings) settings — project settings (.claude/settings.json and .claude/settings.local.json) are ignored. Default: false"),
  excludedCommands: z.array(z.string()).optional().describe("Command patterns (Bash permission-rule syntax) that always run outside the sandbox. A convenience, not a security boundary: excluded commands still go through the permission flow. Merged across settings sources. When managed settings or a --settings file set allowUnsandboxedCommands: false, or managed settings set network.allowManagedDomainsOnly: true, values from project settings (.claude/settings.json and .claude/settings.local.json) are ignored."),
  ripgrep: sandboxRipgrepSchema.optional().describe("Custom ripgrep configuration for bundled ripgrep support. Only honored from user, managed/policy, or CLI (--settings) settings — project settings (.claude/settings.json and .claude/settings.local.json) are ignored."),
  bwrapPath: z.string().optional().describe("Linux/WSL only: Absolute path to the bwrap (bubblewrap) binary. Overrides auto-detection via PATH. Only honored from admin-controlled managed settings."),
  socatPath: z.string().optional().describe("Linux/WSL only: Absolute path to the socat binary used for the sandbox network proxy. Overrides auto-detection via PATH. Only honored from admin-controlled managed settings."),
});

// --- the hooks block --------------------------------------------------------

/**
 * The **33** hook event names the target's hook schema knows.
 *
 * The list is the target's own (`chunk-c9s0jh80.js`, the `Xc` literal), and it
 * is the same 33 the plan's global constraints name.
 */
export const HOOK_EVENT_NAMES = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PreModelSwitch',
  'PostModelSwitch',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
  'MessageDisplay',
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

/** One hook command. The target models the five kinds as a union on `type`. */
export const hookCommandSchema = z.looseObject({
  type: z.enum(['command', 'prompt', 'mcp_tool', 'http', 'agent']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedEnvVars: z.array(z.string()).optional(),
  shell: z.enum(['bash', 'powershell']).optional(),
  timeout: z.number().positive().optional(),
  onFailure: z.enum(['continue', 'block']).optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
  async: z.boolean().optional(),
  asyncRewake: z.boolean().optional(),
  model: z.string().optional(),
});

/** One matcher group: a matcher and the hooks it selects. */
export const hookMatcherGroupSchema = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(hookCommandSchema),
});

/**
 * The `hooks` block: a **partial** record of hook event name to matcher groups.
 *
 * The target's own record is partial, so a document that names one event is
 * valid and a document that names an event the target does not know is not.
 */
export const hooksSchema = z.partialRecord(
  z.enum(HOOK_EVENT_NAMES),
  z.array(hookMatcherGroupSchema),
);

// --- the marketplace blocks -------------------------------------------------

/** The kinds of marketplace source the target knows. */
export const MARKETPLACE_SOURCE_KINDS = [
  'github',
  'git',
  'url',
  'npm',
  'pluginDirectory',
  'settings',
] as const;

export const marketplaceSourceKindSchema = z.enum(MARKETPLACE_SOURCE_KINDS);

/** A marketplace declaration. */
export const marketplaceSourceSchema = z.looseObject({
  source: marketplaceSourceKindSchema,
  installLocation: z.string().optional(),
  autoUpdate: z.boolean().optional(),
});

/** One entry of a marketplace allow- or block-list. */
export const marketplaceEntrySchema = z.looseObject({
  source: z.string(),
  repo: z.string().optional(),
  url: z.string().optional(),
  registry: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  headersHelper: z.string().optional(),
  plugins: z.array(z.unknown()).optional(),
});

/** One entry of the marketplace block-list. */
export const blockedMarketplaceSchema = z.looseObject({
  source: z.string(),
  repo: z.string().optional(),
  url: z.string().optional(),
  registry: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
});

/** The `extraKnownMarketplaces` / `additionalMarketplaces` record. */
export const marketplacesSchema = z.record(z.string(), marketplaceSourceSchema);

// --- the MCP server blocks --------------------------------------------------

/** One MCP server the organization delivers. */
export const managedMcpServerSchema = z.looseObject({
  type: z.enum(['http', 'sse']).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/** One entry of the enterprise MCP allow-list. */
export const allowedMcpServerSchema = z.looseObject({
  serverName: z.string().optional(),
  serverCommand: z.string().optional(),
  serverUrl: z.string().optional(),
});

/** One entry of the enterprise MCP deny-list. */
export const deniedMcpServerSchema = z.looseObject({
  serverName: z.string().optional(),
  serverCommand: z.string().optional(),
  serverUrl: z.string().optional(),
});

// --- the model blocks -------------------------------------------------------

/** One row of the `/model` picker. */
export const modelPickerOptionSchema = z.looseObject({
  model: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
});

/** One row of the contracted-price table. */
export const modelPricingRowSchema = z.looseObject({
  input: z.number().min(0).max(1e4),
  output: z.number().min(0).max(1e4),
  cacheRead: z.number().min(0).max(1e4),
  cacheWrite: z.number().min(0).max(1e4),
});

/** The providers a managed document may allow. */
export const ALLOWED_PROVIDERS = [
  'anthropic',
  'customEndpoint',
  'bedrock',
  'vertex',
  'foundry',
  'anthropicAws',
  'mantle',
  'gateway',
] as const;

export type AllowedProvider = (typeof ALLOWED_PROVIDERS)[number];

/** One model's own settings. */
export const modelSettingSchema = z.looseObject({
  effortLevel: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  maxEffortLevel: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  autoCompactWindow: z
    .union([z.literal('auto'), z.number().int().min(100000).max(1000000).optional()])
    .optional(),
});

/** The auto-compact window, in tokens. */
export const autoCompactWindowSchema = z.number().int().min(100000).max(1000000).optional().catch(undefined);

// --- the policy-helper blocks ------------------------------------------------

/** One policy helper: a program the target runs to compute managed settings. */
export const policyHelperSchema = z.looseObject({
  path: z.string().optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  refreshIntervalMs: z.union([z.literal(0), z.number().int().min(60000)]).optional(),
});

/** One per-OS policy-helper entry. */
export const policyHelperEntrySchema = z.looseObject({
  path: z.string().optional(),
  script: z.string().optional(),
  interpreter: z.string().optional(),
  outputBehavior: z.enum(['replace', 'merge']).optional(),
  onFailure: z.enum(['continue', 'refuse']).optional(),
  retries: z.number().int().optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  refreshIntervalMs: z.union([z.literal(0), z.number().int().min(60000)]).optional(),
  defaultSettings: z.record(z.string(), z.unknown()).optional(),
});

/** The per-OS policy-helper map. */
export const policyHelpersSchema = z.looseObject({
  macos: policyHelperEntrySchema.optional(),
  linux: policyHelperEntrySchema.optional(),
  windows: policyHelperEntrySchema.optional(),
  wsl: policyHelperEntrySchema.optional(),
  default: policyHelperEntrySchema.optional(),
});


/**
 * The sentinel the target substitutes for a footer-link entry it does not
 * understand, and then filters out.
 */
export const INVALID_FOOTER_LINK = Object.freeze({ type: 'invalid-entry-stripped' });

// --- the remaining sub-schemas ----------------------------------------------

/** One footer-link badge. */
export const footerLinkSchema = z.union([
  z.looseObject({ type: z.literal('regex'), pattern: z.string().optional(), label: z.string().optional() }),
  z.looseObject({ type: z.string() }),
]);

/** One channel plugin. */
export const channelPluginSchema = z.looseObject({
  marketplace: z.string(),
  plugin: z.string(),
});

/** One spinner tip. */
export const spinnerTipSchema = z.looseObject({
  id: z.string().optional(),
  text: z.string().optional(),
  cooldownSessions: z.number().optional(),
  priority: z.number().optional(),
});

/** The spinner tip list. */
export const spinnerTipsSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter(
          (entry) =>
            typeof entry === 'string' ||
            (typeof entry === 'object' && entry !== null && !Array.isArray(entry)),
        )
      : value,
  z.array(z.union([z.string(), spinnerTipSchema])),
);

/** The surfaces `strictPluginOnlyCustomization` can lock. */
export const STRICT_PLUGIN_ONLY_SURFACES = ['skills', 'agents', 'hooks', 'mcp'] as const;

/** The `strictPluginOnlyCustomization` key. */
export const strictPluginOnlyCustomizationSchema = z.preprocess(
  (value) => {
    if (!Array.isArray(value)) return value;
    return value.filter((entry) => (STRICT_PLUGIN_ONLY_SURFACES as readonly string[]).includes(entry));
  },
  z.union([z.boolean(), z.array(z.enum(STRICT_PLUGIN_ONLY_SURFACES))]),
);

/** The `attribution` object. */
export const attributionObjectSchema = z.looseObject({
  commit: z.string().optional(),
  pr: z.string().optional(),
  sessionUrl: z.boolean().optional(),
});

/**
 * Strip the `Object.prototype` member names from a record.
 *
 * The target's `modelSettings` preprocess drops a key that names an
 * `Object.prototype` member, so a settings file cannot smuggle one into the
 * per-model map.
 */
export function stripPrototypeKeys(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Object.hasOwn(Object.prototype, key)) continue;
    out[key] = entry;
  }
  return out;
}


// --- the settings document --------------------------------------------------

/**
 * The **183** top-level keys the target's settings document accepts, in the
 * target's own order.
 *
 * The order is the order of the object literal the target's settings factory
 * returns (`chunk-c9s0jh80.js:253945`–`323785`), so a caller that lists the
 * keys gets the target's listing.
 */
export const SETTINGS_DOCUMENT_KEYS = [
  '$schema',
  'apiKeyHelper',
  'proxyAuthHelper',
  'awsCredentialExport',
  'awsAuthRefresh',
  'gcpAuthRefresh',
  'processWrapper',
  'policyHelper',
  'policyHelpers',
  'fileSuggestion',
  'respectGitignore',
  'breakReminder',
  'quietHours',
  'cleanupPeriodDays',
  'desktopSessionCleanupPeriodDays',
  'syncClaudeAiSkills',
  'syncClaudeAiPlugins',
  'skillListingMaxDescChars',
  'skillListingBudgetFraction',
  'wslInheritsWindowsSettings',
  'env',
  'attribution',
  'includeCoAuthoredBy',
  'includeGitInstructions',
  'permissions',
  'model',
  'fallbackModel',
  'availableModels',
  'enforceAvailableModels',
  'availableModelsMatch',
  'deniedModels',
  'modelOverrides',
  'modelPicker',
  'modelPricing',
  'enableAllProjectMcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'disableClaudeAiConnectors',
  'skillOverrides',
  'disableBundledSkills',
  'managedMcpServers',
  'allowedMcpServers',
  'deniedMcpServers',
  'hooks',
  'worktree',
  'disableAllHooks',
  'disableAgentView',
  'disableRemoteControl',
  'disableWorkflows',
  'disableArtifact',
  'enableArtifact',
  'enableWorkflows',
  'workflowSizeGuideline',
  'workflowKeywordTriggerEnabled',
  'disableSkillShellExecution',
  'defaultShell',
  'bashEditDiffEnabled',
  'bashOutputMaxChars',
  'taskOutputMaxChars',
  'respondToBashCommands',
  'allowManagedHooksOnly',
  'allowedHttpHookUrls',
  'httpHookAllowedEnvVars',
  'allowManagedPermissionRulesOnly',
  'allowManagedMcpServersOnly',
  'allowAllClaudeAiMcps',
  'allowClaudeInChromeWithManagedMcp',
  'strictPluginOnlyCustomization',
  'statusLine',
  'prUrlTemplate',
  'footerLinksRegexes',
  'subagentStatusLine',
  'enabledPlugins',
  'prependPlugins',
  'appendPlugins',
  'extraKnownMarketplaces',
  'additionalMarketplaces',
  'strictKnownMarketplaces',
  'allowedMarketplaces',
  'blockedMarketplaces',
  'disableCommandPluginSources',
  'disableSideloadFlags',
  'pluginSuggestionMarketplaces',
  'forceLoginMethod',
  'forceLoginGatewayUrl',
  'gatewayInternalNetworks',
  'parentSettingsBehavior',
  'managedSourcesBehavior',
  'forceLoginOrgUUID',
  'allowedProviders',
  'forceRemoteSettingsRefresh',
  'otelHeadersHelper',
  'outputStyle',
  'viewMode',
  'language',
  'skipWebFetchPreflight',
  'sandbox',
  'feedbackSurveyRate',
  'feedbackDrafts',
  'spinnerTipsEnabled',
  'spinnerVerbs',
  'spinnerTipsOverride',
  'syntaxHighlightingDisabled',
  'maxProseWidth',
  'spellcheck',
  'terminalTitleFromRename',
  'promptCacheTtl',
  'subagentPromptCacheTtl',
  'alwaysThinkingEnabled',
  'effortLevel',
  'maxEffortLevel',
  'modelSettings',
  'ultracode',
  'autoCompactWindow',
  'advisorModel',
  'fastMode',
  'fastModePerSessionOptIn',
  'promptSuggestionEnabled',
  'emojiCompletionEnabled',
  'awaySummaryEnabled',
  'showClearContextOnPlanAccept',
  'askUserQuestionTimeout',
  'dialogExpiry',
  'agent',
  'modelProposedGoals',
  'companyAnnouncements',
  'pluginConfigs',
  'remote',
  'autoUpdatesChannel',
  'minimumVersion',
  'requiredMinimumVersion',
  'requiredMaximumVersion',
  'plansDirectory',
  'tui',
  'voice',
  'channelsEnabled',
  'allowedChannelPlugins',
  'prefersReducedMotion',
  'timeFormat',
  'timeZone',
  'doneMeansMerged',
  'totalTokensReminder',
  'totalTokensReminderBudget',
  'totalTokensReminderAfterUserTurn',
  'autoMemoryEnabled',
  'autoMemoryDirectory',
  'autoDreamEnabled',
  'showThinkingSummaries',
  'skipDangerousModePermissionPrompt',
  'skipWorkflowUsageWarning',
  'disableAutoMode',
  'remoteTools',
  'sshConfigs',
  'claudeMd',
  'claudeMdExcludes',
  'pluginTrustMessage',
  'theme',
  'editorMode',
  'keybindingFlavor',
  'vimInsertModeRemaps',
  'verbose',
  'preferredNotifChannel',
  'autoCompactEnabled',
  'precomputeCompactionEnabled',
  'idleCompaction',
  'switchModelsOnFlag',
  'autoContinueAtUsageLimit',
  'autoScrollEnabled',
  'wheelScrollAccelerationEnabled',
  'fileCheckpointingEnabled',
  'showTurnDuration',
  'showMessageTimestamps',
  'terminalProgressBarEnabled',
  'todoFeatureEnabled',
  'teammateMode',
  'remoteControlAtStartup',
  'remoteControl',
  'isolatePeerMachines',
  'daemonColdStart',
  'crossSessionInbound',
  'autoUploadSessions',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
] as const;

export type SettingsDocumentKey = (typeof SETTINGS_DOCUMENT_KEYS)[number];

/**
 * The **seven** top-level keys the target's *gated blocks* contribute.
 *
 * The target builds the document from a factory and then merges the shapes of
 * the blocks that are switched on (`chunk-c9s0jh80.js:223884`). Five blocks
 * exist — `autoMode`, `deepLink`, `voice`, `briefView` and `screenReader` — and
 * they contribute these seven top-level keys, which are **not** in the 183-key
 * list. The `autoMode` block contributes one more key, `disableAutoMode`, to
 * the **permissions** sub-schema.
 */
export const GATED_SETTINGS_KEYS = [
  'skipAutoPermissionPrompt',
  'useAutoModeDuringPlan',
  'autoMode',
  'disableDeepLinkRegistration',
  'voiceEnabled',
  'defaultView',
  'axScreenReader',
] as const;

export type GatedSettingsKey = (typeof GATED_SETTINGS_KEYS)[number];

/** The `autoMode` block's own shape: the auto-mode classifier prompt. */
export const autoModeBlockSchema = z.looseObject({
  allow: z.array(z.string()).optional(),
  soft_deny: z.array(z.string()).optional(),
  hard_deny: z.array(z.string()).optional(),
  environment: z.array(z.string()).optional(),
  classifyAllShell: z.boolean().optional(),
});

/**
 * The settings document schema.
 *
 * The shape is the target's own: the 183 keys, the seven gated-block keys, the
 * `permissions` block and the `sandbox` block. The object is **loose**, because
 * the target's is (`cc(…)` + `.passthrough()`): a settings file written by a
 * newer release keeps its extra keys.
 */
export const settingsDocumentSchema = z.looseObject({
  // --- the gated blocks ---
  skipAutoPermissionPrompt: z
    .boolean()
    .optional()
    .describe('Whether the user has accepted the auto mode opt-in dialog'),
  useAutoModeDuringPlan: z
    .boolean()
    .optional()
    .describe(
      'Whether plan mode uses auto mode semantics when auto mode is available (default: true)',
    ),
  autoMode: autoModeBlockSchema
    .optional()
    .describe('Auto mode classifier prompt customization'),
  disableDeepLinkRegistration: z
    .literal('disable')
    .optional()
    .describe('Prevent prricode:// protocol handler registration with the OS'),
  voiceEnabled: z.boolean().optional().describe('Enable voice mode (hold-to-talk dictation)'),
  defaultView: z
    .enum(['chat', 'transcript'])
    .optional()
    .describe('Default transcript view: chat (SendUserMessage checkpoints only) or transcript (full)'),
  axScreenReader: z
    .boolean()
    .optional()
    .describe(
      'Render screen-reader friendly output (flat text, no decorative borders or animations). Overridden by the CLAUDE_AX_SCREEN_READER env var and the --ax-screen-reader CLI flag.',
    ),

  // --- the 183 keys ---
  $schema: z.string().optional().describe("JSON Schema reference for PRRICODE settings"),
  apiKeyHelper: z.string().optional().describe("Path to a script that outputs authentication values"),
  proxyAuthHelper: z.string().optional().describe("Shell command that outputs a Proxy-Authorization header value (EAP)"),
  awsCredentialExport: z.string().optional().describe("Path to a script that exports AWS credentials"),
  awsAuthRefresh: z.string().optional().describe("Path to a script that refreshes AWS authentication"),
  gcpAuthRefresh: z.string().optional().describe("Command to refresh GCP authentication (e.g., gcloud auth application-default login)"),
  processWrapper: z.string().optional().describe("Corporate launcher argv prefix for the background-agent supervisor, the sessions and workers it hosts, and the other covered background processes listed in the PRRICODE corporate-launcher documentation. Equivalent to the CLAUDE_CODE_PROCESS_WRAPPER environment variable, which takes precedence when set. Honored from managed settings, a --settings/SDK-supplied settings file, and user settings, in that precedence order; project and local settings are ignored."),
  policyHelper: policyHelperSchema.optional().catch(undefined).describe("Executable that computes managed settings at startup. Honored only from admin-controlled policy sources."),
  policyHelpers: policyHelpersSchema.optional().catch(undefined).describe("@internal Per-OS variant of policyHelper, keyed by platform: macos, linux, windows, wsl, plus an optional \"default\" entry that is a STATIC settings payload (a JSON object of managed settings, not a helper). Each per-OS entry carries a helper — a \"path\", or an inline \"script\" + \"interpreter\" delivered to a fixed interpreter over stdin, either with timeoutMs/refreshIntervalMs — its own static \"defaultSettings\" payload, or both; an entry may be payload-only. Selection for a platform walks its chain (the platform's own entry; on wsl the linux entry next): the first helper on the chain wins over policyHelper; if no helper is configured — or the selected helper fails at startup or refresh — the first payload applies (the chain's \"defaultSettings\" in platform-specific-first order, then the top-level \"default\", applied with no process spawned; unrecognized platforms reach only \"default\"); with no payload either, policyHelper. Honored from admin-controlled policy sources, and from remote managed settings — a payload of plain policy as delivered, like any other remote key; a helper, or a payload carrying anything the managed-settings approval dialog lists, only once the settings are verified this session and approved there (policyHelper itself is never honored from remote)."),
  fileSuggestion: z.object({
    type: z.literal("command"),
    command: z.string(),
}).optional().describe("Custom file suggestion configuration for @ mentions"),
  respectGitignore: z.boolean().optional().describe("Whether file picker should respect .gitignore files (default: true). Note: .ignore files are always respected."),
  breakReminder: z.object({
    enabled: z.boolean().optional(),
    intervalMinutes: z.number().int().positive().optional(),
    breakThresholdMinutes: z.number().int().positive().optional(),
    message: z.string().optional(),
}).optional().describe("@internal Opt-in break reminder. When enabled, shows a dismissible nudge after sustained continuous use. Never blocks — just a friendly heads-up."),
  quietHours: z.object({
    enabled: z.boolean().optional(),
    start: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/,'Expected 24-hour local time "HH:MM" (e.g. "22:00")').optional(),
    end: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/,'Expected 24-hour local time "HH:MM" (e.g. "07:00")').optional(),
}).optional().describe("@internal Opt-in quiet hours. When enabled, shows a single soft nudge per session while inside the configured local-time window. Never blocks."),
  cleanupPeriodDays: z.number().int().positive().optional().describe("Number of days to retain chat transcripts before automatic cleanup (default: 30). Minimum 1. Use a large value for long retention; use --no-session-persistence to disable transcript writes entirely."),
  desktopSessionCleanupPeriodDays: z.number().int().nonnegative().optional().describe("Retention ceiling in days for session transcripts created or last written by a desktop-host surface (PRRICODE Desktop, Cowork), which are otherwise exempt from the cleanupPeriodDays sweep. 0 (the default) means no ceiling: such transcripts are kept until deleted another way. Unlike cleanupPeriodDays, 0 is allowed because this setting never disables writes — it only bounds an exemption from deletion. The ceiling is a hard cap: it also bounds an active archive grace, so the grace window of a release marker never keeps files past the ceiling. Ignored when cleanupPeriodDays is managed by org policy. A ceiling at or below cleanupPeriodDays effectively disables the exemption: those transcripts age out on the regular cleanupPeriodDays schedule, so the effective retention is whichever of the two periods is longer."),
  syncClaudeAiSkills: z.boolean().optional().describe("Set to false to turn off syncing of the skills you have enabled on claude.ai. In your user settings (or managed settings): nothing more is downloaded, previously synced skills (~/.claude/skills/synced) can no longer be run, are hidden from every session started afterwards, and are moved to ~/.claude/skills/.trash at the next launch (deleted after cleanupPeriodDays; re-downloaded, not restored, if you re-enable). In .claude/settings.local.json or --settings: downloads stop and synced skills are blocked and hidden for sessions in that workspace or invocation only (nothing is moved). Not read from project settings (.claude/settings.json). Only false is honored — the feature is enabled server-side for your account, so setting true does not turn it on early. While it is on, synced skills are available in every session, re-synced about every 10 minutes while a session is in use and a quarter as often otherwise, and removed when you disable them on claude.ai. Only applies when signed in with your PRRICODE account."),
  syncClaudeAiPlugins: z.boolean().optional().describe("Set to false to turn off syncing of the plugins you have enabled on claude.ai. In your user settings (or managed settings): nothing more is downloaded, previously synced plugins (~/.claude/plugins/synced) are hidden from every session started afterwards and moved to ~/.claude/plugins/.trash at the next launch (deleted after cleanupPeriodDays; re-downloaded, not restored, if you re-enable). In .claude/settings.local.json or --settings: downloads stop and synced plugins are hidden for sessions in that workspace or invocation only (nothing is moved). Not read from project settings (.claude/settings.json). Only false is honored — the feature is enabled server-side for your account, so setting true does not turn it on early. While it is on, synced plugins load in every session like plugins you installed yourself (a plugin you installed with the same name takes precedence), are re-synced at each launch, and are removed when you disable them on claude.ai. Only applies when signed in with your PRRICODE account."),
  skillListingMaxDescChars: z.number().int().positive().optional().describe("Per-skill description character cap in the skill listing sent to PRRICODE (default: 1536). Descriptions longer than this are truncated. Raise to opt in to higher per-turn context cost."),
  skillListingBudgetFraction: z.number().gt(0).lte(1).optional().describe("Fraction of the context window (in characters) reserved for the skill listing sent to PRRICODE (default: 0.01 = 1%). When the listing exceeds this, descriptions are shortened to fit. Raise to opt in to higher per-turn context cost."),
  wslInheritsWindowsSettings: z.boolean().optional().describe("When set to true in either admin-only Windows source — the HKLM SOFTWARE/Policies/PRRICODECode registry key or C:/Program Files/PRRICODECode/managed-settings.json — WSL reads managed settings from the full Windows policy chain (HKLM, C:/Program Files/PRRICODECode via DrvFs, HKCU) in addition to /etc/claude-code. Windows sources take priority. The flag is also required in HKCU itself for HKCU policy to apply on WSL (double opt-in: admin enables the chain, user confirms HKCU). On native Windows the flag has no effect."),
  env: z.record(z.string(), z.string()).optional().describe("Environment variables to set for PRRICODE sessions"),
  attribution: z.union([z.boolean(), attributionObjectSchema])
    .transform((value) =>
      typeof value === 'boolean'
        ? value
          ? {}
          : { commit: '', pr: '', sessionUrl: false }
        : value,
    )
    .pipe(attributionObjectSchema)
    .optional().describe("Customize attribution text for commits and PRs. Each field defaults to the standard PRRICODE attribution if not set. Set to false to hide all attribution, the same as { \"commit\": \"\", \"pr\": \"\", \"sessionUrl\": false }. Setting it to true is the same as leaving it out. Older PRRICODE versions reject true or false here, so use the object form in settings files shared across versions."),
  includeCoAuthoredBy: z.boolean().optional().describe("Deprecated: Use attribution instead. Whether to include PRRICODE's co-authored by attribution in commits and PRs (defaults to true)"),
  includeGitInstructions: z.boolean().optional().describe("Include built-in commit and PR workflow instructions in PRRICODE's system prompt (default: true)"),
  permissions: permissionsSchema.optional().describe("Tool usage permissions configuration"),
  model: z.string().optional().describe("Override the default model used by PRRICODE"),
  fallbackModel: z.array(z.string()).optional().describe("Fallback model(s) tried in order when the primary model is overloaded or unavailable. Each element accepts a model name or alias; \"default\" expands to the default model. CLI --fallback-model takes precedence."),
  availableModels: z.array(z.string()).optional().describe("Allowlist of models that users can select. Accepts family aliases (\"opus\" allows any opus version), version prefixes (\"opus-4-5\" allows that version and any model ID that extends it, so \"claude-opus-5\" also allows \"claude-opus-5-5\"), and full model IDs. If undefined, all models are available. If empty array, only the default model is available. Typically set in managed settings by enterprise administrators."),
  enforceAvailableModels: z.boolean().optional().describe("When true and availableModels is a non-empty array, the Default model selection is also constrained: if the default model for the user tier is not in availableModels, Default resolves to the first allowed availableModels entry instead. Has no effect when availableModels is unset or an empty array. Typically set in managed settings by enterprise administrators."),
  availableModelsMatch: z.enum(["prefix", "exact"]).optional().describe("How availableModels entries match model IDs. \"prefix\" (the default) lets an entry also allow any model ID that extends it, so \"claude-opus-5\" allows \"claude-opus-5-5\". \"exact\" keeps that matching but stops a model ID entry from allowing other versions: \"claude-opus-5\" allows Opus 5 and its dated and -fast IDs, but not Opus 5.5 or a later release until it is listed, and a -latest ID needs a -latest entry. Family aliases (\"opus\") still allow the whole family; aliases whose model depends on the release or settings (best, opusplan, default) are ignored. With \"exact\" and a list that names at least one model, the Default option also uses only a listed model; if none can be used, PRRICODE will not start. Haiku background models, and hooks and other helper requests that pick their own model, are not restricted (deniedModels covers them; allowManagedHooksOnly limits hooks). Read from managed settings only."),
  deniedModels: z.array(z.string()).optional().describe("Models users cannot select, even when availableModels allows them. A family alias (\"opus\") blocks that family. A model ID blocks that version in every spelling: dates, -fast and provider prefixes are ignored, so \"claude-opus-5-5\" blocks every Opus 5.5 ID but not Opus 5. An ID with no minor version (\"claude-opus-5\") also blocks later minor versions, as it allows them in availableModels. Aliases whose model depends on the release or settings (best, opusplan, default) are ignored. The Default option steps down past a blocked model; if the Default has no allowed model to step down to, PRRICODE will not start. Read from managed settings only."),
  modelOverrides: z.record(z.string(), z.string()).optional().describe("Override mapping from Anthropic model ID (e.g. \"claude-opus-4-6\") to provider-specific model ID (e.g. a Bedrock inference profile ARN). Typically set in managed settings by enterprise administrators."),
  modelPicker: z.object({
    options: z.array(modelPickerOptionSchema),
    replaceBuiltInOptions: z.boolean().optional(),
}).optional().describe("Curate the /model picker: an ordered list of models with your own labels, independent of the built-in lineup and of PRRICODE releases. availableModels still applies to these rows. Honored from managed, --settings/SDK, and user settings only (not from a project checkout); the highest-precedence of those that defines modelPicker wins outright (no merging across sources). Typically set in managed settings by enterprise administrators."),
  modelPricing: z.object({
    multiplier: z.number().gt(0).lte(10).optional(),
    overrides: z.record(z.string(), modelPricingRowSchema).optional(),
}).optional().describe("Price usage at your organization's contracted rates instead of list price. Affects every spend figure PRRICODE reports — /cost, the status line, the SDK total_cost_usd, --max-budget-usd, and the OpenTelemetry cost metric and events — which remain USD estimates, not an invoice (the per-Mtok price labels in /model stay at list). \"overrides\" maps a model ID to its USD-per-million-token rates (input, output, cacheRead, cacheWrite — all four required, each 0 to 10000; cacheWrite prices both 5-minute and 1-hour cache writes). A matching row is charged exactly as written; fast-mode and US-data-residency surcharges are not added on top. A key PRRICODE itself uses for a built-in model — its ID such as \"claude-sonnet-4-6\", or its first-party, Bedrock (any or no region prefix), Vertex or Foundry ID — covers every dated and provider form of that model; any other key — a gateway model alias, or a spelling PRRICODE does not itself use — matches that model ID only (case-insensitive), and such an exact match wins over a built-in row. On Bedrock an application inference profile is matched by its backing model. An invalid row or multiplier is reported and skipped; the rest still apply. \"multiplier\" in (0, 10] scales every computed cost, overridden or not (0.85 = 85% of the price, 1.2 = 120%). Only honored from managed settings (server-managed, MDM / OS policy, or managed-settings.json), or — when none of those sets it — when supplied by a host application that manages the model provider; ignored in user, project, local and --settings sources."),
  enableAllProjectMcpServers: z.boolean().optional().describe("Whether to automatically approve all MCP servers in the project"),
  enabledMcpjsonServers: z.array(z.string()).optional().describe("List of approved MCP servers from .mcp.json"),
  disabledMcpjsonServers: z.array(z.string()).optional().describe("List of rejected MCP servers from .mcp.json"),
  disableClaudeAiConnectors: z.boolean().optional().describe("When true in any settings source, claude.ai MCP cloud connectors are not auto-fetched or connected, and a claudeai-proxy server passed explicitly (e.g. via --mcp-config or the SDK mcpServers option) does not connect either. Any-source-true wins: a project can opt out, but a project-level false cannot override a user-level true."),
  skillOverrides: z.record(z.string(), z.enum(["on", "name-only", "user-invocable-only", "off"])).optional().describe("Per-skill listing overrides keyed by skill name. \"name-only\" lists the skill without its description; \"user-invocable-only\" hides it from the model but keeps /name; \"off\" hides it from both. Absent = on."),
  disableBundledSkills: z.boolean().optional().describe("Disable the skills and workflows that ship with PRRICODE: bundled skills and workflows are removed entirely; built-in slash commands stay typable but are hidden from the model. Plugins, .claude/skills/, and .claude/commands/ are unaffected. Equivalent to CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1."),
  managedMcpServers: z.record(z.string(), managedMcpServerSchema).optional().describe("MCP servers the organization provides to every user, keyed by server name, each with the .mcp.json entry shape; only \"http\" and \"sse\" servers are accepted (nothing that names a program to run, no ${VAR} references). Honored from managed settings only; users cannot remove them, deniedMcpServers still applies, and they need no allowedMcpServers entry. Not read in PRRICODE Desktop's Code tab on a third-party deployment or in Cowork sessions, where PRRICODE Desktop supplies and locks the session's MCP servers itself."),
  allowedMcpServers: z.array(allowedMcpServerSchema).optional().describe("Enterprise allowlist of the MCP servers users may use. Governs servers users add (user, project and local config, --mcp-config, agent frontmatter, plugins, claude.ai connectors); servers the organization itself delivers (managedMcpServers, and managed-mcp.json entries that use no ${VAR} expansion) are allowed without being listed; a managed-mcp.json entry that uses ${VAR} expansion is still checked against this list. If undefined, all servers are allowed. If empty array, users can use no servers of their own. Denylist takes precedence - if a server is on both lists, it is denied."),
  deniedMcpServers: z.array(deniedMcpServerSchema).optional().describe("Enterprise denylist of MCP servers that are explicitly blocked. If a server is on the denylist, it will be blocked across all scopes including enterprise. Denylist takes precedence over allowlist - if a server is on both lists, it is denied."),
  hooks: hooksSchema.optional().describe("Custom commands to run before/after tool executions"),
  worktree: z.object({
    symlinkDirectories: z.array(z.string()).optional(),
    sparsePaths: z.array(z.string()).optional(),
    baseRef: z.enum(["fresh", "head"]).optional(),
    bgIsolation: z.enum(["worktree", "none"]).optional().catch(undefined),
    location: z.string().optional().catch(undefined),
}).optional().describe("Git worktree configuration: the CLI --worktree flag, EnterWorktree and agent isolation, plus the location PRRICODE Desktop uses for SSH-session worktrees on this machine."),
  disableAllHooks: z.boolean().optional().describe("Disable all hooks and statusLine execution: the hooks defined in settings files and by installed plugins. Features built into PRRICODE are not hooks in this sense and keep working; each has its own switch."),
  disableAgentView: z.boolean().optional().describe("Disable agent view (`prricode agents`, `--bg`, /background, the on-demand daemon). Typically set in managed settings. Equivalent to CLAUDE_CODE_DISABLE_AGENT_VIEW=1."),
  disableRemoteControl: z.boolean().optional().describe("Disable Remote Control (claude.ai/code, `prricode remote-control`, `--remote-control`/`--rc`, auto-start, and the in-session toggle). Typically set in managed settings."),
  disableWorkflows: z.boolean().optional().describe("Disable the Workflows feature. Code Review on pull requests and /ultrareview run in Anthropic's cloud and are not stopped by this setting, except an /ultrareview that has to restart partway through. A machine that runs a review itself refuses it when that machine's own administrator set this, or CLAUDE_CODE_DISABLE_WORKFLOWS in an `env` block, in its managed settings (MDM, the managed-settings file or an administrator's policy helper). Set in the environment before PRRICODE starts, CLAUDE_CODE_DISABLE_WORKFLOWS disables Workflows. Beyond the cases above it stops a review only when the review's own session starts with it set."),
  disableArtifact: z.boolean().optional().describe("Deprecated: use enableArtifact: false. Still honored — true disables the Artifact tool; false is ignored."),
  enableArtifact: z.boolean().optional().describe("Turn the Artifact tool on or off. Off in any of managed, --settings, or user settings wins; project and local settings can only turn it off. Unset defaults to on once the feature is available."),
  enableWorkflows: z.boolean().optional().describe("Enable or disable the Workflows feature for this user. Unset = default by plan once the feature is available."),
  workflowSizeGuideline: z.enum(["unrestricted", "small", "medium", "large"]).optional().describe("Advisory size guideline for the dynamic workflows PRRICODE writes: \"small\" aims for fewer than 5 agents, \"medium\" fewer than 10, \"large\" fewer than 50, and \"unrestricted\" sends no guideline. Unset defaults to \"medium\", or \"small\" on Pro plans. A value here — including from managed settings — takes precedence over the \"Dynamic workflow size\" choice in /config, and that /config row is hidden while a settings file provides the key. This is a guideline, not an enforced limit."),
  workflowKeywordTriggerEnabled: z.boolean().optional().describe("Enable the \"ultracode\" keyword trigger: including the keyword in a prompt opts that turn into the Workflow tool. Set to false to disable the trigger. Default: true."),
  disableSkillShellExecution: z.boolean().optional().describe("Disable inline shell execution in skills and custom slash commands from user, project, or plugin sources. Commands are replaced with a placeholder instead of being run."),
  defaultShell: z.enum(["bash", "powershell"]).optional().describe("Default shell for input-box ! commands. Defaults to 'bash' on all platforms (no Windows auto-flip)."),
  bashEditDiffEnabled: z.boolean().optional().describe("Whether the Bash tool shows a diff of the files a Bash command changed (PostToolUse Bash hooks get the changed-file list in tool_response). Set to false to turn that off. Default: on when the Bash tool handles file edits. Only user, flag or policy settings can turn it on outside auto and bypassPermissions modes."),
  bashOutputMaxChars: z.number().int().positive().optional().catch(undefined).describe("How many characters of a successful Bash or PowerShell command's output PRRICODE receives inline (default 30000; values clamp to 4000-128000). Output past this is saved to a file and PRRICODE receives a short preview plus the path. When set, this also replaces BASH_MAX_OUTPUT_LENGTH, which on its own only sizes the read-back window."),
  taskOutputMaxChars: z.number().int().positive().optional().catch(undefined).describe("Deprecated: no longer has any effect (the TaskOutput tool was removed). Read a background task's output file with the Read tool instead."),
  respondToBashCommands: z.boolean().optional().describe("Whether PRRICODE responds after an input-box ! bash command runs. Set to false to add the command output to context without a response. Default: true."),
  allowManagedHooksOnly: z.boolean().optional().describe("When true (and set in managed settings), only hooks from managed settings and from plugins that managed settings enable run. User, project, and local hooks and the hooks of plugins the user installed are ignored. Features built into PRRICODE are not hooks in this sense and keep working."),
  allowedHttpHookUrls: z.array(z.string()).optional().describe("Allowlist of URL patterns that HTTP hooks may target. Supports * as a wildcard (e.g. \"https://hooks.example.com/*\"). When set, HTTP hooks with non-matching URLs are blocked. If undefined, all URLs are allowed. If empty array, no HTTP hooks are allowed. Arrays merge across settings sources (same semantics as allowedMcpServers)."),
  httpHookAllowedEnvVars: z.array(z.string()).optional().describe("Allowlist of environment variable names HTTP hooks may interpolate into headers. When set, each hook's effective allowedEnvVars is the intersection with this list. If undefined, no restriction is applied. Arrays merge across settings sources (same semantics as allowedMcpServers)."),
  allowManagedPermissionRulesOnly: z.boolean().optional().describe("When true (and set in managed settings), permission rules from user, project, local, and --settings files and allow rules from --allowedTools are ignored; only managed settings can add allow rules through settings. The allowed-tools frontmatter of skills and custom commands from user, project, and --add-dir sources, and of plugins no managed setting vouches for, is ignored too. Plugins keep theirs only on an admin-backed channel: host-delivered --plugin-dir plugins, the official marketplace registered from its unpinned anthropics source, claude.ai-synced plugins Anthropic attests, the saved login organization's claude.ai-hosted marketplaces, marketplaces whose registered source managed extraKnownMarketplaces declares or an exact or owner-pinned (owner/*) strictKnownMarketplaces entry names at the path it pins (an npm marketplace source only when the registration and the declared entry pin the same registry, and a settings marketplace source only when every nested npm plugin entry pins one on a bare package name — unpinned, the package resolves through the member's own npm config, and a non-bare spelling packs as an exotic spec the pin does not bind, so nothing an entry names is what was fetched), and npm-direct (package@npm) plugins whose recorded resolution a registry-pinned managed npm strictKnownMarketplaces entry names (host and path patterns and enabledPlugins ids do not vouch); managed and bundled skills keep theirs. --disallowedTools, skill disallowed-tools, and other deny and ask rules from the command line or the current session still apply."),
  allowManagedMcpServersOnly: z.boolean().optional().describe("When true (and set in managed settings), allowedMcpServers is only read from managed settings. deniedMcpServers still merges from all sources, so users can deny servers for themselves. Users can still add their own MCP servers, but only the admin-defined allowlist applies."),
  allowAllClaudeAiMcps: z.boolean().optional().describe("When true (and set in managed settings), claude.ai cloud MCP connectors load alongside managed-mcp.json instead of being suppressed by its exclusive-control lockdown. Default off preserves the lockdown. Read from managed settings only."),
  allowClaudeInChromeWithManagedMcp: z.boolean().optional().describe("When true (and set in device managed settings: MDM, the managed-settings.json file, or a policy helper those configure), the built-in PRRICODE in Chrome MCP server can run alongside managed-mcp.json instead of being blocked by its exclusive-control lockdown. deniedMcpServers and the organization's PRRICODE in Chrome setting still block it. Default off preserves the lockdown."),
  strictPluginOnlyCustomization: strictPluginOnlyCustomizationSchema.optional().catch(undefined).describe("When set in managed settings, blocks non-plugin customization sources for the listed surfaces. Array form locks specific surfaces (e.g. [\"skills\", \"hooks\"]); `true` locks all four; `false` is an explicit no-op. Blocked: ~/.claude/{surface}/, .claude/{surface}/ (project), settings.json hooks, .mcp.json. NOT blocked: managed (policySettings) sources, plugin-provided customizations. Composes with strictKnownMarketplaces for end-to-end admin control — plugins gated by marketplace allowlist, everything else blocked here."),
  statusLine: z.object({
    type: z.literal("command"),
    command: z.string(),
    padding: z.number().optional(),
    refreshInterval: z.number().min(1).optional().catch(undefined),
    hideVimModeIndicator: z.boolean().optional(),
}).optional().describe("Custom status line display configuration"),
  prUrlTemplate: z.string().optional().describe("URL template for PR links in the footer link badges and inline messages. The detected git PR is rendered as the first footer-link badge. Placeholders: {host} {owner} {repo} {number} {url}. Example: \"https://reviews.example.com/{owner}/{repo}/pull/{number}\""),
  footerLinksRegexes: z.array(footerLinkSchema.catch(INVALID_FOOTER_LINK))
    .transform((entries) => entries.filter((entry) => entry !== INVALID_FOOTER_LINK))
    .optional()
    .catch(undefined).describe("Extra clickable footer badges that appear when a regex matches turn output (tool results and assistant responses). Read from user, flag, and managed settings only; ignored in project .claude/settings.json and local .claude/settings.local.json. At most 5 badges render; the oldest is displaced by newer matches and /clear removes them. Use to surface IDs printed by project CLIs as session links."),
  subagentStatusLine: z.object({
    type: z.literal("command"),
    command: z.string(),
}).optional().describe("Custom per-subagent status line shown in the agent panel; receives row context as JSON on stdin"),
  enabledPlugins: z.record(z.string(), z.union([z.array(z.string()), z.boolean(), z.undefined()])).optional().describe("Enabled plugins using plugin-id@marketplace-id format. Example: { \"formatter@anthropic-tools\": true }. Also supports extended format with version constraints. Settings precedence is user < project < local < flag < policy, so to disable a plugin that project settings enable, set it to false in .claude/settings.local.json — setting false in ~/.claude/settings.json is overridden by the project."),
  prependPlugins: z.array(z.string()).optional().catch(undefined).describe("Managed plugins (plugin@marketplace ids that managed enabledPlugins sets true) whose hooks run first, outermost, in the listed order: the first id listed sees every event before any other plugin and every result after it. Managed plugins not listed here or in appendPlugins follow the listed ones; user, project and marketplace plugins come after those; then appendPlugins; then the built-in plugins. The bundled cc-plugin-sec-default@builtin seats itself outermost (on a machine with managed settings and for Team and Enterprise organizations) unless this list is set, in which case list it where it should sit or leave it out. Name it there as sec-default@builtin, the id every release reads, for as long as any machine in the organization may run a release from before its rename; a release that knows the new id reads either. Any other id that is not an enabled managed plugin is skipped; an id listed in both keys is prepended. Only honored from managed settings (or, on a machine with none, from user settings for your own plugins); ignored in project, local and --settings sources."),
  appendPlugins: z.array(z.string()).optional().catch(undefined).describe("Managed plugins (plugin@marketplace ids that managed enabledPlugins sets true) whose hooks run last among plugins, innermost, in the listed order: the last id listed sits just above the built-in plugins and sees each event as every other plugin left it. Only honored from managed settings (or, on a machine with none, from user settings for your own plugins); ignored in project, local and --settings sources."),
  extraKnownMarketplaces: marketplacesSchema.optional().describe("Additional marketplaces to make available for this repository. Typically used in repository .claude/settings.json to ensure team members have required plugin sources."),
  additionalMarketplaces: marketplacesSchema.optional().describe("Alias for extraKnownMarketplaces: this key is read exactly as if it were spelled extraKnownMarketplaces. Do not set both in one file — if both appear, this key is ignored with a warning. PRRICODE may rewrite this key as extraKnownMarketplaces when it updates the file. Clients older than this alias ignore it, so prefer extraKnownMarketplaces while older PRRICODE versions still share the same settings."),
  strictKnownMarketplaces: z.array(marketplaceEntrySchema).optional().describe("Enterprise strict list of allowed marketplace sources. When set in managed settings, ONLY these sources can be added as marketplaces. Entries match exactly, except that a github entry may use the owner-wildcard form {\"source\":\"github\",\"repo\":\"owner/*\"} to allow every repository under that owner. The check happens BEFORE downloading, so blocked sources never touch the filesystem. Note: this is a policy gate only — it does NOT register marketplaces. To pre-register allowed marketplaces for users, also set extraKnownMarketplaces."),
  allowedMarketplaces: z.array(marketplaceEntrySchema).optional().describe("Alias for strictKnownMarketplaces (managed settings only): this key is read exactly as if it were spelled strictKnownMarketplaces. Do not set both in one file — if both appear, this key is ignored with a warning. Clients older than this alias ignore it, so keep using strictKnownMarketplaces when the allowlist must also bind older PRRICODE versions."),
  blockedMarketplaces: z.array(blockedMarketplaceSchema).optional().describe("Enterprise blocklist of marketplace sources. When set in managed settings, these sources are blocked from being added as marketplaces. Entries match exactly, except that a github entry may use the owner-wildcard form {\"source\":\"github\",\"repo\":\"owner/*\"} to block every repository under that owner. The check happens BEFORE downloading, so blocked sources never touch the filesystem."),
  disableCommandPluginSources: z.boolean().optional().describe("Controls the `command` plugin source, whose plugin directory is produced by running a marketplace-declared command on this machine. true: command-sourced plugins are never installed, updated, or re-resolved (the command never runs). false: explicitly allowed. Unset: follows allowManagedHooksOnly — an org that restricts hook execution to managed settings gets command sources disabled too. Only honored from managed settings."),
  disableSideloadFlags: z.boolean().optional().describe("When true (and set in managed settings), rejects the --plugin-dir, --plugin-url, --agents, and non-sdk --mcp-config CLI flags at startup. Closes the CLI-flag bypass of strictKnownMarketplaces. Pair with allowedMcpServers for per-server MCP control; this setting does not gate other MCP entry points (SDK setMcpServers, prricode mcp add, .mcp.json). Also blocks surfaces that spawn the CLI with these flags internally (see settings documentation). Only honored from managed settings; ignored in user/project/local settings."),
  pluginSuggestionMarketplaces: z.array(z.string()).optional().describe("Marketplace names whose plugins may surface as contextual install suggestions (relevance-based tips). No marketplace-declared suggestions surface without this allowlist; the built-in first-party frontend-design tip is unaffected. Only honored when set in managed settings (policy scope); the key is ignored in user, project, and local settings. A name only takes effect when the marketplace is registered on the machine AND its registered source is also declared in managed settings, either as the extraKnownMarketplaces entry for that name or as an entry of strictKnownMarketplaces. A marketplace registered from a different source under an allowlisted name is ignored. The official marketplace is exempt from the source requirement: allowlisting its name alone suffices, since that name can only register from the official Anthropic source."),
  forceLoginMethod: z.enum(["claudeai", "console", "gateway"]).optional().catch(undefined).describe("Force a specific login method: \"claudeai\" for PRRICODE Pro/Max, \"console\" for Console billing, \"gateway\" for the Cloud gateway OIDC device flow"),
  forceLoginGatewayUrl: z.string().min(1).optional().catch(undefined).describe("Cloud gateway URL to pre-fill during login, alongside forceLoginMethod: \"gateway\". Honored from admin-controlled managed settings (MDM / managed-settings.json / policy helper) and, on a machine with none of those, from your own user settings; ignored in project, local, flag, and remote-delivered settings."),
  gatewayInternalNetworks: z.array(z.string()).optional().catch(['(unreadable)']).describe("IPv4 CIDR blocks (at most 4, each /8 to /32, not overlapping) your Cloud gateway sits in: the public block your organization numbers its internal network from, which lets /login reach a gateway there. A block must lie entirely outside private space, where /login accepts a gateway without this key. /login accepts a gateway inside a listed block over a direct connection only, and only when this machine's own address on that connection is inside the same block, so /login must happen from a machine whose own address is inside the block (not through a proxy, VPN pool, container or NAT segment outside it). A bar against copied settings files, not proof of location. Honored only from admin-controlled managed settings (MDM / managed-settings.json / policy helper); ignored in user, project, and remote-delivered settings."),
  parentSettingsBehavior: z.enum(["first-wins", "merge"]).optional().describe("Controls whether the SDK parent tier (Options.managedSettings / --managed-settings) layers under this admin tier. \"first-wins\" (the default, except in a gateway session PRRICODE Desktop's Code tab launched, where \"merge\" is): parent is dropped — admin tiers are the only policy source. \"merge\": parent's restrictive-only-filtered settings union under the admin winner. Has no effect when no admin tier exists (parent applies as the sole policy tier, still filtered restrictive-only)."),
  managedSourcesBehavior: z.enum(["first-wins", "merge"]).optional().describe("Controls how the managed settings sources compose. \"first-wins\" (default): the highest-priority source present (server-managed > MDM (managed plist / HKLM) > managed-settings.json) is the managed tier alone. \"merge\": every present source deep-merges with fixed precedence server-managed > MDM > managed-settings.json — scalars take the highest source's value (a restrictive boolean or enum — the allowManaged*Only locks, the disable* switches, the sandbox lock family — takes the strictest value any source sets) and arrays union, except fallbackModel, the restriction allowlists allowedMcpServers, allowedProviders, availableModels, strictKnownMarketplaces and allowedChannelPlugins, and sandbox.credentials.awsPairs and sandbox.ripgrep (the highest source that sets one owns it whole), modelOverrides (the whole map of the highest source that sets it, dropped when that source sits below the one that sets availableModels), managedMcpServers (server names union; a name set by two sources takes the higher source's whole entry), and the keys taken from the highest source only: the auth pins forceLoginOrgUUID, forceLoginMethod, forceLoginGatewayUrl and gatewayInternalNetworks, the credential helpers apiKeyHelper, awsAuthRefresh, awsCredentialExport, gcpAuthRefresh, otelHeadersHelper and proxyAuthHelper, modelPicker, permissions.defaultMode, parentSettingsBehavior and the policyHelper configuration (env keeps its own per-key union). In both modes, a forceLoginOrgUUID, or a forceLoginMethod of claudeai or console, that this machine's own MDM policy or managed settings file sets applies ahead of server-managed settings. Honored only from the highest-priority source present; enable it only when every lower source is admin-controlled, since lower sources then contribute entries such as permissions.allow. HKCU and --managed-settings never take part in the merge."),
  forceLoginOrgUUID: z.union([z.string(), z.array(z.string())]).optional().describe("Organization UUID to require for OAuth login. Accepts a single UUID string or an array of UUIDs (any one is permitted). When set in managed settings, login fails if the authenticated account does not belong to a listed organization."),
  allowedProviders: z.preprocess(
      (value) =>
        Array.isArray(value)
          ? value.filter((entry): entry is AllowedProvider =>
              typeof entry === 'string' && (ALLOWED_PROVIDERS as readonly string[]).includes(entry),
            )
          : value,
      z.array(z.enum(ALLOWED_PROVIDERS)),
    )
    .optional()
    .catch(undefined).describe("Managed settings only (managed-settings.json, MDM, or server-managed). The API providers PRRICODE may use on this machine: \"anthropic\" (the Anthropic API on Anthropic's own host, via a claude.ai or Console sign-in or an API key; pair it with forceLoginMethod / forceLoginOrgUUID to require a sign-in), \"bedrock\", \"vertex\", \"foundry\", \"anthropicAws\", \"mantle\" (each meaning that provider's own service: its regional, FIPS, private-endpoint and sovereign-cloud hosts), \"customEndpoint\" (the Anthropic API or a cloud provider's API sent to some other host — ANTHROPIC_BASE_URL, that provider's ANTHROPIC_*_BASE_URL, a Foundry resource name that is not a bare name, or for Bedrock the AWS SDK's AWS_ENDPOINT_URL[_BEDROCK[_RUNTIME]] — such as an LLM gateway; admitted only for the value pinned in the \"env\" block of the same managed source), or \"gateway\" (the Cloud gateway sign-in). A session on a provider that is not listed is refused at startup, at login, and when it next contacts the API, with a message naming what selected the provider and the entry that would allow it. Under a list, where first-party traffic goes (ANTHROPIC_BASE_URL, a gateway sign-in) is honored only when the same managed source pins it in \"env\" (or forceLoginGatewayUrl), and a prricode ssh tunnel into the machine is refused. A cloud provider's credential and tenancy variables, and the network path and TLS trust (HTTPS_PROXY, NODE_EXTRA_CA_CERTS, CLAUDE_CODE_CERT_STORE), are not judged by this list; set those for the fleet in the managed \"env\" block, whose values replace the user's. To route Bedrock through a gateway for a fleet, pin ANTHROPIC_BEDROCK_BASE_URL there (it is what the clients use, ahead of an endpoint_url in ~/.aws/config, which this list does not judge); the AWS SDK's AWS_ENDPOINT_URL* pins only sanction where the SDK's own clients go and never stand in for the \"bedrock\" entry. Unset allows every provider; an empty array allows none. Only a list in managed-settings.json or MDM is enforcement on the machine: it cannot be widened or hidden by server-managed settings and reaches every session. A list set only in the admin console reaches only sessions that fetch your server-managed settings — not a session on a cloud provider, another organization or a non-Anthropic ANTHROPIC_BASE_URL, one authenticating only with apiKeyHelper or ANTHROPIC_AUTH_TOKEN, a Pro/Max login, --bare without an API key, or a first launch before the fetch lands — all conditions the user controls. Versions that predate this setting ignore it; pair it with a minimum-version policy on a mixed fleet. 'claude auth status' reports the Anthropic API as apiProvider \"firstParty\"."),
  forceRemoteSettingsRefresh: z.boolean().optional().describe("When set in managed settings, the CLI blocks startup until remote managed settings are freshly fetched, and exits if the fetch fails"),
  otelHeadersHelper: z.string().optional().describe("Path to a script that outputs OpenTelemetry headers"),
  outputStyle: z.string().optional().describe("Controls the output style for assistant responses"),
  viewMode: z.enum(["default", "verbose", "focus"]).optional().catch(undefined).describe("Default transcript view mode on startup"),
  language: z.string().optional().describe("Preferred language for PRRICODE responses and voice dictation (e.g., \"japanese\", \"spanish\")"),
  skipWebFetchPreflight: z.boolean().optional().describe("Skip the WebFetch blocklist check for enterprise environments with restrictive security policies"),
  sandbox: sandboxSchema.optional(),
  feedbackSurveyRate: z.number().min(0).max(1).optional().describe("Probability (0–1) that the session quality survey appears when eligible. 0.05 is a reasonable starting point."),
  feedbackDrafts: z.enum(["notify", "quiet", "off"]).optional().describe("Model-drafted feedback (the SendFeedback tool). \"notify\" (default) shows a one-line notice when a draft is queued; \"quiet\" shows only the footer counter; \"off\" disables the tool entirely so drafts are never queued."),
  spinnerTipsEnabled: z.boolean().optional().describe("Whether to show tips in the spinner"),
  spinnerVerbs: z.object({
    mode: z.enum(["append", "replace"]),
    verbs: z.array(z.string()),
}).optional().describe("Customize spinner verbs. mode: \"append\" adds verbs to defaults, \"replace\" uses only your verbs."),
  spinnerTipsOverride: z.looseObject({
    excludeDefault: z.boolean().optional().catch(undefined),
    tips: spinnerTipsSchema.optional(),
    tipsFile: z.string().optional().catch(undefined),
    label: z.string().optional().catch(undefined),
}).optional().catch(undefined).describe("Add your organization's own tips to the spinner tip rotation. tips: strings or {id, text, cooldownSessions?, priority?} objects; tipsFile: a JSON file of the same; label: prefix shown before your tips; excludeDefault: if true, only show your tips (default: false)."),
  syntaxHighlightingDisabled: z.boolean().optional().describe("Whether to disable syntax highlighting in diffs"),
  maxProseWidth: z.number().int().min(40).optional().catch(undefined).describe("Maximum width, in terminal columns, of the prose in PRRICODE's responses (paragraphs, headings, lists, blockquotes). In a wider terminal the prose wraps at this width while tables and code blocks keep the full width; only the display wraps, the response text itself gains no line breaks. Minimum 40. Unset (the default) uses the full terminal width."),
  spellcheck: z.looseObject({
    enabled: z.boolean().optional().catch(undefined),
    checker: z.string().optional().catch(undefined),
    language: z.string().optional().catch(undefined),
    color: z.string().optional().catch(undefined),
}).optional().catch(undefined).describe("Underline misspelled words in the prompt input as you type, using an installed ${vze.slice(0,-1).join(\", \")} or ${vze.at(-1)} (off unless \"enabled\" is true; does nothing if none is installed). Read from user, flag and managed settings only (the whole block from the highest-precedence of those applies); ignored in project .claude/settings.json and .claude/settings.local.json."),
  terminalTitleFromRename: z.boolean().optional().describe("Whether /rename updates the terminal tab title (defaults to true). Set to false to keep auto-generated topic titles."),
  promptCacheTtl: z.enum(["5m","1h"]).optional().catch(undefined).describe("Prompt cache TTL for the main conversation (interactive, -p and SDK turns, plus the helpers that run inline with it): \"5m\" or \"1h\". Unset = automatic: 1 hour on a PRRICODE subscription within its usage limits, 5 minutes on an API key, Bedrock, Vertex or Foundry. 1-hour cache writes are billed at a higher rate; the cache stays warm across longer breaks. The CLAUDE_CODE_PROMPT_CACHE_TTL environment variable takes precedence."),
  subagentPromptCacheTtl: z.enum(["5m","1h"]).optional().catch(undefined).describe("Prompt cache TTL for everything outside the main conversation — subagents, workflows, background and helper requests: \"5m\" or \"1h\". Unset = automatic (5 minutes unless ENABLE_PROMPT_CACHING_1H=1). The CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL environment variable takes precedence."),
  alwaysThinkingEnabled: z.boolean().optional().describe("When false, thinking is disabled. When absent or true, thinking is enabled automatically for supported models."),
  effortLevel: z.enum(["low", "medium", "high", "xhigh"]).optional().catch(undefined).describe("Persisted effort level for supported models."),
  maxEffortLevel: z.enum(["low","medium","high","xhigh","max"]).optional().catch(undefined).describe("Maximum effort level. Anything above it (an /effort or /model pick, --effort, CLAUDE_CODE_EFFORT_LEVEL, a model default) is clamped to it, on every provider including Bedrock, Vertex and Foundry. Combines with an organization's per-model effort cap by taking the lower of the two; across settings files the lowest value wins, and modelSettings.<model>.maxEffortLevel replaces it per model. Enforced client-side: an effort supplied through CLAUDE_CODE_EXTRA_BODY is not clamped."),
  modelSettings: z.preprocess(stripPrototypeKeys, z.record(z.string(), modelSettingSchema.optional()))
    .optional()
    .catch(undefined).describe("Per-model settings keyed by canonical model name."),
  ultracode: z.boolean().optional().catch(undefined).describe("Enable ultracode for the session: standing dynamic-workflow orchestration at any effort level. Session-scoped — typically provided via --settings or the apply_flag_settings control request; interactive toggles never persist it. Requires workflows to be enabled and a model that supports ultracode."),
  autoCompactWindow: autoCompactWindowSchema.describe("Auto-compact window size"),
  advisorModel: z.string().optional().describe("Advisor model for the server-side advisor tool."),
  fastMode: z.boolean().optional().describe("When true, fast mode is enabled. When absent or false, fast mode is off."),
  fastModePerSessionOptIn: z.boolean().optional().describe("When true, fast mode does not persist across sessions. Each session starts with fast mode off."),
  promptSuggestionEnabled: z.boolean().optional().describe("When false, prompt suggestions are disabled. When absent or true, prompt suggestions are enabled."),
  emojiCompletionEnabled: z.boolean().optional().describe("When false, the :emoji: shortcode typeahead (the suggestion popup and the :name: inline replacement) is disabled. When absent or true, it is enabled."),
  awaySummaryEnabled: z.boolean().optional().describe("@internal When false, the session recap (shown when you return after being away for 5+ minutes) is disabled. When absent or true, recap is enabled. Hidden from public SDK types until external launch."),
  showClearContextOnPlanAccept: z.boolean().optional().describe("When true, the plan-approval dialog offers a \"clear context\" option. Defaults to false."),
  askUserQuestionTimeout: z.enum(["60s", "5m", "10m", "never"]).optional().catch(undefined).describe("Idle time before PRRICODE's questions auto-continue with any answers selected so far. Defaults to never — auto-continue only runs when explicitly set to 60s/5m/10m."),
  dialogExpiry: z.enum(["60s", "5m", "10m", "never"]).optional().catch(undefined).describe("Max time a permission/user dialog forwarded to a remote client stays parked awaiting an answer, and how long a HELD cross-session message awaits approval, before either resolves to its safe no-action default (cancelled / dropped-with-denial). Defaults to 5m to match the long-standing remote-dialog deadline; \"never\" disables the deadline. Local-only permission prompts (no remote client) are unaffected. The CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS env var, when set, overrides this. Read from trusted sources only (never a checked-in repo settings file)."),
  agent: z.string().optional().describe("Name of an agent (built-in or custom) to use for the main thread. Applies the agent's system prompt, tool restrictions, and model."),
  modelProposedGoals: z.enum(["auto","alwaysAsk","disabled"]).optional().catch(undefined).describe("@internal Controls the ProposeGoal tool (model-proposed session goals). 'auto' (the default when absent) lets the model choose per proposal whether to ask for approval via its ask_user parameter; 'alwaysAsk' routes every model-proposed goal through the approval dialog; 'disabled' turns the tool off. A typed /goal is unaffected. Consent-affecting, so it is read from trusted sources only (user/policy/flag) — workspace-resident project and local settings are ignored."),
  companyAnnouncements: z.array(z.string()).optional().describe("Company announcements to display at startup (one will be randomly selected if multiple are provided)"),
  pluginConfigs: z.record(z.string(), z.object({
    mcpServers: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))).optional(),
    options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
})).optional().describe("Per-plugin configuration including MCP server user configs, keyed by plugin ID (plugin@marketplace format)"),
  remote: z.object({
    defaultEnvironmentId: z.string().optional(),
}).optional().describe("Cloud session configuration"),
  autoUpdatesChannel: z.enum(["latest", "stable", "rc"]).optional().describe("Release channel for auto-updates (latest or stable)"),
  minimumVersion: z.string().optional().describe("Minimum version to stay on - prevents downgrades when switching to stable channel"),
  requiredMinimumVersion: z.string().optional().describe("Minimum PRRICODE version required to start. If the running version is older, PRRICODE exits at startup with instructions to update. Only enforced from managed (policy) settings."),
  requiredMaximumVersion: z.string().optional().describe("Maximum PRRICODE version allowed to start. If the running version is newer, PRRICODE exits at startup with instructions to install an approved version. Only enforced from managed (policy) settings."),
  plansDirectory: z.string().optional().describe("Custom directory for plan files, relative to project root. If not set, defaults to ~/.claude/plans/"),
  tui: z.enum(["default", "fullscreen"]).optional().describe("Terminal UI renderer. \"fullscreen\" uses the flicker-free alt-screen renderer with virtualized scrollback (equivalent to CLAUDE_CODE_NO_FLICKER=1). \"default\" uses the classic main-screen renderer."),
  voice: z.object({
    enabled: z.boolean().optional(),
    mode: z.enum(["hold", "tap"]).optional(),
    autoSubmit: z.boolean().optional(),
}).optional().describe("Voice mode settings (hold-to-talk / tap-to-toggle dictation)"),
  channelsEnabled: z.boolean().optional().describe("Managed-org opt-in for channel notifications (MCP servers with the claude/channel capability pushing inbound messages). claude.ai Teams/Enterprise: default off. Console: default on unless managed settings exist. Set true to allow; users then select servers via --channels."),
  allowedChannelPlugins: z.array(channelPluginSchema).optional().describe("Managed-org allowlist of channel plugins. When set, replaces the default Anthropic allowlist — admins decide which plugins may push inbound messages. Undefined falls back to the default. Requires channelsEnabled: true."),
  prefersReducedMotion: z.boolean().optional().describe("Reduce or disable animations for accessibility (spinner shimmer, flash effects, etc.)"),
  timeFormat: z.union([z.enum(["auto","12-hour","24-hour","24-hour-utc"]), z.string()]).optional().describe("Clock format for times shown in the UI: \"auto\" (default, follows the locale), \"12-hour\", \"24-hour\", \"24-hour-utc\" (\"18:05Z\"), or a strftime pattern such as \"%H:%M\" (any value containing \"%\"; other values read as \"auto\"). A pattern replaces the time everywhere; message timestamps show only the pattern, so include %Y-%m-%d for the date. /config offers the presets; a pattern is set here."),
  timeZone: z.string().optional().describe("IANA time zone for times shown in the UI, e.g. \"UTC\" or \"Europe/Dublin\". Default: the system time zone. An unknown name falls back to the system time zone."),
  doneMeansMerged: z.boolean().optional().describe("@internal When true, PRRICODE keeps working until the PR is ready for you to merge, a cron/Monitor is armed to resume later, or it hands you a self-contained next step."),
  totalTokensReminder: z.enum(["off", "infinite", "fixed", "countdown", "padded-countdown"]).optional().describe("@internal Emit a <total_tokens>N tokens left</total_tokens> block in the system prompt, after each tool result, and (when totalTokensReminderAfterUserTurn is on) after each regular user prompt. 'infinite' uses the literal value Infinite, 'fixed' uses 5000000, 'countdown' uses the live remaining context-window tokens, 'padded-countdown' counts down from totalTokensReminderBudget (re-anchoring to the full budget on each regular user prompt when totalTokensReminderAfterUserTurn is on — task-budget semantics). Defaults to padded-countdown. Env var CLAUDE_CODE_TOTAL_TOKENS_REMINDER overrides."),
  totalTokensReminderBudget: z.number().int().positive().optional().describe("@internal Starting budget (tokens) for totalTokensReminder 'padded-countdown' mode. Defaults to 15000000. Server-controlled via GrowthBook; env var CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET overrides."),
  totalTokensReminderAfterUserTurn: z.boolean().optional().describe("@internal When true, emit the totalTokensReminder block after each regular user prompt and (for 'padded-countdown') re-anchor the task budget to the full configured value at the start of each user turn. When false, the reminder appears only in the system prompt and after each tool-result batch, and 'padded-countdown' counts down over the whole session. Defaults to on. Env var CLAUDE_CODE_TOTAL_TOKENS_REMINDER_AFTER_USER_TURN overrides; server-controlled via GrowthBook tengu_lapis_anchor_user_turn."),
  autoMemoryEnabled: z.boolean().optional().describe("Enable auto-memory for this project. When false, PRRICODE will not read from or write to the auto-memory directory."),
  autoMemoryDirectory: z.string().optional().describe("Custom directory path for auto-memory storage. Supports ~/ prefix for home directory expansion. Ignored if set in projectSettings (checked-in .claude/settings.json) for security. When unset, defaults to ~/.claude/projects/<sanitized-cwd>/memory/."),
  autoDreamEnabled: z.boolean().optional().describe("Enable background memory consolidation (auto-dream). When set, overrides the server-side default."),
  showThinkingSummaries: z.boolean().optional().describe("Request API-side thinking summaries and show them in the conversation and in the transcript view (ctrl+o). Set explicitly to override the default for your install."),
  skipDangerousModePermissionPrompt: z.boolean().optional().describe("Whether the user has accepted the bypass permissions mode dialog"),
  skipWorkflowUsageWarning: z.boolean().optional().describe("@internal Whether the user has accepted the multi-agent workflow usage warning. Until set, auto permission mode prompts before running a workflow."),
  disableAutoMode: z.enum(["disable"]).optional().describe("Disable auto mode"),
  remoteTools: z.object({
    allowUnattendedServing: z.boolean().optional(),
}).optional().describe("@internal How this computer serves tool calls to cloud sessions"),
  sshConfigs: z.array(z.object({
    id: z.string(),
    name: z.string(),
    sshHost: z.string(),
    sshPort: z.number().int().optional(),
    sshIdentityFile: z.string().optional(),
    startDirectory: z.string().optional(),
})).optional().describe("SSH connection configurations for remote environments. Typically set in managed settings by enterprise administrators to pre-configure SSH connections for team members."),
  claudeMd: z.string().optional().describe("CLAUDE.md-style instructions injected as organization-managed memory. Only honored from managed/policy settings."),
  claudeMdExcludes: z.array(z.string()).optional().describe("Glob patterns or absolute paths of CLAUDE.md files to exclude from loading. Patterns are matched against absolute file paths using picomatch. Only applies to User, Project, and Local memory types (Managed/policy files cannot be excluded). Examples: \"/home/user/monorepo/CLAUDE.md\", \"**/code/CLAUDE.md\", \"**/some-dir/.claude/rules/**\""),
  pluginTrustMessage: z.string().optional().describe("Custom message to append to the plugin trust warning shown before installation. Only read from policy settings (managed-settings.json / MDM). Useful for enterprise administrators to add organization-specific context (e.g., \"All plugins from our internal marketplace are vetted and approved.\")."),
  theme: z.union([z.enum(["auto","dark","light","light-daltonized","dark-daltonized","light-ansi","dark-ansi"]), z.string().startsWith("custom:")]).optional().catch(undefined).describe("Color theme for the UI"),
  editorMode: z.enum(["normal","vim"]).optional().catch(undefined).describe("Key binding mode for the prompt input"),
  keybindingFlavor: z.enum(["classic", "readline"]).optional().catch(undefined).describe("Deprecated: no longer has any effect. The prompt's word-editing keys always follow Bash (readline) conventions."),
  vimInsertModeRemaps: z.record(z.string(), z.never()).optional().catch(undefined).describe("Vim INSERT-mode key-sequence remaps, e.g. {\"jj\": \"<Esc>\"}. Each key is exactly two printable characters typed in sequence; \"<Esc>\" (return to NORMAL mode) is the only supported target. Applies when editorMode is \"vim\"."),
  verbose: z.boolean().optional().describe("Show full tool output instead of truncated summaries"),
  preferredNotifChannel: z.enum(["auto","iterm2","terminal_bell","iterm2_with_bell","kitty","ghostty","notifications_disabled"]).optional().catch(undefined).describe("Preferred OS notification channel"),
  autoCompactEnabled: z.boolean().optional().describe("Automatically compact conversation when context fills"),
  precomputeCompactionEnabled: z.boolean().optional().describe("Precompute the compaction summary in the background before it is needed. Only applies when auto-compact is on."),
  idleCompaction: z.boolean().optional().describe("Set to false to stop PRRICODE from compacting a long conversation while the session is idle. Setting it to true does not turn idle compaction on."),
  switchModelsOnFlag: z.boolean().optional().describe("When safeguards flag a message, automatically switch to a different model to keep chatting. When off, your session will pause instead."),
  autoContinueAtUsageLimit: z.boolean().optional().describe("When a claude.ai usage limit stops your session, wait for the limit to reset and continue the task automatically. When off, the limit dialog offers the wait as a choice instead."),
  autoScrollEnabled: z.boolean().optional().describe("Auto-scroll the conversation view to bottom (fullscreen mode only)"),
  wheelScrollAccelerationEnabled: z.boolean().optional().describe("Ramp mouse-wheel scroll speed during fast scrolls (fullscreen mode only)"),
  fileCheckpointingEnabled: z.boolean().optional().describe("Snapshot files before edits so /rewind can restore them"),
  showTurnDuration: z.boolean().optional().describe("Show \"Cooked for Nm Ns\" after each assistant turn"),
  showMessageTimestamps: z.boolean().optional().describe("Stamp each message with its arrival time"),
  terminalProgressBarEnabled: z.boolean().optional().describe("Emit OSC 9;4 progress sequences during long operations"),
  todoFeatureEnabled: z.boolean().optional().describe("Enable the todo / task tracking panel"),
  teammateMode: z.enum(["auto","tmux","iterm2","in-process"]).optional().catch(undefined).describe("How spawned teammates execute (tmux, iterm2, in-process, auto)"),
  remoteControlAtStartup: z.boolean().optional().describe("Start Remote Control bridge automatically each session"),
  remoteControl: z.object({
    shareHostProfile: z.enum(["off","basic","full"]).optional().catch(undefined),
}).optional().describe("@internal Remote Control (`prricode remote-control`) options"),
  isolatePeerMachines: z.boolean().optional().describe("Require explicit approval before SendMessage can reach a peer session on another machine via Remote Control"),
  daemonColdStart: z.enum(["transient", "ask"]).optional().describe("When no background service is running: 'transient' spawns one for this login session; 'ask' offers to install it persistently"),
  crossSessionInbound: z.enum(["accept","hold","refuse"]).optional().catch(undefined).describe("Inbound cross-session peer messages (SendMessage from your other sessions): 'accept' delivers them, 'hold' parks them for your review without letting PRRICODE act, 'refuse' opts this session out. An explicit value always wins. Unset (mode parity): a message auto-delivers only when the sending session's permission-mode class matches yours (bypass↔bypass or prompting↔prompting); a mismatched sender's message is held for your approval; a sender that asserts no class is held only while this session bypasses permission prompts."),
  autoUploadSessions: z.boolean().optional().describe("Mirror local sessions to claude.ai as view-only (no remote control)"),
  inputNeededNotifEnabled: z.boolean().optional().describe("Push to mobile when a permission prompt or question is waiting"),
  agentPushNotifEnabled: z.boolean().optional().describe("Allow PRRICODE to push proactive mobile notifications"),
});

export type SettingsDocument = z.infer<typeof settingsDocumentSchema>;

export type SettingsParseResult =
  | { ok: true; value: SettingsDocument }
  | { ok: false; issues: string[] };

// --- the defaults -----------------------------------------------------------

/**
 * The defaults the target's own prose establishes, keyed by the **dotted path**
 * of the setting.
 *
 * A key that is **not** in this table has **no** default. That is not the same
 * as a default of `false`: the target states a default only for the settings
 * whose own description names one, and the rest are read as "the feature is
 * off" or "the plan decides" by the code that reads them — neither of which is
 * a value a document can carry.
 *
 * The values are the target's own (`chunk-c9s0jh80.js`, the `.describe()` text
 * of each key). Where the target's default depends on the plan, on the
 * server-side rollout or on the machine, the setting is **not** in the table:
 * the target's own default is not a value then.
 */
export const SETTINGS_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({
  // --- the top-level keys whose default the target states ---
  respectGitignore: true,
  cleanupPeriodDays: 30,
  desktopSessionCleanupPeriodDays: 0,
  skillListingMaxDescChars: 1536,
  skillListingBudgetFraction: 0.01,
  includeCoAuthoredBy: true,
  includeGitInstructions: true,
  availableModelsMatch: 'prefix',
  enableArtifact: true,
  workflowKeywordTriggerEnabled: true,
  defaultShell: 'bash',
  bashEditDiffEnabled: true,
  bashOutputMaxChars: 30000,
  respondToBashCommands: true,
  allowAllClaudeAiMcps: false,
  allowClaudeInChromeWithManagedMcp: false,
  parentSettingsBehavior: 'first-wins',
  managedSourcesBehavior: 'first-wins',
  feedbackDrafts: 'notify',
  terminalTitleFromRename: true,
  showClearContextOnPlanAccept: false,
  askUserQuestionTimeout: 'never',
  dialogExpiry: '5m',
  modelProposedGoals: 'auto',
  tui: 'default',
  timeFormat: 'auto',
  totalTokensReminder: 'padded-countdown',
  totalTokensReminderBudget: 15000000,
  totalTokensReminderAfterUserTurn: true,
  alwaysThinkingEnabled: true,
  promptSuggestionEnabled: true,
  emojiCompletionEnabled: true,
  awaySummaryEnabled: true,
  fastMode: false,

  // --- the nested members whose default the target states ---
  'attribution.sessionUrl': true,
  'breakReminder.enabled': false,
  'breakReminder.intervalMinutes': 30,
  'breakReminder.breakThresholdMinutes': 10,
  'quietHours.enabled': false,
  'spellcheck.enabled': false,
  'sandbox.enabled': false,
  'sandbox.failIfUnavailable': false,
  'sandbox.allowUnsandboxedCommands': true,
  'sandbox.autoAllowBashIfSandboxed': true,
  'sandbox.enableWeakerNestedSandbox': false,
  'sandbox.enableWeakerNetworkIsolation': false,
  'sandbox.allowAppleEvents': false,
  'autoMode.useAutoModeDuringPlan': true,
  'remoteTools.allowUnattendedServing': true,
  'spinnerTipsOverride.excludeDefault': false,
});

/**
 * The default of a setting, or `undefined` when the setting has none.
 *
 * The lookup is an **own-property** check: a key that names an
 * `Object.prototype` member (`constructor`, `toString`, …) has no default,
 * rather than resolving to the inherited member.
 */
export function settingsDefault(key: string): unknown {
  if (!Object.hasOwn(SETTINGS_DEFAULTS, key)) return undefined;
  return SETTINGS_DEFAULTS[key];
}

/**
 * The value a settings document gives a setting: the document's own value when
 * it has one, and the target's default otherwise.
 *
 * A document that carries the key with the value `undefined` is treated as
 * carrying no value: the target's own shape is `.optional()`, so an absent key
 * and a key whose value is `undefined` are the same thing.
 */
export function effectiveSettingValue(document: unknown, key: string): unknown {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return settingsDefault(key);
  }
  const record = document as Record<string, unknown>;
  if (!Object.hasOwn(record, key)) return settingsDefault(key);
  const value = record[key];
  return value === undefined ? settingsDefault(key) : value;
}

// --- the workspace config (the first sibling document) ----------------------

/**
 * The **28** keys of the target's `WorkspaceConfig`.
 *
 * The workspace config is the managed-config surface for a third-party
 * distribution: it is a **separate document** with its own keys, and it is not
 * a variant of the settings document. The target reads it as the `workspace`
 * section of the flat managed config, and this implementation keeps it as its
 * own schema so that a caller can validate the section on its own.
 */
export const WORKSPACE_CONFIG_KEYS = [
  'disabledBuiltinTools',
  'disableBundledSkills',
  'skillCreationEnabled',
  'scheduledTasksEnabled',
  'keepAwakeEnabled',
  'builtinToolPolicy',
  'autoModeEnabled',
  'disableBypassPermissionsMode',
  'toolSearchEnabled',
  'skipWebFetchPreflight',
  'allowedFolders',
  'blockReadsOutsideWorkingDirectories',
  'disableWslSessions',
  'claudeCodeProcessWrapperEnabled',
  'relocateUncUserData',
  'allowedEgressHosts',
  'egressProxyUrl',
  'egressProxyPacUrl',
  'edrExtension',
  'edrExtensionVendor',
  'vmIpv6Enabled',
  'secureVmEnabled',
  'hardwareBuddyEnabled',
  'quickWriteEnabled',
  'requireFullVmSandbox',
  'endUserAttribution',
  'userContentRendererUrl',
  'organizationInstructions',
] as const;

export type WorkspaceConfigKey = (typeof WORKSPACE_CONFIG_KEYS)[number];

/**
 * The workspace config schema.
 *
 * The object is **loose**: the target's own object strips the members it does
 * not know rather than rejecting the document, and a loose object keeps them.
 */
export const workspaceConfigSchema = z.looseObject({
  disabledBuiltinTools: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? [...new Set(value.filter((entry) => typeof entry === 'string'))]
          : value,
      z.array(z.string()).max(100),
    )
    .optional(),
  disableBundledSkills: z.boolean().optional(),
  skillCreationEnabled: z.boolean().optional(),
  scheduledTasksEnabled: z.boolean().optional(),
  keepAwakeEnabled: z.boolean().optional(),
  builtinToolPolicy: z
    .preprocess(
      (value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).map(([name, entry]) => [
                name,
                entry === 'allow' ? 'allow' : 'ask',
              ]),
            )
          : value,
      z.record(z.string(), z.enum(['allow', 'ask'])),
    )
    .optional(),
  autoModeEnabled: z.boolean().optional(),
  disableBypassPermissionsMode: z.boolean().optional(),
  toolSearchEnabled: z.boolean().optional(),
  skipWebFetchPreflight: z.boolean().optional(),
  allowedFolders: z
    .array(z.union([z.string().min(1), z.record(z.string(), z.unknown())]))
    .max(200)
    .transform((entries) =>
      entries.map((entry) => (typeof entry === 'string' ? { path: entry } : entry)),
    )
    .optional(),
  blockReadsOutsideWorkingDirectories: z.boolean().optional(),
  disableWslSessions: z.boolean().optional(),
  claudeCodeProcessWrapperEnabled: z.boolean().optional(),
  relocateUncUserData: z.boolean().optional(),
  allowedEgressHosts: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? value.filter((entry) => typeof entry === 'string' && entry.length > 0)
          : value,
      z.array(z.string().min(1)).max(500),
    )
    .optional(),
  egressProxyUrl: z.string().optional(),
  egressProxyPacUrl: z.string().optional(),
  edrExtension: z.string().optional(),
  edrExtensionVendor: z.string().optional(),
  vmIpv6Enabled: z.boolean().optional(),
  secureVmEnabled: z.boolean().optional(),
  hardwareBuddyEnabled: z.boolean().optional(),
  quickWriteEnabled: z.boolean().optional(),
  requireFullVmSandbox: z.boolean().optional(),
  endUserAttribution: z.boolean().optional(),
  userContentRendererUrl: z.string().optional(),
  organizationInstructions: z.string().trim().min(1).max(3000).optional(),
});

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

/**
 * The workspace config's own runtime defaults, and the stand-in the target
 * substitutes when a value **cannot be read**.
 *
 * The two are different things, and the target keeps them apart: `default` is
 * the value the setting has when nothing sets it, and `failClosedValue` is the
 * value the setting takes when the source that carried it could not be read at
 * all. The target's `runtimeDefault` reads the first and **ignores** an object
 * default — the target's own metadata marks several of these defaults
 * "display-only", which means the *display* shows a default and the runtime
 * has none. Those are absent here.
 */
export const WORKSPACE_CONFIG_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({
  toolSearchEnabled: false,
  hardwareBuddyEnabled: true,
  requireFullVmSandbox: false,
});

/** The stand-in the target substitutes when a workspace value cannot be read. */
export const WORKSPACE_CONFIG_FAIL_CLOSED: Readonly<Record<string, unknown>> = Object.freeze({
  disableBundledSkills: true,
  skillCreationEnabled: true,
  scheduledTasksEnabled: true,
  keepAwakeEnabled: true,
  autoModeEnabled: true,
  disableBypassPermissionsMode: false,
  blockReadsOutsideWorkingDirectories: false,
  claudeCodeProcessWrapperEnabled: false,
  secureVmEnabled: true,
  hardwareBuddyEnabled: true,
  requireFullVmSandbox: false,
  endUserAttribution: true,
});

// --- the flat managed config (the second sibling document) ------------------

/**
 * The **22** top-level sections of the target's `FlatManagedConfig`.
 *
 * The flat managed config is the *flat* form of the managed configuration: the
 * document on disk carries **dot-path** keys (`"inference.provider"`), and the
 * target expands them into the nested shape this schema describes. It is a
 * **separate document** with its own keys, not a variant of the settings
 * document, and the target reads it from the managed-settings sources rather
 * than from a `settings.json`.
 */
export const FLAT_MANAGED_CONFIG_KEYS = [
  'inference',
  'selfHosted',
  'otlp',
  'dictation',
  'tokenLimits',
  'coworkSurface',
  'codeSurface',
  'chatSurface',
  'sessionRetention',
  'extensions',
  'autoUpdate',
  'featureDiscovery',
  'bootstrap',
  'lifecycle',
  'models',
  'plugins',
  'telemetry',
  'mcp',
  'workspace',
  'builtinBrowser',
  'authentication',
  'appearance',
] as const;

export type FlatManagedConfigKey = (typeof FLAT_MANAGED_CONFIG_KEYS)[number];

/**
 * The two **discriminators** of the flat managed config.
 *
 * They are flat keys that do not name a section of their own: they select
 * which member of the `inference` section is in force. The target's own
 * registry gives each one the nested path it expands to.
 */
export const FLAT_MANAGED_CONFIG_DISCRIMINATORS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  inferenceProvider: Object.freeze(['inference', 'provider']),
  inferenceCredentialKind: Object.freeze(['inference', 'credential', 'kind']),
});

/**
 * The flat managed config schema: the nested shape the flat document expands
 * to.
 *
 * Each section is a **loose object**: the target's own section schemas are
 * field trees whose leaves carry their own metadata, and a loose object keeps
 * the members this implementation could not read while still rejecting a
 * section that is not an object.
 */
export const flatManagedConfigSchema = z.looseObject({
  inference: z.looseObject({}).optional(),
  selfHosted: z.looseObject({}).optional(),
  otlp: z.looseObject({}).optional(),
  dictation: z.looseObject({}).optional(),
  tokenLimits: z.looseObject({}).optional(),
  coworkSurface: z.looseObject({}).optional(),
  codeSurface: z.looseObject({}).optional(),
  chatSurface: z.looseObject({}).optional(),
  sessionRetention: z.looseObject({}).optional(),
  extensions: z.looseObject({}).optional(),
  autoUpdate: z.looseObject({}).optional(),
  featureDiscovery: z.looseObject({}).optional(),
  bootstrap: z.looseObject({}).optional(),
  lifecycle: z.looseObject({}).optional(),
  models: z.looseObject({}).optional(),
  plugins: z.looseObject({}).optional(),
  telemetry: z.looseObject({}).optional(),
  mcp: z.looseObject({}).optional(),
  workspace: workspaceConfigSchema.optional(),
  builtinBrowser: z.looseObject({}).optional(),
  authentication: z.looseObject({}).optional(),
  appearance: z.looseObject({}).optional(),
});

export type FlatManagedConfig = z.infer<typeof flatManagedConfigSchema>;

/**
 * The flat managed config as it is written down: a **flat** map of dot-path
 * keys to values.
 *
 * The target's own registry is `FLAT_KEY_TO_NESTED_PATH`; this implementation
 * carries the **section** names and the two discriminators, and expands a flat
 * document by splitting each key on the dot.
 */
export const flatManagedConfigDocumentSchema = z.looseObject({});

/**
 * Expand a flat managed-config document into the nested shape.
 *
 * A key that names no section is **kept** where it is: the target's flat
 * registry knows every leaf, and this implementation does not carry the leaf
 * registry, so an unknown flat key is preserved rather than dropped.
 */
export function materializeFlatManagedConfig(flat: unknown): Record<string, unknown> {
  if (typeof flat !== 'object' || flat === null || Array.isArray(flat)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat as Record<string, unknown>)) {
    const segments = key.split('.').filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;
    let cursor = out;
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        cursor[segment] = {};
      }
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1] as string] = value;
  }
  return out;
}

// --- parsing ----------------------------------------------------------------

/**
 * Whether an error is a permission failure.
 *
 * A configuration directory owned by **another** user cannot be narrowed,
 * and the mode is not ours to change — so a `chmod` that fails that way is
 * not a reason to refuse the write.
 */
function isPermissionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

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

/** The result of parsing a sibling document. */
export type SiblingDocumentParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: string[] };

/** Parse a workspace-config document. */
export function parseWorkspaceConfig(input: unknown): SiblingDocumentParseResult {
  const result = workspaceConfigSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return `${path.length > 0 ? path : '<root>'}: ${issue.message}`;
  });
  return { ok: false, issues };
}

/**
 * Parse a flat managed-config document: the flat map is expanded into the
 * nested shape and the nested shape is validated.
 */
export function parseFlatManagedConfig(input: unknown): SiblingDocumentParseResult {
  const nested = materializeFlatManagedConfig(input);
  const result = flatManagedConfigSchema.safeParse(nested);
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
  try {
    chmodSync(configDir, 0o700);
  } catch (error) {
    // A configuration directory owned by **another** user cannot be narrowed,
    // and the mode is not ours to change. That is not a reason to refuse the
    // write: the settings file itself is written `0600`, and a directory we
    // did not create is not ours to fix.
    if (!isPermissionError(error)) throw error;
  }

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
