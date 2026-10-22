/**
 * The product, end to end.
 *
 * **The milestone:** `CC-049` of
 * [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../../docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
 *
 * **The concept:** [`docs/DIVERGENCE-LAYER-2.md`](../../docs/DIVERGENCE-LAYER-2.md) §4 —
 * the purpose is stated plainly: "**turning an idea into a verified, shippable
 * product**".
 *
 * ## What is measured, and how
 *
 * **The whole thing runs.** An idea goes in and a verified product comes out,
 * through **all eight** stages, with the **eight documents** the stages
 * produce — and the documents are on disk, not only in the report.
 *
 * **The generative work goes through the model layer's engine.** The three
 * stages that ask a model for a document are answered by a **real HTTP server
 * on a real port**, speaking one of the model layer's own API shapes, through
 * the model layer's own engine. So the test measures the whole path, and it
 * can count the questions the backend was asked — three, one per stage.
 *
 * **The verification stage's own checks are really executed.** The files the
 * build produced are **run**, and the verdicts are the runner's own. A
 * criterion is met by **the test that covers it**, and a criterion no test
 * covers is **not met**.
 *
 * **The result is compared against what the run claimed.** This is the
 * milestone's most important test: a run that claims a criterion is met and
 * does not meet it **fails**, it fails **at the stage that claimed it**, and
 * nothing is released. The claim is a statement about the documents; the
 * execution is a fact about the product; and the two are compared.
 *
 * **The capabilities follow their backends.** The `model` capability follows
 * the model layer's own predicate — a provider that is not connected means
 * the capability is off, with the reason, and the generative stages refuse
 * with it. The `approval` capability follows the rules: a rule that matches
 * decides **without asking** — and the test proves it by counting the
 * questions, zero — and an approval nobody answers is a **refusal with a
 * reason**.
 *
 * ## What is not measured here
 *
 * The **verification suite** (`CC-050`) is the next milestone, and this test is
 * what it will measure. The **terminal surface** (`CC-048`) is another
 * implementer's, and nothing here touches a screen.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { approvalRules, type ApprovalRuleSet, type ApprovalTransport } from '../../src/approvals/index.js';
import {
  ModelCatalogue,
  ModelEngine,
  ProviderTable,
  type ModelEntry,
  type ProviderEntry,
} from '../../src/model/index.js';
import {
  formatProductReport,
  runProduct,
  runProductCommand,
  type ProductOptions,
  type ProductResult,
} from '../../src/product/index.js';

/* -------------------------------------------------------------------------- */
/* The fake backend                                                            */
/* -------------------------------------------------------------------------- */

/** A model id that says nothing about who wrote it. */
const MODEL = 'the-house-model';

/** The provider the fake backend is reached through. */
const PROVIDER = 'house';

/** The specification the fake model writes. */
const SPECIFICATION = [
  'requirement the tool reads the last line of a build log',
  'accept the last line of the build log is reported',
  'requirement the tool explains the failure in one line',
  'accept the failure is explained in one line of plain words',
].join('\n');

/** The plan the fake model writes. */
const PLAN = [
  'step write the module that reads the last line',
  'satisfies 1',
  'step write the module that explains the failure',
  'satisfies 2',
].join('\n');

/** The module that reads the last line. */
const LAST_LINE =
  "export const lastLine = (text) => { const lines = String(text).split('\\n');" +
  " return (lines[lines.length - 1] ?? '').trim(); };";

/** The module that explains the failure. */
const EXPLAIN =
  "export const explain = (line) => line.includes('error')" +
  " ? 'the build failed: ' + line : 'the build passed';";

/** The test that covers the first criterion. */
const LAST_LINE_TEST =
  "import { test } from 'node:test'; import assert from 'node:assert';" +
  " import { lastLine } from '../src/last-line.mjs';" +
  " test('the last line is reported', () => { assert.equal(lastLine('one\\ntwo\\nthree'), 'three'); });";

/** The test that covers the second criterion. */
const EXPLAIN_TEST =
  "import { test } from 'node:test'; import assert from 'node:assert';" +
  " import { explain } from '../src/explain.mjs';" +
  " test('the failure is explained in one line', () => { assert.equal(explain('error: it broke'), 'the build failed: error: it broke'); });";

/** The test that covers the second criterion — and fails. */
const EXPLAIN_TEST_FAILING =
  "import { test } from 'node:test'; import assert from 'node:assert';" +
  " import { explain } from '../src/explain.mjs';" +
  " test('the failure is explained in one line', () => { assert.equal(explain('error: it broke'), 'the build passed'); });";

/** The files the fake model writes: a module and a test for each criterion. */
const FILES = [
  'artefact src/last-line.mjs',
  `content ${LAST_LINE}`,
  'satisfies 1',
  'artefact test/last-line.test.mjs',
  `content ${LAST_LINE_TEST}`,
  'satisfies 1',
  'artefact src/explain.mjs',
  `content ${EXPLAIN}`,
  'satisfies 2',
  'artefact test/explain.test.mjs',
  `content ${EXPLAIN_TEST}`,
  'satisfies 2',
].join('\n');

/** The files the fake model writes when its second test fails. */
const FILES_WITH_A_FAILING_TEST = [
  'artefact src/last-line.mjs',
  `content ${LAST_LINE}`,
  'satisfies 1',
  'artefact test/last-line.test.mjs',
  `content ${LAST_LINE_TEST}`,
  'satisfies 1',
  'artefact src/explain.mjs',
  `content ${EXPLAIN}`,
  'satisfies 2',
  'artefact test/explain.test.mjs',
  `content ${EXPLAIN_TEST_FAILING}`,
  'satisfies 2',
].join('\n');

/** The files the fake model writes when it never tests its second criterion. */
const FILES_WITHOUT_A_TEST = [
  'artefact src/last-line.mjs',
  `content ${LAST_LINE}`,
  'satisfies 1',
  'artefact test/last-line.test.mjs',
  `content ${LAST_LINE_TEST}`,
  'satisfies 1',
  'artefact src/explain.mjs',
  `content ${EXPLAIN}`,
  'satisfies 2',
].join('\n');

/** The backend the fake model is reached through. */
interface FakeBackend {
  /** The endpoint the provider is given. */
  readonly url: string;
  /** Every prompt the backend was asked, in order. */
  readonly prompts: string[];
  /** Stop the backend. */
  close(): Promise<void>;
}

/** The reply the backend gives for a prompt. */
type Answerer = (prompt: string) => string;

/**
 * Start the fake backend.
 *
 * It is a **real HTTP server on a real port**, and it answers in the model
 * layer's own `chat` shape — a streamed reply, and the stream is the shape's
 * own. The prompts it was asked are kept, so the test can count them.
 */
async function startFakeBackend(answer: Answerer): Promise<FakeBackend> {
  const prompts: string[] = [];

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let prompt = '';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          readonly messages?: readonly { readonly role: string; readonly content: string }[];
        };
        const messages = body.messages ?? [];
        const last = messages[messages.length - 1];
        prompt = last?.content ?? '';
      } catch {
        prompt = '';
      }
      prompts.push(prompt);

      const text = answer(prompt);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
      );
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    prompts,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** The answer the fake model gives, chosen by the prompt it was asked. */
function answerWith(build: string): Answerer {
  return (prompt: string): string => {
    if (prompt.includes('Write the specification')) return SPECIFICATION;
    if (prompt.includes('Order the work')) return PLAN;
    if (prompt.includes('Produce the files')) return build;
    return '';
  };
}

/* -------------------------------------------------------------------------- */
/* The harness                                                                 */
/* -------------------------------------------------------------------------- */

/** The model the catalogue holds. */
function modelEntry(): ModelEntry {
  return {
    id: MODEL,
    provider: PROVIDER,
    capabilities: { input: ['text'], output: ['text'], temperature: true, tools: false },
    overlays: [],
    reasoning: {},
    enabled: true,
  };
}

/** The provider the fake backend is reached through. */
function providerEntry(backend: FakeBackend, connected: boolean): ProviderEntry {
  return {
    id: PROVIDER,
    dialect: 'chat',
    endpoint: backend.url,
    // A provider that names no integration is available; one that names an
    // integration nobody connected is not.
    credential: connected ? { kind: 'none' } : { kind: 'integration', integration: 'house' },
    headers: {},
    models: [],
  };
}

/** The engine the product's model seam reaches through. */
function engineFor(provider: ProviderEntry): ModelEngine {
  return new ModelEngine({
    providers: new ProviderTable([provider]),
    catalogue: new ModelCatalogue({
      snapshot: { providers: [{ provider: PROVIDER, models: [modelEntry()] }] },
    }),
    resolveCredential: async () => ({
      ok: true,
      connection: undefined,
      secret: undefined,
      source: 'none',
    }),
  });
}

/** A transport that never answers, and counts the questions it was asked. */
function silentTransport(): ApprovalTransport & { readonly asked: number } {
  let asked = 0;
  return {
    capability: () => ({ enabled: true, unsupported: null }),
    ask: () => {
      asked += 1;
      return new Promise<never>(() => {});
    },
    get asked(): number {
      return asked;
    },
  };
}

/** Everything a run needs, and the way to clean it up. */
interface Harness {
  /** The directory the product was written into. */
  readonly workspace: string;
  /** The backend the model was reached through. */
  readonly backend: FakeBackend;
  /** The options the run was started with. */
  readonly options: ProductOptions;
  /** Stop the backend and take the directory away. */
  cleanup(): Promise<void>;
}

/** How a harness is built. */
interface HarnessOptions {
  /** The files the fake model writes. */
  readonly build?: string;
  /** Whether the model backend is connected. */
  readonly connected?: boolean;
  /** The approval rules. `null` means no rules at all. */
  readonly rules?: ApprovalRuleSet | null;
  /** The transport an approval is asked through. */
  readonly transport?: ApprovalTransport;
}

/** Build a harness, and the options the product is run with. */
async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'prricode-product-'));
  const backend = await startFakeBackend(answerWith(options.build ?? FILES));
  const connected = options.connected ?? true;
  const provider = providerEntry(backend, connected);

  const rules = options.rules === undefined ? approvalRules({ allow: ['ship'] }) : options.rules;

  const product: ProductOptions = {
    brief: 'A tool that reads a build log and explains the failure in one line.',
    workspace,
    model: {
      engine: engineFor(provider),
      selection: { provider: PROVIDER, model: MODEL },
      provider,
    },
    ...(rules === null
      ? {}
      : {
          approvals: {
            rules,
            ...(options.transport === undefined ? {} : { transport: options.transport }),
            timeoutMs: 250,
          },
        }),
  };

  return {
    workspace,
    backend,
    options: product,
    cleanup: async (): Promise<void> => {
      await backend.close();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

/** The harnesses this file opened. */
const opened: Harness[] = [];

afterEach(async () => {
  while (opened.length > 0) {
    const harness = opened.pop();
    if (harness !== undefined) await harness.cleanup();
  }
});

/** Open a harness, and remember it so that it is taken away afterwards. */
async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const openedHarness = await createHarness(options);
  opened.push(openedHarness);
  return openedHarness;
}

/** The stage records of a run, keyed by the stage's id. */
function recordsOf(result: ProductResult): Map<string, { state: string; reason?: string }> {
  const records = new Map<string, { state: string; reason?: string }>();
  for (const record of result.run.records) {
    records.set(record.stageId, {
      state: record.state,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    });
  }
  return records;
}

/* -------------------------------------------------------------------------- */
/* 1. The whole thing runs                                                    */
/* -------------------------------------------------------------------------- */

describe('the product, end to end', () => {
  it('turns an idea into a verified product, through all eight stages', async () => {
    const product = await harness();
    const result = await runProduct(product.options);

    expect(result.state).toBe('verified');
    expect(result.verified).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.failedAt).toBeNull();

    // Every stage completed, and none was skipped.
    const records = recordsOf(result);
    expect([...records.keys()]).toEqual([
      'concept',
      'clarify',
      'specify',
      'plan',
      'build',
      'verify',
      'ship',
      'operate',
    ]);
    for (const [stageId, record] of records) {
      expect(`${stageId}: ${record.state}`).toBe(`${stageId}: completed`);
    }

    // The eight documents, in the pipeline's order.
    expect(result.documents.map((document) => document.stageId)).toEqual([
      'concept',
      'clarify',
      'specify',
      'plan',
      'build',
      'verify',
      'ship',
      'operate',
    ]);
    for (const document of result.documents) {
      expect(document.summary.length).toBeGreaterThan(0);
    }
  });

  it('asks the model for the three generative documents, through the model layer', async () => {
    const product = await harness();
    await runProduct(product.options);

    // Three questions: one per generative stage, and no more.
    expect(product.backend.prompts).toHaveLength(3);
    expect(product.backend.prompts[0]).toContain('Write the specification');
    expect(product.backend.prompts[1]).toContain('Order the work');
    expect(product.backend.prompts[2]).toContain('Produce the files');
  });

  it('writes the product, its documents and its release down', async () => {
    const product = await harness();
    const result = await runProduct(product.options);

    // The files the build produced are on disk, with the text it gave them.
    const module = await readFile(path.join(product.workspace, 'src/last-line.mjs'), 'utf8');
    expect(module).toBe(LAST_LINE);
    const test = await readFile(path.join(product.workspace, 'test/explain.test.mjs'), 'utf8');
    expect(test).toBe(EXPLAIN_TEST);

    // The eight documents are on disk too.
    for (const stageId of [
      'concept',
      'clarify',
      'specify',
      'plan',
      'build',
      'verify',
      'ship',
      'operate',
    ]) {
      const document = JSON.parse(
        await readFile(path.join(product.workspace, `documents/${stageId}.json`), 'utf8'),
      ) as { stageId: string };
      expect(document.stageId).toBe(stageId);
    }

    // And the release is recorded, under the run's own id.
    const release = JSON.parse(
      await readFile(path.join(product.workspace, 'release.json'), 'utf8'),
    ) as { id: string };
    expect(release.id).toBe(result.runId);
  });

  it('runs the tests of the product, and takes their verdict', async () => {
    const product = await harness();
    const result = await runProduct(product.options);

    const verification = result.verification;
    expect(verification).not.toBeNull();
    if (verification === null) throw new Error('unreachable');

    // The product's own test run happened: two test files, both run, both passed.
    expect(verification.tests.files).toHaveLength(2);
    expect(verification.tests.passed).toBe(true);
    for (const file of verification.tests.files) {
      expect(file.passed).toBe(true);
    }

    // And every criterion was met by a test that covers it.
    expect(verification.checks).toHaveLength(2);
    for (const check of verification.checks) {
      expect(check.passed).toBe(true);
      expect(check.tests.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The capabilities follow their backends                                   */
/* -------------------------------------------------------------------------- */

describe('the capabilities follow their backends', () => {
  it('turns the model capability off when no backend is connected', async () => {
    const product = await harness({ connected: false });
    const result = await runProduct(product.options);

    // The capability is off, and it says why.
    const model = result.capabilities['model'];
    expect(model?.enabled).toBe(false);
    expect(model?.unsupported).toBe('no model backend is connected');

    // And the run stops at the first stage that needed it, naming the stage.
    expect(result.state).toBe('refused');
    expect(result.failedAt).toBe('specify');
    expect(result.reason).toContain('no model backend is connected');
    const records = recordsOf(result);
    expect(records.get('specify')?.state).toBe('refused');
    expect(records.get('plan')?.state).toBe('not-reached');
    expect(records.get('operate')?.state).toBe('not-reached');

    // The backend was never asked: there was no model to ask.
    expect(product.backend.prompts).toHaveLength(0);
  });

  it('turns the approval capability off when no rule is configured', async () => {
    const product = await harness({ rules: null });
    const result = await runProduct(product.options);

    const approval = result.capabilities['approval'];
    expect(approval?.enabled).toBe(false);
    expect(approval?.unsupported).toBe('no approval rules are configured');

    // The run reached the release and was refused there, naming the reason.
    expect(result.failedAt).toBe('ship');
    expect(result.reason).toContain('no approval rules are configured');
    expect(recordsOf(result).get('operate')?.state).toBe('not-reached');
  });

  it('decides a release with a matching rule, without asking anybody', async () => {
    const transport = silentTransport();
    const product = await harness({ transport });
    const result = await runProduct(product.options);

    // The capability is on, because there is a rule behind it.
    expect(result.capabilities['approval']?.enabled).toBe(true);
    // The rule decided, and nobody was asked: the questions are counted.
    expect(transport.asked).toBe(0);
    // And the product was released.
    expect(result.state).toBe('verified');
    const ship = result.run.outputs['ship'];
    expect(ship?.artifacts['release']).toBeDefined();
  });

  it('refuses a release that nobody answers, with the reason', async () => {
    const transport = silentTransport();
    // A rule that covers nothing: the release has to be asked about.
    const product = await harness({ rules: approvalRules({ allow: ['something-else'] }), transport });
    const result = await runProduct(product.options);

    // The approval was asked for, and nobody answered.
    expect(transport.asked).toBe(1);
    // An approval nobody answers is a refusal with a reason, and the run stops.
    expect(result.state).toBe('refused');
    expect(result.failedAt).toBe('ship');
    expect(result.reason).toContain('nobody answered the approval');
    expect(recordsOf(result).get('operate')?.state).toBe('not-reached');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The verification, and the claim it is compared with                      */
/* -------------------------------------------------------------------------- */

describe('the verification is executed, and compared with what the run claimed', () => {
  it('fails a run that claims a criterion is met and does not meet it', async () => {
    // The model claims both criteria are met — it names a file for each — but
    // the test that covers the second one fails.
    const product = await harness({ build: FILES_WITH_A_FAILING_TEST });
    const result = await runProduct(product.options);

    // The run is not verified, and it says which stage stopped it.
    expect(result.state).toBe('refused');
    expect(result.verified).toBe(false);
    expect(result.failedAt).toBe('verify');

    // The reason names the criterion that was claimed and is not met.
    expect(result.reason).toContain('claimed');
    expect(result.reason).toContain('the failure is explained in one line of plain words');

    // The comparison is in the report, and it says what was over-claimed.
    const verification = result.verification;
    expect(verification).not.toBeNull();
    if (verification === null) throw new Error('unreachable');

    // The run **did** claim that every criterion was met — the claim is the
    // pipeline's own check, over the documents the run holds.
    expect(verification.claimed.passed).toBe(true);
    expect(verification.claimed.checks).toHaveLength(2);
    expect(verification.claimed.checks[1]?.passed).toBe(true);

    // And the execution did not meet it: the test that covers it really ran,
    // and it really failed.
    expect(verification.comparison.agreed).toBe(false);
    expect(verification.comparison.overClaimed).toEqual([
      'the failure is explained in one line of plain words',
    ]);
    expect(verification.checks[1]?.passed).toBe(false);
    expect(verification.checks[1]?.detail).toContain('the test that covers it failed');
    expect(verification.tests.files).toHaveLength(2);
    expect(verification.tests.files[1]?.passed).toBe(false);
    expect(verification.tests.files[1]?.detail).toContain('the exit code');

    // And nothing was released: the stages after the claim are not reached.
    const records = recordsOf(result);
    expect(records.get('verify')?.state).toBe('refused');
    expect(records.get('ship')?.state).toBe('not-reached');
    expect(records.get('operate')?.state).toBe('not-reached');
    expect(result.run.outputs['ship']).toBeUndefined();
  });

  it('fails a run that claims a criterion nothing tests', async () => {
    // The model names a file for the second criterion, and never tests it.
    const product = await harness({ build: FILES_WITHOUT_A_TEST });
    const result = await runProduct(product.options);

    expect(result.state).toBe('refused');
    expect(result.failedAt).toBe('verify');
    expect(result.reason).toContain('no test covers this acceptance criterion');

    const verification = result.verification;
    if (verification === null) throw new Error('unreachable');
    expect(verification.comparison.agreed).toBe(false);
    expect(verification.comparison.overClaimed).toHaveLength(1);
    expect(verification.checks[1]?.detail).toContain('no test covers this acceptance criterion');
  });

  it('agrees with a run that claimed exactly what the product does', async () => {
    const product = await harness();
    const result = await runProduct(product.options);

    const verification = result.verification;
    if (verification === null) throw new Error('unreachable');
    expect(verification.comparison.agreed).toBe(true);
    expect(verification.comparison.overClaimed).toEqual([]);
    expect(verification.comparison.underClaimed).toEqual([]);
    expect(verification.comparison.detail).toContain('the run claimed what the product does');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The command                                                              */
/* -------------------------------------------------------------------------- */

describe('the command', () => {
  it('says the product is verified, and leaves the exit code at zero', async () => {
    const product = await harness();
    const out: string[] = [];
    const err: string[] = [];

    const code = await runProductCommand({
      brief: product.options.brief,
      product: {
        workspace: product.options.workspace,
        model: product.options.model,
        approvals: product.options.approvals,
      },
      io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    });

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('the product: verified');
    expect(out.join('\n')).toContain('the stages:');
  });

  it('says the product is not verified, and leaves the exit code at one', async () => {
    const product = await harness({ build: FILES_WITH_A_FAILING_TEST });
    const out: string[] = [];
    const err: string[] = [];

    const code = await runProductCommand({
      brief: product.options.brief,
      product: {
        workspace: product.options.workspace,
        model: product.options.model,
        approvals: product.options.approvals,
      },
      io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('the product: not verified');
    expect(err.join('\n')).toContain('why the product is not verified');
  });

  it('reports every stage, including the ones that were not reached', async () => {
    const product = await harness({ connected: false });
    const result = await runProduct(product.options);
    const report = formatProductReport(result);

    expect(report).toContain('the product: not verified');
    expect(report).toContain('specify: refused');
    expect(report).toContain('plan: not-reached');
    expect(report).toContain('operate: not-reached');
  });
});
