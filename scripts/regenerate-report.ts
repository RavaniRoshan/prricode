#!/usr/bin/env bun
/**
 * Regenerate the measured part of the compatibility report.
 *
 * The report's **totals**, its **measured rows** and its **honest gaps** are all
 * derived from the harness: this script runs every scenario and writes what it
 * measured. The report therefore cannot drift from the implementation — the
 * defect a verification found, where a milestone changed the table and left the
 * summary describing the state before it, cannot happen again.
 *
 * What the script does **not** touch: the vocabulary, the rule, the list of
 * conformance documents, and the reproduction notes. Those are prose, and they
 * are the author's.
 *
 * Usage: `bun run scripts/regenerate-report.ts`
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SCENARIOS, measure } from '../tests/compatibility/scenarios.js';

const REPORT = path.resolve(process.cwd(), 'docs/compatibility/results.md');

const OUTCOMES = ['match', 'partial', 'mismatch', 'not-tested', 'unknown'] as const;
type Outcome = (typeof OUTCOMES)[number];

interface Measured {
  rowId: string;
  outcome: Outcome;
  detail: string;
  /** The evidence class the **matrix** carries for the row. */
  evidence?: string;
}

/** The index of the first line that starts with `prefix`, or -1. */
function indexOf(lines: readonly string[], prefix: string, from = 0): number {
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index]?.startsWith(prefix) === true) return index;
  }
  return -1;
}

/** The rows of the table at or after `start`, up to the first blank line. */
function tableRows(lines: readonly string[], start: number, end = lines.length): string[] {
  let at = start;
  while (at < end && !(lines[at] ?? '').startsWith('|')) at += 1;
  const rows: string[] = [];
  for (let index = at; index < end; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') break;
    rows.push(line);
  }
  return rows;
}

/** The index of the next heading of the same or a higher level, or `end`. */
function nextHeading(lines: readonly string[], start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if ((lines[index] ?? '').startsWith('### ') || (lines[index] ?? '').startsWith('## ')) {
      return index;
    }
  }
  return end;
}

/** Run every scenario and collect what it measured. */
export async function measureAll(): Promise<Measured[]> {
  // The **evidence class** comes from the matrix, so the report and the matrix
  // cannot disagree about what kind of claim a row is.
  const matrix = await readFile(
    path.resolve(process.cwd(), 'docs/compatibility/feature-matrix.md'),
    'utf8',
  );
  const evidenceOf = new Map<string, string>();
  for (const match of matrix.matchAll(/^\| (F-[0-9a-z]+) \|[^|]*\|[^|]*\|[^|]*\| ([^|]*)\|/gm)) {
    evidenceOf.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  const measured: Measured[] = [];
  for (const scenario of SCENARIOS) {
    const result = await measure(scenario);
    measured.push({
      rowId: scenario.rowId,
      outcome: result.outcome as Outcome,
      detail: result.detail,
      evidence: evidenceOf.get(scenario.rowId),
    });
  }
  return measured;
}

/**
 * The report's measured parts, derived from what the harness measured.
 *
 * Pure: it takes the report's current text and the measurements, and returns
 * the text with its totals, its measured rows and its honest gaps rewritten.
 */
export function regenerateReport(source: string, measured: readonly Measured[]): string {
  let lines = source.split('\n');

  // --- the totals -------------------------------------------------------
  const counts = new Map<Outcome, number>();
  for (const row of measured) {
    counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  }
  const totalsAt = indexOf(lines, '## The totals');
  if (totalsAt === -1) throw new Error('the report has no totals section');
  const totalsRows = tableRows(lines, totalsAt);
  const totalRow = totalsRows.findIndex((row) => row.includes('**Total**'));
  if (totalRow === -1) throw new Error('the report has no totals row');
  const rewrittenTotals = totalsRows.map((row, index) => {
    if (index === 0 || index === 1) return row;
    if (index === totalRow) return `| **Total** | **${measured.length}** |`;
    const outcome = /\| `([a-z-]+)` \|/.exec(row)?.[1];
    if (outcome === undefined) {
      throw new Error(`the totals table has a row this script cannot read: ${row}`);
    }
    return `| \`${outcome}\` | ${counts.get(outcome as Outcome) ?? 0} |`;
  });
  const totalsTableAt = totalsAt + (totalsRows.length > 0 ? lines.slice(totalsAt).indexOf(totalsRows[0] ?? '') : 0);
  lines = [
    ...lines.slice(0, totalsTableAt),
    ...rewrittenTotals,
    ...lines.slice(totalsTableAt + totalsRows.length),
  ];

  // --- the measured rows -------------------------------------------------
  for (const row of measured) {
    const at = indexOf(lines, `| ${row.rowId} |`);
    if (at === -1) throw new Error(`the report has no row for ${row.rowId}`);
    const cells = (lines[at] ?? '').split(' | ');
    // The **evidence class** comes from the matrix, so the two documents cannot
    // disagree about what kind of claim a row is.
    if (row.evidence !== undefined && row.evidence !== '') cells[3] = row.evidence;
    cells[4] = row.outcome;
    cells[5] = row.detail;
    lines[at] = cells.join(' | ');
  }

  // --- the counts the prose carries --------------------------------------
  // The rule section names the `mismatch` rows, and the mismatch section
  // counts them. Both are derived, so neither can go stale.
  const mismatches = measured.filter((row) => row.outcome === 'mismatch');
  const names = mismatches.map((row) => `\`${row.rowId}\``);
  const listed = names.length === 0
    ? 'no row is'
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const words = [
    'no',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
  ] as const;
  const word: string = words[Math.min(mismatches.length, words.length - 1)] ?? 'no';
  const capital = word.charAt(0).toUpperCase() + word.slice(1);
  lines = lines.map((line) => {
    if (!line.startsWith('- A **divergence from an observed behaviour**')) return line;
    return line.replace(
      /\*\*[A-Za-z]+\*\* rows are `mismatch` for that reason: .*$/,
      `**${capital}** rows are \`mismatch\` for that reason: ${listed}`,
    );
  });
  lines = lines.map((line) => {
    if (!/rows are$/.test(line)) return line;
    return line.replace(/([A-Za-z]+) rows are$/, `${capital} rows are`);
  });

  // --- the honest gaps ---------------------------------------------------
  for (const outcome of OUTCOMES) {
    const heading = `### \`${outcome}\` —`;
    const at = indexOf(lines, heading);
    if (at === -1) continue;
    const sectionEnd = nextHeading(lines, at + 1, lines.length);
    const rows = tableRows(lines, at + 1, sectionEnd);
    const body = measured
      .filter((row) => row.outcome === outcome)
      .map((row) => `| \`${row.rowId}\` | ${row.detail} |`);
    // The table starts at the first `|`-bearing line after the heading; the
    // section's prose sits between them and is left alone.
    let tableStart = at + 1;
    while (tableStart < sectionEnd && !(lines[tableStart] ?? '').startsWith('|')) {
      tableStart += 1;
    }
    if (tableStart >= sectionEnd) continue;
    const end = tableStart + rows.length;
    // The blank line after the table is dropped only when there **is** one:
    // taking it unconditionally would eat the next heading.
    const afterTable = lines[end];
    const blank = afterTable !== undefined && afterTable.trim() === '' ? 1 : 0;
    lines = [
      ...lines.slice(0, tableStart),
      ...(body.length > 0 ? body : []),
      ...(body.length > 0 ? [''] : []),
      ...lines.slice(end + blank),
    ];
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const measured = await measureAll();
  const report = regenerateReport(await readFile(REPORT, 'utf8'), measured);
  await writeFile(REPORT, report, 'utf8');
  const counts = new Map<Outcome, number>();
  for (const row of measured) {
    counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  }
  process.stdout.write(
    `the report now carries ${measured.length} rows: ` +
      OUTCOMES.map((outcome) => `${counts.get(outcome) ?? 0} ${outcome}`).join(', ') +
      '\n',
  );
}

// The script **writes the report** when it is run, and **must not** when it
// is imported: the results test imports it to regenerate the report in memory
// and compare, and an import that rewrote the file would silently undo every
// check that test makes.
if (import.meta.main) await main();
