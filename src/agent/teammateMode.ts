/**
 * The **teammate mode**: how a spawned teammate executes.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded
 * in `/home/shiva/opt/reference-agent-rea/analysis/findings-agent-teams.md`:
 *
 *   - `chunk-c9s0jh80.js:320848` — the `teammateMode` setting and its
 *     description; `chunk-wwqhf5t7.js:893` — its four states.
 *   - `chunk-9hxmx5h0.js:735` — the default (`in-process`) and the snapshot
 *     class; `:1051` — clearing the CLI override; `:1193` — the capture;
 *     `:1439` — reading the captured mode.
 *   - `chunk-yd6z0250.js:670` — the settings lookup the capture uses.
 *   - `chunk-vqa3vv4s.js:4245` and `:4361` — the two explicit-iTerm2
 *     failures; the same chunk — the backend detection and `isInProcessEnabled`.
 *   - `chunk-xbdsavh3.js:31375` — the in-process fallback and its notification.
 *   - `chunk-081t8575.js:107996` — the CLI's own validation of the mode;
 *     `:115213` — the CLI override wiring.
 *
 * **The honest boundary.** This implementation has **no pane backend**: there
 * is no tmux and no iTerm2 here, and no `it2` CLI. The mode's **states**, its
 * **default**, its **snapshot** and its **selection rules** are implemented — a
 * clone that resolved the mode differently would resolve a *different* mode —
 * but a mode that names a pane backend **refuses**, and the refusal names the
 * capability it needed.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **environment** the selection reads is this implementation's own
 *     shape; the target probes the host directly.
 *   - The **refusal** for a pane backend is this implementation's own: the
 *     target has the backend, so it has no such refusal to copy.
 */

/* -------------------------------------------------------------------------- */
/* The states                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How a spawned teammate executes.
 *
 * The four states are the target's own: `auto`, `tmux`, `iterm2` and
 * `in-process`.
 */
export type TeammateMode = 'auto' | 'tmux' | 'iterm2' | 'in-process';

/** The four states, in the target's own order. */
export const TEAMMATE_MODES: readonly TeammateMode[] = ['auto', 'tmux', 'iterm2', 'in-process'];

/**
 * The mode a session uses when nothing says otherwise.
 *
 * The target's default is `in-process`, **not** `auto`.
 */
export const DEFAULT_TEAMMATE_MODE: TeammateMode = 'in-process';

/**
 * Whether a value is one of the four states.
 */
export function isTeammateMode(value: unknown): value is TeammateMode {
  return typeof value === 'string' && (TEAMMATE_MODES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* The snapshot                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The captured mode, and the CLI override that outranks it.
 *
 * The target captures the mode **once**, at startup, and reads the captured
 * value everywhere else — so a settings change mid-session does not move a
 * running session's mode.
 */
export class TeammateModeSnapshot {
  /** The captured mode, or `null` when nothing has been captured. */
  captured: TeammateMode | null = null;
  /** The CLI override, or `null` when there is none. */
  cliOverride: TeammateMode | null = null;

  /** Set the CLI override. */
  setCliOverride(mode: TeammateMode): void {
    this.cliOverride = mode;
  }

  /** Capture a mode. */
  capture(mode: TeammateMode): void {
    this.captured = mode;
  }

  /**
   * Replace the captured mode **and** clear the CLI override.
   *
   * The target's "clear the override" does both: the override is dropped and
   * the mode the caller names becomes the captured one.
   */
  replaceWith(mode: TeammateMode): void {
    this.captured = mode;
    this.cliOverride = null;
  }
}

/** The session's snapshot. */
export const teammateModeSnapshot = new TeammateModeSnapshot();

/**
 * Set the CLI override.
 *
 * The target's `--teammate-mode` flag lands here.
 */
export function setCliTeammateModeOverride(mode: TeammateMode): void {
  teammateModeSnapshot.setCliOverride(mode);
}

/**
 * The CLI override, when there is one.
 */
export function getCliTeammateModeOverride(): TeammateMode | undefined {
  return teammateModeSnapshot.cliOverride ?? undefined;
}

/**
 * Clear the CLI override, and set the mode the caller names.
 */
export function clearCliTeammateModeOverride(mode: TeammateMode): void {
  teammateModeSnapshot.replaceWith(mode);
}

/**
 * Whether the mode has been captured.
 */
export function hasTeammateModeSnapshot(): boolean {
  return teammateModeSnapshot.captured !== null;
}

/**
 * Capture the mode.
 *
 * The CLI override wins; otherwise the settings value is captured, and the
 * default when the settings say nothing.
 */
export function captureTeammateModeSnapshot(settings?: { teammateMode?: TeammateMode }): void {
  const snapshot = teammateModeSnapshot;
  if (snapshot.cliOverride !== null) {
    snapshot.capture(snapshot.cliOverride);
    return;
  }
  snapshot.capture(settings?.teammateMode ?? DEFAULT_TEAMMATE_MODE);
}

/**
 * The captured mode.
 *
 * Reading the mode before it has been captured is an initialisation bug, and
 * the target says so rather than guessing.
 */
export function getTeammateModeFromSnapshot(): TeammateMode {
  if (teammateModeSnapshot.captured === null) {
    throw new Error(
      'getTeammateModeFromSnapshot called before capture - this indicates an initialization bug',
    );
  }
  return teammateModeSnapshot.captured ?? DEFAULT_TEAMMATE_MODE;
}

/**
 * Forget the captured mode and the override.
 *
 * This implementation's own seam: the target's snapshot lives for the life of
 * the process, and a test needs a way to start again.
 */
export function resetTeammateModeSnapshot(): void {
  teammateModeSnapshot.captured = null;
  teammateModeSnapshot.cliOverride = null;
}

/* -------------------------------------------------------------------------- */
/* The backend selection                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the selection reads about the host.
 */
export interface TeammateEnvironment {
  /** Whether the session is running inside a tmux session. */
  insideTmux: boolean;
  /** Whether the session is running inside iTerm2. */
  insideITerm2: boolean;
  /** Whether tmux is installed. */
  tmuxAvailable: boolean;
  /** Whether the `it2` CLI is reachable. */
  it2Available: boolean;
  /** Whether the session is interactive; a headless session is always in-process. */
  interactive: boolean;
  /** Whether the in-process fallback has been armed. */
  inProcessFallbackActive: boolean;
}

/**
 * The backend the target selects.
 */
export interface TeammateBackendSelection {
  /** The backend. */
  backend: 'tmux' | 'iterm2';
  /** Whether the backend is native to the host. */
  isNative: boolean;
  /** Whether the iTerm2 setup is still needed. */
  needsIt2Setup: boolean;
}

/**
 * The failure the mode's own rules raise.
 *
 * The message is the target's own text — with the target's product name
 * substituted — and the error carries the **capability** the mode needed, so
 * the refusal says what is missing.
 */
export class TeammateBackendUnavailableError extends Error {
  /** The capability the mode needed and this session does not have. */
  readonly capability: string;
  /** The target's own telemetry code for the failure. */
  readonly telemetryCode: string;

  constructor(message: string, capability: string, telemetryCode: string) {
    super(message);
    this.name = 'TeammateBackendUnavailableError';
    this.capability = capability;
    this.telemetryCode = telemetryCode;
  }
}

/**
 * Whether a teammate runs **in this process**.
 *
 * The target's own rule: a headless session is always in-process; the
 * `in-process` mode is in-process; `tmux` and `iterm2` are not; and `auto` is
 * in-process unless the session is inside tmux or iTerm2 — or the in-process
 * fallback has been armed.
 */
export function isInProcessEnabled(mode: TeammateMode, environment: TeammateEnvironment): boolean {
  if (!environment.interactive) return true;
  if (mode === 'in-process') return true;
  if (mode === 'tmux' || mode === 'iterm2') return false;
  if (environment.inProcessFallbackActive) return true;
  return !environment.insideTmux && !environment.insideITerm2;
}

/**
 * Select the pane backend.
 *
 * The target's own detection order:
 *
 *   1. the mode is `iterm2` **explicitly** — the session must be inside
 *      iTerm2 and the `it2` CLI must be reachable, or the mode fails;
 *   2. the session is inside tmux — the tmux backend;
 *   3. the session is inside iTerm2 and `it2` is reachable — the iTerm2
 *      backend;
 *   4. the session is inside iTerm2 without `it2`, but tmux is available — the
 *      tmux backend, and the iTerm2 setup is still needed;
 *   5. the session is inside iTerm2 without `it2` and without tmux — a failure;
 *   6. the session is outside both, and tmux is available — the tmux backend;
 *   7. otherwise — a failure.
 *
 * The **selection** is the target's own. Whether the pane can then be **opened**
 * is this implementation's question, and {@link planTeammateExecution} answers
 * it.
 */
export function selectTeammateBackend(
  mode: TeammateMode,
  environment: TeammateEnvironment,
): TeammateBackendSelection {
  if (mode === 'iterm2') {
    if (!environment.insideITerm2) {
      throw new TeammateBackendUnavailableError(
        'teammateMode is set to "iterm2" but this session is not running inside iTerm2. Launch PRRICODE from iTerm2, or change teammateMode in settings.',
        'an iTerm2 pane backend',
        'iterm2_explicit_not_in_iterm2',
      );
    }
    if (!environment.it2Available) {
      throw new TeammateBackendUnavailableError(
        'teammateMode is set to "iterm2" but the it2 CLI is not reachable. Install it with `pip install it2` and enable the Python API in iTerm2 (Preferences > General > Magic > Enable Python API).',
        'the it2 CLI',
        'iterm2_explicit_no_it2',
      );
    }
    return { backend: 'iterm2', isNative: true, needsIt2Setup: false };
  }

  if (environment.insideTmux) {
    return { backend: 'tmux', isNative: true, needsIt2Setup: false };
  }

  if (environment.insideITerm2) {
    if (environment.it2Available) {
      return { backend: 'iterm2', isNative: true, needsIt2Setup: false };
    }
    if (environment.tmuxAvailable) {
      return { backend: 'tmux', isNative: false, needsIt2Setup: true };
    }
    throw new TeammateBackendUnavailableError(
      'iTerm2 detected but it2 CLI not installed. Install it2 with: pip install it2',
      'the it2 CLI',
      'iterm2_no_it2_no_tmux',
    );
  }

  if (environment.tmuxAvailable) {
    return { backend: 'tmux', isNative: false, needsIt2Setup: false };
  }

  throw new TeammateBackendUnavailableError(
    'The teammate mode needs a terminal pane backend, which this session does not have, so the teammate was not spawned.',
    'a terminal pane backend',
    'no_backend_available',
  );
}

/**
 * What a spawned teammate does.
 */
export type TeammateExecution =
  | {
      /** The teammate runs in this process. */
      kind: 'in-process';
      /** Whether the target's in-process fallback notification is raised. */
      fallback: boolean;
    }
  | {
      /** The teammate runs in a terminal pane. */
      kind: 'pane';
      /** The backend. */
      backend: 'tmux' | 'iterm2';
      /** Whether the backend is native to the host. */
      isNative: boolean;
      /** Whether the iTerm2 setup is still needed. */
      needsIt2Setup: boolean;
    };

/**
 * What a spawned teammate does, in this implementation.
 *
 * The target's own rules decide **whether** a pane is wanted
 * ({@link isInProcessEnabled}) and **which** pane ({@link
 * selectTeammateBackend}). The target then opens it — and this implementation
 * has **no pane backend**: there is no tmux and no iTerm2 here, and no `it2`
 * CLI.
 *
 * So the target's own `auto` fallback applies verbatim: when the mode is `auto`
 * and the pane cannot be opened, the teammate runs **in-process** and the
 * target's fallback notification is raised. An **explicit** pane mode is
 * different: the target rethrows, and so does this implementation — with a
 * refusal that names the capability it needed.
 */
export function planTeammateExecution(
  mode: TeammateMode,
  environment: TeammateEnvironment,
): TeammateExecution {
  if (isInProcessEnabled(mode, environment)) {
    return { kind: 'in-process', fallback: false };
  }

  if (mode === 'auto') {
    // The target's own fallback: no pane backend, so the teammate runs
    // in-process and the user is told.
    return { kind: 'in-process', fallback: true };
  }

  const selection = selectTeammateBackend(mode, environment);

  throw new TeammateBackendUnavailableError(
    `The teammate mode needs a ${selection.backend} pane backend, which this session does not have, so the teammate was not spawned.`,
    `a ${selection.backend} pane backend`,
    `${selection.backend}_backend_unavailable`,
  );
}

/**
 * The notification the target raises when a pane cannot be opened and the mode
 * is `auto`.
 *
 * The target raises it **once**, keyed `teammate-auto-fallback`.
 */
export const TEAMMATE_FALLBACK_NOTIFICATION_KEY = 'teammate-auto-fallback';

/**
 * The text of the in-process fallback notification.
 *
 * The target's own text, with the target's product name substituted.
 */
export function teammateFallbackNotification(insideITerm2: boolean): string {
  const hint = insideITerm2
    ? 'To force iTerm2 panes, set teammateMode: "iterm2" in settings and enable the iTerm2 Python API (Preferences > General > Magic).'
    : 'To use terminal panes, set teammateMode: "tmux" in settings.';
  return `Couldn't open a teammate pane — running in-process instead. ${hint}`;
}
