/**
 * The repository never names the target's product.
 *
 * The product is **PRRICODE**, and the target's own name appears nowhere in this
 * repository — not in a string, not in a comment, not in a document. That is a
 * standing requirement, and this file is what keeps it true: a guard that is
 * only as good as the last time somebody remembered to run it is not a guard.
 *
 * ## What is forbidden, and what is not
 *
 * **Forbidden** — the target's product name, in any case, as a standalone word.
 *
 * - the product name, capitalised, on its own — the product name **is** the
 *   capitalised word, so the full name is caught by the same rule.
 * - the target's program name, in lowercase, when it is used **as a program** —
 *   that is, followed by a flag or an argument. This implementation's program
 *   is `prricode`, so a lowercase program name before a flag is the target's
 *   name, and `prricode` before a flag is this one's.
 *
 * **Not forbidden** — the target's **data**, which this implementation has to
 * speak to:
 *
 * - the model ids (`claude-haiku-5-5`, `anthropic.claude-*`),
 * - the API hosts (`claude.ai`, `*.googleapis.com`),
 * - the environment variables (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CONFIG_DIR`),
 * - the configuration root (`~/.claude`) and the memory file (`CLAUDE.md`),
 * - the MCP proxy header (`x-claude-ai-proxy`),
 * - the settings **key names** (`claudeMd`, `syncClaudeAiSkills`, …) — a
 *   settings file is an interface, and a clone that renamed a key would reject
 *   a file the target accepts,
 * - the target's **tool names**, which the model calls by name.
 *
 * The two rules are therefore different in kind: a **name** is forbidden, a
 * **datum** is not.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The target's product name, spelled in pieces. */
const PRODUCT_NAME = ['Cla', 'ude'].join('');

/** The directories and files the guard reads. */
const ROOTS = ['src', 'tests', 'docs', 'scripts'];
const FILES = ['package.json', 'README.md', 'CONTRIBUTING.md', 'tsconfig.json'];

const TEXT_SUFFIXES = ['.ts', '.tsx', '.md', '.json', '.yml', '.yaml', '.txt', '.mjs', '.cjs', '.js'];

/** The files the guard reads. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const full = path.join(directory, entry);
      let isDirectory = false;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        walk(full);
        continue;
      }
      if (TEXT_SUFFIXES.some((suffix) => entry.endsWith(suffix))) found.push(full);
    }
  };
  walk(root);
  return found;
}

/** Every file the guard reads, in a stable order. */
function guardedFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) files.push(...filesUnder(path.join(REPOSITORY, root)));
  for (const file of FILES) {
    try {
      statSync(path.join(REPOSITORY, file));
      files.push(path.join(REPOSITORY, file));
    } catch {
      // The file is not there; nothing to guard.
    }
  }
  return files.sort();
}

describe('the repository never names the target product', () => {
  it('reads a tree that is not empty', () => {
    // A guard that reads nothing guards nothing.
    expect(guardedFiles().length).toBeGreaterThan(20);
  });

  it('names the target product nowhere', () => {
    const offenders: string[] = [];
    for (const file of guardedFiles()) {
      const text = readFileSync(file, 'utf8');
      // The **capitalised** name as a standalone word. The camelCase data
      // names — `syncClaudeAiSkills`, `ClaudeDesign` — do not match, because
      // the name is a part of a longer identifier there.
      const pattern = new RegExp(`(?<![A-Za-z0-9])${PRODUCT_NAME}(?![A-Za-z0-9])`, 'g');
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(REPOSITORY, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never writes the target program name as a program', () => {
    const offenders: string[] = [];
    for (const file of guardedFiles()) {
      const text = readFileSync(file, 'utf8');
      // A lowercase `claude` followed by a flag or an argument is the target's
      // program. The data — a host, a path, an identifier — is not, and this
      // rule does not touch it.
      const pattern = /(?<![A-Za-z0-9_./-])claude(?=\s+-{1,2}[A-Za-z])/g;
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(REPOSITORY, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the target data, which the implementation has to speak to', () => {
    // The counterpart of the two rules above: the data must still be there.
    // A guard that removed the data would have broken the clone.
    const sources = readFileSync(path.join(REPOSITORY, 'src/config/schema.ts'), 'utf8');
    expect(sources).toContain('claudeMd');
    const args = readFileSync(path.join(REPOSITORY, 'src/cli/args.ts'), 'utf8');
    expect(args).toContain('claude-sonnet-4-5');
  });
});
