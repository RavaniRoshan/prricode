/**
 * **Output styles**: the customisation surface that replaces the assistant's system
 * prompt with a style of the user's own.
 *
 * Evidence: `chunk-4jsg44k7.js:2255227` (the directory name), `:737660` (the
 * directories the target scans), `:2255368` (the loader and the shape),
 * `:730783` (the frontmatter schema), `:737733` (the sort), and the record at
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §4.
 *
 * ## What an output style is
 *
 * A **markdown file** under an `output-styles` directory. Its **frontmatter** names
 * it and describes it; its **body** is the prompt that replaces the assistant's own.
 *
 * The frontmatter is the target's own schema, and it is **strict** — an unknown key is
 * an error the target reports and moves past:
 *
 * | Key | Meaning |
 * |---|---|
 * | `name` | the style's name; it defaults to the file's name |
 * | `description` | what the picker shows |
 * | `keep-coding-instructions` | whether the default coding instructions stay in the system prompt alongside the style |
 * | `force-for-plugin` | plugin-bundled styles only; ignored for a user's own styles |
 *
 * ## Where the styles come from
 *
 * The target scans the `output-styles` directory of the **configuration root** and the
 * `output-styles` directory of every **project** directory from the working directory
 * up to the home directory. The styles are sorted by the depth of their directory, so
 * the shallower ones come first.
 *
 * ## What this implementation does not have
 *
 * The target also loads a plugin's `output-styles` directory. This implementation has
 * no plugin surface yet — that is `CC-040` — so the styles it loads are the **file**
 * styles only. The difference is recorded in `docs/compatibility/remaining-surfaces.md`.
 *
 * ## The remote session
 *
 * Over **Remote Control**, or from a **relayed message**, the target lets the
 * session pick **only the built-in styles**: a custom style may not be selected
 * there, and the command says so. The predicate and the note are the target's
 * own — `chunk-720ca63b.js:1447` and `chunk-4jsg44k7.js:2269007`.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  BUILTIN_OUTPUT_STYLES,
  DEFAULT_OUTPUT_STYLE_NAME,
  type BuiltinOutputStyle,
} from './outputStyleBuiltins.js';

export {
  BUILTIN_OUTPUT_STYLES,
  DEFAULT_OUTPUT_STYLE_NAME,
  builtinOutputStyleOf,
  type BuiltinOutputStyle,
} from './outputStyleBuiltins.js';

/* -------------------------------------------------------------------------- */
/* The shape                                                                    */
/* -------------------------------------------------------------------------- */

/** Where a style came from. */
export type OutputStyleSource = 'user' | 'project' | 'built-in';

/** One output style. */
export interface OutputStyle {
  /** The style's name — the frontmatter's `name`, or the file's name. */
  readonly name: string;
  /** What the picker shows — the frontmatter's `description`, or the first heading. */
  readonly description: string;
  /** The prompt — the file's body, trimmed. */
  readonly prompt: string;
  /** Where the style came from. */
  readonly source: OutputStyleSource;
  /** The directory the style's file is in. */
  readonly baseDir: string;
  /** Whether the default coding instructions stay in the system prompt. */
  readonly keepCodingInstructions: boolean;
}

/** The frontmatter of an output style. */
export interface OutputStyleFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly 'keep-coding-instructions'?: boolean;
  readonly 'force-for-plugin'?: boolean;
}

/**
 * The directory the styles live in, under a configuration root.
 *
 * The target's own name for it (`_on`).
 */
export const OUTPUT_STYLES_DIRECTORY = 'output-styles';

/**
 * The default configuration root.
 *
 * The target's storage root is `~/.claude` (audit §2.6), and the styles live in a
 * directory of the same name inside it.
 */
export function defaultConfigRoot(): string {
  return path.join(homedir(), '.claude');
}

/* -------------------------------------------------------------------------- */
/* The frontmatter                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Parse the frontmatter of a markdown file.
 *
 * The frontmatter is a YAML block between two `---` lines. The target parses it with a
 * schema; this implementation reads the four keys the schema names and **ignores** the
 * rest, so a file with an unknown key still loads — which is what the target does
 * after it reports the unknown key.
 */
export function parseOutputStyleFrontmatter(source: string): {
  frontmatter: OutputStyleFrontmatter;
  content: string;
} {
  const normalised = source.replaceAll('\r\n', '\n');
  if (!normalised.startsWith('---')) return { frontmatter: {}, content: normalised.trim() };

  const end = normalised.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, content: normalised.trim() };

  const block = normalised.slice(normalised.indexOf('\n') + 1, end);
  const content = normalised.slice(end + 4).trim();

  const frontmatter: {
    name?: string;
    description?: string;
    'keep-coding-instructions'?: boolean;
    'force-for-plugin'?: boolean;
  } = {};
  for (const line of block.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === 'name') frontmatter.name = unquote(value);
    else if (key === 'description') frontmatter.description = unquote(value);
    else if (key === 'keep-coding-instructions') {
      frontmatter['keep-coding-instructions'] = value === 'true';
    } else if (key === 'force-for-plugin') {
      frontmatter['force-for-plugin'] = value === 'true';
    }
  }

  return { frontmatter, content };
}

/** Strip the quotes a YAML scalar may carry. */
function unquote(value: string): string {
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
 * The description a style gets when its frontmatter carries none.
 *
 * The target reads the frontmatter's description first — trimmed, and only when it is
 * a non-empty string. Then it reads the **first non-empty line** of the body: the
 * text of a heading when the line is one, and the whole line otherwise. A line
 * longer than a hundred characters is cut to ninety-seven and given an ellipsis.
 *
 * A body with no line at all falls back to `Custom <name> output style`.
 */
export function outputStyleDescription(
  frontmatter: OutputStyleFrontmatter,
  fallbackName: string,
  content: string,
): string {
  const declared = frontmatter.description;
  if (typeof declared === 'string' && declared.trim() !== '') return declared.trim();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const heading = /^#+\s+(\S.*)$/.exec(trimmed)?.[1] ?? trimmed;
    return heading.length > 100 ? `${heading.substring(0, 97)}...` : heading;
  }
  return `Custom ${fallbackName} output style`;
}

/* -------------------------------------------------------------------------- */
/* The loader                                                                   */
/* -------------------------------------------------------------------------- */

/** The options the loader takes. */
export interface OutputStyleOptions {
  /** The working directory the project styles are found from. */
  readonly cwd: string;
  /** The configuration root the user styles are found in. */
  readonly configRoot?: string;
  /** The home directory the project walk stops at. */
  readonly homeDir?: string;
}

/**
 * The **project directories** the target walks, from the working directory up to the
 * home directory.
 *
 * The target collects every `.claude/<surface>` directory on the way up, and stops at
 * the home directory.
 */
export function projectStyleDirectories(cwd: string, homeDir: string = homedir()): string[] {
  const found: string[] = [];
  const stop = path.resolve(homeDir);
  let current = path.resolve(cwd);
  for (;;) {
    if (path.resolve(current) === stop) break;
    found.push(path.join(current, '.claude', OUTPUT_STYLES_DIRECTORY));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

/**
 * Read the styles of one directory.
 *
 * A directory that does not exist, or that cannot be read, contributes nothing.
 */
async function stylesOfDirectory(
  directory: string,
  source: OutputStyleSource,
): Promise<OutputStyle[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const styles: OutputStyle[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const file = path.join(directory, entry);
    let source_text: string;
    try {
      source_text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, content } = parseOutputStyleFrontmatter(source_text);
    const fallbackName = entry.replace(/\.md$/, '');
    const name = frontmatter.name !== undefined && frontmatter.name !== '' ? frontmatter.name : fallbackName;
    styles.push({
      name,
      description: outputStyleDescription(frontmatter, fallbackName, content),
      prompt: content.trim(),
      source,
      baseDir: directory,
      keepCodingInstructions: frontmatter['keep-coding-instructions'] === true,
    });
  }
  return styles;
}

/**
 * The sort the target's styles are in.
 *
 * The target sorts by the **depth** of the style's directory — the number of path
 * separators in it — so the shallower directories come first.
 */
export function compareOutputStyles(a: OutputStyle, b: OutputStyle): number {
  const depth = (style: OutputStyle): number => style.baseDir.split(/[/\\]/).length;
  return depth(a) - depth(b);
}

/**
 * Load the output styles.
 *
 * The user styles come from the configuration root, the project styles from the
 * working directory up to the home directory, and the whole list is sorted by the
 * depth of the directory each style came from.
 */
export async function loadOutputStyles(options: OutputStyleOptions): Promise<OutputStyle[]> {
  const configRoot = options.configRoot ?? defaultConfigRoot();
  const homeDir = options.homeDir ?? homedir();

  const user = await stylesOfDirectory(
    path.join(configRoot, OUTPUT_STYLES_DIRECTORY),
    'user',
  );
  const project: OutputStyle[] = [];
  for (const directory of projectStyleDirectories(options.cwd, homeDir)) {
    project.push(...(await stylesOfDirectory(directory, 'project')));
  }

  return [...user, ...project].sort(compareOutputStyles);
}

/**
 * The style with a given name.
 *
 * The **first** style with the name wins, and the list is already sorted, so the
 * shallowest one wins.
 */
export function outputStyleOf(styles: readonly OutputStyle[], name: string): OutputStyle | undefined {
  return styles.find((style) => style.name === name);
}

/* -------------------------------------------------------------------------- */
/* The whole registry                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The **built-in** styles, in the target's own shape.
 *
 * The target's `default` entry is `null` — it means *no style* — so it is carried
 * here as an entry with no description and no prompt, and the four real styles
 * follow it.
 */
export function builtinOutputStyles(): OutputStyle[] {
  const none: OutputStyle = {
    name: DEFAULT_OUTPUT_STYLE_NAME,
    description: '',
    prompt: '',
    source: 'built-in',
    baseDir: '',
    keepCodingInstructions: false,
  };
  const styles: OutputStyle[] = BUILTIN_OUTPUT_STYLES.map((style) => ({
    name: style.name,
    description: style.description,
    prompt: style.prompt,
    source: 'built-in' as const,
    baseDir: '',
    keepCodingInstructions: style.keepCodingInstructions,
  }));
  return [none, ...styles];
}

/**
 * Every style the session can choose: the **built-in** ones, then the file ones.
 *
 * The target's order is the built-ins first, then the file styles — the user's own
 * first, then the project's, then the managed ones — and a later style **replaces**
 * an earlier one with the same name.
 */
export async function allOutputStyles(options: OutputStyleOptions): Promise<OutputStyle[]> {
  const styles = new Map<string, OutputStyle>();
  for (const style of builtinOutputStyles()) styles.set(style.name, style);
  for (const style of await loadOutputStyles(options)) styles.set(style.name, style);
  return [...styles.values()];
}

/* -------------------------------------------------------------------------- */
/* The remote session                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The flags the target's remote predicate reads.
 *
 * The target's predicate is `dispatchedOverBridge === true ||
 * submissionVerifiedSlackHumanTurn === true` — the message was dispatched over
 * a bridge (Remote Control), or it was submitted by a verified Slack human
 * turn.
 */
export interface OutputStyleSession {
  /** Whether the message was dispatched over a bridge. */
  readonly dispatchedOverBridge?: boolean;
  /** Whether the message was submitted by a verified Slack human turn. */
  readonly submissionVerifiedSlackHumanTurn?: boolean;
}

/**
 * Whether the session is **remote or relayed**.
 *
 * Evidence: `chunk-720ca63b.js:1447`.
 */
export function isRemoteOrRelayedSession(session: OutputStyleSession): boolean {
  return session.dispatchedOverBridge === true || session.submissionVerifiedSlackHumanTurn === true;
}

/**
 * Whether a style may be picked over a remote or relayed session.
 *
 * The target's own rule: a style may be picked only when it is the built-in
 * "no style" entry — which the target holds as `null` — or when its source is
 * `built-in`. A custom style may not.
 *
 * Evidence: `chunk-4jsg44k7.js:2269007` — `n6e(e) { return e === null || e?.source === "built-in" }`.
 */
export function isRemotelySelectableOutputStyle(style: OutputStyle | null): boolean {
  return style === null || style?.source === 'built-in';
}

/**
 * The note the command appends over a remote or relayed session.
 *
 * The target's own text.
 *
 * Evidence: `chunk-4jsg44k7.js:2269063`.
 */
export const REMOTE_OUTPUT_STYLE_NOTE =
  "Custom output styles can't be selected over Remote Control or from a relayed message. " +
  'Select one in the session itself, or pick a built-in style here.';

/**
 * The label the current style carries over a remote or relayed session, when
 * the current style is a custom one.
 *
 * The target's own text.
 */
export const REMOTE_CURRENT_OUTPUT_STYLE_LABEL = 'a custom style';

/**
 * The words that ask the command for the **list** rather than for a style.
 *
 * The target's own list.
 */
export const OUTPUT_STYLE_QUERY_WORDS = [
  'list',
  'show',
  'display',
  'current',
  'view',
  'get',
  'check',
  'describe',
  'print',
  'version',
  'about',
  'status',
  '?',
] as const;

/**
 * The words that ask the command for its **help**.
 *
 * The target's own list.
 */
export const OUTPUT_STYLE_HELP_WORDS = ['help', '-h', '--help'] as const;

/**
 * Whether a word asks the command for the list rather than for a style.
 */
export function isOutputStyleQueryWord(word: string): boolean {
  const lowered = word.trim().toLowerCase();
  return (
    (OUTPUT_STYLE_QUERY_WORDS as readonly string[]).includes(lowered) ||
    (OUTPUT_STYLE_HELP_WORDS as readonly string[]).includes(lowered)
  );
}

/**
 * What the command reports: the styles the session may pick from, the label of
 * the current one, and the note it appends.
 */
export interface OutputStyleSelection {
  /** The styles the session may pick from. */
  readonly styles: readonly OutputStyle[];
  /** The label of the current style. */
  readonly currentLabel: string;
  /** The note the command appends, when the session is remote or relayed. */
  readonly note?: string;
}

/**
 * The styles a session may pick from, and the labels the command reports.
 *
 * Over a remote or relayed session the list is **only the built-in styles**,
 * and the current style is reported as *"a custom style"* when it is not one of
 * them.
 */
export function outputStyleSelection(
  styles: readonly OutputStyle[],
  current: string,
  remote: boolean,
): OutputStyleSelection {
  if (!remote) {
    return { styles, currentLabel: current };
  }

  const selectable = styles.filter((style) => isRemotelySelectableOutputStyle(style));
  // The target reads the **registry's** entry for the current style, and a
  // style the registry does not hold is not remotely selectable — so the
  // current style is reported as a custom one.
  const currentStyle = styles.find((style) => style.name === current);
  const currentLabel =
    currentStyle !== undefined && isRemotelySelectableOutputStyle(currentStyle)
      ? current
      : REMOTE_CURRENT_OUTPUT_STYLE_LABEL;

  return { styles: selectable, currentLabel, note: REMOTE_OUTPUT_STYLE_NOTE };
}

/* -------------------------------------------------------------------------- */
/* The setting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The **local settings file** of a project.
 *
 * The target saves the output style to the **local** tier — `.claude/settings.local.json`
 * in the project — and refuses when the session does not load that tier.
 */
export function localSettingsPath(cwd: string): string {
  return path.join(cwd, '.claude', 'settings.local.json');
}

/**
 * Save the active output style to the project's local settings file.
 *
 * The file is **read first** and only the `outputStyle` member is replaced, so
 * nothing else in it is lost. A file that is not a settings document is **left
 * alone**: writing over it would throw the user's settings away.
 */
export async function writeOutputStyleSetting(cwd: string, name: string): Promise<void> {
  const file = localSettingsPath(cwd);
  let document: Record<string, unknown> = {};
  try {
    const raw = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`the settings file ${file} is not a settings document`);
    }
    document = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  document['outputStyle'] = name;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/**
 * The active output style's name.
 *
 * The setting is a **string** — the name of the style — and the default is
 * `default`, which means *no style*.
 */
export function currentOutputStyle(settings: Record<string, unknown> | undefined): string {
  const value = settings?.['outputStyle'];
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_OUTPUT_STYLE_NAME;
  return value;
}
