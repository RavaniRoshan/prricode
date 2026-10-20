/**
 * The interactive terminal UI.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.10 (The
 * command-line surface) and the `CC-015` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
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
 * ## What is observed and what is a implementation choice
 *
 * The audit records the target's **input and output formats** and the fact that
 * a headless run is forced by a non-TTY stdout. It records nothing about how
 * an interactive terminal draws a conversation, so the ARIA labels, the region
 * roles, the layout and the choice bindings are **implementation choices**, and they are
 * marked as such below.
 */

import { createElement, Fragment, type ReactNode } from 'react';

import { Box, Text, render, useInput, type Instance, type RenderOptions } from 'ink';

import type { PermissionDecision } from '../permissions/decision.js';
import type { SessionEvent } from '../session/event.js';

import { renderConversation } from './render/messages.js';
import { APPROVAL_CHOICES, renderApprovalPrompt, type ApprovalChoice } from './render/prompts.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The ARIA roles this implementation's regions use.
 *
 * They are a subset of the roles Ink supports, and they are the roles that
 * match what the regions **are**: a list of messages, a list of messages'
 * items, a list of choices, and a line of text the user types into.
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
 */
export function approvalLabel(toolName: string): string {
  return `Approval required for ${toolName === '' ? 'the tool' : toolName}`;
}

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
 * The three that matter are the ones the plan fixes:
 *
 *   - `alternateScreen: false` — this implementation keeps the terminal's scrollback;
 *   - `incrementalRendering: true` — a streaming turn rewrites only the lines
 *     that changed;
 *   - `maxFps` — the frame rate a streaming turn runs at.
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
    isScreenReaderEnabled: process.env['INK_SCREEN_READER'] === 'true',
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
 * The choice a number in the prompt names.
 *
 * The number is the one the prompt shows, and it is looked up in the closed
 * list of the choices — never in a plain object, because the key comes from
 * the keyboard.
 */
function choiceFor(key: string): ApprovalChoice | undefined {
  if (key.length !== 1) return undefined;
  const digit = key.charCodeAt(0) - 0x30;
  if (digit < 1 || digit > APPROVAL_CHOICES.length) return undefined;
  return APPROVAL_CHOICES[digit - 1];
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
 */
export function App(props: AppProps): ReactNode {
  const blocks = renderConversation(props.events);
  const approval = props.approval;
  const input = props.input;

  const interactive = props.onInputChange !== undefined || props.onSubmit !== undefined;

  useInput(
    (typed, key) => {
      // A pending approval takes the number keys: they answer the question
      // rather than typing a digit into the prompt.
      if (approval !== undefined) {
        const choice = choiceFor(typed);
        if (choice !== undefined) {
          props.onApproval?.(choice);
          return;
        }
      }
      if (key.return) {
        props.onSubmit?.(input);
        return;
      }
      if (key.escape) {
        props.onInputChange?.('');
        return;
      }
      if (key.backspace || key.delete) {
        props.onInputChange?.(input.slice(0, -1));
        return;
      }
      if (typed !== '' && !key.ctrl && !key.meta) {
        props.onInputChange?.(input + typed);
      }
    },
    { isActive: interactive || props.onApproval !== undefined },
  );

  const messageItems = blocks.map((block, index) =>
    createElement(
      Box,
      { key: `message-${index}`, 'aria-role': 'listitem' },
      createElement(Text, null, block),
    ),
  );

  const approvalRegion =
    approval === undefined
      ? null
      : region(
          'listbox',
          approvalLabel(approval.toolName),
          createElement(
            Text,
            null,
            renderApprovalPrompt(approval.decision, approval.toolName),
          ),
        );

  const inputRegion = region(
    'textbox',
    ARIA_LABELS.input,
    createElement(Text, null, input === '' ? '' : `> ${input}`),
  );

  const statusRegion =
    props.status === undefined || props.status === ''
      ? null
      : createElement(Text, { dimColor: true }, props.status);

  return createElement(
    Box,
    { flexDirection: 'column' },
    region('list', ARIA_LABELS.messageList, createElement(Fragment, null, ...messageItems)),
    approvalRegion,
    inputRegion,
    statusRegion,
  );
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
