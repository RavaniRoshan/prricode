#!/usr/bin/env bun
/**
 * verify-all — the one-command, human-equivalent verification harness.
 *
 * Runs every gate the repository documents (type check, full test suite, the
 * compatibility report regeneration, the REA surface re-derivation, and the
 * product suite) in order, prints a single pass/fail line per gate, and exits
 * non-zero if any gate fails. This is the harness an operator runs to confirm
 * the tree is "ready" without remembering the individual commands.
 */
import { spawnSync } from 'node:child_process';

interface Gate {
  name: string;
  command: string;
  args: string[];
}

const gates: Gate[] = [
  { name: 'type check (tsc --noEmit)', command: 'npx', args: ['tsc', '--noEmit'] },
  { name: 'full test suite (vitest)', command: 'npx', args: ['vitest', 'run', '--maxWorkers=4'] },
  { name: 'compatibility report (regenerate-report)', command: 'bun', args: ['run', 'scripts/regenerate-report.ts'] },
  { name: 'REA surface re-derivation (verify-rea)', command: 'bun', args: ['run', 'scripts/verify-rea.ts'] },
  { name: 'product suite (verify-product)', command: 'bun', args: ['run', 'scripts/verify-product.ts'] },
];

let failed = 0;
const started = Date.now();
console.log('verify-all: running', gates.length, 'gates...\n');

for (const gate of gates) {
  const t0 = Date.now();
  process.stdout.write(`[RUN ] ${gate.name} ...\n`);
  const result = spawnSync(gate.command, gate.args, {
    stdio: 'inherit',
    shell: false,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`[PASS] ${gate.name}  (${elapsed}s)\n`);
  } else {
    failed += 1;
    console.log(
      `[FAIL] ${gate.name}  (exit ${result.status ?? 'signal ' + result.signal}, ${elapsed}s)\n`,
    );
  }
}

const total = ((Date.now() - started) / 1000).toFixed(1);
console.log('────────────────────────────────────────────');
if (failed === 0) {
  console.log(`verify-all: ALL ${gates.length} GATES PASSED  (${total}s)`);
  process.exit(0);
} else {
  console.log(`verify-all: ${failed} of ${gates.length} GATES FAILED  (${total}s)`);
  process.exit(1);
}