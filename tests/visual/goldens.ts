/**
 * The **golden frames** — the machinery that records a picture and checks it.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What a golden is
 *
> A golden frame is a **picture** — the rendered terminal frame, exactly as the
 * user would see it — recorded and compared. **Not a description of the
> picture.**
 *
 * So a golden is the **bytes**: the frame's rows, in the theme's own colours,
 * with the styles the terminal has. `cat` on a golden in a terminal shows the
 * frame as the user saw it. The picture is produced by
 * `src/ui/surface/frame.ts` — the one function that writes a frame — and it is
 * compared byte for byte.
 *
 * ## Why a golden is possible
 *
> The motion's frame is a **value**: it reads no clock and keeps no counter,
 * and the time is quantised to the frame index. So the same frame is the same
 * picture every time, on any machine, and the golden is reproducible.
 *
 * ## The two checks
 *
 * | the check | what it compares | what it catches |
 * |---|---|---|
 * | the **picture** | the recorded bytes with the bytes drawn now | a change to what the user sees |
 * | the **fingerprint** | the recorded hash of the drawing with the hash of the drawing now | a change to the code that draws it, whether or not it changed this particular frame |
 *
 * The **fingerprint** is a SHA-256 over the **sources that draw the golden** —
 * the surface modules, the motion system and the theme. So a golden that was
 * not regenerated deliberately is **stale**, and a stale golden **fails**.
 * That is the whole point: a stale picture cannot pass quietly.
 *
 * ## The files
 *
 * | the file | what it is |
 * |---|---|
 * | `tests/visual/goldens/<name>.frame` | the picture — the bytes |
 * | `tests/visual/goldens/<name>.json` | the record — the parameters, the picture's hash and the drawing's fingerprint |
 *
 * The picture and the record are kept apart on purpose: the picture is a
 * picture, and nothing of the machinery is in it.
 *
 * ## The regeneration is deliberate
 *
 * `tests/visual/regenerate.ts` writes the goldens. It is run by hand, and
 * what it writes is what the test then compares against — so regenerating is
 * an act, and the diff says what changed.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  approvalOverlayRows,
  renderMotionSurface,
  renderOverlayFrame,
  renderPromptFrame,
  renderStageFrame,
  renderStateFrame,
  type TerminalFrame,
} from '../../src/ui/surface/index.js';
import { renderPicture } from '../../src/ui/surface/frame.js';
import type { MotionCapability, MotionName } from '../../src/ui/surface/index.js';
import type { ApprovalPromptParts } from '../../src/ui/render/prompts.js';
import { REASON_NOT_INTERACTIVE } from '../../src/ui/motion/capability.js';

/* -------------------------------------------------------------------------- */
/* The paths                                                                   */
/* -------------------------------------------------------------------------- */

/** The repository's root. */
export const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The directory the goldens live in. */
export const GOLDEN_DIRECTORY = path.join(REPOSITORY, 'tests/visual/goldens');

/* -------------------------------------------------------------------------- */
/* The record                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The record of one golden.
 *
 * It says **how** the picture was drawn, **what** the picture is (its hash),
 * and **what drew it** (the fingerprint and the sources it covers).
 */
export interface GoldenRecord {
  /** The golden's name. */
  readonly name: string;
  /** The motion the golden draws. */
  readonly motion: MotionName;
  /** The time the golden is drawn at, in milliseconds. */
  readonly elapsedMs: number;
  /** The capability the golden is drawn with. */
  readonly capability: MotionCapability;
  /** The SHA-256 of the picture. */
  readonly pictureHash: string;
  /** The SHA-256 of the drawing — the sources that draw it. */
  readonly fingerprint: string;
  /** The sources the fingerprint covers, relative to the repository's root. */
  readonly sources: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* The definitions                                                             */
/* -------------------------------------------------------------------------- */

/** A terminal that can draw. */
const CAPABLE: MotionCapability = {
  enabled: true,
  unsupported: null,
  interactive: true,
  reducedMotion: false,
};

/** A terminal that cannot draw. */
const BLIND: MotionCapability = {
  enabled: false,
  unsupported: REASON_NOT_INTERACTIVE,
  interactive: false,
  reducedMotion: false,
};

/**
 * The sources every golden's drawing depends on.
 *
 * The theme owns the colours, and the motion system owns the frame, the
 * easings, the durations and the drawer. A change in any of them changes
 * every picture, so every golden's fingerprint covers them.
 */
const BASE_SOURCES: readonly string[] = [
  'src/ui/theme.ts',
  'src/ui/motion/vocabulary.ts',
  'src/ui/motion/easing.ts',
  'src/ui/motion/frame.ts',
  'src/ui/motion/render.ts',
  'src/ui/motion/capability.ts',
];

/** The sources the frame itself is drawn by. */
const FRAME_SOURCES: readonly string[] = ['src/ui/surface/frame.ts'];

/** The approval dialog the overlay golden draws. */
const APPROVAL: ApprovalPromptParts = {
  title: 'Bash command',
  question: 'Do you want to proceed?',
  reason: 'No permission rule matched.',
  choices: [
    { value: 'yes', label: 'Yes', focused: true, selected: true },
    {
      value: 'yes-always',
      label: "Yes, and don't ask again for this Bash call",
      focused: false,
      selected: false,
    },
    {
      value: 'no',
      label: 'No, and tell PRRICODE what to do differently',
      suffix: '(esc)',
      focused: false,
      selected: false,
    },
  ],
  guide: 'enter to confirm · esc to cancel',
};

/**
 * One golden: what it is, how it is drawn, and what draws it.
 */
export interface GoldenDefinition {
  /** The golden's name — the file's name, without the extension. */
  readonly name: string;
  /** The motion the golden draws. */
  readonly motion: MotionName;
  /** The time the golden is drawn at, in milliseconds. */
  readonly elapsedMs: number;
  /** The capability the golden is drawn with. */
  readonly capability: MotionCapability;
  /** The sources the fingerprint covers. */
  readonly sources: readonly string[];
  /** The frame the golden is a picture of. */
  readonly frame: () => TerminalFrame;
}

/**
 * The goldens.
 *
 * One for each of the four surfaces, one for the exit, and one for the
 * **degraded** form — the resting picture and the reason, for a terminal that
 * cannot draw a frame.
 */
export const GOLDENS: readonly GoldenDefinition[] = Object.freeze([
  {
    name: 'prompt-shimmer',
    motion: 'prompt-shimmer',
    elapsedMs: 60,
    capability: CAPABLE,
    sources: [...BASE_SOURCES, ...FRAME_SOURCES, 'src/ui/surface/prompt.ts'],
    frame: () =>
      renderPromptFrame({
        columns: 40,
        elapsedMs: 60,
        capability: CAPABLE,
      }),
  },
  {
    name: 'state-transition',
    motion: 'transition-in',
    elapsedMs: 0,
    capability: CAPABLE,
    sources: [...BASE_SOURCES, ...FRAME_SOURCES, 'src/ui/surface/states.ts'],
    frame: () =>
      renderStateFrame({
        change: { from: 'thinking', to: 'tool' },
        elapsedMs: 0,
        capability: CAPABLE,
      }),
  },
  {
    name: 'stage-advance',
    motion: 'stage-advance',
    elapsedMs: 0,
    capability: CAPABLE,
    sources: [...BASE_SOURCES, ...FRAME_SOURCES, 'src/ui/surface/stages.ts'],
    frame: () =>
      renderStageFrame({
        advance: { stageId: 'concept', state: 'running', enabled: true, unsupported: null },
        elapsedMs: 0,
        capability: CAPABLE,
      }),
  },
  {
    name: 'overlay-in',
    motion: 'overlay-in',
    elapsedMs: 0,
    capability: CAPABLE,
    sources: [
      ...BASE_SOURCES,
      ...FRAME_SOURCES,
      'src/ui/surface/overlays.ts',
      'src/ui/render/prompts.ts',
    ],
    frame: () =>
      renderOverlayFrame({
        rows: approvalOverlayRows(APPROVAL),
        elapsedMs: 0,
        capability: CAPABLE,
        motion: 'overlay-in',
      }),
  },
  {
    name: 'overlay-out',
    motion: 'overlay-out',
    elapsedMs: 0,
    capability: CAPABLE,
    sources: [
      ...BASE_SOURCES,
      ...FRAME_SOURCES,
      'src/ui/surface/overlays.ts',
      'src/ui/render/prompts.ts',
    ],
    frame: () =>
      renderOverlayFrame({
        rows: approvalOverlayRows(APPROVAL),
        elapsedMs: 0,
        capability: CAPABLE,
        motion: 'overlay-out',
      }),
  },
  {
    name: 'degraded',
    motion: 'prompt-shimmer',
    elapsedMs: 60,
    capability: BLIND,
    sources: [
      ...BASE_SOURCES,
      ...FRAME_SOURCES,
      'src/ui/surface/prompt.ts',
      'src/ui/surface/states.ts',
      'src/ui/surface/stages.ts',
      'src/ui/surface/overlays.ts',
      'src/ui/surface/motionSurface.ts',
      'src/ui/render/prompts.ts',
    ],
    frame: () =>
      renderMotionSurface({
        capability: BLIND,
        elapsedMs: 60,
        prompt: { columns: 40 },
        state: { from: 'thinking', to: 'tool' },
        stage: { stageId: 'concept', state: 'running', enabled: true, unsupported: null },
        overlay: { rows: approvalOverlayRows(APPROVAL) },
      }),
  },
]);

/* -------------------------------------------------------------------------- */
/* The hashes                                                                  */
/* -------------------------------------------------------------------------- */

/** The SHA-256 of some bytes, in hex. */
export function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The fingerprint of a drawing.
 *
 * The hash is over the **paths and the contents** of the sources, in a fixed
 * order, so a source that is renamed or edited changes the fingerprint and
 * the golden is stale.
 */
export function fingerprintOf(sources: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const source of [...sources.keys()].sort()) {
    hash.update(source, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(sources.get(source) ?? '', 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

/**
 * The fingerprint of the sources on disk.
 *
 * A source that is not there is **not** silently skipped: the reading throws,
 * because a golden whose drawing cannot be read cannot be current either.
 */
export function fingerprintOfFiles(paths: readonly string[]): string {
  const sources = new Map<string, string>();
  for (const source of paths) {
    sources.set(source, readFileSync(path.join(REPOSITORY, source), 'utf8'));
  }
  return fingerprintOf(sources);
}

/* -------------------------------------------------------------------------- */
/* The files                                                                   */
/* -------------------------------------------------------------------------- */

/** The path of a golden's picture. */
export function picturePath(name: string, directory: string = GOLDEN_DIRECTORY): string {
  return path.join(directory, `${name}.frame`);
}

/** The path of a golden's record. */
export function recordPath(name: string, directory: string = GOLDEN_DIRECTORY): string {
  return path.join(directory, `${name}.json`);
}

/** The picture a golden is a picture of. */
export function pictureOf(definition: GoldenDefinition): string {
  return renderPicture(definition.frame());
}

/** The record a golden carries. */
export function recordOf(definition: GoldenDefinition): GoldenRecord {
  return {
    name: definition.name,
    motion: definition.motion,
    elapsedMs: definition.elapsedMs,
    capability: definition.capability,
    pictureHash: hashOf(pictureOf(definition)),
    fingerprint: fingerprintOfFiles(definition.sources),
    sources: [...definition.sources],
  };
}

/** Write a golden: the picture and the record. */
export function writeGolden(
  definition: GoldenDefinition,
  directory: string = GOLDEN_DIRECTORY,
): GoldenRecord {
  const picture = pictureOf(definition);
  const record = recordOf(definition);
  mkdirSync(directory, { recursive: true });
  writeFileSync(picturePath(definition.name, directory), picture, 'utf8');
  writeFileSync(recordPath(definition.name, directory), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

/* -------------------------------------------------------------------------- */
/* The check                                                                   */
/* -------------------------------------------------------------------------- */

/** Why a golden failed. */
export interface GoldenFailure {
  /** The golden's name. */
  readonly name: string;
  /** What went wrong. */
  readonly reason: 'missing' | 'picture' | 'stale';
  /** The sentence that says what went wrong. */
  readonly message: string;
}

/**
 * Whether a record is **current** against a fingerprint.
 *
 * This is the staleness rule, on its own: a record whose fingerprint is not
 * the drawing's is **stale**, and a stale golden fails.
 */
export function isCurrent(record: GoldenRecord, fingerprint: string): boolean {
  return record.fingerprint === fingerprint;
}

/**
 * Check one golden.
 *
 * The failures are the reasons the golden did not pass: it is not there, its
 * picture is not the one that is drawn now, or its drawing has changed and
 * the golden was not regenerated.
 */
export function checkGolden(
  definition: GoldenDefinition,
  directory: string = GOLDEN_DIRECTORY,
): GoldenFailure[] {
  const failures: GoldenFailure[] = [];
  const name = definition.name;

  let record: GoldenRecord;
  let picture: string;
  try {
    record = JSON.parse(readFileSync(recordPath(name, directory), 'utf8')) as GoldenRecord;
    picture = readFileSync(picturePath(name, directory), 'utf8');
  } catch {
    failures.push({
      name,
      reason: 'missing',
      message: `the golden "${name}" is not recorded; run the regeneration deliberately`,
    });
    return failures;
  }

  const drawn = pictureOf(definition);

  if (picture !== drawn) {
    failures.push({
      name,
      reason: 'picture',
      message: `the golden "${name}" is not the picture that is drawn now; the frame the user sees has changed`,
    });
  }

  if (!isCurrent(record, fingerprintOfFiles(definition.sources))) {
    failures.push({
      name,
      reason: 'stale',
      message: `the golden "${name}" is stale: the code that draws it has changed and the golden was not regenerated`,
    });
  }

  return failures;
}

/** Check every golden. */
export function checkGoldens(directory: string = GOLDEN_DIRECTORY): GoldenFailure[] {
  return GOLDENS.flatMap((definition) => checkGolden(definition, directory));
}
