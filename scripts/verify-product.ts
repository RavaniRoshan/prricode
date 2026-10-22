#!/usr/bin/env bun
/**
 * The **verification suite** — one command, four kinds, one report.
 *
 * **The milestone:** `CC-050` of
 * [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
 *
 * **The conformance document:**
 * [`docs/compatibility/verification.md`](../docs/compatibility/verification.md).
 *
 * ## The four kinds
 *
 * | the kind | what it measures |
 * |---|---|
 * | **the product** | the end-to-end run — an idea in, a verified product out, through all eight stages — and the run's own verification, **executed** and compared with what the run claimed |
 * | **the backend** | the protocol over a **real pipe**; the providers against a fake backend on a **real port** that speaks every API shape; the credential store's resolution and **where the secret came from**; and the five failures, each degrading with its reason |
 * | **the frontend** | the rendered frames, compared against the **recorded goldens**, and the motion's **degraded** form against its own golden |
 * | **visually** | the goldens themselves, and the **staleness check** — a golden that was not regenerated deliberately is a failure |
 *
 * ## The rules this suite lives by
 *
 * 1. **Each kind must be able to fail.** A check that cannot fail is a claim,
 *    not a check. So every kind carries the case that must go red: the product
 *    kind runs a product that **over-claims** and requires the run to fail at
 *    the stage that claimed it; the backend kind requires every failure to
 *    degrade **with its reason** and to claim nothing; the frontend kind
 *    compares bytes; and the visual kind compares fingerprints.
 * 2. **A kind that cannot run says so.** It reports `enabled: false` and
 *    `unsupported: <why>` — the shared shape — and it never passes vacuously
 *    and never skips quietly.
 * 3. **Never fake success.** This is the product's own rule, and the suite is
 *    where it is enforced: a kind that could not measure says it could not
 *    measure, and a kind that measured says what it found.
 *
 * ## How to run it
 *
 * ```
 * bun run scripts/verify-product.ts                  # all four kinds
 * bun run scripts/verify-product.ts --kind backend   # one kind
 * ```
 *
 * **The exit code** is `0` when every kind passed, `1` when a kind **failed**,
 * and `2` when a kind **could not run** — so a suite that could not measure
 * everything never reads as a suite that measured everything and found nothing
 * wrong.
 *
 * ## What the suite borrows, and what it owns
 *
 * The protocol's server process is the repository's own
 * (`tests/fixtures/protocol-child.mjs`), because a second copy of the
 * protocol would measure the copy. The goldens are the terminal surface's own
 * (`tests/visual/goldens.ts`), because the picture and the fingerprint are
 * theirs. Everything else — the fake backend, the harness, the report — is
 * this file's.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { approvalRules } from '../src/approvals/index.js';
import {
  ModelCatalogue,
  ModelEngine,
  ProviderTable,
  resolveProviderCredential,
  createEncryptedFileSecretStore,
  MemoryCredentialStore,
  type Connection,
  type CredentialResolution,
  type Dialect,
  type Integration,
  type ModelEntry,
  type ModelMessage,
  type ModelRef,
  type ModelStreamEvent,
  type ProviderEntry,
} from '../src/model/index.js';
import { createProtocolClient, type ProtocolClient } from '../src/protocol/index.js';
import {
  nodeTestRunner,
  runProduct,
  type ProductResult,
  type ProductVerification,
} from '../src/product/index.js';

import type { GoldenRecord } from '../tests/visual/goldens.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

/** The four kinds of verification. */
export type VerificationKind = 'product' | 'backend' | 'frontend' | 'visual';

/** The state a kind ends in. */
export type VerificationState = 'passed' | 'failed' | 'unsupported';

/** One check, and what it saw. */
export interface VerificationCheck {
  /** The check's own name. */
  readonly name: string;
  /** Whether it passed. */
  readonly passed: boolean;
  /** What it saw, in one line. */
  readonly detail: string;
}

/** What one kind reported. */
export interface VerificationKindResult {
  /** Which kind this is. */
  readonly kind: VerificationKind;
  /** The kind's own title. */
  readonly title: string;
  /** Whether the kind could run at all. */
  readonly enabled: boolean;
  /** Why it could not run. `null` when it could. */
  readonly unsupported: string | null;
  /** The state the kind ended in. */
  readonly state: VerificationState;
  /** The checks it made. */
  readonly checks: readonly VerificationCheck[];
}

/** The whole report. */
export interface VerificationReport {
  /** The four kinds, in the order they were run. */
  readonly kinds: readonly VerificationKindResult[];
  /** Whether every kind passed. */
  readonly passed: boolean;
  /** How many kinds could not run. */
  readonly unsupported: number;
  /** How many kinds failed. */
  readonly failed: number;
}

/* -------------------------------------------------------------------------- */
/* The helpers                                                                  */
/* -------------------------------------------------------------------------- */

/** The repository's root. */
export const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The protocol's server process — the repository's own. */
const PROTOCOL_CHILD = path.join(REPOSITORY, 'tests/fixtures/protocol-child.mjs');

/**
 * The checks of one kind, collected as they are made.
 *
 * The collector is what makes a kind's report **a report**: every check says
 * what it saw, so a failure says what was expected and what was found.
 */
class CheckList {
  readonly #checks: VerificationCheck[] = [];

  /** Make a check. */
  add(name: string, passed: boolean, detail: string): void {
    this.#checks.push({ name, passed, detail });
  }

  /** The checks, so far. */
  get checks(): readonly VerificationCheck[] {
    return [...this.#checks];
  }
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'the error carried no message';
}

/** A member of a plain object, read safely. */
function memberOf(record: Readonly<Record<string, unknown>>, key: string): unknown {
  if (!Object.hasOwn(record, key)) return undefined;
  return record[key];
}

/**
 * The `node` executable.
 *
 * The suite is run by `bun`, and the protocol's server process needs **node**:
 * the fixture loads a TypeScript module through node's own resolver hook, and
 * bun does not have it. So the executable is looked up rather than assumed, and
 * a host without one is told so instead of being failed at random.
 */
export function nodeExecutable(): string | undefined {
  const fromPath = process.env['PRRICODE_NODE'];
  if (fromPath !== undefined && fromPath.length > 0) return fromPath;
  const own = path.basename(process.execPath);
  if (own === 'node' || own === 'node.exe') return process.execPath;
  const probe = spawnSync('node', ['--version'], { stdio: 'ignore', shell: false });
  if (probe.error === undefined && probe.status === 0) return 'node';
  return undefined;
}

/** A temporary directory, and the way to take it away. */
interface Scratch {
  /** The directory's path. */
  readonly directory: string;
  /** Take it away. */
  remove(): void;
}

/** Make a temporary directory. */
function scratch(prefix: string): Scratch {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    directory,
    remove: (): void => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The fake backend                                                             */
/* -------------------------------------------------------------------------- */

/** A request the fake backend received. */
export interface RecordedRequest {
  /** The method. */
  readonly method: string;
  /** The path. */
  readonly path: string;
  /** The headers. */
  readonly headers: Record<string, string>;
  /** The body, as it was parsed. */
  readonly body: unknown;
}

/** A fake backend — a real HTTP server on a real port. */
export interface FakeBackend {
  /** The endpoint the provider is given. */
  readonly url: string;
  /** Every request the backend received, in order. */
  readonly requests: readonly RecordedRequest[];
  /** The last request, or `undefined` when nothing was sent. */
  lastRequest(): RecordedRequest | undefined;
  /** Stop the backend. */
  close(): Promise<void>;
}

/** What the fake backend is asked for. */
export interface FakeBackendRequest {
  /** What the backend answers, given the prompt. */
  readonly answer?: (prompt: string) => string;
  /** The models the backend reports. */
  readonly models?: readonly ModelEntry[];
  /** When set, every request is refused with this status. */
  readonly refuseWith?: number;
}

/** How a fake backend is built. The seam the suite's own tests drive. */
export type FakeBackendFactory = (request: FakeBackendRequest) => Promise<FakeBackend>;

/** The `data:` payload of a streamed reply, as one SSE frame. */
function sse(event: string | undefined, data: unknown): string {
  const head = event === undefined ? '' : `event: ${event}\n`;
  return `${head}data: ${JSON.stringify(data)}\n\n`;
}

/** Read a request's body as text. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The prompt a chat-shaped request carries. */
function promptOf(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const messages = (body as Record<string, unknown>)['messages'];
  if (!Array.isArray(messages)) return '';
  const last = messages[messages.length - 1];
  if (typeof last !== 'object' || last === null) return '';
  const content = (last as Record<string, unknown>)['content'];
  return typeof content === 'string' ? content : '';
}

/**
 * Start a fake backend.
 *
 * It is a **real HTTP server on a real port** — no network, no stubbed
 * function — and it speaks **every API shape** the model layer has: the
 * chat-completions shape, the messages shape and the responses shape. The
 * paths are the shapes' own, so the engine reaches each one where it would
 * reach a real provider.
 */
export async function startFakeBackend(request: FakeBackendRequest = {}): Promise<FakeBackend> {
  const requests: RecordedRequest[] = [];
  const answer = request.answer ?? ((): string => 'hello ');

  const handler = async (
    incoming: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const raw = await readBody(incoming);
    let body: unknown;
    try {
      body = raw === '' ? undefined : JSON.parse(raw);
    } catch {
      body = raw;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers[name] = value;
    }
    requests.push({
      method: incoming.method ?? '',
      path: incoming.url ?? '',
      headers,
      body,
    });

    if (request.refuseWith !== undefined) {
      response.writeHead(request.refuseWith, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'the backend refused the request' } }));
      return;
    }

    const url = incoming.url ?? '';

    if (incoming.method === 'GET' && url.endsWith('/models')) {
      const models = request.models ?? [];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: models }));
      return;
    }

    if (incoming.method === 'POST' && url.endsWith('/chat/completions')) {
      const text = answer(promptOf(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sse(undefined, { choices: [{ delta: { content: text } }] }));
      response.write(
        sse(undefined, {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path":"a"}' } },
                ],
              },
            },
          ],
        }),
      );
      response.write(
        sse(undefined, {
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      );
      response.write('data: [DONE]\n\n');
      response.end();
      return;
    }

    if (incoming.method === 'POST' && url.endsWith('/messages')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 11 } } }),
      );
      response.write(
        sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      response.write(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: answer('') },
        }),
      );
      response.write(
        sse('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} },
        }),
      );
      response.write(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' },
        }),
      );
      response.write(sse('content_block_stop', { type: 'content_block_stop', index: 1 }));
      response.write(
        sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 7 },
        }),
      );
      response.write(sse('message_stop', { type: 'message_stop' }));
      response.end();
      return;
    }

    if (incoming.method === 'POST' && url.endsWith('/responses')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        sse('response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: answer(''),
        }),
      );
      response.write(
        sse('response.output_item.added', {
          type: 'response.output_item.added',
          item: { type: 'function_call', id: 'call_1', call_id: 'call_1', name: 'read', arguments: '' },
        }),
      );
      response.write(
        sse('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: 'call_1',
          delta: '{"path":"a"}',
        }),
      );
      response.write(
        sse('response.completed', {
          type: 'response.completed',
          response: { usage: { input_tokens: 11, output_tokens: 7 } },
        }),
      );
      response.end();
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'no such path' } }));
  };

  const server: Server = createServer((incoming, response) => {
    void handler(incoming, response);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    lastRequest: () => requests[requests.length - 1],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/* -------------------------------------------------------------------------- */
/* 1. The product                                                              */
/* -------------------------------------------------------------------------- */

/** The eight stages, in the pipeline's order. */
const THE_EIGHT_STAGES = [
  'concept',
  'clarify',
  'specify',
  'plan',
  'build',
  'verify',
  'ship',
  'operate',
] as const;

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
const HONEST_BUILD = [
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
const OVERCLAIMING_BUILD = [
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

/** The model the catalogue holds. */
const THE_MODEL = 'the-house-model';

/** The provider the fake backend is reached through. */
const THE_PROVIDER = 'house';

/** How the product kind is run. */
export interface ProductKindOptions {
  /** The files the fake model writes. The honest ones by default. */
  readonly build?: string;
  /** The `node` executable the product's own tests are run with. `null` for none. */
  readonly node?: string | null;
  /** How the product is run. The seam the suite's own tests drive. */
  readonly run?: ProductRunner;
}

/** The answer the fake model gives, chosen by the prompt it was asked. */
function answerWith(build: string): (prompt: string) => string {
  return (prompt: string): string => {
    if (prompt.includes('Write the specification')) return SPECIFICATION;
    if (prompt.includes('Order the work')) return PLAN;
    if (prompt.includes('Produce the files')) return build;
    return '';
  };
}

/** The model the catalogue holds. */
function houseModel(): ModelEntry {
  return {
    id: THE_MODEL,
    provider: THE_PROVIDER,
    capabilities: { input: ['text'], output: ['text'], temperature: true, tools: false },
    overlays: [],
    reasoning: {},
    enabled: true,
  };
}

/** The provider the fake backend is reached through. */
function houseProvider(endpoint: string): ProviderEntry {
  return {
    id: THE_PROVIDER,
    dialect: 'chat',
    endpoint,
    credential: { kind: 'none' },
    headers: {},
    models: [],
  };
}

/** The engine the product's model seam reaches through. */
function houseEngine(provider: ProviderEntry): ModelEngine {
  return new ModelEngine({
    providers: new ProviderTable([provider]),
    catalogue: new ModelCatalogue({
      snapshot: { providers: [{ provider: THE_PROVIDER, models: [houseModel()] }] },
    }),
    resolveCredential: async (): Promise<CredentialResolution> => ({
      ok: true,
      connection: undefined,
      secret: undefined,
      source: 'none',
    }),
  });
}

/** The stage records of a run, keyed by the stage's id. */
function recordsOf(result: ProductResult): Map<string, string> {
  const records = new Map<string, string>();
  for (const record of result.run.records) {
    records.set(record.stageId, record.state);
  }
  return records;
}

/**
 * What one run of the product produced.
 *
 * It is a **summary** of the run, and not the run itself: the kind reads the
 * verdict, the stages, the documents and the verification, and nothing else.
 * The summary is what makes the runner a **seam** — a caller can hand the kind
 * a run that behaved differently, and the kind will say so.
 */
export interface ProductRun {
  /** The run's id. */
  readonly runId: string;
  /** Whether the product is verified. */
  readonly state: 'verified' | 'refused';
  /** The stage the run stopped at, when it stopped. */
  readonly failedAt: string | null;
  /** Why the run was refused, when it was. */
  readonly reason: string | null;
  /** Every stage's record, keyed by the stage's id. */
  readonly records: ReadonlyMap<string, string>;
  /** How many documents the run produced. */
  readonly documents: number;
  /** Whether every document was written down. */
  readonly written: boolean;
  /** The verification the run carried. */
  readonly verification: ProductVerification | null;
  /** Take the run's directory away. */
  readonly remove: () => void;
}

/** How the product is run. The seam the suite's own tests drive. */
export type ProductRunner = (build: string, node: string) => Promise<ProductRun>;

/**
 * Run the product, once, over a fake backend.
 *
 * The backend is a **real HTTP server on a real port**, and the product's own
 * tests are run by **node**, in the product's own directory — so the run's
 * verdict is a fact about the product and not a claim about it.
 */
export const runTheProduct: ProductRunner = async (
  build: string,
  node: string,
): Promise<ProductRun> => {
  const workspace = scratch('prricode-verify-product-');
  const backend = await startFakeBackend({ answer: answerWith(build) });
  try {
    const provider = houseProvider(backend.url);
    const result = await runProduct({
      brief: 'A tool that reads a build log and explains the failure in one line.',
      workspace: workspace.directory,
      model: {
        engine: houseEngine(provider),
        selection: { provider: THE_PROVIDER, model: THE_MODEL },
        provider,
      },
      approvals: { rules: approvalRules({ allow: ['ship'] }) },
      testRunner: nodeTestRunner({ command: node }),
    });
    return {
      runId: result.runId,
      state: result.state,
      failedAt: result.failedAt,
      reason: result.reason,
      records: recordsOf(result),
      documents: result.documents.length,
      written: THE_EIGHT_STAGES.every((stage) =>
        existsSync(path.join(workspace.directory, 'documents', `${stage}.json`)),
      ),
      verification: result.verification,
      remove: workspace.remove,
    };
  } catch (error) {
    workspace.remove();
    throw error;
  } finally {
    await backend.close();
  }
};

/**
 * The **product** kind.
 *
 * It runs the product twice: once honestly, and once with a build whose test
 * fails while the run **claims** the criterion is met. The honest run must be
 * verified through all eight stages; the over-claiming run must **fail at the
 * stage that claimed it**, and nothing may be released.
 */
export async function checkProduct(
  options: ProductKindOptions = {},
): Promise<VerificationKindResult> {
  const checks = new CheckList();
  const node = options.node === undefined ? nodeExecutable() : (options.node ?? undefined);
  if (node === undefined) {
    return {
      kind: 'product',
      title: 'the product',
      enabled: false,
      unsupported:
        'there is no node executable on this host, and the product own tests are run by node',
      state: 'unsupported',
      checks: [],
    };
  }

  const run = options.run ?? runTheProduct;

  /* --- the honest run ------------------------------------------------- */
  const honest = await run(options.build ?? HONEST_BUILD, node);
  const stages = [...honest.records.keys()];
  const allCompleted = THE_EIGHT_STAGES.every((stage) => honest.records.get(stage) === 'completed');
  checks.add(
    'the run reaches all eight stages',
    stages.length === THE_EIGHT_STAGES.length && allCompleted,
    `${stages.length} stage(s): ${stages.join(', ')}`,
  );

  checks.add(
    'the run produces the eight documents, and writes them down',
    honest.documents === THE_EIGHT_STAGES.length && honest.written,
    `${honest.documents} document(s), ${honest.written ? 'all of them on disk' : 'some of them are missing'}`,
  );

  const verification = honest.verification;
  const tests = verification?.tests;
  const everyTestPassed =
    tests !== undefined && tests.files.length > 0 && tests.files.every((file) => file.passed);
  checks.add(
    'the verification is really executed',
    everyTestPassed === true,
    tests === undefined ? 'the run carried no verification at all' : tests.detail,
  );

  const everyCriterionMet =
    verification !== null &&
    verification !== undefined &&
    verification.checks.length > 0 &&
    verification.checks.every((check) => check.passed && check.tests.length > 0);
  checks.add(
    'every criterion is met by a test that covers it',
    everyCriterionMet,
    verification === null || verification === undefined
      ? 'the run carried no verification at all'
      : verification.checks
          .map((check) => `criterion ${check.index}: ${check.passed ? 'met' : 'not met'}`)
          .join(', '),
  );

  const agreed =
    verification !== null &&
    verification !== undefined &&
    verification.comparison.agreed &&
    verification.comparison.overClaimed.length === 0;
  checks.add(
    'the run claim agrees with the execution',
    agreed,
    verification === null || verification === undefined
      ? 'the run carried no verification at all'
      : verification.comparison.detail,
  );

  const verified = honest.state === 'verified' && honest.failedAt === null;
  checks.add(
    'the product is verified',
    verified,
    verified
      ? `the run ${honest.runId} is verified`
      : `the run ${honest.runId} is not verified: ${honest.reason ?? 'no reason was given'}`,
  );

  /* --- the over-claiming run ------------------------------------------ */
  const overclaiming = await run(OVERCLAIMING_BUILD, node);
  const overVerification = overclaiming.verification;
  const refused =
    overclaiming.state === 'refused' &&
    overclaiming.failedAt === 'verify' &&
    overVerification !== null &&
    !overVerification.comparison.agreed &&
    overVerification.comparison.overClaimed.length > 0;
  checks.add(
    'a run that over-claims fails at the stage that claimed it',
    refused,
    overVerification === null
      ? 'the over-claiming run carried no verification at all'
      : overVerification.comparison.detail,
  );

  const nothingReleased =
    overclaiming.records.get('ship') === 'not-reached' &&
    overclaiming.records.get('operate') === 'not-reached';
  checks.add(
    'a run that over-claims releases nothing',
    nothingReleased,
    `ship: ${overclaiming.records.get('ship') ?? 'not reached'}, operate: ${overclaiming.records.get('operate') ?? 'not reached'}`,
  );

  /* --- the over-claim, read by the suite itself ------------------------ */
  const overClaimed = overClaimedBy(overVerification);
  checks.add(
    'the over-claim is a real disagreement, and not a broken comparison',
    overClaimed.length > 0,
    overClaimed.length > 0
      ? `the run claimed ${overClaimed.length} criterion/criteria that the product own test run does not meet`
      : 'the run claimed nothing that the execution does not meet',
  );

  honest.remove();
  overclaiming.remove();

  return {
    kind: 'product',
    title: 'the product',
    enabled: true,
    unsupported: null,
    state: checks.checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks: checks.checks,
  };
}

/**
 * The criteria the run **claimed** were met and the execution does not meet.
 *
 * The suite reads the claim and the execution itself, and does not take the
 * product's own comparison for it — a suite that believes the thing it
 * measures is not a suite.
 */
function overClaimedBy(verification: ProductVerification | null): readonly string[] {
  if (verification === null) return [];
  const overClaimed: string[] = [];
  for (const executed of verification.checks) {
    const claim = verification.claimed.checks.find((entry) => entry.criterion === executed.criterion);
    if (claim === undefined) continue;
    if (claim.passed && !executed.passed) overClaimed.push(executed.criterion);
  }
  return overClaimed;
}

/* -------------------------------------------------------------------------- */
/* 2. The backend                                                              */
/* -------------------------------------------------------------------------- */

/** How the backend kind is run. */
export interface BackendKindOptions {
  /** The `node` executable the protocol's server process is run with. `null` for none. */
  readonly node?: string | null;
  /** How the fake backend is built. The seam the suite's own tests drive. */
  readonly backend?: FakeBackendFactory;
}

/** The frames a client received, and the waiters for the ones it has not. */
class Notifications {
  readonly seen: Array<{ method: string; params: unknown }> = [];
  readonly #waiters: Array<{
    method: string;
    match: (params: unknown) => boolean;
    resolve: (params: unknown) => void;
  }> = [];

  handle = (method: string, params: unknown): void => {
    this.seen.push({ method, params });
    for (const waiter of [...this.#waiters]) {
      if (waiter.method !== method) continue;
      if (!waiter.match(params)) continue;
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve(params);
    }
  };

  wait(
    method: string,
    match: (params: unknown) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<unknown> {
    const already = this.seen.find((entry) => entry.method === method && match(entry.params));
    if (already) return Promise.resolve(already.params);
    return new Promise<unknown>((resolve, reject) => {
      const waiter = { method, match, resolve };
      this.#waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        reject(new Error(`the notification "${method}" did not arrive within ${timeoutMs} ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  count(method: string): number {
    return this.seen.filter((entry) => entry.method === method).length;
  }
}

/** A child process, and the client that speaks to it. */
interface ProtocolHarness {
  /** The child — a real process. */
  readonly child: ChildProcessWithoutNullStreams;
  /** The client over the child's pipes. */
  readonly client: ProtocolClient;
  /** The notifications the client received. */
  readonly notifications: Notifications;
  /** Stop the child. */
  stop(): void;
}

/** Start the protocol's server process, and speak to it. */
function startProtocolHarness(node: string): ProtocolHarness {
  const child = spawn(node, [PROTOCOL_CHILD], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  const notifications = new Notifications();
  const client = createProtocolClient({
    input: child.stdout,
    output: child.stdin,
    identity: 'the-verifier',
    peerIdentity: 'the-agent',
    requestTimeoutMs: 5_000,
  });
  for (const method of [
    'event/message',
    'event/tool',
    'event/stage',
    'event/diagnostic',
    'turn/failed',
  ]) {
    client.onNotification(method, (params) => notifications.handle(method, params));
  }
  return {
    child,
    client,
    notifications,
    stop: (): void => {
      client.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

/** The raw pipe: the child's bytes, with no client in between. */
interface RawPipe {
  /** Write a line. */
  write(line: string): void;
  /** Read one line. */
  read(timeoutMs?: number): Promise<string>;
  /** Stop the child. */
  stop(): void;
}

/** Start the protocol's server process and talk to it in raw bytes. */
function startRawPipe(node: string): RawPipe {
  const child = spawn(node, [PROTOCOL_CHILD], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  const lines: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(line);
        else lines.push(line);
      }
      newline = buffer.indexOf('\n');
    }
  });

  return {
    write: (line: string): void => {
      child.stdin.write(line);
    },
    read: (timeoutMs = 5_000): Promise<string> => {
      const ready = lines.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise<string>((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`no line arrived within ${timeoutMs} ms`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
    },
    stop: (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

/** The model the backend kind's catalogue holds. */
function backendModel(provider: string, id: string): ModelEntry {
  return {
    id,
    provider,
    capabilities: { input: ['text'], output: ['text'], temperature: true, tools: true },
    overlays: [],
    reasoning: {},
    enabled: true,
  };
}

/** The provider the backend kind reaches the fake backend through. */
function backendProvider(
  id: string,
  dialect: Dialect,
  endpoint: string,
  models: readonly ModelEntry[] = [],
  credential: ProviderEntry['credential'] = { kind: 'none' },
): ProviderEntry {
  return {
    id,
    dialect,
    endpoint,
    credential,
    headers: {},
    models,
  };
}

/** The outcome of one turn through the engine. */
interface TurnOutcome {
  /** The events the turn produced, before it failed. */
  readonly events: readonly ModelStreamEvent[];
  /** The failure, when the turn failed. */
  readonly error: { readonly code: string; readonly reason: string } | null;
}

/** Run one turn, and report what it produced and what it refused. */
async function runTurn(
  engine: ModelEngine,
  selection: ModelRef,
  request: { readonly messages: readonly ModelMessage[] },
): Promise<TurnOutcome> {
  const events: ModelStreamEvent[] = [];
  try {
    for await (const event of engine.run(selection, request)) {
      events.push(event);
    }
    return { events, error: null };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'no-code';
    const reason =
      typeof error === 'object' && error !== null && 'reason' in error
        ? String((error as { reason: unknown }).reason)
        : messageOf(error);
    return { events, error: { code, reason } };
  }
}

/**
 * The **backend** kind.
 *
 * The protocol is measured over a **real pipe** — a real child process, real
 * frames — and the providers are measured against a **fake backend on a real
 * port** that speaks every API shape. The credential store's resolution is
 * measured with **where the secret came from**, and the five failures are
 * measured for the thing that matters: each one **degrades with its reason**
 * and **claims nothing**.
 */
export async function checkBackend(
  options: BackendKindOptions = {},
): Promise<VerificationKindResult> {
  const checks = new CheckList();
  const node = options.node === undefined ? nodeExecutable() : (options.node ?? undefined);
  if (node === undefined) {
    return {
      kind: 'backend',
      title: 'the backend',
      enabled: false,
      unsupported:
        'there is no node executable on this host, and the protocol server process is run by node',
      state: 'unsupported',
      checks: [],
    };
  }

  const build = options.backend ?? startFakeBackend;
  const credentials = scratch('prricode-verify-credentials-');

  /* --- the protocol, over a real pipe ---------------------------------- */
  const harness = startProtocolHarness(node);
  try {
    const created = await harness.client.request<{
      sessionId: string;
      state: string;
      capabilities: Record<string, unknown>;
    }>('session/create', { client: 'the-verifier' });

    const started = await harness.client.request<{ turnId: string }>('turn/start', {
      sessionId: created.sessionId,
      prompt: 'hello',
    });
    const ended = (await harness.notifications.wait(
      'event/message',
      (params) => memberOf(params as Record<string, unknown>, 'state') === 'completed',
    )) as Record<string, unknown>;

    const real =
      typeof harness.child.pid === 'number' &&
      harness.child.pid > 0 &&
      harness.child.pid !== process.pid &&
      created.sessionId.startsWith('session_') &&
      started.turnId.startsWith('turn_') &&
      memberOf(ended, 'turnId') === started.turnId;
    checks.add(
      'the protocol answers over a real pipe',
      real,
      `the server is the process ${harness.child.pid ?? 'none'}, the session is ${created.sessionId}, the turn is ${started.turnId}`,
    );

    const capabilities = created.capabilities;
    const model = memberOf(capabilities, 'model');
    const modelEnabled =
      typeof model === 'object' && model !== null && memberOf(model as Record<string, unknown>, 'enabled') === false;
    checks.add(
      'a capability that is not enabled is reported, not worked around',
      modelEnabled,
      'the model capability of the protocol server is off, and the record says so',
    );
  } catch (error) {
    checks.add(
      'the protocol answers over a real pipe',
      false,
      `the exchange failed: ${messageOf(error)}`,
    );
  } finally {
    harness.stop();
  }

  /* --- the frames on the wire ------------------------------------------ */
  const raw = startRawPipe(node);
  try {
    raw.write(
      `${JSON.stringify({ v: '1', id: 4242, method: 'capability/describe', params: { capability: 'protocol' } })}\n`,
    );
    const line = await raw.read();
    const frame = JSON.parse(line) as Record<string, unknown>;
    const framed =
      frame['v'] === '1' &&
      frame['id'] === 4242 &&
      memberOf(frame, 'result') !== undefined &&
      memberOf(frame, 'error') === undefined;
    checks.add(
      'the frames on the wire are frames',
      framed,
      `the answer carried the version ${String(frame['v'])}, the id ${String(frame['id'])} and a result`,
    );

    raw.write('this is not json at all\n');
    const refusal = JSON.parse(await raw.read()) as Record<string, unknown>;
    const params = memberOf(refusal, 'params');
    const code =
      typeof params === 'object' && params !== null
        ? String(memberOf(params as Record<string, unknown>, 'code'))
        : 'none';
    checks.add(
      'a frame that is not JSON is refused with a reason',
      refusal['method'] === 'event/diagnostic' && code === 'frame/malformed',
      `the server answered with "${String(refusal['method'])}" and the code ${code}`,
    );
  } catch (error) {
    checks.add(
      'the frames on the wire are frames',
      false,
      `the raw exchange failed: ${messageOf(error)}`,
    );
  } finally {
    raw.stop();
  }

  /* --- the providers, against a fake backend on a real port -------------- */
  const backend = await build({ models: [] });
  try {
    const dialects: readonly Dialect[] = ['chat', 'messages', 'responses'];
    const reached: string[] = [];
    let everyShapeWorked = true;
    for (const dialect of dialects) {
      const model = backendModel(dialect, `the-${dialect}-model`);
      const provider = backendProvider(dialect, dialect, backend.url);
      const engine = new ModelEngine({
        providers: new ProviderTable([provider]),
        catalogue: new ModelCatalogue({
          snapshot: { providers: [{ provider: dialect, models: [model] }] },
        }),
        resolveCredential: async (): Promise<CredentialResolution> => ({
          ok: true,
          connection: undefined,
          secret: undefined,
          source: 'none',
        }),
      });
      const outcome = await runTurn(
        engine,
        { provider: dialect, model: model.id },
        { messages: [{ role: 'user', content: 'hello' }] },
      );
      let text = '';
      let call = '';
      let usage = false;
      let end = false;
      for (const event of outcome.events) {
        if (event.type === 'text') text += event.text;
        else if (event.type === 'tool-call') call = event.call.name;
        else if (event.type === 'usage') usage = true;
        else if (event.type === 'end') end = true;
      }
      const worked =
        outcome.error === null && text.length > 0 && call.length > 0 && usage && end;
      if (!worked) everyShapeWorked = false;
      reached.push(`${dialect}: ${worked ? 'answered' : 'did not answer'}`);
    }
    const last = backend.lastRequest();
    const onTheWire =
      last !== undefined &&
      last.method === 'POST' &&
      last.path.startsWith('/v1/') &&
      backend.url.startsWith('http://127.0.0.1:');
    checks.add(
      'the providers are reached over a real socket',
      everyShapeWorked && onTheWire,
      `${reached.join(', ')}; the last request was ${last?.method ?? 'none'} ${last?.path ?? 'none'} on ${backend.url}`,
    );
  } finally {
    await backend.close();
  }

  /* --- the credentials, and where the secret came from ------------------ */
  {
    const integration: Integration = {
      id: 'house',
      name: 'the house',
      env: ['HOUSE_KEY'],
    };
    const store = new MemoryCredentialStore([
      {
        id: 'cred_1',
        integration: 'house',
        kind: 'key',
        label: 'the house key',
        createdAt: 2,
        secret: 'the-house-secret',
      },
    ]);
    const secretStore = createEncryptedFileSecretStore(
      path.join(credentials.directory, 'secrets.json'),
      'a passphrase of the verification suite',
    );
    await secretStore.write('cred_1', 'the-house-secret');

    const resolved = await resolveProviderCredential(
      { kind: 'integration', integration: 'house' },
      integration,
      store,
      secretStore,
      {},
    );
    const fromTheFile =
      resolved.ok === true &&
      resolved.source === 'encrypted-file' &&
      resolved.secret === 'the-house-secret' &&
      resolved.connection !== undefined &&
      resolved.connection.kind === 'credential';
    checks.add(
      'the credential store resolves the secret, and says where it came from',
      fromTheFile,
      resolved.ok
        ? `the secret came from the ${resolved.source}`
        : `the credential could not be resolved: ${resolved.reason}`,
    );

    const fromTheEnvironment = await resolveProviderCredential(
      { kind: 'integration', integration: 'house' },
      integration,
      new MemoryCredentialStore(),
      secretStore,
      { HOUSE_KEY: 'the-environment-secret' },
    );
    const environmentIsAPeer =
      fromTheEnvironment.ok === true &&
      fromTheEnvironment.source === 'environment' &&
      fromTheEnvironment.secret === 'the-environment-secret';
    checks.add(
      'the environment is a first-class peer of a stored key',
      environmentIsAPeer,
      fromTheEnvironment.ok
        ? `the secret came from the ${fromTheEnvironment.source}`
        : `the credential could not be resolved: ${fromTheEnvironment.reason}`,
    );

    const provider = backendProvider('house', 'chat', backend.url, []);
    const withSecret: ProviderEntry = {
      ...provider,
      credential: { kind: 'integration', integration: 'house' },
    };
    const carries = JSON.stringify(withSecret).includes('the-house-secret');
    checks.add(
      'the provider record carries no secret',
      !carries,
      'the provider names an integration, and the secret is nowhere in the record',
    );
  }

  /* --- the failures ----------------------------------------------------- */
  const refusing = await build({ refuseWith: 500 });
  try {
    const notConnectedModel = backendModel('not-connected', 'the-model');
    const notConnectedProvider = backendProvider(
      'not-connected',
      'chat',
      refusing.url,
      [],
      { kind: 'integration', integration: 'house' },
    );
    const notConnectedEngine = new ModelEngine({
      providers: new ProviderTable([notConnectedProvider]),
      catalogue: new ModelCatalogue({
        snapshot: { providers: [{ provider: 'not-connected', models: [notConnectedModel] }] },
      }),
      resolveCredential: async (): Promise<CredentialResolution> => ({
        ok: true,
        connection: undefined,
        secret: undefined,
        source: 'none',
      }),
      connections: (): readonly Connection[] => [],
    });
    const notConnected = await runTurn(
      notConnectedEngine,
      { provider: 'not-connected', model: notConnectedModel.id },
      { messages: [{ role: 'user', content: 'hello' }] },
    );
    checks.add(
      'a provider that is not connected degrades with its reason',
      notConnected.error !== null &&
        notConnected.error.code === 'model/not-connected' &&
        notConnected.error.reason.length > 0 &&
        notConnected.events.length === 0,
      notConnected.error === null
        ? 'the turn answered, and it should not have'
        : `${notConnected.error.code}: ${notConnected.error.reason}`,
    );

    const unavailableModel: ModelEntry = {
      ...backendModel('unavailable', 'the-model'),
      enabled: false,
    };
    const unavailableProvider = backendProvider('unavailable', 'chat', refusing.url, []);
    const unavailableEngine = new ModelEngine({
      providers: new ProviderTable([unavailableProvider]),
      catalogue: new ModelCatalogue({
        snapshot: { providers: [{ provider: 'unavailable', models: [unavailableModel] }] },
      }),
      resolveCredential: async (): Promise<CredentialResolution> => ({
        ok: true,
        connection: undefined,
        secret: undefined,
        source: 'none',
      }),
    });
    const unavailable = await runTurn(
      unavailableEngine,
      { provider: 'unavailable', model: unavailableModel.id },
      { messages: [{ role: 'user', content: 'hello' }] },
    );
    checks.add(
      'a model that has become unavailable degrades with its reason',
      unavailable.error !== null &&
        unavailable.error.code === 'model/unavailable' &&
        unavailable.error.reason.length > 0 &&
        unavailable.events.length === 0,
      unavailable.error === null
        ? 'the turn answered, and it should not have'
        : `${unavailable.error.code}: ${unavailable.error.reason}`,
    );

    const refusedModel = backendModel('refused', 'the-model');
    const refusedProvider = backendProvider('refused', 'chat', refusing.url, []);
    const refusedEngine = new ModelEngine({
      providers: new ProviderTable([refusedProvider]),
      catalogue: new ModelCatalogue({
        snapshot: { providers: [{ provider: 'refused', models: [refusedModel] }] },
      }),
      resolveCredential: async (): Promise<CredentialResolution> => ({
        ok: true,
        connection: undefined,
        secret: undefined,
        source: 'none',
      }),
    });
    const refused = await runTurn(
      refusedEngine,
      { provider: 'refused', model: refusedModel.id },
      { messages: [{ role: 'user', content: 'hello' }] },
    );
    checks.add(
      'an endpoint that refuses degrades with its reason',
      refused.error !== null &&
        refused.error.code === 'model/endpoint-refused' &&
        refused.error.reason.length > 0 &&
        refused.events.length === 0,
      refused.error === null
        ? 'the turn answered, and it should not have'
        : `${refused.error.code}: ${refused.error.reason}`,
    );

    const unresolvableProvider = backendProvider(
      'unresolvable',
      'chat',
      refusing.url,
      [],
      { kind: 'integration', integration: 'house' },
    );
    const externalStore = new MemoryCredentialStore([
      {
        id: 'cred_external',
        integration: 'house',
        kind: 'external',
        label: 'a secret managed elsewhere',
        createdAt: 3,
        reference: 'a-reference',
      },
    ]);
    const unresolvableEngine = new ModelEngine({
      providers: new ProviderTable([unresolvableProvider]),
      catalogue: new ModelCatalogue({
        snapshot: {
          providers: [{ provider: 'unresolvable', models: [backendModel('unresolvable', 'the-model')] }],
        },
      }),
      resolveCredential: async (provider): Promise<CredentialResolution> =>
        resolveProviderCredential(
          provider.credential,
          { id: 'house', env: [] },
          externalStore,
          createEncryptedFileSecretStore(
            path.join(credentials.directory, 'nothing.json'),
            'a passphrase of the verification suite',
          ),
          {},
        ),
      // The provider is connected — the connection is there — and the
      // credential it names cannot be resolved, which is the case this check
      // measures.
      connections: (): readonly Connection[] => [
        {
          kind: 'credential',
          id: 'cred_external',
          label: 'a secret managed elsewhere',
          credential: 'external',
        },
      ],
    });
    const unresolvable = await runTurn(
      unresolvableEngine,
      { provider: 'unresolvable', model: 'the-model' },
      { messages: [{ role: 'user', content: 'hello' }] },
    );
    checks.add(
      'a credential that cannot be resolved degrades with its reason',
      unresolvable.error !== null &&
        unresolvable.error.code === 'model/credential-unresolved' &&
        unresolvable.error.reason.length > 0 &&
        unresolvable.events.length === 0,
      unresolvable.error === null
        ? 'the turn answered, and it should not have'
        : `${unresolvable.error.code}: ${unresolvable.error.reason}`,
    );

    const overlayModel: ModelEntry = {
      ...backendModel('overlay', 'the-model'),
      overlays: [
        {
          kind: 'effort',
          name: 'low',
          effort: 'low',
          spellings: { chat: { fields: { reasoning_effort: 'low' } } },
        },
      ],
      reasoning: { effort: { values: ['low'] } },
    };
    const overlayProvider = backendProvider('overlay', 'chat', refusing.url, []);
    const overlayEngine = new ModelEngine({
      providers: new ProviderTable([overlayProvider]),
      catalogue: new ModelCatalogue({
        snapshot: { providers: [{ provider: 'overlay', models: [overlayModel] }] },
      }),
      resolveCredential: async (): Promise<CredentialResolution> => ({
        ok: true,
        connection: undefined,
        secret: undefined,
        source: 'none',
      }),
    });
    const overlay = await runTurn(
      overlayEngine,
      { provider: 'overlay', model: 'the-model', overlay: 'high' },
      { messages: [{ role: 'user', content: 'hello' }] },
    );
    checks.add(
      'an overlay the model does not offer degrades with its reason',
      overlay.error !== null &&
        overlay.error.code === 'model/overlay-unknown' &&
        overlay.error.reason.length > 0 &&
        overlay.events.length === 0,
      overlay.error === null
        ? 'the turn answered, and it should not have'
        : `${overlay.error.code}: ${overlay.error.reason}`,
    );
  } finally {
    await refusing.close();
    credentials.remove();
  }

  return {
    kind: 'backend',
    title: 'the backend',
    enabled: true,
    unsupported: null,
    state: checks.checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks: checks.checks,
  };
}

/* -------------------------------------------------------------------------- */
/* 3. The frontend, and 4. The goldens                                          */
/* -------------------------------------------------------------------------- */

/** The goldens' own machinery, as it is loaded. */
type GoldenModule = typeof import('../tests/visual/goldens.js');

/** How the golden kinds are run. */
export interface GoldenKindOptions {
  /** Where the goldens are recorded. */
  readonly directory?: string;
  /** How the goldens' machinery is loaded. */
  readonly load?: () => Promise<GoldenModule>;
}

/** The goldens' machinery, loaded from the repository's own. */
async function loadGoldenModule(): Promise<GoldenModule> {
  const loaded = await import('../tests/visual/goldens.js');
  return loaded;
}

/** The golden kinds' shared preamble: the goldens, or the reason there are none. */
interface GoldenPreamble {
  /** The goldens' machinery. */
  readonly module: GoldenModule;
  /** The directory the goldens are recorded in. */
  readonly directory: string;
}

/** Load the goldens, or say why they could not be loaded. */
async function prepareGoldens(
  options: GoldenKindOptions,
): Promise<{ readonly preamble: GoldenPreamble } | { readonly reason: string }> {
  const load = options.load ?? loadGoldenModule;
  let module: GoldenModule;
  try {
    module = await load();
  } catch (error) {
    return {
      reason: `the golden frames are not recorded: the machinery could not be loaded (${messageOf(error)})`,
    };
  }
  const directory = options.directory ?? module.GOLDEN_DIRECTORY;
  if (!existsSync(directory)) {
    return {
      reason: `the golden frames are not recorded: the directory ${directory} is not there`,
    };
  }
  return { preamble: { module, directory } };
}

/**
 * The **frontend** kind.
 *
 * The rendered frames are compared against the **recorded goldens**, byte for
 * byte, and the motion's **degraded** form is compared against **its own**
 * golden — the resting picture and the reason beside it.
 */
export async function checkFrontend(
  options: GoldenKindOptions = {},
): Promise<VerificationKindResult> {
  const prepared = await prepareGoldens(options);
  if ('reason' in prepared) {
    return {
      kind: 'frontend',
      title: 'the frontend',
      enabled: false,
      unsupported: prepared.reason,
      state: 'unsupported',
      checks: [],
    };
  }

  const { module, directory } = prepared.preamble;
  const checks = new CheckList();

  for (const definition of module.GOLDENS) {
    const recordedPath = module.picturePath(definition.name, directory);
    if (!existsSync(recordedPath)) {
      checks.add(
        `the "${definition.name}" frame is the picture that is drawn now`,
        false,
        `the golden is not recorded at ${recordedPath}; the regeneration is a deliberate act`,
      );
      continue;
    }
    const recorded = readFileSync(recordedPath, 'utf8');
    const drawn = module.pictureOf(definition);
    checks.add(
      `the "${definition.name}" frame is the picture that is drawn now`,
      recorded === drawn,
      recorded === drawn
        ? `${recorded.length} byte(s) of picture, the same as the golden`
        : `the golden is ${recorded.length} byte(s) and the frame that is drawn now is ${drawn.length}`,
    );
  }

  const degraded = module.GOLDENS.find((definition) => definition.name === 'degraded');
  if (degraded === undefined) {
    checks.add(
      'the degraded form has a golden of its own',
      false,
      'there is no golden named "degraded"',
    );
  } else {
    const record = module.recordOf(degraded);
    const picture = module.pictureOf(degraded);
    const reason = record.capability.unsupported;
    const degradedIsItsOwn =
      record.capability.enabled === false &&
      typeof reason === 'string' &&
      reason.length > 0 &&
      picture.includes(reason);
    checks.add(
      'the degraded form has a golden of its own',
      degradedIsItsOwn,
      degradedIsItsOwn
        ? `the motion is off, and the picture carries the reason: ${String(reason)}`
        : 'the degraded form is not drawn with its reason beside it',
    );
  }

  return {
    kind: 'frontend',
    title: 'the frontend',
    enabled: true,
    unsupported: null,
    state: checks.checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks: checks.checks,
  };
}

/**
 * The **visual** kind.
 *
 * The goldens themselves are checked: every one has a record and a picture,
 * every record describes the picture beside it, and — the check that matters —
 * every golden is **current**. A golden that was not regenerated deliberately
 * is **stale**, and a stale golden **fails**, so a stale picture cannot pass
 * quietly.
 */
export async function checkVisual(
  options: GoldenKindOptions = {},
): Promise<VerificationKindResult> {
  const prepared = await prepareGoldens(options);
  if ('reason' in prepared) {
    return {
      kind: 'visual',
      title: 'the goldens, visually',
      enabled: false,
      unsupported: prepared.reason,
      state: 'unsupported',
      checks: [],
    };
  }

  const { module, directory } = prepared.preamble;
  const checks = new CheckList();

  for (const definition of module.GOLDENS) {
    const recordFile = module.recordPath(definition.name, directory);
    const pictureFile = module.picturePath(definition.name, directory);
    if (!existsSync(recordFile) || !existsSync(pictureFile)) {
      checks.add(
        `the "${definition.name}" golden is recorded`,
        false,
        'the golden has no record, or no picture; the regeneration is a deliberate act',
      );
      continue;
    }

    let recorded: GoldenRecord;
    try {
      recorded = JSON.parse(readFileSync(recordFile, 'utf8')) as GoldenRecord;
    } catch (error) {
      checks.add(
        `the "${definition.name}" golden is recorded`,
        false,
        `the record could not be read: ${messageOf(error)}`,
      );
      continue;
    }
    checks.add(
      `the "${definition.name}" golden is recorded`,
      true,
      `the record and the picture are both there`,
    );

    const current = module.fingerprintOfFiles(definition.sources);
    const stale = !module.isCurrent(recorded, current);
    checks.add(
      `the "${definition.name}" golden is current`,
      !stale,
      stale
        ? 'the code that draws it has changed and the golden was not regenerated'
        : `the drawing is unchanged (${current.slice(0, 12)})`,
    );

    const picture = readFileSync(pictureFile, 'utf8');
    const describes = recorded.pictureHash === module.hashOf(picture);
    checks.add(
      `the "${definition.name}" record describes the picture beside it`,
      describes,
      describes
        ? `the record and the picture agree (${recorded.pictureHash.slice(0, 12)})`
        : 'the record does not describe the picture that is recorded beside it',
    );
  }

  return {
    kind: 'visual',
    title: 'the goldens, visually',
    enabled: true,
    unsupported: null,
    state: checks.checks.every((check) => check.passed) ? 'passed' : 'failed',
    checks: checks.checks,
  };
}

/* -------------------------------------------------------------------------- */
/* The report                                                                   */
/* -------------------------------------------------------------------------- */

/** The kinds, in the order they are run. */
export const VERIFICATION_KINDS: readonly VerificationKind[] = Object.freeze([
  'product',
  'backend',
  'frontend',
  'visual',
]);

/** How the suite is run. */
export interface VerificationOptions {
  /** The kinds to run. Every kind by default. */
  readonly kinds?: readonly VerificationKind[];
  /** How the product kind is run. */
  readonly product?: ProductKindOptions;
  /** How the backend kind is run. */
  readonly backend?: BackendKindOptions;
  /** How the frontend kind is run. */
  readonly frontend?: GoldenKindOptions;
  /** How the visual kind is run. */
  readonly visual?: GoldenKindOptions;
}

/**
 * Run the suite.
 *
 * Every kind is run, and every kind reports. A kind that cannot run says so,
 * and the suite does not call that a pass.
 */
export async function runVerification(
  options: VerificationOptions = {},
): Promise<VerificationReport> {
  const wanted = options.kinds ?? VERIFICATION_KINDS;
  const results: VerificationKindResult[] = [];

  for (const kind of wanted) {
    if (kind === 'product') {
      results.push(await checkProduct(options.product ?? {}));
      continue;
    }
    if (kind === 'backend') {
      results.push(await checkBackend(options.backend ?? {}));
      continue;
    }
    if (kind === 'frontend') {
      results.push(await checkFrontend(options.frontend ?? {}));
      continue;
    }
    results.push(await checkVisual(options.visual ?? {}));
  }

  const failed = results.filter((result) => result.state === 'failed').length;
  const unsupported = results.filter((result) => result.state === 'unsupported').length;
  return {
    kinds: results,
    passed: failed === 0 && unsupported === 0 && results.length > 0,
    failed,
    unsupported,
  };
}

/** The report the command prints. */
export function formatVerificationReport(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push('the verification suite');
  lines.push('');

  for (const kind of report.kinds) {
    if (kind.state === 'unsupported') {
      lines.push(`${kind.title} — could not run`);
      lines.push(`  why: ${kind.unsupported ?? 'no reason was given'}`);
      lines.push('');
      continue;
    }
    lines.push(`${kind.title} — ${kind.state}`);
    for (const check of kind.checks) {
      lines.push(`  ${check.passed ? 'ok  ' : 'FAIL'} ${check.name} — ${check.detail}`);
    }
    lines.push('');
  }

  const passed = report.kinds.filter((kind) => kind.state === 'passed').length;
  lines.push(
    `the suite: ${passed} of ${report.kinds.length} kind(s) passed` +
      (report.failed > 0 ? `, ${report.failed} failed` : '') +
      (report.unsupported > 0 ? `, ${report.unsupported} could not run` : ''),
  );
  return lines.join('\n');
}

/**
 * The exit code the suite leaves behind.
 *
 * **Zero** when every kind passed, **one** when a kind failed, and **two**
 * when a kind could not run — so a suite that could not measure everything
 * never reads as a suite that measured everything and found nothing wrong.
 */
export function exitCodeOf(report: VerificationReport): number {
  if (report.failed > 0) return 1;
  if (report.unsupported > 0) return 2;
  return report.passed ? 0 : 1;
}

/* -------------------------------------------------------------------------- */
/* The command                                                                  */
/* -------------------------------------------------------------------------- */

/** The command's own arguments. */
interface CommandArguments {
  /** The kinds to run. Every kind by default. */
  readonly kinds: readonly VerificationKind[];
  /** Whether the usage was asked for. */
  readonly help: boolean;
}

/** Read the command's arguments. */
export function readArguments(argv: readonly string[]): CommandArguments {
  const kinds: VerificationKind[] = [];
  let help = false;
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--kind') continue;
    if (argument.startsWith('--kind=')) {
      const named = argument.slice('--kind='.length);
      if ((VERIFICATION_KINDS as readonly string[]).includes(named)) {
        kinds.push(named as VerificationKind);
      }
      continue;
    }
    if ((VERIFICATION_KINDS as readonly string[]).includes(argument)) {
      kinds.push(argument as VerificationKind);
    }
  }
  return { kinds: kinds.length > 0 ? kinds : VERIFICATION_KINDS, help };
}

/** The command's usage. */
const USAGE = [
  'the verification suite — one command, four kinds, one report',
  '',
  'usage: bun run scripts/verify-product.ts [--kind <kind>]...',
  '',
  `the kinds: ${VERIFICATION_KINDS.join(', ')}`,
  '',
  'the exit code: 0 when every kind passed, 1 when a kind failed,',
  '2 when a kind could not run.',
].join('\n');

/** The command. */
export async function main(argv: readonly string[]): Promise<number> {
  const arguments_ = readArguments(argv);
  if (arguments_.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const report = await runVerification({ kinds: arguments_.kinds });
  process.stdout.write(`${formatVerificationReport(report)}\n`);
  return exitCodeOf(report);
}

/** Whether this file is the one that was run. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`the verification suite could not run: ${messageOf(error)}\n`);
      process.exitCode = 1;
    },
  );
}
