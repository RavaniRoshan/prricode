/**
 * Choosing a model.
 *
 * The grammar is `provider/model#overlay`. The explicit form — a provider, a
 * model and an overlay, given separately — is for configuration, where the
 * parts are named rather than written into a string.
 *
 * The precedence, in order:
 *
 * 1. the model remembered **for this location and this agent**;
 * 2. the **agent's** own model;
 * 3. the model named on the command line;
 * 4. the **configured** model;
 * 5. the **last used**;
 * 6. the **first available**.
 *
 * **There is no cross-provider fallback.** A model that has become unavailable
 * **fails loudly**: a run that quietly used a different model than the one
 * that was asked for is a different run, and the report would be a lie.
 *
 * See [`docs/protocol/MODEL-LAYER.md`](../../docs/protocol/MODEL-LAYER.md) §7
 * and §8.
 */

import { DEFAULT_OVERLAY_NAME, findOverlay } from './overlays.js';
import type { Modality, ModelEntry } from './types.js';

/** A model, named. */
export interface ModelRef {
  readonly provider: string;
  readonly model: string;
  /** The overlay to apply, if any. */
  readonly overlay?: string;
}

/**
 * Read the grammar.
 *
 * The first `/` separates the provider from the model, and the first `#`
 * after it separates the overlay. A reference that is not one is refused, and
 * the refusal says what the form is.
 */
export function parseModelRef(text: string): ModelRef | undefined {
  if (typeof text !== 'string' || text === '') return undefined;
  const hash = text.indexOf('#');
  if (hash !== -1 && hash === 0) return undefined;
  const head = hash === -1 ? text : text.slice(0, hash);
  const overlay = hash === -1 ? undefined : text.slice(hash + 1);
  const slash = head.indexOf('/');
  if (slash <= 0) return undefined;
  const provider = head.slice(0, slash);
  const model = head.slice(slash + 1);
  if (provider === '' || model === '') return undefined;
  if (overlay !== undefined && overlay === '') return undefined;
  return overlay === undefined ? { provider, model } : { provider, model, overlay };
}

/** Write the grammar back. */
export function formatModelRef(ref: ModelRef): string {
  const base = `${ref.provider}/${ref.model}`;
  return ref.overlay === undefined ? base : `${base}#${ref.overlay}`;
}

/** What a model must be able to do to be selected. */
export interface ModelRequirements {
  /** The modalities the model must take. */
  readonly input?: readonly Modality[];
  /** The modalities the model must produce. */
  readonly output?: readonly Modality[];
  /** Whether the model must call tools. */
  readonly tools?: boolean;
  /** Whether the model must take a temperature. */
  readonly temperature?: boolean;
  /** The effort the model must offer. */
  readonly effort?: string;
}

/** Whether a model meets a set of requirements. */
export function modelSatisfies(model: ModelEntry, requirements: ModelRequirements): boolean {
  if (requirements.tools !== undefined && model.capabilities.tools !== requirements.tools) {
    return false;
  }
  if (requirements.temperature !== undefined) {
    if (model.capabilities.temperature !== requirements.temperature) return false;
  }
  if (requirements.input) {
    for (const modality of requirements.input) {
      if (!model.capabilities.input.includes(modality)) return false;
    }
  }
  if (requirements.output) {
    for (const modality of requirements.output) {
      if (!model.capabilities.output.includes(modality)) return false;
    }
  }
  if (requirements.effort !== undefined) {
    const support = model.reasoning.effort;
    if (!support || !support.values.includes(requirements.effort)) return false;
  }
  return true;
}

/** Whether a model can hold text — in and out. */
export function canHoldText(model: ModelEntry): boolean {
  return model.capabilities.input.includes('text') && model.capabilities.output.includes('text');
}

/** Where a selection came from. */
export type SelectionSource =
  | 'remembered'
  | 'agent'
  | 'command-line'
  | 'configured'
  | 'last-used'
  | 'first-available';

/** The sources, in the order they are consulted. */
const PRECEDENCE: readonly { key: keyof SelectionSources; source: SelectionSource }[] = [
  { key: 'remembered', source: 'remembered' },
  { key: 'agent', source: 'agent' },
  { key: 'commandLine', source: 'command-line' },
  { key: 'configured', source: 'configured' },
  { key: 'lastUsed', source: 'last-used' },
];

/** The sources a selection is made from. */
export interface SelectionSources {
  /** The model remembered for this location and this agent. */
  readonly remembered?: string | ModelRef;
  /** The agent's own model. */
  readonly agent?: string | ModelRef;
  /** The model named on the command line. */
  readonly commandLine?: string | ModelRef;
  /** The configured model. */
  readonly configured?: string | ModelRef;
  /** The last used model. */
  readonly lastUsed?: string | ModelRef;
}

/** How a selection is made. */
export interface SelectionOptions {
  /** The sources. */
  readonly sources: SelectionSources;
  /** The models that are available. */
  readonly available: readonly ModelEntry[];
  /** What the model must be able to do. */
  readonly requirements?: ModelRequirements;
}

/** The outcome of a selection. */
export type SelectionResult =
  | { readonly ok: true; readonly ref: ModelRef; readonly source: SelectionSource }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly attempted?: ModelRef;
      readonly source?: SelectionSource;
    };

/**
 * Choose a model.
 *
 * The first source that names a model decides — and if that model is not
 * available, the selection **fails loudly**. The chain never continues past a
 * source that named a model: falling back would be a silent substitution.
 */
export function selectModel(options: SelectionOptions): SelectionResult {
  const { sources, available, requirements } = options;

  for (const { key, source } of PRECEDENCE) {
    const raw = sources[key];
    if (raw === undefined) continue;

    const ref = typeof raw === 'string' ? parseModelRef(raw) : raw;
    if (!ref) {
      return {
        ok: false,
        reason: `"${String(raw)}" is not a model reference; the form is provider/model#overlay`,
        source,
      };
    }

    const model = available.find(
      (entry) => entry.provider === ref.provider && entry.id === ref.model && entry.enabled,
    );
    if (!model) {
      return {
        ok: false,
        reason: `the model "${ref.provider}/${ref.model}" is not available`,
        attempted: ref,
        source,
      };
    }

    if (ref.overlay !== undefined && ref.overlay !== DEFAULT_OVERLAY_NAME) {
      if (!findOverlay(model, ref.overlay)) {
        return {
          ok: false,
          reason: `the model "${ref.provider}/${ref.model}" offers no overlay named "${ref.overlay}"`,
          attempted: ref,
          source,
        };
      }
    }

    if (requirements && !modelSatisfies(model, requirements)) {
      return {
        ok: false,
        reason: `the model "${ref.provider}/${ref.model}" does not meet the requirements`,
        attempted: ref,
        source,
      };
    }

    return { ok: true, ref, source };
  }

  const fallback = available.find(
    (entry) =>
      entry.enabled && canHoldText(entry) && (!requirements || modelSatisfies(entry, requirements)),
  );
  if (!fallback) {
    return { ok: false, reason: 'no available model can hold text' };
  }
  return {
    ok: true,
    ref: { provider: fallback.provider, model: fallback.id },
    source: 'first-available',
  };
}
