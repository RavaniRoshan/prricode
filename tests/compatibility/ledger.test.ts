/**
 * Contract test: the ledger and the plan agree.
 *
 * The plan is the tracking mechanism: every milestone it names must have a row
 * in the ledger, and every milestone the ledger names must be in the plan. A
 * row that goes missing is a milestone that quietly stops being reported, and
 * the report is what a reader trusts.
 *
 * This is a **static** check over two documents — it runs no code and needs no
 * terminal.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** A file in the repository, read by its path from the repository root. */
function read(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

/** The plan's milestones, in the order the plan declares them. */
function planMilestones(): string[] {
  const plan = read('docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md');
  return [...plan.matchAll(/^### (CC-[0-9a-z]+) —/gm)].map((match) => match[1] ?? '');
}

/** The ledger's milestone rows, with their status. */
function ledgerRows(): Map<string, string> {
  const ledger = read('docs/PROGRESS.md');
  const rows = new Map<string, string>();
  for (const match of ledger.matchAll(/^\| `(CC-[0-9a-z]+)`[^|]*\|([^|]*)\|/gm)) {
    rows.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return rows;
}

describe('the ledger and the plan', () => {
  it('has a row for every milestone the plan declares', () => {
    const rows = ledgerRows();
    const missing = planMilestones().filter((milestone) => !rows.has(milestone));
    expect(missing).toEqual([]);
  });

  it('has no row for a milestone the plan does not declare', () => {
    const declared = new Set(planMilestones());
    const extra = [...ledgerRows().keys()].filter((milestone) => !declared.has(milestone));
    expect(extra).toEqual([]);
  });

  it('gives every row a status', () => {
    const withoutStatus = [...ledgerRows()].filter(([, status]) => status.length === 0);
    expect(withoutStatus).toEqual([]);
  });

  it('carries no row twice', () => {
    const ledger = read('docs/PROGRESS.md');
    const ids = [...ledger.matchAll(/^\| `(CC-[0-9a-z]+)`/gm)].map((match) => match[1] ?? '');
    const seen = new Set<string>();
    const twice = ids.filter((id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    });
    expect(twice).toEqual([]);
  });
});
