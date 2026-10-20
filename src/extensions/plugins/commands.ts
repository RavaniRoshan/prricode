/**
 * The plugin command discovery rules.
 *
 * Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.8 ("The command and
 * skill discovery rules are observed") and
 * `docs/compatibility/extension-surface.md` ("The command discovery rules").
 *
 * ## The two shapes
 *
 * - a **directory** — its `.md` files are the commands, and a directory with
 *   neither `.md` files nor `SKILL.md` in subdirectories is a **warning**, not
 *   an error: *"Warning: No commands found in plugin `<name>` custom directory:
 *   `<path>`. Expected .md files or SKILL.md in subdirectories."*;
 * - a **file** — it must end in `.md`; a file that exceeds the command **byte
 *   limit** is skipped with *"Skipping plugin command `<path>`: exceeds `<N>`
 *   byte limit"*.
 *
 * ## The three naming shapes
 *
 * - a command file is named `<plugin>:<basename without the .md>`;
 * - a `commandsMetadata` entry whose `source` resolves to the same path is
 *   named `<plugin>:<metadata key>`;
 * - a `commandsMetadata` entry with `content` but **no** `source` is an
 *   **inline** command: it is named `<plugin>:<key>` and its path is the
 *   pseudo-path `<inline:<plugin>:<key>>`.
 *
 * ## The interning
 *
 * "The skill body is **interned**, so identical skill contents are stored
 * once." The interner hands out an id per distinct body.
 *
 * ## Implementation choices (the audit does not pin them)
 *
 *   - The **byte limit** is `10000` bytes. The audit says a command file that
 *     "exceeds the command **byte limit**" is skipped and names the limit in
 *     the message, but does not give the number; this implementation's number is its own.
 *   - A commands path that is a file **without** the `.md` suffix is skipped
 *     with a warning of this implementation's wording.
 *   - A directory that holds a `SKILL.md` in a **subdirectory** contributes no
 *     command — the subdirectory is a skill, not a command — but it does
 *     silence the "no commands found" warning.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { parseFrontmatter } from '../skills/frontmatter.js';
import { isSafeLookupName } from '../skills/source.js';

/**
 * The byte limit a plugin command file may not exceed.
 *
 * Implementation choice — see the file header.
 */
export const PLUGIN_COMMAND_BYTE_LIMIT = 10_000;

/**
 * The interner that stores each distinct skill body once.
 */
export class SkillBodyInterner {
  private readonly ids = new Map<string, string>();
  private readonly bodies = new Map<string, string>();
  private counter = 0;

  /** The id of a body, interning it when it is new. */
  intern(content: string): string {
    const existing = this.ids.get(content);
    if (existing !== undefined) return existing;
    this.counter += 1;
    const id = `body-${this.counter}`;
    this.ids.set(content, id);
    this.bodies.set(id, content);
    return id;
  }

  /** The body an id stands for. */
  resolve(id: string): string | undefined {
    return this.bodies.get(id);
  }

  /** How many distinct bodies are stored. */
  get size(): number {
    return this.bodies.size;
  }
}

/** The metadata a plugin declares for a command. */
export interface PluginCommandMetadata {
  /** The path of the command file, relative to the plugin root. */
  source?: string;
  /** The inline content of the command. */
  content?: string;
}

/** A discovered plugin command. */
export interface PluginCommand {
  /** The command's name — `<plugin>:<name>`. */
  name: string;
  /** The path of the command, or `<inline:<plugin>:<key>>` for an inline one. */
  path: string;
  /** The id of the interned body. */
  bodyId: string;
  /** The body of the command. */
  body: string;
  /** The frontmatter **as written**, with its keys normalized. */
  frontmatter: Record<string, unknown>;
  /** The problem with the frontmatter, when there is one. */
  frontmatterProblem?: string;
  /** Whether the command is inline. */
  inline: boolean;
}

/** What a command discovery found. */
export interface PluginCommandDiscovery {
  /** The commands that were found. */
  commands: PluginCommand[];
  /** The warnings the discovery raised. */
  warnings: string[];
  /** The interner the bodies were stored in. */
  interner: SkillBodyInterner;
}

/** The options a command discovery runs with. */
export interface PluginCommandDiscoveryOptions {
  /** The plugin's name — the prefix of every command's name. */
  plugin: string;
  /** The plugin's root; every path is resolved against it. */
  root: string;
  /** The command paths the manifest declares. */
  commandsPaths: readonly string[];
  /** The command metadata the manifest declares. */
  commandsMetadata?: Readonly<Record<string, PluginCommandMetadata>>;
  /** The byte limit a command file may not exceed. */
  byteLimit?: number;
  /** The interner the bodies go into. */
  interner?: SkillBodyInterner;
}

function isDirectory(candidatePath: string): boolean {
  try {
    return statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function fileSize(candidatePath: string): number | undefined {
  try {
    return statSync(candidatePath).size;
  } catch {
    return undefined;
  }
}

/** Whether a directory holds a `SKILL.md` in one of its subdirectories. */
function holdsSkillInSubdirectory(directory: string): boolean {
  let entries: string[] = [];
  try {
    entries = readdirSync(directory);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    const subdirectory = path.join(directory, entry);
    return isDirectory(subdirectory) && existsSync(path.join(subdirectory, 'SKILL.md'));
  });
}

/**
 * The metadata key whose `source` resolves to a path.
 *
 * The lookup is an **own-property** check, so a metadata key that names an
 * inherited member of `Object.prototype` never matches.
 */
function metadataKeyForPath(
  metadata: Readonly<Record<string, PluginCommandMetadata>>,
  root: string,
  commandPath: string,
): string | undefined {
  const target = path.resolve(commandPath);
  for (const [key, entry] of Object.entries(metadata)) {
    if (!isSafeLookupName(key)) continue;
    if (typeof entry?.source !== 'string') continue;
    if (path.resolve(root, entry.source) !== target) continue;
    return key;
  }
  return undefined;
}

/**
 * Discover a plugin's commands.
 *
 * The rules are the target's; see the file header.
 */
export function discoverPluginCommands(
  options: PluginCommandDiscoveryOptions,
): PluginCommandDiscovery {
  const {
    plugin,
    root,
    commandsPaths,
    commandsMetadata = {},
    byteLimit = PLUGIN_COMMAND_BYTE_LIMIT,
  } = options;
  const interner = options.interner ?? new SkillBodyInterner();

  const commands: PluginCommand[] = [];
  const warnings: string[] = [];

  const addFileCommand = (filePath: string): void => {
    const size = fileSize(filePath);
    if (size !== undefined && size > byteLimit) {
      warnings.push(
        `Skipping plugin command \`${filePath}\`: exceeds ${byteLimit} byte limit`,
      );
      return;
    }

    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      warnings.push(`Skipping plugin command \`${filePath}\`: it could not be read`);
      return;
    }

    const parsed = parseFrontmatter(text);
    const metadataKey = metadataKeyForPath(commandsMetadata, root, filePath);
    const baseName = path.basename(filePath, '.md');
    const name = metadataKey === undefined ? `${plugin}:${baseName}` : `${plugin}:${metadataKey}`;

    commands.push({
      name,
      path: filePath,
      bodyId: interner.intern(parsed.body),
      body: parsed.body,
      frontmatter: parsed.frontmatter,
      ...(parsed.problem === undefined ? {} : { frontmatterProblem: parsed.problem }),
      inline: false,
    });
  };

  for (const declared of commandsPaths) {
    const commandsPath = path.resolve(root, declared);

    if (isDirectory(commandsPath)) {
      let entries: string[] = [];
      try {
        entries = readdirSync(commandsPath);
      } catch {
        entries = [];
      }
      const markdownFiles = entries
        .filter((entry) => entry.endsWith('.md'))
        .filter((entry) => isDirectory(path.join(commandsPath, entry)) === false)
        .sort();

      if (markdownFiles.length === 0 && !holdsSkillInSubdirectory(commandsPath)) {
        warnings.push(
          `Warning: No commands found in plugin \`${plugin}\` custom directory: \`${commandsPath}\`. Expected .md files or SKILL.md in subdirectories.`,
        );
        continue;
      }

      for (const entry of markdownFiles) {
        addFileCommand(path.join(commandsPath, entry));
      }
      continue;
    }

    if (!existsSync(commandsPath)) {
      warnings.push(`Skipping plugin command \`${commandsPath}\`: it does not exist`);
      continue;
    }

    if (!commandsPath.endsWith('.md')) {
      warnings.push(`Skipping plugin command \`${commandsPath}\`: not a .md file`);
      continue;
    }

    addFileCommand(commandsPath);
  }

  // The inline commands: an entry with content and no source.
  for (const [key, entry] of Object.entries(commandsMetadata)) {
    if (!isSafeLookupName(key)) continue;
    if (typeof entry?.content !== 'string') continue;
    if (typeof entry?.source === 'string') continue;

    const body = entry.content;
    commands.push({
      name: `${plugin}:${key}`,
      path: `<inline:${plugin}:${key}>`,
      bodyId: interner.intern(body),
      body,
      frontmatter: {},
      inline: true,
    });
  }

  return { commands, warnings, interner };
}
