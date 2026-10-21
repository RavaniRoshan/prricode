/**
 * The sandbox policy: the settings vocabulary, the decision, and the reason strings.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.7 (the policy tier) and
 * §2.9 ("Native and platform sandbox"), and the `CC-017` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The vocabulary is the target's.** The audit names five keys in the `sandbox`
 * block of a settings document — `enabled`, `enabledPlatforms`, `failIfUnavailable`,
 * `allowUnsandboxedCommands` and `excludedCommands` — and the same five keys are
 * already in `src/config/schema.ts`. This module reads them and evaluates them.
 *
 * **The reason strings are the target's.** The audit records that the sandbox policy
 * "raises distinct, specific errors for `sandbox.enabledPlatforms excludes
 * <platform>`, `sandbox.enabled is false`, `sandbox.failIfUnavailable is false (a
 * missing backend would run the shell unconfined)`, and `sandbox.allowUnsandboxed
 * Commands is true`, and reports every `excludedCommands` exemption". The four
 * strings are reproduced verbatim in `SANDBOX_REASONS`.
 *
 * **The decision vocabulary is three-valued.** `allow` means "run it inside the
 * sandbox", `deny` means "do not run it", and `unconfined` means "run it, but
 * without the sandbox" — the third is what the target does when the backend is
 * missing and `failIfUnavailable` is false, and what it does for an explicitly
 * excluded command.
 *
 * **Only one of the four reasons refuses the command.** `deny` is the
 * `failIfUnavailable` refusal — the user asked for a sandbox and none can be
 * provided. The other three run the command **unconfined** and say so:
 * `sandbox.enabledPlatforms excludes <platform>` means this platform has no
 * sandbox, `sandbox.enabled is false` means the user turned the sandbox off, and
 * `sandbox.failIfUnavailable is false (...)` means the backend is missing. The
 * target's own documented default is that "a failed sandbox start **falls back to
 * running unsandboxed**", and a setting that turned the sandbox off would be
 * useless if it refused the command instead. Refusing on an unsupported platform
 * would also make this implementation unusable everywhere its backend does not run.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The **order** of the checks is: the platform exclusion, then `enabled`, then
 *     the command exclusion, then the backend availability. The audit lists the
 *     reason strings in that order, and a command that is exempt from the sandbox
 *     runs unconfined whatever the backend's state is, so the exclusion is decided
 *     before the availability.
 *   - **An exclusion covers the whole command only when every part of it matches.**
 *     A compound command is split on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines,
 *     and a single part that is not excluded keeps the whole command inside the
 *     sandbox: `git status && rm -rf /tmp/x` must not become unconfined because
 *     `git status` is excluded. The target's own compound handling splits a command
 *     and matches every part independently, and the strictest reading is the
 *     fail-safe one.
 *   - An exclusion entry must cover the **whole** sub-command. The sub-command is
 *     stripped of the shell wrappers the target strips (`timeout`, `nice`,
 *     `nohup`, …) and of its redirections, and the entry must then match it
 *     **entirely**: the entry `git status` matches `git status` and `git status >
 *     out.txt`, and it does **not** match `git status --short`. An entry that
 *     carries a `*` is a glob over the whole sub-command, so `git *` matches
 *     `git status --short`.
 *   - A sub-command that carries a **command substitution** is never excluded.
 *     `$( … )` and the backtick form are evaluated by the shell *before* the
 *     command runs, so `git status "$(rm -rf /tmp/x)"` would run the `rm` on the
 *     host while the command itself is exempt. A part that carries a substitution
 *     is rejected outright, which is the fail-safe reading: the command is then
 *     sandboxed like any other. The check runs on the **raw** part, before the
 *     redirections are stripped, because a substitution inside a redirection
 *     target is a substitution too: `git status > "$(rm -rf /tmp/x)"` would run
 *     the `rm` on the host just as surely. The **process substitution** forms
 *     (`<( … )` and `>( … )`) are refused as well, because a shell that
 *     supports them runs the command inside the parentheses.
 *   - **An entry of `*` exempts every command.** The entries are globs over the
 *     whole sub-command, so an entry that consists of nothing but `*` matches
 *     every command: with `allowUnsandboxedCommands` set, such a list switches
 *     the sandbox off for the **whole** command space, and `git status && rm -rf
 *     /` is exempt too. This implementation does **not** change the semantics — the
 *     target's own glob has the same reach, and the substitution guard still
 *     bites — but the hazard is made visible: the status reports the **scope**
 *     of the list (`exemptionScope`), and `all` says that the sandbox is off
 *     for everything.
 *   - `enabledPlatforms` is a **whitelist**: a platform that is not in the list is
 *     excluded. An unset list takes the default (`['linux']`, the only platform the
 *     implementation's backend implements); an explicitly empty list excludes every platform.
 *   - The reason for a refusal that the audit does not name — the backend is missing
 *     and `failIfUnavailable` is true — is a reimplementation string. The audit names the
 *     other four reasons exactly, and this one says the same thing in the same
 *     shape.
 *
 * **The defaults are this implementation's, and they are not the target's.** The target's
 * documented default is that a failed sandbox start **falls back to running
 * unsandboxed**; this implementation's `failIfUnavailable` default is the opposite — it
 * fails closed. This implementation's `enabled` default is `true` (the sandbox is on unless
 * a settings document turns it off), and its `enabledPlatforms` default is
 * `['linux']`, the only platform this implementation's backend implements. A caller that
 * wants the target's behaviour sets `failIfUnavailable: false` explicitly.
 *
 * **The residual risk.** The policy decides what the sandbox *does*; it is not
 * itself a boundary. Every layer of the sandbox shares one kernel, so a kernel
 * privilege escalation reachable from the sandbox defeats all of them, and
 * unprivileged user namespaces widen the reachable surface. Only a microVM moves
 * the boundary below the kernel.
 */

import { isIP } from 'node:net';

import { splitShellCommand, stripRedirections, stripWrappers } from '../../permissions/shell.js';

/** The platforms this implementation's sandbox backend implements. */
export const SANDBOX_SUPPORTED_PLATFORMS: readonly string[] = ['linux'];

/**
 * The filesystem policy of the `sandbox.filesystem` block.
 *
 * The block is the target's: the audit names `allowRead`, `allowWrite`,
 * `denyRead`, `denyWrite` and `credentials` as the lists it carries. The
 * launcher maps the block onto the mount plan: the allow lists become binds,
 * and the deny lists and the credential list become masked paths.
 */
export interface SandboxFilesystemPolicy {
  /** The paths the sandbox may read. */
  readonly allowRead?: readonly string[];
  /** The paths the sandbox may read and write. */
  readonly allowWrite?: readonly string[];
  /** The paths the sandbox may not read. */
  readonly denyRead?: readonly string[];
  /** The paths the sandbox may not write. */
  readonly denyWrite?: readonly string[];
  /** The credential files the sandbox may not see. */
  readonly credentials?: readonly string[];
}

/**
 * The network policy of the `sandbox.network` block — the **egress firewall**'s
 * own configuration.
 *
 * **Observed.** The target's sandbox runtime declares the block in
 * `chunk-3rfnbzz0.js` (offsets **11 700** – **14 600**); every member below is
 * the target's own key, and the target's own description of each is quoted in
 * the conformance document (`docs/compatibility/provider-catalog.md`).
 *
 * The members that carry a **value** are optional; the two lists and the
 * booleans that decide are given a value of their own, so that a caller never
 * has to distinguish "unset" from "empty".
 */
export interface SandboxNetworkPolicy {
  /** The hosts the sandbox may reach. */
  readonly allowedDomains: readonly string[];
  /** The hosts the sandbox may never reach, whatever the allowlist says. */
  readonly deniedDomains: readonly string[];
  /** Why a denied entry is denied, keyed by the exact entry string. */
  readonly deniedDomainReasons: Readonly<Record<string, string>>;
  /** Whether a host outside the allowlist is denied instead of asked for. */
  readonly strictAllowlist: boolean;
  /** Whether only the managed settings may supply the allowlist. */
  readonly allowManagedDomainsOnly: boolean;
  /** The port of an external HTTP proxy that replaces the local one. */
  readonly httpProxyPort?: number;
  /** The port of an external SOCKS proxy that replaces the local one. */
  readonly socksProxyPort?: number;
  /** Whether the proxy terminates TLS in process. */
  readonly tlsTerminate: boolean;
  /** The Unix sockets the sandbox may reach. */
  readonly allowUnixSockets: readonly string[];
  /** Whether every Unix socket is allowed. */
  readonly allowAllUnixSockets: boolean;
  /** Whether the sandbox may bind a local port. */
  readonly allowLocalBinding: boolean;
  /** The Mach services the sandbox may look up. */
  readonly allowMachLookup: readonly string[];
}

/** The network policy this implementation uses when a settings document says nothing. */
export const DEFAULT_SANDBOX_NETWORK_POLICY: SandboxNetworkPolicy = Object.freeze({
  allowedDomains: Object.freeze([]) as readonly string[],
  deniedDomains: Object.freeze([]) as readonly string[],
  deniedDomainReasons: Object.freeze({}) as Readonly<Record<string, string>>,
  strictAllowlist: false,
  allowManagedDomainsOnly: false,
  tlsTerminate: false,
  allowUnixSockets: Object.freeze([]) as readonly string[],
  allowAllUnixSockets: false,
  allowLocalBinding: false,
  allowMachLookup: Object.freeze([]) as readonly string[],
});

/**
 * The sandbox policy.
 *
 * The five members are the target's `sandbox` block, in the order the audit names
 * them. The sixth member, `filesystem`, is the target's `sandbox.filesystem`
 * sub-block: it is optional, and a document without one leaves it unset.
 */
export interface SandboxPolicy {
  /** Whether the sandbox is switched on at all. */
  readonly enabled: boolean;
  /** The platforms the sandbox applies to. */
  readonly enabledPlatforms: readonly string[];
  /** Whether a missing backend refuses the command instead of running it unconfined. */
  readonly failIfUnavailable: boolean;
  /** Whether a command may be exempted from the sandbox. */
  readonly allowUnsandboxedCommands: boolean;
  /** The commands that may run outside the sandbox. */
  readonly excludedCommands: readonly string[];
  /** The filesystem policy of the `sandbox.filesystem` block. */
  readonly filesystem?: SandboxFilesystemPolicy;
  /**
   * The network policy of the `sandbox.network` block.
   *
   * **Observed** — the target's sandbox runtime declares the block in
   * `chunk-3rfnbzz0.js`; this is the **egress firewall**'s configuration, and the
   * rules that decide on it are implemented below.
   */
  readonly network?: SandboxNetworkPolicy;
}

/** The policy this implementation uses when a settings document says nothing. */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = Object.freeze({
  enabled: true,
  enabledPlatforms: Object.freeze([...SANDBOX_SUPPORTED_PLATFORMS]) as readonly string[],
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  excludedCommands: Object.freeze([]) as readonly string[],
});

/**
 * The reason strings.
 *
 * The first four are the target's, verbatim. `unavailableRefused` is this implementation's
 * own: the audit names no reason for a refusal that is caused by a missing backend
 * with `failIfUnavailable` set.
 */
export const SANDBOX_REASONS = Object.freeze({
  /** The platform is not in `enabledPlatforms`. */
  platformExcluded: (platform: string): string => `sandbox.enabledPlatforms excludes ${platform}`,
  /** The sandbox is switched off. */
  disabled: 'sandbox.enabled is false',
  /** The backend is missing and the policy says to continue anyway. */
  unavailableUnconfined:
    'sandbox.failIfUnavailable is false (a missing backend would run the shell unconfined)',
  /** The command is exempt from the sandbox. */
  unsandboxedCommand: 'sandbox.allowUnsandboxedCommands is true',
  /** The backend is missing and the policy says to refuse. */
  unavailableRefused: 'sandbox backend is unavailable and sandbox.failIfUnavailable is true',
});

/** What the policy decided about a command. */
export type SandboxDecision = 'allow' | 'deny' | 'unconfined';

/**
 * The scope the `excludedCommands` list covers.
 *
 * `all` is the hazard: an entry that consists of nothing but `*` is a glob over
 * the whole sub-command, so it exempts **every** command, and a policy that
 * carries it runs the whole command space outside the sandbox. `partial` means
 * the list names particular commands, and `none` means it exempts nothing.
 */
export type SandboxExemptionScope = 'none' | 'partial' | 'all';

/** The result of evaluating the policy. */
export interface SandboxEvaluation {
  /** What to do with the command. */
  decision: SandboxDecision;
  /** The reason, when there is one. */
  reason?: string;
  /** The `excludedCommands` entries that exempt the command. */
  exemptions?: readonly string[];
}

/** Whether the sandbox backend can run on this host. */
export type SandboxAvailability = 'available' | 'unavailable';

/**
 * Decide what to do with a command.
 *
 * The decision is `unconfined` when the platform is excluded or the sandbox is
 * switched off, `unconfined` when the command is exempt or the backend is
 * missing and the policy tolerates that, `deny` when the backend is missing and
 * the policy does **not** tolerate that, and `allow` otherwise.
 *
 * The **availability is an argument, never a guess**: the caller says whether the
 * backend can run on this host. The three-argument form of the plan's signature
 * would have to fabricate it from the platform name, and a fabricated `available`
 * silently returns `allow` on a host that has no backend at all.
 */
export function evaluateSandbox(
  policy: SandboxPolicy,
  platform: string,
  command: string,
  availability: SandboxAvailability,
): SandboxEvaluation {
  if (!policy.enabledPlatforms.includes(platform)) {
    return { decision: 'unconfined', reason: SANDBOX_REASONS.platformExcluded(platform) };
  }
  if (!policy.enabled) {
    return { decision: 'unconfined', reason: SANDBOX_REASONS.disabled };
  }
  if (policy.allowUnsandboxedCommands) {
    const exemptions = matchingExclusions(command, policy.excludedCommands);
    if (exemptions.length > 0) {
      return {
        decision: 'unconfined',
        reason: SANDBOX_REASONS.unsandboxedCommand,
        exemptions,
      };
    }
  }
  if (availability === 'unavailable') {
    if (policy.failIfUnavailable) {
      return { decision: 'deny', reason: SANDBOX_REASONS.unavailableRefused };
    }
    return { decision: 'unconfined', reason: SANDBOX_REASONS.unavailableUnconfined };
  }
  return { decision: 'allow' };
}

/**
 * The scope the exclusion list of a policy covers.
 *
 * The list is **inert** unless `allowUnsandboxedCommands` is set: a policy that
 * does not allow unsandboxed commands never has the `all` scope, whatever its
 * list carries. The scope is a **report**, not a decision: this implementation does not
 * change the semantics of the target's glob, it only makes the reach of the
 * list visible.
 */
export function exemptionScope(policy: SandboxPolicy): SandboxExemptionScope {
  if (!policy.allowUnsandboxedCommands) return 'none';
  if (policy.excludedCommands.some(coversEveryCommand)) return 'all';
  return policy.excludedCommands.length === 0 ? 'none' : 'partial';
}

/**
 * Whether an exclusion entry is a glob that covers every command.
 *
 * An entry with a `*` is a glob over the whole sub-command, and the only glob
 * that covers every sub-command is one that consists of nothing but `*`: `*`
 * and `**` do, `git *` does not.
 */
function coversEveryCommand(entry: string): boolean {
  const trimmed = entry.trim();
  return trimmed.length > 0 && [...trimmed].every((character) => character === '*');
}

/**
 * The `excludedCommands` entries that exempt a command.
 *
 * Every part of a compound command must match an entry; otherwise the command is
 * not exempt at all and the result is empty. A part that carries a command
 * substitution is never exempt: the shell evaluates the substitution before the
 * command runs, so an exempt part that carries one would run the substituted
 * command on the host.
 *
 * **The substitution check runs on the raw part.** The redirections are
 * stripped *after* it, because `stripRedirections` deletes the redirection's
 * target — and a target that carries a substitution is exactly the escape this
 * check exists to stop. The entry that is reported is the **trimmed** entry, so
 * a list that carries a stray space does not report one.
 */
export function matchingExclusions(command: string, entries: readonly string[]): string[] {
  if (entries.length === 0) return [];
  const parts = splitShellCommand(command).filter((part) => part.trim().length > 0);
  if (parts.length === 0) return [];

  const matched = new Set<string>();
  for (const rawPart of parts) {
    // The raw part, before anything is stripped: a substitution in a
    // redirection target is a substitution.
    if (carriesCommandSubstitution(rawPart)) return [];
    const part = stripWrappers(stripRedirections(rawPart)).trim();
    if (part.length === 0) continue;
    const entry = entries.find((candidate) => exclusionMatches(candidate, part));
    if (entry === undefined) return [];
    matched.add(entry.trim());
  }
  return [...matched];
}

/**
 * Whether a sub-command carries a command substitution.
 *
 * Both spellings are refused: `$( … )` and the backtick form. The shell expands
 * them before the command runs, so a sub-command that carries one is not the
 * command the exclusion entry names. The check runs on the **raw** part, so a
 * substitution that hides in a redirection target is caught as well.
 *
 * The **process substitution** forms (`<( … )` and `>( … )`) are refused too.
 * They are not command substitutions, but a shell that supports them runs the
 * command inside the parentheses, so an exempt part that carries one would run
 * it on the host exactly as a `$( … )` would. This implementation's shell is `/bin/sh`,
 * which is `dash` on some hosts and `bash` on others, so the refusal does not
 * depend on which one it is.
 */
function carriesCommandSubstitution(part: string): boolean {
  return (
    part.includes('$(') ||
    part.includes('`') ||
    part.includes('<(') ||
    part.includes('>(')
  );
}

/**
 * Whether an exclusion entry covers a sub-command.
 *
 * An entry with a `*` is a glob over the whole sub-command. An entry without one
 * covers the sub-command only when it is the sub-command: the entry must cover
 * the **whole** sub-command, so `git status` does not cover `git status
 * --short` and, above all, does not cover `git status "$(rm -rf /tmp/x)"`.
 *
 * The entry is **trimmed** before it is compared, so a list that carries a
 * stray space still covers the command it names; the trimmed form is the one
 * that is reported.
 */
function exclusionMatches(entry: string, part: string): boolean {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes('*')) return globMatches(trimmed, part);
  return part === trimmed;
}

/** Whether a glob pattern covers a whole string. */
function globMatches(pattern: string, value: string): boolean {
  const source = pattern.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}$`).test(value);
}

/** Escape the regular-expression metacharacters of a literal. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read the sandbox policy out of a settings document.
 *
 * The document's `sandbox` block carries the policy. A document without one yields
 * the default policy.
 */
export function readSandboxPolicy(settings: unknown): SandboxPolicy {
  if (!isRecord(settings)) return DEFAULT_SANDBOX_POLICY;
  if (!Object.hasOwn(settings, 'sandbox')) return DEFAULT_SANDBOX_POLICY;
  return parseSandboxPolicy(settings['sandbox']);
}

/**
 * Read the sandbox policy out of a bare `sandbox` block.
 *
 * A key with the wrong type is ignored rather than trusted: the settings file is
 * caller-supplied data, and a malformed block must not become a malformed policy.
 */
export function parseSandboxPolicy(block: unknown): SandboxPolicy {
  if (!isRecord(block)) return DEFAULT_SANDBOX_POLICY;
  const filesystem = readFilesystemPolicy(block['filesystem']);
  const network = readNetworkPolicy(block['network']);
  return {
    enabled: readBoolean(block, 'enabled') ?? DEFAULT_SANDBOX_POLICY.enabled,
    enabledPlatforms:
      readStringArray(block, 'enabledPlatforms') ?? DEFAULT_SANDBOX_POLICY.enabledPlatforms,
    failIfUnavailable:
      readBoolean(block, 'failIfUnavailable') ?? DEFAULT_SANDBOX_POLICY.failIfUnavailable,
    allowUnsandboxedCommands:
      readBoolean(block, 'allowUnsandboxedCommands') ??
      DEFAULT_SANDBOX_POLICY.allowUnsandboxedCommands,
    excludedCommands:
      readStringArray(block, 'excludedCommands') ?? DEFAULT_SANDBOX_POLICY.excludedCommands,
    ...(filesystem === undefined ? {} : { filesystem }),
    ...(network === undefined ? {} : { network }),
  };
}

/**
 * Read the `sandbox.network` block.
 *
 * A block with the wrong type is ignored rather than trusted: the settings file is
 * caller-supplied data, and a malformed block must not become a malformed policy.
 * A list that is not an array of strings is dropped, and the rest of the block is
 * kept.
 */
function readNetworkPolicy(block: unknown): SandboxNetworkPolicy | undefined {
  if (!isRecord(block)) return undefined;
  return {
    allowedDomains: readStringArray(block, 'allowedDomains') ?? DEFAULT_SANDBOX_NETWORK_POLICY.allowedDomains,
    deniedDomains: readStringArray(block, 'deniedDomains') ?? DEFAULT_SANDBOX_NETWORK_POLICY.deniedDomains,
    deniedDomainReasons: readStringRecord(block, 'deniedDomainReasons'),
    strictAllowlist: readBoolean(block, 'strictAllowlist') ?? DEFAULT_SANDBOX_NETWORK_POLICY.strictAllowlist,
    allowManagedDomainsOnly:
      readBoolean(block, 'allowManagedDomainsOnly') ??
      DEFAULT_SANDBOX_NETWORK_POLICY.allowManagedDomainsOnly,
    ...(readPort(block, 'httpProxyPort') === undefined
      ? {}
      : { httpProxyPort: readPort(block, 'httpProxyPort') }),
    ...(readPort(block, 'socksProxyPort') === undefined
      ? {}
      : { socksProxyPort: readPort(block, 'socksProxyPort') }),
    tlsTerminate: readBoolean(block, 'tlsTerminate') ?? DEFAULT_SANDBOX_NETWORK_POLICY.tlsTerminate,
    allowUnixSockets: readStringArray(block, 'allowUnixSockets') ?? DEFAULT_SANDBOX_NETWORK_POLICY.allowUnixSockets,
    allowAllUnixSockets:
      readBoolean(block, 'allowAllUnixSockets') ??
      DEFAULT_SANDBOX_NETWORK_POLICY.allowAllUnixSockets,
    allowLocalBinding:
      readBoolean(block, 'allowLocalBinding') ?? DEFAULT_SANDBOX_NETWORK_POLICY.allowLocalBinding,
    allowMachLookup: readStringArray(block, 'allowMachLookup') ?? DEFAULT_SANDBOX_NETWORK_POLICY.allowMachLookup,
  };
}

/**
 * Read the `sandbox.network` block out of a settings document.
 *
 * The document's `sandbox.network` carries the policy. A document without one
 * yields the default policy.
 *
 * **Observed** — the target's own block, `chunk-3rfnbzz0.js:11 700` – `14 600`.
 */
export function readSandboxNetworkPolicy(settings: unknown): SandboxNetworkPolicy {
  if (!isRecord(settings)) return DEFAULT_SANDBOX_NETWORK_POLICY;
  if (!Object.hasOwn(settings, 'sandbox')) return DEFAULT_SANDBOX_NETWORK_POLICY;
  const sandbox = settings['sandbox'];
  if (!isRecord(sandbox)) return DEFAULT_SANDBOX_NETWORK_POLICY;
  if (!Object.hasOwn(sandbox, 'network')) return DEFAULT_SANDBOX_NETWORK_POLICY;
  return readNetworkPolicy(sandbox['network']) ?? DEFAULT_SANDBOX_NETWORK_POLICY;
}

/**
 * Read the `sandbox.filesystem` block.
 *
 * A block with the wrong type is ignored rather than trusted: the settings file
 * is caller-supplied data, and a malformed block must not become a malformed
 * policy. A list that is not an array of strings is dropped, and the rest of the
 * block is kept.
 */
function readFilesystemPolicy(block: unknown): SandboxFilesystemPolicy | undefined {
  if (!isRecord(block)) return undefined;
  const allowRead = readStringArray(block, 'allowRead');
  const allowWrite = readStringArray(block, 'allowWrite');
  const denyRead = readStringArray(block, 'denyRead');
  const denyWrite = readStringArray(block, 'denyWrite');
  const credentials = readStringArray(block, 'credentials');
  if (
    allowRead === undefined &&
    allowWrite === undefined &&
    denyRead === undefined &&
    denyWrite === undefined &&
    credentials === undefined
  ) {
    return undefined;
  }
  return {
    ...(allowRead === undefined ? {} : { allowRead }),
    ...(allowWrite === undefined ? {} : { allowWrite }),
    ...(denyRead === undefined ? {} : { denyRead }),
    ...(denyWrite === undefined ? {} : { denyWrite }),
    ...(credentials === undefined ? {} : { credentials }),
  };
}

/** Whether a value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a boolean member of an object, if it has one. */
function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Read a string-array member of an object, if it has one. */
function readStringArray(source: Record<string, unknown>, key: string): string[] | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === 'string')) return undefined;
  return [...(value as string[])];
}

/** Read a string-valued record member of an object, if it has one. */
function readStringRecord(
  source: Record<string, unknown>,
  key: string,
): Readonly<Record<string, string>> {
  if (!Object.hasOwn(source, key)) return {};
  const value = source[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const entries: Record<string, string> = {};
  for (const [name, reason] of Object.entries(value as Record<string, unknown>)) {
    if (typeof reason !== 'string') continue;
    entries[name] = reason;
  }
  return entries;
}

/** Read a TCP port member of an object, if it has a usable one. */
function readPort(source: Record<string, unknown>, key: string): number | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > 65535) return undefined;
  return value;
}

/* -------------------------------------------------------------------------- */
/* The egress firewall's own rules                                             */
/* -------------------------------------------------------------------------- */

/**
 * One entry of a host list, split into its host and its port.
 *
 * **Observed** — the target's sandbox runtime's `kee`, `chunk-ew44hcmm.js:21 314`.
 */
export interface SandboxHostEntry {
  /** The host pattern, as the entry spells it. */
  readonly hostPattern: string;
  /** The port, when the entry carries one. */
  readonly port?: number;
}

/** Strip the brackets an IPv6 literal is written with. */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** The port an entry names, when it names a usable one. */
function entryPort(text: string): number | undefined {
  if (!/^[1-9][0-9]{0,4}$/.test(text)) return undefined;
  const value = Number(text);
  return value > 65535 ? undefined : value;
}

/**
 * Split a host-list entry into its host and its port.
 *
 * **Observed** — the target's sandbox runtime's `kee`, `chunk-ew44hcmm.js:21 314`.
 * The port is the text after the **last** colon, and it is a port only when it
 * is a number from 1 to 65535. A bracketed IPv6 literal is split at the bracket;
 * an unbracketed one (which carries several colons) is a host with no port.
 */
export function parseSandboxHostEntry(entry: string): SandboxHostEntry {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    if (close === -1) return { hostPattern: entry };
    const host = stripBrackets(entry.slice(1, close)).toLowerCase().replace(/\.$/, '');
    const rest = entry.slice(close + 1);
    if (rest === '') return { hostPattern: host };
    const port = entryPort(rest.startsWith(':') ? rest.slice(1) : '');
    return port === undefined ? { hostPattern: entry } : { hostPattern: host, port };
  }
  const separator = entry.lastIndexOf(':');
  if (separator === -1) return { hostPattern: entry };
  if (entry.indexOf(':') !== separator) {
    // More than one colon: an unbracketed IPv6 literal, which carries no port.
    return { hostPattern: stripBrackets(entry).toLowerCase().replace(/\.$/, '') };
  }
  const port = entryPort(entry.slice(separator + 1));
  if (port === undefined) return { hostPattern: entry };
  return { hostPattern: entry.slice(0, separator), port };
}

/**
 * Whether a host is covered by a host-list entry.
 *
 * **Observed** — the target's sandbox runtime's `A8e`, `chunk-ew44hcmm.js:21 523`.
 *
 *   - the entry `*` covers every host;
 *   - an entry that starts with `*.` covers a host that **ends with** the rest of
 *     the entry — so `*.corp.com` covers `a.corp.com` and `a.b.corp.com` but
 *     **not** `corp.com` — and it never covers an **address literal**;
 *   - any other entry must equal the host, case-insensitively.
 */
export function sandboxHostMatches(host: string, pattern: string): boolean {
  const name = host.toLowerCase();
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    if (isIP(stripBrackets(name)) !== 0) return false;
    return name.endsWith(`.${pattern.slice(2).toLowerCase()}`);
  }
  return name === pattern.toLowerCase();
}

/**
 * Whether a host and a port are covered by a host-list entry.
 *
 * **Observed** — the target's sandbox runtime's `izn`, `chunk-ew44hcmm.js:21 900`.
 * An entry that carries a port restricts itself to that port.
 */
export function sandboxHostEntryMatches(host: string, port: number, entry: string): boolean {
  const parsed = parseSandboxHostEntry(entry);
  if (parsed.port !== undefined && parsed.port !== port) return false;
  return sandboxHostMatches(host, parsed.hostPattern);
}

/** The entry of a list that covers a host and a port, if one does. */
function matchingEntry(
  entries: readonly string[],
  host: string,
  port: number,
): string | undefined {
  return entries.find((entry) => sandboxHostEntryMatches(host, port, entry));
}

/**
 * The decision about one egress request.
 *
 * `allow` — the host is on the allowlist. `deny` — the host is on the deny list,
 * or the allowlist is strict and the host is not on it. `ask` — the host is not
 * on the allowlist and the policy does not deny it outright.
 */
export interface SandboxEgressDecision {
  /** What the policy says about the request. */
  readonly outcome: 'allow' | 'deny' | 'ask';
  /** Whether the request may go out. */
  readonly allowed: boolean;
  /** Why, in the target's own spirit. */
  readonly reason?: string;
}

/**
 * Decide whether a request may leave the sandbox.
 *
 * **Observed.** The target's own rule (`chunk-3rfnbzz0.js:11 700`) is that the
 * **deny** list wins over the allowlist — "Domains that are always blocked, even
 * if matched by allowedDomains" — and that `strictAllowlist` denies a host that
 * is not on the allowlist "without consulting the ask callback".
 *
 * The `deniedDomainReasons` map is keyed by the **exact** entry string, so a
 * reason that names a different spelling of the same host never fires.
 */
export function evaluateSandboxEgress(
  target: { host: string; port: number },
  policy: SandboxNetworkPolicy,
): SandboxEgressDecision {
  const { host, port } = target;
  const denied = matchingEntry(policy.deniedDomains, host, port);
  if (denied !== undefined) {
    const reason = policy.deniedDomainReasons[denied];
    return {
      outcome: 'deny',
      allowed: false,
      reason: reason ?? `the host ${host} is on the denied list (${denied})`,
    };
  }
  if (matchingEntry(policy.allowedDomains, host, port) !== undefined) {
    return { outcome: 'allow', allowed: true };
  }
  if (policy.strictAllowlist) {
    return {
      outcome: 'deny',
      allowed: false,
      reason: `the host ${host} is not in the allowlist, and the strict allowlist denies it`,
    };
  }
  return {
    outcome: 'ask',
    allowed: false,
    reason: `the host ${host} is not in the allowlist`,
  };
}

/**
 * Merge the network policies of several settings sources.
 *
 * **Observed** — the target's sandbox-option merge, `chunk-5gektv5j.js:5 899`:
 * `network.deniedDomains` is a **union** across the sources, and every other
 * member is taken **whole** from the highest source that sets it.
 */
export function mergeSandboxNetworkPolicies(
  policies: readonly SandboxNetworkPolicy[],
): SandboxNetworkPolicy {
  const deniedDomains: string[] = [];
  let allowedDomains: readonly string[] = DEFAULT_SANDBOX_NETWORK_POLICY.allowedDomains;
  let deniedDomainReasons: Readonly<Record<string, string>> =
    DEFAULT_SANDBOX_NETWORK_POLICY.deniedDomainReasons;
  let strictAllowlist = DEFAULT_SANDBOX_NETWORK_POLICY.strictAllowlist;
  let allowManagedDomainsOnly = DEFAULT_SANDBOX_NETWORK_POLICY.allowManagedDomainsOnly;
  let httpProxyPort: number | undefined;
  let socksProxyPort: number | undefined;
  let tlsTerminate = DEFAULT_SANDBOX_NETWORK_POLICY.tlsTerminate;
  let allowUnixSockets: readonly string[] = DEFAULT_SANDBOX_NETWORK_POLICY.allowUnixSockets;
  let allowAllUnixSockets = DEFAULT_SANDBOX_NETWORK_POLICY.allowAllUnixSockets;
  let allowLocalBinding = DEFAULT_SANDBOX_NETWORK_POLICY.allowLocalBinding;
  let allowMachLookup: readonly string[] = DEFAULT_SANDBOX_NETWORK_POLICY.allowMachLookup;

  for (const policy of policies) {
    allowedDomains = policy.allowedDomains;
    deniedDomains.push(...policy.deniedDomains);
    deniedDomainReasons = { ...deniedDomainReasons, ...policy.deniedDomainReasons };
    strictAllowlist = policy.strictAllowlist;
    allowManagedDomainsOnly = policy.allowManagedDomainsOnly;
    httpProxyPort = policy.httpProxyPort;
    socksProxyPort = policy.socksProxyPort;
    tlsTerminate = policy.tlsTerminate;
    allowUnixSockets = policy.allowUnixSockets;
    allowAllUnixSockets = policy.allowAllUnixSockets;
    allowLocalBinding = policy.allowLocalBinding;
    allowMachLookup = policy.allowMachLookup;
  }

  return {
    allowedDomains,
    deniedDomains: [...new Set(deniedDomains)],
    deniedDomainReasons,
    strictAllowlist,
    allowManagedDomainsOnly,
    ...(httpProxyPort === undefined ? {} : { httpProxyPort }),
    ...(socksProxyPort === undefined ? {} : { socksProxyPort }),
    tlsTerminate,
    allowUnixSockets,
    allowAllUnixSockets,
    allowLocalBinding,
    allowMachLookup,
  };
}

/**
 * The capability the target's egress firewall needs.
 *
 * This implementation has a host-side sandbox proxy of its own, but it does not
 * have the target's **egress firewall**: the sandbox runtime's domain filter,
 * its deny list, its strict allowlist, its resolved-address check, its MITM
 * proxy and its TLS termination. The refusal names what is missing.
 */
export const EGRESS_FIREWALL_CAPABILITY =
  'the sandbox runtime egress firewall (the domain filter, the deny list, the strict allowlist and the resolved-address check)';

/**
 * The refusal an egress-firewall operation raises.
 *
 * The pattern is the one the IDE surface uses: the refusal names the capability
 * the operation needed, so a reader can tell what is missing.
 */
export class EgressFirewallCapabilityError extends Error {
  /** The stable code of the refusal. */
  readonly code = 'egress_firewall_unavailable';

  /** The capability the operation needed. */
  readonly capability: string;

  constructor(capability: string, operation: string) {
    super(
      `${operation} needs ${capability}, which this session does not have, so it was not attempted.`,
    );
    this.name = 'EgressFirewallCapabilityError';
    this.capability = capability;
  }
}

/**
 * Enforce the egress firewall for one request.
 *
 * **This implementation's** entry point, and the one that **refuses**. The target
 * enforces the firewall inside the sandbox runtime, where the request is
 * filtered before it is dialled. This implementation has no such filter, so the
 * operation refuses and names the capability it needed.
 */
export function enforceSandboxEgress(
  _target: { host: string; port: number },
  _policy: SandboxNetworkPolicy,
): never {
  throw new EgressFirewallCapabilityError(
    EGRESS_FIREWALL_CAPABILITY,
    'Enforcing the sandbox egress firewall',
  );
}
