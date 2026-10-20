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
 *   - An exclusion entry matches a sub-command when the sub-command **equals** the
 *     entry, **starts with** the entry followed by whitespace (`git` matches `git
 *     status`), or — when the entry carries a `*` — matches the whole sub-command
 *     as a glob. The shell wrappers the target strips (`timeout`, `nice`, `nohup`,
 *     …) are stripped before the comparison.
 *   - `enabledPlatforms` is a **whitelist**: a platform that is not in the list is
 *     excluded. An unset list takes the default (`['linux']`, the only platform the
 *     implementation's backend implements); an explicitly empty list excludes every platform.
 *   - The reason for a refusal that the audit does not name — the backend is missing
 *     and `failIfUnavailable` is true — is a reimplementation string. The audit names the
 *     other four reasons exactly, and this one says the same thing in the same
 *     shape.
 *
 * **The residual risk.** The policy decides what the sandbox *does*; it is not
 * itself a boundary. Every layer of the sandbox shares one kernel, so a kernel
 * privilege escalation reachable from the sandbox defeats all of them, and
 * unprivileged user namespaces widen the reachable surface. Only a microVM moves
 * the boundary below the kernel.
 */

import { splitShellCommand, stripWrappers } from '../../permissions/shell.js';

/** The platforms this implementation's sandbox backend implements. */
export const SANDBOX_SUPPORTED_PLATFORMS: readonly string[] = ['linux'];

/**
 * The sandbox policy.
 *
 * The five members are the target's `sandbox` block, in the order the audit names
 * them.
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
}

/** The policy type under the name the plan uses. */
export type sandboxPolicy = SandboxPolicy;

/** The policy this implementation uses when a settings document says nothing. */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = Object.freeze({
  enabled: true,
  enabledPlatforms: Object.freeze(['linux']) as readonly string[],
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  excludedCommands: Object.freeze([]) as readonly string[],
});

/** The default policy, under the name the plan uses. */
export const sandboxPolicy: SandboxPolicy = DEFAULT_SANDBOX_POLICY;

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
 * The availability the policy assumes for a platform.
 *
 * This implementation's backend is Linux-only, so another platform has no backend. The
 * launcher passes the **host's** real availability instead.
 */
function assumedAvailability(platform: string): SandboxAvailability {
  return SANDBOX_SUPPORTED_PLATFORMS.includes(platform) ? 'available' : 'unavailable';
}

/**
 * Decide what to do with a command.
 *
 * The decision is `deny` when the platform is excluded or the sandbox is switched
 * off, `unconfined` when the command is exempt or the backend is missing and the
 * policy tolerates that, and `allow` otherwise.
 */
export function evaluateSandbox(
  policy: SandboxPolicy,
  platform: string,
  command: string,
  availability: SandboxAvailability = assumedAvailability(platform),
): SandboxEvaluation {
  if (!policy.enabledPlatforms.includes(platform)) {
    return { decision: 'deny', reason: SANDBOX_REASONS.platformExcluded(platform) };
  }
  if (!policy.enabled) {
    return { decision: 'deny', reason: SANDBOX_REASONS.disabled };
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
 * The `excludedCommands` entries that exempt a command.
 *
 * Every part of a compound command must match an entry; otherwise the command is
 * not exempt at all and the result is empty.
 */
export function matchingExclusions(command: string, entries: readonly string[]): string[] {
  if (entries.length === 0) return [];
  const parts = splitShellCommand(command)
    .map((part) => stripWrappers(part).trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return [];

  const matched = new Set<string>();
  for (const part of parts) {
    const entry = entries.find((candidate) => exclusionMatches(candidate, part));
    if (entry === undefined) return [];
    matched.add(entry);
  }
  return [...matched];
}

/**
 * Whether an exclusion entry covers a sub-command.
 *
 * An entry with a `*` is a glob over the whole sub-command. An entry without one
 * covers the sub-command when it equals it or when it is a prefix followed by
 * whitespace.
 */
function exclusionMatches(entry: string, part: string): boolean {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes('*')) return globMatches(trimmed, part);
  return part === trimmed || part.startsWith(`${trimmed} `);
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
