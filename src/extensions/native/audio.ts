/**
 * The **audio capture surface** — the target's native audio addon, the wrapper
 * around it, the microphone permission rule, and the `/voice` option parsing.
 *
 * Evidence: the target's own source, recorded in
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-native-addons.md`:
 * `chunk-vjnh31ch.js:704` (the loader), `:1048`–`:1505` (the nine wrappers),
 * `chunk-mhdmymcx.js:3653` (the permission rule), and
 * `chunk-v47hn89x.js:3865` (the option parsing).
 *
 * ## The wrapper
 *
 * The target wraps the addon in **nine** functions, and every one of them has an
 * answer for the case where the addon is not there:
 *
 * | The wrapper | The addon's export | The answer when the addon is absent |
 * |---|---|---|
 * | `isNativeAudioAvailable` | — | `false` |
 * | `startNativeRecording` | `startRecording` | `false` |
 * | `stopNativeRecording` | `stopRecording` | nothing |
 * | `isNativeRecordingActive` | `isRecording` | `false` |
 * | `startNativePlayback` | `startPlayback` | `false` |
 * | `stopNativePlayback` | `stopPlayback` | nothing |
 * | `writeNativePlaybackData` | `writePlaybackData` | nothing |
 * | `isNativePlaying` | `isPlaying` | `false` |
 * | `microphoneAuthorizationStatus` | `microphoneAuthorizationStatus` | **`0`** |
 *
 * The last one is the target's own value, and the target's wrapper answers it
 * when the addon is absent **and** when the addon does not carry the export.
 *
 * ## The honest boundary
 *
 * **This implementation ships no native addon**, so every operation that would
 * use one **refuses** and names the capability it would have needed. The
 * queries keep the target's own values, because a query has no work to refuse.
 *
 * The target's fallbacks — the ALSA `arecord` recorder and the SoX `rec`
 * recorder — are **not** implemented here either, and the document says so.
 */

import {
  loadNativeAddon,
  nativeAddonExport,
  refuseNativeAddon,
  type NativeAddonExports,
  type NativeAddonResult,
} from './addons.js';

/* -------------------------------------------------------------------------- */
/* The addon                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The loaded native audio addon, or `null`.
 *
 * @returns the addon's exports, or `null` when the addon is not there.
 */
function audioAddon(): NativeAddonExports | null {
  return loadNativeAddon('audio-capture');
}

/**
 * Whether the native audio addon is loaded.
 *
 * @returns whether the addon is there.
 */
export function isNativeAudioAvailable(): boolean {
  return audioAddon() !== null;
}

/* -------------------------------------------------------------------------- */
/* The recording                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Start a native recording.
 *
 * The target's call takes **two callbacks** — the data callback, which receives
 * the captured bytes, and the end callback — and answers a boolean.
 *
 * **This implementation ships no native addon**, so the call refuses.
 *
 * @param onData the callback the captured bytes arrive on.
 * @param onEnd the callback the recording's end arrives on.
 * @returns the refusal.
 */
export function startNativeRecording(
  onData: (chunk: Buffer) => void,
  onEnd: () => void,
): NativeAddonResult<boolean> {
  void onData;
  void onEnd;
  return refuseNativeAddon('audio-capture', 'native audio recording');
}

/**
 * Stop the native recording.
 *
 * **This implementation ships no native addon**, so the call refuses.
 *
 * @returns the refusal.
 */
export function stopNativeRecording(): NativeAddonResult<null> {
  return refuseNativeAddon('audio-capture', 'native audio recording');
}

/**
 * Whether a native recording is running.
 *
 * The target's own answer when the addon is absent is `false`, and that is the
 * answer here.
 *
 * @returns whether a recording is running.
 */
export function isNativeRecordingActive(): boolean {
  const addon = audioAddon();
  const isRecording = nativeAddonExport(addon, 'isRecording');
  if (typeof isRecording !== 'function') return false;
  return isRecording() === true;
}

/* -------------------------------------------------------------------------- */
/* The playback                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Start a native playback.
 *
 * The target's wrapper passes two arguments through to the addon's
 * `startPlayback`. **This implementation ships no native addon**, so the call
 * refuses.
 *
 * @param file what to play.
 * @param options the options the target's wrapper passes through.
 * @returns the refusal.
 */
export function startNativePlayback(
  file: string,
  options: Readonly<Record<string, unknown>>,
): NativeAddonResult<boolean> {
  void file;
  void options;
  return refuseNativeAddon('audio-capture', 'native audio playback');
}

/**
 * Stop the native playback.
 *
 * **This implementation ships no native addon**, so the call refuses.
 *
 * @returns the refusal.
 */
export function stopNativePlayback(): NativeAddonResult<null> {
  return refuseNativeAddon('audio-capture', 'native audio playback');
}

/**
 * Write a buffer to the native playback.
 *
 * **This implementation ships no native addon**, so the call refuses.
 *
 * @param data the buffer.
 * @returns the refusal.
 */
export function writeNativePlaybackData(data: Buffer): NativeAddonResult<null> {
  void data;
  return refuseNativeAddon('audio-capture', 'native audio playback');
}

/**
 * Whether a native playback is running.
 *
 * The target's own answer when the addon is absent is `false`, and that is the
 * answer here.
 *
 * @returns whether a playback is running.
 */
export function isNativePlaying(): boolean {
  const addon = audioAddon();
  const isPlaying = nativeAddonExport(addon, 'isPlaying');
  if (typeof isPlaying !== 'function') return false;
  return isPlaying() === true;
}

/**
 * The microphone authorization status.
 *
 * The target's own answer when the addon is absent — or when the addon does
 * not carry the export — is **`0`**, and that is the answer here.
 *
 * @returns the status.
 */
export function microphoneAuthorizationStatus(): number {
  const addon = audioAddon();
  const status = nativeAddonExport(addon, 'microphoneAuthorizationStatus');
  if (typeof status !== 'function') return 0;
  return status() as number;
}

/* -------------------------------------------------------------------------- */
/* The permission rule                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The target's own message for a microphone the session may not use.
 *
 * The product name is the target's, and this implementation names its own.
 */
export const MICROPHONE_ACCESS_DENIED =
  "Microphone access is denied. To enable it, go to your system's audio settings, " +
  'then run /voice again.';

/** What the permission rule decides. */
export interface MicrophonePermissionInput {
  /** The native audio addon is loaded. */
  readonly nativeAudioAvailable: boolean;
  /** A native recording started. */
  readonly recordingStarted?: boolean;
  /**
   * There is a capture path at all.
   *
   * The target's own rule does not ask this question: it grants the request
   * when the native addon is absent, because the OS prompt belongs to the
   * native recorder and the target has a command-line recorder besides it.
   * This implementation has **no** recorder besides the addon, so the question
   * is asked, and the answer decides.
   */
  readonly capturePathAvailable: boolean;
}

/** The permission rule's answer. */
export interface MicrophonePermissionDecision {
  /** Whether the session may capture audio. */
  readonly granted: boolean;
  /** Why the request was refused, when it was. */
  readonly reason: string | null;
}

/**
 * Decide whether the session may capture audio.
 *
 * The target's own rule, in the target's own order:
 *
 *   - **no native addon** — there is no OS prompt to raise, so the request is
 *     **granted**;
 *   - **a native addon that started a recording** — the recording is the grant,
 *     so the request is **granted**;
 *   - **a native addon that did not** — the request is **refused**.
 *
 * And this implementation's own first question: **no capture path at all** —
 * the request is refused, and the refusal names the capability it would have
 * needed.
 *
 * @param input what the rule decides over.
 * @returns the decision.
 */
export function resolveMicrophonePermission(
  input: MicrophonePermissionInput,
): MicrophonePermissionDecision {
  if (!input.capturePathAvailable) {
    return {
      granted: false,
      reason:
        'capturing audio needs a native audio capture addon; this implementation ships no ' +
        'native addon and implements no command-line recorder, so it refuses.',
    };
  }
  if (!input.nativeAudioAvailable) return { granted: true, reason: null };
  if (input.recordingStarted === true) return { granted: true, reason: null };
  return { granted: false, reason: MICROPHONE_ACCESS_DENIED };
}

/* -------------------------------------------------------------------------- */
/* The option parsing                                                          */
/* -------------------------------------------------------------------------- */

/** The three modes `/voice` accepts. */
export type VoiceMode = 'hold' | 'tap' | 'off';

/**
 * What the argument to `/voice` means.
 *
 * `undefined` — the argument was empty, so no mode was given; `invalid` — the
 * argument named no mode; otherwise the mode itself.
 */
export type VoiceModeParse = VoiceMode | 'invalid' | undefined;

/**
 * Parse the argument to `/voice`.
 *
 * The target's own parser: the argument is trimmed and lower-cased, the empty
 * argument means **no mode**, the three modes are accepted, and anything else
 * is invalid.
 *
 * @param argument the argument the command was given.
 * @returns what the argument means.
 */
export function parseVoiceMode(argument: string): VoiceModeParse {
  const mode = argument.trim().toLowerCase();
  if (mode === '') return undefined;
  if (mode === 'hold' || mode === 'tap' || mode === 'off') return mode;
  return 'invalid';
}

/**
 * The message the target gives for an argument that names no mode.
 *
 * The target quotes the **trimmed** argument, not the lower-cased one.
 *
 * @param argument the argument the command was given.
 * @returns the message.
 */
export function voiceModeRejection(argument: string): string {
  return `Unknown mode: "${argument.trim()}". Use hold, tap, or off.`;
}
