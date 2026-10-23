/**
 * The **frame plan** — the beat table the demo GIF is drawn from.
 *
 * ## What this module is
 *
 * A run the interactive UI is driven through, in the 8-phase grid the
 * storyboard fixes — cold open, submit, first stream, the ledger, the
 * verification run, the fix, the dense resolution, the verified end card —
 * with the repository's own product run substituted in: the tiny example
 * product the product kind builds (a tool that reads a build log and
 * explains the failure in one line), the over-claiming test the run catches,
 * and the report the run prints when the product is verified.
 *
 * Every row is a record the real app renders (`src/ui/render/messages.ts`);
 * every tool call names a tool the registry holds, with the summary the
 * renderer's own summariser produces; every result line is what one of this
 * repository's own tools or report formats prints; every stage id and stage
 * state is the pipeline's own. The quoted source lines (and the search
 * counts) are lines this repository really carries.
 *
 * The builder is **linear**: the run's records are pushed as the run's steps
 * happen, and each beat takes a snapshot of what had arrived before it
 * opened. A tool call lands in one beat, and its result lands in a later
 * beat — the way a real turn streams — so a beat can hold a call whose answer
 * has not arrived yet.
 *
 * Every result envelope carries the tool-use id of the call it answers: the
 * transcript renderer pairs a result with its call through that member, and
 * an unpaired result renders as the renderer's own mismatch report.
 */

import type { Beat, DemoEvent } from './events.js';

/* -------------------------------------------------------------------------- */
/* The run's own constants — the repository's, quoted                          */
/* -------------------------------------------------------------------------- */

/** The brief the run answers. The product kind's own brief. */
export const BRIEF = 'A tool that reads a build log and explains the failure in one line.';

/**
 * The run id of the demo's run, in the run's own shape:
 * `run_<base36 instant>_<counter>`. The instant is fixed so replaying the
 * capture is reproducible.
 */
export const RUN_ID = `run_${Math.floor(1.77e12).toString(36)}_3`;

/** The phase boundaries the storyboard fixes, in frames. */
export const PHASE_BOUNDS: readonly number[] = [0, 3, 21, 75, 144, 196, 253, 341, 414];

/** How many beats each phase takes, in the storyboard's order. */
export const PHASE_BEATS: readonly number[] = [1, 4, 12, 9, 6, 7, 11, 9];

/** What each phase is called, in the storyboard's order. */
export const PHASE_NAMES: readonly string[] = [
  'cold open',
  'submit',
  'first stream',
  'the ledger',
  'the verification run',
  'the ask and the fix',
  'the dense resolution',
  'the end card',
];

/** The frames the six storyboard holds sit at, with their holds. */
export const HOLDS: ReadonlyMap<number, number> = new Map<number, number>([
  [2, 400],
  [13, 400],
  [74, 200],
  [189, 200],
  [195, 200],
  [252, 200],
]);

/** The build's artefacts, with the content the run's own fixture gives. */
const LAST_LINE =
  "export const lastLine = (text) => { const lines = String(text).split('\\n');" +
  " return (lines[lines.length - 1] ?? '').trim(); };";
const LAST_LINE_TEST =
  "import { test } from 'node:test'; import assert from 'node:assert';" +
  " import { lastLine } from 'src/last-line.mjs';" +
  " test('the last line is reported', () => { assert.equal(lastLine('one\\ntwo\\nthree'), 'three'); });";
const EXPLAIN =
  "export const explain = (line) => line.includes('error')" +
  " ? 'the build failed: ' + line : 'the build passed';";

/** The over-claiming test — the one the run catches. */
const EXPLAIN_TEST_FAILING =
  "import { test } from 'node:test'; import assert from 'node:assert';" +
  " import { explain } from 'src/explain.mjs';" +
  " test('the failure is explained in one line', () => { assert.equal(explain('error: it broke'), 'the build passed'); });";

/* Real repository lines the reads and searches produce — this repository's
 * own lines, at these exact offsets. */
const REAL_STAGE_IDS = [
  'src/pipeline/stage.ts:65: export const PIPELINE_STAGE_IDS = [',
  "src/pipeline/stage.ts:66:   'concept',",
  "src/pipeline/stage.ts:67:   'clarify',",
  "src/pipeline/stage.ts:68:   'specify',",
];

const REAL_GREP_REPORT_LINES = [
  "src/product/command.ts:52:   lines.push(`the product: ${result.state === 'verified' ? 'verified' : 'not verified'}`);",
  'src/product/command.ts:53:   lines.push(`the run: ${result.runId}`);',
  'src/product/command.ts:54:   lines.push(`the idea: ${result.brief}`);',
];

const REAL_GREP_CRITERION_COUNTS = [
  'src/product/verification.ts:41',
  'src/product/command.ts:1',
  'src/product/testrun.ts:1',
];

const REAL_GREP_VERIFIED_COUNTS = ['src/product/product.ts:13', 'src/product/command.ts:6'];

const REAL_GREP_COVER = [
  'src/product/verification.ts:29: * covers a criterion is a test file the build produced that names the',
  "src/product/verification.ts:30: * criterion, and the coverage is the build's own: the `satisfies` number the",
  'src/product/verification.ts:31: * file carries is the criterion it delivers.',
];

const REAL_GREP_CLAIM = [
  "src/product/verification.ts:272:     detail = 'the run claimed what the product does, and the product does what the run claimed';",
];

const REAL_GLOB_PRODUCT = [
  'src/product/approvals.ts',
  'src/product/command.ts',
  'src/product/index.ts',
  'src/product/model.ts',
  'src/product/product.ts',
  'src/product/testrun.ts',
  'src/product/verification.ts',
  'src/product/workspace.ts',
];

const REAL_READ_TESTRUN = [
  'src/product/testrun.ts:26:  * A criterion is met when **a test that covers it passes**. The test that',
  'src/product/testrun.ts:27:  * covers a criterion is a test file the build produced that names the',
  "src/product/testrun.ts:28:  * criterion, and the coverage is the build's own.",
];

/** The report the run prints, in the report format's own lines. */
const REPORT_LINES = [
  'the product: verified',
  `the run: ${RUN_ID}`,
  `the idea: ${BRIEF}`,
  'the stages:',
  '  concept: completed — the stage completed',
  '  clarify: completed — the stage completed',
  '  specify: completed — the stage completed',
  '  plan: completed — the stage completed',
  '  build: completed — the stage completed',
  '  verify: completed — the stage completed',
  '  ship: completed — the stage completed',
  '  operate: completed — the stage completed',
  'the documents: 8',
  "the product's own test run: 2 test file(s) ran, and every one of them passed",
  '  criterion 1: met — 1 test(s) cover it, and every one of them passed',
  '  criterion 2: met — 1 test(s) cover it, and every one of them passed',
  'the comparison: the run claimed what the product does, and the product does what the run claimed',
];

/* -------------------------------------------------------------------------- */
/* The builder                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The beats. The tool names are the registry's own, the stage ids are the
 * pipeline's own, the search results are this repository's lines, and the
 * result lines are what this repository's tools print for them.
 */
/*
 * The beats live below the builder's own helpers: the builder runs when the
 * module is evaluated, and it uses the helpers the module defines first.
 */

/** The run's records the builder pushes, in the order the run happened. */

/** The run's records the builder pushes, in the order the run happened. */
const events: DemoEvent[] = [];

const push = (event: DemoEvent): void => {
  events.push(event);
};

/** The records so far — exactly what a beat opened at that moment holds. */
const wave = (): readonly DemoEvent[] => events.map((event) => event);

/** Push a tool call. */
const call = (name: string, input: unknown): string => {
  const id = letter();
  push({ t: 'tool_call', id, name, input });
  return id;
};
/** Push a text result for the call the id names. */
const text = (id: string, lines: readonly string[] | string): void => {
  push({
    t: 'tool_result',
    id,
    envelope: {
      id,
      content: { type: 'text', text: Array.isArray(lines) ? lines.join('\n') : lines },
      isError: false,
    },
  });
};
/** Push an errored result for the call the id names. */
const errorEnvelope = (id: string, message: string): void => {
  push({
    t: 'tool_result',
    id,
    envelope: { id, content: { type: 'error', message }, isError: true },
  });
};
/** Push a sandboxed Bash result for the call the id names. */
const bash = (id: string, exitCode: number, stdout: string): void => {
  push({
    t: 'tool_result',
    id,
    envelope: { id, content: { sandboxed: true, exitCode, stdout }, isError: false },
  });
};
/** Push one of the model's messages. */
const say = (body: string): void => {
  push({ t: 'assistant_message', text: body });
};
/** Push a write's own result line. */
const wrote = (id: string, path: string, content: string): void => {
  push({
    t: 'tool_result',
    id,
    envelope: {
      id,
      content: { type: 'text', text: `Wrote ${content.split('\n').length} lines to ${path}.` },
      isError: false,
    },
  });
};
/** Push an edit's own result line. */
const edit = (id: string, path: string, occurrences: number): void => {
  push({
    t: 'tool_result',
    id,
    envelope: {
      id,
      content: {
        type: 'text',
        text: `Replaced ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${path}.`,
      },
      isError: false,
    },
  });
};

/** The event bookkeeping's own counter: ids in the letters the records use. */
let counter = 0;
function letter(): string {
  const digits = 'abcdefghijklmnopqrstuvwxyz';
  let id = '';
  let value = counter++;
  do {
    id = `${digits[value % 26]}${id}`;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return id;
}

/** Hold the screen for one beat. */
const hold = (
  frames: number,
  rest: Omit<Beat, 'events' | 'frames'>,
): Beat => ({ events: wave(), frames, ...rest });

/**
 * The beats. The tool names are the registry's own, the stage ids are the
 * pipeline's own, the search results are this repository's lines, and the
 * result lines are what this repository's tools print for them.
 */
export const BEATS: readonly Beat[] = buildBeats();

/* -------------------------------------------------------------------------- */
/* The beats                                                                   */
/* -------------------------------------------------------------------------- */

function buildBeats(): Beat[] {
  const beats: Beat[] = [];

  /* ------------------------------------------------------------------ P1 -- */
  // The cold open: the idea's complete line is in the composer from the first
  // frame; the block cursor is the compositor's, drawn once. No records yet.
  beats.push({ events: [], input: BRIEF, busy: false, frames: 3 });

  /* ------------------------------------------------------------------ P2 -- */
  // Submit: the return-key pill marks the keystroke, the user's row commits
  // on the band, and the turn starts running.
  push({ t: 'user_message', text: BRIEF });
  beats.push(hold(2, { input: '', busy: true, status: 'Working', pill: 'enter' }));
  beats.push(hold(5, { input: '', busy: true, status: 'Working', from: 'idle', to: 'thinking' }));
  beats.push(hold(3, { input: '', busy: true, status: 'Working' }));
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  /* ------------------------------------------------------------------ P3 -- */
  // Thinking gives way to the first stream: the concept stage advances, and
  // the first reads and searches arrive as row pairs — each call in one
  // beat, its result in the next.
  const a = call('Read', { file_path: 'src/pipeline/stage.ts' });
  beats.push(hold(5, { input: '', busy: true, status: 'Working', from: 'thinking', to: 'tool', stageId: 'concept', stageState: 'running' }));
  text(a, REAL_STAGE_IDS);
  beats.push(hold(3, { input: '', busy: true, status: 'Working', stageId: 'concept', stageState: 'running' }));

  const b = call('Bash', { command: 'git branch' });
  bash(b, 0, '* main');
  beats.push(hold(5, { input: '', busy: true, status: 'Working', stageId: 'concept', stageState: 'completed' }));

  const c = call('Grep', { pattern: 'criterion', output_mode: 'count', path: 'src/product' });
  text(c, REAL_GREP_CRITERION_COUNTS);
  beats.push(hold(5, { input: '', busy: true, status: 'Working', stageId: 'clarify', stageState: 'running' }));

  const d = call('Grep', { pattern: 'verified', output_mode: 'count', path: 'src/product' });
  text(d, REAL_GREP_VERIFIED_COUNTS);
  beats.push(hold(5, { input: '', busy: true, status: 'Working', stageId: 'clarify', stageState: 'running' }));

  const e = call('Glob', { pattern: 'src/product/*.ts' });
  text(e, REAL_GLOB_PRODUCT);
  beats.push(hold(5, { input: '', busy: true, status: 'Working', stageId: 'clarify', stageState: 'completed' }));

  const f = call('Read', { file_path: 'src/product/testrun.ts' });
  text(f, REAL_READ_TESTRUN);
  beats.push(hold(5, { input: '', busy: true, status: 'Working', stageId: 'specify', stageState: 'running' }));

  say('the concept reads the last line of the build log and reports it, so the failure is in plain words.');
  beats.push(hold(3, { input: '', busy: true, status: 'Working' }));

  const g = call('Grep', { pattern: 'the product: ', output_mode: 'content', path: 'src/product' });
  text(g, REAL_GREP_REPORT_LINES);
  beats.push(hold(5, { input: '', busy: true, status: 'Working', stageId: 'specify', stageState: 'completed' }));

  const h = call('Grep', { pattern: 'a test that covers it', output_mode: 'content', path: 'src/product' });
  text(h, REAL_GREP_COVER);
  beats.push(hold(5, { input: '', busy: true, status: 'Working', stageId: 'plan', stageState: 'running' }));

  const i = call('Read', { file_path: 'src/product/verification.ts' });
  text(i, [REAL_GREP_COVER[0] ?? '', REAL_GREP_COVER[1] ?? ''].join('\n'));
  beats.push(hold(3, { input: '', busy: true, status: 'Working' }));

  const j = call('Bash', { command: 'wc -l src/product/verification.ts' });
  bash(j, 0, '281 src/product/verification.ts');
  beats.push(hold(5, { input: '', busy: true, status: 'Working', stageId: 'plan', stageState: 'completed' }));

  /* ------------------------------------------------------------------ P4 -- */
  // The ledger: writes and reads stream fast, and the build stage advances.
  const k = call('Grep', { pattern: 'the stage completed', output_mode: 'content', path: 'src/pipeline' });
  text(k, ["src/pipeline/pipeline.ts:300:       if (outcome.state === 'completed') {"]);
  beats.push(hold(8, { input: '', busy: true, status: 'Working', stageId: 'build', stageState: 'running' }));

  say('the build writes the module that reads the last line first, then the test that covers it.');
  const l = call('Write', { file_path: 'src/last-line.mjs', content: LAST_LINE });
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  wrote(l, 'src/last-line.mjs', LAST_LINE);
  const m = call('Write', { file_path: 'test/last-line.test.mjs', content: LAST_LINE_TEST });
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  wrote(m, 'test/last-line.test.mjs', LAST_LINE_TEST);
  say('the last line is reported by the module, and the test covers the criterion it satisfies.');
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  const n = call('Read', { file_path: 'src/last-line.mjs' });
  text(n, LAST_LINE);
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  const o = call('Grep', { pattern: 'lastLine', output_mode: 'count', path: 'src/last-line.mjs' });
  text(o, ['src/last-line.mjs:1']);
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  const p = call('Bash', { command: 'wc -l src/last-line.mjs test/last-line.test.mjs' });
  bash(p, 0, '1 src/last-line.mjs\n2 test/last-line.test.mjs');
  beats.push(hold(7, { input: '', busy: true, status: 'Working' }));

  say('the plan has two steps, and each one satisfies an acceptance criterion the build covers with its own test.');
  beats.push(hold(7, { input: '', busy: true, status: 'Working' }));
  beats.push(hold(7, { input: '', busy: true, status: 'Working' }));

  /* ------------------------------------------------------------------ P5 -- */
  // The verification run, and the failing verdict the run catches.
  const q = call('Write', { file_path: 'src/explain.mjs', content: EXPLAIN });
  beats.push(hold(9, { input: '', busy: true, status: 'Working' }));

  wrote(q, 'src/explain.mjs', EXPLAIN);
  const r = call('Write', { file_path: 'test/explain.test.mjs', content: EXPLAIN_TEST_FAILING });
  beats.push(hold(9, { input: '', busy: true, status: 'Working' }));

  wrote(r, 'test/explain.test.mjs', EXPLAIN_TEST_FAILING);
  const s = call('Bash', { command: 'node --test test/last-line.test.mjs' });
  beats.push(hold(9, { input: '', busy: true, status: 'Working' }));

  bash(s, 0, 'the test file ran 1 test(s), and every one of them passed');
  const t = call('Bash', { command: 'node --test test/explain.test.mjs' });
  beats.push(hold(9, { input: '', busy: true, status: 'Working' }));

  errorEnvelope(
    t,
    'the test file failed with the exit code 1: 1 of 1 test(s) failed' +
      ' — the test file did not meet the criterion it covers: the failure is explained in one line',
  );
  beats.push(hold(8, { input: '', busy: true, status: 'Working', stageId: 'build', stageState: 'completed' }));

  const u = call('Bash', { command: 'git diff -- test/explain.test.mjs' });
  bash(
    u,
    0,
    `-  test('the failure is explained in one line', () => { assert.equal(explain('error: it broke'), 'the build passed'); });\n` +
    `+  test('the failure is explained in one line', () => { assert.equal(explain('error: it broke'), 'the build failed: error: it broke'); });`,
  );
  say('the test that covers the second criterion fails: the expected line says the build passed, and the product says what the build failed with.');
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  /* ------------------------------------------------------------------ P6 -- */
  // The ask, the fix, and the re-run: the run reads the failing test, writes
  // the fix, and the host asks before the corrected run executes — the ask is
  // answered with a return-key pill, and the re-run passes.
  const v = call('Read', { file_path: 'test/explain.test.mjs' });
  beats.push(hold(9, { input: '', busy: true, status: 'Working' }));

  text(v, EXPLAIN_TEST_FAILING);
  const w = call('Edit', {
    file_path: 'test/explain.test.mjs',
    old_string: "'the build passed'",
    new_string: "'the build failed: error: it broke'",
  });
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  edit(w, 'test/explain.test.mjs', 1);
  const x = call('Bash', { command: 'node --test test/explain.test.mjs' });
  beats.push(hold(8, { input: '', busy: true, status: 'Working', approval: 'Bash', from: 'tool', to: 'asking' }));
  beats.push(hold(8, { input: '', busy: true, status: 'Working', approval: 'Bash', pill: 'enter' }));
  bash(x, 0, 'the test file ran 1 test(s), and every one of them passed');
  beats.push(hold(8, { input: '', busy: true, status: 'Working', from: 'asking', to: 'tool' }));

  const y = call('Bash', { command: 'git status --short' });
  bash(y, 0, ' M src/explain.mjs\n M test/explain.test.mjs');
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  const z = call('Grep', { pattern: 'criterion', output_mode: 'count', path: 'src/product/verification.ts' });
  text(z, [REAL_GREP_CRITERION_COUNTS[0] ?? '']);
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  /* ------------------------------------------------------------------ P7 -- */
  // Dense resolution: the executed verdicts and the claim agree, the
  // verify/ship/operate advances run, and the ledger scrolls.
  const aa = call('Bash', { command: 'node --test test/last-line.test.mjs test/explain.test.mjs' });
  beats.push(hold(8, { input: '', busy: true, status: 'Working', stageId: 'verify', stageState: 'running' }));

  bash(aa, 0, '2 test file(s) ran, and every one of them passed');
  say('criterion 1: met — 1 test(s) cover it, and every one of them passed');
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  say('criterion 2: met — 1 test(s) cover it, and every one of them passed');
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  const ab = call('Grep', { pattern: 'the run claimed what the product does', output_mode: 'content', path: 'src/product' });
  text(ab, REAL_GREP_CLAIM);
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  const ac = call('Read', { file_path: 'src/product/verification.ts' });
  text(ac, REAL_GREP_COVER);
  beats.push(hold(8, { input: '', busy: true, status: 'Working', stageId: 'verify', stageState: 'completed' }));

  const ad = call('Glob', { pattern: 'documents/*.json' });
  text(ad, [
    'documents/concept.json',
    'documents/clarify.json',
    'documents/specify.json',
    'documents/plan.json',
    'documents/build.json',
    'documents/verify.json',
    'documents/ship.json',
    'documents/operate.json',
  ]);
  beats.push(hold(8, { input: '', busy: true, status: 'Working', stageId: 'ship', stageState: 'running' }));

  say('the run writes the eight documents it holds, and the release the run claimed is in them.');
  beats.push(hold(8, { input: '', busy: true, status: 'Working', stageId: 'ship', stageState: 'running' }));

  const ae = call('Grep', { pattern: 'verified', output_mode: 'count', path: 'src/product/product.ts' });
  text(ae, ['src/product/product.ts:13']);
  beats.push(hold(8, { input: '', busy: true, status: 'Working', stageId: 'ship', stageState: 'completed' }));

  const af = call('Read', { file_path: 'src/product/product.ts' });
  beats.push(hold(8, { input: '', busy: true, status: 'Working', stageId: 'operate', stageState: 'running' }));

  text(af, ['  const runId = options.runId ?? `run_${Date.now().toString(36)}_${runCounter}`;']);
  beats.push(hold(8, { input: '', busy: true, status: 'Working' }));

  beats.push(hold(8, { input: '', busy: true, status: 'Working', stageId: 'operate', stageState: 'completed' }));

  /* ------------------------------------------------------------------ P8 -- */
  // Settle, and the end card: the run's own report is the last block, the
  // status row carries the turn's own wording, and the esc gesture's toast
  // is the armed one. The last frames hold; the GIF does not loop a second
  // story in place of the still end card.
  say(REPORT_LINES.join('\n'));
  beats.push(hold(9, { input: '', busy: true, status: 'Working', from: 'tool', to: 'idle' }));
  beats.push(hold(8, { input: '', busy: false, status: 'The turn finished.' }));
  beats.push(hold(8, { input: '', busy: false }));
  beats.push(hold(8, { input: '', busy: false, notice: 'Esc again to clear', pill: 'esc' }));
  beats.push(hold(8, { input: '', busy: false }));
  beats.push(hold(8, { input: '', busy: false }));
  beats.push(hold(8, { input: '', busy: false }));
  beats.push(hold(8, { input: '', busy: false }));
  beats.push(hold(8, { input: '', busy: false }));

  return beats;
}
