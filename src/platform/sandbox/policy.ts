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
 * The decision is `deny` when the platform is excluded or the sandbox is switched
 * off, `unconfined` when the command is exempt or the backend is missing and the
 * policy tolerates that, and `allow` otherwise.
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
  };
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
