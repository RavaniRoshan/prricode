/**
 * Contract test for the **interactive terminal UI**'s renderers.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.10 (The
 * command-line surface) and the `CC-015` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
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
 *      **reason type**, so a reader can tell *who* refused the call and *why
 *      kind* of refusal it was.
 *   3. A **sandboxed** run's status is shown: whether the command ran inside
 *      the sandbox, and — when it did not — the reason it did not.
 *   4. The renderers are **pure** and **deterministic**.
 *   5. A **caller-supplied** tool name (or input) never reaches a plain-object
 *      lookup: `constructor` and `__proto__` are ordinary names here, and the
 *      renderer must not resolve them to `Object.prototype` members.
 *   6. A **partially-streamed** markdown fragment renders as text: it is never
 *      thrown away and it never throws.
 *   7. A **fenced code block** keeps its language, and the block cannot break
 *      out of its fence.
 *   8. The markdown renderer is **safe against hostile input**: it evaluates
 *      nothing, and it strips the control sequences a model could use to
 *      rewrite the terminal.
 *   9. The **screen-reader tree** names the message list, the input and the
 *      approval prompt: each of the three has an ARIA role and a label.
 *  10. The app does **not** enter the alternate screen, so the content that
 *      was on the terminal before the session started stays in the scrollback.
 */

import { PassThrough, Writable } from 'node:stream';

import { render, type RenderOptions } from 'ink';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SESSION_SCHEMA_VERSION, type SessionEvent } from '../../src/session/event.js';
import type { ToolResultEnvelope } from '../../src/tools/runner.js';
import { App, appRenderOptions, renderApp } from '../../src/ui/app.js';
import { renderMarkdown } from '../../src/ui/render/markdown.js';
import { renderConversation, renderMessages } from '../../src/ui/render/messages.js';
import { renderApprovalPrompt } from '../../src/ui/render/prompts.js';

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

/** The `Bash` tool's output shape. */
function bashOutput(overrides: Partial<{
  text: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  sandboxed: boolean;
  sandboxReason: string;
  sandboxExemptions: readonly string[];
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
    ...(overrides.sandboxExemptions === undefined
      ? {}
      : { sandboxExemptions: overrides.sandboxExemptions }),
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
      {
        ...base('p1'),
        t: 'permission_request',
        toolName: 'Bash',
        decision: {
          behavior: 'deny',
          source: 'hook',
          reasonType: 'safetyCheck',
          reason: 'A safety check refused this Bash call.',
        },
      },
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
      toolCall('c1', 'Bash', { command: 'git status' }),
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
    expect(blocks[0]).toContain('git');
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

  it('treats a caller-supplied tool name as data, never as a lookup key', () => {    const blocks = renderMessages([
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

  it('keeps the language of a fenced code block of a single line', () => {
    // A block of one line is the case a formatter that only labels a boxed
    // block loses: the language must survive it too.
    const rendered = renderMarkdown('```rust\nfn main() {}\n```');

    expect(rendered).toContain('rust');
    expect(rendered).toContain('fn main() {}');
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
 * Mount a tree with Ink and collect what it wrote.
 *
 * The mount is a **real** Ink instance — the same one the CLI mounts — with
 * the terminal replaced by a collector. `debug: true` makes every frame go
 * out as it is rendered, so the collected text is the frame itself.
 */
async function mount(node: ReactNode, options: RenderOptions = {}): Promise<string> {
  const { stream, text } = captureStream({ isTTY: true });
  const stdin = new PassThrough();
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  const instance = render(node, {
    stdout: stream,
    stdin,
    stderr,
    debug: true,
    patchConsole: false,
    ...options,
  });
  await instance.waitUntilRenderFlush();
  instance.unmount();
  return text();
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

describe('the app — the screen-reader tree', () => {
  it('exposes an ARIA role and a label for the message list, the input and the approval prompt', async () => {
    const previous = process.env['INK_SCREEN_READER'];
    process.env['INK_SCREEN_READER'] = 'true';
    let output: string;
    try {
      output = await mount(
        createElement(App, {
          events: APP_EVENTS,
          input: 'what next?',
          approval: {
            decision: {
              behavior: 'ask',
              source: 'unknown',
              reasonType: 'other',
              reason: 'No permission rule matched.',
            },
            toolName: 'Bash',
          },
        }),
      );
    } finally {
      if (previous === undefined) delete process.env['INK_SCREEN_READER'];
      else process.env['INK_SCREEN_READER'] = previous;
    }

    expect(output).toContain('list: Conversation');
    expect(output).toContain('textbox: Message input');
    expect(output).toContain('listbox: Approval required for Bash');
  });

  it('still announces the content of the regions it labels', async () => {
    const previous = process.env['INK_SCREEN_READER'];
    process.env['INK_SCREEN_READER'] = 'true';
    let output: string;
    try {
      output = await mount(
        createElement(App, {
          events: APP_EVENTS,
          input: 'what next?',
          approval: {
            decision: {
              behavior: 'ask',
              source: 'unknown',
              reasonType: 'other',
              reason: 'No permission rule matched.',
            },
            toolName: 'Bash',
          },
        }),
      );
    } finally {
      if (previous === undefined) delete process.env['INK_SCREEN_READER'];
      else process.env['INK_SCREEN_READER'] = previous;
    }

    // Ink replaces the content of a labelled node with the label, so this implementation
    // renders the content beside the labelled node: the label is announced
    // *and* the conversation is.
    expect(output).toContain('Hello there.');
    expect(output).toContain('what next?');
    expect(output).toContain('No permission rule matched.');
  });
});

describe('the app — the scrollback', () => {
  it('does not ask for the alternate screen', () => {
    expect(appRenderOptions().alternateScreen).toBe(false);
  });

  it('enables incremental rendering and tunes the frame rate for streaming', () => {
    const options = appRenderOptions();
    expect(options.incrementalRendering).toBe(true);
    expect(options.maxFps).toBeGreaterThan(0);
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
