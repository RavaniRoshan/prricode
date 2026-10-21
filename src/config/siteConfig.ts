/**
 * The **site-configuration bundle**: the default bundle the target ships, and the
 * resolution of the auto-mode severity thresholds out of it.
 *
 * Evidence: `chunk-f27ph7ed.js:260401` (the bundle literal), `:260867` (how the bundle
 * is obtained), and `chunk-4jsg44k7.js:1646058`, `:1646178`, `:1646348`, `:1647108`
 * (the resolution). The record is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` §1.
 *
 * ## Why this module exists
 *
 * The target ships a **default bundle** of site configuration. The compatibility report
 * recorded, as a difference, that this implementation shipped **no such bundle at all** —
 * and the report's row was claiming the opposite, which is how the gap was found. So the
 * bundle is here, with the target's own data.
 *
 * The bundle carries ten members. Eight of them are the site configuration the target
 * reads as **booleans** or a **number**:
 *
 * | Member | Value |
 * |---|---|
 * | `twoStageClassifier` | `true` |
 * | `sameTurnSiblingContext` | `true` |
 * | `editRemovalVisibility` | `true` |
 * | `editRemovalCap` | `3000` |
 * | `outcomeVisibility` | `false` |
 * | `repoVisibility` | `true` |
 * | `gitStatusType` | `true` |
 * | `gitStatusUploads` | `false` |
 * | `tagConnectorWrites` | `false` |
 *
 * and the ninth is `severityByModel` — the **per-model threshold table**:
 *
 * | Model | `t1` | `t2` |
 * |---|---|---|
 * | `claude-sonnet-5[1m]` | 25 | 35 |
 * | `claude-opus-4-8[1m]` | 45 | 35 |
 * | `claude-sonnet-5` | 25 | 35 |
 * | `claude-opus-4-8` | 45 | 35 |
 *
 * The tenth member is the table the thresholds are read from when the model is not in
 * the table: **`{t1: 15, t2: 20}`**.
 *
 * ## The resolution
 *
 * The target resolves a model's thresholds in one order, and this module reproduces it:
 *
 * 1. **the bundle's own severity** — the bundle's per-site severity entry. The value
 *    `"off"` switches the thresholds off for that site;
 * 2. **the per-model entry** — `severityByModel[model]`, the exact model id first and
 *    then the model's aliases;
 * 3. **the defaults** — `{t1: 15, t2: 20}`.
 *
 * A threshold that is not a number in `[0, 100]` is **not a threshold**: the target falls
 * back to the next source, and this module does the same.
 *
 * ## What this implementation does not have
 *
 * The thresholds are the **auto-mode safety classifier's** two-stage thresholds: the
 * classifier asks a model to classify a tool call and compares the model's severity
 * score against `t1` and `t2`. This implementation has **no auto-mode safety
 * classifier** — its `auto` mode takes the verdict from a caller-supplied callback
 * (`src/permissions/decision.ts`) rather than running the classifier. So the bundle is
 * shipped and the thresholds are resolvable, and **nothing applies them**. That is a
 * difference from the target and it is recorded in
 * `docs/compatibility/remaining-surfaces.md`; it is not papered over by inventing a
 * consumer.
 */

/* -------------------------------------------------------------------------- */
/* The data                                                                     */
/* -------------------------------------------------------------------------- */

/** The two thresholds a model is resolved to. */
export interface SeverityThresholds {
  /** The first threshold. */
  readonly t1: number;
  /** The second threshold. */
  readonly t2: number;
}

/**
 * The **built-in thresholds**: `t1: 15` and `t2: 20`.
 *
 * The target holds them in two module-level constants (`qKe` and `KKe`), and they are
 * the last source in the resolution.
 */
export const DEFAULT_SEVERITY_THRESHOLDS: SeverityThresholds = Object.freeze({ t1: 15, t2: 20 });

/**
 * The **per-model threshold table** the bundle ships.
 *
 * The target freezes it, and the freeze is reproduced here: the table is data, and a
 * caller that mutates it must not be able to change what every other caller reads.
 */
export const SEVERITY_BY_MODEL: Readonly<Record<string, SeverityThresholds>> = Object.freeze({
  'claude-sonnet-5[1m]': Object.freeze({ t1: 25, t2: 35 }),
  'claude-opus-4-8[1m]': Object.freeze({ t1: 45, t2: 35 }),
  'claude-sonnet-5': Object.freeze({ t1: 25, t2: 35 }),
  'claude-opus-4-8': Object.freeze({ t1: 45, t2: 35 }),
});

/**
 * The **site-configuration bundle** the target ships.
 *
 * The target freezes it whole (`Object.freeze`), and so is this one.
 */
export interface SiteConfigBundle {
  /** Whether the classifier runs in two stages. */
  readonly twoStageClassifier: boolean;
  /** Whether the classifier sees the sibling context of the same turn. */
  readonly sameTurnSiblingContext: boolean;
  /** Whether an edit's removal is visible to the classifier. */
  readonly editRemovalVisibility: boolean;
  /** The cap on the removed lines the classifier is shown. */
  readonly editRemovalCap: number;
  /** Whether the outcome of a classified call is visible. */
  readonly outcomeVisibility: boolean;
  /** Whether the repository is visible to the classifier. */
  readonly repoVisibility: boolean;
  /** Whether the git status is a **type**. */
  readonly gitStatusType: boolean;
  /** Whether the git status carries the **uploads**. */
  readonly gitStatusUploads: boolean;
  /** Whether a connector may be **tagged** with a write. */
  readonly tagConnectorWrites: boolean;
  /** The per-model threshold table. */
  readonly severityByModel: Readonly<Record<string, SeverityThresholds>>;
  /**
   * The per-site severity entries.
   *
   * The target reads `bundle.severityBySite?.[siteKey]`; the site keys themselves were
   * not established, so the member is optional and empty here.
   */
  readonly severityBySite?: Readonly<Record<string, unknown>>;
}

/**
 * The **default** bundle: the target's own data, frozen.
 */
export const DEFAULT_SITE_CONFIG: SiteConfigBundle = Object.freeze({
  twoStageClassifier: true,
  sameTurnSiblingContext: true,
  editRemovalVisibility: true,
  editRemovalCap: 3000,
  outcomeVisibility: false,
  repoVisibility: true,
  gitStatusType: true,
  gitStatusUploads: false,
  tagConnectorWrites: false,
  severityByModel: SEVERITY_BY_MODEL,
});

/**
 * The **empty** bundle.
 *
 * The target holds one (`Sc`), and uses it in two places: when the site has switched the
 * feature off, and as the identity that tells "the remote configuration answered" from
 * "nothing answered".
 */
export const EMPTY_SITE_CONFIG: SiteConfigBundle = Object.freeze({
  twoStageClassifier: false,
  sameTurnSiblingContext: false,
  editRemovalVisibility: false,
  editRemovalCap: 0,
  outcomeVisibility: false,
  repoVisibility: false,
  gitStatusType: false,
  gitStatusUploads: false,
  tagConnectorWrites: false,
  severityByModel: Object.freeze({}),
});

/* -------------------------------------------------------------------------- */
/* The resolution                                                               */
/* -------------------------------------------------------------------------- */

/** Where a resolved threshold came from. */
export type SeveritySource =
  /** The bundle answered — the bundle's own severity, or its per-model entry. */
  | 'bundle'
  /** The site's own defaults answered. */
  | 'siteDefault'
  /** Nothing answered; the thresholds are off. */
  | 'default';

/** A resolved pair of thresholds, and where it came from. */
export interface ResolvedSeverity {
  /** The thresholds, or `null` when they are off. */
  readonly value: SeverityThresholds | null;
  /** Where they came from. */
  readonly source: SeveritySource;
}

/** Whether a value is a usable threshold: a number in `[0, 100]`. */
export function isSeverityThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** A threshold, or the fallback when the value is not one. */
function thresholdOr(value: unknown, fallback: number): number {
  return isSeverityThreshold(value) ? value : fallback;
}

/**
 * Read a member of a **plain** object by key.
 *
 * The key is caller-supplied — a model id, a site key — and the object is data, so the
 * read is guarded: an inherited member never answers.
 */
function ownOf(record: unknown, key: string): unknown {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  if (!Object.hasOwn(record, key)) return undefined;
  return (record as Record<string, unknown>)[key];
}

/** The model's aliases, when the caller has them. */
export type ModelAliasResolver = (model: string) => readonly string[];

/**
 * Resolve the **per-model entry** of a threshold table.
 *
 * The target reads the **exact** model id first, and then the model's aliases — and it
 * only walks the aliases when the table *is* the bundle's own table, so a table that
 * came from elsewhere is read by its exact ids alone.
 */
export function resolveSeverityByModel(
  table: unknown,
  model: string,
  aliases?: ModelAliasResolver,
): SeverityThresholds | undefined {
  if (table === null || typeof table !== 'object') return undefined;

  const exact = ownOf(table, model);
  if (exact !== undefined) return readThresholds(exact);

  if (aliases === undefined) return undefined;
  for (const alias of aliases(model)) {
    const found = ownOf(table, alias);
    if (found !== undefined) return readThresholds(found);
  }
  return undefined;
}

/** Read a `{t1, t2}` pair out of a value, when it is one. */
function readThresholds(value: unknown): SeverityThresholds | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const t1 = ownOf(value, 't1');
  const t2 = ownOf(value, 't2');
  if (!isSeverityThreshold(t1) || !isSeverityThreshold(t2)) return undefined;
  return { t1, t2 };
}

/**
 * Resolve a model's thresholds out of a bundle.
 *
 * The order is the target's:
 *
 * 1. the **bundle's own severity** — `bundle.severityBySite[siteKey]`. The value
 *    `"off"` switches the thresholds off; an object is read for the exact model id and
 *    then for the model's aliases;
 * 2. the **per-model entry** — `bundle.severityByModel[model]`;
 * 3. the **defaults** — `{t1: 15, t2: 20}`.
 *
 * A `siteKey` of `undefined` skips the first source, which is what the target does when
 * it has no site to read.
 */
export function resolveSeverity(
  bundle: SiteConfigBundle,
  model: string,
  siteKey?: string,
  aliases?: ModelAliasResolver,
): ResolvedSeverity {
  if (siteKey !== undefined) {
    const site = ownOf(bundle.severityBySite, siteKey);
    if (site === 'off') return { value: null, source: 'bundle' };
    if (site !== undefined && site !== null && typeof site === 'object' && !Array.isArray(site)) {
      const own = readThresholds(ownOf(site, model)) ?? resolveSeverityByModel(site, model, aliases);
      if (own === undefined) return { value: null, source: 'default' };
      return { value: own, source: 'bundle' };
    }
  }

  const perModel = resolveSeverityByModel(bundle.severityByModel, model, aliases);
  if (perModel !== undefined) {
    return {
      value: {
        t1: thresholdOr(perModel.t1, DEFAULT_SEVERITY_THRESHOLDS.t1),
        t2: thresholdOr(perModel.t2, DEFAULT_SEVERITY_THRESHOLDS.t2),
      },
      source: 'bundle',
    };
  }

  return { value: null, source: 'default' };
}

/**
 * The thresholds a model is resolved to, or `null` when they are off.
 *
 * This is the target's own convenience wrapper (`vYt`): it takes the **value** and drops
 * the source.
 */
export function severityThresholdsFor(
  bundle: SiteConfigBundle,
  model: string,
  siteKey?: string,
  aliases?: ModelAliasResolver,
): SeverityThresholds | null {
  return resolveSeverity(bundle, model, siteKey, aliases).value;
}
