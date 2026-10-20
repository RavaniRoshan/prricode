/**
 * The four timeouts.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("MCP, plugins, and
 * hooks" — "MCP transport"), and the `CC-011` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * This module owns **one** responsibility: the four deadlines a connection runs
 * with, and the error each of them raises.
 *
 * ## The four timeouts are four distinct behaviours
 *
 *   - the **armed-request timeout** is the deadline of the *connect* phase: the
 *     negotiation request is armed when it goes out and disarmed when its
 *     response arrives;
 *   - the **request timeout** is the deadline of an ordinary request
 *     (`tools/list`, `prompts/list`, `resources/list`);
 *   - the **tool timeout** is the deadline of a whole tool call;
 *   - the **tool idle timeout** is the longest a tool call may stay silent.
 *
 * Each of them bounds a different thing, so none of them is a second copy of
 * another — and each raises an error that says **which** one fired, through
 * `McpTimeoutError.kind`. A tool call that runs out of time is therefore
 * distinguishable from an ordinary request that runs out of time, which is why
 * the tool timeout is a separate option rather than a reused one.
 *
 * ## Implementation choices
 *
 * The audit does not pin these, so they are marked here:
 *
 *   - The **default values** are `5 000` ms (armed request), `30 000` ms
 *     (request), `120 000` ms (tool) and `15 000` ms (tool idle). The request
 *     timeout's default is the research report's observed `MCP_TIMEOUT`; the
 *     others are this implementation's own.
 *   - The **scoping** of the four timeouts is this implementation's own: the armed
 *     timeout belongs to the connect phase only, the request timeout to the
 *     ordinary requests, and the tool and tool-idle timeouts to a tool call
 *     only. A tool call never carries the armed timeout, and an ordinary
 *     request never carries the tool timeout.
 *   - The **environment overrides** are `MCP_TIMEOUT` (the request timeout) and
 *     `MCP_CONNECT_TIMEOUT_MS` (the armed-request timeout). The tool and
 *     tool-idle timeouts have no environment override; they are set by the
 *     caller.
 */

/** The four timeouts, which are **distinct** from one another. */
export interface McpTimeoutOptions {
  /** Armed when the connect request is sent, disarmed when its response arrives. */
  armedRequestTimeoutMs: number;
  /** The deadline of an ordinary request. */
  requestTimeoutMs: number;
  /** The deadline of a whole tool call. */
  toolTimeoutMs: number;
  /** The longest a tool call may stay silent. */
  toolIdleTimeoutMs: number;
}

/** This implementation's default timeouts. */
export const DEFAULT_MCP_TIMEOUTS: McpTimeoutOptions = Object.freeze({
  armedRequestTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  toolTimeoutMs: 120_000,
  toolIdleTimeoutMs: 15_000,
});

/** The environment variable that carries the request timeout. */
export const MCP_TIMEOUT_ENV = 'MCP_TIMEOUT';

/** The environment variable that carries the connect timeout. */
export const MCP_CONNECT_TIMEOUT_ENV = 'MCP_CONNECT_TIMEOUT_MS';

/** Which of the four timeouts fired. */
export type McpTimeoutKind = 'armedRequest' | 'request' | 'tool' | 'toolIdle';

/**
 * A request that ran out of time.
 *
 * The `kind` says **which** of the four timeouts fired, so a caller can tell a
 * tool timeout from an ordinary request timeout without parsing the message.
 */
export class McpTimeoutError extends Error {
  /** Which of the four timeouts fired. */
  readonly kind: McpTimeoutKind;

  constructor(kind: McpTimeoutKind, message: string) {
    super(message);
    this.name = 'McpTimeoutError';
    this.kind = kind;
  }
}

/** The options a timeout resolution runs with. */
export interface McpTimeoutResolutionOptions {
  /** The timeouts, or the ones to override. */
  timeouts?: Partial<McpTimeoutOptions>;
}

/**
 * The resolved timeouts.
 *
 * The caller's overrides win, then the environment, then the defaults.
 */
export function resolveMcpTimeouts(
  options: McpTimeoutResolutionOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): McpTimeoutOptions {
  const overrides = options.timeouts ?? {};
  const timeouts: McpTimeoutOptions = { ...DEFAULT_MCP_TIMEOUTS };
  for (const key of [
    'armedRequestTimeoutMs',
    'requestTimeoutMs',
    'toolTimeoutMs',
    'toolIdleTimeoutMs',
  ] as const) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      timeouts[key] = value;
    }
  }
  const fromEnv = Number(env[MCP_TIMEOUT_ENV]);
  if (overrides.requestTimeoutMs === undefined && Number.isFinite(fromEnv) && fromEnv > 0) {
    timeouts.requestTimeoutMs = fromEnv;
  }
  // The armed-request timeout is the timeout of the *connect* phase, so it
  // follows the connect timeout the target's environment reference names.
  const connectFromEnv = Number(env[MCP_CONNECT_TIMEOUT_ENV]);
  if (
    overrides.armedRequestTimeoutMs === undefined &&
    Number.isFinite(connectFromEnv) &&
    connectFromEnv > 0
  ) {
    timeouts.armedRequestTimeoutMs = connectFromEnv;
  }
  return timeouts;
}
