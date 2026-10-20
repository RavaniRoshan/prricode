/**
 * The markdown renderer.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.10 (The
 * command-line surface) and the `CC-015` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What this module is
 *
 * Ink has **no** built-in markdown, so the markdown rendering is this implementation's
 * own job. The plan names `markdansi` (the maintained option; `ink-markdown` is
 * stale), and `markdansi` does the formatting of the **prose**. This module
 * adds the three things a streaming terminal UI needs on top of it.
 *
 * ## 1. A partially-streamed fragment must render
 *
 * A turn's text arrives in pieces, so the renderer is handed fragments that are
 * **not valid markdown yet**: an unterminated emphasis marker, an unterminated
 * fenced code block, a half-written table row. The renderer must **render** such
 * a fragment — not throw, and not drop it — because dropping a fragment loses
 * text the user is watching arrive.
 *
 * The tolerance is **explicit** here, in three places:
 *
 *   - an **unterminated fence** is treated as a code block that runs to the end
 *     of the fragment (the CommonMark rule), so the code is shown as code;
 *   - `markdansi` is called inside a `try`/`catch`, and a renderer that throws
 *     falls back to the **raw text** rather than losing the fragment;
 *   - the renderer never returns `undefined` and never throws: it always
 *     returns a string, and the string always contains the fragment's text.
 *
 * ## 2. A fenced code block keeps its language
 *
 * The **language** of a fenced code block is part of what the user reads, and
 * `markdansi` only shows it when it draws the block's box — which it does not
 * do for a block of a single line. This implementation therefore splits the source into
 * **prose segments** and **code segments** and renders the code segments
 * itself, so the language is shown **always**:
 *
 * ```
 * [ts]
 * const x = 1;
 * ```
 *
 * The code's **content** is emitted verbatim and is never handed back to a
 * markdown parser, so **a fenced code block cannot break out of its fence**:
 * a model that writes a closing fence inside the block, or markdown syntax
 * inside it, changes nothing — the text is shown as text.
 *
 * ## 3. The renderer is safe against hostile input
 *
 * A model can emit **arbitrary** text, and the terminal is the place where
 * arbitrary text does damage: an escape sequence can clear the screen, move the
 * cursor, retitle the window, or — the one that matters most for this implementation —
 * **enter the alternate screen** and destroy the scrollback the target's UI
 * keeps. The renderer therefore **strips every control sequence** from the
 * source before it is parsed, keeping only the line feed and the tab.
 *
 * Nothing is **evaluated**: `markdansi` is a formatter over a parsed AST, and
 * the code segments never reach a parser at all.
 *
 * ## What is observed and what is a implementation choice
 *
 * The audit pins the **input and output formats** of the command line and says
 * nothing about how a terminal UI draws a fenced code block. The shape of the
 * rendered block, the `[ts]` label, the width the prose is laid out at, and the
 * control-sequence stripping are therefore **implementation choices**, and they are
 * marked as such below.
 *
 * The function is **pure**: it reads no clock, touches no terminal and touches
 * no filesystem. That is what makes it testable.
 */

import { render as renderMarkdansi } from 'markdansi';

/* -------------------------------------------------------------------------- */
/* The constants                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The width the prose is laid out at.
 *
 * **Implementation choice.** The renderer is a pure function and is not told the
 * terminal's width, so it lays the prose out at a fixed width and lets the
 * terminal wrap whatever is longer. Wrapping is therefore **off**: a hard wrap
 * at a width the terminal does not have would break the code blocks' own
 * layout, and the terminal's own wrapping is the right one.
 */
export const MARKDOWN_WIDTH = 80;

/* -------------------------------------------------------------------------- */
/* The source scanner                                                          */
/* -------------------------------------------------------------------------- */

/** A piece of the source: either prose or a fenced code block. */
type Segment =
  | { kind: 'prose'; content: string }
  | { kind: 'code'; language: string | undefined; content: string };

/** An opening fence. */
interface Fence {
  /** The fence's marker character: a backtick or a tilde. */
  readonly marker: '`' | '~';
  /** How many marker characters the fence is made of. */
  readonly length: number;
  /** The info string that follows the fence. */
  readonly info: string;
}

/** The opening fence: up to three spaces of indentation, then three or more markers. */
const FENCE_OPEN = /^(?: {0,3})(`{3,}|~{3,})(.*)$/;

/** The closing fence: up to three spaces of indentation, then markers and nothing else. */
const FENCE_CLOSE = /^(?: {0,3})(`{3,}|~{3,})[ \t]*$/;

/**
 * Match an opening fence.
 *
 * The **backtick** rule of CommonMark is honoured: the info string of a
 * backtick fence may not contain a backtick, because a backtick in the info
 * string is how a writer escapes a fence that is not really a fence.
 */
function matchFenceOpen(line: string): Fence | undefined {
  const match = FENCE_OPEN.exec(line);
  if (match === null) return undefined;
  const markers = match[1];
  const rest = match[2];
  if (markers === undefined || rest === undefined) return undefined;
  const marker = markers[0];
  if (marker !== '`' && marker !== '~') return undefined;
  if (marker === '`' && rest.includes('`')) return undefined;
  return { marker, length: markers.length, info: rest.trim() };
}

/**
 * Whether a line closes a fence.
 *
 * The closing fence must use the **same** marker character and be **at least as
 * long** as the opening one, and it must carry nothing else. A line that only
 * looks like a fence — a backtick inside a line of code, say — does not close
 * the block.
 */
function isFenceClose(line: string, fence: Fence): boolean {
  const match = FENCE_CLOSE.exec(line);
  if (match === null) return false;
  const markers = match[1];
  if (markers === undefined) return false;
  if (markers[0] !== fence.marker) return false;
  return markers.length >= fence.length;
}

/**
 * The language of a fenced code block.
 *
 * It is the **first word** of the info string: `` ```ts title="x" `` names the
 * language `ts`.
 */
function languageOf(info: string): string | undefined {
  const trimmed = info.trim();
  if (trimmed === '') return undefined;
  const first = trimmed.split(/\s+/)[0];
  if (first === undefined || first === '') return undefined;
  // A bracket in the language would make the label ambiguous; the language is
  // a label, not markup.
  return first.replace(/[[\]]/g, '');
}

/**
 * Split the source into prose and code segments.
 *
 * An **unterminated** fence runs to the end of the fragment: that is the
 * CommonMark rule, and it is what makes a half-streamed code block render as
 * the code block it is going to be.
 */
function segment(source: string): Segment[] {
  const lines = source.split('\n');
  const segments: Segment[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    if (prose.length === 0) return;
    segments.push({ kind: 'prose', content: prose.join('\n') });
    prose = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      index += 1;
      continue;
    }
    const fence = matchFenceOpen(line);
    if (fence === undefined) {
      prose.push(line);
      index += 1;
      continue;
    }

    flushProse();
    const body: string[] = [];
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index];
      if (candidate === undefined) {
        index += 1;
        continue;
      }
      if (isFenceClose(candidate, fence)) {
        index += 1;
        break;
      }
      body.push(candidate);
      index += 1;
    }
    segments.push({ kind: 'code', language: languageOf(fence.info), content: body.join('\n') });
  }

  flushProse();
  return segments;
}

/* -------------------------------------------------------------------------- */
/* The control-sequence stripper                                               */
/* -------------------------------------------------------------------------- */

/**
 * Strip every control sequence from the text.
 *
 * The text a model emits reaches a **terminal**, and a terminal acts on escape
 * sequences: `ESC [ 2 J` clears the screen, `ESC ] 0 ; … BEL` retitles the
 * window, and `ESC [ ? 1049 h` enters the **alternate screen** — the one thing
 * this implementation's UI must never do, because the alternate screen destroys the
 * scrollback the target's UI keeps. The renderer therefore drops every escape
 * sequence and every control character except the line feed and the tab.
 *
 * The stripper is a **scanner** and not a set of regular expressions: an
 * escape sequence's payload is defined by its terminator, and a regex that
 * guesses the terminator gets it wrong on exactly the inputs that matter.
 */
export function stripControlSequences(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      // `skipEscapeSequence` returns the index of the sequence's **last**
      // character, so the loop has to step past it.
      index = skipEscapeSequence(text, index) + 1;
      continue;
    }
    // The line feed and the tab survive; every other C0 control character and
    // every C1 control character does not.
    if (code === 0x0a || code === 0x09) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

/**
 * Skip one escape sequence, and return the index of its last character.
 *
 * The forms that matter:
 *
 *   - `ESC [` … a final byte in `0x40`–`0x7e` — a **CSI** sequence;
 *   - `ESC ]` … `BEL` or `ESC \` — an **OSC** sequence;
 *   - `ESC P`, `ESC ^`, `ESC _`, `ESC X` … `ESC \` — the string sequences;
 *   - `ESC` followed by any other single byte — a two-byte sequence.
 */
function skipEscapeSequence(text: string, start: number): number {
  const next = text[start + 1];
  if (next === undefined) return start;

  if (next === '[') {
    let index = start + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index;
      index += 1;
    }
    return text.length - 1;
  }

  if (next === ']' || next === 'P' || next === '^' || next === '_' || next === 'X') {
    let index = start + 2;
    while (index < text.length) {
      if (text.charCodeAt(index) === 0x07) return index;
      if (text.charCodeAt(index) === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 1;
      index += 1;
    }
    return text.length - 1;
  }

  return start + 1;
}

/* -------------------------------------------------------------------------- */
/* The renderers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Render a prose segment.
 *
 * `markdansi` does the formatting. The renderer never throws: a formatter that
 * throws falls back to the **raw text**, because a fragment that cannot be
 * formatted must still be shown.
 */
function renderProse(content: string): string {
  if (content.trim() === '') return '';
  try {
    return renderMarkdansi(content, {
      width: MARKDOWN_WIDTH,
      wrap: false,
      color: false,
      hyperlinks: false,
    });
  } catch {
    return content;
  }
}

/**
 * Render a fenced code block.
 *
 * The **language** is shown on a label line, and the code is shown verbatim.
 * The code never reaches a markdown parser, so it cannot break out of its
 * fence.
 */
function renderCodeBlock(language: string | undefined, content: string): string {
  const label = language === undefined || language === '' ? '' : `[${language}]\n`;
  const body = content.replace(/\n+$/, '');
  if (label === '' && body === '') return '';
  return `${label}${body}`;
}

/* -------------------------------------------------------------------------- */
/* The entry point                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Render markdown for the terminal.
 *
 * The function is **pure**: it reads no clock, touches no terminal and touches
 * no filesystem. It never throws, and it never drops a fragment — a
 * partially-streamed fragment is rendered as text.
 *
 * The rendered prose carries **no ANSI**: the colours are the UI's business,
 * and a renderer that emitted its own colours would fight with them.
 *
 * **Implementation choice**: the shape of a rendered code block, the `[ts]` label, the
 * width the prose is laid out at, and the stripping of control sequences. The
 * audit pins none of them.
 */
export function renderMarkdown(md: string): string {
  if (typeof md !== 'string' || md === '') return '';
  const source = stripControlSequences(md);
  if (source.trim() === '') return '';

  const parts: string[] = [];
  for (const part of segment(source)) {
    const rendered =
      part.kind === 'code'
        ? renderCodeBlock(part.language, part.content)
        : renderProse(part.content).trim();
    if (rendered === '') continue;
    parts.push(rendered);
  }
  return parts.join('\n\n');
}
