/**
 * The command — **the product, run from a line**.
 *
 * **One responsibility:** the report the run prints, and the exit code the
 * run leaves behind.
 *
 * ## The rule this module exists to keep
 *
 * > **The product either is verified, or it is not, and it says which.**
 *
 * So the command's report says **which**, in the first line, and the exit
 * code says it too: **zero** when the product is verified, and **one** when
 * it is not. A command that exited zero on a run that did not verify would
 * be the one lie this product is not allowed to tell.
 *
 * The report carries every stage — the ones that completed and the ones that
 * did not — because a stage that was skipped is a stage that was reported.
 *
 * The wiring of a **real** model backend and a **real** approval transport
 * is the deployment's business, and it is not this command's: the command
 * takes the product's options, and the product takes the backends. The
 * terminal surface (`CC-048`) is where the run is driven from a screen.
 */

import { runProduct, type ProductOptions, type ProductResult } from './product.js';

/** Where the command writes. */
export interface ProductCommandIo {
  /** The ordinary output. */
  readonly out: (text: string) => void;
  /** The output that is not ordinary. */
  readonly err: (text: string) => void;
}

/** How the command is run. */
export interface ProductCommandOptions {
  /** The idea the run starts from. */
  readonly brief: string;
  /** How the product is wired — the backends it reaches. */
  readonly product: Omit<ProductOptions, 'brief' | 'workspace'> & { readonly workspace: string };
  /** Where the command writes. */
  readonly io: ProductCommandIo;
}

/**
 * The report of a run.
 *
 * Every stage is in it, in the pipeline's order, with what happened to it.
 */
export function formatProductReport(result: ProductResult): string {
  const lines: string[] = [];
  lines.push(`the product: ${result.state === 'verified' ? 'verified' : 'not verified'}`);
  lines.push(`the run: ${result.runId}`);
  lines.push(`the idea: ${result.brief}`);

  lines.push('the stages:');
  for (const record of result.run.records) {
    const detail =
      record.state === 'completed'
        ? (record.output?.summary ?? 'the stage completed')
        : (record.reason ?? 'the stage did not proceed');
    lines.push(`  ${record.stageId}: ${record.state} — ${detail}`);
  }

  lines.push(`the documents: ${result.documents.length}`);

  const verification = result.verification;
  if (verification !== null) {
    lines.push(`the product's own test run: ${verification.tests.detail}`);
    for (const check of verification.checks) {
      lines.push(
        `  criterion ${check.index}: ${check.passed ? 'met' : 'not met'} — ${check.detail}`,
      );
    }
    lines.push(`the comparison: ${verification.comparison.detail}`);
  }

  if (result.reason !== null) {
    lines.push(`why the product is not verified: ${result.reason}`);
  }
  for (const diagnostic of result.diagnostics) {
    lines.push(`the product found: ${diagnostic}`);
  }

  return lines.join('\n');
}

/**
 * Run the product, and report it.
 *
 * The exit code is **zero** when the product is verified and **one** when it
 * is not.
 */
export async function runProductCommand(options: ProductCommandOptions): Promise<number> {
  const result = await runProduct({
    ...options.product,
    brief: options.brief,
  });
  const report = formatProductReport(result);
  if (result.verified) {
    options.io.out(report);
    return 0;
  }
  options.io.err(report);
  return 1;
}
