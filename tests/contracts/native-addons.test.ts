/**
 * Contract test for the **native addons** — the target's two `.node` addons and
 * the code around them.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded in
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-native-addons.md` — every
 * claim there carries a file and a byte offset. The milestone is `CC-039` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 * Conformance: `docs/compatibility/packaging.md` and
 * `docs/compatibility/extension-surface.md`.
 *
 * What this test pins:
 *
 *   - **the inventory**: the target ships exactly **two** native addons — a
 *     clipboard and an audio capture — with their file names, their sizes and
 *     their export sets (two and eight);
 *   - **the loader**: the candidate paths, in the target's own order; the
 *     **cached attempt**, so a failure is not retried; and `null` — never an
 *     exception — when the addon is not there;
 *   - **the own-property guard**: an export is read only when the loaded object
 *     carries it as an **own** property;
 *   - **the clipboard surface**: the probe's five-way decision, the demotion of
 *     the addon after one failed write, and the status vocabulary;
 *   - **the audio surface**: the nine operations, the value the target's
 *     wrapper returns when the addon is absent, the microphone permission rule
 *     and the `/voice` option parsing;
 *   - **the honest boundary**: this implementation ships **no native addon**,
 *     so every operation that needs one **refuses** and names the capability it
 *     would need. Nothing pretends otherwise.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { nativeAddonFilesIn } from '../../scripts/build.js';
import {
  NATIVE_ADDON_IDS,
  NATIVE_ADDONS,
  createNativeAddonLoader,
  loadNativeAddon,
  nativeAddonCandidatePaths,
  nativeAddonExport,
  nativeAddonSpec,
  type NativeAddonExports,
} from '../../src/extensions/native/addons.js';
import {
  CLIPBOARD_TOOLS,
  clipboardToolStatus,
  createClipboardToolState,
  probeClipboardTool,
  readClipboardText,
  recordClipboardAddonWrite,
  writeClipboardText,
  type ClipboardEnvironment,
} from '../../src/extensions/native/clipboard.js';
import {
  MICROPHONE_ACCESS_DENIED,
  isNativeAudioAvailable,
  isNativePlaying,
  isNativeRecordingActive,
  microphoneAuthorizationStatus,
  parseVoiceMode,
  resolveMicrophonePermission,
  startNativePlayback,
  startNativeRecording,
  stopNativePlayback,
  stopNativeRecording,
  voiceModeRejection,
  writeNativePlaybackData,
} from '../../src/extensions/native/audio.js';

/* -------------------------------------------------------------------------- */
/* The helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** An environment where nothing is installed and no display exists. */
function bareEnvironment(overrides: Partial<ClipboardEnvironment> = {}): ClipboardEnvironment {
  return {
    platform: 'linux',
    display: undefined,
    waylandDisplay: undefined,
    hasCommand: () => false,
    addonAvailable: false,
    ...overrides,
  };
}

/** The addon exports a fake that carries the target's own names. */
function fakeAddon(): NativeAddonExports {
  return {
    setLinuxClipboardText: () => true,
    getLinuxClipboardText: async () => 'text',
  };
}

/* -------------------------------------------------------------------------- */
/* The packaging                                                               */
/* -------------------------------------------------------------------------- */

describe('the packaging', () => {
  it('names the native addon files a directory holds', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'prricode-native-'));
    try {
      expect([...nativeAddonFilesIn(directory)]).toEqual([]);
      writeFileSync(path.join(directory, 'clipboard-napi.node'), 'not a real addon');
      writeFileSync(path.join(directory, 'audio-capture.node'), 'not a real addon');
      writeFileSync(path.join(directory, 'prricode'), 'not a real executable');
      expect([...nativeAddonFilesIn(directory)].sort()).toEqual([
        'audio-capture.node',
        'clipboard-napi.node',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ships no native addon in this repository', () => {
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    expect([...nativeAddonFilesIn(repository)]).toEqual([]);
    expect(readdirSync(repository).some((entry) => entry.endsWith('.node'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The inventory                                                               */
/* -------------------------------------------------------------------------- */

describe('the native addon inventory', () => {
  it('names exactly the two addons the target ships', () => {
    expect([...NATIVE_ADDON_IDS]).toEqual(['clipboard-napi', 'audio-capture']);
  });

  it('carries the target file names and sizes', () => {
    expect(NATIVE_ADDONS['clipboard-napi'].fileName).toBe('clipboard-napi.node');
    expect(NATIVE_ADDONS['clipboard-napi'].size).toBe(1_072_864);
    expect(NATIVE_ADDONS['audio-capture'].fileName).toBe('audio-capture.node');
    expect(NATIVE_ADDONS['audio-capture'].size).toBe(492_368);
  });

  it('carries the clipboard addon own two exports', () => {
    expect([...NATIVE_ADDONS['clipboard-napi'].exports]).toEqual([
      'setLinuxClipboardText',
      'getLinuxClipboardText',
    ]);
  });

  it('carries the audio addon own eight exports, in the registration order', () => {
    expect([...NATIVE_ADDONS['audio-capture'].exports]).toEqual([
      'isPlaying',
      'isRecording',
      'stopPlayback',
      'startPlayback',
      'stopRecording',
      'startRecording',
      'writePlaybackData',
      'microphoneAuthorizationStatus',
    ]);
  });

  it('looks an addon up only when the key is an own property', () => {
    expect(nativeAddonSpec('clipboard-napi')?.id).toBe('clipboard-napi');
    expect(nativeAddonSpec('toString')).toBeUndefined();
    expect(nativeAddonSpec('constructor')).toBeUndefined();
    expect(nativeAddonSpec('nope')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The loader                                                                  */
/* -------------------------------------------------------------------------- */

describe('the native addon loader', () => {
  it('offers the packaged copy first and the vendored paths in the target order', () => {
    const paths = nativeAddonCandidatePaths('clipboard-napi', {
      bundleDir: '/opt/app',
      platform: 'linux',
    });
    expect(paths).toEqual([
      '/opt/app/clipboard-napi.node',
      './vendor/clipboard-napi/x64-linux/clipboard-napi.node',
      '../clipboard-napi/x64-linux/clipboard-napi.node',
      './vendor/clipboard-napi/x64-linux-musl/clipboard-napi.node',
      '../clipboard-napi/x64-linux-musl/clipboard-napi.node',
    ]);
  });

  it('offers the audio addon own paths, with the addon name in them', () => {
    const paths = nativeAddonCandidatePaths('audio-capture', {
      bundleDir: '/opt/app',
      platform: 'linux',
    });
    expect(paths).toEqual([
      '/opt/app/audio-capture.node',
      './vendor/audio-capture/x64-linux/audio-capture.node',
      '../audio-capture/x64-linux/audio-capture.node',
      './vendor/audio-capture/x64-linux-musl/audio-capture.node',
      '../audio-capture/x64-linux-musl/audio-capture.node',
    ]);
  });

  it('drops the musl variant away from linux, as the target does', () => {
    const paths = nativeAddonCandidatePaths('audio-capture', {
      bundleDir: '/opt/app',
      platform: 'darwin',
    });
    expect(paths).toEqual([
      '/opt/app/audio-capture.node',
      './vendor/audio-capture/x64-darwin/audio-capture.node',
      '../audio-capture/x64-darwin/audio-capture.node',
    ]);
  });

  it('returns null when the addon is not there, and never throws', () => {
    const loader = createNativeAddonLoader({
      bundleDir: '/nowhere',
      require: () => {
        throw new Error('MODULE_NOT_FOUND');
      },
    });
    expect(loader.load('clipboard-napi')).toBeNull();
  });

  it('caches the attempt, so a failure is not retried', () => {
    let attempts = 0;
    const loader = createNativeAddonLoader({
      bundleDir: '/nowhere',
      require: () => {
        attempts += 1;
        throw new Error('MODULE_NOT_FOUND');
      },
    });
    expect(loader.load('clipboard-napi')).toBeNull();
    // The one attempt walks every candidate: the packaged copy and the four
    // vendored paths.
    expect(attempts).toBe(5);
    expect(loader.load('clipboard-napi')).toBeNull();
    expect(attempts).toBe(5);
  });

  it('loads the addon from the first candidate that answers', () => {
    const seen: string[] = [];
    const loader = createNativeAddonLoader({
      bundleDir: '/opt/app',
      require: (specifier: string) => {
        seen.push(specifier);
        if (specifier !== '../clipboard-napi/x64-linux/clipboard-napi.node') {
          throw new Error('MODULE_NOT_FOUND');
        }
        return fakeAddon();
      },
    });
    expect(loader.load('clipboard-napi')).not.toBeNull();
    expect(seen).toEqual([
      '/opt/app/clipboard-napi.node',
      './vendor/clipboard-napi/x64-linux/clipboard-napi.node',
      '../clipboard-napi/x64-linux/clipboard-napi.node',
    ]);
  });

  it('answers null for an addon that does not exist', () => {
    const loader = createNativeAddonLoader({ require: () => fakeAddon() });
    expect(loader.load('not-an-addon')).toBeNull();
    expect(loader.candidates('not-an-addon')).toEqual([]);
  });

  it('finds no addon on this machine, because none is shipped', () => {
    expect(loadNativeAddon('clipboard-napi')).toBeNull();
    expect(loadNativeAddon('audio-capture')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The own-property guard                                                      */
/* -------------------------------------------------------------------------- */

describe('the own-property guard', () => {
  it('reads an export the loaded object owns', () => {
    const addon = fakeAddon();
    expect(nativeAddonExport(addon, 'setLinuxClipboardText')).toBe(addon['setLinuxClipboardText']);
  });

  it('refuses an export the object only inherits', () => {
    const inherited = Object.create({ setLinuxClipboardText: () => true }) as NativeAddonExports;
    expect(nativeAddonExport(inherited, 'setLinuxClipboardText')).toBeUndefined();
  });

  it('refuses an export the object does not carry', () => {
    expect(nativeAddonExport(fakeAddon(), 'microphoneAuthorizationStatus')).toBeUndefined();
    expect(nativeAddonExport(null, 'setLinuxClipboardText')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The clipboard surface                                                       */
/* -------------------------------------------------------------------------- */

describe('the clipboard probe', () => {
  it('names the tools in the target own order', () => {
    expect([...CLIPBOARD_TOOLS]).toEqual(['wl-copy', 'xclip', 'xsel', 'addon']);
  });

  it('prefers wl-copy when a wayland display and the command are there', async () => {
    const state = await probeClipboardTool(
      createClipboardToolState(),
      bareEnvironment({
        waylandDisplay: 'wayland-0',
        hasCommand: (command) => command === 'wl-copy',
      }),
    );
    expect(clipboardToolStatus(state, 'linux')).toBe('wl-copy');
  });

  it('prefers xclip over xsel, and needs a display for either', async () => {
    const withDisplay = bareEnvironment({
      display: ':0',
      hasCommand: (command) => command === 'xclip' || command === 'xsel',
    });
    const state = await probeClipboardTool(createClipboardToolState(), withDisplay);
    expect(clipboardToolStatus(state, 'linux')).toBe('xclip');

    const noDisplay = await probeClipboardTool(
      createClipboardToolState(),
      bareEnvironment({ hasCommand: (command) => command === 'xsel' }),
    );
    expect(clipboardToolStatus(noDisplay, 'linux')).toBe('none');
  });

  it('falls to the addon when the external tools are not there', async () => {
    const state = await probeClipboardTool(
      createClipboardToolState(),
      bareEnvironment({ display: ':0', addonAvailable: true }),
    );
    expect(clipboardToolStatus(state, 'linux')).toBe('addon');
  });

  it('reports none when the addon is not there either', async () => {
    const state = await probeClipboardTool(
      createClipboardToolState(),
      bareEnvironment({ display: ':0' }),
    );
    expect(clipboardToolStatus(state, 'linux')).toBe('none');
  });

  it('demotes the addon after one failed write', async () => {
    const environment = bareEnvironment({ display: ':0', addonAvailable: true });
    let state = await probeClipboardTool(createClipboardToolState(), environment);
    expect(clipboardToolStatus(state, 'linux')).toBe('addon');

    state = recordClipboardAddonWrite(state, false);
    state = await probeClipboardTool(state, environment);
    expect(clipboardToolStatus(state, 'linux')).toBe('none');
  });

  it('keeps the addon after a successful write', async () => {
    const environment = bareEnvironment({ display: ':0', addonAvailable: true });
    let state = await probeClipboardTool(createClipboardToolState(), environment);
    state = recordClipboardAddonWrite(state, true);
    state = await probeClipboardTool(state, environment);
    expect(clipboardToolStatus(state, 'linux')).toBe('addon');
  });

  it('does nothing on a platform that is not linux', async () => {
    const state = await probeClipboardTool(
      createClipboardToolState(),
      bareEnvironment({ platform: 'macos', display: ':0', addonAvailable: true }),
    );
    expect(clipboardToolStatus(state, 'macos')).toBe('not_linux');
  });

  it('reports the four statuses the target reports', () => {
    expect(clipboardToolStatus(createClipboardToolState(), 'macos')).toBe('not_linux');
    expect(clipboardToolStatus(createClipboardToolState(), 'linux')).toBe('not_probed');
    expect(
      clipboardToolStatus({ ...createClipboardToolState(), tool: null }, 'linux'),
    ).toBe('none');
    expect(
      clipboardToolStatus({ ...createClipboardToolState(), tool: 'xclip' }, 'linux'),
    ).toBe('xclip');
  });
});

/* -------------------------------------------------------------------------- */
/* The clipboard operations                                                    */
/* -------------------------------------------------------------------------- */

describe('the clipboard operations', () => {
  it('refuses the write and names the capability it would need', () => {
    const result = writeClipboardText('text');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the write must refuse');
    expect(result.capability).toBe('a native clipboard addon');
    expect(result.reason).toContain('native clipboard addon');
  });

  it('refuses the read and names the capability it would need', () => {
    const result = readClipboardText();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the read must refuse');
    expect(result.capability).toBe('a native clipboard addon');
  });
});

/* -------------------------------------------------------------------------- */
/* The audio surface                                                           */
/* -------------------------------------------------------------------------- */

describe('the audio surface', () => {
  it('reports that the native audio addon is not available', () => {
    expect(isNativeAudioAvailable()).toBe(false);
    expect(isNativeRecordingActive()).toBe(false);
    expect(isNativePlaying()).toBe(false);
  });

  it('returns the target own zero for the microphone authorization status', () => {
    // The target's wrapper returns 0 when the addon, or the export, is absent.
    expect(microphoneAuthorizationStatus()).toBe(0);
  });

  it('refuses every operation that needs the addon', () => {
    const recording = startNativeRecording(() => undefined, () => undefined);
    expect(recording.ok).toBe(false);

    const stopped = stopNativeRecording();
    expect(stopped.ok).toBe(false);

    const playback = startNativePlayback('/tmp/a.wav', {});
    expect(playback.ok).toBe(false);

    const playbackStopped = stopNativePlayback();
    expect(playbackStopped.ok).toBe(false);

    const written = writeNativePlaybackData(Buffer.from([0, 1]));
    expect(written.ok).toBe(false);
  });

  it('names the capability the recording refuses for', () => {
    const recording = startNativeRecording(() => undefined, () => undefined);
    if (recording.ok) throw new Error('the recording must refuse');
    expect(recording.capability).toBe('a native audio capture addon');
  });
});

/* -------------------------------------------------------------------------- */
/* The option parsing                                                          */
/* -------------------------------------------------------------------------- */

describe('the voice mode option parsing', () => {
  it('accepts the three modes the target accepts', () => {
    expect(parseVoiceMode('hold')).toBe('hold');
    expect(parseVoiceMode('tap')).toBe('tap');
    expect(parseVoiceMode('off')).toBe('off');
  });

  it('trims and lower-cases the argument', () => {
    expect(parseVoiceMode('  HOLD ')).toBe('hold');
    expect(parseVoiceMode('Tap')).toBe('tap');
  });

  it('reads an empty argument as no mode at all', () => {
    expect(parseVoiceMode('')).toBeUndefined();
    expect(parseVoiceMode('   ')).toBeUndefined();
  });

  it('rejects anything else', () => {
    expect(parseVoiceMode('push')).toBe('invalid');
    expect(parseVoiceMode('hold on')).toBe('invalid');
  });

  it('uses the target own rejection message', () => {
    expect(voiceModeRejection('  push ')).toBe('Unknown mode: "push". Use hold, tap, or off.');
  });
});

/* -------------------------------------------------------------------------- */
/* The permission rules                                                        */
/* -------------------------------------------------------------------------- */

describe('the microphone permission rule', () => {
  it('grants when there is no native microphone to authorize', () => {
    // The target's own rule: with no native addon there is no OS prompt to
    // raise, so the request is granted.
    const decision = resolveMicrophonePermission({
      nativeAudioAvailable: false,
      capturePathAvailable: true,
    });
    expect(decision.granted).toBe(true);
    expect(decision.reason).toBeNull();
  });

  it('grants when the native recording started', () => {
    const decision = resolveMicrophonePermission({
      nativeAudioAvailable: true,
      recordingStarted: true,
      capturePathAvailable: true,
    });
    expect(decision.granted).toBe(true);
    expect(decision.reason).toBeNull();
  });

  it('refuses when the native recording did not start', () => {
    const decision = resolveMicrophonePermission({
      nativeAudioAvailable: true,
      recordingStarted: false,
      capturePathAvailable: true,
    });
    expect(decision.granted).toBe(false);
    expect(decision.reason).toBe(MICROPHONE_ACCESS_DENIED);
  });

  it('refuses when there is no capture path at all', () => {
    const decision = resolveMicrophonePermission({
      nativeAudioAvailable: false,
      capturePathAvailable: false,
    });
    expect(decision.granted).toBe(false);
    expect(decision.reason).toContain('audio capture');
  });
});
