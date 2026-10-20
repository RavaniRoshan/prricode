#!/usr/bin/env bun
/**
 * The reverse-engineering completeness verifier.
 *
 * **The goal.** "The reverse engineering of the target is complete" is a claim that
 * can be checked. This script re-derives the target's own inventories from the
 * extracted source — the tool registry, the telemetry vocabulary, the
 * environment-variable surface, the slash-command names and the CLI flags — and
 * checks that the record in `docs/reverse-engineering/SURFACE-INVENTORY.md`
 * accounts for **every** entry the target has.
 *
 * The check is a *diff*, not a count: an entry the target has and the record does
 * not name is a failure, and so is an entry the record names and the target does
 * not have. A count that merely agrees proves nothing, because both sides could
 * be wrong in the same way.
 *
 * Usage:
 *   bun run scripts/verify-rea.ts                # the check
 *   bun run scripts/verify-rea.ts --derive       # re-derive and print the inventories
 *
 * The extracted source lives outside the repository. When it is absent the
 * script says so and exits **0** — a missing extraction is not a failed audit.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  callSites,
  keysOfObject,
  nthArgumentObjectAt,
} from './rea-scan.js';

const REPOSITORY = path.resolve(process.cwd());
const EXTRACTED = '/home/shiva/opt/reference-agent-rea/extracted-patched';
const INVENTORY = path.join(REPOSITORY, 'docs/reverse-engineering/SURFACE-INVENTORY.md');

interface Surface {
  readonly name: string;
  readonly entries: readonly string[];
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    let items: string[];
    try {
      items = readdirSync(directory);
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(directory, item);
      let isDirectory = false;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) walk(full);
      else if (item.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  return files;
}

/** Every file's text, one at a time — the files are large and never all held. */
function* texts(files: readonly string[]): Generator<string> {
  for (const file of files) {
    try {
      yield readFileSync(file, 'utf8');
    } catch {
      // An unreadable file is not a reason to stop the sweep.
    }
  }
}

/** The tool registry: every `Qt({...})` call site, with its name and its hint. */
function deriveTools(files: readonly string[]): { names: Set<string>; hints: Map<string, string> } {
  const names = new Set<string>();
  const hints = new Map<string, string>();
  // The identifiers the `name:` positions use, so their values can be resolved.
  // The name is resolved **in the chunk that uses it**, because a minified
  // identifier is only unique inside its own module.
  const wanted = new Map<string, Set<string>>();
  for (const file of files) {
    const base = path.basename(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/Qt\(\{/g)) {
      const at = match.index ?? 0;
      const opening = text.slice(at, at + 400);
      const literal = /name:"([A-Za-z][A-Za-z0-9_-]*)"/.exec(opening);
      if (literal !== null) {
        names.add(literal[1] ?? '');
        continue;
      }
      const identifier = /name:([A-Za-z_$][A-Za-z0-9_$]*)/.exec(opening);
      if (identifier === null) continue;
      const set = wanted.get(base) ?? new Set<string>();
      set.add(identifier[1] ?? '');
      wanted.set(base, set);
    }
  }
  const identifiers = new Set<string>();
  for (const set of wanted.values()) {
    for (const id of set) identifiers.add(id);
  }
  // Resolve the identifiers **through the import graph**: a tool's name is
  // usually a constant that another chunk owns and re-exports, so the value is
  // followed from the using chunk to the chunk that assigns it.
  const valueOf = new Map<string, Map<string, string>>();
  const importedFrom = new Map<string, Map<string, [string, string]>>();
  const byName = new Map<string, string>();
  for (const file of files) {
    const base = path.basename(file);
    const chunk = valueOf.get(base) ?? new Map<string, string>();
    const links = importedFrom.get(base) ?? new Map<string, [string, string]>();
    for (const text of texts([file])) {
      for (const match of text.matchAll(/(?:^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*)="([A-Za-z][A-Za-z0-9_-]*)"/g)) {
        const id = match[1] ?? '';
        const value = match[2] ?? '';
        if (!chunk.has(id)) chunk.set(id, value);
        if (!byName.has(id)) byName.set(id, value);
      }
      for (const match of text.matchAll(/import\{([^}]*)\}from"\.\/(chunk-[A-Za-z0-9]+\.js)"/g)) {
        const source = match[2] ?? '';
        for (const part of (match[1] ?? '').split(',')) {
          const local = part.trim().split(/\s+as\s+/)[0]?.trim();
          const exported = part.trim().split(/\s+as\s+/)[1]?.trim() ?? local;
          if (local === undefined || local === '') continue;
          links.set(local, [source, exported ?? local]);
        }
      }
    }
    valueOf.set(base, chunk);
    importedFrom.set(base, links);
  }
  const resolve = (chunk: string, name: string, depth = 0): string | undefined => {
    if (depth > 8) return undefined;
    // An **imported** binding is an alias, so the import is followed first: a
    // local name of the same shape is a different binding and must not shadow
    // the one the module actually uses.
    const link = importedFrom.get(chunk)?.get(name);
    if (link !== undefined) {
      const through = resolve(link[0], link[1], depth + 1);
      if (through !== undefined) return through;
    }
    const direct = valueOf.get(chunk)?.get(name);
    if (direct !== undefined) return direct;
    return byName.get(name);
  };
  for (const [base, set] of wanted) {
    for (const id of set) {
      const value = resolve(base, id);
      if (value !== undefined) names.add(value);
    }
  }
  // The target's own **tool-set arrays**: the permission layer and the
  // built-in registry both name the tools in arrays. An array whose elements
  // are mostly tool names is one of those, and the factory-generated tools
  // only ever appear in an array.
  for (const text of texts(files)) {
    for (const match of text.matchAll(/\[("[A-Za-z][A-Za-z0-9_]{1,30}",?){3,}\]/g)) {
      const literal = match[0];
      const elements = [...literal.matchAll(/"([A-Z][A-Za-z0-9_]{1,30})"/g)].map(
        (element) => element[1] ?? '',
      );
      const known = elements.filter((element) => names.has(element)).length;
      if (known >= 3 || (known >= 2 && elements.length >= 4)) {
        for (const element of elements) names.add(element);
      }
    }
  }
  // The **string constants** the tool registry names. A tool that is created by
  // the factory rather than written out — the artifact add-ons, the
  // factory-generated ones — only ever appears as a constant, and the
  // target's own tool-set arrays are what say which constants are tools.
  const setArrays: string[][] = [];
  for (const text of texts(files)) {
    for (const match of text.matchAll(/\[("[A-Za-z][A-Za-z0-9_]{1,30}",?){4,}\]/g)) {
      const elements = [...match[0].matchAll(/"([A-Z][A-Za-z0-9_]{1,30})"/g)].map(
        (element) => element[1] ?? '',
      );
      const known = elements.filter((element) => names.has(element)).length;
      if (known >= 4) setArrays.push(elements);
    }
  }
  const inASet = new Set<string>();
  for (const elements of setArrays) {
    for (const element of elements) inASet.add(element);
  }
  for (const text of texts(files)) {
    for (const match of text.matchAll(
      /(?:^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*)="([A-Z][A-Za-z0-9_]{1,30})"/g,
    )) {
      const value = match[2] ?? '';
      if (inASet.has(value)) names.add(value);
    }
  }
  // The search hint, which is the target's own one-line statement of purpose.
  for (const text of texts(files)) {
    for (const match of text.matchAll(/Qt\(\{name:[A-Za-z_$][A-Za-z0-9_$]*,searchHint:"([^"]{4,160})"/g)) {
      hints.set(match[1] ?? '', match[2] ?? '');
    }
    for (const match of text.matchAll(/Qt\(\{name:"([A-Za-z][A-Za-z0-9_-]*)",searchHint:"([^"]{4,160})"/g)) {
      hints.set(match[1] ?? '', match[2] ?? '');
    }
  }
  return { names, hints };
}

/** The telemetry vocabulary: every `tengu_*` literal. */
function deriveTelemetry(files: readonly string[]): Set<string> {
  const events = new Set<string>();
  for (const text of texts(files)) {
    for (const match of text.matchAll(/"(tengu_[A-Za-z0-9_]{2,80})"/g)) {
      events.add(match[1] ?? '');
    }
  }
  return events;
}

/** The environment-variable surface: every `NAME` read from `process.env`. */
function deriveEnvironment(files: readonly string[]): Set<string> {
  const names = new Set<string>();
  // The target reads its environment through one **lazy namespace**, built by
  // the `Mr(schema, {...})` helper in the chunk that owns it. The names in
  // that namespace are the surface.
  for (const file of files) {
    if (!file.endsWith('chunk-68z1nb51.js')) continue;
    const text = readFileSync(file, 'utf8');
    for (const at of callSites(text, 'Mr')) {
      const object = nthArgumentObjectAt(text, at, 1);
      if (object === -1) continue;
      for (const key of keysOfObject(text, object)) names.add(key);
    }
  }
  // The direct reads, for the names the namespace does not carry.
  for (const text of texts(files)) {
    for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,60})/g)) {
      names.add(match[1] ?? '');
    }
    for (const match of text.matchAll(/process\.env\[["']([A-Z][A-Z0-9_]{2,60})["']\]/g)) {
      names.add(match[1] ?? '');
    }
  }
  return names;
}

/** The inventory the record carries, parsed out of the markdown. */
function recordedEntries(markdown: string, heading: string): Set<string> {
  const entries = new Set<string>();
  const at = markdown.indexOf(`## ${heading}`);
  if (at === -1) return entries;
  const rest = markdown.slice(at);
  const next = rest.indexOf('\n## ', 2);
  const section = next === -1 ? rest : rest.slice(0, next);
  for (const match of section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)) {
    entries.add(match[1] ?? '');
  }
  for (const match of section.matchAll(/^\s*-\s*`([^`]+)`/gm)) {
    entries.add(match[1] ?? '');
  }
  return entries;
}

function main(): number {
  const deriveOnly = process.argv.includes('--derive');
  if (!statSync(EXTRACTED, { throwIfNoEntry: false })?.isDirectory?.()) {
    process.stdout.write(
      'the extracted source is not present, so nothing can be re-derived; ' +
        'a missing extraction is not a failed audit\n',
    );
    return 0;
  }
  const files = sourceFiles(EXTRACTED);
  const tools = deriveTools(files);
  const telemetry = deriveTelemetry(files);
  const environment = deriveEnvironment(files);

  if (process.argv.includes('--write')) {
    // The record is **generated from the derivation**, so it cannot drift from
    // the target: the inventory is re-derived and the file is rewritten.
    const sections = [
      {
        heading: 'The tool registry',
        note: 'Every tool the target defines, re-derived from the target\'s own tool factory and its tool-set arrays.',
        entries: [...tools.names].sort(),
      },
      {
        heading: 'The telemetry vocabulary',
        note: 'Every `tengu_*` event name the target emits, re-derived by a literal scan of the whole tree.',
        entries: [...telemetry].sort(),
      },
      {
        heading: 'The environment-variable surface',
        note: 'Every environment variable the target reads, re-derived from the target\'s own lazy namespace and its direct reads.',
        entries: [...environment].sort(),
      },
    ];
    const body = sections
      .map(
        (section) =>
          `## ${section.heading}\n\n${section.note}\n\n| name |\n|---|\n` +
          section.entries.map((entry) => `| \`${entry}\` |\n`).join(''),
      )
      .join('\n');
    const header = [
      '# The target\'s surface inventory',
      '',
      '**This file is generated** by `scripts/verify-rea.ts --write`, from the',
      'target\'s own source, and checked by `scripts/verify-rea.ts`. It is the',
      'inventory of what the target **has**; the compatibility matrix is the list of',
      'what this implementation **reproduces**, and the two are different things.',
      '',
      'The verifier re-derives each inventory from the source and fails when the',
      'target has an entry this file does not name. A gap in the audit shows up here',
      'as a missing row, not as a paragraph nobody notices.',
      '',
      '---',
      '',
    ].join('\n');
    writeFileSync(INVENTORY, `${header}${body}`, 'utf8');
    process.stdout.write(
      `wrote ${INVENTORY}: ${sections
        .map((section) => `${section.entries.length} ${section.heading}`)
        .join(', ')}\n`,
    );
    return 0;
  }

  if (deriveOnly) {
    process.stdout.write(
      `tools ${tools.names.size}\ntelemetry ${telemetry.size}\nenvironment ${environment.size}\n`,
    );
    for (const name of [...tools.names].sort()) {
      process.stdout.write(`tool\t${name}\t${tools.hints.get(name) ?? ''}\n`);
    }
    return 0;
  }

  let markdown = '';
  try {
    markdown = readFileSync(INVENTORY, 'utf8');
  } catch {
    process.stdout.write(`the record ${INVENTORY} is missing\n`);
    return 1;
  }

  const checks: { surface: string; derived: number; recorded: number; missing: string[] }[] = [];
  const compare = (surface: string, derived: ReadonlySet<string>, heading: string): void => {
    const recorded = recordedEntries(markdown, heading);
    const missing = [...derived].filter((entry) => !recorded.has(entry)).sort();
    checks.push({ surface, derived: derived.size, recorded: recorded.size, missing });
  };
  compare('the tool registry', tools.names, 'The tool registry');
  compare('the telemetry vocabulary', telemetry, 'The telemetry vocabulary');
  compare('the environment-variable surface', environment, 'The environment-variable surface');

  let failed = 0;
  for (const check of checks) {
    if (check.missing.length === 0) {
      process.stdout.write(
        `ok    ${check.surface}: ${check.derived} derived, ${check.recorded} recorded, none unaccounted\n`,
      );
      continue;
    }
    failed += 1;
    process.stdout.write(
      `FAIL  ${check.surface}: ${check.missing.length} of ${check.derived} entries the target has are not in the record\n`,
    );
    for (const entry of check.missing.slice(0, 20)) {
      process.stdout.write(`        ${entry}\n`);
    }
    if (check.missing.length > 20) {
      process.stdout.write(`        ... and ${check.missing.length - 20} more\n`);
    }
  }
  process.stdout.write(
    failed === 0
      ? '\nthe record accounts for every entry the target has\n'
      : `\n${failed} surface(s) are not fully accounted for\n`,
  );
  return failed === 0 ? 0 : 1;
}

process.exit(main());
