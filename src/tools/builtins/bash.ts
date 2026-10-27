/**
 * The `Bash` tool: run a shell command.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.5 (Permissions, "Tool
 * contract" and "Rule sources") and §2.9 ("Native and platform sandbox"), and the
 * `CC-008` and `CC-008b` milestones of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **A Bash rule matches command text, not program identity.** The research is
 * explicit: `Bash(curl *)` does not stop `/usr/bin/curl` or `sh -c 'curl …'`, and
 * the target's own documentation calls these rules "not a security boundary around
 * the program". The tool therefore does not claim any such guarantee: it hands the
 * command text to the rule engine and does what the engine says, and it does not
 * try to decide which program the shell will run.
 *
 * **A compound command is split and every part is matched independently.** That is
 * the rule engine's job, not the tool's, and the engine splits on `&&`, `||`, `;`,
 * `|`, `|&`, `&` and newlines with **no cap** on the number of parts.
 *
 * **A shell command is concurrency safe only when it is read-only.** The
 * target's `Bash` tool declares the flag as
 * `isConcurrencySafe(e){return this.isReadOnly?.(e)??!1}`, and the read-only
 * rule is the target's own: it lives in `src/tools/readonly.ts`, and this
 * tool's flag is that rule.
 *
 * **The `dangerouslyDisableSandbox` flag is not a permission bypass.** The sandbox
 * is a separate layer from the permissions, and the flag never skips a permission
 * rule: the permission check runs on the command whether the flag is set or not.
 * The flag skips the **sandbox** and nothing else.
 *
 * **The flag is the target's own, and its routing is the target's too.** The
 * reading the `CC-024` milestone is built on established both, from the
 * target's own bundle:
 *
 *   - the **field name** — the target's `Bash` tool declares
 *     `dangerouslyDisableSandbox` in its input schema, described as "Set this
 *     to true to dangerously override sandbox mode and run commands without
 *     sandboxing", and the tool's permission check reads that same field. The
 *     flag is therefore the **target's data**, and this implementation
 *     reproduces it under the target's name;
 *   - the **routing** — the target asks its own predicate "must this command
 *     be sandboxed?" twice, once with the flag and once without, and the flag
 *     is what changes the routing when the two answers differ. The predicate
 *     consults the flag **before** the command's own exemption, and it
 *     consults it only when the policy **permits** unsandboxed commands: the
 *     target's own settings block says that
 *     `sandbox.allowUnsandboxedCommands` "allows commands to run outside the
 *     sandbox via the `dangerouslyDisableSandbox` parameter" and that "when
 *     false, the `dangerouslyDisableSandbox` parameter is completely ignored and
 *     all commands must run sandboxed". See {@link sandboxRoutingOf};
 *   - the **report** — the target does not silently honour the flag. When the
 *     ordinary decision is an **allow** that is not rule-derived, the target
 *     replaces it with an **ask** whose reason kind is `sandboxOverride` and
 *     whose message is "Run outside of the sandbox", so the user is asked
 *     whether the command may run outside the sandbox. A denial keeps its own
 *     reason, an ask that was already put to the user is not asked again, and
 *     a rule-derived allow keeps its rule.
 *
 * **The flag never overrides a policy error.** The flag is a **tool input field**
 * — the model supplies it — while `sandbox.enabled: false` and
 * `sandbox.enabledPlatforms` are the **user's settings file**. A model that could
 * opt itself out of a user-configured control would make the control advisory,
 * and the plan's global constraint says that the shell execution is enforced by
 * implementation-owned code, independent of the model instructions. So the flag overrides
 * the **routing** of a command the policy would otherwise run inside the sandbox,
 * and it overrides **nothing else**:
 *
 *   - a **denial** is a denial: `sandbox.enabled is false`,
 *     `sandbox.enabledPlatforms excludes <platform>` and the refusal a missing
 *     backend earns under `failIfUnavailable: true` are refusals whether the flag
 *     is set or not — the flag turns none of them into a run;
 *   - an **allow** is routed outside the sandbox when the flag is set;
 *   - an **unconfined** decision is unconfined either way, and the policy's own
 *     reason is the one reported.
 *
 * The flag is read as an **own** field of the input, exactly as the validator
 * reads it: an input that inherits `dangerouslyDisableSandbox` from its prototype
 * has no such field, and the validator and the runner must agree about that.
 *
 * **The command runs through the sandbox.** The tool resolves the session's
 * sandbox policy, asks the policy what to do with the command, and routes the
 * command accordingly:
 *
 *   - **allowed** — the command runs through `launchSandbox`, inside the sandbox
 *     the policy describes;
 *   - **unconfined** — the command runs on the host, with the **reason** the
 *     policy gave and the `excludedCommands` exemptions that applied;
 *   - **denied** — the command is **refused**, and the refusal names the reason.
 *
 * The reason strings are the target's, verbatim: `sandbox.enabledPlatforms
 * excludes <platform>`, `sandbox.enabled is false`, `sandbox.failIfUnavailable is
 * false (a missing backend would run the shell unconfined)` and
 * `sandbox.allowUnsandboxedCommands is true`. The refusal the policy produces is
 * reported as a **refusal** — a typed failure that names the reason — and never as
 * a command that ran and exited with a non-zero status.
 *
 * **The availability is probed, never assumed.** The tool asks the backend
 * whether it can run on this host, and it hands the answer to `evaluateSandbox` as
 * its fourth argument. A host with no backend is never reported as available by
 * default, so the policy's `failIfUnavailable` decides between a refusal and an
 * unconfined run. The probe is **one** probe per call: the same answer goes to
 * `evaluateSandbox` and to the launcher, so the two provably cannot disagree. The
 * reason and the warning the probe reported are carried into the result instead
 * of being thrown away.
 *
 * **Neither path sees the agent's credentials.** The sandbox filters the
 * environment against an allowlist (`PATH`, `HOME`, `LANG`, `TERM` and the
 * proxy-socket variable), and the tool applies **the same filter** to every
 * command that runs outside the sandbox: a command the policy exempts, a command
 * the flag asked for, and a command of a session that has no sandbox policy at all
 * are all the agent's commands, and the agent's API key is in the session's
 * environment.
 *
 * **The sandbox is in the production path.** The CLI builds the tools'
 * dependencies from `loadSettings(...)` and passes the loaded sandbox policy:
 * the `BuiltinToolDeps` the session assembly builds carries
 * `sandboxPolicy: settings.sandboxPolicy`, so a configured session's commands
 * run inside the sandbox. A session that supplies **no** policy at all still
 * takes the no-policy branch — it runs on the host, unconfined — and that
 * branch filters the environment too, so it never exposes the agent's
 * credentials either.
 *
 * Implementation choices (the audit does not pin them, so they are marked here):
 *
 *   - The command runs through `/bin/sh -c`, with the session's working directory
 *     as its directory and the **session's environment** — the `env` the session
 *     supplies, and the process environment when it supplies none — filtered
 *     against the sandbox's allowlist. The target documents a **persistent**
 *     shell session; this implementation runs a shell per call, which is a labelled implementation
 *     choice and not a claim of equivalence.
 *   - The default timeout is `120000` ms and the maximum is `600000` ms. The audit
 *     does not pin the shell timeout. A timeout of `0` is refused: it would stop
 *     the command before it began.
 *   - The output is capped, so a command that prints without bound does not fill
 *     the context window. On the **sandboxed** path the launcher caps **at its
 *     collection point**, so the cap bounds the memory the process holds, not
 *     only what the tool reports. The cap the tool reports is unchanged.
 *   - A command that runs **past its timeout** is reported with the exit code
 *     `124`, the same message and the same `truncated` flag on both paths. On the
 *     sandboxed path the output is the **partial** output the command had
 *     produced when it was stopped — the launcher keeps what it has collected
 *     and the tool reads it after the stop, with a bounded grace period for a
 *     backend that does not collect. The result says so itself: `timedOut` is
 *     `true`.
 *   - The **output shape** — `{ type: 'text', text, stdout, stderr, exitCode,
 *     truncated, sandboxed, sandboxReason, sandboxEstablishmentReason,
 *     sandboxExemptions, sandboxExemptionScope, sandboxAvailability, timedOut }` —
 *     is a implementation choice: the audit pins the tool-result *metadata*, not the
 *     content a tool returns. The sandbox members report **what the sandbox
 *     did**: whether the command ran inside it, why it ran outside it (when it
 *     did), why the sandbox never came up (when it did not), the
 *     `excludedCommands` exemptions that applied, the **scope** of the exclusion
 *     list, and what the backend's availability probe reported.
 *   - A session that supplies **no** sandbox policy has no sandbox at all: the
 *     command runs on the host, with the filtered environment and the reason
 *     `no sandbox policy is configured for this session, so the command runs
 *     outside the sandbox`. The settings loader always supplies one
 *     (`SettingsLoadResult.sandboxPolicy`), so a configured session always has
 *     the sandbox in front of it.
 *   - The `dangerouslyDisableSandbox` flag asks for an **unconfined** run of a
 *     command the policy would otherwise sandbox, and it does so whatever the
 *     policy says about the sandbox — but never over a **denial**, as the header
 *     above says. It never touches the permission layer either.
 *   - The availability probe costs a **fork and an exec per call**, and the probe
 *     is **not** cached: a cached probe would answer for a host that changed
 *     under the session, and the "one probe, one answer" property is what makes
 *     the policy's decision and the launcher's decision provably the same. The
 *     cost is paid on every `Bash` call.
 */

import { spawn, type ChildProcess} from 'node:child_process';

import { ToolExecutionError, TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import {
  SANDBOX_OVERRIDE_MESSAGE,
  sandboxOverrideDecision,
  type PermissionDecision,
  type ToolContext,
} from '../../permissions/decision.js';
import { isReadOnlyCommand } from '../readonly.js';
import { defaultSandboxBackend } from '../../platform/sandbox/helper.js';
import {
  SandboxRefusedError,
  launchSandbox,
  sandboxEnvironment,
  type LaunchedSandbox,
  type SandboxBackend,
  type SandboxRunResult,
  type SandboxSpec,
} from '../../platform/sandbox/launcher.js';
import {
  evaluateSandbox,
  exemptionScope,
  type SandboxAvailability,
  type SandboxExemptionScope,
  type SandboxPolicy,
} from '../../platform/sandbox/policy.js';

import {
  checkToolPermissions,
  recheckToolPermissions,
  optionalIntegerField,
  readInputField,
  rejectUnknownFields,
  requireStringField,
  type BuiltinToolDeps,
} from './shared.js';

/** The input of the `Bash` tool. */
export interface BashInput {
  /** The command to run. */
  command: string;
  /** What the command does, for the user. */
  description?: string;
  /** The timeout in milliseconds. */
  timeout?: number;
  /**
   * Whether the sandbox is skipped. It never skips a permission rule, and it
   * never overrides a policy **error**: it only routes a command the policy
   * would have sandboxed.
   */
  dangerouslyDisableSandbox?: boolean;
}

/** What the backend's availability probe reported. */
export interface SandboxAvailabilityReport {
  /** Whether the backend can run on this host. */
  available: boolean;
  /** Why it cannot, when it cannot. */
  reason?: string;
  /** What the probe could not establish. */
  warning?: string;
}

/** The output of the `Bash` tool. */
export interface BashOutput {
  type: 'text';
  /** The standard output of the command. */
  text: string;
  /** The standard output of the command. */
  stdout: string;
  /** The standard error of the command. */
  stderr: string;
  /** The exit code of the command. */
  exitCode: number;
  /** Whether the output was capped. */
  truncated: boolean;
  /**
   * Whether the command ran inside the sandbox.
   *
   * It is the **backend's own report**: a sandbox that never came up reports
   * `false`, whatever the policy decided.
   */
  sandboxed: boolean;
  /**
   * Why the command ran **outside** the sandbox, when it did.
   *
   * It is the reason the policy gave, or the reason the call asked for an
   * unsandboxed run. It says nothing about a sandbox that never came up: that
   * is `sandboxEstablishmentReason`.
   */
  sandboxReason?: string;
  /** Why the sandbox **never came up**, when it did not. */
  sandboxEstablishmentReason?: string;
  /** The `excludedCommands` exemptions that applied to the command. */
  sandboxExemptions?: readonly string[];
  /**
   * The scope the `excludedCommands` list covers.
   *
   * `all` means the list carries an entry that matches **every** command: with
   * `allowUnsandboxedCommands` set, the sandbox is then switched off for the
   * whole command space. The semantics are the target's; this implementation reports the
   * reach of the list, so the hazard is visible.
   */
  sandboxExemptionScope?: SandboxExemptionScope;
  /** What the backend's availability probe reported. */
  sandboxAvailability?: SandboxAvailabilityReport;
  /**
   * Whether the command was stopped for running past its timeout.
   *
   * The output that comes with it is the output the command had produced when
   * it was stopped.
   */
  timedOut?: boolean;
}

/** The input schema of the `Bash` tool. */
export const BASH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The command to run.',
    },
    description: {
      type: 'string',
      description: 'A short description of what the command does.',
    },
    timeout: {
      type: 'integer',
      minimum: 1,
      description: 'The timeout in milliseconds.',
    },
    dangerouslyDisableSandbox: {
      type: 'boolean',
      description:
        'Whether the sandbox is skipped. It never skips a permission rule, and it never overrides a sandbox policy error: a matching deny rule still blocks the call, and a policy that refuses to sandbox the command still refuses it.',
    },
  },
  required: ['command'],
  additionalProperties: false,
} as const;

/** The default timeout of a shell command. */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/** The largest timeout a shell command may ask for. */
export const MAX_BASH_TIMEOUT_MS = 600_000;

/** The number of output characters the tool reports. */
export const MAX_BASH_OUTPUT_CHARS = 200_000;

/**
 * The reason a command runs outside the sandbox when the session configured none.
 *
 * The wording is this implementation's own: the audit names no reason for a session that
 * has no sandbox at all.
 */
export const SANDBOX_NOT_CONFIGURED_REASON =
  'no sandbox policy is configured for this session, so the command runs outside the sandbox';

/**
 * The reason a permission decision carries when the call asked for an
 * unsandboxed run.
 *
 * **The target's.** The target's own source renders the `sandboxOverride`
 * decision reason as "Run outside of the sandbox", and the decision the target
 * builds carries the same words as its message.
 */
export const SANDBOX_OVERRIDE_REASON = SANDBOX_OVERRIDE_MESSAGE;

/**
 * The reason a command runs outside the sandbox when the call asked for it.
 *
 * **The wording is this implementation's own**: the target reports *that* the
 * command runs outside the sandbox, and the target's own reason for it is the
 * flag's name — the target's decision reason carries the string
 * `dangerouslyDisableSandbox`. The target's tool-result shape is not the
 * audit's, so this implementation's own sentence is what the result carries.
 */
export const SANDBOX_SKIPPED_BY_CALL_REASON =
  'the call asked for the sandbox to be skipped (dangerouslyDisableSandbox)';

/**
 * The grace period the tool gives the launcher to hand over the output of a
 * command it stopped.
 *
 * The launcher keeps the output it has collected, so a command that was stopped
 * before it ended still yields what it had already printed — the tool reads
 * that buffer directly. This grace period is the **fallback** for a backend
 * that does not collect: the tool waits at most this long for the result. The
 * tool never waits longer than this for a process that does not die.
 */
export const SANDBOX_OUTPUT_GRACE_MS = 250;

/**
 * The timeout a command runs with.
 *
 * A call that asks for no timeout gets the default, and a call that asks for more
 * than the maximum gets the maximum. A timeout of zero is **not** a timeout: it
 * would kill the command before it started, so it is refused by the validator and
 * it never reaches here.
 */
export function resolveBashTimeout(timeout: number | undefined): number {
  if (timeout === undefined || timeout <= 0) return DEFAULT_BASH_TIMEOUT_MS;
  return Math.min(timeout, MAX_BASH_TIMEOUT_MS);
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A promise that resolves after the given delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What a command produced. */
interface BashCommandResult {
  /** The standard output. */
  stdout: string;
  /** The standard error. */
  stderr: string;
  /** The exit code of the command. */
  exitCode: number;
  /** Whether the output was capped. */
  truncated: boolean;
  /** Whether the command was stopped for running past its timeout. */
  timedOut: boolean;
}

/**
 * Run a command through the shell and collect its output.
 *
 * The environment is the one the caller filtered: the command never sees the
 * agent's credentials, whichever path it runs on.
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<BashCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The command leads its **own process group**, so the timeout can stop
      // the whole group. Without this, only the shell is killed and the
      // command's own process is orphaned and keeps running — the report would
      // say the command was stopped while it was not. It is what bubblewrap
      // does with `--die-with-parent`.
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, truncated, timedOut });
    };

    const timer = setTimeout(() => {
      truncated = true;
      timedOut = true;
      // The **group** is stopped, not just the shell: the command's own
      // process would otherwise be orphaned and keep running.
      stopProcessGroup(child);
      // The notice is **reserved room for**, so a standard error that is
      // already at the cap does not truncate it away.
      const notice = '\nThe command was stopped because it ran past its timeout.';
      stderr = `${stderr.slice(0, Math.max(0, MAX_BASH_OUTPUT_CHARS - notice.length))}${notice}`;
      finish(124);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length >= MAX_BASH_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      stdout += chunk;
      if (stdout.length > MAX_BASH_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_BASH_OUTPUT_CHARS);
        truncated = true;
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length >= MAX_BASH_OUTPUT_CHARS) return;
      stderr += chunk;
      if (stderr.length > MAX_BASH_OUTPUT_CHARS) {
        stderr = stderr.slice(0, MAX_BASH_OUTPUT_CHARS);
        truncated = true;
      }
    });
    child.on('error', (error: Error) => {
      stderr += `\n${error.message}`;
      finish(127);
    });
    child.on('close', (code: number | null) => {
      finish(code ?? 0);
    });
  });
}

/**
 * The environment a command that runs **outside** the sandbox gets.
 *
 * It is the **sandbox's** filter, not a second one: an allowlist, so the agent's
 * credentials never reach the command — not even a command the policy exempts
 * from the sandbox, not even a command the call asked to run unconfined, and not
 * even a command of a session that has no sandbox policy at all. The home
 * directory is the caller's own, because the unconfined path runs on the host,
 * where `/tmp` is shared and world-writable.
 */
function unconfinedEnvironment(spec: SandboxSpec): Record<string, string> {
  return sandboxEnvironment(spec, 'unconfined');
}

/**
 * Whether the backend can run on this host, and what the probe reported.
 *
 * The probe is the backend's own, and a probe that **fails** is an unavailable
 * backend: a host with no backend must never be reported as available. The
 * reason and the warning the probe reported are carried along, so they reach the
 * result instead of being thrown away.
 */
async function backendAvailability(
  backend: SandboxBackend,
): Promise<{ availability: SandboxAvailability; report: SandboxAvailabilityReport }> {
  try {
    const probe = await backend.isAvailable();
    return {
      availability: probe.available ? 'available' : 'unavailable',
      report: {
        available: probe.available,
        ...(probe.reason === undefined ? {} : { reason: probe.reason }),
        ...(probe.warning === undefined ? {} : { warning: probe.warning }),
      },
    };
  } catch (error) {
    return {
      availability: 'unavailable',
      report: {
        available: false,
        reason: `the availability probe failed: ${messageOf(error)}`,
      },
    };
  }
}

/**
 * The message a refusal is reported with.
 *
 * The wording is the launcher's: a refusal names the reason the policy gave.
 */
function refusalMessage(reason: string | undefined): string {
  return `the sandbox refused to run the command: ${reason ?? 'the sandbox policy refused the command'}`;
}

/** What an unconfined run reports besides the command's own output. */
interface UnconfinedReport {
  /** Why the command ran outside the sandbox. */
  reason: string;
  /** The `excludedCommands` exemptions that applied. */
  exemptions?: readonly string[];
  /** The scope the `excludedCommands` list covers. */
  scope?: SandboxExemptionScope;
  /** What the backend's availability probe reported. */
  availability?: SandboxAvailabilityReport;
}

/**
 * Run a command **outside** the sandbox, with the reason recorded.
 *
 * The environment is the filtered one: an exempt command is still the agent's
 * command, and it must not see the agent's credentials.
 */
async function runUnconfined(
  spec: SandboxSpec,
  timeoutMs: number,
  report: UnconfinedReport,
): Promise<BashOutput> {
  const result = await runCommand(
    spec.command,
    spec.cwd,
    timeoutMs,
    unconfinedEnvironment(spec),
  );
  return {
    type: 'text',
    text: result.stdout,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    truncated: result.truncated,
    ...(result.timedOut ? { timedOut: true } : {}),
    sandboxed: false,
    sandboxReason: report.reason,
    ...(report.exemptions === undefined ? {} : { sandboxExemptions: report.exemptions }),
    ...(report.scope === undefined ? {} : { sandboxExemptionScope: report.scope }),
    ...(report.availability === undefined ? {} : { sandboxAvailability: report.availability }),
  };
}

/** What a sandboxed run produced. */
type SandboxOutcome =
  | { kind: 'completed'; result: SandboxRunResult }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'failed'; message: string };

/**
 * Stop a command and **everything it started**.
 *
 * The child leads its own process group, so the group's negative pid reaches
 * every process the command started. Killing only the shell would orphan the
 * command's own process, which would keep running while the report said the
 * command was stopped.
 */
function stopProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The group is already gone, or the platform refuses the group signal;
    // the child's own kill is the fallback.
    try {
      child.kill('SIGKILL');
    } catch {
      // The child is already gone.
    }
  }
}

/**
 * The output a stopped command had produced.
 *
 * The launcher keeps the output it has collected so far, so a command that
 * was stopped before it ends still yields what it had already printed. A
 * backend that does **not** collect is the fallback: the tool waits for the
 * result with a **bounded** grace period, so the timeout is reported at once
 * and a process that does not die is never waited for.
 *
 * The caller has already **stopped** the command — see {@link stopSandbox} —
 * so this never kills anything itself.
 */
async function partialOutputOf(
  launched: LaunchedSandbox,
): Promise<{ stdout: string; stderr: string }> {
  const collected = launched.output;
  if (collected !== undefined) {
    return { stdout: collected.stdout, stderr: collected.stderr };
  }
  const outcome = await Promise.race([
    launched.wait(),
    delay(SANDBOX_OUTPUT_GRACE_MS).then(() => undefined),
  ]).catch(() => undefined);
  return { stdout: outcome?.stdout ?? '', stderr: outcome?.stderr ?? '' };
}

/**
 * Stop a sandboxed command that ran past its timeout.
 *
 * The kill is **not** awaited: the timeout must be reported at once, and a
 * process that does not die must not hold the report. `cleanup` kills
 * synchronously and only then waits for the process, so the kill happens
 * immediately whatever the report does.
 */
function stopSandbox(launched: LaunchedSandbox): void {
  void launched.cleanup().catch(() => undefined);
}

/**
 * Wait for the sandboxed command, or stop it when it runs past its timeout.
 *
 * A command that **fails** to report its result is not a command that succeeded:
 * it is reported as a failure with the exit code `127` the direct path reports
 * for a command that could not be started.
 */
function waitForSandbox(launched: LaunchedSandbox, timeoutMs: number): Promise<SandboxOutcome> {
  return new Promise<SandboxOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: SandboxOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };
    timer = setTimeout(() => {
      // The flag is set **before** the command is stopped: a command that ends
      // because the timeout stopped it is a timeout, not a command that ran.
      timedOut = true;
      // The command is **stopped**, not merely reported as stopped: the
      // sandboxed process would otherwise keep running after the call
      // returned.
      stopSandbox(launched);
      void (async () => {
        const partial = await partialOutputOf(launched);
        finish({ kind: 'timeout', stdout: partial.stdout, stderr: partial.stderr });
      })();
    }, timeoutMs);
    void launched.wait().then(
      (result) => {
        if (timedOut) return;
        finish({ kind: 'completed', result });
      },
      (error: unknown) => {
        if (timedOut) return;
        finish({ kind: 'failed', message: messageOf(error) });
      },
    );
  });
}

/**
 * Run a command **inside** the sandbox, through the launcher.
 *
 * The launcher owns the plan, the backend and the environment; the tool owns the
 * timeout, the output cap and the report. A launcher that refuses the launch
 * raises a refusal, and the refusal is reported as a refusal — never as a command
 * that ran and failed.
 */
async function runSandboxed(
  spec: SandboxSpec,
  timeoutMs: number,
  availability?: SandboxAvailabilityReport,
): Promise<BashOutput> {
  let launched: LaunchedSandbox;
  try {
    launched = await launchSandbox(spec);
  } catch (error) {
    if (error instanceof SandboxRefusedError) {
      throw new ToolExecutionError(refusalMessage(error.reason), TOOL_ERROR_CODES.executionFailed);
    }
    throw error;
  }

  const outcome = await waitForSandbox(launched, timeoutMs);
  if (outcome.kind !== 'timeout') await launched.cleanup();

  const status = {
    sandboxed: launched.status.sandboxed,
    ...(launched.status.reason === undefined
      ? {}
      : { sandboxEstablishmentReason: launched.status.reason }),
    ...(launched.status.exemptions === undefined
      ? {}
      : { sandboxExemptions: launched.status.exemptions }),
    sandboxExemptionScope: launched.status.exemptionScope,
    ...(availability === undefined ? {} : { sandboxAvailability: availability }),
  };

  if (outcome.kind === 'failed') {
    // A run that could not report its result is not a command that succeeded and
    // printed nothing: the direct path reports `127` for a command that could
    // not be started, and this is the same failure.
    const stderr = capOutput(`\n${outcome.message}`);
    return {
      type: 'text',
      text: '',
      stdout: '',
      stderr: stderr.text,
      exitCode: 127,
      truncated: stderr.truncated,
      ...status,
    };
  }

  if (outcome.kind === 'timeout') {
    // The timeout message is **reserved room for**, so it is never truncated
    // away by a standard error that is already at the cap: the message is
    // part of the report, and the report has to survive the cap.
    const stdout = capOutput(outcome.stdout);
    const timeoutNotice = '\nThe command was stopped because it ran past its timeout.';
    const stderr = capOutput(
      `${outcome.stderr.slice(0, Math.max(0, MAX_BASH_OUTPUT_CHARS - timeoutNotice.length))}${timeoutNotice}`,
    );
    return {
      type: 'text',
      text: stdout.text,
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: 124,
      truncated: true,
      timedOut: true,
      ...status,
    };
  }

  const stdout = capOutput(outcome.result.stdout);
  const stderr = capOutput(outcome.result.stderr);
  return {
    type: 'text',
    text: stdout.text,
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: outcome.result.exitCode ?? 0,
    truncated: stdout.truncated || stderr.truncated,
    ...status,
  };
}

/**
 * Cap the output the tool reports.
 *
 * The cap is the tool's own: a command that prints without bound does not fill
 * the context window.
 */
function capOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_BASH_OUTPUT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_BASH_OUTPUT_CHARS), truncated: true };
}

/**
 * The target's routing: what the call's flag does to the command's sandbox.
 *
 * **Observed** — the target's own source, read for the `CC-024` milestone. The
 * target's `Bash` tool consults the flag through a predicate that answers
 * *"must this command be sandboxed?"*, and it asks that predicate **twice**:
 * once with the flag and once without. The override is produced only when the
 * two answers differ, so the flag is the thing that changed the routing.
 *
 * The target consults the flag **before** the command's own exemption, and it
 * consults it only when the policy **permits** unsandboxed commands. The
 * target's own settings block says so: `sandbox.allowUnsandboxedCommands`
 * "allows commands to run outside the sandbox via the
 * `dangerouslyDisableSandbox` parameter", and "when false, the
 * `dangerouslyDisableSandbox` parameter is completely ignored and all commands
 * must run sandboxed".
 */
export interface SandboxRouting {
  /**
   * Whether the flag routes the command outside the sandbox.
   *
   * It is `false` when the sandbox does not apply at all (it is switched off,
   * or the platform is excluded), when the policy forbids unsandboxed
   * commands, and when there is no policy.
   */
  readonly flagRoutesOutside: boolean;
  /**
   * Whether the flag is what **changes** the routing.
   *
   * It is `false` when the command would have run outside the sandbox anyway
   * — the target's exemption list, for instance — because then the flag
   * changes nothing and the target asks no question.
   */
  readonly flagChangedRouting: boolean;
}

/**
 * The target's routing, reproduced.
 *
 * The predicate answers the target's question — "must this command be
 * sandboxed?" — for the command **with** the flag and **without** it, and the
 * two answers are what the override is built from.
 *
 * The target's own predicate also knows two things this implementation does
 * not: a shell the **user typed** (`!` in the composer) is routed outside the
 * sandbox whatever the settings say, and a **remote** session that requires
 * the sandbox refuses an unsandboxed command outright. Neither has a
 * counterpart here, and both are named in the conformance document.
 */
export function sandboxRoutingOf(
  policy: SandboxPolicy | undefined,
  platform: string,
  command: string,
  flag: boolean,
): SandboxRouting {
  // No policy at all: there is no sandbox, so the flag changes nothing.
  if (policy === undefined) return { flagRoutesOutside: false, flagChangedRouting: false };
  // The sandbox does not apply here: the flag changes nothing.
  if (!policy.enabled) return { flagRoutesOutside: false, flagChangedRouting: false };
  if (!policy.enabledPlatforms.includes(platform)) {
    return { flagRoutesOutside: false, flagChangedRouting: false };
  }
  // The policy forbids unsandboxed commands: the flag is **completely
  // ignored**, and every command runs sandboxed.
  if (!policy.allowUnsandboxedCommands) {
    return { flagRoutesOutside: false, flagChangedRouting: false };
  }
  // Without the flag: does the policy sandbox this command? A command the
  // exemption list covers runs outside the sandbox either way, so the flag
  // changes nothing — and the target asks no question about it.
  const withoutFlag = evaluateSandbox(policy, platform, command, 'available');
  if (withoutFlag.decision !== 'allow') {
    return { flagRoutesOutside: false, flagChangedRouting: false };
  }
  if (!flag) return { flagRoutesOutside: false, flagChangedRouting: false };
  return { flagRoutesOutside: true, flagChangedRouting: true };
}

/**
 * Whether a decision's reason is rule-derived.
 *
 * **The target's own test.** The target asks whether the decision's reason is
 * a rule — or a compound escalation whose every part is a rule — and a
 * rule-derived allow keeps its own reason: the target does not turn it into a
 * sandbox override.
 */
function isRuleDerived(decision: PermissionDecision): boolean {
  return decision.reasonKind === 'rule' || decision.reasonKind === 'subcommandResults';
}

/**
 * Whether the decision is the user's own answer to a question that was already
 * put to them.
 *
 * **Why the target does not need this test.** The target builds its override
 * from the decision the permission check produced **before** the prompt: a
 * decision that is still an `ask` is not an `allow`, and the target's override
 * condition excludes an `ask`. This implementation's check consults the prompt
 * itself, so the decision it holds is the user's **answer** — and an answer
 * that says "yes" must not be asked a second question about the sandbox.
 */
function isUserAnswer(decision: PermissionDecision): boolean {
  return decision.source === 'user_temporary' || decision.source === 'user_permanent';
}

/**
 * The target's sandbox override.
 *
 * **Observed** — the target's own `Bash` tool. The target produces the
 * override **ask** when all of the following hold:
 *
 *   1. the call carries the `dangerouslyDisableSandbox` flag;
 *   2. the ordinary decision is neither a `deny` nor an `ask` — an **allow**;
 *   3. the ordinary decision's reason is **not** rule-derived;
 *   4. the flag is what changes the routing: with the flag the command runs
 *      outside the sandbox, and without it the command runs inside.
 *
 * The decision it produces is the target's:
 * `{ behavior: 'ask', decisionReason: { type: 'sandboxOverride', reason:
 * 'dangerouslyDisableSandbox' }, message: 'Run outside of the sandbox' }`.
 *
 * A **denial** keeps its own reason, and so does an **ask** that was already
 * put to the user: the flag never turns a refusal into an approval, and it
 * never asks the same person the same question twice.
 */
function withSandboxOverride(
  decision: PermissionDecision,
  input: unknown,
  deps: BuiltinToolDeps,
): PermissionDecision {
  if (decision.behavior !== 'allow') return decision;
  if (readInputField(input, 'dangerouslyDisableSandbox') !== true) return decision;
  if (isRuleDerived(decision)) return decision;
  if (isUserAnswer(decision)) return decision;
  const command = readInputField(input, 'command');
  if (typeof command !== 'string') return decision;
  const routing = sandboxRoutingOf(
    deps.sandboxPolicy,
    deps.sandboxPlatform ?? process.platform,
    command,
    true,
  );
  if (!routing.flagChangedRouting) return decision;
  return sandboxOverrideDecision();
}

/**
 * Create the `Bash` tool.
 */
export function createBashTool(deps: BuiltinToolDeps): ToolDefinition<BashInput, BashOutput> {
  return {
    name: 'Bash',
    description: 'Run a shell command.',
    inputSchema: BASH_INPUT_SCHEMA,
    mutatesFiles: false,

    /**
     * A shell command is concurrency safe **only when it is read-only**.
     *
     * The target's `Bash` tool declares the flag as
     * `isConcurrencySafe(e){return this.isReadOnly?.(e)??!1}` — the command
     * itself decides. The read-only rule is the target's own, and it lives in
     * `src/tools/readonly.ts`.
     */
    isConcurrencySafe(input: BashInput): boolean {
      const command = readInputField(input, 'command');
      if (typeof command !== 'string') return false;
      return isReadOnlyCommand(command);
    },

    async checkPermissions(input, ctx: ToolContext) {
      const decision = await checkToolPermissions(ctx, deps);
      return withSandboxOverride(decision, input, deps);
    },

    async recheckPermission(input, ctx: ToolContext) {
      // A hook may have rewritten the input: the **whole** check runs again on the
      // rewritten input, so the rewrite cannot escape the ask list, the allow
      // scope or the mode.
      const recheck = await recheckToolPermissions(ctx, deps);
      const decision = recheck.decision;
      return {
        ...recheck,
        decision: decision === undefined ? undefined : withSandboxOverride(decision, input, deps),
      };
    },

    async validateInput(input) {
      const fields = rejectUnknownFields(input, [
        'command',
        'description',
        'timeout',
        'dangerouslyDisableSandbox',
      ]);
      if (!fields.ok) return fields;
      const command = requireStringField(input, 'command', {
        invalidCode: TOOL_ERROR_CODES.invalidCommand,
      });
      if (!command.ok) return command;
      const timeout = optionalIntegerField(input, 'timeout');
      if (!timeout.ok) return timeout;
      if (timeout.value === 0) {
        // A timeout of zero would stop the command before it began.
        return {
          ok: false,
          message: "The 'timeout' argument must be greater than zero.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      const sandbox = readInputField(input, 'dangerouslyDisableSandbox');
      if (sandbox !== undefined && sandbox !== null && typeof sandbox !== 'boolean') {
        return {
          ok: false,
          message: "The 'dangerouslyDisableSandbox' argument must be a boolean.",
          errorCode: TOOL_ERROR_CODES.invalidInput,
        };
      }
      return { ok: true };
    },

    async execute(input) {
      const timeout = resolveBashTimeout(input.timeout);
      const cwd = deps.cwd ?? process.cwd();
      const env = deps.env ?? process.env;
      const command = input.command;
      const skipSandbox = readInputField(input, 'dangerouslyDisableSandbox') === true;

      const policy = deps.sandboxPolicy;
      if (policy === undefined) {
        // **No sandbox at all.** The command runs on the host, the way the tool
        // has always run it — but with the **filtered** environment: the
        // session's own environment carries the agent's credentials, and a
        // command that runs outside the sandbox must not see them.
        return runUnconfined({ command, cwd, env }, timeout, {
          reason: SANDBOX_NOT_CONFIGURED_REASON,
        });
      }

      const backend = deps.sandboxBackend ?? (await defaultSandboxBackend());
      const platform = deps.sandboxPlatform ?? process.platform;
      const { availability, report } = await backendAvailability(backend);
      const evaluation = evaluateSandbox(policy, platform, command, availability);

      if (evaluation.decision === 'deny') {
        // A refusal is a refusal: it names the reason, and it is never reported
        // as a command that ran and exited with a non-zero status. The flag
        // never reaches this point: it overrides the **routing** of a command,
        // never a policy error.
        throw new ToolExecutionError(
          refusalMessage(evaluation.reason),
          TOOL_ERROR_CODES.executionFailed,
        );
      }

      const spec: SandboxSpec = { command, cwd, env, policy, platform, availability, backend };
      const scope = exemptionScope(policy);
      const routing = sandboxRoutingOf(policy, platform, command, skipSandbox);

      if (routing.flagRoutesOutside) {
        // The flag asks for an unconfined run of a command the policy would
        // have sandboxed. The target consults the flag **before** the command's
        // own exemption, so the flag's reason is the one reported. It never
        // skips a permission rule — the permission check has already run on
        // this command — and it never overrides the denial above.
        return runUnconfined(spec, timeout, {
          reason: SANDBOX_SKIPPED_BY_CALL_REASON,
          scope,
          availability: report,
        });
      }

      if (evaluation.decision === 'unconfined') {
        // The policy itself runs the command outside the sandbox, and its reason
        // is the one reported — the flag is not what made it unconfined.
        return runUnconfined(spec, timeout, {
          reason: evaluation.reason ?? 'the sandbox policy does not sandbox the command',
          ...(evaluation.exemptions === undefined ? {} : { exemptions: evaluation.exemptions }),
          scope,
          availability: report,
        });
      }

      return runSandboxed(spec, timeout, report);
    },
  };
}
