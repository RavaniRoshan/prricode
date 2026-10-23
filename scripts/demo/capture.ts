/**
 * The **capture** — the run the demo GIF is drawn from, recorded beat by beat.
 *
 * ## What this module is
 *
 * It drives the repository's own interactive UI (`src/ui/app.ts`) through the
 * beat table (`./story.ts`), and records what the real renderer put on the
 * screen: the UI mounted on a terminal-width stream, fed the records of one
 * turn, and re-rendered once per beat — each beat holding the screen for the
 * frames the storyboard gives it.
 *
 * The records are turned into the conversation's own record shape before the
 * app sees them; nothing else is invented. The app is **controlled**: the
 * caller owns the input text, the records, the status and the motion, exactly
 * as a host does.
 *
 * ## What it writes
 *
 *   - `<dir>/beat-<n>.json` — the screen rows of one beat, as cells: the
 *     character of each column with the foreground and background the real
 *     renderer asked for, and the attributes it set;
 *   - `<dir>/beat-<n>.txt` — the same rows as plain text, for a quick read;
 *   - `<dir>/plan.json` — the frame plan: every frame of the GIF with the
 *     beat it draws, its hold in milliseconds, and the compositor's own
 *     extras (the keystroke pill and the block cursor).
 *
 * The screen model replays the renderer's output the way a terminal does —
 * cursor moves, line erases, attributes, wrapping — so the rows are what a
 * reader of the session would see.Chunks that arrive split across write
 * boundaries are held back until a sequence is complete, so an edge never
 * corrupts a row.
 *
 * ## The two things the compositor draws itself
 *
 * The block cursor: the composer hides the terminal's hardware caret while a
 * line is being typed — the picture a reader sees on a cold open carried no
 * caret at all, so the compositor draws the block at the echo's end
 (`caret`) — and the transient keystroke pill (`pill`) is the compositor's,
 * straight from the beat table. Everything else on the screen is the real
 * renderer's output.
 */

import { Writable } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createElement } from 'react';

import { App, renderApp, type AppProps, type PendingApproval } from '../../src/ui/app.js';
import { SESSION_SCHEMA_VERSION, type SessionEvent } from '../../src/session/event.js';
import type { ToolResultEnvelope } from '../../src/tools/runner.js';
import type { MotionCapability } from '../../src/ui/motion/capability.js';

import { BEATS, HOLDS, PHASE_BEATS, PHASE_NAMES, BRIEF } from './story.js';
import type { Beat, DemoEvent } from './events.js';

/* -------------------------------------------------------------------------- */
/* The screen model                                                            */
/* -------------------------------------------------------------------------- */

/** One cell of the screen: a character and how the renderer drew it. */
export interface Cell {
  /** The character; a space when the cell is blank. */
  ch: string;
  /** The foreground the renderer set, as `r,g,b`, or null for the default. */
  fg: string | null;
  /** The background the renderer set, as `r,g,b`, or null for the default. */
  bg: string | null;
  /** Whether the renderer asked for bold. */
  bold: boolean;
  /** Whether the renderer asked for dim. */
  dim: boolean;
  /** Whether the renderer asked for italic. */
  italic: boolean;
  /** Whether the renderer asked for inverse. */
  inverse: boolean;
}

const COLUMNS = 76;
const RESERVE_ROWS = 300;
const CROP_ROWS = 18;

function blank(): Cell {
  return { ch: ' ', fg: null, bg: null, bold: false, dim: false, italic: false, inverse: false };
}

/**
 * The indexed palette a terminal falls back to, for a renderer that speaks
 * the eight-colour form. The run's own renderer speaks the true-colour form;
 * this table is the small bridge for anything else.
 */
function indexedColour(index: number): string {
  const basics = [
    '0,0,0', '128,0,0', '0,128,0', '128,128,0',
    '0,0,128', '128,0,128', '0,128,128', '192,192,192',
    '128,128,128', '255,0,0', '0,255,0', '255,255,0',
    '0,0,255', '255,0,255', '0,255,255', '255,255,255',
  ];
  const basic = basics[index];
  if (basic !== undefined) return basic;
  if (index >= 232) {
    const grey = 8 + (index - 232) * 10;
    return `${grey},${grey},${grey}`;
  }
  if (index >= 16 && index <= 231) {
    const rest = index - 16;
    const step = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
    const r = step(Math.floor(rest / 36));
    const g = step(Math.floor((rest % 36) / 6));
    const b = step(rest % 6);
    return `${r},${g},${b}`;
  }
  return '255,255,255';
}

/**
 * The screen: the rows the renderer wrote, replayed the way a terminal
 * replays them.
 */
class Screen {
  readonly rows: Cell[][] = [];
  #row = 0;
  #col = 0;
  #fg: string | null = null;
  #bg: string | null = null;
  #bold = false;
  #dim = false;
  #italic = false;
  #inverse = false;
  #hold = '';

  /** Feed the next chunk of the renderer's output. */
  feed(text: string): void {
    this.#hold += text;
    let index = 0;
    while (index < this.#hold.length) {
      const ch = this.#hold[index] ?? '';
      if (ch === '\u001b') {
        const length = this.#sequenceLength(this.#hold, index);
        if (length === undefined) break;
        this.#escape(this.#hold.slice(index, index + length));
        index += length;
        continue;
      }
      this.#write(ch);
      index += 1;
    }
    this.#hold = this.#hold.slice(index);
  }

  /** The highest row that carries any non-blank cell. */
  bottom(): number {
    for (let row = this.rows.length - 1; row >= 0; row -= 1) {
      const line = this.rows[row];
      if (line === undefined) continue;
      for (const cell of line) {
        if (cell.ch !== ' ') return row;
      }
    }
    return 0;
  }

  /** One row of the output as plain text, trailing blanks trimmed. */
  rowText(row: number): string {
    const line = this.rows[row];
    if (line === undefined) return '';
    let out = '';
    for (const cell of line) out += cell.ch;
    return out.replace(/\s+$/, '');
  }

  /** A sequence's length, or undefined while it is still arriving. */
  #sequenceLength(text: string, start: number): number | undefined {
    const next = text[start + 1];
    if (next === undefined) return undefined;
    if (next === '[') {
      for (let index = start + 2; index < text.length; index += 1) {
        const code = text.charCodeAt(index) ?? 0;
        if (code >= 0x40 && code <= 0x7e) return index - start + 1;
      }
      return undefined;
    }
    if (next === ']') {
      for (let index = start + 2; index < text.length; index += 1) {
        const code = text.charCodeAt(index) ?? 0;
        if (code === 0x07) return index - start + 1;
        if (code === 0x1b && text[index + 1] === '\\') return index - start + 2;
      }
      return undefined;
    }
    if (next === '(' || next === ')') return text.length - start >= 3 ? 3 : undefined;
    return 2;
  }

  #escape(sequence: string): void {
    if (sequence[1] !== '[') return;
    const final = sequence[sequence.length - 1] ?? '';
    const body = sequence.slice(2, sequence.length - 1);
    const parameter = (fallback: number): number => {
      const raw = body === '' ? '' : (body.split(';')[0] ?? '');
      const value = Number(raw === '' ? String(fallback) : raw);
      return Number.isFinite(value) ? value : fallback;
    };
    switch (final) {
      case 'H':
      case 'f': {
        const parts = body.split(';');
        const row = Number(parts[0] === undefined || parts[0] === '' ? '1' : parts[0]);
        const col = Number(parts[1] === undefined || parts[1] === '' ? '1' : parts[1]);
        this.#row = Math.max(0, Math.min(RESERVE_ROWS - 1, row - 1));
        this.#col = Math.max(0, Math.min(COLUMNS - 1, col - 1));
        return;
      }
      case 'A':
        this.#row = Math.max(0, this.#row - parameter(1));
        return;
      case 'B':
        this.#row = Math.min(RESERVE_ROWS - 1, this.#row + parameter(1));
        return;
      case 'E':
        this.#row = Math.min(RESERVE_ROWS - 1, this.#row + parameter(1));
        this.#col = 0;
        return;
      case 'F':
        this.#row = Math.max(0, this.#row - parameter(1));
        this.#col = 0;
        return;
      case 'G':
        this.#col = Math.max(0, Math.min(COLUMNS - 1, parameter(1) - 1));
        return;
      case 'd':
        this.#row = Math.max(0, Math.min(RESERVE_ROWS - 1, parameter(1) - 1));
        return;
      case 'K':
        this.#eraseLine(body === '' ? 0 : Number(body));
        return;
      case 'J':
        if (body === '2') {
          for (let row = 0; row < this.rows.length; row += 1) this.#clearRow(row);
          return;
        }
        this.#eraseDown();
        return;
      case 'm':
        this.#sgr(body);
        return;
      default:
        return;
    }
  }

  #sgr(body: string): void {
    const params = body === '' ? ['0'] : body.split(';');
    let index = 0;
    while (index < params.length) {
      const raw = params[index] ?? '';
      const code = Number(raw === '' ? '0' : raw);
      if (code === 38 || code === 48) {
        const space = Number(params[index + 1] ?? '0');
        if (space === 2) {
          const rgb = `${params[index + 2] ?? '0'},${params[index + 3] ?? '0'},${params[index + 4] ?? '0'}`;
          if (code === 38) this.#fg = rgb;
          else this.#bg = rgb;
          index += 5;
          continue;
        }
        if (space === 5) {
          const rgb = indexedColour(Number(params[index + 2] ?? '0'));
          if (code === 38) this.#fg = rgb;
          else this.#bg = rgb;
          index += 3;
          continue;
        }
        index += 1;
        continue;
      }
      if (code === 0) {
        this.#fg = null;
        this.#bg = null;
        this.#bold = false;
        this.#dim = false;
        this.#italic = false;
        this.#inverse = false;
      } else if (code === 1) {
        this.#bold = true;
      } else if (code === 2) {
        this.#dim = true;
      } else if (code === 3) {
        this.#italic = true;
      } else if (code === 7) {
        this.#inverse = true;
      } else if (code === 22) {
        this.#bold = false;
        this.#dim = false;
      } else if (code === 23) {
        this.#italic = false;
      } else if (code === 27) {
        this.#inverse = false;
      } else if (code === 39) {
        this.#fg = null;
      } else if (code === 49) {
        this.#bg = null;
      }
      index += 1;
    }
  }

  #eraseLine(mode: number): void {
    const line = this.rows[this.#row];
    if (line === undefined) return;
    const from = mode === 1 ? 0 : this.#col;
    const to = mode === 1 ? this.#col : COLUMNS - 1;
    for (let cell = from; cell <= to; cell += 1) line[cell] = blank();
  }

  #eraseDown(): void {
    const line = this.rows[this.#row];
    if (line !== undefined) {
      for (let cell = this.#col; cell < COLUMNS; cell += 1) line[cell] = blank();
    }
    for (let below = this.#row + 1; below < this.rows.length; below += 1) {
      this.#clearRow(below);
    }
  }

  #clearRow(row: number): void {
    const line = this.#rowAt(row);
    for (let cell = 0; cell < COLUMNS; cell += 1) line[cell] = blank();
  }

  #rowAt(row: number): Cell[] {
    const found = this.rows[row];
    if (found !== undefined) return found;
    while (this.rows.length <= row) {
      const fresh: Cell[] = [];
      for (let cell = 0; cell < COLUMNS; cell += 1) fresh.push(blank());
      this.rows.push(fresh);
    }
    const line = this.rows[row];
    return line ?? [];
  }

  #write(ch: string): void {
    if (ch === '\n') {
      this.#row = Math.min(RESERVE_ROWS - 1, this.#row + 1);
      this.#col = 0;
      this.#rowAt(this.#row);
      return;
    }
    if (ch === '\r') {
      this.#col = 0;
      return;
    }
    if (this.#col >= COLUMNS) {
      this.#col = 0;
      this.#row = Math.min(RESERVE_ROWS - 1, this.#row + 1);
      this.#rowAt(this.#row);
    }
    const line = this.#rowAt(this.#row);
    const cell = line[this.#col];
    if (cell !== undefined) {
      line[this.#col] = {
        ch,
        fg: this.#fg,
        bg: this.#bg,
        bold: this.#bold,
        dim: this.#dim,
        italic: this.#italic,
        inverse: this.#inverse,
      };
    }
    this.#col += 1;
  }
}

/* -------------------------------------------------------------------------- */
/* The records the app is fed                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The run's records, in the conversation's own shape. The bookkeeping members
 * come from the record version this build writes; the ids follow the record's
 * position, so a record that two beats hold is the same record both times.
 */
function toSessionEvents(events: readonly DemoEvent[]): SessionEvent[] {
  return events.map((event, index) => {
    const base = {
      v: SESSION_SCHEMA_VERSION,
      ts: 1_700_000_000_000 + index * 1000,
      id: `demo-${index}`,
    };
    switch (event.t) {
      case 'user_message':
        return { ...base, t: 'user_message', text: event.text };
      case 'assistant_message':
        return { ...base, t: 'assistant_message', text: event.text };
      case 'tool_call':
        return { ...base, t: 'tool_call', id: event.id, name: event.name, input: event.input };
      case 'tool_result':
        return {
          ...base,
          t: 'tool_result',
          envelope: event.envelope as unknown as ToolResultEnvelope,
        };
    }
  }) as unknown as SessionEvent[]; // the capture's bookkeeping members are synthetic: the version, the timestamp, the id
}

/* -------------------------------------------------------------------------- */
/* The frame plan                                                              */
/* -------------------------------------------------------------------------- */

/** One frame of the plan: the beat it draws and the hold it takes. */
interface PlanFrame {
  /** The frame's index, from 0. */
  index: number;
  /** The beat the frame holds. */
  beat: number;
  /** The hold in milliseconds. */
  delay: number;
}

/** The plan the compositor reads. */
interface Plan {
  /** The GIF canvas, in pixels. */
  canvas: { width: number; height: number };
  /** The rows the window body crops to. */
  cropRows: number;
  /** The holds the storyboard fixes, as index/hold pairs. */
  holds: Array<[number, number]>;
  /** The phases: their name and the beat range they cover. */
  phases: Array<{ name: string; firstBeat: number; lastBeat: number }>;
  /** Every frame, in order. */
  frames: PlanFrame[];
  /** The beat, its snapshot file, and the compositor's extras. */
  beats: Array<{
    index: number;
    file: string;
    frames: number;
    /** The keystroke the compositor's pill marks, when there is one. */
    pill?: 'enter' | 'esc';
    /** Whether the compositor draws the static block cursor. */
    caret?: boolean;
    /** The tool the approval prompt was about, when one was up. */
    approval?: string;
  }>;
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

const OUT_DIR = process.argv[2] ?? '/tmp/opencode/demo-work';
const BRIEF_ROWS = 18;

const clock = { ms: 0 };
const CAPABLE: MotionCapability = {
  enabled: true,
  unsupported: null,
  interactive: true,
  reducedMotion: false,
};

/** The stream the UI is mounted on: a terminal-width window into a tall buffer. */
function makeStdout(screen: Screen): Writable {
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      screen.feed(chunk.toString('utf8'));
      callback();
    },
  });
  Object.defineProperty(stdout, 'isTTY', { value: true });
  Object.defineProperty(stdout, 'columns', { value: COLUMNS });
  Object.defineProperty(stdout, 'rows', { value: RESERVE_ROWS });
  return stdout;
}

/** The approval the host asks about, in the decision shape the prompt shows. */
function approvalFor(toolName: string): PendingApproval {
  return {
    decision: {
      behavior: 'ask',
      source: 'unknown',
      reasonType: 'other',
      reason: 'No permission rule matched.',
    },
    toolName,
  };
}

/** The clock's step for one beat: a burst holds mid-arrival; a settle jumps. */
function clockStep(beat: Beat): number {
  return beat.from !== undefined || beat.to !== undefined ? 90 : 640;
}

/** The sleep the run waits between a re-render and its snapshot. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const screen = new Screen();
  const stdout = makeStdout(screen);

  const base = {
    env: process.env,
  };

  const props = (
    beat: Beat,
    state: AppProps['motion'],
    approval: PendingApproval | undefined,
  ): AppProps => ({
    events: toSessionEvents(beat.events),
    input: beat.input,
    busy: beat.busy,
    status: beat.status,
    approval,
    notice: beat.notice,
    motion: state,
    ...base,
  });

  let lastState: NonNullable<NonNullable<AppProps['motion']>['state']> | undefined;
  let lastStage: NonNullable<NonNullable<AppProps['motion']>['stage']> | undefined;
  let approval: PendingApproval | undefined;

  const instance = renderApp(props(BEATS[0] ?? { events: [], input: '', busy: false, frames: 0 }, undefined, undefined), {
    stdout,
    debug: false,
    patchConsole: false,
  });
  await instance.waitUntilRenderFlush();
  await sleep(240);

  const planBeats: Plan['beats'] = [];
  const planFrames: PlanFrame[] = [];

  for (let index = 0; index < BEATS.length; index += 1) {
    const beat = BEATS[index] ?? { events: [], input: '', busy: false, frames: 0 };
    const report: string[] = [];
    if (beat.from !== undefined || beat.to !== undefined) {
      lastState = {
        change: { from: beat.from ?? null, to: beat.to ?? 'tool' },
        atMs: clock.ms,
      };
    }
    if (beat.stageId !== undefined) {
      lastStage = {
        advance: {
          stageId: beat.stageId,
          state: beat.stageState ?? 'pending',
          enabled: true,
          unsupported: null,
        },
        atMs: clock.ms,
      };
    }
    if (beat.approval !== undefined) approval = approvalFor(beat.approval);
    else approval = undefined;

    clock.ms += clockStep(beat);

    const motion: NonNullable<AppProps['motion']> = {
      capability: CAPABLE,
      state: lastState,
      stage: lastStage,
      now: () => clock.ms,
    };

    instance.rerender(createElement(App, props(beat, motion, approval)));
    await instance.waitUntilRenderFlush();
    await sleep(230);

    // The crop: the last rows of the output, pinned to its bottom edge.
    const bottom = screen.bottom();
    const first = Math.max(0, bottom - (BRIEF_ROWS - 1));
    const rows: Cell[][] = [];
    for (let row = first; row <= bottom; row += 1) {
      const line = screen.rows[row];
      if (line === undefined) continue;
      rows.push(line.map((cell) => ({ ...cell })));
    }

    const file = `beat-${index}.json`;
    await writeFile(
      path.join(OUT_DIR, file),
      JSON.stringify({
        beat: index,
        rows: rows.length,
        bottom,
        cells: rows,
        text: rows.map((_, row) => screen.rowText(first + row)),
      }),
    );

    report.push(
      `beat ${index} (${String(beat.frames).padStart(2)}f) rows ${first}-${bottom}` +
        ` | ${screen.rowText(bottom)}`,
    );

    const currentIndex = planBeats.length;
    for (let frame = 0; frame < beat.frames; frame += 1) {
      const global = planFrames.length;
      planFrames.push({ index: global, beat: currentIndex, delay: HOLDS.get(global) ?? 100 });
    }
    planBeats.push({
      index: currentIndex,
      file,
      frames: beat.frames,
      ...(beat.pill === undefined ? {} : { pill: beat.pill }),
      ...(beat.busy !== true && beat.input !== '' ? { caret: true } : {}),
      ...(beat.approval === undefined ? {} : { approval: beat.approval }),
    });

    if (index < BEATS.length - 1 && report[0] !== undefined) console.log(report[0]);
  }

  await instance.unmount();

  const plan: Plan = {
    canvas: { width: 1552, height: 992 },
    cropRows: CROP_ROWS,
    holds: [...HOLDS.entries()].sort((a, b) => a[0] - b[0]),
    phases: (() => {
      const phases: Plan['phases'] = [];
      let beat = 0;
      for (let phase = 0; phase < PHASE_BEATS.length; phase += 1) {
        const count = PHASE_BEATS[phase] ?? 0;
        phases.push({
          name: PHASE_NAMES[phase] ?? '',
          firstBeat: beat,
          lastBeat: beat + count - 1,
        });
        beat += count;
      }
      return phases;
    })(),
    frames: planFrames,
    beats: planBeats,
  };

  await writeFile(path.join(OUT_DIR, 'plan.json'), JSON.stringify(plan, null, 1));

  // The self-check: the run's own report and the two gesture texts must have
  // been on the screen by the end.
  const finalBottom = screen.bottom();
  const tail = [...Array(6).keys()].map((offset) => screen.rowText(finalBottom - offset));
  console.log('final rows:', tail.join(' || '));
  console.log('bottom row:', finalBottom);
  console.log('frames:', planFrames.length, 'beats:', planBeats.length);
  console.log('out dir:', OUT_DIR);
}

await main();
