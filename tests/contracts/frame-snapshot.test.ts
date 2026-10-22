/**
 * The **frame snapshot** test — the golden frames, compared.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What is measured, and how
 *
 * - **The golden frames are compared.** A golden is a **picture** — the
 *   rendered terminal frame, exactly as the user would see it — and it is
 *   compared byte for byte with the picture that is drawn now. A change to
 *   what the user sees is therefore **a failing test** and not a surprise.
 * - **The goldens are current.** Each golden records a **fingerprint** of the
 *   code that draws it, and the fingerprint is compared on every run. A
 *   golden that was not regenerated deliberately is **stale**, and a stale
 *   golden **fails**.
 * - **The degraded form has its own golden.** A terminal that cannot draw a
 *   frame gets the resting picture and the reason, and that picture is
 *   recorded and compared like any other.
 * - **The goldens are reproducible.** The motion's frame is a value and the
 *   time is quantised, so the same golden is the same picture every time.
 *
 * ## The staleness check, and the test that proves it
 *
 * The check is `isCurrent(record, fingerprint)`: the record's fingerprint
 * against the fingerprint of the sources that draw it. The test proves the
 * check works in **two** ways — a golden whose drawing changed is reported
 * as stale, and a golden in a directory whose record was tampered with fails
 * the real check rather than passing quietly.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GOLDENS,
  REPOSITORY,
  checkGolden,
  checkGoldens,
  fingerprintOf,
  fingerprintOfFiles,
  hashOf,
  isCurrent,
  pictureOf,
  picturePath,
  recordOf,
  recordPath,
  writeGolden,
} from '../visual/goldens.js';
import { frameText } from '../../src/ui/surface/frame.js';
import { REASON_NOT_INTERACTIVE } from '../../src/ui/motion/capability.js';

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** A golden, by name. */
function goldenNamed(name: string) {
  const definition = GOLDENS.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new Error(`there is no golden named "${name}"`);
  return definition;
}

/** A directory of its own, so a test can write into it. */
function scratchDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), 'prricode-goldens-'));
}

/* -------------------------------------------------------------------------- */
/* The goldens                                                                 */
/* -------------------------------------------------------------------------- */

describe('the golden frames', () => {
  it('records a golden for every surface, and for the degraded form', () => {
    expect(GOLDENS.map((definition) => definition.name)).toEqual([
      'prompt-shimmer',
      'state-transition',
      'stage-advance',
      'overlay-in',
      'overlay-out',
      'degraded',
    ]);
  });

  it('compares every golden with the picture that is drawn now', () => {
    const failures = checkGoldens();
    expect(failures).toEqual([]);
  });

  it('keeps every golden current against the code that draws it', () => {
    for (const definition of GOLDENS) {
      const record = recordOf(definition);
      expect(isCurrent(record, fingerprintOfFiles(definition.sources))).toBe(true);
      expect(record.pictureHash).toBe(hashOf(pictureOf(definition)));
    }
  });

  it('is reproducible — the same golden is the same picture every time', () => {
    for (const definition of GOLDENS) {
      expect(pictureOf(definition)).toBe(pictureOf(definition));
    }
  });

  it('records a picture, and not a description of one', () => {
    for (const definition of GOLDENS) {
      const picture = readFileSync(picturePath(definition.name), 'utf8');
      // The picture carries the theme's own colours: the escape sequences that
      // put them on the screen.
      expect(picture).toContain('38;2;');
      expect(picture).toContain('\u001b[');
      // And it carries the frame's own characters.
      expect(picture.length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The degraded form                                                            */
/* -------------------------------------------------------------------------- */

describe('the golden frames — the degraded form', () => {
  it('records the resting picture and the reason beside it', () => {
    const definition = goldenNamed('degraded');
    const picture = pictureOf(definition);

    expect(picture).toContain(REASON_NOT_INTERACTIVE);
    // The resting picture: the rule is there, in its own role, with no
    // travelling light on it.
    expect(picture).not.toContain('promptBorderShimmer');
  });

  it('shows the reason, and not an animation that was not drawn', () => {
    const definition = goldenNamed('degraded');
    const text = frameText(definition.frame());

    expect(text).toContain(REASON_NOT_INTERACTIVE);
    expect(text).toContain('Running a tool');
  });

  it('is a golden of its own, and not the capable one', () => {
    const degraded = goldenNamed('degraded');
    const capable = goldenNamed('prompt-shimmer');

    expect(pictureOf(degraded)).not.toBe(pictureOf(capable));
    expect(recordOf(degraded).capability.enabled).toBe(false);
    expect(recordOf(degraded).capability.unsupported).toBe(REASON_NOT_INTERACTIVE);
  });
});

/* -------------------------------------------------------------------------- */
/* The staleness check                                                          */
/* -------------------------------------------------------------------------- */

describe('the golden frames — the staleness check', () => {
  it('fails a golden whose drawing has changed', () => {
    const definition = goldenNamed('prompt-shimmer');
    const record = recordOf(definition);

    // The drawing as it is now.
    const current = fingerprintOfFiles(definition.sources);
    expect(isCurrent(record, current)).toBe(true);

    // The drawing as it would be after a change that was not regenerated.
    const sources = new Map<string, string>();
    for (const source of definition.sources) {
      sources.set(source, readFileSync(path.join(REPOSITORY, source), 'utf8'));
    }
    const first = definition.sources[0];
    expect(first).toBeDefined();
    const changed = new Map(sources);
    changed.set(first ?? '', `${sources.get(first ?? '') ?? ''}\n// a change that was never regenerated\n`);

    expect(isCurrent(record, fingerprintOf(changed))).toBe(false);
  });

  it('fails a stale golden rather than passing it quietly', () => {
    const definition = goldenNamed('prompt-shimmer');
    const directory = scratchDirectory();

    // The golden is recorded, and it is current.
    writeGolden(definition, directory);
    expect(checkGolden(definition, directory)).toEqual([]);

    // The drawing moves on, and the golden is not regenerated.
    const record = recordOf(definition);
    writeFileSync(
      recordPath(definition.name, directory),
      `${JSON.stringify({ ...record, fingerprint: 'a fingerprint of a drawing that is not there' }, null, 2)}\n`,
      'utf8',
    );

    const failures = checkGolden(definition, directory);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe('stale');
  });

  it('fails a golden whose picture is not the one that is drawn now', () => {
    const definition = goldenNamed('prompt-shimmer');
    const directory = scratchDirectory();

    writeGolden(definition, directory);
    writeFileSync(picturePath(definition.name, directory), 'something else entirely\n', 'utf8');

    const failures = checkGolden(definition, directory);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe('picture');
  });

  it('fails a golden that was never recorded', () => {
    const definition = goldenNamed('prompt-shimmer');
    const directory = scratchDirectory();

    const failures = checkGolden(definition, directory);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe('missing');
  });

  it('names the golden that failed, and says what to do about it', () => {
    const definition = goldenNamed('prompt-shimmer');
    const directory = scratchDirectory();

    const failures = checkGolden(definition, directory);
    expect(failures[0]?.name).toBe('prompt-shimmer');
    expect(failures[0]?.message).toContain('regeneration');
  });
});

/* -------------------------------------------------------------------------- */
/* The record                                                                  */
/* -------------------------------------------------------------------------- */

describe('the golden frames — the record', () => {
  it('says how the picture was drawn', () => {
    const definition = goldenNamed('prompt-shimmer');
    const record = recordOf(definition);

    expect(record.name).toBe('prompt-shimmer');
    expect(record.motion).toBe('prompt-shimmer');
    expect(record.elapsedMs).toBe(60);
    expect(record.capability.enabled).toBe(true);
  });

  it('names the sources the fingerprint covers', () => {
    for (const definition of GOLDENS) {
      const record = recordOf(definition);
      expect(record.sources.length).toBeGreaterThan(0);
      expect(record.sources).toContain('src/ui/surface/frame.ts');
      expect(record.sources).toContain('src/ui/theme.ts');
    }
  });
});
