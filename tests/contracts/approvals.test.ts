/**
 * The contract test for the approvals — the second layer's approval rules and
 * the decision point that asks.
 *
 * **The milestone:** `CC-046` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §7 — "Approvals are
 * rules", the way the first layer's permissions are — `allow`, `ask`, `deny` —
 * so a matching rule decides without asking, and a rule persists. On top of
 * that: the request names the tool, the call and the reason; the answer
 * carries `allow` or `deny` and the request id; an answer for an unknown
 * request id is dropped; **an answer is attributed to the peer that gave it**;
 * and **a denial is final** — it is not re-asked within the turn.
 *
 * ## What is measured, and how
 *
 * - **The rules are the first layer's.** The approval layer calls the first
 *   layer's own matcher, and the test proves the equivalence by running the
 *   first layer's own entry point over the same rules and the same call and
 *   comparing the two verdicts. A rule written for the first layer's
 *   permissions therefore behaves the same way here.
 * - **The decision point.** A matching rule decides **without asking**, and
 *   the test proves it by counting the questions the transport was asked: the
 *   count is zero.
 * - **The denial is final.** A denied call is not asked about again in the same
 *   turn, and the count of questions proves it.
 * - **The attribution.** The answer travels over the **protocol** — the real
 *   framing, the real peer, the real registry — and the outcome names the peer
 *   that gave it.
 * - **The rule persists.** An approval is written to a store, and the next
 *   decision for the same call is made by the rule, with no question asked.
 * - **Never fake success.** An approval that cannot be asked for — no
 *   transport, the capability is off, the peer refuses — is a **refusal with a
 *   reason**, never an approval that was never granted.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  approvalRules,
  createApprovalGate,
  createFileApprovalRuleStore,
  evaluateApprovalRules,
  protocolApprovalTransport,
  type ApprovalAllowedByAnswer,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalSubject,
  type ApprovalTransport,
} from '../../src/approvals/index.js';
import { evaluateRules, type ToolContext } from '../../src/permissions/decision.js';
import {
  capabilityRecord,
  createDefaultCapabilityRegistry,
  createProtocolClient,
  createProtocolServer,
} from '../../src/protocol/index.js';

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** A transport that records every question it was asked. */
interface RecordingTransport extends ApprovalTransport {
  /** The requests the transport was asked about. */
  readonly asked: ApprovalRequest[];
  /** The capability the transport reports. */
  capability: ApprovalTransport['capability'];
}

/** A transport that answers the same way every time, and counts the questions. */
function recordingTransport(
  answer: 'allow' | 'deny',
  answerer = 'the-editor',
): RecordingTransport {
  const asked: ApprovalRequest[] = [];
  return {
    asked,
    capability: () => ({ enabled: true, unsupported: null }),
    async ask(request: ApprovalRequest) {
      asked.push(request);
      return { decision: answer, answerer };
    },
  };
}

/** A transport whose capability is off, and which says why. */
function disabledTransport(reason: string): ApprovalTransport {
  return {
    capability: () => ({ enabled: false, unsupported: reason }),
    async ask(): Promise<never> {
      throw new Error('the transport must not be asked when the capability is off');
    },
  };
}

/** The temporary directories the test creates. */
const temporaryDirectories: string[] = [];

/** A temporary directory the test may write into. */
function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'prricode-approvals-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory === undefined) continue;
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Wait for a condition, or fail the test. */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the condition was not met within ${timeoutMs} ms`);
}

/** The outcome, narrowed to the one a human allowed. */
function allowedBy(outcome: ApprovalOutcome): ApprovalAllowedByAnswer {
  if (outcome.outcome !== 'allowed' || outcome.decidedBy !== 'answer') {
    throw new Error(`the decision was not an answer that allowed: ${outcome.outcome}`);
  }
  return outcome;
}

/* -------------------------------------------------------------------------- */
/* The rules — the first layer's rules, reused                                 */
/* -------------------------------------------------------------------------- */

describe('the approval rules are the first layer\'s rules', () => {
  it('a matching allow rule decides without asking', async () => {
    const transport = recordingTransport('allow');
    const gate = createApprovalGate({
      rules: approvalRules({ allow: ['Bash(git status)'] }),
      transport,
    });

    const outcome = await gate.decide({ toolName: 'Bash', input: { command: 'git status' } });

    expect(outcome.outcome).toBe('allowed');
    expect(outcome.decidedBy).toBe('rule');
    // No question was asked: the rule decided.
    expect(transport.asked).toHaveLength(0);
  });

  it('a matching deny rule decides without asking', async () => {
    const transport = recordingTransport('allow');
    const gate = createApprovalGate({
      rules: approvalRules({ deny: ['Bash(rm *)'] }),
      transport,
    });

    const outcome = await gate.decide({
      toolName: 'Bash',
      input: { command: 'rm -rf /tmp/whatever' },
    });

    expect(outcome.outcome).toBe('denied');
    expect(outcome.decidedBy).toBe('rule');
    expect(transport.asked).toHaveLength(0);
  });

  it('an ask rule asks, and the answer resolves it', async () => {
    const transport = recordingTransport('allow');
    const gate = createApprovalGate({
      rules: approvalRules({ ask: ['Write'] }),
      transport,
    });

    const outcome = await gate.decide({
      toolName: 'Write',
      input: { file_path: '/tmp/prricode-approvals-note.txt' },
    });

    expect(outcome.outcome).toBe('allowed');
    expect(outcome.decidedBy).toBe('answer');
    expect(transport.asked).toHaveLength(1);
    expect(transport.asked[0]?.tool).toBe('Write');
    expect(transport.asked[0]?.reason.length).toBeGreaterThan(0);
    // The request names the tool, the call and the reason.
    expect(transport.asked[0]?.call).toEqual({ file_path: '/tmp/prricode-approvals-note.txt' });
    // And the outcome quotes the request id the answer must carry.
    expect(allowedBy(outcome).requestId).toBe(transport.asked[0]?.requestId);
  });

  it('an unmatched call asks', async () => {
    const transport = recordingTransport('deny');
    const gate = createApprovalGate({ rules: approvalRules({}), transport });

    const outcome = await gate.decide({ toolName: 'Bash', input: { command: 'ls' } });

    expect(outcome.outcome).toBe('denied');
    expect(outcome.decidedBy).toBe('answer');
    expect(transport.asked).toHaveLength(1);
  });

  it('a rule written for the first layer\'s permissions behaves the same way here', () => {
    const cases: Array<{ rules: ReturnType<typeof approvalRules>; subject: ApprovalSubject }> = [
      {
        rules: approvalRules({ allow: ['Bash(git status)'] }),
        subject: { toolName: 'Bash', input: { command: 'git status' } },
      },
      {
        rules: approvalRules({ deny: ['Bash(rm *)'] }),
        subject: { toolName: 'Bash', input: { command: 'rm -rf /tmp/whatever' } },
      },
      {
        rules: approvalRules({ ask: ['Write'] }),
        subject: { toolName: 'Write', input: { file_path: '/tmp/prricode-approvals-note.txt' } },
      },
      {
        rules: approvalRules({ allow: ['Bash(git *)'] }),
        subject: { toolName: 'Bash', input: { command: 'git status && rm -rf /tmp/whatever' } },
      },
      {
        rules: approvalRules({}),
        subject: { toolName: 'Bash', input: { command: 'ls' } },
      },
    ];

    for (const { rules, subject } of cases) {
      // The first layer's own entry point, over the same rules and the same call.
      const context: ToolContext = {
        toolName: subject.toolName,
        input: subject.input,
        toolUseId: subject.toolUseId ?? '',
        sessionId: subject.sessionId ?? '',
      };
      const first = evaluateRules(rules, context);

      // The approval layer's verdict.
      const second = evaluateApprovalRules(subject, rules);

      // The first layer matched nothing, and the approval layer asks.
      expect(second.behavior).toBe(first?.behavior ?? 'ask');
    }
  });

  it('the layer has no rule language of its own', () => {
    const directory = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/approvals',
    );
    const files = readdirSync(directory).filter((entry) => entry.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const text = readFileSync(path.join(directory, file), 'utf8');
      // A second rule engine would have a pattern language of its own.
      expect(text.includes('new RegExp('), file).toBe(false);
    }

    const rules = readFileSync(path.join(directory, 'rules.ts'), 'utf8');
    // The matcher is the first layer's.
    expect(rules).toContain("../permissions/");
  });
});

/* -------------------------------------------------------------------------- */
/* The decision point                                                           */
/* -------------------------------------------------------------------------- */

describe('the decision point', () => {
  it('a denial is final and is not re-asked within the turn', async () => {
    const transport = recordingTransport('deny');
    const gate = createApprovalGate({ rules: approvalRules({}), transport });
    const subject: ApprovalSubject = {
      toolName: 'Bash',
      input: { command: 'rm -rf /tmp/whatever' },
      turnId: 'turn_1',
    };

    const first = await gate.decide(subject);
    expect(first.outcome).toBe('denied');
    expect(first.decidedBy).toBe('answer');

    const second = await gate.decide(subject);
    expect(second.outcome).toBe('denied');
    // The denial was not re-asked: one question, two decisions.
    expect(transport.asked).toHaveLength(1);
  });

  it('a denial in one turn does not silence the next turn', async () => {
    const transport = recordingTransport('deny');
    const gate = createApprovalGate({ rules: approvalRules({}), transport });
    const call = { toolName: 'Bash', input: { command: 'rm -rf /tmp/whatever' } };

    await gate.decide({ ...call, turnId: 'turn_1' });
    await gate.decide({ ...call, turnId: 'turn_2' });

    // The denial is final within the turn, and the next turn asks again.
    expect(transport.asked).toHaveLength(2);
  });

  it('an approval that cannot be asked for is a refusal with a reason', async () => {
    const noTransport = await createApprovalGate({ rules: approvalRules({}) }).decide({
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    expect(noTransport.outcome).toBe('refused');
    expect(noTransport.reason.length).toBeGreaterThan(0);

    const capabilityOff = await createApprovalGate({
      rules: approvalRules({}),
      transport: disabledTransport('no approval rules are configured'),
    }).decide({ toolName: 'Bash', input: { command: 'ls' } });
    expect(capabilityOff.outcome).toBe('refused');
    expect(capabilityOff.reason).toBe('no approval rules are configured');

    const failing: ApprovalTransport = {
      capability: () => ({ enabled: true, unsupported: null }),
      async ask(): Promise<never> {
        throw new Error('the peer went away');
      },
    };
    const refused = await createApprovalGate({ rules: approvalRules({}), transport: failing }).decide({
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    expect(refused.outcome).toBe('refused');
    expect(refused.reason).toContain('the peer went away');
  });

  it('an approval nobody answers is a refusal with a reason', async () => {
    const silent: ApprovalTransport = {
      capability: () => ({ enabled: true, unsupported: null }),
      ask: () => new Promise<never>(() => undefined),
    };
    const gate = createApprovalGate({
      rules: approvalRules({}),
      transport: silent,
      timeoutMs: 50,
    });

    const outcome = await gate.decide({ toolName: 'Bash', input: { command: 'ls' } });

    expect(outcome.outcome).toBe('refused');
    expect(outcome.reason).toContain('nobody answered the approval');
  });

  it('a decision made by a rule is the same the next time', async () => {
    const rules = approvalRules({ allow: ['Bash(git status)'] });
    const transport = recordingTransport('allow');
    const gate = createApprovalGate({ rules, transport });
    const subject: ApprovalSubject = { toolName: 'Bash', input: { command: 'git status' } };

    const first = await gate.decide(subject);
    const second = await gate.decide(subject);
    // The same gate, the same rules, the same call: the same decision.
    expect(second.outcome).toBe('allowed');
    expect(second.reason).toBe(first.reason);

    // And another gate with the same rules decides the same way.
    const other = await createApprovalGate({ rules, transport: recordingTransport('deny') }).decide(
      subject,
    );
    expect(other.outcome).toBe('allowed');
    expect(other.reason).toBe(first.reason);

    // Nobody was asked, either time.
    expect(transport.asked).toHaveLength(0);
  });

  it('a rule may match on a model', async () => {
    const transport = recordingTransport('allow');
    const gate = createApprovalGate({
      rules: approvalRules({ deny: ['Write(model:alpha)'] }),
      transport,
    });
    const call = { toolName: 'Write', input: { file_path: '/tmp/prricode-approvals-note.txt' } };

    const denied = await gate.decide({ ...call, model: 'alpha' });
    expect(denied.outcome).toBe('denied');
    expect(denied.decidedBy).toBe('rule');
    expect(transport.asked).toHaveLength(0);

    const asked = await gate.decide({ ...call, model: 'beta' });
    expect(asked.outcome).toBe('allowed');
    expect(asked.decidedBy).toBe('answer');
    expect(transport.asked).toHaveLength(1);
  });

  it('an allow rule that covers only part of a command is asked', async () => {
    const transport = recordingTransport('allow');
    const gate = createApprovalGate({
      rules: approvalRules({ allow: ['Bash(git *)'] }),
      transport,
    });

    const outcome = await gate.decide({
      toolName: 'Bash',
      input: { command: 'git status && rm -rf /tmp/whatever' },
    });

    expect(outcome.outcome).toBe('allowed');
    expect(outcome.decidedBy).toBe('answer');
    expect(transport.asked).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The approval that travels over the protocol                                 */
/* -------------------------------------------------------------------------- */

describe('the approval that travels over the protocol', () => {
  it('the answer is attributed to the peer that gave it', async () => {
    // The real protocol: the real framing, the real peer, the real registry.
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    const capabilities = createDefaultCapabilityRegistry();
    capabilities.register('approval', capabilityRecord(true, null));

    const server = createProtocolServer({
      input: clientToServer,
      output: serverToClient,
      identity: 'prricode',
      peerIdentity: 'the-editor',
      capabilities,
    });

    const requests: ApprovalRequest[] = [];
    const client = createProtocolClient({
      input: serverToClient,
      output: clientToServer,
      identity: 'the-editor',
      onApprovalRequest: (request) => {
        requests.push(request);
      },
    });

    const gate = createApprovalGate({
      rules: approvalRules({}),
      transport: protocolApprovalTransport(server),
    });

    const deciding = gate.decide({ toolName: 'Bash', input: { command: 'ls' } });
    await waitFor(() => requests.length > 0);
    await client.answerApproval(requests[0]?.requestId ?? '', 'allow');
    const outcome = await deciding;

    expect(outcome.outcome).toBe('allowed');
    expect(outcome.decidedBy).toBe('answer');
    // The answerer is the peer that gave the answer — the client, and not the
    // user it answered for.
    expect(allowedBy(outcome).answerer).toBe('the-editor');

    client.close();
    server.close();
  });
});

/* -------------------------------------------------------------------------- */
/* A rule persists                                                              */
/* -------------------------------------------------------------------------- */

describe('a rule persists', () => {
  it('the rule decides the next time, and no question is asked', async () => {
    const file = path.join(temporaryDirectory(), 'approvals.json');
    const store = createFileApprovalRuleStore(file);
    const subject: ApprovalSubject = { toolName: 'Bash', input: { command: 'git status' } };

    const first = createApprovalGate({ rules: approvalRules({}), transport: recordingTransport('allow'), store });
    const firstOutcome = await first.decide(subject);
    expect(firstOutcome.outcome).toBe('allowed');
    expect(firstOutcome.decidedBy).toBe('answer');
    expect(allowedBy(firstOutcome).persistence?.rules).toEqual(['Bash(git status)']);

    // The rule persisted, and the next decision is made by the rule.
    const second = createApprovalGate({ rules: approvalRules({}), transport: recordingTransport('allow'), store });
    const decided = await second.decide(subject);
    expect(decided.outcome).toBe('allowed');
    expect(decided.decidedBy).toBe('rule');
  });

  it('the persisted rule asks nobody', async () => {
    const file = path.join(temporaryDirectory(), 'approvals.json');
    const store = createFileApprovalRuleStore(file);
    const subject: ApprovalSubject = { toolName: 'Bash', input: { command: 'git status' } };

    await createApprovalGate({ rules: approvalRules({}), transport: recordingTransport('allow'), store }).decide(
      subject,
    );

    const transport = recordingTransport('allow');
    const gate = createApprovalGate({ rules: approvalRules({}), transport, store });
    const outcome = await gate.decide(subject);

    expect(outcome.outcome).toBe('allowed');
    expect(outcome.decidedBy).toBe('rule');
    expect(transport.asked).toHaveLength(0);
  });

  it('a persisted path rule is anchored so that it matches the call that was approved', async () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, 'approvals.json');
    const store = createFileApprovalRuleStore(file);
    const target = path.join(directory, 'note.txt');
    const subject: ApprovalSubject = { toolName: 'Write', input: { file_path: target } };

    const allowed = await createApprovalGate({
      rules: approvalRules({}),
      transport: recordingTransport('allow'),
      store,
    }).decide(subject);
    expect(allowed.outcome).toBe('allowed');
    expect(allowedBy(allowed).persistence?.rules).toHaveLength(1);

    const transport = recordingTransport('allow');
    const gate = createApprovalGate({ rules: approvalRules({}), transport, store });
    const decided = await gate.decide(subject);

    expect(decided.outcome).toBe('allowed');
    expect(decided.decidedBy).toBe('rule');
    expect(transport.asked).toHaveLength(0);
  });

  it('a persisted rule does not override a deny rule', async () => {
    const file = path.join(temporaryDirectory(), 'approvals.json');
    const store = createFileApprovalRuleStore(file);
    const subject: ApprovalSubject = { toolName: 'Bash', input: { command: 'git status' } };

    await createApprovalGate({ rules: approvalRules({}), transport: recordingTransport('allow'), store }).decide(
      subject,
    );

    const transport = recordingTransport('allow');
    const gate = createApprovalGate({
      rules: approvalRules({ deny: ['Bash(git *)'] }),
      transport,
      store,
    });
    const outcome = await gate.decide(subject);

    expect(outcome.outcome).toBe('denied');
    expect(outcome.decidedBy).toBe('rule');
    expect(transport.asked).toHaveLength(0);
  });
});
