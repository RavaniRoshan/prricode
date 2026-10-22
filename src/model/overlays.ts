/**
 * The overlays — where the effort lives.
 *
 * **The reasoning effort is not a number.** It is one of a family of named
 * overlays, and the same mechanism carries all of them: an effort, a thinking
 * toggle, a token budget, and any overlay the user defines.
 *
 * The engine applies an overlay and **knows no vendor's spelling**. The
 * spelling belongs to the catalogue — to the model *and* the shape together —
 * so the overlays are re-spelled whenever the effective shape changes. A rule
 * in this repository that asked what a particular model id contains would be a
 * rule that is wrong for the next model.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §4.
 */

import type { Dialect, ModelEntry, Overlay, OverlaySpelling } from './types.js';

/**
 * The pseudo-overlay that means **no overlay at all**.
 *
 * There is no "default effort" as a user-visible thing: selecting this means
 * the remote's own default, which is the only default that is always right.
 */
export const DEFAULT_OVERLAY_NAME = 'default';

/** The three channels an overlay contributes to. */
export interface OverlayTarget {
  /** The request's top-level parameters. */
  readonly fields: Record<string, unknown>;
  /** The request's headers. */
  readonly headers: Record<string, string>;
  /** The request's body. */
  readonly body: Record<string, unknown>;
}

/** An empty target: nothing contributed yet. */
export function emptyOverlayTarget(): OverlayTarget {
  return { fields: {}, headers: {}, body: {} };
}

/** The overlay a model offers under a name, if it offers one. */
export function findOverlay(model: ModelEntry, name: string): Overlay | undefined {
  return model.overlays.find((overlay) => overlay.name === name);
}

/** The names of the overlays a model offers on a shape. */
export function overlayNames(model: ModelEntry, dialect: Dialect): readonly string[] {
  return model.overlays
    .filter((overlay) => overlay.spellings[dialect] !== undefined)
    .map((overlay) => overlay.name);
}

/** The outcome of resolving an overlay. */
export type OverlayResolution =
  | {
      readonly ok: true;
      /** The overlay, or `undefined` for the pseudo-overlay `default`. */
      readonly overlay: Overlay | undefined;
      /** The spelling for the effective shape. */
      readonly spelling: OverlaySpelling;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve an overlay by name, for one shape.
 *
 * The resolution refuses, with a reason, when the model does not offer the
 * overlay, when the overlay is not spelled for the effective shape, or when the
 * model does not declare the support kind the overlay belongs to. A capability
 * the model does not have is **enforced**, not ignored.
 */
export function resolveOverlay(
  model: ModelEntry,
  dialect: Dialect,
  name: string,
): OverlayResolution {
  if (name === DEFAULT_OVERLAY_NAME) {
    // The pseudo-overlay means *no overlay at all*: the remote's own default.
    return { ok: true, overlay: undefined, spelling: {} };
  }

  const overlay = findOverlay(model, name);
  if (!overlay) {
    return {
      ok: false,
      reason: `the model "${model.provider}/${model.id}" offers no overlay named "${name}"`,
    };
  }

  const spelling = overlay.spellings[dialect];
  if (spelling === undefined) {
    return {
      ok: false,
      reason:
        `the overlay "${name}" of the model "${model.provider}/${model.id}" is not ` +
        `spelled for the ${dialect} shape`,
    };
  }

  const refusal = refuseUnsupportedKind(model, overlay);
  if (refusal) return { ok: false, reason: refusal };

  return { ok: true, overlay, spelling };
}

/**
 * The refusal a support kind earns, when the model does not declare it.
 *
 * The kinds are the engine's own vocabulary — an effort is a named level, a
 * toggle is on or off, a budget is a token count — and the *values* come from
 * the catalogue. Nothing here knows how any endpoint spells them.
 */
function refuseUnsupportedKind(model: ModelEntry, overlay: Overlay): string | undefined {
  const where = `the model "${model.provider}/${model.id}"`;
  switch (overlay.kind) {
    case 'effort': {
      const support = model.reasoning.effort;
      if (!support) {
        return `${where} does not offer a reasoning effort, so the effort "${overlay.effort}" is not available`;
      }
      if (!support.values.includes(overlay.effort)) {
        return (
          `${where} does not offer the effort "${overlay.effort}"; ` +
          `it offers ${support.values.join(', ')}`
        );
      }
      return undefined;
    }
    case 'toggle': {
      if (!model.reasoning.toggle) {
        return `${where} does not offer a thinking toggle`;
      }
      return undefined;
    }
    case 'budget_tokens': {
      const support = model.reasoning.budget;
      if (!support) {
        return `${where} does not offer a token budget`;
      }
      if (support.min !== undefined && overlay.tokens < support.min) {
        return (
          `the token budget "${overlay.name}" is below the ${support.min} tokens ` +
          `the model "${model.provider}/${model.id}" accepts`
        );
      }
      if (support.max !== undefined && overlay.tokens > support.max) {
        return (
          `the token budget "${overlay.name}" is above the ${support.max} tokens ` +
          `the model "${model.provider}/${model.id}" accepts`
        );
      }
      return undefined;
    }
    case 'named':
      // A named overlay is the user's own; the model needs to declare nothing.
      return undefined;
    default: {
      const unknown: never = overlay;
      throw new Error(`unknown overlay kind: ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Apply a resolved overlay to a target.
 *
 * The merge order is the dialect's own body, then the overlay's **body**, then
 * the overlay's **fields** — so the overlay's own parameters win over the
 * fragment it brings, and both win over the shape's defaults. The headers are
 * merged over the shape's own.
 */
export function applyOverlay(target: OverlayTarget, resolution: OverlayResolution): OverlayTarget {
  if (!resolution.ok) {
    throw new Error(resolution.reason);
  }
  const { spelling } = resolution;
  if (spelling.body) mergeInto(target.body, spelling.body);
  if (spelling.fields) mergeInto(target.fields, spelling.fields);
  if (spelling.headers) Object.assign(target.headers, spelling.headers);
  return target;
}

/**
 * Merge one level of a plain object.
 *
 * A nested plain object is merged; every other value replaces what was there.
 * The overlay's own spelling is data, and a nested object it brings is a
 * fragment the shape's body is missing, not a whole replacement of it.
 */
function mergeInto(target: Record<string, unknown>, source: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      mergeInto(existing, value);
      continue;
    }
    target[key] = value;
  }
}

/** Whether a value is a plain object — not `null`, and not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A model with one more overlay.
 *
 * The catalogue's own entry is **not** written back: an overlay the user
 * defines is added to a copy, so the committed catalogue stays as it was.
 */
export function withOverlay(model: ModelEntry, overlay: Overlay): ModelEntry {
  return { ...model, overlays: [...model.overlays, overlay] };
}
