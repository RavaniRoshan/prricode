/**
 * The **status line**: the settings-level display handler the target ships, the JSON it
 * hands the user's command, and the way it runs that command.
 *
 * Evidence: `chunk-c9s0jh80.js:283237` (the `statusLine` setting), `chunk-4jsg44k7.js:2367468`
 * (the payload), `:2366659` (the runner), `:2366573` (the two constants), `:1085773`
 * (the managed tier wins), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §3.
 *
 * ## What this module is
 *
 * The status line is **not** a hook event — the target treats it as a settings-level
 * display handler, and so does this implementation. It is:
 *
 *   - the **`statusLine` setting** — `{type: "command", command, padding?,
 *     refreshInterval?, hideVimModeIndicator?}`;
 *   - the **payload** — one JSON document, written to the command's standard input;
 *   - the **runner** — the command's standard output is the line, and a failure is
 *     swallowed.
 *
 * ## The payload is an interface
 *
 * A user's status line script reads the payload's **member names**, so the names are
 * the target's own: `session_id`, `model.display_name`, `cost.total_cost_usd`,
 * `context_window.used_percentage` and the rest. They are data, and they are
 * reproduced exactly. The member **order** is the target's too, because the JSON the
 * command reads is observable.
 *
 * ## What is this implementation's own
 *
 * The **`version` block** carries the running program's own build metadata — the
 * version, the build time, the commit — and this implementation writes **its own**
 * there. The target's values are recorded in the findings file; they are the target's,
 * not this implementation's.
 *
 * ## What this implementation does not have
 *
 * The target registers a status line **per interactive site** and re-runs it on a
 * debounce, on a refresh interval, and on every event that changes the payload. This
 * implementation has no interactive-site registry of its own, so the **scheduling** is
 * a plain debounce and a refresh interval here, and the difference is recorded in
 * `docs/compatibility/remaining-surfaces.md`.
 */

import { spawn } from 'node:child_process';

/* -------------------------------------------------------------------------- */
/* The setting                                                                  */
/* -------------------------------------------------------------------------- */

/** The `statusLine` setting's own shape. */
export interface StatusLineSettings {
  /** The target's own discriminator. */
  readonly type: 'command';
  /** The command to run. */
  readonly command: string;
  /** The padding the UI puts around the line. */
  readonly padding?: number;
  /** Re-run the command every N seconds, in addition to the event-driven updates. */
  readonly refreshInterval?: number;
  /** Hide the built-in vim-mode indicator. */
  readonly hideVimModeIndicator?: boolean;
}

/**
 * The debounce before the command runs again after an event.
 *
 * The target holds it in `_tr` (`chunk-4jsg44k7.js:2366573`).
 */
export const STATUS_LINE_DEBOUNCE_MS = 300;

/**
 * The minimum gap between two runs of the command.
 *
 * The target holds it in `ktr` (`chunk-4jsg44k7.js:2366573`).
 */
export const STATUS_LINE_MIN_GAP_MS = 1000;

/**
 * The refresh interval of the `statusLine` setting, in milliseconds.
 *
 * The target's own rule: an absent interval is `null` (no refresh at all), and an
 * interval of N seconds is at least N seconds — the setting's schema refuses an
 * interval below 1.
 */
export function statusLineRefreshIntervalMs(settings: StatusLineSettings | undefined): number | null {
  const interval = settings?.refreshInterval;
  if (interval === undefined) return null;
  return Math.max(1, interval) * 1000;
}

/* -------------------------------------------------------------------------- */
/* The payload                                                                  */
/* -------------------------------------------------------------------------- */

/** The session block of the payload. */
export interface StatusLineSession {
  /** The session's id. */
  readonly id: string;
  /** The path of the session's transcript. */
  readonly transcriptPath?: string;
  /** The session's title, when it has one. */
  readonly title?: string;
  /** The agent's id, for a subagent session. */
  readonly agentId?: string;
  /** The agent's type, for a subagent session. */
  readonly agentType?: string;
  /** The scratchpad directory, when the session has one. */
  readonly scratchpadDir?: string;
  /** The prompt's id, when the session has one. */
  readonly promptId?: string;
}

/** The git worktree the session is in. */
export interface StatusLineGitWorktree {
  readonly name: string;
  readonly path: string;
  readonly branch?: string;
  readonly original_cwd?: string;
  readonly original_branch?: string;
}

/** The repository the session is in. */
export interface StatusLineRepo {
  readonly root: string;
  readonly branch?: string;
}

/** The cost block of the payload. */
export interface StatusLineCost {
  readonly total_cost_usd: number;
  readonly total_duration_ms: number;
  readonly total_api_duration_ms: number;
  readonly total_lines_added: number;
  readonly total_lines_removed: number;
}

/** The context-window block of the payload. */
export interface StatusLineContextWindow {
  readonly total_input_tokens: number;
  readonly total_output_tokens: number;
  readonly context_window_size: number;
  readonly current_usage?: StatusLineUsage;
  readonly used_percentage?: number;
  readonly remaining_percentage?: number;
}

/** The API's own usage record. */
export interface StatusLineUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

/** The prompt-cache statistics. */
export interface StatusLinePromptCache {
  readonly warm: boolean;
  readonly caching_observed: boolean;
  readonly ttl?: string;
  readonly expires_at?: number | null;
  readonly requests: number;
  readonly misses: number;
  readonly expected_rebuilds: number;
  readonly hit_ratio?: number;
}

/** The rate limits, when the account has any. */
export interface StatusLineRateLimits {
  readonly five_hour?: { used_percentage: number; resets_at: number };
  readonly seven_day?: { used_percentage: number; resets_at: number };
  readonly spend_limit?: { used_percentage: number; resets_at: number };
}

/** The pull request the session is about. */
export interface StatusLinePr {
  readonly number: number;
  readonly url: string;
  readonly review_state?: string;
  readonly kind?: string;
}

/**
 * The **version block** — the running program's own build metadata.
 *
 * The target's block carries the target's own issue tracker, package name, docs URL,
 * feedback channel, version, build time and commit. This implementation writes **its
 * own**: the block describes the program that is running, and a clone that wrote the
 * target's would be claiming to be it.
 */
export const STATUS_LINE_VERSION: Readonly<Record<string, string>> = Object.freeze({
  ISSUES_EXPLAINER: 'report the issue at the PRRICODE issue tracker',
  PACKAGE_URL: 'prricode',
  README_URL: 'https://prricode.dev/docs',
  VERSION: '2.1.303',
  FEEDBACK_CHANNEL: 'the PRRICODE issue tracker',
  BUILD_TIME: '',
  GIT_SHA: '',
  HOOKS_WORKER_URL: '',
  DD_SOURCEMAP_GROUP: 'default',
});

/** The payload the target hands the status line command. */
export interface StatusLinePayload {
  readonly session_id: string;
  readonly transcript_path: string;
  readonly cwd: string;
  readonly scratchpad_dir?: string;
  readonly prompt_id?: string;
  readonly permission_mode: string;
  readonly agent_id?: string;
  readonly agent_type?: string;
  readonly effort?: { readonly level: string };
  readonly session_name?: string;
  readonly model: { readonly id: string; readonly display_name: string };
  readonly workspace: {
    readonly current_dir: string;
    readonly project_dir: string;
    readonly added_dirs: readonly string[];
    readonly git_worktree?: StatusLineGitWorktree;
    readonly repo?: StatusLineRepo;
  };
  readonly version: Readonly<Record<string, string>>;
  readonly output_style: { readonly name: string };
  readonly cost: StatusLineCost;
  readonly context_window: StatusLineContextWindow;
  readonly exceeds_200k_tokens: boolean;
  readonly prompt_cache?: StatusLinePromptCache;
  readonly fast_mode: boolean;
  readonly thinking: { readonly enabled: boolean };
  readonly rate_limits?: StatusLineRateLimits;
  readonly vim?: { readonly mode: string };
  readonly agent?: { readonly name: string };
  readonly remote?: { readonly session_id: string };
  readonly pr?: StatusLinePr;
  readonly worktree?: StatusLineGitWorktree;
}

/** What the payload is built from. */
export interface StatusLineInput {
  /** The session. */
  readonly session: StatusLineSession;
  /** The session's permission mode. */
  readonly permissionMode: string;
  /** The session's working directory. */
  readonly cwd: string;
  /** The session's original working directory — the project's directory. */
  readonly projectDir: string;
  /** The extra directories the user added. */
  readonly addedDirs?: readonly string[];
  /** The model's id. */
  readonly modelId: string;
  /** The model's display name. */
  readonly modelDisplayName: string;
  /** The session's effort level. */
  readonly effortLevel?: string;
  /** The model's effort level, when the model has one. */
  readonly modelEffortLevel?: string;
  /** The active output style's name. */
  readonly outputStyleName: string;
  /** The session's cost. */
  readonly cost: StatusLineCost;
  /** The session's context window. */
  readonly contextWindow: StatusLineContextWindow;  /** Whether the context is over two hundred thousand tokens. */
  readonly exceeds200kTokens: boolean;
  /** The prompt-cache statistics, when there are any. */
  readonly promptCache?: StatusLinePromptCache;
  /** Whether the session is in fast mode. */
  readonly fastMode: boolean;
  /** Whether thinking is enabled. */
  readonly thinkingEnabled: boolean;
  /** The rate limits, when the account has any. */
  readonly rateLimits?: StatusLineRateLimits;
  /** The vim mode, when vim mode is on. */
  readonly vimMode?: string;
  /** The teammate agent's name, for a teammate session. */
  readonly agentName?: string;
  /** The remote session's id, for a served session. */
  readonly remoteSessionId?: string;
  /** The pull request the session is about. */
  readonly pr?: StatusLinePr;
  /** The worktree the session is in. */
  readonly worktree?: StatusLineGitWorktree;
  /** The repository the session is in. */
  readonly repo?: StatusLineRepo;
  /** The git worktree the session is in. */
  readonly gitWorktree?: StatusLineGitWorktree;
}

/**
 * Build the payload the target hands the status line command.
 *
 * The member order is the target's own, because the JSON a user's script reads is
 * observable.
 */
export function buildStatusLinePayload(input: StatusLineInput): StatusLinePayload {
  const session: StatusLineSession = input.session;

  // The session block, in the target's own order. The target's `effort` member is
  // only there when the session has an app state and the model has an effort level;
  // the payload's own `effort` member follows later and replaces it.
  const sessionBlock: Record<string, unknown> = {
    session_id: session.id,
    transcript_path: session.transcriptPath ?? '',
    cwd: input.cwd,
  };
  if (session.scratchpadDir !== undefined) sessionBlock['scratchpad_dir'] = session.scratchpadDir;
  if (session.promptId !== undefined) sessionBlock['prompt_id'] = session.promptId;
  sessionBlock['permission_mode'] = input.permissionMode;
  if (session.agentId !== undefined) sessionBlock['agent_id'] = session.agentId;
  if (session.agentType !== undefined) sessionBlock['agent_type'] = session.agentType;
  if (input.effortLevel !== undefined) sessionBlock['effort'] = { level: input.effortLevel };

  const payload: Record<string, unknown> = { ...sessionBlock };

  if (session.title !== undefined) payload['session_name'] = session.title;

  payload['model'] = { id: input.modelId, display_name: input.modelDisplayName };

  const workspace: Record<string, unknown> = {
    current_dir: input.cwd,
    project_dir: input.projectDir,
    added_dirs: input.addedDirs ?? [],
  };
  if (input.gitWorktree !== undefined) workspace['git_worktree'] = input.gitWorktree;
  if (input.repo !== undefined) workspace['repo'] = input.repo;
  payload['workspace'] = workspace;

  payload['version'] = { ...STATUS_LINE_VERSION };
  payload['output_style'] = { name: input.outputStyleName };
  payload['cost'] = { ...input.cost };
  payload['context_window'] = { ...input.contextWindow };
  payload['exceeds_200k_tokens'] = input.exceeds200kTokens;

  if (input.promptCache !== undefined) payload['prompt_cache'] = input.promptCache;

  payload['fast_mode'] = input.fastMode;

  if (input.modelEffortLevel !== undefined) payload['effort'] = { level: input.modelEffortLevel };

  payload['thinking'] = { enabled: input.thinkingEnabled };

  if (input.rateLimits !== undefined) payload['rate_limits'] = input.rateLimits;
  if (input.vimMode !== undefined) payload['vim'] = { mode: input.vimMode };
  if (input.agentName !== undefined) payload['agent'] = { name: input.agentName };
  if (input.remoteSessionId !== undefined) payload['remote'] = { session_id: input.remoteSessionId };
  if (input.pr !== undefined) payload['pr'] = { ...input.pr };
  if (input.worktree !== undefined) payload['worktree'] = { ...input.worktree };

  return payload as unknown as StatusLinePayload;
}

/* -------------------------------------------------------------------------- */
/* The runner                                                                   */
/* -------------------------------------------------------------------------- */

/** What the runner returns. */
export interface StatusLineResult {
  /** The command's standard output, trimmed of the trailing newline. */
  readonly text: string;
  /** Whether the command succeeded. */
  readonly ok: boolean;
}

/** The options the runner takes. */
export interface StatusLineRunOptions {
  /** The working directory of the command. */
  readonly cwd?: string;
  /** The environment of the command. */
  readonly env?: NodeJS.ProcessEnv;
  /** A signal that stops the command. */
  readonly signal?: AbortSignal;
  /** How long the command may run. */
  readonly timeoutMs?: number;
}

/** The default timeout of a status line command. */
export const STATUS_LINE_TIMEOUT_MS = 5000;

/**
 * Run the status line command.
 *
 * The command is a **shell command** — the target runs it through the shell — and the
 * payload is written to its **standard input** as one JSON document. The command's
 * **standard output** is the line.
 *
 * A failure is **swallowed**: the target's runner catches everything and keeps the
 * previous line, so a broken status line never breaks the session.
 */
export function runStatusLine(
  command: string,
  payload: StatusLinePayload,
  options: StatusLineRunOptions = {},
): Promise<StatusLineResult> {
  const timeoutMs = options.timeoutMs ?? STATUS_LINE_TIMEOUT_MS;

  return new Promise<StatusLineResult>((resolve) => {
    let settled = false;
    const finish = (result: StatusLineResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/bin/sh', ['-c', command], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      finish({ text: '', ok: false });
      return;
    }

    const chunks: string[] = [];
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => chunks.push(chunk));
    // The standard error is swallowed: a status line that writes to it is not a
    // failure of the session.
    child.stderr?.resume();

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      finish({ text: '', ok: false });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const text = chunks.join('').replace(/\n+$/, '');
      finish({ text, ok: code === 0 });
    });

    try {
      child.stdin?.on('error', () => {
        // A command that never reads its input closes the pipe; that is not a
        // failure of the command.
      });
      child.stdin?.end(JSON.stringify(payload));
    } catch {
      finish({ text: '', ok: false });
    }
  });
}

/* -------------------------------------------------------------------------- */
/* The gates                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether the status line command may run.
 *
 * The target's own gates:
 *
 *   - `disableAllHooks: true` — the status line is a **display handler**, and the
 *     target warns and does **not** run the command;
 *   - the workspace trust is not accepted — the command is **skipped**.
 *
 * The target's own messages are the second and third arguments.
 */
export function statusLineGate(
  settings: { readonly disableAllHooks?: boolean } | undefined,
  trustAccepted: boolean,
): { readonly allowed: boolean; readonly reason?: string } {
  if (settings?.disableAllHooks === true) {
    return {
      allowed: false,
      reason: 'Status line is configured but disableAllHooks is true',
    };
  }
  if (!trustAccepted) {
    return {
      allowed: false,
      reason: 'Status line command skipped: workspace trust not accepted',
    };
  }
  return { allowed: true };
}
