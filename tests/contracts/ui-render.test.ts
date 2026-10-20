/**
 * Contract test for the **interactive terminal UI**'s renderers.
 *
 * Evidence: the `CC-015` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 * The audit records **no** TUI drawing at all — §2.10 is the argument parser —
 * so every string this test pins is a **implementation choice**, except the permission
 * vocabulary of §2.5 (the behavior, the source and the reason type).
 *
 * ## What this test pins
 *
 * The UI is a **renderer over the runtime**, not a second implementation: it
 * reads the same session records the headless path reads and renders them. The
 * three functions the plan fixes are therefore **pure** — they touch no
 * terminal, no clock and no filesystem — and that is what makes them testable
 * at all.
 *
 * The contracts pinned here are:
 *
 *   1. `renderMessages` produces **one block per assistant message** and **one
 *      block per tool call**, and the tool block carries the tool's result.
 *   2. A **denied** tool call is marked with the decision's **source** and its
 *      **reason type**, so a reader can tell *who* refused the call and *what
 *      kind* of refusal it was — and the **strictest** of two decisions wins.
 *   3. A **sandboxed** run's status is shown: whether the command ran inside
 *      the sandbox, why the sandbox never came up, how far the exemption list
 *      reaches, and whether the command was stopped for running too long.
 *   4. The renderers are **pure** and **deterministic**.
 *   5. A **caller-supplied** tool name (or input) never reaches a plain-object
 *      lookup: `constructor` and `__proto__` are ordinary names here, and the
 *      renderer must not resolve them to `Object.prototype` members.
 *   6. A **partially-streamed** markdown fragment renders as text: it is never
 *      thrown away and it never throws.
 *   7. A **fenced code block** keeps its language, and the block cannot break
 *      out of its fence.
 *   8. The renderers are **safe against hostile input**: they evaluate
 *      nothing, they never call a caller-supplied `toJSON`, and they strip the
 *      control sequences a model could use to rewrite the terminal — from the
 *      **code blocks**, the **tool results**, the **tool summaries** and the
 *      **approval prompt** alike.
 *   9. The **screen-reader tree** names the message list, the input and the
 *      approval prompt: each of the three has an ARIA role and a label, the
 *      messages are **items**, and the three choices are **options**.
 *  10. The app does **not** enter the alternate screen, so the content that
 *      was on the terminal before the session started stays in the scrollback.
 *  11. The **implementation's own strings** are pinned by their **content**, not by
 *      their presence: a reworded marker, a missing exemption line or a
 *      changed choice label is a change the suite must catch.
 *  12. The **strip is per path**: every path that carries a caller-supplied
 *      string strips it **itself**, and each path's stripped text is pinned
 *      **exactly** — so a path that stopped stripping, or a second and weaker
 *      scanner, is caught on its own and not by the path next to it.
 *  13. The **ARIA label** of the approval prompt and the **status line** are
 *      stripped too, and the **mounted** app puts **no** escape sequence on
 *      the terminal — the label reaches the terminal through Ink's own
 *      sanitiser, so only the mount can show that it does not.
 *  14. The **sandbox availability report** is shown: an unconfined run says
 *      why the backend was not used.
 *  15. The renderer's **strictness** rule **fails closed**: a behavior outside
 *      the closed vocabulary is the strictest, exactly as the permission
 *      layer's own rule is.
 *  16. The **shipped view** is built on the plan's `renderMessages`: the
 *      relationship is asserted **by the code** — the conversation is built
 *      from `renderMessages`' own blocks — and by a **behavioural** test (the
 *      conversation's model blocks *are* the model's blocks). It is **not**
 *      observed by spying on the call: an ESM namespace spy cannot see an
 *      intra-module call.
 */

import { PassThrough, Writable } from 'node:stream';

import type { RenderOptions } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { SESSION_SCHEMA_VERSION, type SessionEvent } from '../../src/session/event.js';
import type { PermissionDecision } from '../../src/permissions/decision.js';
import type { ToolResultEnvelope } from '../../src/tools/runner.js';
import {
  appRenderOptions,
  approvalLabel,
  inputEcho,
  renderApp,
  STREAMING_MAX_FPS,
  type AppProps,
} from '../../src/ui/app.js';
import { renderMarkdown } from '../../src/ui/render/markdown.js';
import {
  KNOWN_INPUT_FIELDS,
  renderConversation,
  renderMessages,
  renderToolBlock,
  summarizeToolInput,
  toolResultLines,
} from '../../src/ui/render/messages.js';
import { approvalChoices, renderApprovalPrompt } from '../../src/ui/render/prompts.js';

/* -------------------------------------------------------------------------- */
/* The fixtures                                                                */
/* -------------------------------------------------------------------------- */

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
    const blocks = renderMessages([
      assistant('a1', 'The first answer.'),
      assistant('a2', 'The second answer.'),
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('The first answer.');
    expect(blocks[1]).toContain('The second answer.');
  });

  it('produces one block per tool call, and the block carries the tool result', () => {
    const blocks = renderMessages([
      toolCall('c1', 'Bash', { command: 'ls -la' }),
      toolResult('r1', {
        toolUseId: 'c1',
        content: bashOutput(),
        isError: false,
      }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('Bash');
    expect(blocks[0]).toContain('ls -la');
    expect(blocks[0]).toContain('file1');
    expect(blocks[0]).toContain('file2');
  });

  it('produces one block per assistant message and one per tool call together', () => {
    const blocks = renderMessages([
      assistant('a1', 'Let me look.'),
      toolCall('c1', 'Read', { file_path: '/work/a.txt' }),
      toolResult('r1', {
        toolUseId: 'c1',
        content: { type: 'text', text: 'the file body' },
        isError: false,
      }),
      assistant('a2', 'Here is what I found.'),
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain('Let me look.');
    expect(blocks[1]).toContain('Read');
    expect(blocks[1]).toContain('/work/a.txt');
    expect(blocks[1]).toContain('the file body');
    expect(blocks[2]).toContain('Here is what I found.');
  });

  it('marks a denied tool call with the decision source and the reason type', () => {
    const blocks = renderMessages([
      toolCall('c1', 'Bash', { command: 'rm -rf /' }),
      toolResult('r1', {
        toolUseId: 'c1',
        content: { type: 'error', message: 'The Bash call was denied.', errorCode: 13 },
        isError: true,
        permissionDecision: { decision: 'deny', source: 'user_reject', reasonType: 'rule' },
      }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('user_reject');
    expect(blocks[0]).toContain('rule');
    expect(blocks[0]).toContain('denied');
  });

  it('marks a denied tool call with the source and reason type the permission request recorded', () => {
    const blocks = renderMessages([
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
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('hook');
    expect(blocks[0]).toContain('safetyCheck');
    expect(blocks[0]).toContain('A safety check refused this Bash call.');
  });

  it('keeps the strictest of two permission requests for the same call', () => {
    // The runtime checks a call twice when a hook rewrites the input: the
    // first check asks, the re-check denies. The stricter decision is the one
    // that decided the call, so it is the one the marker carries.
    const blocks = renderMessages([
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
    ]);

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
    const blocks = renderMessages([
      toolCall('c1', 'Bash', { command: 'ls' }),
      toolCall('c2', 'Bash', { command: 'rm -rf /' }),
      permissionRequest('p1', 'Bash', {
        behavior: 'deny',
        source: 'hook',
        reasonType: 'safetyCheck',
        reason: 'A safety check refused this Bash call.',
      }),
    ]);

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

    const blocks = renderMessages([
      toolCall('c1', 'Bash', { command: 'rm -rf /' }),
      permissionRequest('p1', 'Bash', {
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'other',
        reason: 'No permission rule matched.',
      }),
      permissionRequest('p2', 'Bash', outside),
    ]);

    expect(blocks[0]).toContain('denied (source: unknown, reason type: other)');
    // The unknown behaviour **won the fold**: the `ask` decision's reason is
    // not the one that is shown.
    expect(blocks[0]).toContain('An unknown behaviour decided this Bash call.');
    expect(blocks[0]).not.toContain('No permission rule matched.');
  });

  it('prefers the decision that decided the call over the first request', () => {
    // The envelope carries the decision the call was settled with; a
    // `permission_request` record is the log of the checks that led to it.
    const blocks = renderMessages([
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
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('denied (source: hook, reason type: safetyCheck)');
    expect(blocks[0]).not.toContain('source: unknown');
  });

  it('shows a sandboxed run as sandboxed', () => {
    const blocks = renderMessages([
      toolCall('c1', 'Bash', { command: 'ls -la' }),
      toolResult('r1', {
        toolUseId: 'c1',
        content: bashOutput({ sandboxed: true }),
        isError: false,
      }),
    ]);

    expect(blocks[0]).toContain('sandboxed');
  });

  it('shows the reason a run was not sandboxed, and the exemptions that applied', () => {
    const blocks = renderMessages([
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
    ]);

    expect(blocks[0]).toContain('sandbox.allowUnsandboxedCommands is true');
    // The exemption line is pinned by its **content**: the command is `ls`,
    // so the word `git` can only come from the exemption list.
    expect(blocks[0]).toContain('  ⎿ sandbox exemptions: git');
  });

  it('shows why the sandbox never came up, how far the exemptions reach, and a timeout', () => {
    const blocks = renderMessages([
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
    ]);

    expect(blocks[0]).toContain('  ⎿ sandbox not established: the bubblewrap backend is not available');
    expect(blocks[0]).toContain('  ⎿ sandbox exemption scope: all');
    expect(blocks[0]).toContain('  ⎿ timed out');
  });

  it('shows the backend\'s availability report, so an unconfined run says why', () => {
    // On the unconfined path the availability report is the **only** carrier
    // of *why the backend was not used*, so it is shown and not merely read.
    const blocks = renderMessages([
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
    ]);

    expect(blocks[0]).toContain(
      '  ⎿ sandbox backend unavailable: the bubblewrap backend is not available',
    );
  });

  it('shows what the availability probe could not establish', () => {
    const blocks = renderMessages([
      toolCall('c1', 'Bash', { command: 'ls -la' }),
      toolResult('r1', {
        toolUseId: 'c1',
        content: bashOutput({
          sandboxed: true,
          sandboxAvailability: { available: true, warning: 'the probe could not check the mount' },
        }),
        isError: false,
      }),
    ]);

    expect(blocks[0]).toContain('  ⎿ sandbox backend available');
    expect(blocks[0]).toContain('  ⎿ sandbox availability warning: the probe could not check the mount');
  });

  it('renders a tool block in this implementation\'s own shape', () => {
    const blocks = renderMessages([
      toolCall('c1', 'Bash', { command: 'ls' }),
      toolResult('r1', { toolUseId: 'c1', content: bashOutput(), isError: false }),
    ]);

    // The block's format is a implementation choice, so it is pinned whole: the marker,
    // the header, the indent, the result marker, the sandbox line, the exit
    // code and the output.
    expect(blocks[0]).toBe(
      '⏺ Bash(ls)\n  ⎿ sandboxed\n  ⎿ exit code 0\n  ⎿ file1\n  ⎿ file2',
    );
  });

  it('strips the control sequences a tool result could carry', () => {
    const blocks = renderMessages([
      toolCall('c1', 'Bash', { command: 'ls' }),
      toolResult('r1', {
        toolUseId: 'c1',
        content: { type: 'text', text: 'out\n\u001b[?1049h\n\u001b]0;pwned\u0007' },
        isError: false,
      }),
    ]);

    expect(blocks[0]).not.toContain('\u001b');
    expect(blocks[0]).not.toContain('1049');
    expect(blocks[0]).not.toContain('pwned');
    expect(blocks[0]).toContain('out');
  });

  it('strips the control sequences a tool input could carry', () => {
    const blocks = renderMessages([toolCall('c1', 'Bash', { command: 'ls\u001b[?1049h' })]);

    expect(blocks[0]).not.toContain('\u001b');
    expect(blocks[0]).not.toContain('1049');
  });

  it('never calls a caller-supplied toJSON', () => {
    const toJSON = vi.fn(() => 'leaked');
    const blocks = renderMessages([toolCall('c1', 'Mystery', { command: 'ls', toJSON })]);

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
    const blocks = renderMessages([
      toolResult('r1', {
        toolUseId: 'nobody',
        content: { type: 'text', text: 'the orphan body' },
        isError: false,
      }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe('⏺ unmatched tool result\n  ⎿ toolUseId: nobody');
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
      blocks = renderMessages(events);
    } finally {
      stdout.mockRestore();
      log.mockRestore();
    }

    expect(stdout).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(events).toEqual(before);
    expect(renderMessages(events)).toEqual(blocks);
  });

  it('treats a caller-supplied tool name as data, never as a lookup key', () => {
    const blocks = renderMessages([
      toolCall('c1', 'constructor', { command: 'ls' }),
      toolCall('c2', '__proto__', { command: 'ls' }),
      toolCall('c3', 'toString', { command: 'ls' }),
    ]);

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
    const events: SessionEvent[] = [
      { ...base('u1'), t: 'user_message', text: 'Please list the files.' },
      assistant('a1', 'Listing them now.'),
    ];

    const blocks = renderMessages(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('Listing them now.');
    expect(blocks.join('\n')).not.toContain('Please list the files.');

    const conversation = renderConversation(events);
    expect(conversation).toHaveLength(2);
    expect(conversation[0]).toContain('Please list the files.');
    expect(conversation[1]).toContain('Listing them now.');
  });

  it('builds the shipped view on the plan\'s blocks', () => {
    // The app ships the conversation; the conversation is built **on** the
    // plan's `renderMessages`, so the two cannot drift apart.
    const events: SessionEvent[] = [
      { ...base('u1'), t: 'user_message', text: 'Please list the files.' },
      assistant('a1', 'Listing them now.'),
      toolCall('c1', 'Read', { file_path: '/work/a.txt' }),
      toolResult('r1', {
        toolUseId: 'c1',
        content: { type: 'text', text: 'the file body' },
        isError: false,
      }),
    ];

    const model = renderMessages(events);
    const conversation = renderConversation(events);

    expect(model).toHaveLength(2);
    expect(conversation).toHaveLength(3);
    expect(conversation.filter((block) => model.includes(block))).toEqual(model);
    // The conversation's model blocks **are** the model's blocks, in order.
    expect(conversation).toEqual(['> Please list the files.', ...model]);
  });
});

describe('renderMarkdown — the markdown renderer', () => {
  it('renders a partially-streamed fragment as text instead of throwing', () => {
    const fragment = 'Here is a **partially streamed fra';

    let rendered: string | undefined;
    expect(() => {
      rendered = renderMarkdown(fragment);
    }).not.toThrow();
    expect(rendered).toBeDefined();
    expect(rendered ?? '').toContain('partially streamed fra');
  });

  it('renders a fragment whose fenced code block has not been closed yet', () => {
    const fragment = '```rust\nfn main() {';

    const rendered = renderMarkdown(fragment);
    expect(rendered).toContain('rust');
    expect(rendered).toContain('fn main() {');
  });

  it('renders a fenced code block with its language preserved', () => {
    const rendered = renderMarkdown('```rust\nfn main() {}\n```');

    expect(rendered).toContain('rust');
    expect(rendered).toContain('fn main() {}');
  });

  it('labels a fenced code block with its language, and shows it verbatim', () => {
    // A block of one line is the case a formatter that only labels a boxed
    // block loses: the language must survive it too. The label is pinned
    // whole, because the label's **shape** is a implementation choice.
    const rendered = renderMarkdown('```rust\nfn main() {}\n```');

    expect(rendered).toBe('[rust]\nfn main() {}');
  });

  it('does not let a fenced code block break out of its fence', () => {
    const source = ['```ts', '**not bold**', 'const fence = "```";', '```'].join('\n');

    const rendered = renderMarkdown(source);
    // The markdown syntax inside the block stays literal: it was never parsed.
    expect(rendered).toContain('**not bold**');
    // The closing fence inside the block did not close the block.
    expect(rendered).toContain('const fence = "```";');
  });

  it('evaluates nothing', () => {
    const rendered = renderMarkdown('Run `process.exit(1)` to stop.');

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

    const rendered = renderMarkdown(hostile);

    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\u0007');
    expect(rendered).not.toContain('pwned');
    expect(rendered).not.toContain('1049');
    expect(rendered).toContain('plain text');
  });

  it('drops the payload of a C1 control sequence, not only its introducer', () => {
    // 0x9b is the 8-bit CSI: a terminal that accepts it acts on `2J` exactly
    // as it acts on the 7-bit form, so the parameters go with the introducer.
    const rendered = renderMarkdown('a\u009b2Jb');

    expect(rendered).not.toContain('\u009b');
    expect(rendered).not.toContain('2J');
    expect(rendered).toBe('ab');
  });

  it('is pure: it writes to no terminal', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let rendered: string | undefined;
    try {
      rendered = renderMarkdown('# A heading\n\nSome **text**.');
    } finally {
      stdout.mockRestore();
    }

    expect(stdout).not.toHaveBeenCalled();
    expect(rendered).toContain('A heading');
    expect(rendered).toContain('Some text.');
  });
});

describe('renderApprovalPrompt — the approval prompt', () => {
  it('names the tool, gives the reason and offers the choices', () => {
    const prompt = renderApprovalPrompt(
      {
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'other',
        reason: 'No permission rule matched, so this Bash call requires approval.',
      },
      'Bash',
    );

    expect(prompt).toContain('Bash');
    expect(prompt).toContain('No permission rule matched');
    expect(prompt).toContain('1. Yes');
    expect(prompt).toContain("don't ask again");
    expect(prompt).toContain('3. No');
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
    expect(prompt).not.toContain('1. Yes');
  });

  it('offers exactly the three choices, in this implementation\'s own wording', () => {
    const prompt = renderApprovalPrompt(
      {
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'other',
        reason: 'No permission rule matched.',
      },
      'Bash',
    );

    expect(prompt).toContain('❯ 1. Yes');
    expect(prompt).toContain("2. Yes, and don't ask again for this Bash call");
    expect(prompt).toContain('3. No, and tell the assistant what to do differently');
    // This implementation is an independent implementation: it never names a product.
    expect(prompt).not.toContain('Agent');
  });

  it('numbers the choices from one', () => {
    const choices = approvalChoices('Bash');

    expect(choices.map((choice) => choice.number)).toEqual([1, 2, 3]);
    expect(choices.map((choice) => choice.label)).toEqual([
      'Yes',
      "Yes, and don't ask again for this Bash call",
      'No, and tell the assistant what to do differently',
    ]);
    expect(choices[0]?.marker).toBe('❯');
    expect(choices[1]?.marker).toBe(' ');
  });

  it('does not call a Write a command, and does not oversell the grant', () => {
    const prompt = renderApprovalPrompt(
      {
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'other',
        reason: 'No permission rule matched.',
      },
      'Write',
    );

    expect(prompt).toContain('Write needs your approval.');
    expect(prompt).not.toContain('command');
    // The permission layer persists one rule per sub-command that needs
    // approval, capped at five: the label must not promise a wider grant.
    expect(prompt).toContain("don't ask again for this Write call");
  });

  it('strips the control sequences a tool name or a reason could carry', () => {
    const prompt = renderApprovalPrompt(
      {
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'other',
        reason: 'No permission rule matched.\u001b[?1049h',
      },
      'Bash\u001b[?1049h',
    );

    expect(prompt).not.toContain('\u001b');
    expect(prompt).not.toContain('1049');
    expect(prompt).toContain('Bash');
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

  it('strips the tool block itself', () => {
    const block = renderToolBlock('Bash\u001b[?1049h', 'ls\u001b]0;pwned\u0007', ['out\u001b[2J']);

    expect(block).toBe('⏺ Bash(ls)\n  ⎿ out');
  });

  it('does not render an empty parenthesis for a summary that is only an escape', () => {
    // The summary is tested **after** it is stripped: a summary that is only
    // an escape is an empty summary, and an empty summary has no parentheses.
    const block = renderToolBlock('Bash', '\u001b[2J', []);

    expect(block).toBe('⏺ Bash');
  });

  it('strips the tool summary itself', () => {
    expect(summarizeToolInput('Bash', { command: 'ls\u001b[?1049h' })).toBe('ls');
    expect(summarizeToolInput('Bash', { command: 'ls\u001b]0;pwned\u0007' })).toBe('ls');
  });

  it('strips the approval prompt itself', () => {
    const prompt = renderApprovalPrompt(
      {
        behavior: 'ask',
        source: 'unknown',
        reasonType: 'other',
        reason: 'No rule matched.\u001b[2J',
      },
      'Bash\u001b]0;pwned\u0007',
    );

    expect(prompt).toBe(
      [
        'Bash needs your approval.',
        '',
        'No rule matched.',
        '',
        '❯ 1. Yes',
        "  2. Yes, and don't ask again for this Bash call",
        '  3. No, and tell the assistant what to do differently',
      ].join('\n'),
    );
  });

  it('strips the typed line itself', () => {
    expect(inputEcho('x\u001b[?1049h')).toBe('> x');
    expect(inputEcho('x\u001b]0;pwned\u0007')).toBe('> x');
  });

  it('strips the markdown itself', () => {
    expect(renderMarkdown('a\u001b[2Jb')).toBe('ab');
  });

  it('strips the approval label itself', () => {
    expect(approvalLabel('Bash\u001b]0;pwned\u0007')).toBe('Approval required for Bash');
    expect(approvalLabel('')).toBe('Approval required for the tool');
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

/** Run a body with the screen-reader switch on, and restore it afterwards. */
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

    expect(output).toContain('listitem: ⏺ Hello there.');
    expect(output).toContain('listitem: ⏺ Bash(ls -la)');
  });

  it('announces the three approval choices as options', async () => {
    const output = await withScreenReader(() =>
      mountApp({ events: APP_EVENTS, input: 'what next?', approval: APP_APPROVAL }),
    );

    expect(output).toContain('option: 1. Yes');
    expect(output).toContain("option: 2. Yes, and don't ask again for this Bash call");
    expect(output).toContain('option: 3. No, and tell the assistant what to do differently');
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
    expect(inputEcho('\u001b[?1049h')).not.toContain('\u001b');
    expect(inputEcho('\u001b[?1049h')).not.toContain('1049');
    expect(inputEcho('hello')).toBe('> hello');
    expect(inputEcho('')).toBe('');
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

    expect(output).toContain('⏺ Hello there.');
    expect(output).toContain('⏺ Bash(ls -la)');
    expect(output).toContain('> what next?');
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
