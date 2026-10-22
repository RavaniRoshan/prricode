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
 * tests the build produced, **in a process of their own**, and the verdict is
 * the process's own exit code. Nothing here reads a file and *decides* that
 * it is fine: the only evidence that a test passed is that the runner that
 * ran it said so.
 *
 * ## Why one process per file
 *
 * **Each test file is run on its own**, and the reason is the verification:
 * a criterion is met by **the test that covers it**, so the product has to
 * know which file passed and which did not. Running the suite as one process
 * and reading its report would mean parsing a report whose format belongs to
 * the runner; running each file on its own means the verdict is the exit
 * code, which is the runner's own and cannot be misread.
 *
 * The cost is one process per file. A product's test suite is a handful of
 * files, and the run is not on an interactive path.
 *
 * ## A file that runs no tests
 *
 * A test file with **no tests in it** has demonstrated nothing, and it is
 * reported as **not passed**. The exit code alone cannot tell an empty file
 * from a passing one, so the runner reads the summary the runner prints and
 * asks whether any test passed. A file that ran a test and passed is passed;
 * a file that ran no test is not.
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

/** The last lines of the runner's output, as one line. */
function summarise(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return 'the runner said nothing';
  return lines.slice(-3).join(' | ');
}

/** Whether the runner's output reports that a test passed. */
function reportsAPassedTest(output: string): boolean {
  return /(^|\s)pass (\d+)/.test(output) || /(^|\s)✔/.test(output);
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
      finish({ path: file, passed: false, detail: `the test file did not finish within ${timeoutMs} ms` });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (error) => {
      finish({ path: file, passed: false, detail: `the test file could not be run: ${error.message}` });
    });

    child.on('close', (code) => {
      if (code === 0) {
        if (!reportsAPassedTest(output)) {
          finish({
            path: file,
            passed: false,
            detail: 'the test file ran no test, and a file that runs nothing demonstrates nothing',
          });
          return;
        }
        finish({ path: file, passed: true, detail: `the test file passed: ${summarise(output)}` });
        return;
      }
      finish({
        path: file,
        passed: false,
        detail: `the test file failed with the exit code ${code ?? 'none'}: ${summarise(output)}`,
      });
    });
  });
}

/**
 * The default runner — the platform's own test runner, one process per file.
 *
 * The arguments are `--test <file>`, which is the runner's own way of running
 * one file as a test file, and the file's own exit code is the verdict.
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
