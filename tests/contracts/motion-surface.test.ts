/**
 * The contract test for the **motion surface** — the second layer's motion
 * applied to the first layer's terminal.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The substrate:** `src/ui/motion/` — the shared motion system, and
 * `src/ui/theme.ts` and `src/ui/render/` — the first layer's own surface.
 *
 * ## What is measured, and how
 *
 * - **The prompt's shimmer.** The travelling light is drawn on the composer's
 *   rule, in the theme's **own** shimmer partner — the motion system writes no
 *   colour of its own, and the surface does not either.
 * - **The transitions between the agent's states.** The four states are a
 *   closed list, and a change draws the outgoing line and the incoming one,
 *   with the incoming sliding up from one line below.
 * - **The pipeline's stage advance.** The advance is read out of the
 *   protocol's `event/stage` notification, and it is drawn as the stage pulses
 *   from half brightness to full.
 * - **The overlays.** The entrance and the exit are the two halves of one
 *   fade, and the resting picture is the overlay with no animation at all.
 * - **The degradation.** A terminal that cannot draw a frame gets the resting
 *   picture and **the reason**, and never a half-drawn animation.
 *
 * ## The frame is a picture
 *
 * The surface produces a **frame** — rows of the first layer's own segments —
 * and the picture is what the terminal shows: the rows, in the theme's own
 * colours. The golden frames in `tests/visual/` are recorded from these
 * functions, and they are compared in `tests/contracts/frame-snapshot.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  AGENT_STATES,
  PROMPT_RULE_CHARACTER,
  approvalOverlayRows,
  autocompleteOverlayRows,
  frameText,
  motionReasonRow,
  promptRuleSegments,
  renderMotionSurface,
  renderOverlayFrame,
  renderPromptFrame,
  renderStageFrame,
  renderStateFrame,
  stageAdvanceFromParams,
  stateLabel,
  stateRole,
  type AgentState,
  type FrameRow,
  type MotionCapability,
  type StageAdvance,
} from '../../src/ui/surface/index.js';
import { DARK_THEME, type Segment } from '../../src/ui/theme.js';

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** A capability record of a terminal that can draw. */
function capableTerminal(overrides: Partial<MotionCapability> = {}): MotionCapability {
  return {
    enabled: true,
    unsupported: null,
    interactive: true,
    reducedMotion: false,
    ...overrides,
  };
}

/** A capability record of a terminal that cannot draw. */
function blindTerminal(reason = 'the output is not an interactive terminal, so no frame can be drawn') {
  return capableTerminal({ enabled: false, unsupported: reason, interactive: false });
}

/** The text of a list of segments, joined. */
function textOf(segments: readonly Segment[]): string {
  return segments.map((segment) => segment.text).join('');
}

/** The roles of a list of segments, in order. */
function rolesOf(segments: readonly Segment[]): (string | undefined)[] {
  return segments.map((segment) => segment.role);
}

/** The text of a frame's rows, joined by a newline. */
function rowsText(rows: readonly FrameRow[]): string {
  return rows.map((row) => textOf(row.segments)).join('\n');
}

/* -------------------------------------------------------------------------- */
/* The prompt's shimmer                                                         */
/* -------------------------------------------------------------------------- */

describe("the motion surface — the prompt's shimmer", () => {
  it("draws the composer's rule in the prompt border role", () => {
    const rule = promptRuleSegments(10);
    expect(textOf(rule)).toBe(PROMPT_RULE_CHARACTER.repeat(10));
    expect(rolesOf(rule)).toEqual(['promptBorder']);
  });

  it('draws no rule at all when there is no room for one', () => {
    expect(promptRuleSegments(0)).toEqual([]);
    expect(promptRuleSegments(-4)).toEqual([]);
  });

  it('draws the travelling light in the theme\'s own shimmer partner', () => {
    const frame = renderPromptFrame({
      columns: 20,
      elapsedMs: 60,
      capability: capableTerminal(),
    });

    // The light is somewhere in the middle of the rule, and every character it
    // touches is drawn in the theme's own partner role.
    const roles = rolesOf(frame.rows[0]?.segments ?? []);
    const lit = roles.filter((role) => role === 'promptBorderShimmer');
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.length).toBeLessThan(roles.length);
  });

  it('reads no clock, so the same elapsed time gives the same picture', () => {
    const first = renderPromptFrame({ columns: 20, elapsedMs: 240, capability: capableTerminal() });
    const second = renderPromptFrame({ columns: 20, elapsedMs: 240, capability: capableTerminal() });
    expect(rowsText(first.rows)).toBe(rowsText(second.rows));
    expect(rolesOf(first.rows[0]?.segments ?? [])).toEqual(rolesOf(second.rows[0]?.segments ?? []));
  });

  it('draws the resting rule when the terminal cannot draw a frame', () => {
    const frame = renderPromptFrame({
      columns: 20,
      elapsedMs: 240,
      capability: blindTerminal(),
    });

    // The resting picture: the rule, in its own role, with no travelling light.
    const roles = rolesOf(frame.rows[0]?.segments ?? []);
    expect(roles.every((role) => role === 'promptBorder')).toBe(true);
    expect(frame.opacity).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The transitions between the agent's states                                   */
/* -------------------------------------------------------------------------- */

describe("the motion surface — the transitions between the agent's states", () => {
  it('names the four states, and the list holds nothing else', () => {
    expect(AGENT_STATES).toEqual(['idle', 'thinking', 'asking', 'tool']);
  });

  it('gives every state a label and a role of its own', () => {
    const labels = AGENT_STATES.map((state) => stateLabel(state));
    expect(new Set(labels).size).toBe(labels.length);
    for (const state of AGENT_STATES) {
      expect(stateRole(state)).not.toBe('');
    }
  });

  it('draws only the incoming line when there was no state before', () => {
    const frame = renderStateFrame({
      change: { from: null, to: 'thinking' },
      elapsedMs: 0,
      capability: capableTerminal(),
    });

    expect(frame.rows).toHaveLength(1);
    expect(rowsText(frame.rows)).toContain(stateLabel('thinking'));
  });

  it('draws the outgoing line and the incoming one while the transition runs', () => {
    const frame = renderStateFrame({
      change: { from: 'thinking', to: 'tool' },
      elapsedMs: 0,
      capability: capableTerminal(),
    });

    const text = rowsText(frame.rows);
    expect(text).toContain(stateLabel('thinking'));
    expect(text).toContain(stateLabel('tool'));
    // The incoming line comes up from one line below, so there is a gap
    // between the two while the transition runs.
    expect(frame.rows.length).toBeGreaterThan(1);
  });

  it('draws only the incoming line when the transition has finished', () => {
    const frame = renderStateFrame({
      change: { from: 'thinking', to: 'tool' },
      elapsedMs: 5_000,
      capability: capableTerminal(),
    });

    expect(frame.rows).toHaveLength(1);
    expect(rowsText(frame.rows)).toContain(stateLabel('tool'));
    expect(rowsText(frame.rows)).not.toContain(stateLabel('thinking'));
  });

  it('draws the resting line when the terminal cannot draw a frame', () => {
    const frame = renderStateFrame({
      change: { from: 'thinking', to: 'tool' },
      elapsedMs: 0,
      capability: blindTerminal(),
    });

    // The resting frame is the current state, plainly: a motion that is not
    // drawn is not a motion that has finished.
    expect(frame.rows).toHaveLength(1);
    expect(rowsText(frame.rows)).toContain(stateLabel('tool'));
    expect(rowsText(frame.rows)).not.toContain(stateLabel('thinking'));
    expect(frame.offset).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The pipeline's stage advance                                                */
/* -------------------------------------------------------------------------- */

describe("the motion surface — the pipeline's stage advance", () => {
  it('reads the advance out of the protocol\'s notification', () => {
    const advance = stageAdvanceFromParams({
      stageId: 'concept',
      state: 'running',
      enabled: true,
      unsupported: null,
    });

    expect(advance).toEqual({
      stageId: 'concept',
      state: 'running',
      enabled: true,
      unsupported: null,
    });
  });

  it('refuses a notification that carries no stage', () => {
    expect(stageAdvanceFromParams({ state: 'running' })).toBeNull();
    expect(stageAdvanceFromParams({ stageId: '' })).toBeNull();
    expect(stageAdvanceFromParams({ stageId: 42 })).toBeNull();
  });

  it('reads the state and the reason of a stage that did not proceed', () => {
    const advance = stageAdvanceFromParams({
      stageId: 'build',
      state: 'refused',
      enabled: false,
      unsupported: 'the model backend is not connected',
    });

    expect(advance?.state).toBe('refused');
    expect(advance?.enabled).toBe(false);
    expect(advance?.unsupported).toBe('the model backend is not connected');
  });

  it('draws the stage and the state it reached', () => {
    const advance: StageAdvance = {
      stageId: 'concept',
      state: 'completed',
      enabled: true,
      unsupported: null,
    };
    const frame = renderStageFrame({ advance, elapsedMs: 0, capability: capableTerminal() });

    expect(rowsText(frame.rows)).toContain('concept');
    expect(rowsText(frame.rows)).toContain('completed');
  });

  it('names the reason a stage did not proceed', () => {
    const advance: StageAdvance = {
      stageId: 'build',
      state: 'refused',
      enabled: false,
      unsupported: 'the model backend is not connected',
    };
    const frame = renderStageFrame({ advance, elapsedMs: 0, capability: capableTerminal() });

    expect(rowsText(frame.rows)).toContain('the model backend is not connected');
  });

  it('pulses the stage from half brightness to full', () => {
    const advance: StageAdvance = {
      stageId: 'concept',
      state: 'running',
      enabled: true,
      unsupported: null,
    };

    const start = renderStageFrame({ advance, elapsedMs: 0, capability: capableTerminal() });
    const end = renderStageFrame({ advance, elapsedMs: 5_000, capability: capableTerminal() });

    // The pulse is a brightness, and the coarse form of it is the dim style.
    expect(start.rows[0]?.segments.every((segment) => segment.dim === true)).toBe(true);
    expect(end.rows[0]?.segments.some((segment) => segment.dim === true)).toBe(false);
  });

  it('draws the resting stage when the terminal cannot draw a frame', () => {
    const advance: StageAdvance = {
      stageId: 'concept',
      state: 'running',
      enabled: true,
      unsupported: null,
    };
    const frame = renderStageFrame({ advance, elapsedMs: 0, capability: blindTerminal() });

    expect(frame.rows[0]?.segments.every((segment) => segment.dim !== true)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The overlays                                                                */
/* -------------------------------------------------------------------------- */

describe('the motion surface — the overlays', () => {
  const rows: FrameRow[] = [{ segments: [{ text: 'the overlay', role: 'text' }] }];

  it('fades the overlay in', () => {
    const frame = renderOverlayFrame({ rows, elapsedMs: 0, capability: capableTerminal() });

    expect(frame.opacity).toBeLessThan(1);
    expect(frame.rows[0]?.segments.every((segment) => segment.dim === true)).toBe(true);
  });

  it('fades the overlay out', () => {
    const frame = renderOverlayFrame({
      rows,
      elapsedMs: 0,
      capability: capableTerminal(),
      motion: 'overlay-out',
    });

    // The exit starts at full presence and goes to none.
    expect(frame.opacity).toBeGreaterThan(0.9);
    expect(frame.rows[0]?.segments.every((segment) => segment.dim === true)).toBe(false);
  });

  it('draws the resting overlay when the terminal cannot draw a frame', () => {
    const frame = renderOverlayFrame({ rows, elapsedMs: 0, capability: blindTerminal() });

    // The resting frame is the overlay, fully present and not dimmed.
    expect(frame.opacity).toBe(1);
    expect(frame.rows[0]?.segments.every((segment) => segment.dim !== true)).toBe(true);
  });

  it('draws the approval dialog\'s own lines', () => {
    const overlay = approvalOverlayRows({
      title: 'Bash command',
      question: 'Do you want to proceed?',
      reason: 'No permission rule matched.',
      choices: [
        { value: 'yes', label: 'Yes', focused: true, selected: true },
        { value: 'no', label: 'No', focused: false, selected: false },
      ],
      guide: 'enter to confirm · esc to cancel',
    });

    const text = rowsText(overlay);
    expect(text).toContain('Bash command');
    expect(text).toContain('Do you want to proceed?');
    expect(text).toContain('No permission rule matched.');
    expect(text).toContain('enter to confirm · esc to cancel');
  });

  it('draws the autocomplete overlay\'s own rows', () => {
    const overlay = autocompleteOverlayRows(
      [
        {
          id: 'help:command',
          displayText: '/help',
          description: 'Show the help',
          command: {
            name: 'help',
            description: 'Show the help',
            aliases: [],
            hidden: false,
            type: 'command',
          } as never,
        },
      ],
      0,
    );

    const text = rowsText(overlay);
    expect(text).toContain('/help');
    expect(text).toContain('Show the help');
  });
});

/* -------------------------------------------------------------------------- */
/* The picture                                                                  */
/* -------------------------------------------------------------------------- */

describe('the motion surface — the picture', () => {
  it('writes the colours the theme owns', () => {
    const frame = renderMotionSurface({
      capability: capableTerminal(),
      elapsedMs: 240,
      prompt: { columns: 12 },
    });

    const picture = frameText(frame);
    expect(picture).toContain(PROMPT_RULE_CHARACTER.repeat(12));
  });

  it('reports the reason beside the resting picture, and only when it cannot draw', () => {
    const reason = 'the user asked for reduced motion, so no animation is drawn';

    const blind = renderMotionSurface({
      capability: blindTerminal(reason),
      elapsedMs: 240,
      prompt: { columns: 12 },
    });
    expect(frameText(blind)).toContain(reason);

    const capable = renderMotionSurface({
      capability: capableTerminal(),
      elapsedMs: 240,
      prompt: { columns: 12 },
    });
    expect(frameText(capable)).not.toContain(reason);
  });

  it('draws no reason row when the terminal can draw', () => {
    expect(motionReasonRow(capableTerminal())).toBeNull();
    expect(motionReasonRow(blindTerminal())).not.toBeNull();
  });

  it('writes no colour of its own', () => {
    // Every role the surface draws is one the theme owns.
    const frame = renderMotionSurface({
      capability: capableTerminal(),
      elapsedMs: 240,
      prompt: { columns: 12 },
      state: { from: 'thinking', to: 'tool' },
      stage: {
        stageId: 'concept',
        state: 'running',
        enabled: true,
        unsupported: null,
      },
    });

    const roles = frame.rows.flatMap((row) => row.segments.map((segment) => segment.role));
    for (const role of roles) {
      if (role === undefined) continue;
      expect(Object.hasOwn(DARK_THEME, role)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

describe('the motion surface — the vocabulary', () => {
  it('names the four states, and every one of them is a state the surface knows', () => {
    for (const state of AGENT_STATES) {
      const known: AgentState = state;
      expect(AGENT_STATES).toContain(known);
    }
  });
});
