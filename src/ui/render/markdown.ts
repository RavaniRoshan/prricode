/**
 * The markdown renderer.
 *
 * Evidence: the `CC-022` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`,
 * and the specification it names —
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-terminal-ui.md` §10
 * ("Markdown rendering").
 *
 * ## What this module is
 *
 * The target renders a model's text as **markdown**, with its own rules
 * (§10.1). The clone renders it with the same rules, and the rules are the
 * contract:
 *
 *   - a **heading** is bold, and an H1 is bold **and** italic **and**
 *     underlined; the `#` markers are not shown;
 *   - an **unlabelled** fenced block is rendered **entirely in the
 *     `permission` colour**, with no header at all;
 *   - a **labelled** fenced block carries its language name — dimmed — above
 *     the body;
 *   - **inline code** is in the `permission` colour;
 *   - a **list item** is marked `-` (unordered) or `N.` (ordered), and a task
 *     item carries the prefix `[x] ` or `[ ] `;
 *   - a **table** is rendered as a markdown table, not as a box;
 *   - a **blockquote** is italic, behind a `│` rule;
 *   - a **thematic break** is `---`;
 *   - **struck-through** text is literal `~~text~~` when the terminal cannot
 *     strike it.
 *
 * ## The renderer produces segments, not strings
 *
 * A renderer that emitted coloured strings would have to decide the colour
 * itself, and the colour belongs to the **theme**: the target's `qn(role,
 * theme)` is called by the component that draws the text. So the renderer
 * produces **segments** — a text and the **role** it is drawn in — and the
 * app resolves the role when it draws.
 *
 * `renderMarkdown` is the plain-text projection of the same renderer, so the
 * two cannot disagree: the plan's contract (`renderMarkdown(md): string`) and
 * the shipped view are the same rendering.
 *
 * ## A partially-streamed fragment must render
 *
 * A turn's text arrives in pieces, so the renderer is handed fragments that
 * are **not valid markdown yet**: an unterminated emphasis marker, an
 * unterminated fenced code block, a half-written table row. The renderer must
 * **render** such a fragment — not throw, and not drop it — because dropping a
 * fragment loses text the user is watching arrive.
 *
 * The tolerance is **explicit** here, in three places:
 *
 *   - an **unterminated fence** is treated as a code block that runs to the end
 *     of the fragment (the CommonMark rule), so the code is shown as code;
 *   - the renderer never returns `undefined` and never throws: it always
 *     returns a string, and the string always contains the fragment's text;
 *   - a renderer that throws falls back to the **raw text** rather than losing
 *     the fragment.
 *
 * ## The shared stripper
 *
 * The stripper lives **here**, and it is exported, because this module owns the
 * question *"what may a model's text contain on its way to a terminal?"* — and
 * because the answer must be the **same** answer everywhere. The markdown
 * renderer is only one of the paths a model-controlled string takes: a tool
 * **result**, a tool **input summary**, an **approval prompt**, an **ARIA
 * label** and the **input echo** reach the terminal too, and a protection that
 * lives in one path is a protection that a caller can route around. The
 * message renderer, the prompt renderer and the app therefore import this
 * **one** function, so there is exactly one scanner and exactly one set of
 * rules.
 *
 * ## What is observed and what is a implementation choice
 *
 * The markdown **rules** are the target's (§10.1, every row of it carries the
 * target's own file and byte offset). Three things are **not** established,
 * and they are labelled where they are made:
 *
 *   - the **syntax highlighter**: the target highlights a fenced block whose
 *     language it supports; the clone has no highlighter, so a block's body
 *     is verbatim and its language name is always dimmed above it;
 *   - the **hyperlink**: the target emits a terminal hyperlink (an OSC 8
 *     sequence) for a link whose scheme it supports; the clone carries the
 *     URL in the segment and does **not** emit the sequence, so nothing it
 *     draws can carry an escape sequence;
 *   - the **list indent**: the target indents a nested item; the clone indents
 *     by two columns per level.
 */

import { render as renderMarkdansi } from 'markdansi';

import type { Segment } from '../theme.js';

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

/**
 * The colour an unlabelled code block and an inline code span are drawn in.
 *
 * The target's `qn("permission", t)` (§10.1, the code-block and inline-code
 * rows).
 */
export const CODE_ROLE = 'permission';

/** The theme role a heading is drawn in — the target draws headings in the text colour. */
export const HEADING_ROLE = 'text';

/* -------------------------------------------------------------------------- */
/* The source scanner                                                          */
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
 * The **OSC** sequences have to go as well, and they cannot be left to the
 * terminal: Ink's own sanitiser (`ink/build/sanitize-ansi.js`) strips the CSI
 * sequences but **preserves** the OSC ones, so an OSC that reached Ink — in a
 * cell, in a screen-reader label, in any text node — would go on to the
 * terminal verbatim. `ESC ] 52 ; … BEL` puts text on the clipboard and
 * `ESC ] 0 ; … BEL` retitles the window. Nothing here is left for Ink to
 * decide.
 *
 * The stripper is a **scanner** and not a set of regular expressions: an
 * escape sequence's payload is defined by its terminator, and a regex that
 * guesses the terminator gets it wrong on exactly the inputs that matter.
 *
 * The stripper is the **shared** one: the message renderer, the prompt renderer
 * and the app import it from here, so a tool result, a tool summary, an
 * approval prompt, an ARIA label and a typed line are all protected by the
 * same rules.
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
    if (code >= 0x80 && code <= 0x9f) {
      // A C1 control character can be an **introducer** as well. Dropping only
      // the introducer would leave the sequence's **parameters** visible as
      // ordinary text (`a\u009b2Jb` would read `a2Jb`), so the whole sequence goes.
      const skipped = skipC1Sequence(text, index);
      if (skipped !== undefined) {
        index = skipped + 1;
        continue;
      }
      index += 1;
      continue;
    }
    // The line feed and the tab survive; every other C0 control character does
    // not.
    if (code === 0x0a || code === 0x09) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      index += 1;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

/**
 * Skip one C1 control sequence, and return the index of its last character.
 *
 * The C1 controls are the **8-bit** forms of the escape sequences: 0x9b is the
 * CSI, 0x9d the OSC, 0x90 the DCS, 0x98 the SOS, 0x9e the PM and 0x9f the
 * APC. A terminal that accepts them acts on their payload exactly as it acts
 * on the 7-bit form, so the payload is dropped with the introducer.
 *
 * A C1 control that is **not** an introducer is dropped on its own, and
 * `undefined` says so.
 */
function skipC1Sequence(text: string, start: number): number | undefined {
  const code = text.charCodeAt(start);

  if (code === 0x9b) {
    // The CSI: parameters, then a final byte in 0x40–0x7e.
    let index = start + 1;
    while (index < text.length) {
      const final = text.charCodeAt(index);
      if (final >= 0x40 && final <= 0x7e) return index;
      index += 1;
    }
    return text.length - 1;
  }

  if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
    // The string sequences: a string, terminated by BEL or ST.
    return skipStringPayload(text, start + 1);
  }

  return undefined;
}

/**
 * Skip a string sequence's payload, and return the index of its last
 * character.
 *
 * The terminator is the bell (`BEL`) or the string terminator (`ST`), which
 * is either the 8-bit `0x9c` or the 7-bit `ESC \`.
 */
function skipStringPayload(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x07) return index;
    if (code === 0x9c) return index;
    if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 1;
    index += 1;
  }
  return text.length - 1;
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
/* The terminal's capabilities                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether the terminal can strike text through.
 *
 * The target's `TSn()` (§10.1, the emphasis row): struck-through text is off
 * on `TERM=linux` and on Apple Terminal, and the target then shows the
 * literal `~~text~~`.
 */
export function supportsStrikethrough(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['TERM'] === 'linux') return false;
  if (env['TERM_PROGRAM'] === 'Apple_Terminal') return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* The block model                                                             */
/* -------------------------------------------------------------------------- */

/** A block of markdown. */
type Block =
  | { kind: 'code'; language: string | undefined; content: string; indented: boolean }
  | { kind: 'heading'; depth: number; text: string }
  | { kind: 'break' }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'paragraph'; text: string };

/** One item of a list. */
interface ListItem {
  /** The marker the item is drawn with: `-` or `N.`. */
  readonly marker: string;
  /** Whether the item is a task, and whether it is done. */
  readonly task: boolean | undefined;
  /** Whether the task is done. */
  readonly checked: boolean;
  /** The item's own blocks. */
  readonly blocks: Block[];
}

/** The opening of a fenced code block. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/;

/** The closing of a fenced code block. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** An ATX heading. */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

/** A thematic break. */
const THEMATIC_BREAK = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/** A list item's marker. */
const LIST_MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

/** A blockquote's marker. */
const QUOTE_MARKER = /^ {0,3}>[ ]?(.*)$/;

/** A task item's checkbox. */
const TASK_MARKER = /^\[([ xX])\][ \t]+/;

/**
 * Parse a source into blocks.
 *
 * The parser is **line-based** and **tolerant**: a line it does not recognise
 * is prose, and a construct it cannot close (a fence, a quote) runs to the end
 * of the fragment.
 */
function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      index += 1;
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // An indented code block: four spaces of indentation.
    if (/^ {4}/.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate === undefined) break;
        if (candidate.trim() === '') {
          body.push('');
          index += 1;
          continue;
        }
        if (!/^ {4}/.test(candidate)) break;
        body.push(candidate.slice(4));
        index += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      blocks.push({ kind: 'code', language: undefined, content: body.join('\n'), indented: true });
      continue;
    }

    // A fenced code block.
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const markers = fence[1] ?? '';
      const info = (fence[2] ?? '').trim();
      const marker = markers[0] ?? '`';
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate === undefined) break;
        const close = FENCE_CLOSE.exec(candidate);
        if (close !== null) {
          const closing = close[1] ?? '';
          if (closing[0] === marker && closing.length >= markers.length) {
            index += 1;
            break;
          }
        }
        body.push(candidate);
        index += 1;
      }
      blocks.push({
        kind: 'code',
        language: info === '' ? undefined : info.split(/\s+/)[0],
        content: body.join('\n'),
        indented: false,
      });
      continue;
    }

    // A heading.
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const marks = heading[1] ?? '#';
      blocks.push({ kind: 'heading', depth: marks.length, text: heading[2] ?? '' });
      index += 1;
      continue;
    }

    // A thematic break.
    if (THEMATIC_BREAK.test(line)) {
      blocks.push({ kind: 'break' });
      index += 1;
      continue;
    }

    // A blockquote.
    const quote = QUOTE_MARKER.exec(line);
    if (quote !== null) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate === undefined) break;
        const marker = QUOTE_MARKER.exec(candidate);
        if (marker === null) {
          // A lazy continuation: a line that is not a marker still belongs to
          // the quote.
          if (candidate.trim() === '') break;
          quoted.push(candidate);
          index += 1;
          continue;
        }
        quoted.push(marker[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(quoted) });
      continue;
    }

    // A table: a row with a pipe, and a separator row under it.
    if (line.includes('|') && index + 1 < lines.length) {
      const separator = lines[index + 1];
      if (separator !== undefined && isTableSeparator(separator)) {
        const header = splitTableRow(line);
        const rows: string[][] = [];
        index += 2;
        while (index < lines.length) {
          const candidate = lines[index];
          if (candidate === undefined) break;
          if (candidate.trim() === '') break;
          if (!candidate.includes('|')) break;
          rows.push(splitTableRow(candidate));
          index += 1;
        }
        blocks.push({ kind: 'table', header, rows });
        continue;
      }
    }

    // A list.
    if (LIST_MARKER.test(line)) {
      const parsed = parseList(lines, index);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }

    // A paragraph: everything up to a blank line or a new construct.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index];
      if (candidate === undefined) break;
      if (candidate.trim() === '') break;
      if (paragraph.length > 0 && startsNewBlock(candidate)) break;
      paragraph.push(candidate);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

/**
 * Whether a line starts a construct that ends a paragraph.
 */
function startsNewBlock(line: string): boolean {
  if (HEADING.test(line)) return true;
  if (THEMATIC_BREAK.test(line)) return true;
  if (FENCE_OPEN.test(line)) return true;
  if (QUOTE_MARKER.test(line)) return true;
  if (LIST_MARKER.test(line)) return true;
  return false;
}

/**
 * Whether a line is a table's separator row.
 */
function isTableSeparator(line: string): boolean {
  if (!line.includes('|') && !line.includes('-')) return false;
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return false;
  }
  return true;
}

/**
 * The cells of a table row.
 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

/**
 * Parse a list, and return the index of the first line after it.
 */
function parseList(lines: readonly string[], start: number): { block: Block; next: number } {
  const items: ListItem[] = [];
  let index = start;
  let ordered = false;
  let number = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    const marker = LIST_MARKER.exec(line);
    if (marker === null) {
      // A blank line ends the list unless the next line continues an item.
      if (line.trim() === '') {
        const next = lines[index + 1];
        if (next === undefined || LIST_MARKER.test(next) === false) break;
        index += 1;
        continue;
      }
      break;
    }

    const indent = marker[1] ?? '';
    const symbol = marker[2] ?? '-';
    const rest = marker[3] ?? '';
    const isOrdered = /\d/.test(symbol);
    if (items.length === 0) ordered = isOrdered;
    number += 1;

    // The item's content: the first line, then the lines that are indented
    // under it.
    const content: string[] = [rest];
    const contentIndent = indent.length + symbol.length + 1;
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index];
      if (candidate === undefined) break;
      if (candidate.trim() === '') {
        const next = lines[index + 1];
        if (next === undefined) break;
        if (next.trim() === '') break;
        if (!/^[ \t]/.test(next)) break;
        content.push('');
        index += 1;
        continue;
      }
      if (LIST_MARKER.test(candidate) && candidate.search(/\S/) <= contentIndent) break;
      content.push(stripIndent(candidate, contentIndent));
      index += 1;
    }

    let task: boolean | undefined;
    let checked = false;
    const taskMarker = TASK_MARKER.exec(content[0] ?? '');
    if (taskMarker !== null) {
      task = true;
      checked = (taskMarker[1] ?? ' ').toLowerCase() === 'x';
      content[0] = (content[0] ?? '').slice(taskMarker[0].length);
    }

    items.push({
      marker: isOrdered ? `${number}.` : '-',
      task,
      checked,
      blocks: parseBlocks(content),
    });
  }

  return { block: { kind: 'list', items }, next: index };
}

/**
 * Remove up to `width` columns of indentation.
 */
function stripIndent(line: string, width: number): string {
  let removed = 0;
  let index = 0;
  while (index < line.length && removed < width) {
    const character = line[index];
    if (character === ' ') {
      removed += 1;
      index += 1;
      continue;
    }
    if (character === '\t') {
      removed += 4;
      index += 1;
      continue;
    }
    break;
  }
  return line.slice(index);
}

/* -------------------------------------------------------------------------- */
/* The inline model                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Render the inline content of a block.
 *
 * The rules are the target's (§10.1): inline code is in the `permission`
 * colour, strong text is bold, emphasised text is italic, struck-through text
 * is struck through **or** the literal `~~text~~` when the terminal cannot
 * strike it, a link carries its URL and its title, an image is its alt text
 * and its URL, raw HTML is emitted verbatim, and an escaped character is
 * emitted as itself.
 */
function renderInline(text: string, env: NodeJS.ProcessEnv): Segment[] {
  const segments: Segment[] = [];
  let plain = '';
  let index = 0;

  const flush = (): void => {
    if (plain === '') return;
    segments.push({ text: plain });
    plain = '';
  };

  while (index < text.length) {
    const character = text[index] ?? '';

    // An escape: the next character is itself.
    if (character === '\\' && index + 1 < text.length) {
      plain += text[index + 1] ?? '';
      index += 2;
      continue;
    }

    // A code span.
    if (character === '`') {
      const fence = countRun(text, index, '`');
      const close = findRun(text, index + fence, '`', fence);
      if (close !== undefined) {
        flush();
        segments.push({ text: text.slice(index + fence, close), role: CODE_ROLE });
        index = close + fence;
        continue;
      }
    }

    // An image.
    if (character === '!' && text[index + 1] === '[') {
      const link = parseLink(text, index + 1);
      if (link !== undefined) {
        flush();
        segments.push({ text: imageText(link), role: HEADING_ROLE });
        index = link.end;
        continue;
      }
    }

    // A link.
    if (character === '[') {
      const link = parseLink(text, index);
      if (link !== undefined) {
        flush();
        const label = renderInline(link.label, env);
        const first = label[0];
        if (first !== undefined) label[0] = { ...first, link: link.href };
        segments.push(...label);
        if (link.title !== undefined) {
          segments.push({ text: ` ("${link.title}")` });
        }
        index = link.end;
        continue;
      }
    }

    // Struck-through text.
    if (character === '~' && text[index + 1] === '~') {
      const close = text.indexOf('~~', index + 2);
      if (close !== -1) {
        const inner = text.slice(index + 2, close);
        flush();
        if (supportsStrikethrough(env)) {
          for (const segment of renderInline(inner, env)) {
            segments.push({ ...segment, strike: true });
          }
        } else {
          segments.push({ text: `~~${inner}~~` });
        }
        index = close + 2;
        continue;
      }
    }

    // Strong text.
    if ((character === '*' || character === '_') && text[index + 1] === character) {
      const marker = character.repeat(2);
      const close = text.indexOf(marker, index + 2);
      if (close !== -1) {
        flush();
        for (const segment of renderInline(text.slice(index + 2, close), env)) {
          segments.push({ ...segment, bold: true });
        }
        index = close + 2;
        continue;
      }
    }

    // Emphasised text.
    if (character === '*' || character === '_') {
      const close = text.indexOf(character, index + 1);
      if (close !== -1 && close > index + 1) {
        flush();
        for (const segment of renderInline(text.slice(index + 1, close), env)) {
          segments.push({ ...segment, italic: true });
        }
        index = close + 1;
        continue;
      }
    }

    // Raw HTML: emitted verbatim.
    if (character === '<') {
      const close = text.indexOf('>', index);
      if (close !== -1) {
        flush();
        segments.push({ text: text.slice(index, close + 1) });
        index = close + 1;
        continue;
      }
    }

    plain += character;
    index += 1;
  }

  flush();
  return segments;
}

/**
 * The number of times a character repeats at a position.
 */
function countRun(text: string, start: number, character: string): number {
  let count = 0;
  while (text[start + count] === character) count += 1;
  return count;
}

/**
 * The index of a run of `length` characters, at or after `start`.
 */
function findRun(text: string, start: number, character: string, length: number): number | undefined {
  let index = start;
  while (index < text.length) {
    if (text[index] === character && countRun(text, index, character) >= length) return index;
    index += 1;
  }
  return undefined;
}

/** A parsed link or image. */
interface ParsedLink {
  /** The link's label. */
  readonly label: string;
  /** The URL the link points at. */
  readonly href: string;
  /** The link's title, when it has one. */
  readonly title: string | undefined;
  /** The index after the link. */
  readonly end: number;
}

/**
 * Parse a `[label](url "title")` at a position.
 *
 * `undefined` when the text is not a link — a half-written one is prose.
 */
function parseLink(text: string, start: number): ParsedLink | undefined {
  if (text[start] !== '[') return undefined;
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '[') depth += 1;
    if (character === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
    index += 1;
  }
  if (depth !== 0 || index >= text.length) return undefined;
  if (text[index + 1] !== '(') return undefined;

  const label = text.slice(start + 1, index);
  const close = text.indexOf(')', index + 2);
  if (close === -1) return undefined;

  const destination = text.slice(index + 2, close).trim();
  const titleMatch = /^(.*?)[ \t]+"([^"]*)"[ \t]*$/.exec(destination);
  const href = titleMatch === null ? destination : (titleMatch[1] ?? '').trim();
  const title = titleMatch === null ? undefined : titleMatch[2];

  return { label, href, title, end: close + 1 };
}

/**
 * The text an image is drawn with.
 *
 * The target's rule (§10.1, the image row): an image with no alt text and no
 * title is drawn as its URL; with alt text it is drawn `alt (url)`; with a
 * title it is drawn `alt (url "title")`.
 */
function imageText(link: ParsedLink): string {
  const alt = link.label.trim();
  if (alt === '' && link.title === undefined) return link.href;
  if (link.title === undefined) return `${alt} (${link.href})`;
  return `${alt} (${link.href} "${link.title}")`;
}

/* -------------------------------------------------------------------------- */
/* The renderers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Render a block into segments.
 */
function renderBlock(block: Block, env: NodeJS.ProcessEnv, depth: number): Segment[] {
  switch (block.kind) {
    case 'code':
      return renderCode(block.language, block.content, block.indented);
    case 'heading': {
      const segments = renderInline(block.text, env);
      return block.depth === 1
        ? segments.map((segment) => ({ ...segment, bold: true, italic: true, underline: true }))
        : segments.map((segment) => ({ ...segment, bold: true }));
    }
    case 'break':
      return [{ text: '---' }];
    case 'quote': {
      const segments: Segment[] = [];
      const inner = renderBlocks(block.blocks, env, depth + 1);
      const lines = segmentText(inner).split('\n');
      for (const line of lines) {
        segments.push({ text: `│ ${line}`, italic: true });
      }
      return segments;
    }
    case 'list': {
      const segments: Segment[] = [];
      for (const [position, item] of block.items.entries()) {
        if (position > 0) segments.push({ text: '\n' });
        const indent = '  '.repeat(depth);
        const prefix = item.task === true ? `[${item.checked ? 'x' : ' '}] ` : '';
        segments.push({ text: `${indent}${item.marker} ${prefix}` });
        segments.push(...renderBlocks(item.blocks, env, depth + 1));
      }
      return segments;
    }
    case 'table':
      return renderTable(block.header, block.rows);
    case 'paragraph':
    default:
      return renderInline(block.text, env);
  }
}

/**
 * Render a fenced code block.
 *
 * The target's rule (§10.1, the code-block row): an **unlabelled** fence is
 * rendered entirely in the `permission` colour, with no header. A labelled
 * fence carries its language name — dimmed — above the body.
 *
 * **Implementation choice.** The target highlights the body of a block whose
 * language its highlighter supports. The clone has **no** highlighter, so the
 * body is verbatim and the language name is always shown.
 */
function renderCode(
  language: string | undefined,
  content: string,
  indented: boolean,
): Segment[] {
  const body = content.replace(/\n+$/, '');
  if (language === undefined && !indented) {
    return body === '' ? [] : [{ text: body, role: CODE_ROLE }];
  }
  const segments: Segment[] = [];
  if (language !== undefined) segments.push({ text: language, dim: true });
  if (body !== '') {
    if (segments.length > 0) segments.push({ text: '\n' });
    segments.push({ text: body });
  }
  return segments;
}

/**
 * Render a table as a markdown table.
 *
 * The target's rule (§10.1, the table row): the header row is `| h1 | h2 |`,
 * the separator is a run of dashes per column, and the body rows follow. A
 * column is as wide as its widest cell, and never narrower than three.
 */
function renderTable(header: readonly string[], rows: readonly string[][]): Segment[] {
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 0);
  const widths: number[] = [];
  for (let column = 0; column < columns; column += 1) {
    let width = 3;
    width = Math.max(width, (header[column] ?? '').length);
    for (const row of rows) width = Math.max(width, (row[column] ?? '').length);
    widths.push(width);
  }

  const line = (cells: readonly string[]): string => {
    const parts: string[] = [];
    for (let column = 0; column < columns; column += 1) {
      parts.push((cells[column] ?? '').padEnd(widths[column] ?? 3));
    }
    return `| ${parts.join(' | ')} |`;
  };

  const separator = `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`;

  const segments: Segment[] = [];
  segments.push({ text: line(header) });
  segments.push({ text: `\n${separator}\n` });
  for (const row of rows) {
    segments.push({ text: line(row) });
    segments.push({ text: '\n' });
  }
  // The trailing newline of the last row is the block separator's business.
  const last = segments[segments.length - 1];
  if (last !== undefined && last.text.endsWith('\n')) {
    segments[segments.length - 1] = { ...last, text: last.text.slice(0, -1) };
  }
  return segments;
}

/**
 * Render a list of blocks, separated by a blank line.
 */
function renderBlocks(blocks: readonly Block[], env: NodeJS.ProcessEnv, depth: number): Segment[] {
  const segments: Segment[] = [];
  for (const block of blocks) {
    if (segments.length > 0) segments.push({ text: '\n\n' });
    segments.push(...renderBlock(block, env, depth));
  }
  return segments;
}

/**
 * The text of a list of segments.
 */
function segmentText(segments: readonly Segment[]): string {
  let out = '';
  for (const segment of segments) out += segment.text;
  return out;
}

/* -------------------------------------------------------------------------- */
/* The entry points                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Render markdown into segments.
 *
 * The function is **pure**: it reads no clock, touches no terminal and touches
 * no filesystem. It never throws, and it never drops a fragment — a
 * partially-streamed fragment is rendered as text.
 *
 * The rendered prose carries **no ANSI**: the colours are the theme's
 * business, and a renderer that emitted its own colours would fight with
 * them.
 */
export function renderMarkdownSegments(
  md: string,
  env: NodeJS.ProcessEnv = process.env,
): Segment[] {
  if (typeof md !== 'string' || md === '') return [];
  const source = stripControlSequences(md);
  if (source.trim() === '') return [];

  try {
    return renderBlocks(parseBlocks(source.split('\n')), env, 0);
  } catch {
    // A fragment that cannot be parsed is shown as text: a fragment that
    // cannot be formatted must still be shown. `markdansi` is the plan's
    // markdown library, and it is the fallback formatter.
    return [{ text: renderFallback(source) }];
  }
}

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
 * This is the **plain-text projection** of `renderMarkdownSegments`: the same
 * rendering, without the roles.
 */
export function renderMarkdown(md: string, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof md !== 'string' || md === '') return '';
  if (stripControlSequences(md).trim() === '') return '';
  return segmentText(renderMarkdownSegments(md, env));
}

/**
 * The fallback rendering: the raw text, formatted by `markdansi`.
 *
 * The fallback exists for one reason: a fragment that cannot be rendered must
 * still be **shown**. `markdansi` is the plan's markdown library, and it is
 * used here for the text the segment renderer could not produce.
 */
function renderFallback(md: string): string {
  try {
    return renderMarkdansi(stripControlSequences(md), {
      width: MARKDOWN_WIDTH,
      wrap: false,
      color: false,
      hyperlinks: false,
    });
  } catch {
    return stripControlSequences(md);
  }
}
