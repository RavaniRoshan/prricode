/**
 * The product — **an idea in, a verified product out**.
 *
 * **The concept:** `docs/DIVERGENCE-LAYER-2.md` §4 — the Product Builder
 * pipeline, and the purpose it states plainly: "**turning an idea into a
 * verified, shippable product**".
 *
 * **The conformance document:**
 * [`docs/compatibility/product-surface.md`](../docs/compatibility/product-surface.md).
 *
 * **One responsibility:** the barrel. Every module of the product is
 * re-exported here, so that an importer of `product/index.js` sees the whole
 * surface and not a part of it.
 *
 * ## The modules
 *
 * | module | what it owns |
 * |---|---|
 * | `product.ts` | the run: the wiring, the eight documents, the verdict |
 * | `model.ts` | the model seam — the model layer's engine as the pipeline's backend |
 * | `approvals.ts` | the approval seam — the decision point as the pipeline's backend |
 * | `workspace.ts` | the directory the product is written into, and the paths it writes at |
 * | `testrun.ts` | the product's own test run |
 * | `verification.ts` | the criteria, really checked, and compared with what the run claimed |
 * | `command.ts` | the command: the report, and the exit code |
 *
 * **The naming rule applies.** The product names the capabilities — a model, an
 * approval, a release — and no product and no company is named anywhere in
 * this layer.
 */

export {
  runProduct,
  type ProductApprovalOptions,
  type ProductDocument,
  type ProductModelOptions,
  type ProductOptions,
  type ProductResult,
} from './product.js';

export {
  approvalAnswerer,
  approvalBackend,
  type ApprovalBackendOptions,
} from './approvals.js';

export { modelBackend, type ModelBackendOptions } from './model.js';

export {
  ProductWorkspace,
  WorkspacePathError,
  resolveInRoot,
} from './workspace.js';

export {
  DEFAULT_TEST_TIMEOUT_MS,
  nodeTestRunner,
  type NodeTestRunnerOptions,
  type ProductTestFileResult,
  type ProductTestRun,
  type ProductTestRunner,
} from './testrun.js';

export {
  executeVerification,
  isTestPath,
  type ClaimedCheck,
  type ExecutedCheck,
  type ExecuteVerificationOptions,
  type ProductArtefact,
  type ProductVerification,
  type VerificationComparison,
} from './verification.js';

export {
  formatProductReport,
  runProductCommand,
  type ProductCommandIo,
  type ProductCommandOptions,
} from './command.js';
