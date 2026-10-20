/**
 * The **theme**: the target's colours, the rule that maps a role to one, and
 * the glyph set the transcript and the composer draw with.
 *
 * Evidence: the `CC-022` milestone of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`,
 * and the specification it names —
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-terminal-ui.md` §1
 * ("The theme and the colour rules") and §1.4 ("Glyph constants").
 *
 * ## What this module is
 *
 * The target's UI is coloured by **role**, not by literal: a component asks for
 * the `permission` role and the theme decides what that means. The rule is one
 * function — `qn(role, theme)` — and every component in the target goes through
 * it, so the whole UI changes colour when the theme changes.
 *
 * This module is that rule, and it is **the only** place a colour literal
 * lives.
 *
 * ## The theme values are the target's
 *
 * The dark theme — the target's **default** — is reproduced **verbatim** from
 * the bundle (`chunk-x6tyc5tp.js:16451`). Every value is the target's own
 * `rgb(r,g,b)` literal, spaces and all, because the value *is* the contract:
 * a colour that is one unit off is a different colour.
 *
 * The other five themes (`light`, `light-ansi`, `dark-ansi`,
 * `light-daltonized`, `dark-daltonized`) are **not** reproduced in full: the
 * specification established only *selected* values for them (§1.2). Those
 * values are reproduced, and every role the specification did **not** establish
 * for a theme keeps the dark theme's value — the specification is the contract,
 * and a value it does not carry is not invented.
 *
 * ## The rule
 *
 * * `isThemeRole(role)` is the target's `dMt`: `Object.hasOwn(theme, role)` —
 *   the test the target's own wrappers use to decide whether a role exists.
 * * `roleColor(role)` is the target's `qn`: the role's literal, or nothing when
 *   the role is not in the theme.
 *
 * The lookup is **own-property** on purpose: a role name can come from a
 * model (a tool's colour role), and `Object.prototype` carries members called
 * `constructor` and `toString`.
 *
 * ## The glyphs
 *
 * The glyph set (§1.4) is **platform-dependent** in the target, and the
 * deltas are the contract:
 *
 *   - the assistant's bullet is `⏺` on macOS and `●` everywhere else;
 *   - on `TERM=linux` the pointer is `>` (not `❯`), the tick is `√` (not
 *     `✔`) and the cross is `×` (not `✘`).
 *
 * The clone reproduces the rule, not one platform's answer, so the tests can
 * pin both sides of the delta.
 *
 * ## The segment
 *
 * The renderers in `src/ui/render/` produce **segments**: a piece of text and
 * how it is drawn. A segment carries a **role** (a theme role) rather than a
 * colour, so the colour is resolved once, here, at the moment the segment is
 * drawn. That is the target's own arrangement (`qn` is called by the component
 * that draws the text, not by the parser that produced it).
 */

/* -------------------------------------------------------------------------- */
/* The segment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A piece of text and how it is drawn.
 *
 * The renderers in `src/ui/render/` produce segments rather than coloured
 * strings: a segment carries a **role**, not a colour, so the colour is
 * resolved once — here, by `roleColor` — at the moment the segment is drawn.
 * That is the target's own arrangement: the target's `qn(role, theme)` is
 * called by the component that draws the text, not by the parser that produced
 * it.
 */
export interface Segment {
  /** The text. */
  readonly text: string;
  /** The theme role the text is drawn in, when it has one. */
  readonly role?: string | undefined;
  /** Whether the text is bold. */
  readonly bold?: boolean | undefined;
  /** Whether the text is italic. */
  readonly italic?: boolean | undefined;
  /** Whether the text is dimmed. */
  readonly dim?: boolean | undefined;
  /** Whether the text is underlined. */
  readonly underline?: boolean | undefined;
  /** Whether the text is struck through. */
  readonly strike?: boolean | undefined;
  /** Whether the text is drawn in the inverse colours — the cursor. */
  readonly inverse?: boolean | undefined;
  /**
   * The label the segment is announced with, when it has one.
   *
   * The target labels its **gutters** for a screen reader — `you:` for the
   * user's pointer, `prricode:` for the assistant's bullet, `tool:` for a tool
   * call's bullet and `thinking:` for a thinking block (§3.1, §3.3 – §3.5) —
   * and a label replaces the segment's text in the announcement, which is
   * exactly what the target wants: the marker is decoration, the name is the
   * information.
   */
  readonly ariaLabel?: string | undefined;
  /** The URL a terminal hyperlink would point at, when the text is a link. */
  readonly link?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* The theme                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The dark theme — the target's default — **verbatim**.
 *
 * Every value is the target's own literal, from `chunk-x6tyc5tp.js:16451`.
 * The values are not "close enough": they are the contract.
 */
export const DARK_THEME = {
  autoAccept: 'rgb(175,135,255)',
  autoAcceptShimmer: 'rgb(208,180,255)',
  skill: 'rgb(175,135,255)',
  bashBorder: 'rgb(253,93,177)',
  prricode: 'rgb(215,119,87)',
  prricodeShimmer: 'rgb(235,159,127)',
  prricodeBlue_FOR_SYSTEM_SPINNER: 'rgb(147,165,255)',
  prricodeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(177,195,255)',
  permission: 'rgb(177,185,249)',
  permissionShimmer: 'rgb(207,215,255)',
  planMode: 'rgb(72,150,140)',
  ide: 'rgb(71,130,200)',
  promptBorder: 'rgb(136,136,136)',
  promptBorderShimmer: 'rgb(166,166,166)',
  text: 'rgb(255,255,255)',
  inverseText: 'rgb(0,0,0)',
  inactive: 'rgb(153,153,153)',
  inactiveShimmer: 'rgb(193,193,193)',
  subtle: 'rgb(80,80,80)',
  suggestion: 'rgb(177,185,249)',
  remember: 'rgb(177,185,249)',
  background: 'rgb(0,204,204)',
  success: 'rgb(78,186,101)',
  error: 'rgb(255,107,128)',
  warning: 'rgb(255,193,7)',
  merged: 'rgb(175,135,255)',
  warningShimmer: 'rgb(255,223,57)',
  diffAdded: 'rgb(34,92,43)',
  diffRemoved: 'rgb(122,41,54)',
  diffAddedDimmed: 'rgb(71,88,74)',
  diffRemovedDimmed: 'rgb(105,72,77)',
  diffAddedWord: 'rgb(56,166,96)',
  diffRemovedWord: 'rgb(179,89,107)',
  red_FOR_SUBAGENTS_ONLY: 'rgb(220,38,38)',
  blue_FOR_SUBAGENTS_ONLY: 'rgb(106,155,204)',
  green_FOR_SUBAGENTS_ONLY: 'rgb(22,163,74)',
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(202,138,4)',
  purple_FOR_SUBAGENTS_ONLY: 'rgb(130,125,189)',
  orange_FOR_SUBAGENTS_ONLY: 'rgb(217,119,87)',
  pink_FOR_SUBAGENTS_ONLY: 'rgb(196,102,134)',
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(8,145,178)',
  professionalBlue: 'rgb(106,155,204)',
  chromeYellow: 'rgb(251,188,4)',
  clawd_body: 'rgb(215,119,87)',
  clawd_background: 'rgb(0,0,0)',
  userMessageBackground: 'rgb(55, 55, 55)',
  userMessageBackgroundHover: 'rgb(70, 70, 70)',
  composerSidebarBackground: 'rgb(38, 38, 38)',
  selectionBg: 'rgb(38, 79, 120)',
  bashMessageBackgroundColor: 'rgb(65, 60, 65)',
  memoryBackgroundColor: 'rgb(55, 65, 70)',
  rate_limit_fill: 'rgb(177,185,249)',
  rate_limit_empty: 'rgb(80,83,112)',
  fastMode: 'rgb(255,120,20)',
  fastModeShimmer: 'rgb(255,165,70)',
  effortUltra: 'rgb(175,135,255)',
  briefLabelYou: 'rgb(122,180,232)',
  briefLabelPrricode: 'rgb(215,119,87)',
  rainbow_red: 'rgb(235,95,87)',
  rainbow_orange: 'rgb(245,139,87)',
  rainbow_yellow: 'rgb(250,195,95)',
  rainbow_green: 'rgb(145,200,130)',
  rainbow_blue: 'rgb(130,170,220)',
  rainbow_indigo: 'rgb(155,130,200)',
  rainbow_violet: 'rgb(200,130,180)',
  rainbow_red_shimmer: 'rgb(250,155,147)',
  rainbow_orange_shimmer: 'rgb(255,185,137)',
  rainbow_yellow_shimmer: 'rgb(255,225,155)',
  rainbow_green_shimmer: 'rgb(185,230,180)',
  rainbow_blue_shimmer: 'rgb(180,205,240)',
  rainbow_indigo_shimmer: 'rgb(195,180,230)',
  rainbow_violet_shimmer: 'rgb(230,180,210)',
} as const;

/** A role of the theme. */
export type ThemeRole = keyof typeof DARK_THEME;

/** A theme: every role the target's dark theme has. */
export type Theme = Readonly<Record<ThemeRole, string>>;

/** The values a variant theme establishes. */
export type ThemeVariant = Partial<Record<ThemeRole, string>>;

/**
 * The theme names the target knows.
 *
 * The target's `sj(r)` (`chunk-x6tyc5tp.js:21403`) switches on exactly these
 * five names and falls through to the dark theme for everything else — so
 * `dark` is the name the clone adds for the default.
 */
export const THEME_NAMES = [
  'dark',
  'light',
  'light-ansi',
  'dark-ansi',
  'light-daltonized',
  'dark-daltonized',
] as const;

/** A theme name. */
export type ThemeName = (typeof THEME_NAMES)[number];

/** The theme the target uses when nothing else is asked for. */
export const DEFAULT_THEME_NAME: ThemeName = 'dark';

/**
 * The values the specification established for the **non-dark** themes.
 *
 * These are the *selected* values of §1.2 — the specification read a handful
 * of roles out of each variant theme, not the whole object. A role that is not
 * here keeps the dark theme's value, because the specification does not
 * establish the variant's own value for it.
 */
export const THEME_VARIANTS: ReadonlyMap<ThemeName, ThemeVariant> = new Map<
  ThemeName,
  ThemeVariant
>([
  [
    'light',
    {
      prricode: 'rgb(215,119,87)',
      permission: 'rgb(87,105,247)',
      text: 'rgb(0,0,0)',
      promptBorder: 'rgb(138,138,138)',
      success: 'rgb(44,122,57)',
      error: 'rgb(171,43,63)',
      warning: 'rgb(150,108,30)',
      suggestion: 'rgb(87,105,247)',
      subtle: 'rgb(175,175,175)',
      userMessageBackground: 'rgb(240, 240, 240)',
      inactive: 'rgb(102,102,102)',
    },
  ],
  [
    'light-ansi',
    {
      prricode: 'ansi:redBright',
      permission: 'ansi:blue',
      text: 'ansi:black',
      promptBorder: 'ansi:white',
      success: 'ansi:green',
      error: 'ansi:red',
      warning: 'ansi:yellow',
    },
  ],
  [
    'dark-ansi',
    {
      prricode: 'ansi:redBright',
      permission: 'ansi:blueBright',
      text: 'ansi:white',
      promptBorder: 'ansi:white',
      success: 'ansi:green',
      error: 'ansi:red',
      warning: 'ansi:yellow',
    },
  ],
  [
    'dark-daltonized',
    {
      prricode: 'rgb(255,153,51)',
      permission: 'rgb(153,204,255)',
      text: 'rgb(255,255,255)',
      success: 'rgb(51,153,255)',
      error: 'rgb(255,102,102)',
      warning: 'rgb(255,204,0)',
      diffAdded: 'rgb(0,68,102)',
      diffRemoved: 'rgb(102,0,0)',
    },
  ],
]);

/**
 * The theme a name asks for.
 *
 * An unknown name is the **default** theme — the target's own rule: its
 * `sj(r)` falls through to the dark theme for a name it does not know.
 */
export function themeFor(name?: string | undefined): Theme {
  if (name === undefined) return DARK_THEME;
  // The lookup table is a **Map**, so a caller-supplied name — `constructor`,
  // `__proto__` — reaches nothing but `undefined`.
  const variant = THEME_VARIANTS.get(name as ThemeName);
  if (variant === undefined) return DARK_THEME;
  return { ...DARK_THEME, ...variant };
}

/**
 * Whether a role is in the theme.
 *
 * The target's `dMt` (`chunk-x6tyc5tp.js:6724`): `Object.hasOwn(theme, role)`.
 */
export function isThemeRole(role: string, theme: Theme = DARK_THEME): boolean {
  return Object.hasOwn(theme, role);
}

/**
 * The colour a role names.
 *
 * The target's `qn` (`chunk-4s86dga3.js:655`) reduced to its own rule: a role
 * that is not in the theme has **no** colour, and the caller draws the text
 * uncoloured.
 *
 * The lookup is **own-property**: a role name can come from a model, and
 * `Object.prototype` carries members called `constructor` and `toString`.
 */
export function roleColor(role: string, theme: Theme = DARK_THEME): string | undefined {
  if (!Object.hasOwn(theme, role)) return undefined;
  return theme[role as ThemeRole];
}

/* -------------------------------------------------------------------------- */
/* The platform                                                                */
/* -------------------------------------------------------------------------- */

/** The platforms the target's glyphs differ on. */
export type Platform = 'macos' | 'windows' | 'wsl' | 'linux';

/**
 * The platform the session runs on.
 *
 * The target's `O()`; the clone's own detection, because the target's is a
 * mangled call the specification did not quote.
 */
export function platformOf(env: NodeJS.ProcessEnv = process.env): Platform {
  if (env['PRRICODE_PLATFORM'] !== undefined) {
    const forced = env['PRRICODE_PLATFORM'];
    if (
      forced === 'macos' ||
      forced === 'windows' ||
      forced === 'wsl' ||
      forced === 'linux'
    ) {
      return forced;
    }
  }
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (env['WSL_DISTRO_NAME'] !== undefined || env['WSL_INTEROP'] !== undefined) return 'wsl';
  return 'linux';
}

/**
 * Whether the terminal is the plain Linux one.
 *
 * The target's icon set (`chunk-wb61d889.js`) is chosen by a test that is
 * `false` **only** on `TERM=linux` and not on Windows. This is the rule that
 * makes the pointer `>` rather than `❯`.
 */
export function isLinuxTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['TERM'] === 'linux' && platformOf(env) !== 'windows';
}

/* -------------------------------------------------------------------------- */
/* The glyphs                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The glyph set.
 *
 * Every glyph is the target's own constant (§1.4), and the two that vary by
 * platform vary by the target's rule.
 */
export interface Glyphs {
  /** The prompt pointer: `❯`, or `>` on the plain Linux terminal. */
  readonly pointer: string;
  /** The small pointer: `›`. */
  readonly pointerSmall: string;
  /** The tick: `✔`, or `√` on the plain Linux terminal. */
  readonly tick: string;
  /** The cross: `✘`, or `×` on the plain Linux terminal. */
  readonly cross: string;
  /** The assistant's bullet: `⏺` on macOS, `●` everywhere else. */
  readonly bullet: string;
  /** The small dot: `·`. */
  readonly dot: string;
  /** The ellipsis: `…`. */
  readonly ellipsis: string;
  /** The up arrow: `↑`. */
  readonly arrowUp: string;
  /** The down arrow: `↓`. */
  readonly arrowDown: string;
  /** The lozenge: `◆`. */
  readonly lozenge: string;
  /** The warning sign: `⚠`. */
  readonly warning: string;
  /** The thinking glyph: `∴`. */
  readonly thinking: string;
  /** The tool-result marker: `⎿`. */
  readonly toolResult: string;
  /** The fork directive glyph: `⑂`. */
  readonly fork: string;
  /** The rule: `─`. */
  readonly rule: string;
  /** The fast-mode glyph: `↯`. */
  readonly fastMode: string;
}

/**
 * The glyph set for a platform and terminal.
 *
 * The two platform deltas are the target's own (`chunk-c9s0jh80.js:216418` and
 * the icon set at `chunk-wb61d889.js`).
 */
export function glyphs(
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = platformOf(env),
): Glyphs {
  const linux = isLinuxTerminal(env);
  return {
    pointer: linux ? '>' : '❯',
    pointerSmall: '›',
    tick: linux ? '√' : '✔',
    cross: linux ? '×' : '✘',
    bullet: platform === 'macos' ? '⏺' : '●',
    dot: '·',
    ellipsis: '…',
    arrowUp: '↑',
    arrowDown: '↓',
    lozenge: '◆',
    warning: '⚠',
    thinking: '∴',
    toolResult: '⎿',
    fork: '⑂',
    rule: '─',
    fastMode: '↯',
  };
}

/* -------------------------------------------------------------------------- */
/* The spinner                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The spinner's six frames.
 *
 * The target's default set (`chunk-r89xstcr.js:650`, the `p` array):
 * `· ✢ * ✶ ✻ ✽`. The Ghostty set replaces the fifth frame with `✻` again;
 * the clone uses the default set and says so.
 */
export const SPINNER_FRAMES: readonly string[] = Object.freeze(['·', '✢', '*', '✶', '✻', '✽']);

/**
 * The braille spinner.
 *
 * The target's second spinner (`chunk-c9s0jh80.js:217165`):
 * `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`.
 */
export const BRAILLE_SPINNER_FRAMES: readonly string[] = Object.freeze([
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
]);

/**
 * The frame the spinner shows after `elapsed` milliseconds.
 *
 * The target's index is `Math.round(MLe(T,2000)*(Wwn().length-1))` — an
 * oscillation on a **two-second cosine period** (§12.1). The cosine itself is
 * the target's own `MLe`, which the specification did not quote, so the shape
 * used here is the clone's own and is labelled as such: a half cosine, so the
 * frame walks the set and walks it back.
 */
export function spinnerFrame(elapsedMs: number, frames: readonly string[] = SPINNER_FRAMES): string {
  if (frames.length === 0) return '';
  const period = 2000;
  const phase = (Math.max(0, elapsedMs) % period) / period;
  const wave = (1 + Math.cos(phase * 2 * Math.PI)) / 2;
  const index = Math.round(wave * (frames.length - 1));
  const frame = frames[Math.min(frames.length - 1, Math.max(0, index))];
  return frame ?? '';
}
