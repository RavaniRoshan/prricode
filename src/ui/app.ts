/**
 * The interactive terminal UI.
 *
 * Evidence: the `CC-022` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`,
 * and the specification it names —
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-terminal-ui.md` §2
 * ("The composer"), §4 ("The approval prompt"), §5 ("The spinner and the
 * status line"), §9 ("Keybindings") and §12 ("Behaviours that are observable
 * but not visual").
 *
 * ## What this module is
 *
 * The **shell**: the Ink application that shows the conversation, the input
 * line and the approval prompt, and that mounts with the options the target's
 * behaviour requires.
 *
 * The UI is a **renderer over the runtime**, not a second implementation. The
 * rendering lives in `src/ui/render/*` and is **pure**; this module wires those
 * renderers to Ink, and owns nothing but the wiring.
 *
 * ## The surfaces are the target's surfaces
 *
 *   - the **composer** is a box with a **top rule only**, in the `promptBorder`
 *     role, holding the prompt glyph and the input (§2.1, §2.2);
 *   - the **placeholder** is `Try "<a suggestion>"`, dimmed, with its first
 *     character inverted — the cursor — while the field has the focus (§2.3);
 *   - the **hint line** under the composer is dim, and its parts are joined
 *     with `" · "` (§2.4);
 *   - the **approval dialog** is a rule in the `permission` colour above a
 *     column, with the title, the question, the options and the input guide
 *     (§4.1);
 *   - the **status line** carries the target's spinner and its gutter arrow
 *     (§5.1, §5.2);
 *   - the **keybindings** are the target's table, with the target's platform
 *     deltas (§9.1, §9.2).
 *
 * ## The three things the plan fixes
 *
 * ### 1. The app does not enter the alternate screen
 *
 * The target's CLI is a **scrollback-append** TUI: the content that was on the
 * terminal before the session started stays in the terminal's scrollback, and
 * `/clear`, the terminal's own search and the scroll wheel all keep working.
 * Ink's alternate-screen mode takes all of that away — the alternate screen
 * **has no scrollback** — so this implementation never enters it.
 *
 * `appRenderOptions` therefore sets `alternateScreen: false` **explicitly**,
 * rather than leaving it to the default: the default can change, and the
 * behaviour cannot.
 *
 * ### 2. The frame rate is tuned for a streaming turn
 *
 * Ink's default is 30 frames per second and `incrementalRendering` is off, so
 * a streaming turn re-renders the **whole** frame thirty times a second. With
 * `incrementalRendering` on, only the lines that changed are rewritten, so the
 * implementation can afford a higher frame rate: a token that has just arrived is on
 * the screen within half the time, and the cost is a fraction of a frame.
 *
 * ### 3. The screen-reader tree names its regions
 *
 * Ink's screen-reader support is an ARIA **subset**: a node can carry a role
 * and a label, and Ink renders the tree as a linear announcement. This implementation
 * uses it for the three regions a screen-reader user navigates: the **message
 * list**, the **input**, and the **approval prompt**.
 *
 * **Ink replaces a labelled node's content with its label** when the screen
 * reader is enabled, so a region that carries its own label would lose its
 * content — the whole conversation would be announced as the word
 * "Conversation". This implementation therefore renders each region's **content beside**
 * the labelled node rather than inside it: the label is announced
 * (`list: Conversation`), and the content is announced with it.
 *
 * The **choices** of the approval prompt are **options**: a screen reader that
 * hears "listbox: Approval required for Bash" and then a paragraph does not
 * hear three answers, so each choice is its own `option` node.
 *
 * ## The two keys that need a gesture
 *
 * The target never says "press enter to continue". It says what the key does
 * (§12.3):
 *
 *   - `Esc again to clear` — the first escape arms the gesture, the second
 *     clears the line;
 *   - `Press ctrl+c again to exit` — the first `ctrl+c` arms the gesture, the
 *     second ends the session.
 *
 * Both are **toasts**: a transient line under the hint line. `ctrl+c` is
 * therefore **not** Ink's own exit key — `exitOnCtrlC` is off, and the app
 * handles the chord itself, because the target's chord is a two-press gesture
 * and not an immediate exit.
 *
 * ## What is observed and what is a implementation choice
 *
 * The audit records the target's **input and output formats** and the fact that
 * a headless run is forced by a non-TTY stdout. It records nothing about how
 * an interactive terminal draws a conversation, so the ARIA labels of the
 * **regions**, the region roles and the frame rate are **implementation choices**,
 * and they are marked as such below. Everything the specification establishes —
 * the markers, the strings, the colours, the chords and the two gestures — is
 * the target's.
 */

import { createElement, Fragment, useEffect, useState, type ReactNode } from 'react';

import { Box, Text, render, useApp, useInput, type Instance, type RenderOptions } from 'ink';

import type { PermissionDecision } from '../permissions/decision.js';
import type { SessionEvent } from '../session/event.js';
import { targetFlag } from '../config/environment.js';

import { stripControlSequences } from './render/markdown.js';
import { renderTranscript, type TranscriptRow } from './render/messages.js';
import {
  APPROVAL_CHOICES,
  approvalPromptParts,
  optionSegments,
  type ApprovalChoice,
  type ApprovalChoiceView,
} from './render/prompts.js';
import {
  DARK_THEME,
  glyphs,
  platformOf,
  roleColor,
  spinnerFrame,
  SPINNER_FRAMES,
  type Segment,
} from './theme.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The ARIA roles this implementation's regions use.
 *
 * They are a subset of the roles Ink supports, and they are the roles that
 * match what the regions **are**: a list of messages, a list of messages'
 * items, a list of choices, and a line of text the user types into.
 *
 * **Implementation choice.** The target's regions were not established; the
 * target labels its **gutters** instead (`you:`, `prricode:`, `tool:`,
 * `thinking:`), and the clone does that too.
 */
export type AriaRole = 'list' | 'listitem' | 'listbox' | 'option' | 'textbox';

/**
 * The labels of the three regions.
 *
 * **Implementation choice.** The audit records no accessibility surface for the target,
 * so these are this implementation's own. They are the words a screen reader announces
 * when the user arrives at a region, and they are what the screen-reader test
 * pins.
 */
export const ARIA_LABELS = {
  /** The conversation. */
  messageList: 'Conversation',
  /** The line the user types into. */
  input: 'Message input',
} as const;

/**
 * The label of the approval prompt.
 *
 * **Implementation choice**, like the labels above. The tool is named, because the
 * question is about that tool.
 *
 * The name is **stripped** of its control sequences, and it has to be: Ink
 * renders an `aria-label` into the screen-reader tree through its own
 * sanitiser, and that sanitiser **preserves** OSC sequences (it strips the
 * CSI ones and keeps the OSC ones). A label that carried an OSC would
 * therefore put it on the terminal **verbatim** — the one path where the
 * implementation's own stripper is not the last word. Every other string the app
 * shows is stripped, and so is this one.
 */
export function approvalLabel(toolName: string): string {
  const name = stripControlSequences(toolName);
  return `Approval required for ${name === '' ? 'the tool' : name}`;
}

/* -------------------------------------------------------------------------- */
/* The composer                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The composer's mode.
 *
 * The target has two: the prompt and the shell (`!` at the start of an empty
 * prompt switches to it, §12.8).
 */
export type ComposerMode = 'prompt' | 'bash';

/**
 * The glyph in front of the input.
 *
 * The target's §2.1: `❯` (and a non-breaking space) in the prompt's colour,
 * and `!` in the `bashBorder` colour in shell mode.
 */
export function composerGlyph(
  mode: ComposerMode = 'prompt',
  env: NodeJS.ProcessEnv = process.env,
  loading = false,
): Segment {
  if (mode === 'bash') return { text: '!\u00A0', role: 'bashBorder', dim: loading ? true : undefined };
  return { text: `${glyphs(env).pointer}\u00A0`, role: 'promptBorder', dim: loading ? true : undefined };
}

/**
 * The suggestions the placeholder offers.
 *
 * The target's §2.3 (`chunk-081t8575.js:82938`): eight of them, one of which
 * names an example file from the project. The clone has no example-file
 * catalogue, so the file placeholder the target falls back to is used.
 */
export const PLACEHOLDER_SUGGESTIONS: readonly string[] = Object.freeze([
  'fix lint errors',
  'fix typecheck errors',
  'how does <\u200Bfilepath> work?',
  'refactor <\u200Bfilepath>',
  'how do I log an error?',
  'edit <\u200Bfilepath> to...',
  'write a test for <\u200Bfilepath>',
  'create a util logging.py that...',
]);

/**
 * The placeholder's text.
 *
 * The target's §2.3: `Try "<a suggestion>"`.
 *
 * **Implementation choice.** The target's suggestion index comes from a
 * counter the specification did not establish; the clone rotates the
 * suggestion once per submission.
 */
export function placeholderText(index = 0): string {
  const suggestion = PLACEHOLDER_SUGGESTIONS[index % PLACEHOLDER_SUGGESTIONS.length];
  return `Try "${suggestion ?? ''}"`;
}

/**
 * The placeholder's segments.
 *
 * The target's §2.3 (`chunk-0e53hjtk.js:7149`): the placeholder is dimmed,
 * and while the field has the focus its **first character is inverted** — that
 * is the cursor.
 */
export function composerPlaceholder(text: string): Segment[] {
  if (text === '') return [];
  const first = text.slice(0, 1);
  const rest = text.slice(1);
  const segments: Segment[] = [{ text: first, inverse: true }];
  if (rest !== '') segments.push({ text: rest, dim: true });
  return segments;
}

/* -------------------------------------------------------------------------- */
/* The hint line                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The state the hint line is built from.
 */
export interface HintState {
  /** Whether a call is waiting for the user's answer. */
  readonly approvalPending: boolean;
  /** Whether the composer is in shell mode. */
  readonly mode: ComposerMode;
}

/**
 * The parts of the hint line.
 *
 * The target's §2.4: the hint line is dim, and its parts are joined with
 * `" · "`.
 *
 * **Implementation choice.** The target's hint line carries many more parts —
 * the voice state, the artifact link, the retention lozenge — and none of them
 * has a producer in this implementation, so only the parts that do are shown.
 */
export function hintLineItems(state: HintState): string[] {
  const items: string[] = [];
  if (state.approvalPending) items.push('Waiting for permission…');
  if (state.mode === 'bash') items.push('! for shell mode');
  items.push('? for shortcuts');
  return items;
}

/**
 * The separator between the parts of the hint line.
 *
 * The target's §2.4: `" · "` (U+00B7).
 */
export const HINT_SEPARATOR = ' · ';

/* -------------------------------------------------------------------------- */
/* The shortcuts overlay                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The key names the target's chord formatter knows.
 *
 * The target's table (`chunk-ndtvw3xq.js:1822`), in the **lower** case the
 * overlay uses.
 */
export const KEY_NAMES: ReadonlyMap<string, string> = new Map<string, string>([
  ['enter', 'enter'],
  ['escape', 'esc'],
  ['tab', 'tab'],
  [' ', 'space'],
  ['backspace', 'backspace'],
  ['delete', 'delete'],
  ['up', '↑'],
  ['down', '↓'],
  ['left', '←'],
  ['right', '→'],
  ['pageup', 'pgup'],
  ['pagedown', 'pgdn'],
  ['home', 'home'],
  ['end', 'end'],
]);

/**
 * The format the overlay renders a chord in.
 *
 * The target's `Km` (`chunk-6bp7hdav.js:790154`): `{keyCase: "lower",
 * modSep: " + "}` — the modifiers are lower case and separated by a space and
 * a plus.
 */
export interface ChordFormat {
  /** The case the key's own name is rendered in. */
  readonly keyCase: 'lower' | 'title' | 'glyph';
  /** The separator between the modifiers and the key. */
  readonly modSep: string;
}

/** The overlay's chord format. */
export const OVERLAY_CHORD_FORMAT: ChordFormat = { keyCase: 'lower', modSep: ' + ' };

/**
 * A chord, as the overlay renders it.
 *
 * The target's formatter (`chunk-ndtvw3xq.js`): the modifiers, then the key's
 * own name, joined by the format's separator.
 */
export function formatChord(chord: string, format: ChordFormat = OVERLAY_CHORD_FORMAT): string {
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  const modifiers = parts.map((modifier) => modifier.toLowerCase());
  const name = KEY_NAMES.get(key) ?? key;
  return [...modifiers, name].join(format.modSep);
}

/**
 * The chord that pastes an image.
 *
 * The target's §9.2 (`chunk-26sqdasq.js:1500`): `alt+v` on Windows and WSL,
 * `ctrl+v` everywhere else.
 */
export function pasteChord(env: NodeJS.ProcessEnv = process.env): string {
  const platform = platformOf(env);
  return platform === 'windows' || platform === 'wsl' ? 'alt+v' : 'ctrl+v';
}

/**
 * The chord that cycles the permission mode.
 *
 * The target's §9.2: `shift+tab` on a recent install and `meta+m` on an old
 * one. The target's test for "a recent install" is a version comparison the
 * specification did not establish, so the clone uses `meta+m` on Windows and
 * `shift+tab` everywhere else.
 */
export function cycleModeChord(env: NodeJS.ProcessEnv = process.env): string {
  return platformOf(env) === 'windows' ? 'meta+m' : 'shift+tab';
}

/**
 * The lines of the `?` shortcuts overlay.
 *
 * The target's §2.5 (`chunk-6bp7hdav.js:790154`), in the target's order. Each
 * key hint is `<chord> to <action>`.
 */
export function shortcutOverlayLines(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    '! for shell mode',
    '/ for commands',
    '@ for file paths',
    '/btw for side question',
    'double tap esc to clear input',
    `${formatChord(cycleModeChord(env))} to auto-accept edits`,
    `${formatChord('ctrl+o')} to verbose output`,
    `${formatChord('ctrl+t')} to toggle tasks`,
    `${formatChord('ctrl+_')} to undo`,
    `${formatChord('ctrl+z')} to suspend`,
    `${formatChord(pasteChord(env))} to paste images`,
    `${formatChord('alt+p')} to switch model`,
    `${formatChord('alt+o')} to toggle fast mode`,
    `${formatChord('shift+tab')} to stash prompt`,
    `${formatChord('ctrl+g')} to edit in $EDITOR`,
    '/keybindings to customize',
  ];
}

/* -------------------------------------------------------------------------- */
/* The keybindings                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The target's keybindings.
 *
 * The table is the target's own (`chunk-26sqdasq.js:1696` and the contexts
 * around it), by context: the chord and the action it runs.
 *
 * The two platform-dependent chords are resolved when the table is read: the
 * paste chord (§9.2) and the cycle-mode chord (§9.2).
 */
export function keybindings(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const paste = pasteChord(env);
  const cycle = cycleModeChord(env);

  const global = new Map<string, string>([
    ['ctrl+c', 'app:interrupt'],
    ['ctrl+d', 'app:exit'],
    ['ctrl+t', 'app:toggleTodos'],
    ['ctrl+o', 'app:toggleTranscript'],
    ['ctrl+shift+b', 'app:toggleBrief'],
    ['ctrl+r', 'history:search'],
    ['ctrl+up', 'app:diffFileListUp'],
    ['ctrl+down', 'app:diffFileListDown'],
    ['meta+up', 'app:diffFileListUp'],
    ['meta+down', 'app:diffFileListDown'],
  ]);

  const chat = new Map<string, string>([
    ['escape', 'chat:cancel'],
    ['ctrl+l', 'chat:clearInput'],
    ['cmd+k', 'chat:clearScreen'],
    ['ctrl+x ctrl+k', 'chat:killAgents'],
    [cycle, 'chat:cycleMode'],
    ['meta+p', 'chat:modelPicker'],
    ['meta+o', 'chat:fastMode'],
    ['ctrl+y', 'chat:defaultToNewerModel'],
    ['meta+t', 'chat:thinkingToggle'],
    ['meta+w', 'chat:workflowKeywordToggle'],
    ['enter', 'chat:submit'],
    ['ctrl+x enter', 'chat:queueSubmit'],
    ['ctrl+x ctrl+s', 'chat:sendNow'],
    ['ctrl+enter', 'chat:sendNow'],
    ['ctrl+j', 'chat:newline'],
    ['up', 'history:previous'],
    ['down', 'history:next'],
    ['ctrl+_', 'chat:undo'],
    ['ctrl+-', 'chat:undo'],
    ['ctrl+shift+-', 'chat:undo'],
    ['ctrl+shift+_', 'chat:undo'],
    ['ctrl+x ctrl+e', 'chat:externalEditor'],
    ['ctrl+x ctrl+a', 'abovePrompt:toggle'],
    ['ctrl+x tab', 'abovePrompt:focus'],
    ['ctrl+g', 'chat:externalEditor'],
    ['ctrl+s', 'chat:stash'],
    [paste, 'chat:imagePaste'],
    ['space', 'voice:pushToTalk'],
  ]);

  const autocomplete = new Map<string, string>([
    ['tab', 'autocomplete:accept'],
    ['escape', 'autocomplete:dismiss'],
    ['up', 'autocomplete:previous'],
    ['down', 'autocomplete:next'],
  ]);

  const confirmation = new Map<string, string>([
    ['enter', 'confirm:yes'],
    ['escape', 'confirm:no'],
    ['up', 'confirm:previous'],
    ['down', 'confirm:next'],
    ['tab', 'confirm:nextField'],
    ['space', 'confirm:toggle'],
    [cycle, 'confirm:cycleMode'],
  ]);

  const select = new Map<string, string>([
    ['up', 'select:previous'],
    ['down', 'select:next'],
    ['j', 'select:next'],
    ['k', 'select:previous'],
    ['ctrl+n', 'select:next'],
    ['ctrl+p', 'select:previous'],
    ['pageup', 'select:pageUp'],
    ['pagedown', 'select:pageDown'],
    ['home', 'select:first'],
    ['end', 'select:last'],
    ['enter', 'select:accept'],
    ['escape', 'select:cancel'],
  ]);

  const transcript = new Map<string, string>([
    ['ctrl+e', 'transcript:toggleShowAll'],
    ['ctrl+c', 'transcript:exit'],
    ['escape', 'transcript:exit'],
    ['q', 'transcript:exit'],
    ['ctrl+u', 'scroll:halfPageUp'],
    ['ctrl+d', 'scroll:halfPageDown'],
    ['ctrl+b', 'scroll:fullPageUp'],
    ['ctrl+f', 'scroll:fullPageDown'],
    ['ctrl+n', 'scroll:lineDown'],
    ['ctrl+p', 'scroll:lineUp'],
    ['g', 'scroll:top'],
    ['shift+g', 'scroll:bottom'],
    ['j', 'scroll:lineDown'],
    ['k', 'scroll:lineUp'],
    ['space', 'scroll:fullPageDown'],
    ['b', 'scroll:fullPageUp'],
    ['up', 'scroll:lineUp'],
    ['down', 'scroll:lineDown'],
    ['home', 'scroll:top'],
    ['end', 'scroll:bottom'],
  ]);

  return new Map<string, ReadonlyMap<string, string>>([
    ['Global', global],
    ['Chat', chat],
    ['Autocomplete', autocomplete],
    ['Confirmation', confirmation],
    ['Select', select],
    ['Transcript', transcript],
  ]);
}

/* -------------------------------------------------------------------------- */
/* The gestures                                                                */
/* -------------------------------------------------------------------------- */

/** The toast the first escape shows. */
export const ESCAPE_AGAIN_MESSAGE = 'Esc again to clear';

/** The toast the first `ctrl+c` shows. */
export const INTERRUPT_AGAIN_MESSAGE = 'Press ctrl+c again to exit';

/* -------------------------------------------------------------------------- */
/* The options                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The frame rate a streaming turn runs at.
 *
 * **Implementation choice.** Ink's default is 30; with `incrementalRendering` on, only
 * the changed lines are rewritten, so 60 frames a second is affordable and
 * halves the delay between a token arriving and the token being on the
 * screen.
 */
export const STREAMING_MAX_FPS = 60;

/**
 * The options the app mounts with.
 *
 * The ones that matter are the ones the plan fixes:
 *
 *   - `alternateScreen: false` — this implementation keeps the terminal's scrollback;
 *   - `incrementalRendering: true` — a streaming turn rewrites only the lines
 *     that changed;
 *   - `maxFps` — the frame rate a streaming turn runs at;
 *   - `exitOnCtrlC: false` — the target's `ctrl+c` is a **two-press gesture**
 *     (§12.3), so the app has to see the chord itself.
 *
 * The screen-reader switch is read from `INK_SCREEN_READER`, the variable Ink
 * itself reads, and it is read **here**, at mount time, so a caller that sets
 * the variable before mounting gets what it asked for.
 */
export function appRenderOptions(): RenderOptions {
  return {
    alternateScreen: false,
    incrementalRendering: true,
    maxFps: STREAMING_MAX_FPS,
    exitOnCtrlC: false,
    // **Observed**: the target reads the screen-reader switch with its own
    // **boolean** rule — `Ne(process.env.INK_SCREEN_READER)` — so `1`, `true`,
    // `yes` and `on` turn it on and nothing else does.
    isScreenReaderEnabled: targetFlag(process.env['INK_SCREEN_READER']),
  };
}

/* -------------------------------------------------------------------------- */
/* The props                                                                   */
/* -------------------------------------------------------------------------- */

/** An approval the user is being asked about. */
export interface PendingApproval {
  /** The decision the prompt is about. */
  readonly decision: PermissionDecision;
  /** The tool the call is for. */
  readonly toolName: string;
}

/** The app's props. */
export interface AppProps {
  /** The transcript records the app shows. */
  readonly events: SessionEvent[];
  /** The text the user has typed. */
  readonly input: string;
  /** The approval the user is being asked about, when one is pending. */
  readonly approval?: PendingApproval | undefined;
  /** The status line's text. */
  readonly status?: string | undefined;
  /** Whether a turn is running. */
  readonly busy?: boolean | undefined;
  /** The composer's mode. */
  readonly mode?: ComposerMode | undefined;
  /** A notice the host produced, shown beside the toast. */
  readonly notice?: string | undefined;
  /** The environment the glyphs and the theme are read from. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Called when the user types. */
  readonly onInputChange?: ((text: string) => void) | undefined;
  /** Called when the user submits the input. */
  readonly onSubmit?: ((text: string) => void) | undefined;
  /** Called when the user answers the approval prompt. */
  readonly onApproval?: ((choice: ApprovalChoice) => void) | undefined;
}

/* -------------------------------------------------------------------------- */
/* The regions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A region, with its ARIA role and label.
 *
 * Ink replaces the content of a **labelled** node with the label when the
 * screen reader is enabled, so the content is rendered **beside** the node
 * rather than inside it. The label is announced (`list: Conversation`) and the
 * content is announced with it, instead of the label replacing it.
 */
function region(role: AriaRole, label: string, content: ReactNode): ReactNode {
  return createElement(
    Fragment,
    null,
    createElement(Box, { 'aria-role': role, 'aria-label': label }),
    content,
  );
}

/**
 * The echo of the line the user is typing.
 *
 * The text is **stripped** of its control sequences: it is typed, and a
 * terminal acts on an escape sequence, so a pasted escape sequence would
 * rewrite the screen. The stripper is the shared one
 * (`./render/markdown.ts`), the same one the renderers use.
 *
 * The echo carries the target's prompt glyph (§2.1).
 */
export function inputEcho(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const echoed = stripControlSequences(text);
  return echoed === '' ? '' : `${glyphs(env).pointer}\u00A0${echoed}`;
}

/* -------------------------------------------------------------------------- */
/* The drawing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Draw a segment.
 *
 * The **role** is resolved to a colour here, at the moment the text is drawn:
 * the theme owns the colours, and the renderer that produced the segment only
 * said which role the text belongs to.
 */
function drawSegment(segment: Segment, key?: string): ReactNode {
  const props: Record<string, unknown> = {};
  if (key !== undefined) props['key'] = key;
  if (segment.role !== undefined) {
    const color = roleColor(segment.role, DARK_THEME);
    if (color !== undefined) props['color'] = color;
  }
  if (segment.bold === true) props['bold'] = true;
  if (segment.italic === true) props['italic'] = true;
  if (segment.dim === true) props['dimColor'] = true;
  if (segment.underline === true) props['underline'] = true;
  if (segment.strike === true) props['strikethrough'] = true;
  if (segment.inverse === true) props['inverse'] = true;
  if (segment.ariaLabel !== undefined) props['aria-label'] = segment.ariaLabel;
  return createElement(Text, props, segment.text);
}

/**
 * Draw a list of segments.
 */
function drawSegments(segments: readonly Segment[]): ReactNode {
  return createElement(
    Fragment,
    null,
    ...segments.map((segment, index) => drawSegment(segment, `segment-${index}`)),
  );
}

/**
 * Split a list of segments into **lines**.
 *
 * A segment's text may run to several lines — a tool's result is a body
 * under a marker — and Ink draws a text node's newlines inside the node
 * itself, which would leave the next segment beside it rather than under it.
 * The lines are therefore split **here**, and each line is drawn as its own
 * row.
 */
function splitSegmentLines(segments: readonly Segment[]): Segment[][] {
  const lines: Segment[][] = [[]];
  for (const segment of segments) {
    const parts = segment.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1]?.push({ ...segment, text: part });
    });
  }
  return lines.filter((line) => line.length > 0);
}

/**
 * Draw one row of the transcript.
 *
 * The user's own prompt is drawn on a band of the `userMessageBackground`
 * colour, exactly as the target draws it (§3.1).
 */
function drawRow(row: TranscriptRow, index: number): ReactNode {
  const lines = splitSegmentLines(row.segments).map((line, lineIndex) =>
    createElement(
      Box,
      { key: `line-${lineIndex}`, flexDirection: 'row' },
      drawSegments(line),
    ),
  );

  const props: Record<string, unknown> = {
    key: `message-${index}`,
    'aria-role': 'listitem',
  };
  if (row.background !== undefined) {
    props['backgroundColor'] = roleColor(row.background, DARK_THEME);
    props['paddingRight'] = 1;
  }

  return createElement(
    Box,
    props,
    createElement(Box, { flexDirection: 'column' }, ...lines),
  );
}

/* -------------------------------------------------------------------------- */
/* The component                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The app.
 *
 * The component is **controlled**: the input text is a prop and the caller
 * owns it, so the app never has two copies of the same text. It takes the
 * terminal over only when it is given something to report back — a caller
 * that only wants the rendering never turns the terminal into raw mode.
 *
 * The message list is the **conversation**: the user's own prompts and the
 * model's blocks, in the order they happened. The conversation is built **on**
 * the plan's `renderMessages` — the model's blocks in the shipped view are
 * the plan's blocks, byte for byte — so the plan's contract and the
 * shipped view cannot drift apart. `renderTranscript` and `renderMessages`
 * are the **same** rows: one carries the roles the colours come from, the
 * other is their text.
 *
 * That relationship is asserted **by the code**: the conversation is built
 * from `renderMessages`' own blocks and from nothing else, so the plan's
 * contract *is* the shipped view. It is checked by a **behavioural** test —
 * the conversation's model blocks are the model's blocks. It is **not**
 * observed by spying on the call: the call is an intra-module one, and an
 * ESM namespace spy cannot see it.
 */
export function App(props: AppProps): ReactNode {
  const env = props.env ?? process.env;
  const rows = renderTranscript(props.events, env);
  const approval = props.approval;
  const input = props.input;
  const mode = props.mode ?? 'prompt';

  const interactive = props.onInputChange !== undefined || props.onSubmit !== undefined;

  // The focus on the approval dialog's options, and the two armed gestures.
  const [focus, setFocus] = useState(0);
  const [escapeArmed, setEscapeArmed] = useState(false);
  const [interruptArmed, setInterruptArmed] = useState(false);
  const [toast, setToast] = useState<string | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  // The `?` shortcuts overlay.
  const [shortcuts, setShortcuts] = useState(false);
  // The placeholder's suggestion: the target rotates it, and the clone
  // rotates it once per submission (§2.3).
  const [suggestion, setSuggestion] = useState(0);

  const { exit } = useApp();

  // The spinner advances every 50 ms while a turn runs, exactly as the
  // target's does (§12.1).
  useEffect(() => {
    if (props.busy !== true) return undefined;
    const timer = setInterval(() => {
      setElapsed((value) => value + 50);
    }, 50);
    return () => {
      clearInterval(timer);
    };
  }, [props.busy]);

  const showToast = (message: string): void => {
    setToast(message);
  };

  // The toast expires: the target's `escape-again-to-clear` notification has a
  // one-second timeout, and the gesture it arms expires with it (§12.3).
  useEffect(() => {
    if (toast === undefined) return undefined;
    const timer = setTimeout(() => {
      setToast(undefined);
      setEscapeArmed(false);
      setInterruptArmed(false);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);

  useInput(
    (typed, key) => {
      // A pending approval takes the keys: the dialog is the **Confirmation**
      // context, where the arrow keys move the focus, `enter` confirms and
      // `escape` cancels (§9.1).
      if (approval !== undefined) {
        if (key.escape) {
          props.onApproval?.('no');
          return;
        }
        if (key.return) {
          props.onApproval?.(choiceAt(focus));
          return;
        }
        if (key.upArrow) {
          setFocus((value) => moveFocus(value, -1));
          return;
        }
        if (key.downArrow) {
          setFocus((value) => moveFocus(value, 1));
          return;
        }
        return;
      }

      // The `?` overlay takes the keys while it is open.
      if (shortcuts) {
        if (key.escape || typed === '?') {
          setShortcuts(false);
          return;
        }
        return;
      }

      // `ctrl+c` is the target's **two-press** gesture (§12.3), so it is not
      // Ink's own exit key.
      if (key.ctrl && typed === 'c') {
        if (interruptArmed) {
          exit();
          return;
        }
        setInterruptArmed(true);
        showToast(INTERRUPT_AGAIN_MESSAGE);
        return;
      }

      if (key.ctrl && typed === 'd') {
        exit();
        return;
      }

      // `ctrl+j` is the target's newline (§9.1).
      if (key.ctrl && typed === 'j') {
        props.onInputChange?.(`${input}\n`);
        return;
      }

      // `ctrl+l` clears the line (§9.1).
      if (key.ctrl && typed === 'l') {
        props.onInputChange?.('');
        return;
      }

      if (key.return) {
        setEscapeArmed(false);
        // The placeholder's suggestion turns over on every submission.
        setSuggestion((value) => value + 1);
        props.onSubmit?.(input);
        return;
      }

      if (key.escape) {
        if (escapeArmed) {
          setEscapeArmed(false);
          setToast(undefined);
          props.onInputChange?.('');
          return;
        }
        setEscapeArmed(true);
        showToast(ESCAPE_AGAIN_MESSAGE);
        return;
      }

      if (key.backspace || key.delete) {
        props.onInputChange?.(input.slice(0, -1));
        return;
      }
      // `?` opens the shortcuts overlay — but only on an **empty** line, so a
      // question mark can still be typed into a prompt. The target's own rule
      // for the shell mode has the same shape (§12.8).
      if (typed === '?' && input === '' && !key.ctrl && !key.meta) {
        setShortcuts(true);
        return;
      }
      if (typed !== '' && !key.ctrl && !key.meta) {
        props.onInputChange?.(input + typed);
      }
    },
    { isActive: interactive || props.onApproval !== undefined },
  );

  const messageItems = rows.map((row, index) => drawRow(row, index));

  // The approval prompt: the title, the question, the reason and the three
  // choices as **options** — a screen reader that hears a paragraph after the
  // listbox does not hear three answers.
  const approvalRegion = (() => {
    if (approval === undefined) return null;
    const parts = approvalPromptParts(approval.decision, approval.toolName, focus);
    const choices = parts.choices.map((choice, index) =>
      createElement(
        Box,
        {
          key: `choice-${index}`,
          'aria-role': 'option',
          'aria-label': optionLabel(choice),
          flexDirection: 'row',
        },
        drawSegments(optionSegments(choice)),
      ),
    );
    return region(
      'listbox',
      approvalLabel(approval.toolName),
      createElement(
        Fragment,
        null,
        createElement(
          Box,
          {
            borderStyle: 'round',
            borderTop: true,
            borderBottom: false,
            borderLeft: false,
            borderRight: false,
            borderColor: roleColor('permission', DARK_THEME),
            flexDirection: 'column',
            width: '100%',
          },
          createElement(
            Box,
            { flexDirection: 'column', paddingLeft: 2, paddingTop: 1 },
            createElement(Text, { bold: true, color: roleColor('permission', DARK_THEME) }, parts.title),
            createElement(Text, null, parts.question),
            parts.reason === '' ? null : createElement(Text, { dimColor: true }, parts.reason),
            ...choices,
            createElement(Text, { dimColor: true, italic: true }, parts.guide),
          ),
        ),
      ),
    );
  })();

  // The composer: the target's top rule, the prompt glyph and the input.
  const composer = createElement(
    Box,
    {
      borderStyle: 'round',
      borderTop: true,
      borderBottom: false,
      borderLeft: false,
      borderRight: false,
      borderColor: roleColor('promptBorder', DARK_THEME),
      flexDirection: 'row',
      width: '100%',
    },
    drawSegment(composerGlyph(mode, env, props.busy === true)),
    input === ''
      ? createElement(Text, null, drawSegments(composerPlaceholder(placeholderText(suggestion))))
      : createElement(Text, null, input),
  );

  const inputRegion = region('textbox', ARIA_LABELS.input, composer);

  // The hint line under the composer: dim, and joined with `" · "`.
  const hintItems = hintLineItems({ approvalPending: approval !== undefined, mode });
  const hintRegion =
    hintItems.length === 0
      ? null
      : createElement(Text, { dimColor: true }, hintItems.join(HINT_SEPARATOR));

  // The status line: the target's gutter arrow and its spinner (§5.2).
  const statusRegion = (() => {
    // The status line is caller-supplied — it is whatever the caller put in
    // it — so it is stripped like every other string the app shows.
    const status = props.status === undefined ? '' : stripControlSequences(props.status);
    if (status === '') return null;
    if (props.busy !== true) return createElement(Text, { dimColor: true }, status);
    const frame = spinnerFrame(elapsed, SPINNER_FRAMES);
    return createElement(
      Text,
      { dimColor: true },
      `${glyphs(env).arrowDown} ${frame} ${status}`,
    );
  })();

  // The toast: the transient line the two gestures show.
  const toastRegion = (() => {
    const parts: string[] = [];
    if (toast !== undefined && toast !== '') parts.push(toast);
    if (props.notice !== undefined && props.notice !== '') {
      parts.push(stripControlSequences(props.notice));
    }
    if (parts.length === 0) return null;
    return createElement(Text, { dimColor: true }, parts.join(HINT_SEPARATOR));
  })();

  // The `?` shortcuts overlay: the target's own lines (§2.5).
  const shortcutsRegion = (() => {
    if (!shortcuts) return null;
    return createElement(
      Box,
      { flexDirection: 'column' },
      ...shortcutOverlayLines(env).map((line, index) =>
        createElement(Text, { key: `shortcut-${index}` }, line),
      ),
    );
  })();

  return createElement(
    Box,
    { flexDirection: 'column' },
    region('list', ARIA_LABELS.messageList, createElement(Fragment, null, ...messageItems)),
    approvalRegion,
    // The status line sits **above** the composer, as the target's spinner
    // line does (§5.2).
    statusRegion,
    shortcutsRegion,
    inputRegion,
    hintRegion,
    toastRegion,
  );
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The focus moves, and it wraps.
 */
function moveFocus(current: number, delta: number): number {
  const count = APPROVAL_CHOICES.length;
  if (count === 0) return 0;
  return ((current + delta) % count + count) % count;
}

/**
 * The choice the focused option answers with.
 */
function choiceAt(focus: number): ApprovalChoice {
  const choice = APPROVAL_CHOICES[focus];
  return choice ?? 'yes';
}

/**
 * The text an option is drawn with.
 *
 * The target's option row (§4.3): the pointer in front of the focused row, the
 * label, and the tick behind the selected one.
 */
export function optionText(choice: ApprovalChoiceView): string {
  let text = '';
  for (const segment of optionSegments(choice)) text += segment.text;
  return text;
}

/**
 * The label an option is announced with.
 */
export function optionLabel(choice: ApprovalChoiceView): string {
  return choice.suffix === undefined ? choice.label : `${choice.label} ${choice.suffix}`;
}

/* -------------------------------------------------------------------------- */
/* The mount                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Mount the app.
 *
 * The options are the app's own — the ones `appRenderOptions` returns — with
 * the caller's overrides applied on top. A caller that mounts the app this way
 * gets this implementation's behaviour: **no alternate screen**, incremental rendering
 * and the streaming frame rate.
 */
export function renderApp(props: AppProps, overrides: RenderOptions = {}): Instance {
  return render(createElement(App, props), { ...appRenderOptions(), ...overrides });
}
