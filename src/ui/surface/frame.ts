/**
 * The **frame** — the picture, and the two ways it is written.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **One responsibility:** the frame, and the bytes that put it on a terminal.
 *
 * ## What a frame is
 *
 * A frame is **rows of the first layer's own segments** — a piece of text and
 * the theme **role** it is drawn in. It is the first layer's shape, unchanged:
 * the motion surface draws segments, and it writes no colour of its own.
 *
 * ## Two ways to write it
 *
 * | the way | what it is | who uses it |
 * |---|---|---|
 * | `frameText` | the frame's **characters** | a test that compares the frame with what the app drew |
 * | `renderPicture` | the frame's **bytes** — the escape sequences that put the colours on the screen | the **golden**: a golden frame is a picture, and a picture is what the terminal shows |
 *
 * The picture is the ANSI the terminal would receive: the theme's own colour
 * literals, the styles every terminal has, and nothing else. `cat` on a golden
 * in a terminal shows the frame as the user saw it.
 *
 * ## The frame is a value
 *
 * A frame carries no clock and no counter, so the same frame is the same
 * picture every time — which is what makes a golden possible at all.
 */

import { DARK_THEME, roleColor, type Segment, type Theme } from '../theme.js';

/* -------------------------------------------------------------------------- */
/* The frame                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One row of a frame.
 *
 * The row carries the **segments** and, when it has one, the theme role of
 * the **background** it is drawn on.
 */
export interface FrameRow {
  /** The row's text, as the first layer's own segments. */
  readonly segments: readonly Segment[];
  /** The theme role of the row's background, when it has one. */
  readonly background?: string | undefined;
}

/** A frame: the rows, in the order they are drawn. */
export interface TerminalFrame {
  /** The frame's rows. */
  readonly rows: readonly FrameRow[];
}

/**
 * A row of segments.
 *
 * The background is the theme **role** of the colour, and not the colour: the
 * theme owns the colours.
 */
export function rowOf(segments: readonly Segment[], background?: string | undefined): FrameRow {
  return background === undefined ? { segments } : { segments, background };
}

/** A frame of rows. */
export function frameOf(rows: readonly FrameRow[]): TerminalFrame {
  return { rows };
}

/**
 * The frame's characters, and nothing else.
 *
 * The styles are dropped on purpose: this is the text a test compares with
 * what the app drew on the terminal.
 */
export function frameText(frame: TerminalFrame): string {
  return frame.rows.map((row) => row.segments.map((segment) => segment.text).join('')).join('\n');
}

/* -------------------------------------------------------------------------- */
/* The colours                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The **ansi** colours, and the SGR code each one names.
 *
 * The theme's variant themes carry a few `ansi:` literals, and a terminal that
 * speaks sixteen colours is told which one by a number. The names are the
 * theme's own; the codes are the terminal's.
 */
const ANSI_CODES: ReadonlyMap<string, number> = new Map<string, number>([
  ['ansi:black', 30],
  ['ansi:red', 31],
  ['ansi:green', 32],
  ['ansi:yellow', 33],
  ['ansi:blue', 34],
  ['ansi:magenta', 35],
  ['ansi:cyan', 36],
  ['ansi:white', 37],
  ['ansi:brightBlack', 90],
  ['ansi:brightRed', 91],
  ['ansi:brightGreen', 92],
  ['ansi:brightYellow', 93],
  ['ansi:brightBlue', 94],
  ['ansi:brightMagenta', 95],
  ['ansi:brightCyan', 96],
  ['ansi:brightWhite', 97],
  // The theme spells the bright ones with the colour first.
  ['ansi:blackBright', 90],
  ['ansi:redBright', 91],
  ['ansi:greenBright', 92],
  ['ansi:yellowBright', 93],
  ['ansi:blueBright', 94],
  ['ansi:magentaBright', 95],
  ['ansi:cyanBright', 96],
  ['ansi:whiteBright', 97],
]);

/**
 * The three numbers of an `rgb(r,g,b)` literal.
 *
 * The theme's literals are the target's own, spaces and all, so the pattern
 * accepts the spaces the target wrote.
 */
function parseRgb(color: string): readonly [number, number, number] | undefined {
  const match = /^rgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)$/.exec(color);
  if (match === null) return undefined;
  const red = Number(match[1]);
  const green = Number(match[2]);
  const blue = Number(match[3]);
  if (red > 255 || green > 255 || blue > 255) return undefined;
  return [red, green, blue];
}

/**
 * The SGR parameter that puts a colour in front of the text.
 *
 * A colour the theme does not own has **no** parameter: the text is drawn in
 * the terminal's own default, which is what the first layer does with a role
 * that is not in the theme.
 */
function foregroundOf(color: string): string | undefined {
  const ansi = ANSI_CODES.get(color);
  if (ansi !== undefined) return String(ansi);
  const rgb = parseRgb(color);
  if (rgb === undefined) return undefined;
  return `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
}

/**
 * The SGR parameter that puts a colour behind the text.
 *
 * The background's codes are the foreground's plus ten for the normal eight
 * and sixty for the bright eight.
 */
function backgroundOf(color: string): string | undefined {
  const ansi = ANSI_CODES.get(color);
  // The normal eight are 30-37 and the bright eight are 90-97, and the
  // background of both is ten higher.
  if (ansi !== undefined) return String(ansi + 10);
  const rgb = parseRgb(color);
  if (rgb === undefined) return undefined;
  return `48;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
}

/* -------------------------------------------------------------------------- */
/* The picture                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The SGR parameters of a segment, in a fixed order.
 *
 * The order is fixed so the picture is **reproducible**: the same segment
 * always produces the same bytes, on any machine.
 */
function attributesOf(segment: Segment, theme: Theme): string {
  const parts: string[] = [];
  if (segment.bold === true) parts.push('1');
  if (segment.dim === true) parts.push('2');
  if (segment.italic === true) parts.push('3');
  if (segment.underline === true) parts.push('4');
  if (segment.inverse === true) parts.push('7');
  if (segment.strike === true) parts.push('9');
  if (segment.role !== undefined) {
    const color = roleColor(segment.role, theme);
    if (color !== undefined) {
      const foreground = foregroundOf(color);
      if (foreground !== undefined) parts.push(foreground);
    }
  }
  return parts.join(';');
}

/**
 * The picture — the bytes that put the frame on the terminal.
 *
 * The frame's rows are written in order, and each row is ended with a reset
 * so the next row starts from the terminal's own defaults.
 */
export function renderPicture(frame: TerminalFrame, theme: Theme = DARK_THEME): string {
  const lines: string[] = [];

  for (const row of frame.rows) {
    const background =
      row.background === undefined ? undefined : backgroundOf(roleColor(row.background, theme) ?? '');
    const rowAttributes = background === undefined ? '' : background;

    let out = rowAttributes === '' ? '' : `\u001b[0m\u001b[${rowAttributes}m`;
    let current = rowAttributes;

    for (const segment of row.segments) {
      const attributes = attributesOf(segment, theme);
      const next = rowAttributes === '' ? attributes : `${rowAttributes};${attributes}`;
      if (next !== current) {
        out += '\u001b[0m';
        if (next !== '') out += `\u001b[${next}m`;
        current = next;
      }
      out += segment.text;
    }

    if (current !== '') out += '\u001b[0m';
    lines.push(out);
  }

  return lines.join('\n');
}
