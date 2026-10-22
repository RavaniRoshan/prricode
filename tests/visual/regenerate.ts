/**
 * The **regeneration** — the deliberate act that records the goldens.
 *
 * **The milestone:** `CC-048` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## Why it is a script and not a flag
 *
> A golden that was not regenerated deliberately is a failure, so a stale
> picture cannot pass quietly.
 *
> So the goldens are written by **this** script, and running it is an act
> somebody performs on purpose. The test never writes: it compares, and it
> fails when the picture or the fingerprint has moved.
 *
 * ## How to run it
 *
 * ```
 * bun run tests/visual/regenerate.ts
 * ```
 *
 * The diff it leaves behind is the record of what changed in what the user
 * sees — and the fingerprint in each record says whether the *drawing*
 * changed as well, which the picture alone cannot show.
 */

import { GOLDENS, writeGolden } from './goldens.js';

const written = GOLDENS.map((definition) => {
  const record = writeGolden(definition);
  return `${record.name}  picture ${record.pictureHash.slice(0, 12)}  drawing ${record.fingerprint.slice(0, 12)}`;
});

for (const line of written) process.stdout.write(`${line}\n`);
process.stdout.write(`${written.length} golden frames recorded.\n`);
