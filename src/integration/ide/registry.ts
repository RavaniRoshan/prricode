/**
 * The **IDE registry**: the target's eighteen IDEs, their kinds, their display
 * names, and their per-OS process keywords.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded
 * in `/home/shiva/opt/reference-agent-rea/analysis/findings-ide-integration.md`
 * — every claim there carries a file and a byte offset. The milestone is
 * `CC-036` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * | what | where in the target |
 * |---|---|
 * | the IDE registry | `chunk-f27ph7ed.js:661418` — the literal `var LMt={…}` |
 * | the editor display-name table | `chunk-f27ph7ed.js:661418`+ — the literal `var Wv={…}` |
 * | the display-name resolver | `chunk-f27ph7ed.js:661418`+ — `Kw(e)` |
 * | the process-detection commands | `chunk-4jsg44k7.js:4017676`+ — `O7r()` |
 * | the JetBrains product directories | `chunk-4jsg44k7.js:4006008` — `var xOn={…}` |
 * | the JetBrains plugin directory | `chunk-4jsg44k7.js:4006008` — `c7r` |
 *
 * ## The counts, verified by a parser and not by a pattern
 *
 * The registry literal was **parsed**, not pattern-matched: the object literal
 * was extracted from the chunk, its bare keys were quoted and the result was
 * read as JSON. The table holds **eighteen** entries, in the target's order,
 * and the record's list of eighteen agrees with it entry for entry.
 *
 *   - `ideKind` takes exactly **two** values: `vscode` (**three** entries —
 *     cursor, windsurf, vscode) and `jetbrains` (**fifteen**).
 *   - **Three** entries — `aqua`, `gateway` and `fleet` — carry an **empty**
 *     macOS keyword list and an **empty** Linux keyword list, and a
 *     Windows keyword.
 *   - The **editor** table is a **different** table, with **twelve** entries,
 *     and it names editors as well as IDEs (`vi`, `nano`, `notepad`, `emacs`,
 *     `subl`, `atom`, `antigravity`).
 *
 * ## What this module is and is not
 *
 * This is **data**: the names, the kinds and the keywords are the target's own,
 * because a clone that renamed an IDE, or that looked for a different process
 * name, would not find the IDE the target finds.
 *
 * The **detection** itself — running `ps aux`, or `tasklist` — is *not* here:
 * a process listing is a side effect on the host, and the module that would
 * run it is the one that owns the refusal. What is here is the **command the
 * target runs**, as data, and the **rule the target applies** to the output.
 */

import { basename as pathBasename } from 'node:path';

/* -------------------------------------------------------------------------- */
/* The kinds and the platforms                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The two kinds of IDE the target knows.
 *
 * `vscode` is the VS Code extension family; `jetbrains` is the JetBrains
 * plugin family. The kind decides how the extension is installed and where the
 * plugin directory is looked for.
 */
export const IDE_KINDS = ['vscode', 'jetbrains'] as const;

/** One of the target's two IDE kinds. */
export type IdeKind = (typeof IDE_KINDS)[number];

/**
 * Whether a value is one of the target's two IDE kinds.
 */
export function isIdeKind(value: unknown): value is IdeKind {
  return typeof value === 'string' && (IDE_KINDS as readonly string[]).includes(value);
}

/**
 * The three operating systems the target's process keywords are given for.
 *
 * The target's own platform names are `macos`, `windows` and `linux`; the
 * target reads them from `os.platform()` and maps them.
 */
export const IDE_PLATFORMS = ['macos', 'windows', 'linux'] as const;

/** One of the three operating systems the target's keywords are given for. */
export type IdePlatform = (typeof IDE_PLATFORMS)[number];

/**
 * Whether a value is one of the three operating systems.
 */
export function isIdePlatform(value: unknown): value is IdePlatform {
  return typeof value === 'string' && (IDE_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Map a Node platform name onto one of the three the target names.
 *
 * The target's own `mac`/`darwin`, `win`/`windows` and `linux` spellings are
 * both accepted, because the target switches on `darwin`, `win32` and `linux`.
 * A platform the target does not name maps to `undefined`.
 */
export function idePlatformFor(nodePlatform: string): IdePlatform | undefined {
  switch (nodePlatform) {
    case 'darwin':
    case 'mac':
    case 'macos':
      return 'macos';
    case 'win32':
    case 'win':
    case 'windows':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

/** The process keywords an IDE is detected by, per operating system. */
export interface IdeProcessKeywords {
  /** The keywords the target looks for in the macOS process listing. */
  readonly macos: readonly string[];
  /** The keywords the target looks for in the Windows process listing. */
  readonly windows: readonly string[];
  /** The keywords the target looks for in the Linux process listing. */
  readonly linux: readonly string[];
}

/** One of the target's eighteen IDEs. */
export interface IdeDefinition {
  /** The registry key — the IDE's own lower-case name. */
  readonly key: string;
  /** Which family the IDE belongs to. */
  readonly ideKind: IdeKind;
  /** The name the target shows the user. */
  readonly displayName: string;
  /** The keywords the IDE's process is detected by. */
  readonly processKeywords: IdeProcessKeywords;
}

/**
 * The target's eighteen IDEs, in the target's own order.
 *
 * The order is the target's because the target's own detection loop walks the
 * registry in order and **breaks on the first keyword that matches**, so the
 * order decides which IDE is reported first when two match.
 */
export const IDE_REGISTRY: readonly IdeDefinition[] = Object.freeze([
  {
    key: 'cursor',
    ideKind: 'vscode',
    displayName: 'Cursor',
    processKeywords: {
      macos: ['Cursor Helper', 'Cursor.app'],
      windows: ['cursor.exe'],
      linux: ['cursor'],
    },
  },
  {
    key: 'windsurf',
    ideKind: 'vscode',
    displayName: 'Devin Desktop',
    processKeywords: {
      macos: ['Windsurf Helper', 'Windsurf.app', 'Devin Helper', 'Devin.app'],
      windows: ['windsurf.exe', 'Devin.exe'],
      linux: ['windsurf', 'devin-desktop'],
    },
  },
  {
    key: 'vscode',
    ideKind: 'vscode',
    displayName: 'VS Code',
    processKeywords: {
      macos: ['Visual Studio Code', 'Code Helper'],
      windows: ['code.exe'],
      linux: ['code'],
    },
  },
  {
    key: 'intellij',
    ideKind: 'jetbrains',
    displayName: 'IntelliJ IDEA',
    processKeywords: {
      macos: ['IntelliJ IDEA'],
      windows: ['idea64.exe'],
      linux: ['idea', 'intellij'],
    },
  },
  {
    key: 'pycharm',
    ideKind: 'jetbrains',
    displayName: 'PyCharm',
    processKeywords: {
      macos: ['PyCharm'],
      windows: ['pycharm64.exe'],
      linux: ['pycharm'],
    },
  },
  {
    key: 'webstorm',
    ideKind: 'jetbrains',
    displayName: 'WebStorm',
    processKeywords: {
      macos: ['WebStorm'],
      windows: ['webstorm64.exe'],
      linux: ['webstorm'],
    },
  },
  {
    key: 'phpstorm',
    ideKind: 'jetbrains',
    displayName: 'PhpStorm',
    processKeywords: {
      macos: ['PhpStorm'],
      windows: ['phpstorm64.exe'],
      linux: ['phpstorm'],
    },
  },
  {
    key: 'rubymine',
    ideKind: 'jetbrains',
    displayName: 'RubyMine',
    processKeywords: {
      macos: ['RubyMine'],
      windows: ['rubymine64.exe'],
      linux: ['rubymine'],
    },
  },
  {
    key: 'clion',
    ideKind: 'jetbrains',
    displayName: 'CLion',
    processKeywords: {
      macos: ['CLion'],
      windows: ['clion64.exe'],
      linux: ['clion'],
    },
  },
  {
    key: 'goland',
    ideKind: 'jetbrains',
    displayName: 'GoLand',
    processKeywords: {
      macos: ['GoLand'],
      windows: ['goland64.exe'],
      linux: ['goland'],
    },
  },
  {
    key: 'rider',
    ideKind: 'jetbrains',
    displayName: 'Rider',
    processKeywords: {
      macos: ['Rider'],
      windows: ['rider64.exe'],
      linux: ['rider'],
    },
  },
  {
    key: 'datagrip',
    ideKind: 'jetbrains',
    displayName: 'DataGrip',
    processKeywords: {
      macos: ['DataGrip'],
      windows: ['datagrip64.exe'],
      linux: ['datagrip'],
    },
  },
  {
    key: 'appcode',
    ideKind: 'jetbrains',
    displayName: 'AppCode',
    processKeywords: {
      macos: ['AppCode'],
      windows: ['appcode.exe'],
      linux: ['appcode'],
    },
  },
  {
    key: 'dataspell',
    ideKind: 'jetbrains',
    displayName: 'DataSpell',
    processKeywords: {
      macos: ['DataSpell'],
      windows: ['dataspell64.exe'],
      linux: ['dataspell'],
    },
  },
  {
    key: 'aqua',
    ideKind: 'jetbrains',
    displayName: 'Aqua',
    processKeywords: {
      macos: [],
      windows: ['aqua64.exe'],
      linux: [],
    },
  },
  {
    key: 'gateway',
    ideKind: 'jetbrains',
    displayName: 'Gateway',
    processKeywords: {
      macos: [],
      windows: ['gateway64.exe'],
      linux: [],
    },
  },
  {
    key: 'fleet',
    ideKind: 'jetbrains',
    displayName: 'Fleet',
    processKeywords: {
      macos: [],
      windows: ['fleet.exe'],
      linux: [],
    },
  },
  {
    key: 'androidstudio',
    ideKind: 'jetbrains',
    displayName: 'Android Studio',
    processKeywords: {
      macos: ['Android Studio'],
      windows: ['studio64.exe'],
      linux: ['android-studio'],
    },
  },
] satisfies readonly IdeDefinition[]);

/**
 * The registry keys, in the target's order.
 */
export const IDE_REGISTRY_KEYS: readonly string[] = Object.freeze(
  IDE_REGISTRY.map((ide) => ide.key),
);

/**
 * The registry, keyed by the IDE's key.
 *
 * A lookup of a caller-supplied key goes through {@link ideDefinition}, which
 * guards the lookup with `Object.hasOwn` — a key of `"__proto__"` must not
 * resolve to an inherited member.
 */
const IDE_REGISTRY_BY_KEY: Readonly<Record<string, IdeDefinition>> = Object.freeze(
  Object.fromEntries(IDE_REGISTRY.map((ide) => [ide.key, ide])),
);

/**
 * The registry entry for that key, or `undefined` when there is none.
 *
 * The lookup is guarded with `Object.hasOwn`, so a key of `"__proto__"`,
 * `"constructor"` or `"toString"` resolves to nothing.
 */
export function ideDefinition(key: string): IdeDefinition | undefined {
  if (typeof key !== 'string' || key.length === 0) return undefined;
  if (!Object.hasOwn(IDE_REGISTRY_BY_KEY, key)) return undefined;
  return IDE_REGISTRY_BY_KEY[key];
}

/**
 * Whether that key names an IDE the target knows.
 */
export function isIdeKey(key: string): boolean {
  return ideDefinition(key) !== undefined;
}

/**
 * Whether that key names an IDE of the VS Code extension family.
 *
 * The target's own test is `ideKind === "vscode"` on the registry entry.
 */
export function isVSCodeFamily(key: string): boolean {
  return ideDefinition(key)?.ideKind === 'vscode';
}

/**
 * Whether that key names an IDE of the JetBrains plugin family.
 *
 * The target's own test is `ideKind === "jetbrains"` on the registry entry.
 */
export function isJetBrainsFamily(key: string): boolean {
  return ideDefinition(key)?.ideKind === 'jetbrains';
}

/**
 * The process keywords for that IDE on that operating system.
 *
 * An IDE the target does not know has **no** keywords — the empty list, not a
 * guess.
 */
export function ideProcessKeywords(key: string, platform: IdePlatform): readonly string[] {
  const ide = ideDefinition(key);
  if (ide === undefined) return [];
  return ide.processKeywords[platform];
}

/* -------------------------------------------------------------------------- */
/* The display names                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The target's **editor** display-name table — twelve entries, and a
 * different table from the IDE registry.
 *
 * It names the editors as well as the IDEs: `antigravity`, `vi`, `vim`,
 * `nano`, `notepad`, `"start /wait notepad"`, `emacs`, `subl` and `atom` are
 * in it, and the three IDEs that share a name with an entry (`code`,
 * `cursor`, `windsurf`) are in it too.
 */
export const EDITOR_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  code: 'VS Code',
  cursor: 'Cursor',
  windsurf: 'Devin Desktop',
  antigravity: 'Antigravity',
  vi: 'Vim',
  vim: 'Vim',
  nano: 'nano',
  notepad: 'Notepad',
  'start /wait notepad': 'Notepad',
  emacs: 'Emacs',
  subl: 'Sublime Text',
  atom: 'Atom',
});

/**
 * The display name for an IDE, an editor, or a terminal.
 *
 * The target's own resolver, `Kw(e)`, in its own order:
 *
 *   1. an empty string is `"IDE"`;
 *   2. a registry key is the registry entry's `displayName`;
 *   3. an editor table key (lower-cased and trimmed) is that table's name;
 *   4. otherwise the part of the input **before the first space** is reduced
 *      to its **basename** and lower-cased, and looked up in the editor table;
 *      if it is not there, that lower-cased basename is returned;
 *   5. and otherwise the lower-cased input.
 *
 * The fourth step is the target's own: it splits on the **first** space, not
 * the last, and it takes a **basename**, so a path is reduced to its file
 * name.
 */
export function ideDisplayName(value: string): string {
  if (!value) return 'IDE';
  const ide = ideDefinition(value);
  if (ide !== undefined) return ide.displayName;

  const lowered = value.toLowerCase().trim();
  if (Object.hasOwn(EDITOR_DISPLAY_NAMES, lowered)) {
    return EDITOR_DISPLAY_NAMES[lowered] as string;
  }

  const space = value.indexOf(' ');
  const head = space === -1 ? value : value.slice(0, space);
  if (head.length > 0) {
    const base = pathBasename(head).toLowerCase();
    if (Object.hasOwn(EDITOR_DISPLAY_NAMES, base)) {
      return EDITOR_DISPLAY_NAMES[base] as string;
    }
    return base;
  }
  return value.toLowerCase();
}

/**
 * The target's own normalisation of an IDE's name for display.
 *
 * The target replaces `windsurf` — in any case — with `Devin Desktop`, so a
 * lock file that names `Windsurf` is shown as `Devin Desktop`.
 */
export function normalizeIdeName(name: string): string {
  return name.replace(/windsurf/gi, 'Devin Desktop');
}

/* -------------------------------------------------------------------------- */
/* The detection                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The three process-listing commands the target runs, one per platform.
 *
 * The command is the target's own, verbatim, including the `grep -v grep` the
 * target appends so that the listing does not match itself.
 */
export const IDE_PROCESS_DETECTION_COMMANDS: Readonly<Record<IdePlatform, string>> =
  Object.freeze({
    macos:
      'ps aux | grep -E "Visual Studio Code|Code Helper|Cursor Helper|Windsurf Helper|Devin Helper|Devin.app|IntelliJ IDEA|PyCharm|WebStorm|PhpStorm|RubyMine|CLion|GoLand|Rider|DataGrip|AppCode|DataSpell|Aqua|Gateway|Fleet|Android Studio" | grep -v grep',
    windows:
      'tasklist | findstr /I "Code.exe Cursor.exe Windsurf.exe Devin.exe idea64.exe pycharm64.exe webstorm64.exe phpstorm64.exe rubymine64.exe clion64.exe goland64.exe rider64.exe datagrip64.exe appcode.exe dataspell64.exe aqua64.exe gateway64.exe fleet.exe studio64.exe"',
    linux:
      'ps aux | grep -E "code|cursor|windsurf|devin-desktop|idea|pycharm|webstorm|phpstorm|rubymine|clion|goland|rider|datagrip|dataspell|aqua|gateway|fleet|android-studio" | grep -v grep',
  });

/**
 * The IDEs a process listing names.
 *
 * The target's own rule, per platform:
 *
 *   - **macOS** — the listing is matched **case-sensitively** against the
 *     macOS keywords; the first keyword that appears names the IDE.
 *   - **Windows** — the listing is lower-cased and the keywords are
 *     lower-cased, and the first keyword that appears names the IDE.
 *   - **Linux** — the listing is lower-cased and the keywords are matched
 *     as they are; the first keyword that appears names the IDE. There is one
 *     extra rule: the `vscode` entry is **only** reported when the listing
 *     contains neither `cursor` nor `appcode`, because the Linux keyword for
 *     VS Code is `code`, and `code` is a substring of `appcode`.
 *
 * The registry is walked **in order**, and each IDE is reported at most once.
 */
export function detectIdesFromProcessList(
  listing: string,
  platform: IdePlatform,
): string[] {
  const found: string[] = [];
  const haystack = platform === 'macos' ? listing : listing.toLowerCase();
  for (const ide of IDE_REGISTRY) {
    const keywords = ide.processKeywords[platform];
    for (const keyword of keywords) {
      const needle = platform === 'macos' ? keyword : keyword.toLowerCase();
      if (!haystack.includes(needle)) continue;
      if (platform === 'linux' && ide.key === 'vscode') {
        if (haystack.includes('cursor') || haystack.includes('appcode')) continue;
      }
      found.push(ide.key);
      break;
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* The JetBrains side                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The JetBrains plugin's directory name.
 *
 * The target looks for a directory of exactly this name under each product's
 * plugin directory.
 */
export const JETBRAINS_PLUGIN_DIRECTORY = 'claude-code-jetbrains-plugin';

/**
 * The JetBrains product directories — fifteen entries, one per JetBrains IDE.
 *
 * The three VS Code-family IDEs are **not** in this table: the JetBrains
 * plugin is installed under the JetBrains product directories only.
 */
export const JETBRAINS_PRODUCT_DIRECTORIES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    pycharm: ['PyCharm'],
    intellij: ['IntelliJIdea', 'IdeaIC'],
    webstorm: ['WebStorm'],
    phpstorm: ['PhpStorm'],
    rubymine: ['RubyMine'],
    clion: ['CLion'],
    goland: ['GoLand'],
    rider: ['Rider'],
    datagrip: ['DataGrip'],
    appcode: ['AppCode'],
    dataspell: ['DataSpell'],
    aqua: ['Aqua'],
    gateway: ['Gateway'],
    fleet: ['Fleet'],
    androidstudio: ['AndroidStudio'],
  });

/**
 * The command the target runs to open a project in that IDE.
 *
 * The table is keyed by the **family**, not by the registry key: the three
 * VS Code-family IDEs share it.
 */
export const IDE_FAMILY_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  vscode: ['code', 'codium'],
  cursor: ['cursor'],
  windsurf: ['windsurf', 'devin'],
});

/**
 * The VS Code extension's identifier.
 *
 * The target installs and lists exactly this extension.
 */
export const VSCODE_EXTENSION_ID = 'anthropic.claude-code';
