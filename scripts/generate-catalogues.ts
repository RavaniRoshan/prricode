#!/usr/bin/env bun
/**
 * Generate the two reference catalogues from the reverse-engineering record.
 *
 * The record — `docs/reverse-engineering/SURFACE-INVENTORY.md` — is generated
 * from the target's own source by `scripts/verify-rea.ts`, and the verifier
 * fails when the target has an entry the record does not name. The two
 * catalogues this script writes are therefore **the target's data**, read from
 * a file that is itself checked against the target.
 *
 * Two numbers matter, and they are different numbers:
 *
 *   - the **environment** surface is the record's own list — 1 285 names;
 *   - the **telemetry** vocabulary is the record's list with the file prefix
 *     removed — the record lists **(file, event) pairs**, and the vocabulary is
 *     the **distinct names**, 3 084 of them. The verifier's own count, 3 554,
 *     is the pair count.
 *
 * Usage:
 *   bun run scripts/generate-catalogues.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPOSITORY = path.resolve(process.cwd());
const INVENTORY = path.join(REPOSITORY, 'docs/reverse-engineering/SURFACE-INVENTORY.md');

/** The rows of one section of the record: the backticked names. */
function sectionRows(markdown: string, heading: string): string[] {
  const start = markdown.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`the record has no section "${heading}"`);
  const rest = markdown.slice(start + heading.length + 3);
  const end = rest.indexOf('\n## ');
  const body = end === -1 ? rest : rest.slice(0, end);
  const rows: string[] = [];
  for (const match of body.matchAll(/^\| `([^`]*)` \|$/gm)) rows.push(match[1] ?? '');
  return rows;
}

/**
 * The telemetry event name a record row carries.
 *
 * A row is `./chunk-<id>.js:"tengu_<name>"` — the file, then the name. The
 * name is what the vocabulary holds; the file is the placement.
 */
function eventNameOf(row: string): string {
  const quoted = /"(tengu_[A-Za-z0-9_]+)"?$/.exec(row);
  if (quoted !== null) return quoted[1] ?? '';
  // A row whose file is not a chunk — the target's own entry point, `cli` —
  // carries no quote at all.
  const afterColon = /:(tengu_[A-Za-z0-9_]+)$/.exec(row);
  if (afterColon !== null) return afterColon[1] ?? '';
  throw new Error(`a telemetry row is not a placement: ${row}`);
}

const markdown = readFileSync(INVENTORY, 'utf8');

const environment = sectionRows(markdown, 'The environment-variable surface').sort();
const telemetryPlacements = sectionRows(markdown, 'The telemetry vocabulary');
const telemetry = [...new Set(telemetryPlacements.map(eventNameOf))].sort();

/** A TypeScript string-literal array. */
function literalArray(names: readonly string[]): string {
  return names.map((name) => `  '${name}',`).join('\n');
}

const environmentSource = `/**
 * The target's **environment-variable surface**: every environment variable the
 * target reads.
 *
 * **This file is generated** by \`scripts/generate-catalogues.ts\` from the
 * reverse-engineering record, and it is this implementation's copy of the
 * reference surface the target honours.
 *
 * ## Where the names come from
 *
 * The record is generated from the target's own source by
 * \`scripts/verify-rea.ts\`, which fails when the target has an entry the
 * record does not name. The derivation unions three sources:
 *
 *   - a **direct** read, \`process.env.NAME\`;
 *   - an **accessor** — a helper whose own body reads \`process.env[\`, called
 *     with an environment-shaped literal;
 *   - the target's **lazy namespace** — the keys of the \`Mr(target, {…})\`
 *     descriptor objects in \`chunk-68z1nb51.js\`, each of which is a getter
 *     over \`process.env\`.
 *
 * The names are **the target's data**, so they keep the target's spelling: a
 * variable the target honours is honoured here under the same name.
 *
 * ## The surface is a lower bound
 *
 * The derivation has two blind spots, and both are named in
 * \`docs/compatibility/reference-catalogues.md\`:
 *
 *   - a name read through a **parameter** that defaults to \`process.env\` is
 *     not seen, because the literal \`process.env[\` is not in the body;
 *   - a name that appears only in a **literal list** is not seen, because the
 *     derivation reads names where they are *read*.
 *
 * {@link ENVIRONMENT_VARIABLE_NAMES_BEYOND_THE_DERIVATION} carries the names
 * this implementation established by reading the target's source, each with
 * the file and the offset it was read at.
 */

/** Every environment variable the target reads, in sorted order. */
export const ENVIRONMENT_VARIABLE_NAMES = [
${literalArray(environment)}
] as const;

/** One environment variable the target reads. */
export type EnvironmentVariableName = (typeof ENVIRONMENT_VARIABLE_NAMES)[number];

/**
 * The same names, as a set.
 *
 * The lookup is a **set membership** test, so a name that collides with an
 * \`Object.prototype\` member (\`toString\`, \`constructor\`) is never resolved
 * from the prototype chain — it is simply not in the surface.
 */
const ENVIRONMENT_VARIABLE_SET: ReadonlySet<string> = new Set(ENVIRONMENT_VARIABLE_NAMES);

/**
 * Whether the target reads an environment variable under this name.
 *
 * A name outside the surface is **not** an error: the target reads names the
 * derivation cannot see, and a third party may set any name at all. The
 * answer is therefore a fact about the surface, not a gate.
 */
export function isTargetEnvironmentVariable(name: string): boolean {
  return ENVIRONMENT_VARIABLE_SET.has(name);
}

/**
 * The names the target reads that the derivation does **not** see, with the
 * place each was read.
 *
 * Every entry was established by reading the target's source; the offset is a
 * byte offset into the named file.
 */
export interface EnvironmentVariableBeyondDerivation {
  /** The variable's name. */
  readonly name: string;
  /** The file the name was read in. */
  readonly file: string;
  /** The byte offset the read is at. */
  readonly offset: number;
  /** Why the derivation does not see it. */
  readonly reason: string;
}

/**
 * The names established by reading, beyond the derivation's reach.
 *
 * A name read through a **parameter** that defaults to \`process.env\` — the
 * target's \`function Xe(e, r = process.env)\` — is read as \`r[NAME]\`, and the
 * literal \`process.env[\` is nowhere in the body. The accessor form therefore
 * does not fire, and the name is invisible to the derivation.
 */
export const ENVIRONMENT_VARIABLE_NAMES_BEYOND_THE_DERIVATION: readonly EnvironmentVariableBeyondDerivation[] = [
  {
    name: 'SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_COMMAND',
    file: 'chunk-zjm15h4n.js',
    offset: 17211,
    reason: 'read through a parameter that defaults to process.env',
  },
  {
    name: 'SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_FILE',
    file: 'chunk-zjm15h4n.js',
    offset: 17238,
    reason: 'read through a parameter that defaults to process.env',
  },
];

/**
 * Every name the target reads that this implementation carries: the derived
 * surface and the names established by reading.
 */
export const ENVIRONMENT_VARIABLE_SURFACE: readonly string[] = Object.freeze(
  [
    ...new Set([
      ...ENVIRONMENT_VARIABLE_NAMES,
      ...ENVIRONMENT_VARIABLE_NAMES_BEYOND_THE_DERIVATION.map((entry) => entry.name),
    ]),
  ].sort(),
);
`;

const telemetrySource = `/**
 * The target's **telemetry vocabulary**: every \`tengu_*\` event name the target
 * emits.
 *
 * **This file is generated** by \`scripts/generate-catalogues.ts\` from the
 * reverse-engineering record, and it is this implementation's copy of the
 * reference surface the target reports under.
 *
 * ## The event model
 *
 * **Observed** (\`chunk-333wmdtg.js\`, the target's telemetry module):
 *
 * - an event is a **pair** — an **event name** and a **metadata** object;
 * - \`logEvent(eventName, metadata)\` is the synchronous emit and
 *   \`logEventAsync(eventName, metadata)\` the awaited one;
 * - the sink's own interface is \`{logEvent, logEventAsync}\`;
 * - the queue holds **1 000** events and drops its **oldest** when it is full.
 *
 * There is no envelope and no channel: the sink receives the name and the
 * metadata, and nothing else.
 *
 * ## The count
 *
 * The vocabulary is **${telemetry.length} distinct names**. The verifier's own derivation reports
 * **${telemetryPlacements.length}**, because it counts **(file, name) pairs** — an event that appears in
 * two chunks is counted twice. The ${telemetryPlacements.length - telemetry.length} extra placements are the events the target ships in more than one
 * chunk. The conformance document names the arithmetic.
 *
 * ## The names are the target's data
 *
 * An event name is a **datum**, not a name: a clone that renamed an event
 * would not be observable in the same way. The type {@link TelemetryEventName}
 * is therefore derived from this list, so an event name this implementation
 * raises cannot be one the target does not emit — the compiler says so.
 */

/** Every \`tengu_*\` event name the target emits, in sorted order. */
export const TELEMETRY_EVENT_NAMES = [
${literalArray(telemetry)}
] as const;

/** One event name the target emits. */
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

/**
 * The same names, as a set.
 *
 * The lookup is a **set membership** test, so a name that collides with an
 * \`Object.prototype\` member (\`toString\`, \`constructor\`) is never resolved
 * from the prototype chain — it is simply not in the vocabulary.
 */
const TELEMETRY_EVENT_SET: ReadonlySet<string> = new Set(TELEMETRY_EVENT_NAMES);

/**
 * Whether the target emits an event under this name.
 *
 * The answer is a fact about the vocabulary, not a gate: the target also emits
 * **timing** events under names that are not \`tengu_*\` (the target's
 * \`skills_load_ms\` is one), and the derivation's literal scan does not see
 * that namespace.
 */
export function isTargetTelemetryEvent(name: string): boolean {
  return TELEMETRY_EVENT_SET.has(name);
}
`;

writeFileSync(path.join(REPOSITORY, 'src/config/environmentCatalogue.ts'), environmentSource, 'utf8');
writeFileSync(path.join(REPOSITORY, 'src/telemetry/vocabulary.ts'), telemetrySource, 'utf8');

process.stdout.write(
  `wrote the catalogues: ${environment.length} environment names, ${telemetry.length} telemetry events ` +
    `(${telemetryPlacements.length} placements)\n`,
);
