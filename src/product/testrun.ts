/**
 * The test run — **the product's own tests, really run**.
 *
 * **One responsibility:** running the test files the build produced, and
 * reporting what each of them did.
 *
 * ## The rule this module exists to keep
 *
 * > **The product's own test run happens: the artefacts the pipeline produced
 * > are run and tested, not merely written.**
 *
 * A file that was described is not a file that works. So the product runs the
 * tests the build produced, and the verdict is the **runner's own**: the
 * process's exit code, and the tests the runner reported. Nothing here reads
 * a file and *decides* that it is fine.
 *
 * ## Why one process per file
 *
 * **Each test file is run on its own, in a process of its own**, in the
 * product's own directory. The reasons are two:
 *
 *   - the **directory**: a test that reads a file by a relative path must see
 *     the product's own directory, and a process is the only thing that can
 *     be *in* a directory;
 *   - the **verdict**: a criterion is met by **the test that covers it**, so
 *     the product has to know which file passed and which did not, and a
 *     process's own report is per file.
 *
 * ## A file that runs no test
 *
 * A test file with **no tests in it** has demonstrated nothing, and it is
 * reported as **not passed**. The runner counts the file itself as a test
 * when the file has none, and it says so: the reported test's name is **the
 * file's own path**, which is the path the product gave the runner. So the
 * product reads the runner's report and asks whether the runner reported a
 * test **other than the file** — and a file that ran none is not a file that
 * passed.
 *
 * A file that could not be run at all — a syntax error, a module that would
 * not load — is **not passed** either, and the runner's own report of the
 * failure is carried into the detail.
 *
 * When the runner's report cannot be read — a format this build does not
 * know — the **exit code** is the verdict, and the file is reported as
 * passed. A report this build cannot read is not evidence of an empty file,
 * and it must not fail a product that works.
 */

import { spawn } from 'node:child_process';

/** What one test file did. */
export interface ProductTestFileResult {
  /** The file that was run. */
  readonly path: string;
  /** Whether the file's tests passed. */
  readonly passed: boolean;
  /** Why, in one line. */
  readonly detail: string;
}

/** The product's own test run. */
export interface ProductTestRun {
  /** Whether every test file passed. */
  readonly passed: boolean;
  /** Every file that was run, in the order it was run. */
  readonly files: readonly ProductTestFileResult[];
  /** The run, in one line. */
  readonly detail: string;
}

/**
 * The runner.
 *
 * It is a **seam**: a deployment that builds its product in another language
 * brings its own runner, and the product's verification asks this and nothing
 * else.
 */
export interface ProductTestRunner {
  /** Run the given files, and report what each of them did. */
  run(files: readonly string[], options: { readonly cwd: string }): Promise<ProductTestRun>;
}

/** How the default runner is built. */
export interface NodeTestRunnerOptions {
  /** The program that runs the tests. The platform's own `node` by default. */
  readonly command?: string;
  /** How long one file may run, in milliseconds. */
  readonly timeoutMs?: number;
}

/** The default wait for one test file. */
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;

/** One test the runner reported. */
interface ReportedTest {
  /** Whether the test passed. */
  readonly passed: boolean;
  /** The name the runner gave the test. */
  readonly name: string;
}

/** The line the runner reports a test on. */
const REPORTED_TEST = /^(✔|✖)\s(.*)\s\(\d+(?:\.\d+)?ms\)$/u;

/**
 * The tests the runner reported.
 *
 * The line is a marker, the test's name, and the time it took. The name may
 * hold anything, so it is read from the end: the time is always the last
 * parenthesised number.
 */
function reportedTests(output: string): ReportedTest[] {
  const tests: ReportedTest[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const match = REPORTED_TEST.exec(line);
    if (match === null) continue;
    tests.push({ passed: match[1] === '✔', name: match[2] ?? '' });
  }
  return tests;
}

/** The last lines of what the runner wrote, as one line. */
function summarise(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return 'the runner said nothing';
  return lines.slice(-2).join(' | ');
}

/** Run one file and report what it did. */
function runFile(
  command: string,
  file: string,
  cwd: string,
  timeoutMs: number,
): Promise<ProductTestFileResult> {
  return new Promise<ProductTestFileResult>((resolve) => {
    const child = spawn(command, ['--test', file], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const collect = (chunk: Buffer | string): void => {
      output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (output.length > 100_000) output = output.slice(-50_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let settled = false;
    const finish = (result: ProductTestFileResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        path: file,
        passed: false,
        detail: `the test file did not finish within ${timeoutMs} ms`,
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (error) => {
      finish({
        path: file,
        passed: false,
        detail: `the test file could not be run: ${error.message}`,
      });
    });

    child.on('close', (code) => {
      const tests = reportedTests(output);
      if (code !== 0) {
        const parts = [`the test file failed with the exit code ${code ?? 'none'}`];
        if (tests.length > 0) {
          parts.push(`${tests.filter((test) => !test.passed).length} of ${tests.length} test(s) failed`);
        }
        parts.push(summarise(output));
        finish({ path: file, passed: false, detail: parts.join(': ') });
        return;
      }
      if (tests.length === 0) {
        // The report could not be read. The exit code is the verdict, and a
        // report this build cannot read is not evidence of an empty file.
        finish({
          path: file,
          passed: true,
          detail: 'the test file passed, and the runner reported no test it could read',
        });
        return;
      }
      if (tests.every((test) => test.name === file)) {
        finish({
          path: file,
          passed: false,
          detail:
            'the test file ran no test, and a file that runs nothing demonstrates nothing',
        });
        return;
      }
      finish({
        path: file,
        passed: true,
        detail: `the test file ran ${tests.length} test(s), and every one of them passed`,
      });
    });
  });
}

/**
 * The default runner — the platform's own test runner, one process per file.
 *
 * The verdict is the runner's own report, and the file's own directory is the
 * product's own directory.
 */
export function nodeTestRunner(options: NodeTestRunnerOptions = {}): ProductTestRunner {
  const command = options.command ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;

  return {
    async run(files, runOptions): Promise<ProductTestRun> {
      if (files.length === 0) {
        return {
          passed: false,
          files: [],
          detail: 'the product has no test file, and a product without tests is not verified',
        };
      }
      const results: ProductTestFileResult[] = [];
      for (const file of files) {
        results.push(await runFile(command, file, runOptions.cwd, timeoutMs));
      }
      const failed = results.filter((result) => !result.passed);
      return {
        passed: failed.length === 0,
        files: results,
        detail:
          failed.length === 0
            ? `${results.length} test file(s) ran, and every one of them passed`
            : `${failed.length} of ${results.length} test file(s) failed`,
      };
    },
  };
}
