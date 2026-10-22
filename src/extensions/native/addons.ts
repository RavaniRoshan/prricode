/**
 * The **native addons** — the target's two `.node` addons, and the loader that
 * finds them.
 *
 * Evidence: the target's own source, read out of the pinned build and recorded in
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-native-addons.md` — every
 * claim there carries a file and a byte offset. The milestone is `CC-039` of
 * `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.
 *
 * ## What the target ships
 *
 * The target's payload holds **exactly two** native objects, and the extraction
 * manifest's own `kind` field says so: two entries of kind `ELF x86-64`, and
 * nothing else.
 *
 * | The addon | The file | The size | The exports |
 * |---|---|---|---|
 * | the clipboard | `clipboard-napi.node` | 1 072 864 B | **two** — `setLinuxClipboardText`, `getLinuxClipboardText` |
 * | the audio capture | `audio-capture.node` | 492 368 B | **eight** — `isPlaying`, `isRecording`, `stopPlayback`, `startPlayback`, `stopRecording`, `startRecording`, `writePlaybackData`, `microphoneAuthorizationStatus` |
 *
 * Both are **Rust `napi-rs` 2.16.17** addons: the clipboard one over
 * `wl-clipboard-rs` and `x11rb` (Wayland and X11), the audio one over ALSA
 * (`alsa`, `cpal`).
 *
 * ## How the target loads them
 *
 * The target loads each addon with a **lazy `import.meta.require`** of the file
 * beside the bundle, and falls back to **vendored per-architecture paths**:
 *
 * ```js
 * // chunk-v57qk004.js:653 — the clipboard loader
 * var JIo=C(function(L,H){H.exports=Ue((import.meta.dirname+"/./clipboard-napi.node"))});
 *
 * // chunk-yp10c36w.js:1994 — the clipboard loader's caller
 * function T(){
 *   if(w)return m;
 *   w=!0;                                   // the attempt is cached — a failure is NOT retried
 *   try{return m=JIo(),m}catch{}
 *   let e="x64-linux",o=[e,`${e}-musl`].flatMap(r=>[
 *       `./vendor/clipboard-napi/${r}/clipboard-napi.node`,
 *       `../clipboard-napi/${r}/clipboard-napi.node`]);
 *   for(let r of o)try{return m=Ue(r),m}catch{}
 *   return null
 * }
 * ```
 *
 * Two properties of that loader are reproduced here because the rest of the
 * surface depends on them:
 *
 *   - **the attempt is cached, including a failure.** The flag is set *before*
 *     the attempt, so a machine with no addon never retries the load;
 *   - **the loader never throws.** Every `require` is wrapped, and the loader
 *     answers `null` when nothing loads.
 *
 * ## The honest boundary
 *
 * **This implementation ships no native addon.** The target's npm package carries
 * the two `.node` files; this implementation's artifact carries none, and the
 * loader therefore answers `null` on every machine.
 *
 * The **shapes** are reproduced — the inventory, the candidate paths, the cached
 * attempt, the own-property guard on an export — and the operations that would
 * need an addon **refuse**, each naming the capability it would need. Nothing
 * pretends to be an addon, and nothing shells out to a clipboard or audio binary
 * to imitate one.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

/* -------------------------------------------------------------------------- */
/* The inventory                                                               */
/* -------------------------------------------------------------------------- */

/** The two native addons the target ships. */
export type NativeAddonId = 'clipboard-napi' | 'audio-capture';

/** The addons, in the target's own order. */
export const NATIVE_ADDON_IDS: readonly NativeAddonId[] = ['clipboard-napi', 'audio-capture'];

/**
 * What one native addon is.
 *
 * Every field is the target's own data: the file name it ships under, the size
 * of that file, the digest of that file, and the names its exports carry.
 */
export interface NativeAddonSpec {
  /** The addon's own name — the stem of the file it ships as. */
  readonly id: NativeAddonId;
  /** The file name the target ships it under. */
  readonly fileName: string;
  /** The size of the target's file, in bytes. */
  readonly size: number;
  /** The SHA-256 of the target's file. */
  readonly sha256: string;
  /** The JavaScript names the addon's exports carry. */
  readonly exports: readonly string[];
  /** The capability an operation needs when it is the addon's export that does the work. */
  readonly capability: string;
}

/**
 * The two addons.
 *
 * The export lists are the target's own, read out of each addon's registration
 * code — the clipboard addon's two names out of its `.rodata`, the audio addon's
 * eight in the order its module registers them.
 */
export const NATIVE_ADDONS: Readonly<Record<NativeAddonId, NativeAddonSpec>> = Object.freeze({
  'clipboard-napi': Object.freeze({
    id: 'clipboard-napi',
    fileName: 'clipboard-napi.node',
    size: 1_072_864,
    sha256: '4881da9229654a04bdec176cb70c818b872dd6bc74aaa881f021dbe20cdcbea7',
    exports: Object.freeze(['setLinuxClipboardText', 'getLinuxClipboardText']),
    capability: 'a native clipboard addon',
  }),
  'audio-capture': Object.freeze({
    id: 'audio-capture',
    fileName: 'audio-capture.node',
    size: 492_368,
    sha256: '4bf312cbbc81f577d5ed0bcdcba803bfaa219c05ac4a1cca729ec81628561e88',
    exports: Object.freeze([
      'isPlaying',
      'isRecording',
      'stopPlayback',
      'startPlayback',
      'stopRecording',
      'startRecording',
      'writePlaybackData',
      'microphoneAuthorizationStatus',
    ]),
    capability: 'a native audio capture addon',
  }),
});

/**
 * Look an addon up.
 *
 * The lookup is **own-property guarded**: a key that the record inherits — the
 * prototype's `toString`, say — is not an addon, and a caller that supplied one
 * must not be handed the prototype's member in its place.
 *
 * @param id the addon the caller asked for.
 * @returns the addon's specification, or `undefined` when there is no such addon.
 */
export function nativeAddonSpec(id: string): NativeAddonSpec | undefined {
  if (!Object.hasOwn(NATIVE_ADDONS, id)) return undefined;
  return NATIVE_ADDONS[id as NativeAddonId];
}

/* -------------------------------------------------------------------------- */
/* The loader                                                                  */
/* -------------------------------------------------------------------------- */

/** What a loaded addon carries. */
export type NativeAddonExports = Record<string, unknown>;

/** The `require` the loader calls. */
export type NativeAddonRequire = (specifier: string) => unknown;

/** The options a loader runs with. */
export interface NativeAddonLoaderOptions {
  /**
   * The directory the packaged addon would sit in.
   *
   * The target's own value is the directory of the bundle it ships in
   * (`import.meta.dirname`). It defaults to the directory of this module.
   */
  readonly bundleDir?: string;
  /**
   * The directory the **relative** candidate paths resolve against.
   *
   * The target's relative paths — `./vendor/…` and `../…` — resolve against the
   * process's working directory. It defaults to the process's working directory.
   */
  readonly workingDirectory?: string;
  /** The platform the candidate paths are built for. */
  readonly platform?: string;
  /** The loader itself. It defaults to Node's `require`. */
  readonly require?: NativeAddonRequire;
}

/** The loader's own interface. */
export interface NativeAddonLoader {
  /**
   * The paths the loader would try, in the target's own order.
   *
   * @param id the addon the caller asked for.
   * @returns the candidate paths; an empty list when there is no such addon.
   */
  candidates(id: string): readonly string[];
  /**
   * Load an addon.
   *
   * The attempt is **cached**, including a failure, and the loader never
   * throws: it answers `null` when the addon is not there.
   *
   * @param id the addon the caller asked for.
   * @returns the addon's exports, or `null`.
   */
  load(id: string): NativeAddonExports | null;
}

/**
 * The architecture variants a candidate path is built for.
 *
 * The target's rule: the architecture is `x64-` and the platform, and the
 * **`-musl`** variant is added **only on Linux** — the pair is `[arch,
 * arch-musl]` there and `[arch]` everywhere else.
 */
export function nativeAddonArchVariants(platform: string): readonly string[] {
  const arch = `x64-${platform}`;
  return platform === 'linux' ? [arch, `${arch}-musl`] : [arch];
}

/**
 * The candidate paths for one addon, in the target's own order.
 *
 * The packaged copy comes first, and then the vendored paths: the architecture
 * pair is flattened, and each architecture yields the `vendor/` root and then the
 * `../` root.
 */
export function nativeAddonCandidatePaths(
  id: string,
  options: { readonly bundleDir?: string; readonly platform?: string } = {},
): string[] {
  const spec = nativeAddonSpec(id);
  if (spec === undefined) return [];

  const bundleDir = options.bundleDir ?? import.meta.dirname;
  const platform = options.platform ?? process.platform;

  const candidates: string[] = [path.join(bundleDir, spec.fileName)];
  for (const arch of nativeAddonArchVariants(platform)) {
    candidates.push(`./vendor/${spec.id}/${arch}/${spec.fileName}`);
    candidates.push(`../${spec.id}/${arch}/${spec.fileName}`);
  }
  return candidates;
}

/**
 * Create a loader.
 *
 * The loader holds the **cached attempt**, exactly as the target's loader does:
 * the flag is set before the attempt, so a machine with no addon never retries.
 *
 * @param options the loader runs with.
 * @returns the loader.
 */
export function createNativeAddonLoader(
  options: NativeAddonLoaderOptions = {},
): NativeAddonLoader {
  const bundleDir = options.bundleDir ?? import.meta.dirname;
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const platform = options.platform ?? process.platform;

  /**
   * What each load attempt answered, keyed by the addon.
   *
   * The target caches the **whole attempt**, not each candidate: the flag is set
   * before the first `require`, so a machine with no addon never tries again.
   */
  const cache = new Map<string, NativeAddonExports | null>();

  /**
   * The `require` a root resolves against.
   *
   * The packaged candidate is absolute; the vendored ones are relative, and the
   * target resolves those against the process's working directory.
   */
  const requireFrom = (root: string): NativeAddonRequire => {
    const require = createRequire(path.join(root, 'native-addon.js'));
    return (specifier: string) => require(specifier);
  };

  const bundleRequire = options.require ?? requireFrom(bundleDir);
  const workingRequire = options.require ?? requireFrom(workingDirectory);

  return {
    candidates(id: string): readonly string[] {
      return nativeAddonCandidatePaths(id, { bundleDir, platform });
    },
    load(id: string): NativeAddonExports | null {
      const spec = nativeAddonSpec(id);
      if (spec === undefined) return null;

      const cached = cache.get(id);
      if (cached !== undefined) return cached;

      const candidates = this.candidates(id);
      for (const candidate of candidates) {
        const require = path.isAbsolute(candidate) ? bundleRequire : workingRequire;
        let loaded: unknown;
        try {
          loaded = require(candidate);
        } catch {
          continue;
        }
        if (typeof loaded !== 'object' || loaded === null) continue;
        const exports = loaded as NativeAddonExports;
        cache.set(id, exports);
        return exports;
      }
      cache.set(id, null);
      return null;
    },
  };
}

/**
 * The default loader — the one the process uses.
 *
 * It is created once, so the **cached attempt** holds for the life of the
 * process, exactly as the target's module-level loader flag does.
 */
let defaultLoader: NativeAddonLoader | undefined;

/**
 * The process's loader.
 *
 * @returns the loader.
 */
export function nativeAddonLoader(): NativeAddonLoader {
  defaultLoader ??= createNativeAddonLoader();
  return defaultLoader;
}

/**
 * Load an addon with the process's loader.
 *
 * @param id the addon the caller asked for.
 * @returns the addon's exports, or `null` when the addon is not there.
 */
export function loadNativeAddon(id: string): NativeAddonExports | null {
  return nativeAddonLoader().load(id);
}

/**
 * Read one export off a loaded addon.
 *
 * The guard is the **own-property** one: an export the loaded object only
 * inherits is not the addon's export, and a caller that asked for it must be
 * told that it is not there rather than handed the prototype's member.
 *
 * @param addon the loaded addon.
 * @param name the export's name.
 * @returns the export, or `undefined` when the addon does not own it.
 */
export function nativeAddonExport(
  addon: NativeAddonExports | null | undefined,
  name: string,
): unknown {
  if (addon === null || addon === undefined) return undefined;
  if (typeof addon !== 'object') return undefined;
  if (!Object.hasOwn(addon, name)) return undefined;
  return addon[name];
}

/* -------------------------------------------------------------------------- */
/* The refusal                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The answer an operation gives when it cannot run.
 *
 * The refusal is a **return value**, not an exception, and it names the
 * capability the operation would have needed.
 */
export interface NativeAddonRefusal {
  /** The operation did not run. */
  readonly ok: false;
  /** The addon the operation would have used. */
  readonly addon: NativeAddonId;
  /** The operation that was refused. */
  readonly operation: string;
  /** The capability the operation would have needed. */
  readonly capability: string;
  /** Why the operation was refused. */
  readonly reason: string;
}

/** The answer an operation gives: a value, or a refusal. */
export type NativeAddonResult<T> =
  | { readonly ok: true; readonly value: T }
  | NativeAddonRefusal;

/**
 * Refuse an operation that would need a native addon.
 *
 * @param addon the addon the operation would have used.
 * @param operation what the operation was.
 * @param options the capability the operation needed, and the reason it is
 *   refused — both default to the addon's own capability and to the standard
 *   refusal for an addon this implementation does not ship.
 * @returns the refusal.
 */
export function refuseNativeAddon(
  id: NativeAddonId,
  operation: string,
  options: { readonly capability?: string; readonly reason?: string } = {},
): NativeAddonRefusal {
  const spec = NATIVE_ADDONS[id];
  const capability = options.capability ?? spec.capability;
  const reason =
    options.reason ??
    `the ${operation} needs ${capability}; this implementation ships no native ` +
      'addon, so it refuses.';
  return {
    ok: false,
    addon: id,
    operation,
    capability,
    reason,
  };
}
