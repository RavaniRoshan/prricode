/**
 * The shapes the demo's run is built from.
 *
 * ## What this module is
 *
 * The demo GIF is captured by driving the repository's own interactive UI
 * (`src/ui/app.ts`) through a run. The run is built out of records the UI
 * already renders — the conversation's own record kinds — and the beats that
 * hold the screen while a frame of the GIF is drawn.
 *
 * The events here are **starter records**: they name their kind and their
 * payload, and the capture assigns the bookkeeping members the conversation's
 * records carry (the version, the timestamp and the id) when it turns a beat
 * into props. The one exception is a tool result's envelope, which carries the
 * tool-use id itself, because the transcript renderer pairs a result with its
 * call through that member (`src/ui/render/messages.ts`).
 *
 * A tool result **without** its call's id renders as the renderer's own
 * mismatch report — `unmatched tool result` — so the pairing is not optional:
 * a run that forgets it is announcing a broken transcript, not drawing one.
 */

/**
 * One record of the demo's run, in the kind and payload shape the
 * conversation's own records carry.
 *
 * Four kinds are used: the user's prompt, an assistant message, a tool call
 * and a tool result. The other kinds the session's vocabulary carries are
 * boundary markers this run has no use for.
 */
export type DemoEvent =
  | { t: 'user_message'; text: string }
  | { t: 'assistant_message'; text: string }
  | { t: 'tool_call'; id: string; name: string; input: unknown }
  | { t: 'tool_result'; id: string; envelope: DemoEnvelope };

/**
 * One of the four states the agent's surface names.
 */
export type DemoState = 'idle' | 'thinking' | 'asking' | 'tool';

/**
 * One state the pipeline's stage advance carries.
 */
export type DemoStageState = 'pending' | 'running' | 'completed' | 'refused' | 'not-reached';

/** The keystroke a transient pill marks. */
export type DemoPill = 'enter' | 'esc';

/**
 * One held picture of the screen.
 *
 * The fields after `frames` map one to one onto the app's props (`src/ui/app.ts`,
 * `AppProps`), plus the two things the compositor draws itself: the transient
 * keystroke pill and the block cursor. The events are a **snapshot** — the
 * records that had arrived before the beat opened — so a beat holds a stable
 * picture of the run so far.
 */
export interface Beat {
  /** The records the screen holds. */
  readonly events: readonly DemoEvent[];
  /** The text in the composer. */
  readonly input: string;
  /** Whether a turn is running. */
  readonly busy: boolean;
  /** The status line's text, when there is one. */
  readonly status?: string | undefined;
  /** The tool the approval prompt is about, when one is up. */
  readonly approval?: string | undefined;
  /** The state the agent left, when a change arrives this beat. */
  readonly from?: DemoState | undefined;
  /** The state the agent is in, when a change arrives this beat. */
  readonly to?: DemoState | undefined;
  /** The pipeline's stage that advanced this beat, when one did. */
  readonly stageId?: string | undefined;
  /** The state that stage advanced to. */
  readonly stageState?: DemoStageState | undefined;
  /** The keystroke the compositor's pill marks, when one is shown. */
  readonly pill?: DemoPill | undefined;
  /** A notice the host produced, shown beside the hint line. */
  readonly notice?: string | undefined;
  /** How many frames the beat holds. */
  readonly frames: number;
}

/**
 * A tool result's envelope as the demo records carry it.
 *
 * The `id` is the tool-use id the result answers — the pairing member the
 * transcript renderer reads. The shape of the content and the error flag are
 * the tool runner's own (`ToolResultEnvelope`); the type is quoted here as a
 * structural comment to keep the capture's bookkeeping separate from the
 * runtime's vocabulary.
 */
export type DemoEnvelope = Record<string, unknown>;
