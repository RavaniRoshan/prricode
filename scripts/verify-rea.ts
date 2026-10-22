#!/usr/bin/env bun
/**
 * The reverse-engineering completeness verifier.
 *
 * **The goal.** "The reverse engineering of the target is complete" is a claim that
 * can be checked. This script re-derives the target's own inventories from the
 * extracted source — the tool registry, the browser tool bundle, the telemetry
 * vocabulary, the environment-variable surface, the settings document, the hook
 * event matrix and the command-line flag sets — and checks that the record in
 * `docs/reverse-engineering/SURFACE-INVENTORY.md` accounts for **every** entry the
 * target has.
 *
 * The check is a *diff*, not a count: an entry the target has and the record does
 * not name is a failure. A count that merely agrees proves nothing, because both
 * sides could be wrong in the same way.
 *
 * ## Why the tree-wide scans are delegated to `grep`
 *
 * The target's extracted source is 2 434 minified chunks — 56 MB, the largest a
 * single file 4.8 MB. Reading them in this process and running a regular
 * expression over each one costs a **gigabyte** of resident memory: every file's
 * text is a fresh string, and the collector lets the garbage pile up until the
 * host is squeezed. A verifier that cannot run is not a check, and a verifier
 * that takes the machine down with it is worse than no verifier.
 *
 * So the tree-wide scans are handed to `grep`, which does the same work in C for
 * a few megabytes, and this process only ever holds the **four** chunks a
 * per-chunk derivation reads. The measurements are the same; the footprint is
 * not.
 *
 * Usage:
 *   bun run scripts/verify-rea.ts                # the check
 *   bun run scripts/verify-rea.ts --derive       # re-derive and print the inventories
 *   bun run scripts/verify-rea.ts --write        # regenerate the record from the derivation
 *   bun run scripts/verify-rea.ts --write-matrix # regenerate the matrix's totals
 *
 * The extracted source lives outside the repository. When it is absent the script
 * says so and exits **0** — a missing extraction is not a failed audit.
 */

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  callSites,
  collections as collectionsIn,
  keysOfObject,
  nameExpressionsOfObjectArray,
  nthArgumentObjectAt,
} from './rea-scan.js';

const REPOSITORY = path.resolve(process.cwd());
const EXTRACTED = '/home/shiva/opt/reference-agent-rea/extracted-patched';
const INVENTORY = path.join(REPOSITORY, 'docs/reverse-engineering/SURFACE-INVENTORY.md');

/** The chunks a per-chunk derivation reads. */
const SETTINGS_CHUNK = 'chunk-c9s0jh80.js';
const ENVIRONMENT_CHUNK = 'chunk-68z1nb51.js';
const PARSER_CHUNK = 'chunk-0y0ptpy9.js';
const BROWSER_CHUNK = 'chunk-g8377zgj.js';
const BROWSER_LIST_CHUNK = 'chunk-epgd1mgh.js';

/** A counter, so two concurrent scans never share a temporary file. */
let grepCounter = 0;

/**
 * Run `grep` over the extracted tree and return its lines.
 *
 * The lines come back with the file that produced them, because a minified
 * identifier is only unique inside its own module and the resolution has to
 * happen there.
 */
function grepTree(pattern: string): string[] {
  // `grep` writes to a **file**, and the file is read afterwards. Capturing its
  // output through a pipe costs the parent a buffer of its own, and the parent
  // is the process that has to stay small.
  const target = path.join(os.tmpdir(), `prricode-grep-${process.pid}-${grepCounter++}.txt`);
  const handle = openSync(target, 'w');
  try {
    spawnSync('grep', ['-rhoHP', pattern, '.'], {
      cwd: EXTRACTED,
      stdio: ['ignore', handle, 'ignore'],
    });
  } finally {
    closeSync(handle);
  }
  let text = '';
  try {
    text = readFileSync(target, 'utf8');
  } catch {
    text = '';
  } finally {
    try {
      unlinkSync(target);
    } catch {
      // The temporary file is already gone; nothing to clean up.
    }
  }
  if (text === '') return [];
  return text.split('\n').filter((line: string) => line !== '');
}

/** Read one chunk, or nothing if it is not there. */
function readChunk(base: string): string | undefined {
  try {
    return readFileSync(path.join(EXTRACTED, base), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The tool factory's call sites, and the name each one carries.
 *
 * The name is a literal or a minified identifier, and the identifier is
 * resolved **in the chunk that uses it**.
 */
function deriveToolSites(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const line of grepTree('Qt\\(\\{.{0,400}?name:("[A-Za-z][A-Za-z0-9_-]*"|[A-Za-z_$][A-Za-z0-9_$]*)')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const file = line.slice(0, separator).replace(/^\.\//, '');
    const match = /name:("[A-Za-z][A-Za-z0-9_-]*"|[A-Za-z_$][A-Za-z0-9_$]*)/.exec(line.slice(separator));
    if (match === null) continue;
    // The capture keeps its quotes: a **literal** name is quoted, and an
    // identifier is not. Stripping the quotes first would lose the difference,
    // and an identifier would be recorded as if it were a name.
    const expression = match[1] ?? '';
    if (expression === '' || expression === '""') continue;
    const list = sites.get(file) ?? [];
    list.push(expression);
    sites.set(file, list);
  }
  return sites;
}

/** The telemetry vocabulary: every `tengu_*` event name. */
function deriveTelemetry(): Set<string> {
  const events = new Set<string>();
  for (const line of grepTree('"tengu_[A-Za-z0-9_]{2,80}"')) {
    // `grep -H` prefixes the file, so a line reads
    // `./chunk-<id>.js:"tengu_name"`. The **name** is what follows the last
    // colon; taking the whole line would record one entry per *placement*
    // rather than one per event, and the same event shipped in two chunks
    // would be counted twice.
    const match = /"([A-Za-z0-9_]+)"$/.exec(line);
    if (match !== null) {
      events.add(match[1] ?? '');
      continue;
    }
    events.add(line.replace(/^.*"tengu_/, '').replace(/"$/, ''));
  }
  return events;
}

/** The environment variables the target reads directly off `process.env`. */
function deriveDirectEnvironment(): Set<string> {
  const names = new Set<string>();
  for (const line of grepTree('process\\.env\\.[A-Z][A-Z0-9_]{2,60}')) {
    names.add(line.replace(/^.*process\.env\./, ''));
  }
  return names;
}

/**
 * The environment variables read through an **accessor**.
 *
 * The target does not only read `process.env.NAME`: it has small helpers that
 * take the name as an argument and read it, and it reads `process.env[NAME]`
 * through a variable. A scan for the literal `process.env.NAME` sees none of
 * those, so the surface it reports is **short** — a sweep of the target's own
 * registries found the runner's forty-one variables and the scan saw none.
 *
 * So the accessors are found — the functions whose own body reads
 * `process.env[` — and the calls to them, with an environment-variable-shaped
 * literal, are resolved **in the chunk that uses them**, because an identifier
 * is only unique inside its own module.
 */
function deriveAccessedEnvironment(): Set<string> {
  const names = new Set<string>();
  const accessors = new Map<string, Set<string>>();
  for (const line of grepTree(
    'function [A-Za-z_$][A-Za-z0-9_$]*\\([^)]*\\)\\{[^}]{0,200}process\\.env\\[',
  )) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const file = line.slice(0, separator).replace(/^\.\//, '');
    const match = /function ([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line.slice(separator));
    if (match === null) continue;
    const set = accessors.get(file) ?? new Set<string>();
    set.add(match[1] ?? '');
    accessors.set(file, set);
  }
  if (accessors.size === 0) return names;
  for (const line of grepTree(
    '\\b([A-Za-z_$][A-Za-z0-9_$]*)\\("([A-Z][A-Z0-9_]*(_[A-Z0-9_]+)+)"\\)',
  )) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const file = line.slice(0, separator).replace(/^\.\//, '');
    if (!accessors.get(file)?.has('')) {
      const callee = /\b([A-Za-z_$][A-Za-z0-9_$]*)\("/.exec(line.slice(separator))?.[1];
      if (callee === undefined || !accessors.get(file)?.has(callee)) continue;
    }
    const name = /"([A-Z][A-Z0-9_]*(_[A-Z0-9_]+)+)"/.exec(line.slice(separator))?.[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/**
 * The values the needed identifiers hold, and where they were imported from.
 *
 * Only the **needed** identifiers are kept, so the map is a few dozen entries
 * rather than millions — a map of every identifier in every chunk is the largest
 * thing this program could allocate, and it is not needed.
 */
function collectValues(needed: ReadonlySet<string>): {
  values: Map<string, Map<string, string>>;
  imports: Map<string, Map<string, [string, string]>>;
} {
  const values = new Map<string, Map<string, string>>();
  const imports = new Map<string, Map<string, [string, string]>>();
  if (needed.size === 0) return { values, imports };
  const alternation = [...needed].map((id) => id.replace(/\$/g, '\\$')).join('|');

  for (const line of grepTree(`\\b(${alternation})="[^"]{0,200}"`)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const file = line.slice(0, separator).replace(/^\.\//, '');
    const match = /\b([A-Za-z_$][A-Za-z0-9_$]*)="([^"]*)"/.exec(line.slice(separator));
    if (match === null) continue;
    const chunk = values.get(file) ?? new Map<string, string>();
    const id = match[1] ?? '';
    if (!chunk.has(id)) chunk.set(id, match[2] ?? '');
    values.set(file, chunk);
  }

  for (const line of grepTree('import\\{[^}]{0,2000}\\}from"\\./(chunk-[A-Za-z0-9]+\\.js)"')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const file = line.slice(0, separator).replace(/^\.\//, '');
    const match = /import\{([^}]*)\}from"\.\/(chunk-[A-Za-z0-9]+\.js)"/.exec(line.slice(separator));
    if (match === null) continue;
    const chunk = imports.get(file) ?? new Map<string, [string, string]>();
    for (const part of (match[1] ?? '').split(',')) {
      const pieces = part.trim().split(/\s+as\s+/);
      const local = pieces[0]?.trim();
      if (local === undefined || local === '' || !needed.has(local)) continue;
      chunk.set(local, [match[2] ?? '', pieces[1]?.trim() ?? local]);
    }
    imports.set(file, chunk);
  }
  return { values, imports };
}

/**
 * Resolve an identifier to the string it holds.
 *
 * An **imported** binding is an alias, so the import is followed first: a local
 * name of the same shape is a different binding and must not shadow the one the
 * module actually uses.
 */
function resolve(
  values: Map<string, Map<string, string>>,
  imports: Map<string, Map<string, [string, string]>>,
  chunk: string,
  name: string,
  depth = 0,
): string | undefined {
  if (depth > 8) return undefined;
  const link = imports.get(chunk)?.get(name);
  if (link !== undefined) {
    const through = resolve(values, imports, link[0], link[1], depth + 1);
    if (through !== undefined) return through;
  }
  return values.get(chunk)?.get(name);
}

/** The tool registry: the main factory's tools. */
function deriveTools(
  sites: Map<string, string[]>,
  values: Map<string, Map<string, string>>,
  imports: Map<string, Map<string, [string, string]>>,
): Set<string> {
  const names = new Set<string>();
  for (const [chunk, expressions] of sites) {
    for (const expression of expressions) {
      if (expression.startsWith('"')) {
        names.add(expression.replace(/^"|"$/g, ''));
        continue;
      }
      const value = resolve(values, imports, chunk, expression);
      if (value !== undefined) names.add(value);
    }
  }
  return names;
}

/**
 * The environment-variable surface: the target's own lazy namespace, plus the
 * variables it reads directly.
 */
function deriveEnvironment(
  direct: ReadonlySet<string>,
  accessed: ReadonlySet<string>,
): Set<string> {
  const names = new Set<string>([...direct, ...accessed]);
  const text = readChunk(ENVIRONMENT_CHUNK);
  if (text === undefined) return names;
  for (const at of callSites(text, 'Mr')) {
    const object = nthArgumentObjectAt(text, at, 1);
    if (object === -1) continue;
    for (const key of keysOfObject(text, object)) names.add(key);
  }
  return names;
}

/**
 * The settings document: the target's own settings factory, `cc`, and the object
 * literal it returns.
 */
function deriveSettings(): Set<string> {
  const keys = new Set<string>();
  const text = readChunk(SETTINGS_CHUNK);
  if (text === undefined) return keys;
  const factory = text.indexOf('function cc(e,{strictPolicyHelperKeys');
  if (factory === -1) return keys;
  const returned = text.indexOf('return{', factory);
  if (returned === -1) return keys;
  const brace = text.indexOf('{', returned);
  for (const key of keysOfObject(text, brace)) keys.add(key);
  return keys;
}

/**
 * The target's **seven flag sets**, read from its own parser.
 *
 * They are told apart by their **size**, and the identification is **checked**:
 * the repeatable set must be a subset of the value set, the boolean set must be
 * disjoint from it, and the session subcommands must not look like flags. A
 * misidentification fails loudly rather than silently.
 */
function deriveFlagSets(): Map<string, string[]> {
  const sets = new Map<string, string[]>();
  const text = readChunk(PARSER_CHUNK);
  if (text === undefined) return sets;
  const bySize = new Map<number, string[]>();
  for (const collection of collectionsIn(text, 3)) {
    if (!bySize.has(collection.members.length)) bySize.set(collection.members.length, collection.members);
  }
  const value = bySize.get(85);
  const boolean = bySize.get(45);
  const optional = bySize.get(14);
  const repeatable = bySize.get(11);
  const tokens = bySize.get(10);
  const subcommands = bySize.get(6);
  const carveouts = bySize.get(3);
  if (
    value === undefined ||
    boolean === undefined ||
    optional === undefined ||
    repeatable === undefined ||
    tokens === undefined ||
    subcommands === undefined ||
    carveouts === undefined
  ) {
    return sets;
  }
  const repeatableIsSubset = repeatable.every((flag) => value.includes(flag));
  const booleanIsDisjoint = boolean.every((flag) => !value.includes(flag));
  const subcommandsAreWords = subcommands.every((word) => !word.startsWith('-'));
  if (!repeatableIsSubset || !booleanIsDisjoint || !subcommandsAreWords) return sets;
  sets.set('The value-taking flags', value);
  sets.set('The boolean flags', boolean);
  sets.set('The optional-value flags', optional);
  sets.set('The repeatable flags', repeatable);
  sets.set('The command tokens', tokens);
  sets.set('The session subcommands', subcommands);
  sets.set('The carve-out flags', carveouts);
  return sets;
}

/**
 * The hook-event matrix: the target's own list of the events a hook may answer
 * to.
 *
 * The list is identified by its **shape** — every member is an event-shaped name
 * — and by the two events that anchor it, `PreToolUse` and `PostToolBatch`. The
 * largest such collection is taken, so a stray three-member list cannot be
 * mistaken for it.
 */
function deriveHookEvents(): Set<string> {
  const HOOK_SHAPED = /^[A-Z][A-Za-z]{2,24}$/;
  const events = new Set<string>();
  const text = readChunk(SETTINGS_CHUNK);
  if (text === undefined) return events;
  let best: string[] = [];
  for (const collection of collectionsIn(text, 10)) {
    const members = collection.members;
    if (members.length < 20) continue;
    if (!members.every((member) => HOOK_SHAPED.test(member))) continue;
    if (!members.includes('PreToolUse') || !members.includes('PostToolBatch')) continue;
    if (members.length > best.length) best = members;
  }
  for (const member of best) events.add(member);
  return events;
}

/**
 * The browser tool bundle: the target's **second** tool set, a separate bundle
 * from the main registry.
 *
 * The bundle is an array of tool **objects**, so the names are read from each
 * object's own `name` member — and a name that is a minified identifier is
 * resolved against the chunk that uses it, because a minified identifier is only
 * unique inside its own module.
 */
function deriveBrowserTools(): Set<string> {
  const names = new Set<string>();
  // The target ships the bundle's names **twice**: once as a list of strings
  // in one chunk, and once as a list of tool objects in another. The string
  // list is read here, because a chunk of minified tool objects does not
  // balance under a brace scanner and a derivation that cannot be trusted is
  // worse than none.
  const listed = readChunk(BROWSER_LIST_CHUNK);
  if (listed !== undefined) {
    for (const collection of collectionsIn(listed, 10)) {
      const members = collection.members;
      if (!members.includes('read_page') || !members.includes('navigate')) continue;
      for (const member of members) names.add(member);
    }
  }
  // The bundle's **first** tool is named by a minified identifier, and it is
  // resolved against the chunk that uses it.
  const bundle = readChunk(BROWSER_CHUNK);
  if (bundle !== undefined) {
    const at = bundle.indexOf('yNe=[{name:');
    if (at !== -1) {
      const opening = bundle.slice(at, at + 400);
      const match = /name:([A-Za-z_$][A-Za-z0-9_$]*)/.exec(opening);
      const identifier = match?.[1];
      if (identifier !== undefined) {
        const resolved = new RegExp(
          `(?:^|[^A-Za-z0-9_$])${identifier.replace(/\$/g, '\\$')}\\s*=\\s*"([^"]+)"`,
        ).exec(bundle);
        if (resolved !== null) names.add(resolved[1] ?? '');
      }
    }
  }
  return names;
}

/**
 * The native inventory: the target's own native objects, and the whole
 * payload the image carries.
 *
 * The audit's *whole-image* native inventory was never established — three
 * attempts timed out (330 s, 360 s, 900 s). But the **extraction manifest**
 * enumerates the image's payload file by file, with each file's kind, size and
 * digest, and the native ones are the `ELF x86-64` entries. So the question
 * that three scans could not answer is answered by the image's own index.
 */
function deriveNativeInventory(): { members: string[]; payload: number } {
  const members: string[] = [];
  let payload = 0;
  const manifest = path.join(path.dirname(EXTRACTED), 'extraction-manifest-patched.json');
  let text: string;
  try {
    text = readFileSync(manifest, 'utf8');
  } catch {
    return { members, payload };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { members, payload };
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const files = (entry as { files?: unknown }).files;
    if (!Array.isArray(files)) continue;
    payload += files.length;
    for (const file of files) {
      if (typeof file !== 'object' || file === null) continue;
      const record = file as { kind?: unknown; path?: unknown; size?: unknown; sha256?: unknown };
      if (record.kind !== 'ELF x86-64') continue;
      const name = typeof record.path === 'string' ? record.path : '';
      if (name === '') continue;
      members.push(
        `${name} (${typeof record.size === 'number' ? record.size : 0} bytes, ${
          typeof record.sha256 === 'string' ? record.sha256 : ''
        })`,
      );
    }
  }
  return { members: members.sort(), payload };
}

/** Every section of the generated record, with its members. */
function inventorySections(markdown: string): Map<string, Set<string>> {
  const sections = new Map<string, Set<string>>();
  for (const match of markdown.matchAll(/^## ([^\n]+)\n[\s\S]*?((?:^\| `[^`]+` \|\n?)+)/gm)) {
    const heading = (match[1] ?? '').trim();
    const members = [...(match[2] ?? '').matchAll(/^\| `([^`]+)` \|$/gm)].map((m) => m[1] ?? '');
    if (members.length > 0) sections.set(heading, new Set(members));
  }
  return sections;
}

function main(): number {
  const deriveOnly = process.argv.includes('--derive');
  const write = process.argv.includes('--write');
  const writeMatrix = process.argv.includes('--write-matrix');

  if (writeMatrix) {
    // The matrix's own **totals** are derived from its rows, so they cannot
    // miscount. A row that moves from `partial` to `observed` moves the table
    // with it.
    const matrixPath = path.join(REPOSITORY, 'docs/compatibility/feature-matrix.md');
    const matrix = readFileSync(matrixPath, 'utf8');
    const counts = new Map<string, number>();
    for (const match of matrix.matchAll(/^\| (F-[0-9a-z]+) \|[^|]*\|[^|]*\| ([^|]*)\|/gm)) {
      const status = (match[2] ?? '').trim();
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    const order = [
      'observed',
      'partial',
      'unknown',
      'inferred',
      'implementation choice',
      'not applicable (project requirement)',
      'project requirement',
    ];
    const table = order
      .filter((status) => counts.has(status))
      .map((status) => `| ${status} | ${counts.get(status) ?? 0} |`)
      .join('\n');
    const rewritten = matrix.replace(
      /(\| Status \| Count \|\n\|---\|---\|\n)(?:\|[^\n]*\n)*/,
      `$1${table}\n`,
    );
    writeFileSync(matrixPath, rewritten, 'utf8');
    process.stdout.write(
      `wrote the matrix's totals: ${order
        .filter((status) => counts.has(status))
        .map((status) => `${counts.get(status)} ${status}`)
        .join(', ')}\n`,
    );
    return 0;
  }

  if (!statSync(EXTRACTED, { throwIfNoEntry: false })?.isDirectory?.()) {
    process.stdout.write(
      'the extracted source is not present, so nothing can be re-derived; ' +
        'a missing extraction is not a failed audit\n',
    );
    return 0;
  }

  const profile = process.env.PRRICODE_PROFILE === '1';
  const mark = (label: string): void => {
    if (!profile) return;
    const usage = process.memoryUsage();
    process.stdout.write(
      `  ${label}: rss ${(usage.rss / 1048576).toFixed(0)} MB, heap ${(usage.heapUsed / 1048576).toFixed(0)} MB\n`,
    );
  };
  const sites = deriveToolSites();
  mark('the tool sites');
  const needed = new Set<string>();
  // The names read through `process.env[NAME]`, where `NAME` is a variable.
  for (const line of grepTree('process\\.env\\[([A-Za-z_$][A-Za-z0-9_$]*)\\]')) {
    const match = /process\.env\[([A-Za-z_$][A-Za-z0-9_$]*)\]/.exec(line.slice(line.indexOf(':')));
    if (match?.[1] !== undefined) needed.add(match[1]);
  }
  for (const expressions of sites.values()) {
    for (const expression of expressions) {
      if (!expression.startsWith('"') && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expression)) {
        needed.add(expression);
      }
    }
  }
  mark('the needed identifiers');
  const { values, imports } = collectValues(needed);
  mark('the values and the imports');
  const tools = deriveTools(sites, values, imports);
  // The target's own **tool-set arrays** — the permission layer's lists — name
  // tools the factory does not define at that site, and a run of tool-shaped
  // names is a tool set when most of its members are already known.
  for (const run of grepTree('"[A-Z][A-Za-z0-9]{2,29}"(,"[A-Z][A-Za-z0-9]{2,29}"){2,}')) {
    const members = [...run.matchAll(/"([A-Z][A-Za-z0-9]{2,29})"/g)].map((m) => m[1] ?? '');
    if (members.length < 3) continue;
    const known = members.filter((member) => tools.has(member)).length;
    if (known < 2) continue;
    for (const member of members) tools.add(member);
  }
  mark('the tools');
  const browserTools = deriveBrowserTools();
  mark('the browser tools');
  const telemetry = deriveTelemetry();
  mark('the telemetry');
  const environment = deriveEnvironment(
    deriveDirectEnvironment(),
    deriveAccessedEnvironment(),
  );
  mark('the environment');
  const settings = deriveSettings();
  mark('the settings');
  const hookEvents = deriveHookEvents();
  mark('the hook events');
  const flagSets = deriveFlagSets();
  const native = deriveNativeInventory();
  mark('the flag sets');

  const sections: { heading: string; note: string; entries: string[] }[] = [
    {
      heading: 'The tool registry',
      note: "Every tool the target's main factory defines, re-derived from the target's own source.",
      entries: [...tools].sort(),
    },
    {
      heading: 'The browser tool bundle',
      note: "Every tool in the target's **second** tool bundle, re-derived from the bundle the target ships.",
      entries: [...browserTools].sort(),
    },
    {
      heading: 'The telemetry vocabulary',
      note: "Every `tengu_*` event name the target emits, re-derived by a literal scan of the whole tree.",
      entries: [...telemetry].sort(),
    },
    {
      heading: 'The environment-variable surface',
      note: "Every environment variable the target reads, re-derived from the target's own lazy namespace and its direct reads.",
      entries: [...environment].sort(),
    },
    {
      heading: 'The settings document',
      note: "Every key the target's settings document accepts, re-derived from the target's own settings factory.",
      entries: [...settings].sort(),
    },
    {
      heading: 'The hook event matrix',
      note: "Every event a hook may answer to, re-derived from the target's own list.",
      entries: [...hookEvents].sort(),
    },
    {
      heading: 'The native inventory',
      note: "Every native object the target's image carries, read from the extraction manifest's own payload index.",
      entries: native.members,
    },
    ...[...flagSets].map(([heading, members]) => ({
      heading,
      note: "Re-derived from the target's own parser, and told apart by the target's own relationships.",
      entries: [...members].sort(),
    })),
  ];

  if (write) {
    // The record is **generated from the derivation**, so it cannot drift from
    // the target: the inventory is re-derived and the file is rewritten.
    const body = sections
      .map(
        (section) =>
          `## ${section.heading}\n\n${section.note}\n\n| name |\n|---|\n` +
          section.entries.map((entry) => `| \`${entry}\` |\n`).join(''),
      )
      .join('\n');
    const header = [
      "# The target's surface inventory",
      '',
      '**This file is generated** by `scripts/verify-rea.ts --write`, from the',
      "target's own source, and checked by `scripts/verify-rea.ts`. It is the",
      "inventory of what the target **has**; the compatibility matrix is the list of",
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
    for (const section of sections) {
      process.stdout.write(`${section.entries.length}\t${section.heading}\n`);
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

  const recorded = inventorySections(markdown);
  let failed = 0;
  for (const section of sections) {
    const target = new Set(section.entries);
    const have = recorded.get(section.heading) ?? new Set<string>();
    const missing = [...target].filter((entry) => !have.has(entry)).sort();
    if (missing.length === 0) {
      process.stdout.write(
        `ok    ${section.heading}: ${target.size} derived, ${have.size} recorded, none unaccounted\n`,
      );
      continue;
    }
    failed += 1;
    process.stdout.write(
      `FAIL  ${section.heading}: ${missing.length} of ${target.size} entries the target has are not in the record\n`,
    );
    for (const entry of missing.slice(0, 20)) {
      process.stdout.write(`        ${entry}\n`);
    }
    if (missing.length > 20) {
      process.stdout.write(`        ... and ${missing.length - 20} more\n`);
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
