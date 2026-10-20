/**
 * Contract test for the **interactive terminal UI**'s renderers.
 *
 * Evidence: the `CC-022` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`,
 * and the specification it names —
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-terminal-ui.md`.
 *
 * ## What this test pins
 *
 * The surfaces the specification establishes, and the strings, the order, the
 * colours and the keys it gives for them:
 *
 *   1. the **theme**: the target's dark theme, value for value, and the rule
 *      that maps a role to one colour;
 *   2. the **glyphs**, with the target's platform deltas (`●` and `⏺`, `❯` and
 *      `>`, `✔` and `√`, `✘` and `×`);
 *   3. the **transcript**: the user's own prompt, the assistant's reply, a
 *      thinking block, a tool call and a tool's result — the same markers, the
 *      same order and the same colours;
 *   4. the **composer**: the prompt glyph, the top rule, and the placeholder;
 *   5. the **hint line**: its parts, and the separator between them;
 *   6. the **approval dialog**: the title, the question, the options, the
 *      input guide;
 *   7. the **keybindings**: the target's table and its platform deltas;
 *   8. the **markdown**: the target's rendering rules;
 *   9. the **two gestures**: `Esc again to clear` and
 *      `Press ctrl+c again to exit`;
 *   10. and the contracts the plan fixed: the message list's shape, the
 *       denial marker, the sandbox report, the purity of the renderers, the
 *       control-sequence stripping on every path, and the screen-reader tree.
 *
 * ## The environment the tests pin
 *
 * The glyphs are platform-dependent, so the tests that pin them pass an
 * **explicit** environment: the suite must not depend on the terminal the test
 * happens to run in.
 */

import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';

import type { Instance, RenderOptions } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { SESSION_SCHEMA_VERSION, type SessionEvent } from '../../src/session/event.js';
import type { PermissionDecision } from '../../src/permissions/decision.js';
import type { ToolResultEnvelope } from '../../src/tools/runner.js';
import {
  appRenderOptions,
  approvalLabel,
  composerGlyph,
  composerPlaceholder,
  cycleModeChord,
  ESCAPE_AGAIN_MESSAGE,
  hintLineItems,
  inputEcho,
  INTERRUPT_AGAIN_MESSAGE,
  keybindings,
  optionText,
  pasteChord,
  PLACEHOLDER_SUGGESTIONS,
  placeholderText,
  renderApp,
  shortcutOverlayLines,
  STREAMING_MAX_FPS,
  type AppProps,
} from '../../src/ui/app.js';
import { renderMarkdown, renderMarkdownSegments } from '../../src/ui/render/markdown.js';
import {
  KNOWN_INPUT_FIELDS,
  renderConversation,
  renderMessages,
  renderToolBlock,
  renderTranscript,
  summarizeToolInput,
  toolResultLines,
} from '../../src/ui/render/messages.js';
import {
  APPROVAL_GUIDE,
  APPROVAL_QUESTION,
  approvalChoices,
  approvalPromptParts,
  approvalTitle,
  choiceForNumber,
  choiceNumber,
  renderApprovalPrompt,
} from '../../src/ui/render/prompts.js';
import {
  DARK_THEME,
  glyphs,
  isThemeRole,
  roleColor,
  spinnerFrame,
  SPINNER_FRAMES,
  themeFor,
} from '../../src/ui/theme.js';

/* -------------------------------------------------------------------------- */
/* The fixtures                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The environment the glyphs are read from.
 *
 * The tests pass it **explicitly**, so a suite that runs on a plain Linux
 * terminal and a suite that runs on a macOS terminal pin the same strings.
 */
const ENV: NodeJS.ProcessEnv = { TERM: 'xterm-256color' };

let sequence = 0;

/** The base of a record: the version, a timestamp and an id. */
function base(id: string): { v: typeof SESSION_SCHEMA_VERSION; ts: number; id: string } {
  sequence += 1;
  return { v: SESSION_SCHEMA_VERSION, ts: 1_700_000_000_000 + sequence, id };
}

/** An assistant message record. */
function assistant(id: string, text: string): SessionEvent {
  return { ...base(id), t: 'assistant_message', text };
}

/** A user's own prompt record. */
function user(id: string, text: string): SessionEvent {
  return { ...base(id), t: 'user_message', text };
}

/** A tool call record. */
function toolCall(id: string, name: string, input: unknown): SessionEvent {
  return { ...base(id), t: 'tool_call', name, input };
}

/** A tool result record. */
function toolResult(id: string, envelope: ToolResultEnvelope): SessionEvent {
  return { ...base(id), t: 'tool_result', envelope };
}

/** A permission request record. */
function permissionRequest(
  id: string,
  toolName: string,
  decision: PermissionDecision,
): SessionEvent {
  return { ...base(id), t: 'permission_request', toolName, decision };
}

/**
 * The `Bash` tool's output shape.
 *
 * The shape is the tool's own (`src/tools/builtins/bash.ts`): every member is
 * optional but `sandboxed`, and the renderer must tolerate a member that is
 * not there.
 */
function bashOutput(overrides: Partial<{
  text: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  sandboxed: boolean;
  sandboxReason: string;
  sandboxEstablishmentReason: string;
  sandboxExemptions: readonly string[];
  sandboxExemptionScope: 'none' | 'partial' | 'all';
  sandboxAvailability: { available: boolean; reason?: string; warning?: string };
  timedOut: boolean;
}> = {}): Record<string, unknown> {
  const stdout = overrides.stdout ?? 'file1\nfile2';
  return {
    type: 'text',
    text: overrides.text ?? stdout,
    stdout,
    stderr: overrides.stderr ?? '',
    exitCode: overrides.exitCode ?? 0,
    truncated: overrides.truncated ?? false,
    sandboxed: overrides.sandboxed ?? true,
    ...(overrides.sandboxReason === undefined ? {} : { sandboxReason: overrides.sandboxReason }),
    ...(overrides.sandboxEstablishmentReason === undefined
      ? {}
      : { sandboxEstablishmentReason: overrides.sandboxEstablishmentReason }),
    ...(overrides.sandboxExemptions === undefined
      ? {}
      : { sandboxExemptions: overrides.sandboxExemptions }),
    ...(overrides.sandboxExemptionScope === undefined
      ? {}
      : { sandboxExemptionScope: overrides.sandboxExemptionScope }),
    ...(overrides.sandboxAvailability === undefined
      ? {}
      : { sandboxAvailability: overrides.sandboxAvailability }),
    ...(overrides.timedOut === undefined ? {} : { timedOut: overrides.timedOut }),
  };
}

/* -------------------------------------------------------------------------- */
/* The contracts                                                               */
/* -------------------------------------------------------------------------- */

describe('renderMessages — the message list', () => {
  it('produces one block per assistant message', () => {
    const blocks = renderMessages(
      [assistant('a1', 'The first answer.'), assistant('a2', 'The second answer.')],
      ENV,
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('The first answer.');
    expect(blocks[1]).toContain('The second answer.');
  });

  it('produces one block per tool call, and the block carries the tool result', () => {
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'ls -la' }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: bashOutput(),
          isError: false,
        }),
      ],
      ENV,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('Bash');
    expect(blocks[0]).toContain('ls -la');
    expect(blocks[0]).toContain('file1');
    expect(blocks[0]).toContain('file2');
  });

  it('produces one block per assistant message and one per tool call together', () => {
    const blocks = renderMessages(
      [
        assistant('a1', 'Let me look.'),
        toolCall('c1', 'Read', { file_path: '/work/a.txt' }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: { type: 'text', text: 'the file body' },
          isError: false,
        }),
        assistant('a2', 'Here is what I found.'),
      ],
      ENV,
    );

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain('Let me look.');
    expect(blocks[1]).toContain('Read');
    expect(blocks[1]).toContain('/work/a.txt');
    expect(blocks[1]).toContain('the file body');
    expect(blocks[2]).toContain('Here is what I found.');
  });

  it('marks a denied tool call with the decision source and the reason type', () => {
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'rm -rf /' }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: { type: 'error', message: 'The Bash call was denied.', errorCode: 13 },
          isError: true,
          permissionDecision: { decision: 'deny', source: 'user_reject', reasonType: 'rule' },
        }),
      ],
      ENV,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('user_reject');
    expect(blocks[0]).toContain('rule');
    expect(blocks[0]).toContain('denied');
  });

  it('marks a denied tool call with the source and reason type the permission request recorded', () => {
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'rm -rf /' }),
        permissionRequest('p1', 'Bash', {
          behavior: 'deny',
          source: 'hook',
          reasonType: 'safetyCheck',
          reason: 'A safety check refused this Bash call.',
        }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: { type: 'error', message: 'The Bash call was denied.', errorCode: 13 },
          isError: true,
        }),
      ],
      ENV,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('hook');
    expect(blocks[0]).toContain('safetyCheck');
    expect(blocks[0]).toContain('A safety check refused this Bash call.');
  });

  it('keeps the strictest of two permission requests for the same call', () => {
    // The runtime checks a call twice when a hook rewrites the input: the
    // first check asks, the re-check denies. The stricter decision is the one
    // that decided the call, so it is the one the marker carries.
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'rm -rf /' }),
        permissionRequest('p1', 'Bash', {
          behavior: 'ask',
          source: 'unknown',
          reasonType: 'other',
          reason: 'No permission rule matched.',
        }),
        permissionRequest('p2', 'Bash', {
          behavior: 'deny',
          source: 'hook',
          reasonType: 'safetyCheck',
          reason: 'A safety check refused this Bash call.',
        }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: { type: 'error', message: 'The Bash call was denied.', errorCode: 13 },
          isError: true,
        }),
      ],
      ENV,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('denied (source: hook, reason type: safetyCheck)');
    expect(blocks[0]).toContain('A safety check refused this Bash call.');
    expect(blocks[0]).not.toContain('No permission rule matched.');
    expect(blocks[0]).not.toContain('source: unknown');
  });

  it('folds a permission request into the most recent call of the same tool', () => {
    // The request belongs to the **most recent** call of the same tool —
    // whether or not that call already carries a decision, because a call that
    // is checked twice folds both requests into it.
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'ls' }),
        toolCall('c2', 'Bash', { command: 'rm -rf /' }),
        permissionRequest('p1', 'Bash', {
          behavior: 'deny',
          source: 'hook',
          reasonType: 'safetyCheck',
          reason: 'A safety check refused this Bash call.',
        }),
      ],
      ENV,
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toContain('denied (source: hook, reason type: safetyCheck)');
    expect(blocks[0]).not.toContain('denied');
  });

  it('fails closed on a behaviour outside the closed vocabulary', () => {
    // The types forbid it, but a caller can still build one at runtime. The
    // permission layer's own rule treats an unknown behaviour as the
    // **strictest**, and the renderer shares that rule, so the unknown
    // behaviour decides the call — and a call that is not an `allow` and not
    // an `ask` is marked as a denial rather than shown as approved.
    const outside = {
      behavior: 'maybe',
      source: 'unknown',
      reasonType: 'other',
      reason: 'An unknown behaviour decided this Bash call.',
    } as unknown as PermissionDecision;

    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'rm -rf /' }),
        permissionRequest('p1', 'Bash', {
          behavior: 'ask',
          source: 'unknown',
          reasonType: 'other',
          reason: 'No permission rule matched.',
        }),
        permissionRequest('p2', 'Bash', outside),
      ],
      ENV,
    );

    expect(blocks[0]).toContain('denied (source: unknown, reason type: other)');
    // The unknown behaviour **won the fold**: the `ask` decision's reason is
    // not the one that is shown.
    expect(blocks[0]).toContain('An unknown behaviour decided this Bash call.');
    expect(blocks[0]).not.toContain('No permission rule matched.');
  });

  it('prefers the decision that decided the call over the first request', () => {
    // The envelope carries the decision the call was settled with; a
    // `permission_request` record is the log of the checks that led to it.
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'rm -rf /' }),
        permissionRequest('p1', 'Bash', {
          behavior: 'ask',
          source: 'unknown',
          reasonType: 'other',
          reason: 'No permission rule matched.',
        }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: { type: 'error', message: 'The Bash call was denied.', errorCode: 13 },
          isError: true,
          permissionDecision: { decision: 'deny', source: 'hook', reasonType: 'safetyCheck' },
        }),
      ],
      ENV,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('denied (source: hook, reason type: safetyCheck)');
    expect(blocks[0]).not.toContain('source: unknown');
  });

  it('shows a sandboxed run as sandboxed', () => {
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'ls -la' }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: bashOutput({ sandboxed: true }),
          isError: false,
        }),
      ],
      ENV,
    );

    expect(blocks[0]).toContain('sandboxed');
  });

  it('shows the reason a run was not sandboxed, and the exemptions that applied', () => {
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'ls -la' }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: bashOutput({
            sandboxed: false,
            sandboxReason: 'sandbox.allowUnsandboxedCommands is true',
            sandboxExemptions: ['git'],
          }),
          isError: false,
        }),
      ],
      ENV,
    );

    expect(blocks[0]).toContain('sandbox.allowUnsandboxedCommands is true');
    // The exemption line is pinned by its **content**: the command is `ls`,
    // so the word `git` can only come from the exemption list.
    expect(blocks[0]).toContain('     sandbox exemptions: git');
  });

  it('shows why the sandbox never came up, how far the exemptions reach, and a timeout', () => {
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'ls -la' }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: bashOutput({
            sandboxed: false,
            sandboxEstablishmentReason: 'the bubblewrap backend is not available',
            sandboxExemptionScope: 'all',
            timedOut: true,
            exitCode: 0,
          }),
          isError: false,
        }),
      ],
      ENV,
    );

    expect(blocks[0]).toContain('     sandbox not established: the bubblewrap backend is not available');
    expect(blocks[0]).toContain('     sandbox exemption scope: all');
    expect(blocks[0]).toContain('     timed out');
  });

  it('shows the backend\'s availability report, so an unconfined run says why', () => {
    // On the unconfined path the availability report is the **only** carrier
    // of *why the backend was not used*, so it is shown and not merely read.
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'ls -la' }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: bashOutput({
            sandboxed: false,
            sandboxAvailability: {
              available: false,
              reason: 'the bubblewrap backend is not available',
            },
          }),
          isError: false,
        }),
      ],
      ENV,
    );

    expect(blocks[0]).toContain(
      '     sandbox backend unavailable: the bubblewrap backend is not available',
    );
  });

  it('shows what the availability probe could not establish', () => {
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'ls -la' }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: bashOutput({
            sandboxed: true,
            sandboxAvailability: { available: true, warning: 'the probe could not check the mount' },
          }),
          isError: false,
        }),
      ],
      ENV,
    );

    expect(blocks[0]).toContain('     sandbox backend available');
    expect(blocks[0]).toContain('     sandbox availability warning: the probe could not check the mount');
  });

  it('renders a tool block in the target\'s shape', () => {
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'ls' }),
        toolResult('r1', { toolUseId: 'c1', content: bashOutput(), isError: false }),
      ],
      ENV,
    );

    // The target's shape: the bullet in the gutter, the tool's name and the
    // summary in parentheses, and the result under the dim marker `  ⎿  ` —
    // every line of the body aligned under the marker.
    expect(blocks[0]).toBe(
      '● Bash(ls)\n  ⎿  sandboxed\n     exit code 0\n     file1\n     file2',
    );
  });

  it('strips the control sequences a tool result could carry', () => {
    const blocks = renderMessages(
      [
        toolCall('c1', 'Bash', { command: 'ls' }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: { type: 'text', text: 'out\n\u001b[?1049h\n\u001b]0;pwned\u0007' },
          isError: false,
        }),
      ],
      ENV,
    );

    expect(blocks[0]).not.toContain('\u001b');
    expect(blocks[0]).not.toContain('1049');
    expect(blocks[0]).not.toContain('pwned');
    expect(blocks[0]).toContain('out');
  });

  it('strips the control sequences a tool input could carry', () => {
    const blocks = renderMessages([toolCall('c1', 'Bash', { command: 'ls\u001b[?1049h' })], ENV);

    expect(blocks[0]).not.toContain('\u001b');
    expect(blocks[0]).not.toContain('1049');
  });

  it('never calls a caller-supplied toJSON', () => {
    const toJSON = vi.fn(() => 'leaked');
    const blocks = renderMessages([toolCall('c1', 'Mystery', { command: 'ls', toJSON })], ENV);

    expect(toJSON).not.toHaveBeenCalled();
    expect(blocks.join('\n')).not.toContain('leaked');
  });

  it('looks the summary field up in a Map, so a tool name cannot reach an inherited member', () => {
    expect(KNOWN_INPUT_FIELDS).toBeInstanceOf(Map);
    expect(KNOWN_INPUT_FIELDS.get('constructor')).toBeUndefined();
    expect(KNOWN_INPUT_FIELDS.get('__proto__')).toBeUndefined();
    expect(KNOWN_INPUT_FIELDS.get('toString')).toBeUndefined();
  });

  it('reports a tool result that has no tool call, rather than dropping it', () => {
    const blocks = renderMessages(
      [
        toolResult('r1', {
          toolUseId: 'nobody',
          content: { type: 'text', text: 'the orphan body' },
          isError: false,
        }),
      ],
      ENV,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe('● unmatched tool result\n  ⎿  toolUseId: nobody');
  });

  it('is pure: it writes to no terminal and mutates no record', () => {
    const events: SessionEvent[] = [
      assistant('a1', 'The answer.'),
      toolCall('c1', 'Bash', { command: 'ls' }),
      toolResult('r1', { toolUseId: 'c1', content: bashOutput(), isError: false }),
    ];
    const before = structuredClone(events);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let blocks: string[];
    try {
      blocks = renderMessages(events, ENV);
    } finally {
      stdout.mockRestore();
      log.mockRestore();
    }

    expect(stdout).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(events).toEqual(before);
    expect(renderMessages(events, ENV)).toEqual(blocks);
  });

  it('treats a caller-supplied tool name as data, never as a lookup key', () => {
    const blocks = renderMessages(
      [
        toolCall('c1', 'constructor', { command: 'ls' }),
        toolCall('c2', '__proto__', { command: 'ls' }),
        toolCall('c3', 'toString', { command: 'ls' }),
      ],
      ENV,
    );

    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(block).not.toContain('function');
      expect(block).not.toContain('[object Object]');
    }
    expect(blocks[0]).toContain('constructor');
    expect(blocks[1]).toContain('__proto__');
    expect(blocks[2]).toContain('toString');
  });

  it('keeps the user prompt out of the model list and inside the conversation view', () => {
    const events: SessionEvent[] = [user('u1', 'Please list the files.'), assistant('a1', 'Listing them now.')];

    const blocks = renderMessages(events, ENV);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('Listing them now.');
    expect(blocks.join('\n')).not.toContain('Please list the files.');

    const conversation = renderConversation(events, ENV);
    expect(conversation).toHaveLength(2);
    expect(conversation[0]).toContain('Please list the files.');
    expect(conversation[1]).toContain('Listing them now.');
  });

  it('builds the shipped view on the plan\'s blocks', () => {
    // The app ships the conversation; the conversation is built **on** the
    // plan's `renderMessages`, so the two cannot drift apart.
    const events: SessionEvent[] = [
      user('u1', 'Please list the files.'),
      assistant('a1', 'Listing them now.'),
      toolCall('c1', 'Read', { file_path: '/work/a.txt' }),
      toolResult('r1', {
        toolUseId: 'c1',
        content: { type: 'text', text: 'the file body' },
        isError: false,
      }),
    ];

    const model = renderMessages(events, ENV);
    const conversation = renderConversation(events, ENV);

    expect(model).toHaveLength(2);
    expect(conversation).toHaveLength(3);
    expect(conversation.filter((block) => model.includes(block))).toEqual(model);
    // The conversation's model blocks **are** the model's blocks, in order.
    expect(conversation).toEqual(['❯ Please list the files.', ...model]);
  });
});

/* -------------------------------------------------------------------------- */
/* The theme                                                                   */
/* -------------------------------------------------------------------------- */

describe('the theme — the target\'s colours and the role rule', () => {
  it('carries the target\'s dark theme, value for value', () => {
    // The target's own literals (`chunk-x6tyc5tp.js:16451`), spaces and all.
    expect(roleColor('promptBorder')).toBe('rgb(136,136,136)');
    expect(roleColor('permission')).toBe('rgb(177,185,249)');
    expect(roleColor('text')).toBe('rgb(255,255,255)');
    expect(roleColor('inactive')).toBe('rgb(153,153,153)');
    expect(roleColor('userMessageBackground')).toBe('rgb(55, 55, 55)');
    expect(roleColor('claude')).toBe('rgb(215,119,87)');
    expect(roleColor('error')).toBe('rgb(255,107,128)');
    expect(roleColor('success')).toBe('rgb(78,186,101)');
    expect(roleColor('warning')).toBe('rgb(255,193,7)');
    expect(roleColor('bashBorder')).toBe('rgb(253,93,177)');
    expect(roleColor('suggestion')).toBe('rgb(177,185,249)');
    expect(roleColor('subtle')).toBe('rgb(80,80,80)');
    expect(roleColor('diffAdded')).toBe('rgb(34,92,43)');
    expect(roleColor('diffRemoved')).toBe('rgb(122,41,54)');
  });

  it('has no colour for a role the theme does not have', () => {
    // The target's `dMt` is `Object.hasOwn(theme, role)`, so a role that is
    // not in the theme has **no** colour — and an inherited member is not a
    // role.
    expect(roleColor('constructor')).toBeUndefined();
    expect(roleColor('__proto__')).toBeUndefined();
    expect(roleColor('toString')).toBeUndefined();
    expect(isThemeRole('constructor')).toBe(false);
    expect(isThemeRole('promptBorder')).toBe(true);
  });

  it('carries every role of the target\'s dark theme', () => {
    // The target's theme has 72 roles; a theme that lost one would draw one
    // surface in the wrong colour.
    expect(Object.keys(DARK_THEME)).toHaveLength(72);
  });

  it('falls back to the dark theme for a name it does not know', () => {
    expect(themeFor('nonsense').promptBorder).toBe('rgb(136,136,136)');
    expect(themeFor('constructor').promptBorder).toBe('rgb(136,136,136)');
  });

  it('carries the values the specification established for the other themes', () => {
    expect(themeFor('light').permission).toBe('rgb(87,105,247)');
    expect(themeFor('light').text).toBe('rgb(0,0,0)');
    expect(themeFor('light').userMessageBackground).toBe('rgb(240, 240, 240)');
    expect(themeFor('light-ansi').text).toBe('ansi:black');
    expect(themeFor('light-ansi').permission).toBe('ansi:blue');
    expect(themeFor('dark-ansi').permission).toBe('ansi:blueBright');
    expect(themeFor('dark-ansi').text).toBe('ansi:white');
    expect(themeFor('dark-daltonized').diffAdded).toBe('rgb(0,68,102)');
    expect(themeFor('dark-daltonized').claude).toBe('rgb(255,153,51)');
  });
});

/* -------------------------------------------------------------------------- */
/* The glyphs                                                                  */
/* -------------------------------------------------------------------------- */

describe('the glyphs — the target\'s platform deltas', () => {
  it('uses the default set off the plain Linux terminal', () => {
    const set = glyphs(ENV);
    expect(set.pointer).toBe('❯');
    expect(set.tick).toBe('✔');
    expect(set.cross).toBe('✘');
  });

  it('uses the plain Linux set on TERM=linux', () => {
    // The target's icon set is chosen by a test that is `false` only on
    // `TERM=linux`, and not on Windows.
    const set = glyphs({ TERM: 'linux' });
    expect(set.pointer).toBe('>');
    expect(set.tick).toBe('√');
    expect(set.cross).toBe('×');
  });

  it('uses the macOS bullet on macOS and the other bullet everywhere else', () => {
    expect(glyphs(ENV, 'macos').bullet).toBe('⏺');
    expect(glyphs(ENV, 'linux').bullet).toBe('●');
    expect(glyphs(ENV, 'wsl').bullet).toBe('●');
  });

  it('carries the target\'s own glyph constants', () => {
    const set = glyphs(ENV);
    expect(set.thinking).toBe('∴');
    expect(set.toolResult).toBe('⎿');
    expect(set.lozenge).toBe('◆');
    expect(set.arrowUp).toBe('↑');
    expect(set.arrowDown).toBe('↓');
    expect(set.fastMode).toBe('↯');
  });
});

/* -------------------------------------------------------------------------- */
/* The transcript                                                              */
/* -------------------------------------------------------------------------- */

describe('the transcript — the target\'s rows', () => {
  it('draws the user\'s own prompt as the pointer and the text, on a band', () => {
    const rows = renderTranscript([user('u1', 'hello there')], ENV);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.kind).toBe('user');
    // The target's §3.1: the pointer in `inactive`, the text in `text`, and
    // the whole row on a `userMessageBackground` band.
    expect(row?.background).toBe('userMessageBackground');
    expect(row?.segments[0]).toMatchObject({ text: '❯', role: 'inactive', ariaLabel: 'you:' });
    expect(row?.segments[2]).toMatchObject({ text: 'hello there', role: 'text' });
  });

  it('draws the assistant\'s reply as the bullet and the markdown body', () => {
    const rows = renderTranscript([assistant('a1', 'The **answer**.')], ENV);

    const row = rows[0];
    expect(row?.kind).toBe('assistant');
    // The target's §3.3: the bullet in `text`, the body beside it.
    expect(row?.segments[0]).toMatchObject({ text: '●', role: 'text', ariaLabel: 'claude:' });
    expect(row?.segments[1]).toEqual({ text: ' ' });
    expect(row?.segments[2]).toMatchObject({ text: 'The ' });
    expect(row?.segments[3]).toMatchObject({ text: 'answer', bold: true });
  });

  it('draws a tool call as the bullet, the bold name and the summary', () => {
    const rows = renderTranscript([toolCall('c1', 'Bash', { command: 'ls -la' })], ENV);

    const row = rows[0];
    expect(row?.kind).toBe('tool');
    // The target's §3.5: the gutter holds the bullet, the tool's name is
    // bold, and the summary is in parentheses.
    expect(row?.segments[0]).toMatchObject({ text: '●', role: 'text', ariaLabel: 'tool:' });
    expect(row?.segments[2]).toMatchObject({ text: 'Bash', bold: true });
    expect(row?.segments[3]).toEqual({ text: '(ls -la)' });
  });

  it('draws the tool\'s result under the dim marker, aligned under it', () => {
    const rows = renderTranscript(
      [
        toolCall('c1', 'Bash', { command: 'ls' }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: { type: 'text', text: 'one\ntwo' },
          isError: false,
        }),
      ],
      ENV,
    );

    const row = rows[0];
    // The target's §3.6: the marker is `  ⎿  ` — two spaces, the marker, two
    // spaces — and it is dim.
    const marker = row?.segments.find((segment) => segment.text === '  ⎿  ');
    expect(marker).toMatchObject({ dim: true });
    // The body is aligned under the marker.
    const body = row?.segments[row.segments.length - 1];
    expect(body?.text).toBe('one\n     two');
  });

  it('draws an errored result in the error colour', () => {
    const rows = renderTranscript(
      [
        toolCall('c1', 'Bash', { command: 'ls' }),
        toolResult('r1', {
          toolUseId: 'c1',
          content: { type: 'text', text: 'it broke' },
          isError: true,
        }),
      ],
      ENV,
    );

    const body = rows[0]?.segments[rows[0].segments.length - 1];
    expect(body?.role).toBe('error');
  });

  it('keeps the rows in the order the records happened', () => {
    const rows = renderTranscript(
      [
        user('u1', 'the question'),
        assistant('a1', 'the answer'),
        toolCall('c1', 'Bash', { command: 'ls' }),
        toolResult('r1', { toolUseId: 'c1', content: { type: 'text', text: 'out' }, isError: false }),
      ],
      ENV,
    );

    expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant', 'tool']);
  });
});

/* -------------------------------------------------------------------------- */
/* The composer                                                                */
/* -------------------------------------------------------------------------- */

describe('the composer', () => {
  it('shows the target\'s prompt glyph, in the prompt border colour', () => {
    // The target's §2.1: `te.pointer` and a non-breaking space.
    expect(composerGlyph('prompt', ENV)).toEqual({ text: '❯\u00A0', role: 'promptBorder' });
  });

  it('shows the shell glyph in the bash border colour', () => {
    // The target's §2.1: `!` and a non-breaking space, in `bashBorder`.
    expect(composerGlyph('bash', ENV)).toEqual({ text: '!\u00A0', role: 'bashBorder' });
  });

  it('dims the glyph while a turn is loading', () => {
    // The target's §2.1: the glyph is dimmed while the turn is loading.
    expect(composerGlyph('prompt', ENV, true)).toEqual({
      text: '❯\u00A0',
      role: 'promptBorder',
      dim: true,
    });
  });

  it('offers the target\'s placeholder', () => {
    // The target's §2.3: `Try "<a suggestion>"`.
    expect(placeholderText(0)).toBe('Try "fix lint errors"');
    expect(PLACEHOLDER_SUGGESTIONS).toHaveLength(8);
    expect(PLACEHOLDER_SUGGESTIONS[1]).toBe('fix typecheck errors');
    expect(PLACEHOLDER_SUGGESTIONS[7]).toBe('create a util logging.py that...');
  });

  it('dims the placeholder and inverts its first character — the cursor', () => {
    const segments = composerPlaceholder(placeholderText(0));

    expect(segments[0]).toMatchObject({ text: 'T', inverse: true });
    expect(segments[1]).toMatchObject({ text: 'ry "fix lint errors"', dim: true });
  });

  it('echoes the typed line with the target\'s prompt glyph', () => {
    expect(inputEcho('hello', ENV)).toBe('❯\u00A0hello');
    expect(inputEcho('', ENV)).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* The hint line                                                               */
/* -------------------------------------------------------------------------- */

describe('the hint line', () => {
  it('waits for the permission while a call is pending', () => {
    // The target's §2.4: `Waiting for permission…`.
    expect(hintLineItems({ approvalPending: true, mode: 'prompt' })).toEqual([
      'Waiting for permission…',
      '? for shortcuts',
    ]);
  });

  it('shows the shell hint in shell mode', () => {
    // The target's §2.4: `! for shell mode`.
    expect(hintLineItems({ approvalPending: false, mode: 'bash' })).toEqual([
      '! for shell mode',
      '? for shortcuts',
    ]);
  });

  it('shows the shortcuts hint', () => {
    expect(hintLineItems({ approvalPending: false, mode: 'prompt' })).toEqual(['? for shortcuts']);
  });
});

/* -------------------------------------------------------------------------- */
/* The shortcuts overlay                                                       */
/* -------------------------------------------------------------------------- */

describe('the shortcuts overlay', () => {
  it('carries the target\'s lines, in the target\'s order', () => {
    const lines = shortcutOverlayLines(ENV);

    expect(lines[0]).toBe('! for shell mode');
    expect(lines[1]).toBe('/ for commands');
    expect(lines[2]).toBe('@ for file paths');
    expect(lines[3]).toBe('/btw for side question');
    expect(lines[4]).toBe('double tap esc to clear input');
    expect(lines[lines.length - 1]).toBe('/keybindings to customize');
  });

  it('renders each key hint as the target does — the chord, then the action', () => {
    const lines = shortcutOverlayLines(ENV);

    expect(lines).toContain('ctrl + o to verbose output');
    expect(lines).toContain('ctrl + t to toggle tasks');
    expect(lines).toContain('ctrl + _ to undo');
    expect(lines).toContain('ctrl + z to suspend');
    expect(lines).toContain('alt + p to switch model');
    expect(lines).toContain('alt + o to toggle fast mode');
    expect(lines).toContain('ctrl + g to edit in $EDITOR');
  });
});

/* -------------------------------------------------------------------------- */
/* The approval dialog                                                         */
/* -------------------------------------------------------------------------- */

describe('the approval prompt — the target\'s dialog', () => {
  it('titles the dialog by the tool', () => {
    // The target's §4.2.
    expect(approvalTitle('Read')).toBe('Read file');
    expect(approvalTitle('Write')).toBe('Edit file');
    expect(approvalTitle('Edit')).toBe('Edit file');
    expect(approvalTitle('NotebookEdit')).toBe('Edit file');
    expect(approvalTitle('Bash')).toBe('Bash command');
  });

  it('asks the target\'s question', () => {
    // The target's §4.2.
    expect(APPROVAL_QUESTION).toBe('Do you want to proceed?');
    const parts = approvalPromptParts(
      { behavior: 'ask', source: 'unknown', reasonType: 'other', reason: 'No rule matched.' },
      'Bash',
    );
    expect(parts.question).toBe('Do you want to proceed?');
    expect(parts.title).toBe('Bash command');
  });

  it('offers the target\'s options, with no numbers', () => {
    // The target's §4.3: the options carry **no** numbers.
    const choices = approvalChoices('Bash');

    expect(choices.map((choice) => choice.value)).toEqual(['yes', 'yes-always', 'no']);
    expect(choices[0]?.label).toBe('Yes');
    expect(choices[2]?.label).toBe('No, and tell Claude what to do differently');
    expect(choices[2]?.suffix).toBe('(esc)');
    // The target's options carry **no** numbers at all.
    expect(Object.hasOwn(choices[0] as object, 'number')).toBe(false);
  });

  it('numbers the choices from one, for a caller that wants the index', () => {
    expect(choiceNumber('yes')).toBe(1);
    expect(choiceNumber('yes-always')).toBe(2);
    expect(choiceNumber('no')).toBe(3);
    expect(choiceForNumber(2)).toBe('yes-always');
    expect(choiceForNumber(9)).toBeUndefined();
  });

  it('shows the focused option with the pointer and the selected one with the tick', () => {
    // The target's §4.3: `❯ ` in the `suggestion` colour for the focused
    // row, `✔` in the `success` colour for the selected one.
    const choices = approvalChoices('Bash', 1);

    expect(optionText(choices[1] as never)).toBe(
      '❯ Yes, and don\'t ask again for this Bash call ✔',
    );
    expect(optionText(choices[0] as never)).toBe('  Yes');
    expect(optionText(choices[2] as never)).toBe(
      '  No, and tell Claude what to do differently (esc)',
    );
  });

  it('shows the target\'s input guide', () => {
    // The target's §4.1: `enter to confirm · esc to cancel`.
    expect(APPROVAL_GUIDE).toBe('enter to confirm · esc to cancel');
  });

  it('renders the whole dialog, in the target\'s order', () => {
    const prompt = renderApprovalPrompt(
      { behavior: 'ask', source: 'unknown', reasonType: 'other', reason: 'No rule matched.' },
      'Bash',
    );

    expect(prompt).toBe(
      [
        'Bash command',
        'Do you want to proceed?',
        '',
        'No rule matched.',
        '',
        '❯ Yes ✔',
        '  Yes, and don\'t ask again for this Bash call',
        '  No, and tell Claude what to do differently (esc)',
        '',
        'enter to confirm · esc to cancel',
      ].join('\n'),
    );
  });

  it('renders a denial as a denial, with no question to answer', () => {
    const prompt = renderApprovalPrompt(
      {
        behavior: 'deny',
        source: 'user_reject',
        reasonType: 'rule',
        reason: 'Permission rule denies this Bash call.',
      },
      'Bash',
    );

    expect(prompt).toContain('denied');
    expect(prompt).toContain('Permission rule denies this Bash call.');
    expect(prompt).not.toContain('1. Yes');
    expect(prompt).not.toContain('Do you want to proceed?');
  });

  it('renders an approval as an approval, with no question to answer', () => {
    const prompt = renderApprovalPrompt(
      {
        behavior: 'allow',
        source: 'user_temporary',
        reasonType: 'rule',
        reason: 'Permission rule allows this Bash call.',
      },
      'Bash',
    );

    expect(prompt).toContain('allowed');
    expect(prompt).not.toContain('Do you want to proceed?');
  });

  it('strips the control sequences a tool name or a reason could carry', () => {
    const prompt = renderApprovalPrompt(
      {
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'other',
        reason: 'No permission rule matched.\u001b[?1049h\u001b]0;pwned\u0007',
      },
      'Bash\u001b[?1049h\u001b]0;pwned\u0007',
    );

    expect(prompt).not.toContain('\u001b');
    expect(prompt).not.toContain('1049');
    expect(prompt).toContain('Bash');
  });
});

/* -------------------------------------------------------------------------- */
/* The keybindings                                                             */
/* -------------------------------------------------------------------------- */

describe('the keybindings — the target\'s table', () => {
  it('carries the Global context', () => {
    const table = keybindings(ENV);

    expect(table.get('Global')?.get('ctrl+c')).toBe('app:interrupt');
    expect(table.get('Global')?.get('ctrl+d')).toBe('app:exit');
    expect(table.get('Global')?.get('ctrl+t')).toBe('app:toggleTodos');
    expect(table.get('Global')?.get('ctrl+o')).toBe('app:toggleTranscript');
  });

  it('carries the Chat context', () => {
    const table = keybindings(ENV);

    expect(table.get('Chat')?.get('enter')).toBe('chat:submit');
    expect(table.get('Chat')?.get('escape')).toBe('chat:cancel');
    expect(table.get('Chat')?.get('ctrl+j')).toBe('chat:newline');
    expect(table.get('Chat')?.get('ctrl+l')).toBe('chat:clearInput');
    expect(table.get('Chat')?.get('ctrl+g')).toBe('chat:externalEditor');
    expect(table.get('Chat')?.get('up')).toBe('history:previous');
    expect(table.get('Chat')?.get('down')).toBe('history:next');
  });

  it('carries the Confirmation context', () => {
    const table = keybindings(ENV);

    expect(table.get('Confirmation')?.get('enter')).toBe('confirm:yes');
    expect(table.get('Confirmation')?.get('escape')).toBe('confirm:no');
    expect(table.get('Confirmation')?.get('up')).toBe('confirm:previous');
    expect(table.get('Confirmation')?.get('down')).toBe('confirm:next');
  });

  it('carries the Select and Transcript contexts', () => {
    const table = keybindings(ENV);

    expect(table.get('Select')?.get('enter')).toBe('select:accept');
    expect(table.get('Select')?.get('escape')).toBe('select:cancel');
    expect(table.get('Transcript')?.get('ctrl+e')).toBe('transcript:toggleShowAll');
    expect(table.get('Transcript')?.get('q')).toBe('transcript:exit');
  });

  it('pastes with the target\'s platform chord', () => {
    // The target's §9.2: `alt+v` on Windows and WSL, `ctrl+v` elsewhere.
    expect(pasteChord({ PRRICODE_PLATFORM: 'linux' })).toBe('ctrl+v');
    expect(pasteChord({ PRRICODE_PLATFORM: 'macos' })).toBe('ctrl+v');
    expect(pasteChord({ PRRICODE_PLATFORM: 'windows' })).toBe('alt+v');
    expect(pasteChord({ PRRICODE_PLATFORM: 'wsl' })).toBe('alt+v');
  });

  it('cycles the mode with the target\'s platform chord', () => {
    // The target's §9.2: `shift+tab` on a recent install, `meta+m` on an old
    // one.
    expect(cycleModeChord({ PRRICODE_PLATFORM: 'linux' })).toBe('shift+tab');
    expect(cycleModeChord({ PRRICODE_PLATFORM: 'macos' })).toBe('shift+tab');
    expect(cycleModeChord({ PRRICODE_PLATFORM: 'windows' })).toBe('meta+m');
  });
});

/* -------------------------------------------------------------------------- */
/* The spinner                                                                 */
/* -------------------------------------------------------------------------- */

describe('the spinner', () => {
  it('carries the target\'s six frames', () => {
    expect(SPINNER_FRAMES).toEqual(['·', '✢', '*', '✶', '✻', '✽']);
  });

  it('oscillates on a two-second period', () => {
    // The target's index is a cosine over two seconds: the frame walks the
    // set and walks it back.
    const first = spinnerFrame(0);
    const half = spinnerFrame(1000);
    const again = spinnerFrame(2000);

    expect(SPINNER_FRAMES).toContain(first);
    expect(SPINNER_FRAMES).toContain(half);
    expect(again).toBe(first);
    expect(half).not.toBe(first);
  });
});

/* -------------------------------------------------------------------------- */
/* The markdown renderer                                                       */
/* -------------------------------------------------------------------------- */

describe('renderMarkdown — the target\'s rules', () => {
  it('renders a partially-streamed fragment as text instead of throwing', () => {
    const fragment = 'Here is a **partially streamed fra';

    let rendered: string | undefined;
    expect(() => {
      rendered = renderMarkdown(fragment, ENV);
    }).not.toThrow();
    expect(rendered).toBeDefined();
    expect(rendered ?? '').toContain('partially streamed fra');
  });

  it('renders a fragment whose fenced code block has not been closed yet', () => {
    const fragment = '```rust\nfn main() {';

    const rendered = renderMarkdown(fragment, ENV);
    expect(rendered).toContain('rust');
    expect(rendered).toContain('fn main() {');
  });

  it('renders a fenced code block with its language preserved', () => {
    const rendered = renderMarkdown('```rust\nfn main() {}\n```', ENV);

    expect(rendered).toContain('rust');
    expect(rendered).toContain('fn main() {}');
  });

  it('dims the language of a labelled fence above the body', () => {
    // The target's §10.1: the language name is dimmed and prepended when the
    // highlighter does not support it — and the clone has no highlighter, so
    // it always is.
    const segments = renderMarkdownSegments('```rust\nfn main() {}\n```', ENV);

    expect(segments[0]).toMatchObject({ text: 'rust', dim: true });
    expect(segments[segments.length - 1]).toMatchObject({ text: 'fn main() {}' });
  });

  it('renders an unlabelled fence entirely in the permission colour', () => {
    // The target's §10.1: an unlabelled, non-indented fence is rendered
    // **entirely** in the `permission` colour, with no header.
    const segments = renderMarkdownSegments('```\nplain\n```', ENV);

    expect(segments).toEqual([{ text: 'plain', role: 'permission' }]);
  });

  it('renders inline code in the permission colour', () => {
    // The target's §10.1.
    const segments = renderMarkdownSegments('Run `code` now', ENV);
    const code = segments.find((segment) => segment.role === 'permission');

    expect(code?.text).toBe('code');
  });

  it('bolds a heading, and underlines an H1 as well', () => {
    // The target's §10.1: an H1 is bold, italic **and** underlined; every
    // other heading is bold. The `#` markers are not shown.
    const h1 = renderMarkdownSegments('# Title', ENV);
    expect(h1[0]).toMatchObject({ text: 'Title', bold: true, italic: true, underline: true });

    const h2 = renderMarkdownSegments('## Sub', ENV);
    expect(h2[0]).toMatchObject({ text: 'Sub', bold: true });
    expect(h2[0]?.italic).toBeUndefined();
  });

  it('renders a thematic break as three dashes', () => {
    expect(renderMarkdown('---', ENV)).toBe('---');
  });

  it('marks a list item with a dash and an ordered one with its number', () => {
    expect(renderMarkdown('- one', ENV)).toBe('- one');
    expect(renderMarkdown('1. one', ENV)).toBe('1. one');
  });

  it('prefixes a task item with its checkbox', () => {
    expect(renderMarkdown('- [x] done', ENV)).toBe('- [x] done');
    expect(renderMarkdown('- [ ] todo', ENV)).toBe('- [ ] todo');
  });

  it('renders a table as a markdown table', () => {
    // The target's §10.1: the header row, a separator of dashes per column,
    // and the body rows.
    expect(renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |', ENV)).toBe(
      '| a   | b   |\n|-----|-----|\n| 1   | 2   |',
    );
  });

  it('renders a blockquote behind a quote rule, in italics', () => {
    const segments = renderMarkdownSegments('> quoted', ENV);

    expect(segments[0]).toMatchObject({ text: '│ quoted', italic: true });
  });

  it('keeps struck-through text literal on a terminal that cannot strike it', () => {
    // The target's §10.1: struck-through is off on `TERM=linux` and on
    // Apple Terminal, and the literal `~~text~~` is shown instead.
    expect(renderMarkdown('~~gone~~', { TERM: 'linux' })).toBe('~~gone~~');
    expect(renderMarkdown('~~gone~~', ENV)).toBe('gone');
  });

  it('renders an image as its alt text and its URL', () => {
    // The target's §10.1.
    expect(renderMarkdown('![alt](https://example.com/i.png)', ENV)).toBe(
      'alt (https://example.com/i.png)',
    );
    expect(renderMarkdown('![](https://example.com/i.png)', ENV)).toBe(
      'https://example.com/i.png',
    );
  });

  it('appends a link\'s title in parentheses', () => {
    expect(renderMarkdown('[label](https://example.com "the title")', ENV)).toBe(
      'label ("the title")',
    );
  });

  it('does not let a fenced code block break out of its fence', () => {
    const source = ['```ts', '**not bold**', 'const fence = "```";', '```'].join('\n');

    const rendered = renderMarkdown(source, ENV);
    // The markdown syntax inside the block stays literal: it was never parsed.
    expect(rendered).toContain('**not bold**');
    // The closing fence inside the block did not close the block.
    expect(rendered).toContain('const fence = "```";');
  });

  it('evaluates nothing', () => {
    const rendered = renderMarkdown('Run `process.exit(1)` to stop.', ENV);

    expect(rendered).toContain('process.exit(1)');
  });

  it('strips the control sequences a model could use to rewrite the terminal', () => {
    // The code path emits its content **verbatim**, so a control sequence inside
    // a code block would reach the terminal untouched unless the renderer
    // stripped it first.
    const hostile = [
      '```txt',
      '\u001b[2J', // clear the screen
      '\u001b]0;pwned\u0007', // retitle the window
      '\u001b[?1049h', // enter the alternate screen — the one this implementation must never do
      'plain text',
      '```',
    ].join('\n');

    const rendered = renderMarkdown(hostile, ENV);

    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\u0007');
    expect(rendered).not.toContain('pwned');
    expect(rendered).not.toContain('1049');
    expect(rendered).toContain('plain text');
  });

  it('drops the payload of a C1 control sequence, not only its introducer', () => {
    // 0x9b is the 8-bit CSI: a terminal that accepts it acts on `2J` exactly
    // as it acts on the 7-bit form, so the parameters go with the introducer.
    const rendered = renderMarkdown('a\u009b2Jb', ENV);

    expect(rendered).not.toContain('\u009b');
    expect(rendered).not.toContain('2J');
    expect(rendered).toBe('ab');
  });

  it('is pure: it writes to no terminal', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let rendered: string | undefined;
    try {
      rendered = renderMarkdown('# A heading\n\nSome **text**.', ENV);
    } finally {
      stdout.mockRestore();
    }

    expect(stdout).not.toHaveBeenCalled();
    expect(rendered).toContain('A heading');
    expect(rendered).toContain('Some text.');
  });
});

/* -------------------------------------------------------------------------- */
/* The strip, one path at a time                                              */
/* -------------------------------------------------------------------------- */

/**
 * The strip is **per path**, and this block is what makes it so.
 *
 * The paths **mask** each other: the tool result is stripped by the result
 * reader *and* by the block renderer, so a reader that stopped stripping
 * would still be hidden by the renderer next to it. A test that only looked
 * at the finished block could not tell the two apart.
 *
 * So every path is pinned **on its own**, and the pinned text is the **exact**
 * stripped text — not merely "there is no escape sequence in here". An exact
 * text also catches a **second, weaker scanner**: a renderer that dropped the
 * CSI sequences and let the OSC through would fail on the exact text even
 * though the shared stripper had already removed both.
 *
 * **Every site carries the OSC form, and not only the CSI one.** A scanner
 * that knows only the CSI form handles a CSI-only input exactly as well as
 * the shared scanner does, so a CSI-only input cannot tell the two apart —
 * the OSC form is what does. The hostile input at every site below therefore
 * carries **both**: the CSI sequence (`ESC [ ? 1049 h`, the alternate screen
 * this implementation must never enter) and the OSC sequence (`ESC ] 0 ; pwned BEL`,
 * which retitles the window and which Ink's own sanitiser **preserves**).
 *
 * The sites are **named after the strip they pin**, so a strip that is
 * removed — or a strip that is replaced by a weaker one — is caught at that
 * site and not by the layer next to it.
 */
describe('the control-sequence strip — one path at a time', () => {
  it('strips the tool result in the result reader itself', () => {
    const lines = toolResultLines(
      {
        toolUseId: 'c1',
        content: { type: 'text', text: 'out\u001b[?1049h\u001b]0;pwned\u0007' },
        isError: false,
      },
      undefined,
    );

    expect(lines).toEqual(['out']);
  });

  it('strips the output of a Bash run in the result reader itself', () => {
    const lines = toolResultLines(
      {
        toolUseId: 'c1',
        content: bashOutput({ stdout: 'out\u001b[2J\u001b]0;pwned\u0007' }),
        isError: false,
      },
      undefined,
    );

    expect(lines).toEqual(['sandboxed', 'exit code 0', 'out']);
  });

  it('strips the error message of a tool result itself', () => {
    // The error branch is its **own** reader: the message does not go
    // through the line splitter, so nothing else strips it on this path.
    const lines = toolResultLines(
      {
        toolUseId: 'c1',
        content: {
          type: 'error',
          message: 'boom\u001b[?1049h\u001b]0;pwned\u0007',
          errorCode: 13,
        },
        isError: true,
      },
      undefined,
    );

    expect(lines).toEqual(['boom (error code 13)']);
  });

  it('strips the denial reason itself', () => {
    // The reason is the decision's own text, and the decision is
    // caller-supplied. The block renderer strips the line it is given, so
    // the reason has to be stripped **here** to be stripped at all.
    const lines = toolResultLines(undefined, {
      behavior: 'deny',
      source: 'hook',
      reasonType: 'safetyCheck',
      reason: 'A safety check refused this call.\u001b[?1049h\u001b]0;pwned\u0007',
    });

    expect(lines).toEqual([
      'denied (source: hook, reason type: safetyCheck)',
      'A safety check refused this call.',
    ]);
  });

  it('strips the compact JSON of a tool input itself', () => {
    // The compact JSON is the summary of a tool this implementation does not know, and
    // the **JSON encoding** is what makes the strip visible here: an escape
    // that survived it would be encoded as a literal six-character escape in
    // the text, so the strip that comes afterwards would not catch it.
    expect(summarizeToolInput('Mystery', { note: 'ls\u001b[?1049h\u001b]0;pwned\u0007' })).toBe(
      '{"note": "ls"}',
    );
  });

  it('strips the tool summary itself', () => {
    expect(summarizeToolInput('Bash', { command: 'ls\u001b[?1049h' })).toBe('ls');
    expect(summarizeToolInput('Bash', { command: 'ls\u001b]0;pwned\u0007' })).toBe('ls');
  });

  it('strips the tool name in the block header itself', () => {
    // The name is the **caller's** name — a model chose it — and nothing
    // else strips it: the summary and the result lines are stripped on
    // their own paths, and the name is on neither of them.
    const block = renderToolBlock('Bash\u001b[?1049h\u001b]0;pwned\u0007', 'ls', [], ENV);

    expect(block).toBe('● Bash(ls)');
  });

  it('strips the summary in the block header itself', () => {
    const block = renderToolBlock('Bash', 'ls\u001b[?1049h\u001b]0;pwned\u0007', [], ENV);

    expect(block).toBe('● Bash(ls)');
  });

  it('strips the result lines in the block itself', () => {
    // The lines arrive already stripped by the reader that produced them, so
    // the block has to strip them **itself** to be safe on its own.
    const block = renderToolBlock('Bash', 'ls', ['out\u001b[?1049h\u001b]0;pwned\u0007'], ENV);

    expect(block).toBe('● Bash(ls)\n  ⎿  out');
  });

  it('strips the user\'s own prompt itself', () => {
    // The user's prompt is the only text in a row that is **not** markdown,
    // so nothing else strips it.
    const rows = renderTranscript([user('u1', 'hello\u001b[?1049h\u001b]0;pwned\u0007')], ENV);
    const body = rows[0]?.segments[2];

    expect(body?.text).toBe('hello');
  });

  it('strips the tool result id of an unmatched result itself', () => {
    // An unmatched result is a block of its own: it never reaches the block
    // renderer, so the id is stripped **here** or not at all.
    const blocks = renderMessages(
      [
        toolResult('r1', {
          toolUseId: 'nobody\u001b[?1049h\u001b]0;pwned\u0007',
          content: { type: 'text', text: 'the orphan body' },
          isError: false,
        }),
      ],
      ENV,
    );

    expect(blocks).toEqual(['● unmatched tool result\n  ⎿  toolUseId: nobody']);
  });

  it('strips the tool block itself', () => {
    const block = renderToolBlock(
      'Bash\u001b[?1049h\u001b]0;pwned\u0007',
      'ls\u001b]0;pwned\u0007',
      ['out\u001b[2J\u001b]0;pwned\u0007'],
      ENV,
    );

    expect(block).toBe('● Bash(ls)\n  ⎿  out');
  });

  it('does not render an empty parenthesis for a summary that is only an escape', () => {
    // The summary is tested **after** it is stripped: a summary that is only
    // an escape is an empty summary, and an empty summary has no parentheses.
    const block = renderToolBlock('Bash', '\u001b[2J\u001b]0;pwned\u0007', [], ENV);

    expect(block).toBe('● Bash');
  });

  it('strips the tool name in the approval prompt itself', () => {
    const prompt = renderApprovalPrompt(
      {
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'other',
        reason: 'No permission rule matched.',
      },
      'Bash\u001b[?1049h\u001b]0;pwned\u0007',
    );

    expect(prompt).toContain('Bash command');
    expect(prompt).not.toContain('\u001b');
    expect(prompt).not.toContain('pwned');
  });

  it('strips the reason in the approval prompt itself', () => {
    const prompt = renderApprovalPrompt(
      {
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'other',
        reason: 'No rule matched.\u001b[?1049h\u001b]0;pwned\u0007',
      },
      'Bash',
    );

    expect(prompt).toBe(
      [
        'Bash command',
        'Do you want to proceed?',
        '',
        'No rule matched.',
        '',
        '❯ Yes ✔',
        "  Yes, and don't ask again for this Bash call",
        '  No, and tell Claude what to do differently (esc)',
        '',
        'enter to confirm · esc to cancel',
      ].join('\n'),
    );
  });

  it('strips the tool name in the approval choices themselves', () => {
    // The prompt strips the name before it hands it to the choices, so the
    // choices have to strip it **themselves** to be safe on their own.
    const choices = approvalChoices('Bash\u001b[?1049h\u001b]0;pwned\u0007');

    expect(choices[1]?.label).toBe("Yes, and don't ask again for this Bash call");
  });

  it('strips the approval prompt itself', () => {
    const prompt = renderApprovalPrompt(
      {
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'other',
        reason: 'No rule matched.\u001b[2J\u001b]0;pwned\u0007',
      },
      'Bash\u001b]0;pwned\u0007',
    );

    expect(prompt).toBe(
      [
        'Bash command',
        'Do you want to proceed?',
        '',
        'No rule matched.',
        '',
        '❯ Yes ✔',
        "  Yes, and don't ask again for this Bash call",
        '  No, and tell Claude what to do differently (esc)',
        '',
        'enter to confirm · esc to cancel',
      ].join('\n'),
    );
  });

  it('strips the typed line itself', () => {
    expect(inputEcho('x\u001b[?1049h', ENV)).not.toContain('\u001b');
    expect(inputEcho('x\u001b]0;pwned\u0007', ENV)).not.toContain('\u001b');
  });

  it('strips the markdown itself', () => {
    expect(renderMarkdown('a\u001b[2Jb\u001b]0;pwned\u0007', ENV)).toBe('ab');
  });

  it('strips the approval label itself', () => {
    expect(approvalLabel('Bash\u001b]0;pwned\u0007')).toBe('Approval required for Bash');
    expect(approvalLabel('')).toBe('Approval required for the tool');
  });
});

/* -------------------------------------------------------------------------- */
/* The shared scanner                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The **shared** scanner is the only escape-handling code in the renderers.
 *
 * The renderers strip for themselves, and every one of those strips is the
 * **same** scanner: the one the markdown renderer uses. A second scanner —
 * a second, weaker one in particular — would be a second set of rules for
 * the same job, and the paths that mask each other would hide it.
 *
 * The guard is **structural** as well as behavioural: a second scanner has
 * to name the escape character, and only the shared scanner does — it
 * compares **code points**, so it never writes the character down at all.
 */
describe('the shared scanner — the only escape-handling code', () => {
  /** The renderers, and the app that mounts them. */
  const RENDERERS = [
    'src/ui/render/markdown.ts',
    'src/ui/render/messages.ts',
    'src/ui/render/prompts.ts',
    'src/ui/app.ts',
  ] as const;

  /** The number of strip sites in the renderers this task owns. */
  const STRIP_SITES: ReadonlyMap<string, number> = new Map([
    ['src/ui/render/messages.ts', 11],
    ['src/ui/render/prompts.ts', 4],
  ]);

  it('never writes the escape character down outside the shared scanner', () => {
    // **What this covers**: a second scanner in a renderer that names the
    // escape character **as a literal** — as `\u001b`, `\x1b`, `\033`,
    // `\u{1b}` or `0x1b`. It does **not** cover a scanner that computes the
    // character (`String.fromCharCode(27)`) or that embeds a raw byte; the
    // **behavioural** per-site tests cover those, because they assert the
    // rendered text rather than the source.

    for (const file of RENDERERS) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

      // A second scanner would have to name the escape character: as a
      // literal escape, or as the byte it stands for.
      expect(source, file).not.toMatch(/\\u001[bB]|\\x1[bB]|\\033|\\u\{1[bB]\}/);
      // The shared scanner is the one that compares code points, so only it
      // may name the byte.
      if (file !== 'src/ui/render/markdown.ts') {
        expect(source, file).not.toMatch(/0x1b/i);
      }
    }
  });

  it('gives every strip site in the two renderers a named test', () => {
    // **What this covers**: the two renderer modules this task owns. It is a
    // **count**, so a rename of the shared scanner, `lines.map(...)` in
    // place of an arrow, or a comment mentioning `stripControlSequences(` all
    // break it — it is a tripwire, not a proof. A site added to
    // `src/ui/app.ts` or `src/ui/render/markdown.ts` is **not** covered by
    // it; those two files' sites are pinned by their own behavioural tests.
    for (const [file, sites] of STRIP_SITES) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      const calls = source.split('stripControlSequences(').length - 1;

      // Every one of the sites above has a test named after it. A site added
      // without one breaks this count, and a site that stopped stripping
      // breaks the test it is named by.
      expect(calls, file).toBe(sites);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The exported result reader                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The exported reader is a **public** function, and its decision argument is
 * **caller-supplied**. The fold normalises the decision before it hands it
 * over, so the reader never sees an unknown behaviour in production — but
 * the reader must not **depend** on its only caller to fail closed.
 */
describe('toolResultLines — the exported result reader', () => {
  it('fails closed on a behaviour outside the closed vocabulary', () => {
    // The types forbid it, but a caller can still build one at runtime. The
    // permission layer's own rule treats an unknown behaviour as the
    // **strictest**, and the reader shares that rule: the call is marked as
    // a denial rather than shown as a call that was allowed.
    const outside = {
      behavior: 'maybe',
      source: 'hook',
      reasonType: 'safetyCheck',
      reason: 'An unknown behaviour decided this call.',
    } as unknown as PermissionDecision;

    const lines = toolResultLines(undefined, outside);

    expect(lines).toEqual([
      'denied (source: hook, reason type: safetyCheck)',
      'An unknown behaviour decided this call.',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The Ink harness                                                             */
/* -------------------------------------------------------------------------- */

/** A stream that collects what is written to it. */
interface CapturedStream extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns: number;
  rows: number;
}

/**
 * A stream that collects what is written to it.
 *
 * The stream is **not** a terminal — the app is exercised without one — but it
 * can be told to look like one, which is what the alternate-screen test needs:
 * Ink only enters the alternate screen on a real TTY, so a test that does not
 * pretend to be one would pass whether the app asked for it or not.
 */
function captureStream(options: { isTTY?: boolean } = {}): {
  stream: CapturedStream;
  text: () => string;
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      callback();
    },
  }) as unknown as CapturedStream;
  stream.columns = 80;
  stream.rows = 24;
  if (options.isTTY === true) stream.isTTY = true;
  return { stream, text: () => chunks.join('') };
}

/**
 * A standard input that looks like a terminal.
 *
 * Ink only reads the input of a stream that is a terminal and can be put into
 * raw mode, so the fake carries both.
 */
function terminalStdin(): PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => unknown;
} {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => unknown;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  return stdin;
}

/** The streams a mount needs, with the terminal replaced by a collector. */
function mountStreams(): {
  stdout: CapturedStream;
  stdin: PassThrough;
  stderr: Writable;
  text: () => string;
} {
  const { stream, text } = captureStream({ isTTY: true });
  const stdin = new PassThrough();
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return { stdout: stream, stdin, stderr, text };
}

/**
 * Mount the app with **the app's own options**.
 *
 * The mount goes through `renderApp`, so the options are this implementation's own:
 * `alternateScreen: false`, `incrementalRendering: true`, the streaming frame
 * rate and the screen-reader switch read from the environment. A test that
 * mounted through Ink's `render` directly would not exercise any of them.
 *
 * What is returned is the **frame** — what was on the terminal — and not the
 * teardown. Ink writes a `show cursor` sequence when the instance is
 * unmounted, and that sequence is Ink's own, not the app's; collecting the
 * frame before the unmount is what lets a test say that the frame carries
 * **no** escape sequence at all.
 */
async function mountApp(props: AppProps, options: RenderOptions = {}): Promise<string> {
  const { stdout, stdin, stderr, text } = mountStreams();
  const instance = renderApp(props, {
    stdout,
    stdin,
    stderr,
    debug: true,
    patchConsole: false,
    ...options,
  });
  await instance.waitUntilRenderFlush();
  const frame = text();
  instance.unmount();
  return frame;
}

/**
 * Mount the app with a **terminal** input, so a key can be pressed.
 *
 * The keystrokes go through Ink's own input pipeline, so what the test presses
 * is what a terminal would send.
 */
async function mountWithKeys(
  props: AppProps,
): Promise<{ text: () => string; press: (key: string) => Promise<void>; instance: Instance }> {
  const { stream, text } = captureStream({ isTTY: true });
  const stdin = terminalStdin();
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const instance = renderApp(props, {
    stdout: stream,
    stdin,
    stderr,
    debug: true,
    patchConsole: false,
  });
  await instance.waitUntilRenderFlush();

  const press = async (key: string): Promise<void> => {
    stdin.write(key);
    // Ink holds a lone escape back for 20 ms, waiting to see whether it is
    // the start of a sequence, so the wait has to be longer than that.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await instance.waitUntilRenderFlush();
  };

  return { text, press, instance };
}

/** The events the app-level tests show. */
const APP_EVENTS: SessionEvent[] = [
  { v: SESSION_SCHEMA_VERSION, ts: 1, id: 'a1', t: 'assistant_message', text: 'Hello there.' },
  { v: SESSION_SCHEMA_VERSION, ts: 2, id: 'c1', t: 'tool_call', name: 'Bash', input: { command: 'ls -la' } },
  {
    v: SESSION_SCHEMA_VERSION,
    ts: 3,
    id: 'r1',
    t: 'tool_result',
    envelope: {
      toolUseId: 'c1',
      content: { type: 'text', text: 'file1' },
      isError: false,
    },
  },
];

/** The approval the app-level tests show. */
const APP_APPROVAL = {
  decision: {
    behavior: 'ask' as const,
    source: 'unknown' as const,
    reasonType: 'other' as const,
    reason: 'No permission rule matched.',
  },
  toolName: 'Bash',
};

/**
 * Run a body with the screen-reader switch on, and restore it afterwards.
 */
async function withScreenReader(body: () => Promise<string>): Promise<string> {
  const previous = process.env['INK_SCREEN_READER'];
  process.env['INK_SCREEN_READER'] = 'true';
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env['INK_SCREEN_READER'];
    else process.env['INK_SCREEN_READER'] = previous;
  }
}

describe('the app — the screen-reader tree', () => {
  it('exposes an ARIA role and a label for the message list, the input and the approval prompt', async () => {
    const output = await withScreenReader(() =>
      mountApp({ events: APP_EVENTS, input: 'what next?', approval: APP_APPROVAL }),
    );

    expect(output).toContain('list: Conversation');
    expect(output).toContain('textbox: Message input');
    expect(output).toContain('listbox: Approval required for Bash');
  });

  it('announces the messages as the items of the list', async () => {
    const output = await withScreenReader(() =>
      mountApp({ events: APP_EVENTS, input: 'what next?', approval: APP_APPROVAL }),
    );

    // The target labels its **gutters**: the assistant's bullet is announced
    // as `claude:` and the tool call's as `tool:` (§3.3, §3.5).
    expect(output).toContain('listitem: claude:   Hello there.');
    expect(output).toContain('listitem: tool:   Bash (ls -la)');
  });

  it('announces the three approval choices as options', async () => {
    const output = await withScreenReader(() =>
      mountApp({ events: APP_EVENTS, input: 'what next?', approval: APP_APPROVAL }),
    );

    expect(output).toContain('option: Yes');
    expect(output).toContain("option: Yes, and don't ask again for this Bash call");
    expect(output).toContain('option: No, and tell Claude what to do differently (esc)');
  });

  it('still announces the content of the regions it labels', async () => {
    const output = await withScreenReader(() =>
      mountApp({ events: APP_EVENTS, input: 'what next?', approval: APP_APPROVAL }),
    );

    // Ink replaces the content of a labelled node with the label, so this implementation
    // renders the content beside the labelled node: the label is announced
    // *and* the conversation is.
    expect(output).toContain('Hello there.');
    expect(output).toContain('what next?');
    expect(output).toContain('No permission rule matched.');
  });

  it('puts no escape sequence on the terminal through the approval label', async () => {
    // The ARIA label reaches the terminal through **Ink's** sanitiser, and
    // Ink's sanitiser **preserves** OSC sequences — so a label that carried
    // one would put it on the terminal verbatim. Only the **mount** can show
    // that the label does not, which is why this test mounts the app.
    const output = await withScreenReader(() =>
      mountApp({
        events: APP_EVENTS,
        input: 'what next?',
        approval: {
          decision: APP_APPROVAL.decision,
          toolName: 'Bash\u001b]0;pwned\u0007',
        },
      }),
    );

    expect(output).toContain('listbox: Approval required for Bash');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('pwned');
  });

  it('reads the screen-reader switch from the environment', () => {
    const previous = process.env['INK_SCREEN_READER'];
    try {
      delete process.env['INK_SCREEN_READER'];
      expect(appRenderOptions().isScreenReaderEnabled).toBe(false);
      process.env['INK_SCREEN_READER'] = 'false';
      expect(appRenderOptions().isScreenReaderEnabled).toBe(false);
      process.env['INK_SCREEN_READER'] = 'true';
      expect(appRenderOptions().isScreenReaderEnabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['INK_SCREEN_READER'];
      else process.env['INK_SCREEN_READER'] = previous;
    }
  });
});

describe('the app — the input echo', () => {
  it('strips the control sequences the typed text could carry', () => {
    expect(inputEcho('\u001b[?1049h', ENV)).not.toContain('\u001b');
    expect(inputEcho('\u001b[?1049h', ENV)).not.toContain('1049');
    expect(inputEcho('hello', ENV)).toBe('❯\u00A0hello');
    expect(inputEcho('', ENV)).toBe('');
  });

  it('does not write a control sequence the typed text carried', async () => {
    const output = await mountApp({ events: APP_EVENTS, input: 'x\u001b[?1049h' });

    expect(output).not.toContain('\u001b[?1049h');
  });
});

describe('the app — the scrollback', () => {
  it('does not ask for the alternate screen', () => {
    expect(appRenderOptions().alternateScreen).toBe(false);
  });

  it('enables incremental rendering and tunes the frame rate for streaming', () => {
    const options = appRenderOptions();
    expect(options.incrementalRendering).toBe(true);
    // The rate is a documented implementation choice: a streaming turn rewrites only
    // the lines that changed, so 60 frames a second is affordable.
    expect(STREAMING_MAX_FPS).toBe(60);
    expect(options.maxFps).toBe(60);
  });

  it('does not let Ink exit on ctrl+c, because the target\'s chord is a gesture', () => {
    // The target's `ctrl+c` is `app:interrupt`, and the exit is a **two-press**
    // gesture: `Press ctrl+c again to exit` (§12.3).
    expect(appRenderOptions().exitOnCtrlC).toBe(false);
  });

  it('never writes the alternate-screen sequences to the terminal', async () => {
    // The mount is forced into interactive mode on a stream that looks like a
    // terminal, so Ink *would* enter the alternate screen if the app asked it
    // to. A test that did not pretend to be a terminal would pass either way.
    const { stream, text } = captureStream({ isTTY: true });
    const stdin = new PassThrough();
    const stderr = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const instance = renderApp(
      { events: APP_EVENTS, input: 'what next?' },
      { stdout: stream, stdin, stderr, interactive: true, patchConsole: false },
    );
    await instance.waitUntilRenderFlush();
    instance.unmount();

    const written = text();
    expect(written).not.toContain('\u001b[?1049h');
    expect(written).not.toContain('\u001b[?1049l');
  });
});

describe('the app — the mounted view', () => {
  it('shows the conversation the plan\'s renderers produce', async () => {
    const output = await mountApp({ events: APP_EVENTS, input: 'what next?' });

    expect(output).toContain('● Hello there.');
    expect(output).toContain('● Bash(ls -la)');
    expect(output).toContain('❯\u00A0what next?');
  });

  it('shows the target\'s placeholder when the line is empty', async () => {
    const output = await mountApp({ events: APP_EVENTS, input: '' });

    expect(output).toContain('Try "fix lint errors"');
  });

  it('shows the approval dialog, with the target\'s title, question and options', async () => {
    const output = await mountApp({ events: APP_EVENTS, input: '', approval: APP_APPROVAL });

    expect(output).toContain('Bash command');
    expect(output).toContain('Do you want to proceed?');
    expect(output).toContain('❯ Yes');
    expect(output).toContain('No, and tell Claude what to do differently (esc)');
    expect(output).toContain('enter to confirm · esc to cancel');
  });

  it('shows the hint line', async () => {
    const output = await mountApp({ events: APP_EVENTS, input: '', approval: APP_APPROVAL });

    expect(output).toContain('Waiting for permission…');
    expect(output).toContain('? for shortcuts');
  });

  it('strips the control sequences the status line could carry', async () => {
    // The status line is the last string in the app that is not stripped, and
    // it is caller-supplied: it is whatever the caller put in it. The mount is
    // the screen-reader one, because that is the path Ink's sanitiser keeps an
    // OSC sequence on: the cell layout of the normal path drops it.
    const output = await withScreenReader(() =>
      mountApp({
        events: APP_EVENTS,
        input: 'what next?',
        status: 'thinking\u001b]0;pwned\u0007',
      }),
    );

    expect(output).toContain('thinking');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('pwned');
  });
});

describe('the app — the shortcuts overlay', () => {
  it('opens on `?` and closes on escape', async () => {
    const mounted = await mountWithKeys({
      events: APP_EVENTS,
      input: '',
      onInputChange: () => undefined,
    });

    // The overlay is closed at first.
    expect(mounted.text()).not.toContain('double tap esc to clear input');

    // The terminal collects every frame, so what a press *wrote* is the text
    // that came after it.
    const before = mounted.text().length;
    await mounted.press('?');
    expect(mounted.text().slice(before)).toContain('double tap esc to clear input');
    expect(mounted.text()).toContain('/keybindings to customize');

    const afterOpen = mounted.text().length;
    await mounted.press('\u001b');
    expect(mounted.text().slice(afterOpen)).not.toContain('double tap esc to clear input');
    mounted.instance.unmount();
  });

  it('lets a question mark be typed into a line that has content', async () => {
    const typed: string[] = [];
    const mounted = await mountWithKeys({
      events: APP_EVENTS,
      input: 'what',
      onInputChange: (text: string) => {
        typed.push(text);
      },
    });

    await mounted.press('?');
    expect(typed).toEqual(['what?']);
    expect(mounted.text()).not.toContain('double tap esc to clear input');
    mounted.instance.unmount();
  });
});

describe('the app — the two gestures', () => {
  it('arms the escape gesture and clears the line on the second press', async () => {
    let current = 'half a line';
    const changes: string[] = [];
    const mounted = await mountWithKeys({
      events: APP_EVENTS,
      input: current,
      onInputChange: (text: string) => {
        current = text;
        changes.push(text);
      },
    });

    // The first escape shows the toast and clears **nothing**.
    await mounted.press('\u001b');
    expect(mounted.text()).toContain(ESCAPE_AGAIN_MESSAGE);
    expect(changes).toEqual([]);

    // The second escape clears the line.
    await mounted.press('\u001b');
    expect(changes).toEqual(['']);
    mounted.instance.unmount();
  });

  it('arms the interrupt gesture and exits on the second press', async () => {
    const mounted = await mountWithKeys({
      events: APP_EVENTS,
      input: 'hello',
      // The app takes the terminal over when it is given something to report
      // back, so the chord has to have a listener.
      onInputChange: () => undefined,
    });

    // The first `ctrl+c` shows the toast and exits **nothing**.
    await mounted.press('\u0003');
    expect(mounted.text()).toContain(INTERRUPT_AGAIN_MESSAGE);

    // The second one ends the session.
    await mounted.press('\u0003');
    await mounted.instance.waitUntilExit();
    expect(mounted.text()).toContain(INTERRUPT_AGAIN_MESSAGE);
  });
});
