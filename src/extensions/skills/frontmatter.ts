/**
 * The skill frontmatter: how it is parsed, what a malformed one looks like,
 * and the exact text the target throws when the `skill.prompt` extension point
 * is handed a frontmatter that is not text.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("The skill
 * frontmatter rule") and `docs/compatibility/extension-surface.md` ("The skill
 * frontmatter rule").
 *
 * ## The rule the target observes
 *
 * "A skill's frontmatter must carry a **text** description. The `skill.prompt`
 * extension point validates it: it finds the first of `source`, `pluginName`,
 * `path`, or `frontmatterProblem` whose value is not a string, and throws
 * `$.skill.prompt: called with a frontmatter that <that> is no text`; when the
 * frontmatter is itself a plain string it throws `$.skill.prompt: called with a
 * frontmatter that is no text`."
 *
 * The four fields are checked **in that order**, and the first one that is
 * present and is not text names itself in the message.
 *
 * ## Implementation choices (the audit does not pin them)
 *
 *   - **Key normalization** is: trim, lower-case, and fold runs of spaces and
 *     underscores into a single dash. The audit says the frontmatter is "parsed
 *     with **key normalization**" without pinning the rule, so the rule above is
 *     this implementation's.
 *   - A frontmatter that is **not an object at all** — `undefined`, `null`, a
 *     number, an array — is refused with the same message the target uses for
 *     a plain string. The target names only the string case; the rest are the
 *     same class of failure (there is no text to read), and this implementation does not
 *     invent a second wording.
 *   - A field that is **present but `undefined`** is treated as absent. A JSON
 *     document cannot carry `undefined`, so the distinction cannot be observed
 *     from a settings file. This **diverges** from the audit's literal reading
 *     — "the first of `source`, `pluginName`, `path`, or `frontmatterProblem`
 *     whose value is not a string" — under which an `undefined` value is not a
 *     string and would name itself in the message. This implementation skips it, and the
 *     divergence is pinned by a test in
 *     `tests/contracts/extensions.test.ts`.
 *   - The **problem strings** the parser reports are this implementation's. The audit says
 *     only that the parse "reports the frontmatter **as written** alongside a
 *     **problem** describing what was wrong with it".
 */

/** The frontmatter fields the target checks for text-ness, in the target's order. */
export const SKILL_FRONTMATTER_TEXT_FIELDS = [
  'source',
  'pluginName',
  'path',
  'frontmatterProblem',
] as const;

/** One of the fields the target checks. */
export type SkillFrontmatterTextField = (typeof SKILL_FRONTMATTER_TEXT_FIELDS)[number];

/** The message the target throws when the whole frontmatter is not text. */
export const SKILL_FRONTMATTER_NOT_TEXT_MESSAGE =
  '$.skill.prompt: called with a frontmatter that is no text';

/**
 * The message the target throws when one of the four fields is not text.
 */
export function skillFrontmatterFieldMessage(field: SkillFrontmatterTextField): string {
  return `$.skill.prompt: called with a frontmatter that ${field} is no text`;
}

/**
 * The error the `skill.prompt` extension point throws.
 *
 * The message is the target's, verbatim; the class is this implementation's so that a
 * caller can tell a frontmatter refusal from any other failure.
 */
export class SkillFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillFrontmatterError';
  }
}

/** Whether a value is a plain object (not an array, not `null`). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a frontmatter key.
 *
 * The rule is this implementation's: trim, lower-case, and fold runs of spaces and
 * underscores into a single dash. `Argument Hint` and `argument_hint` both
 * become `argument-hint`.
 */
export function normalizeFrontmatterKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** A parsed frontmatter. */
export interface ParsedFrontmatter {
  /**
   * The frontmatter **as written**, with its keys normalized.
   *
   * The values are the raw text of the file — the parse never invents a value
   * the file did not carry.
   */
  frontmatter: Record<string, unknown>;
  /** The body, the text after the frontmatter block. */
  body: string;
  /**
   * The problem, when the frontmatter is malformed.
   *
   * A malformed frontmatter is **surfaced**, not dropped: the caller gets the
   * frontmatter it wrote *and* the reason it is not usable.
   */
  problem?: string;
}

/**
 * Parse a `SKILL.md`-style document.
 *
 * The block is delimited by `---` lines. A document that does not open with one
 * has no frontmatter at all: the whole document is the body, and the parse
 * reports the problem.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const normalized = text.replace(/^﻿/, '');
  const lines = normalized.split(/\r?\n/);

  if (lines[0]?.trim() !== '---') {
    return {
      frontmatter: {},
      body: normalized,
      problem: 'the document has no frontmatter',
    };
  }

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      end = index;
      break;
    }
  }

  if (end === -1) {
    return {
      frontmatter: {},
      body: normalized,
      problem: 'the frontmatter is not closed',
    };
  }

  const frontmatter: Record<string, unknown> = {};
  let problem: string | undefined;

  for (const line of lines.slice(1, end)) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(':');
    if (separator === -1) {
      problem ??= 'the frontmatter has a line that is not a `key: value` pair';
      continue;
    }
    const key = normalizeFrontmatterKey(line.slice(0, separator));
    if (key.length === 0) {
      problem ??= 'the frontmatter has a line with no key';
      continue;
    }
    const value = stripQuotes(line.slice(separator + 1).trim());
    // A repeated key keeps the **last** value, as a YAML mapping would.
    Object.defineProperty(frontmatter, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');

  return { frontmatter, body, ...(problem ? { problem } : {}) };
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Read a value out of a frontmatter.
 *
 * The lookup is an **own-property** check: a frontmatter is caller-supplied
 * data, so a key that names an inherited member of `Object.prototype` yields
 * `undefined` rather than the inherited member.
 */
export function frontmatterValue(frontmatter: unknown, key: string): unknown {
  if (!isPlainObject(frontmatter)) return undefined;
  if (!Object.hasOwn(frontmatter, key)) return undefined;
  return frontmatter[key];
}

/**
 * Whether a frontmatter value is **text**.
 *
 * The audit says a skill's frontmatter "must carry a **text** description", so
 * a value that a YAML frontmatter would read as a number, a boolean or null is
 * not text. This implementation's parser keeps every value as the raw text the file
 * carried, so this is where the distinction is made.
 *
 * Implementation choice: the set of scalars treated as non-text is this implementation's.
 */
export function isTextScalar(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return false;
  if (/^(true|false|null|~)$/i.test(trimmed)) return false;
  return true;
}

/**
 * The problem with a skill's frontmatter, when it has one.
 *
 * A skill's frontmatter must carry a **text** description; the problem names
 * the ways that can fail.
 */
export function skillFrontmatterProblem(frontmatter: unknown): string | undefined {
  if (!isPlainObject(frontmatter)) return 'the frontmatter is not text';
  if (!isTextScalar(frontmatterValue(frontmatter, 'description'))) {
    return 'the description is not text';
  }
  return undefined;
}

/**
 * Validate a frontmatter at the `skill.prompt` extension point.
 *
 * Throws the target's exact message:
 *
 *   - `$.skill.prompt: called with a frontmatter that is no text` when the
 *     frontmatter is itself a plain string (or is not text at all);
 *   - `$.skill.prompt: called with a frontmatter that <field> is no text` for
 *     the **first** of `source`, `pluginName`, `path`, `frontmatterProblem`
 *     that is present and is not a string.
 */
export function assertSkillFrontmatter(frontmatter: unknown): void {
  if (!isPlainObject(frontmatter)) {
    throw new SkillFrontmatterError(SKILL_FRONTMATTER_NOT_TEXT_MESSAGE);
  }

  for (const field of SKILL_FRONTMATTER_TEXT_FIELDS) {
    if (!Object.hasOwn(frontmatter, field)) continue;
    const value = frontmatter[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new SkillFrontmatterError(skillFrontmatterFieldMessage(field));
    }
  }
}
