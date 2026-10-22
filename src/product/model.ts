/**
 * The model seam — **the model layer's engine, as the pipeline's backend**.
 *
 * **The concept:** `docs/DIVERGENCE-LAYER-2.md` §3 — "the model backend: any
 * OpenAI-compatible backend — the backend's absence is reported, not worked
 * around".
 *
 * **One responsibility:** the one method the pipeline's stages ask, and the
 * translation of the model layer's turn into that method's answer.
 *
 * ## The rule this module exists to keep
 *
 * > **The stages' generative work goes through the model layer's engine — one
 * > method, so a backend plugs in without touching a stage.**
 *
 * The pipeline's seam is one method — `complete(request)` — and it is the
 * **stage's** contract, not ours. So this module does not teach a stage how to
 * reach a model: it teaches the **engine** how to answer the seam. A stage
 * that asks for a document is unchanged whether the answer came from the
 * engine, from another backend, or from a test double.
 *
 * ## What a failure is
 *
 * The model layer **never fakes success**: a turn either produces events, or
 * it fails with a reason that says which thing was missing. That reason is
 * carried through unchanged — a stage that is refused for a model that is not
 * connected says *that*, and not "the model failed".
 *
 * An answer with **no text** is a failure too. A stage that parses the
 * answer would refuse it, but it would refuse it as an unreadable document;
 * the truth is that the model said nothing, and the seam says so.
 */

import { ModelLayerError, type ModelEngine, type ModelRef } from '../model/index.js';
import {
  StageSeamRefusal,
  type StageModelBackend,
  type StageModelRequest,
} from '../pipeline/index.js';

/** How the model backend is built. */
export interface ModelBackendOptions {
  /** The model layer's engine — the one code path that speaks a provider. */
  readonly engine: ModelEngine;
  /** The model the stages' work runs against. */
  readonly selection: ModelRef;
  /** The signal that aborts the turn, when the caller has one. */
  readonly signal?: AbortSignal;
}

/** The name of a model, as the product reports it. */
function modelName(selection: ModelRef): string {
  return `${selection.provider}/${selection.model}`;
}

/**
 * The model layer's engine, as the pipeline's backend.
 *
 * The turn is the model layer's own: the same `run(selection, request)` every
 * other caller uses, with one message — the stage's instruction. The answer is
 * the text the model produced, and nothing else: a tool call the model made is
 * not a document a stage can read, and it is not read as one.
 */
export function modelBackend(options: ModelBackendOptions): StageModelBackend {
  const { engine, selection } = options;

  return {
    async complete(request: StageModelRequest): Promise<{ readonly text: string }> {
      let text = '';
      try {
        const turn = engine.run(selection, {
          messages: [{ role: 'user', content: request.prompt }],
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        for await (const event of turn) {
          if (event.type === 'text') text += event.text;
        }
      } catch (error) {
        if (error instanceof ModelLayerError) {
          // The model layer's reason says which thing was missing, and it is
          // carried through unchanged.
          throw new StageSeamRefusal(error.reason);
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new StageSeamRefusal(`the model backend failed: ${detail}`);
      }

      if (text.trim().length === 0) {
        throw new StageSeamRefusal(
          `the model "${modelName(selection)}" answered the "${request.stageId}" stage with no text`,
        );
      }

      return { text };
    },
  };
}
