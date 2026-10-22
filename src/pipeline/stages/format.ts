/**
 * The format the model answers in.
 *
 * **One responsibility:** reading the three stages that ask the model back
 * into documents.
 *
 * ## Why a format at all
 *
 * Three of the eight stages — `specify`, `plan` and `build` — ask the model
 * for a **document**, not for prose. A document has a shape, and the shape is
 * this one:
 *
 * ```
 * requirement <the requirement>
 * accept <the criterion that shows the requirement is met>
 * ```
 *
 * ```
 * step <what the step does>
 * satisfies <the number of the acceptance criterion the step delivers>
 * ```
 *
 * ```
 * artefact <the path of the file>
 * content <the text of the file>
 * satisfies <the number of the acceptance criterion the artefact delivers>
 * ```
 *
 * A line is a **name** and a **value**, separated by the first space. The
 * value is the rest of the line, so it may hold spaces of its own.
 *
 * The format is **not** a fence, and a model that ignores it produces a
 * document the stage cannot use — and the stage then **refuses with a reason**
 * rather than inventing the missing parts. A stage that filled in what the
 * model did not say would be faking the model's work.
 */

/** One line of a model's answer. */
export interface ModelLine {
  /** The name — the word before the first space. */
  readonly name: string;
  /** The value — the rest of the line. */
  readonly value: string;
}

/**
 * Read an answer into its lines.
 *
 * A blank line carries nothing and is skipped. A line with no space carries no
 * value, and is skipped as well: there is nothing to read out of it.
 */
export function parseModelLines(text: string): ModelLine[] {
  const lines: ModelLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    const value = line.slice(space + 1).trim();
    if (value.length === 0) continue;
    lines.push({ name: line.slice(0, space), value });
  }
  return lines;
}

/** The lines of a name, in order. */
export function linesNamed(lines: readonly ModelLine[], name: string): string[] {
  return lines.filter((line) => line.name === name).map((line) => line.value);
}

/**
 * The number a `satisfies` line names.
 *
 * It is a **one-based** index into the specification's criteria, and a line
 * that does not name a number names nothing.
 */
export function criterionNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : null;
}
