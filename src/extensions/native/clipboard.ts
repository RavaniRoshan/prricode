/**
 * The **clipboard surface** — the probe that decides how the clipboard is
 * reached, the status vocabulary, and the operations that would need the native
 * clipboard addon.
 *
 * Evidence: the target's own source, recorded in
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-native-addons.md`:
 * `chunk-yp10c36w.js:3651` (the state), `:3738` (the probe), `:4115` (the
 * demotion rule), `:4699` (the status), `:6555` (the write) and `:8259` (the
 * read).
 *
 * ## The probe
 *
 * The target picks **one** mechanism for the clipboard and keeps it. The order is
 * the target's own:
 *
 * 1. **`wl-copy`** — when there is a Wayland display and the command is there;
 * 2. **`xclip`** — when there is an X11 display and the command is there;
 * 3. **`xsel`** — the same, after `xclip`;
 * 4. **the native addon** — when there is a display, the addon is loaded, and no
 *    earlier addon write has failed;
 * 5. **nothing** — `null`, the probe's own "no mechanism" answer.
 *
 * The addon is **demoted after one failed write**: the failure is recorded, and
 * the re-probe the write triggers skips the addon and lands on nothing. A
 * write that succeeds keeps it.
 *
 * ## The status
 *
 * Four answers, and they are the target's own strings:
 * `not_linux`, `not_probed` (the probe never ran), the tool's name, and `none`
 * (the probe ran and found nothing).
 *
 * ## The honest boundary
 *
 * **This implementation ships no native addon**, and it implements **none** of
 * the target's other mechanisms — the `wl-copy`/`xclip`/`xsel` commands and the
 * OSC 52 terminal copy are all absent. The write and the read therefore
 * **refuse**, and each refusal names the capability it would have needed.
 * Nothing shells out to a clipboard binary to stand in for the addon.
 */

import {
  loadNativeAddon,
  nativeAddonExport,
  refuseNativeAddon,
  type NativeAddonResult,
} from './addons.js';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The mechanisms the target may use for the clipboard, in the target's order.
 *
 * The first three are commands; the fourth is the native addon.
 */
export const CLIPBOARD_TOOLS = ['wl-copy', 'xclip', 'xsel', 'addon'] as const;

/** One of the mechanisms. */
export type ClipboardTool = (typeof CLIPBOARD_TOOLS)[number];

/**
 * What the clipboard is using.
 *
 * `not_linux` — the platform is not Linux; `not_probed` — the probe never ran;
 * a tool's name — the mechanism; `none` — the probe ran and found nothing.
 */
export type ClipboardToolStatus = 'not_linux' | 'not_probed' | ClipboardTool | 'none';

/* -------------------------------------------------------------------------- */
/* The state                                                                   */
/* -------------------------------------------------------------------------- */

/** What the clipboard's probe has settled on so far. */
export interface ClipboardToolState {
  /**
   * The mechanism the probe chose.
   *
   * `undefined` — the probe never ran; `null` — the probe ran and found
   * nothing; a name — the mechanism.
   */
  readonly tool?: ClipboardTool | null;
  /** An addon write failed and the addon was demoted. */
  readonly addonWriteFailed: boolean;
  /** An addon write succeeded at least once. */
  readonly addonWriteSucceeded: boolean;
}

/**
 * The state a fresh clipboard starts in.
 *
 * @returns the state.
 */
export function createClipboardToolState(): ClipboardToolState {
  return { tool: undefined, addonWriteFailed: false, addonWriteSucceeded: false };
}

/* -------------------------------------------------------------------------- */
/* The environment                                                             */
/* -------------------------------------------------------------------------- */

/** What the probe looks at. */
export interface ClipboardEnvironment {
  /** The platform: `linux`, `macos`, `windows`, `wsl` or `unknown`. */
  readonly platform: string;
  /** The X11 display, if there is one. */
  readonly display?: string | undefined;
  /** The Wayland display, if there is one. */
  readonly waylandDisplay?: string | undefined;
  /**
   * Whether a command is on the search path.
   *
   * The target's own probe is `Bun.which(command)`, and it answers the path or
   * nothing; truthiness is what the probe reads.
   */
  readonly hasCommand: (command: string) => boolean | Promise<boolean>;
  /** The native clipboard addon is loaded, and carries `setLinuxClipboardText`. */
  readonly addonAvailable: boolean;
}

/**
 * Whether there is a display to reach the clipboard through.
 *
 * The target's own rule: an X11 `DISPLAY` counts when it starts with `unix:`
 * or with a bare colon; without a `DISPLAY`, any Wayland display counts.
 *
 * @param environment the environment.
 * @returns whether a display exists.
 */
export function hasClipboardDisplay(environment: ClipboardEnvironment): boolean {
  const display = environment.display;
  if (display !== undefined && display !== '') return /^(unix)?:/.test(display);
  return Boolean(environment.waylandDisplay);
}

/* -------------------------------------------------------------------------- */
/* The probe                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run the probe.
 *
 * The probe is **pure**: it reads the state and answers the state it would
 * leave behind, and it never changes the state itself.
 *
 * The target's own early return is reproduced: on a platform that is not Linux
 * the probe does nothing at all, and a mechanism that has already been chosen
 * is kept — except for the addon, which is re-probed so that a failed write can
 * demote it.
 *
 * @param state the state the probe reads.
 * @param environment what the probe looks at.
 * @returns the state the probe leaves behind.
 */
export async function probeClipboardTool(
  state: ClipboardToolState,
  environment: ClipboardEnvironment,
): Promise<ClipboardToolState> {
  if (environment.platform !== 'linux') return state;
  if (typeof state.tool === 'string' && state.tool !== 'addon') return state;

  const wayland = environment.waylandDisplay;
  if (wayland !== undefined && wayland !== '') {
    if (await environment.hasCommand('wl-copy')) return { ...state, tool: 'wl-copy' };
  }

  const display = environment.display;
  if (display !== undefined && display !== '') {
    if (await environment.hasCommand('xclip')) return { ...state, tool: 'xclip' };
    if (await environment.hasCommand('xsel')) return { ...state, tool: 'xsel' };
  }

  if (
    !state.addonWriteFailed &&
    hasClipboardDisplay(environment) &&
    environment.addonAvailable
  ) {
    return { ...state, tool: 'addon' };
  }

  return { ...state, tool: null };
}

/**
 * Record the outcome of an addon write.
 *
 * The target's own rule: a write that succeeded is remembered; a write that
 * failed demotes the addon **unless** a write had already succeeded.
 *
 * @param state the state the write happened against.
 * @param succeeded whether the write succeeded.
 * @returns the state the write leaves behind.
 */
export function recordClipboardAddonWrite(
  state: ClipboardToolState,
  succeeded: boolean,
): ClipboardToolState {
  if (succeeded) return { ...state, addonWriteSucceeded: true };
  return {
    ...state,
    addonWriteFailed: state.addonWriteFailed || !state.addonWriteSucceeded,
  };
}

/**
 * What the clipboard is using.
 *
 * @param state the state.
 * @param platform the platform.
 * @returns the status.
 */
export function clipboardToolStatus(
  state: ClipboardToolState,
  platform: string,
): ClipboardToolStatus {
  if (platform !== 'linux') return 'not_linux';
  if (state.tool === undefined) return 'not_probed';
  return state.tool ?? 'none';
}

/* -------------------------------------------------------------------------- */
/* The operations                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Write text to the clipboard.
 *
 * The target writes through the mechanism the probe chose — the native addon
 * when the addon is the mechanism, and one of the three commands otherwise.
 *
 * **This implementation has neither.** The write refuses, and the refusal names
 * the capability it would have needed.
 *
 * @param text the text to write.
 * @returns the refusal.
 */
export function writeClipboardText(text: string): NativeAddonResult<boolean> {
  void text;
  return refuseNativeAddon('clipboard-napi', 'clipboard write');
}

/**
 * Read the clipboard.
 *
 * The target reads through the mechanism the probe chose, and strips the
 * trailing newline the addon returns.
 *
 * **This implementation has neither.** The read refuses, and the refusal names
 * the capability it would have needed.
 *
 * @returns the refusal.
 */
export function readClipboardText(): NativeAddonResult<string | null> {
  return refuseNativeAddon('clipboard-napi', 'clipboard read');
}

/* -------------------------------------------------------------------------- */
/* The addon                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether the native clipboard addon is loaded and carries the write export.
 *
 * This is the target's own probe condition: the addon must be there **and** it
 * must own `setLinuxClipboardText`.
 *
 * @returns whether the addon can write.
 */
export function nativeClipboardAddonAvailable(): boolean {
  const addon = loadNativeAddon('clipboard-napi');
  return nativeAddonExport(addon, 'setLinuxClipboardText') !== undefined;
}
