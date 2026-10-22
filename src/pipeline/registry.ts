/**
 * The registry — the three deliveries of a stage.
 *
 * **The concept:** `docs/DIVERGENCE-LAYER-2.md` §6 — "**How a stage plugs in.**
 * One interface, three deliveries. A stage may be in-process, a package, or a
 * process speaking our protocol over stdio, and the pipeline does not know the
 * difference."
 *
 * **The specification:** `docs/protocol/PROTOCOL.md` §8.
 *
 * **One responsibility:** turning the three ways a stage arrives into the one
 * thing the pipeline holds — a `PipelineStage`.
 *
 * | the delivery | what it is | how it is loaded |
 * |---|---|---|
 * | **in-process** | an object registered through the typed interface | `registerStage` |
 * | **a package** | a module the agent loads, which exports a stage | `loadPackageStage` |
 * | **a process** | a program speaking our protocol over stdio, answering `tool/call` | `createProcessStage` |
 *
 * ## The package's contract
 *
 * A package is a **module**, and the loader looks for the stage in three
 * places, in this order: a `createStage` export, a `stage` export, and a
 * default export. The export may be the stage itself or a **factory** that
 * builds it.
 *
 * The loader does not care what the package is written in, and the package
 * does not have to import anything of ours: a stage is an **interface**, and
 * the interface is the contract.
 *
 * ## What a load that fails says
 *
 * A package that exports no stage, or a stage that is not a stage, is refused
 * **with a reason**. It is never registered as if it had worked, and the
 * pipeline never runs a stage it does not have.
 */

import {
  isPipelineStage,
  type PipelineStage,
  type StageRegistration,
} from './stage.js';

export { createProcessStage } from './process.js';
export type { StageDelivery, StageRegistration } from './stage.js';

/* -------------------------------------------------------------------------- */
/* The failure                                                                 */
/* -------------------------------------------------------------------------- */

/** A stage that could not be loaded. */
export class StageLoadError extends Error {
  /** The sentence that says why. */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'StageLoadError';
    this.reason = reason.trim();
  }
}

/* -------------------------------------------------------------------------- */
/* The in-process delivery                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Register a stage that is already in this process.
 *
 * This is the typed interface: the stage is an object of this repository's own
 * type, and it is handed to the pipeline as it is.
 */
export function registerStage(stage: PipelineStage): StageRegistration {
  if (!isPipelineStage(stage)) {
    throw new StageLoadError('the stage is not a stage: a stage has an id and a run method');
  }
  return { id: stage.id, delivery: 'in-process', stage };
}

/* -------------------------------------------------------------------------- */
/* The package delivery                                                        */
/* -------------------------------------------------------------------------- */

/** A package's exports. */
export interface StagePackageModule {
  /** The well-known export names, and anything else the package carries. */
  readonly [name: string]: unknown;
}

/** The export names a package may carry its stage in, in the order they are looked for. */
const PACKAGE_EXPORTS = ['createStage', 'stage', 'default'] as const;

/**
 * Load a stage from a package.
 *
 * The source is either a **module** — already imported, or the namespace a
 * dynamic import returned — or a **specifier** the loader imports itself.
 */
export async function loadPackageStage(
  source: string | StagePackageModule,
): Promise<StageRegistration> {
  const module: StagePackageModule =
    typeof source === 'string' ? ((await import(source)) as StagePackageModule) : source;

  const exported = pickStageExport(module);
  if (exported === undefined) {
    throw new StageLoadError(
      'the package exports no stage: it needs a "createStage" export, a "stage" export or a default export',
    );
  }

  const built = typeof exported === 'function' ? (exported as () => unknown)() : exported;
  if (!isPipelineStage(built)) {
    throw new StageLoadError(
      'the package does not export a stage: a stage has an id and a run method',
    );
  }

  return { id: built.id, delivery: 'package', stage: built };
}

/**
 * The export a package carries its stage in.
 *
 * The lookup is of a **caller-supplied key** in a plain object — a module's
 * namespace is a plain object — so it is guarded.
 */
function pickStageExport(module: StagePackageModule): unknown {
  for (const name of PACKAGE_EXPORTS) {
    if (!Object.hasOwn(module, name)) continue;
    const value = module[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* The process delivery                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Register a stage served by a process.
 *
 * The process speaks our protocol over stdio and answers `tool/call`; the
 * adapter turns the answer into the same outcome an in-process stage returns,
 * so the pipeline cannot tell the two apart. The implementation lives in
 * `process.ts`; it is re-exported here so that the registry is the one place
 * a deployment reaches for.
 */
