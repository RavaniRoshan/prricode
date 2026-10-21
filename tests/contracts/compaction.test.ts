/**
 * Contract test for the compaction behaviour.
 *
 * The evidence is the REA record
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-compaction.md` — the
 * reading of the target's own bundle, with the file and the byte offset of
 * every claim — and the `CC-023` milestone of the implementation plan.
 *
 * The five things the milestone names are the five things this file pins:
 * the **trigger**, the **boundary**, the **summary's shape**, the
 * **projection** and the **fallback ordering**.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentRuntime, type TurnInput } from '../../src/agent/loop.js';
import { TURN_SOURCE } from '../../src/agent/context.js';
import type { PermissionDecision } from '../../src/permissions/decision.js';
import type {
  ProviderDriver,
  ProviderEvent,
  ProviderRequest,
} from '../../src/provider/drivers/types.js';
import { createSessionStore, projectDirectoryName } from '../../src/session/store.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import {
  AUTO_COMPACT_BLOCK_MARGIN,
  AUTO_COMPACT_OUTPUT_RESERVE,
  AUTO_COMPACT_THRESHOLD_MARGIN,
  AUTO_COMPACT_WARN_MARGIN,
  COMPACT_FALLBACK_ORDER,
  COMPACT_FOREIGN_ARTIFACT_NOTICE,
  COMPACT_PROMPT_TOO_LONG,
  COMPACT_PROMPT_TOO_LONG_RETRIES,
  COMPACT_RESUME_GUIDANCE,
  COMPACT_RESUME_TAIL,
  COMPACT_RETRY_MARKER,
  COMPACT_ROUTER_ORDER,
  COMPACT_SUMMARY_PREAMBLE,
  COMPACT_SUMMARY_SYSTEM_PROMPT,
  autoCompactDecision,
  autoCompactThreshold,
  bytesPerTokenFor,
  compact,
  compactRetryMessages,
  compactSummaryContent,
  compactSummaryPrompt,
  estimateConversationTokens,
  normaliseCompactSummary,
  projectCompactedContext,
  type AutoCompactWindow,
} from '../../src/session/compaction.js';
import type { ProviderMessage } from '../../src/provider/drivers/types.js';
/** A window with room in it: 200 000 tokens of context, 8 192 of output. */
const WINDOW: AutoCompactWindow = {
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

/**
 * The threshold of {@link WINDOW}.
 *
 * The reserve is `min(maxOutputTokens, 20000)`, so the threshold of a 200 000
 * token window with an 8 192 token output budget is
 * `200000 − 8192 − 13000`.
 */
const THRESHOLD = 200_000 - 8_192 - AUTO_COMPACT_THRESHOLD_MARGIN;

/** The effective window of {@link WINDOW}. */
const EFFECTIVE = 200_000 - 8_192;

describe('the compaction trigger', () => {
  it('is a token count measured against the model\'s own window', () => {
    // The target's threshold is `contextWindow − min(maxOutputTokens, 20000)
    // − 13000` — the reading's §1.1.
    expect(AUTO_COMPACT_OUTPUT_RESERVE).toBe(20000);
    expect(AUTO_COMPACT_THRESHOLD_MARGIN).toBe(13000);
    expect(THRESHOLD).toBe(178_808);
    expect(autoCompactThreshold(WINDOW)).toBe(178_808);
  });

  it('reserves the output budget, and never more than the target\'s reserve', () => {
    // A model whose output budget is larger than the reserve still only loses
    // the reserve: `min(maxOutputTokens, 20000)`.
    expect(autoCompactThreshold({ contextWindow: 200_000, maxOutputTokens: 64_000 })).toBe(
      200_000 - AUTO_COMPACT_OUTPUT_RESERVE - AUTO_COMPACT_THRESHOLD_MARGIN,
    );
    expect(autoCompactThreshold({ contextWindow: 200_000, maxOutputTokens: 1_000 })).toBe(
      200_000 - 1_000 - AUTO_COMPACT_THRESHOLD_MARGIN,
    );
  });

  it('warns below the threshold, compacts at it and blocks above the window', () => {
    // The reading's §1.2 — the four levels of the target's `qqe`.
    expect(AUTO_COMPACT_WARN_MARGIN).toBe(20000);
    expect(AUTO_COMPACT_BLOCK_MARGIN).toBe(3000);

    expect(autoCompactDecision(THRESHOLD - 20_001, WINDOW).level).toBe('ok');
    expect(autoCompactDecision(THRESHOLD - 20_000, WINDOW).level).toBe('warn');
    expect(autoCompactDecision(THRESHOLD - 1, WINDOW).level).toBe('warn');
    expect(autoCompactDecision(THRESHOLD, WINDOW).level).toBe('compact');
    expect(autoCompactDecision(THRESHOLD + 1, WINDOW).level).toBe('compact');

    // The blocked line is the usable window less 3 000.
    const usable = 200_000 - 8_192;
    expect(autoCompactDecision(usable - AUTO_COMPACT_BLOCK_MARGIN - 1, WINDOW).level).toBe(
      'compact',
    );
    expect(autoCompactDecision(usable - AUTO_COMPACT_BLOCK_MARGIN, WINDOW).level).toBe('blocked');
  });

  it('never compacts when auto-compaction is switched off', () => {
    // The target's `qqe` only compacts when `r.enabled` — the
    // `autoCompactEnabled` setting, which is on by default.
    const decision = autoCompactDecision(THRESHOLD + 1_000, { ...WINDOW, enabled: false });
    expect(decision.level).not.toBe('compact');
    expect(decision.level).not.toBe('blocked');
    expect(autoCompactDecision(THRESHOLD + 1_000, WINDOW).level).toBe('compact');
  });

  it('lets the percentage override lower the threshold and never raise it', () => {
    // The target's `cX`: `min(floor(effective * pct / 100), effective − 13000)`.
    expect(autoCompactThreshold({ ...WINDOW, percentOverride: 50 })).toBe(
      Math.min(Math.floor(EFFECTIVE * 0.5), EFFECTIVE - AUTO_COMPACT_THRESHOLD_MARGIN),
    );
    expect(autoCompactThreshold({ ...WINDOW, percentOverride: 100 })).toBe(THRESHOLD);
    // An override outside the range is ignored.
    expect(autoCompactThreshold({ ...WINDOW, percentOverride: 0 })).toBe(THRESHOLD);
    expect(autoCompactThreshold({ ...WINDOW, percentOverride: 101 })).toBe(THRESHOLD);
  });

  it('measures the conversation in estimated tokens', () => {
    // The target's estimate is characters ÷ 4, rounded — the reading's §1.3.
    expect(estimateConversationTokens([{ role: 'user', content: 'a'.repeat(400) }])).toBe(100);
    expect(estimateConversationTokens([{ role: 'user', content: 'a'.repeat(401) }])).toBe(100);
    expect(
      estimateConversationTokens([
        { role: 'user', content: 'a'.repeat(400) },
        { role: 'assistant', content: 'b'.repeat(400) },
      ]),
    ).toBe(200);
    // A tool use is its name plus the JSON of its input.
    expect(
      estimateConversationTokens([
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } }],
        },
      ]),
    ).toBe(Math.round(('Read' + JSON.stringify({ path: 'a' })).length / 4));
    // The older model families take three bytes a token.
    expect(bytesPerTokenFor('claude-3-5-sonnet-20241022')).toBe(3);
    expect(bytesPerTokenFor('claude-opus-4-5')).toBe(3);
    expect(bytesPerTokenFor('claude-sonnet-4-6')).toBe(3);
    expect(bytesPerTokenFor('claude-opus-4-8')).toBe(4);
    expect(bytesPerTokenFor('claude-sonnet-5')).toBe(4);
  });

  it('reports how much of the window the conversation still has', () => {
    const decision = autoCompactDecision(THRESHOLD, WINDOW);
    expect(decision.tokens).toBe(THRESHOLD);
    expect(decision.threshold).toBe(THRESHOLD);
    expect(decision.percentLeft).toBe(0);
    expect(autoCompactDecision(THRESHOLD / 2, WINDOW).percentLeft).toBe(50);
  });
});

describe('the summary', () => {
  it('is produced by the model, and the model is told to answer in text only', () => {
    // The reading's §3.3 — the target's summarization request.
    expect(COMPACT_SUMMARY_SYSTEM_PROMPT).toBe(
      'You are a helpful AI assistant tasked with summarizing conversations.',
    );
    const prompt = compactSummaryPrompt();
    expect(prompt.startsWith('CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.')).toBe(
      true,
    );
    expect(prompt).toContain(
      'Your entire response must be plain text: an <analysis> block followed by a <summary> block.',
    );
    expect(prompt).toContain('Your task is to create a detailed summary of the conversation so far');
    expect(prompt.endsWith(
      'REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.',
    )).toBe(true);
  });

  it('carries the user\'s additional instructions when the hook added any', () => {
    // The target's `cCe` appends them under their own heading.
    const prompt = compactSummaryPrompt('focus on the tests');
    expect(prompt).toContain('\n\nAdditional Instructions:\nfocus on the tests');
    expect(compactSummaryPrompt()).not.toContain('Additional Instructions');
    expect(compactSummaryPrompt('   ')).not.toContain('Additional Instructions');
  });

  it('is normalised out of the model\'s analysis and summary tags', () => {
    // The target's `yzr` — the reading's §3.3.
    const raw = '<analysis>thinking hard</analysis><summary>the work</summary>';
    expect(normaliseCompactSummary(raw)).toBe('Summary:\nthe work');
    expect(normaliseCompactSummary('  a summary  ')).toBe('a summary');
    expect(normaliseCompactSummary('one\n\n\n\ntwo')).toBe('one\n\ntwo');
    // The target's replacements are not global: only the first block of each
    // kind is rewritten.
    expect(normaliseCompactSummary('<summary>one</summary><summary>two</summary>')).toBe(
      'Summary:\none<summary>two</summary>',
    );
  });

  it('leads with the target\'s preamble and resumes without asking questions', () => {
    // The reading's §3.2 — the target's `zZ`.
    const content = compactSummaryContent('the work', { suppressFollowUpQuestions: true });
    expect(content.startsWith(`${COMPACT_SUMMARY_PREAMBLE}\n\nthe work\n`)).toBe(true);
    expect(COMPACT_SUMMARY_PREAMBLE).toBe(
      'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
    );
    expect(content).toContain(COMPACT_RESUME_GUIDANCE);
    expect(content).toContain(COMPACT_RESUME_TAIL);
    expect(content.endsWith(`${COMPACT_RESUME_GUIDANCE} ${COMPACT_RESUME_TAIL}`)).toBe(true);
  });

  it('leaves the resume guidance out when the compaction does not want it', () => {
    // The target's directional `/compact` builds the summary without it.
    const content = compactSummaryContent('the work');
    expect(content).not.toContain(COMPACT_RESUME_GUIDANCE);
    expect(content).toBe(`${COMPACT_SUMMARY_PREAMBLE}\n\nthe work`);
  });

  it('warns about foreign artifact content and points at the transcript', () => {
    // The target's `zZ` — the two conditional paragraphs.
    const content = compactSummaryContent('the work', {
      foreignArtifactContent: true,
      transcriptPath: '/tmp/transcript.jsonl',
    });
    expect(content.startsWith(COMPACT_FOREIGN_ARTIFACT_NOTICE)).toBe(true);
    expect(content).toContain(
      'If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /tmp/transcript.jsonl',
    );

    const truncated = compactSummaryContent('the work', {
      headTruncated: true,
      transcriptPath: '/tmp/transcript.jsonl',
    });
    expect(truncated).toContain(
      'Note: the earliest part of the conversation was too large to include and is NOT covered by this summary (the full transcript mentioned above still has it).',
    );
  });
});

describe('the boundary', () => {
  const events = [
    { v: 1, t: 'user_message', ts: 1000, id: 'm0', text: 'one' },
    { v: 1, t: 'assistant_message', ts: 1100, id: 'm1', text: 'two' },
    { v: 1, t: 'assistant_message', ts: 1200, id: 'm2', text: 'three' },
  ] as const;

  it('marks the boundary with a record that hangs off the last dropped record', () => {
    const { events: compacted, summary } = compact([...events], {
      keepLast: 1,
      summary: 'the earlier conversation',
      ts: 5000,
      id: 'cmp_1',
    });

    expect(compacted).toHaveLength(2);
    const marker = compacted[0];
    if (marker?.t !== 'compaction') throw new Error('expected a compaction marker');
    // The boundary is located by the **link**, never by the count.
    expect(marker.parentId).toBe('m1');
    expect(marker.replacedFrom).toBe(2);
    expect(marker.id).toBe('cmp_1');
    expect(marker.ts).toBe(5000);
    // The record keeps the summary the **model** produced, unchanged.
    expect(marker.summary).toBe('the earlier conversation');
    expect(summary).toBe('the earlier conversation');
    expect(compacted[1]?.id).toBe('m2');
  });

  it('never produces a summary locally', () => {
    const { events: compacted, summary } = compact([...events], { keepLast: 1 });
    expect(summary).toBeUndefined();
    expect(compacted).toEqual([...events]);
  });

  it('marks no boundary when nothing would be dropped', () => {
    const { events: compacted, summary } = compact([...events], {
      keepLast: 3,
      summary: 'the earlier conversation',
    });
    expect(summary).toBeUndefined();
    expect(compacted).toEqual([...events]);
  });
});

describe('the projection', () => {
  it('is the summary, then the replacement, then the kept tail, then the attachments and the hook results', () => {
    // The target's `uU` — the reading's §4.
    const summary: ProviderMessage = { role: 'user', content: 'the summary' };
    const replacement: ProviderMessage = { role: 'user', content: 'the replacement' };
    const kept: ProviderMessage = { role: 'assistant', content: 'the kept tail' };
    const attachments: ProviderMessage = { role: 'user', content: 'the attachment' };
    const hookResults: ProviderMessage = { role: 'user', content: 'the hook result' };

    expect(
      projectCompactedContext({ summary: [summary], replacement: [replacement], kept: [kept], attachments: [attachments], hookResults: [hookResults] }),
    ).toEqual([summary, replacement, kept, attachments, hookResults]);

    // Every part is optional, and an absent part contributes nothing.
    expect(projectCompactedContext({ summary: [summary] })).toEqual([summary]);
    expect(projectCompactedContext({})).toEqual([]);
  });
});

describe('the fallback ordering', () => {
  it('is the ladder the target walks', () => {
    // The reading's §5.
    expect(COMPACT_FALLBACK_ORDER).toEqual([
      'the_cached_prefix',
      'a_fresh_request',
      'the_next_model_in_the_ladder',
      'the_refusals_fallback_model',
      'dropping_the_head',
      'giving_up',
    ]);
    expect(COMPACT_ROUTER_ORDER).toEqual([
      'disabled',
      'below_the_threshold',
      'the_fixed_prefix_alone_is_over_the_threshold',
      'the_rapid_refill_breaker',
      'the_reactive_path',
      'the_core_path',
    ]);
    expect(COMPACT_PROMPT_TOO_LONG).toBe('Prompt is too long');
    expect(COMPACT_PROMPT_TOO_LONG_RETRIES).toBe(3);
  });

  it('drops the head of the conversation when the prompt was too long', () => {
    // The target's `gCe` — the reading's §5.2.
    const conversation: ProviderMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
      { role: 'user', content: 'five' },
      { role: 'assistant', content: 'six' },
    ];

    const retry = compactRetryMessages(conversation);
    expect(retry).not.toBeNull();
    // The conversation is grouped — an assistant message and the user
    // messages that follow it are one group — and without a known gap the
    // target drops the first fifth of the groups, at least one. The first
    // group goes, so the retry starts with an assistant message and the
    // marker says the head is gone.
    expect(retry?.map((message) => message.content)).toEqual([
      COMPACT_RETRY_MARKER,
      'two',
      'three',
      'four',
      'five',
      'six',
    ]);
  });

  it('marks a truncated retry that would start with an assistant message', () => {
    const conversation: ProviderMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ];
    const retry = compactRetryMessages(conversation, 1);
    // The gap of one token drops the first group, so the retry starts with the
    // assistant message — and the marker says the head is gone.
    expect(retry?.[0]).toEqual({ role: 'user', content: COMPACT_RETRY_MARKER });
    expect(COMPACT_RETRY_MARKER).toBe('[earlier conversation truncated for compaction retry]');
  });

  it('gives up when the conversation cannot be shortened any further', () => {
    expect(compactRetryMessages([{ role: 'user', content: 'one' }])).toBeNull();
    expect(compactRetryMessages([])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The compaction in a turn                                                    */
/* -------------------------------------------------------------------------- */

const CWD = '/work/project';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cc023-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

/** One round of a fake provider turn. */
interface FakeRound {
  /** The events of the round. */
  events: ProviderEvent[];
}

/** A driver that answers with the rounds it was given, and records the requests. */
function fakeDriver(rounds: FakeRound[]): ProviderDriver & {
  readonly requests: ProviderRequest[];
  [TURN_SOURCE]: true;
  send(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
} {
  const requests: ProviderRequest[] = [];
  return {
    route: 'firstParty',
    requests,
    [TURN_SOURCE]: true,
    async *send(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      const index = requests.length;
      requests.push(request);
      const round = rounds[index];
      if (round === undefined) return;
      for (const event of round.events) yield event;
    },
    buildUrl: () => 'https://api.anthropic.com/v1/messages',
    buildHeaders: () => ({}),
    buildBody: (req: ProviderRequest) => ({ body: req, headers: {} }),
    parseStream: () => ({ events: [], state: {} }),
    parseNonStreaming: () => ({ events: [] }),
    classifyError: (status: number) => ({ message: `HTTP ${status}`, retryable: false }),
    calculateNonstreamingTimeout: () => 1_000,
    betaFlagsFor: (flags: string[]) => flags,
  };
}

/** A round that answers with text and stops. */
function textRound(text: string): FakeRound {
  return {
    events: [
      { type: 'text_delta', text },
      { type: 'message_stop', stopReason: 'end_turn' },
    ],
  };
}

const allowAll = async (): Promise<PermissionDecision> => ({
  behavior: 'allow',
  source: 'unknown',
  reasonType: 'other',
});

/** The path of a session's transcript. */
function transcriptPath(configDir: string, sessionId: string): string {
  return path.join(configDir, 'projects', projectDirectoryName(CWD), `${sessionId}.jsonl`);
}

/** The text a message carries. */
function textOf(message: ProviderMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

describe('the compaction in a turn', () => {
  it('compacts when the trigger says so, and projects the summary into the next request', async () => {
    const configDir = makeRoot();
    const store = createSessionStore({ configDir });
    const driver = fakeDriver([
      textRound('the first answer'),
      textRound('<analysis>the analysis</analysis><summary>the earlier work</summary>'),
      textRound('the second answer'),
    ]);
    const runtime = createAgentRuntime({
      driver,
      registry: createToolRegistry(),
      store,
      permission: allowAll,
      cwd: CWD,
      maxTokens: 16,
      // A window small enough that the first turn's conversation is over the
      // threshold: the threshold is `contextWindow − min(maxOutputTokens,
      // 20000) − 13000`.
      contextWindow: 20_000,
    });

    // The first turn's prompt is long enough that the conversation it leaves
    // behind is over the threshold.
    await runtime.runTurn({
      prompt: 'x'.repeat(30_000),
      sessionId: 'session-01',
      model: 'm',
    });

    // The second turn finds the conversation over the threshold, and compacts
    // it before its own request.
    await runtime.runTurn({
      prompt: 'the second prompt',
      sessionId: 'session-01',
      model: 'm',
    });

    // The summarization was a request of its own: one turn, no tools, and the
    // target's system prompt.
    const summaryRequest = driver.requests[1];
    expect(summaryRequest?.system).toBe(COMPACT_SUMMARY_SYSTEM_PROMPT);
    expect(summaryRequest?.tools).toEqual([]);
    const summaryText = summaryRequest?.messages.at(-1);
    expect(summaryText?.role).toBe('user');
    expect(typeof summaryText?.content === 'string' ? summaryText.content : '').toContain(
      'Your task is to create a detailed summary of the conversation so far',
    );
    // The summarization saw the conversation it summarises.
    expect(JSON.stringify(summaryRequest?.messages)).toContain('the first answer');

    // The next request carries the **summary**, not the conversation it
    // replaced.
    const next = driver.requests[2];
    const carried = next?.messages.map((message) => textOf(message));
    expect(carried?.join('\n')).toContain(COMPACT_SUMMARY_PREAMBLE);
    expect(carried?.join('\n')).toContain('Summary:\nthe earlier work');
    expect(carried?.join('\n')).not.toContain('the first answer');

    // The boundary is a record of the transcript, and the prefix it replaced
    // is still in the file.
    const raw = readFileSync(transcriptPath(configDir, 'session-01'), 'utf8');
    expect(raw).toContain('"t":"compaction"');
    expect(raw).toContain('the first answer');
  });

  it('never compacts when the runtime does not know the model\'s window', async () => {
    const configDir = makeRoot();
    const store = createSessionStore({ configDir });
    const driver = fakeDriver([textRound('the first answer')]);
    const runtime = createAgentRuntime({
      driver,
      registry: createToolRegistry(),
      store,
      permission: allowAll,
      cwd: CWD,
      maxTokens: 16,
    });

    await runtime.runTurn({
      prompt: 'x'.repeat(30_000),
      sessionId: 'session-01',
      model: 'm',
    });

    // One request: the turn's own, and no summarization.
    expect(driver.requests).toHaveLength(1);
  });

  it('gives the compaction up when the summarization cannot be produced', async () => {
    const configDir = makeRoot();
    const store = createSessionStore({ configDir });
    const driver = fakeDriver([
      textRound('the first answer'),
      { events: [{ type: 'message_stop', stopReason: 'end_turn' }] },
      textRound('the second answer'),
    ]);
    const runtime = createAgentRuntime({
      driver,
      registry: createToolRegistry(),
      store,
      permission: allowAll,
      cwd: CWD,
      maxTokens: 16,
      contextWindow: 20_000,
    });

    await runtime.runTurn({
      prompt: 'x'.repeat(30_000),
      sessionId: 'session-01',
      model: 'm',
    });
    await runtime.runTurn({
      prompt: 'the second prompt',
      sessionId: 'session-01',
      model: 'm',
    });

    // The summarization produced no text, so the compaction is given up and
    // the turn carries on with the conversation it had. No boundary is
    // written.
    const raw = readFileSync(transcriptPath(configDir, 'session-01'), 'utf8');
    expect(raw).not.toContain('"t":"compaction"');
    expect(driver.requests).toHaveLength(3);
  });
});
