# Settings precedence conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.7 "Configuration".
**Owning task:** `CC-003` in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**Matrix rows:** F-03, F-04, F-05 in [`feature-matrix.md`](feature-matrix.md).

## Tier set

Five settings sources are observed in the pinned artifact.

| Source | Scope name | Path | Notes |
|---|---|---|---|
| `policySettings` | — | machine-admin managed settings | Read mode `machine_admin`. Contributes `sandbox` blocks and `env` restrictions. |
| `flagSettings` | — | feature-flag overlay | Supplied by the caller, not by a file. |
| `userSettings` | `user` | `<configDir>/settings.json` | The only tier that may supply `spellcheck`. |
| `projectSettings` | `project` | `<cwd>/.claude/settings.json` | Gated by a `gateProject` trust decision. |
| `localSettings` | `local` | `<cwd>/.claude/settings.local.json` | Overrides a legacy local settings file. |

## The two orderings

These are **different**, and the difference is the whole model. Inverting either silently breaks precedence.

| Ordering | Members, highest first | Applies to |
|---|---|---|
| `TOP_LEVEL_KEY_ORDER` | `policySettings`, `flagSettings`, `userSettings` | A top-level settings key. |
| `MERGED_KEY_ORDER` | `localSettings`, `projectSettings`, `userSettings` | A merged key (for example a skill override). |

A third observed literal, the source enumeration order `D_ = ["userSettings", "projectSettings", "localSettings"]`, is the order the tiers are read in and carries the scope map `{ userSettings: "user", projectSettings: "project", localSettings: "local" }`.

A **fourth** composition, `TIER_PRECEDENCE`, is a **implementation choice**, not an observed literal: it is the ordering used for the whole-block rule and is consistent with both observed orderings.

## Precedence rules

1. **Top-level keys** resolve strictly through `TOP_LEVEL_KEY_ORDER`. The resolver returns the full `[{ source, value }]` list for every source that defines the key; the **first** entry is effective.
2. **Merged keys** resolve through `MERGED_KEY_ORDER`; the first source defining the key wins.
3. **Block granularity.** A higher tier's block applies **as a whole** over any lower tier and is never merged key by key. The target's own message states it: "the spellcheck block in `<source>` applies (as a whole, over any lower tier)".
4. **Ordinary keys.** The per-tier merge for a key that is neither top-level nor a known merged key is **not derived from the target** — the audit records this as an open gap. This implementation composes project/local over user and labels it an underived implementation choice; it is **not** claimed as target-verified.

## Scope restrictions

Some capabilities are deliberately confined to one tier.

| Capability | Tier | Behavior |
|---|---|---|
| `spellcheck` | `userSettings` only | A `spellcheck` block in project or local settings is **ignored entirely**, and the user is told to set it in user settings. |
| `otelHeadersHelper` | reported per tier | The supplying tier is reported alongside the value. |
| `apiKeyHelper` | reported per tier | Same. |
| `autoMemoryDirectory` | reported per tier | Same. |
| `skipDangerousModePermissionPrompt` | explicit union (user, local, flag, policy) | Read from that union; the highest-precedence member that defines it wins. |
| `skipWorkflowUsageWarning` | explicit union (user, local, flag, policy) | Same. |
| one variant of the above | `policySettings` + `userSettings` only | Deliberately narrow. |
| `sandbox` | `policySettings` | Contributes `sandbox` blocks; the policy module reads it directly. |

An unregistered boolean flag with no explicit union is an **error**, not a silent widening of the union.

## Tier degradation and suppression

| Situation | Result | Read mode |
|---|---|---|
| Project settings file is a **symlink** to the user settings path | Reported as **linked away**; the tier is **not applied** | `none` |
| Project settings file is a **hard link** to the user settings path | Reported as **linked away**; the tier is **not applied** | `none` |
| Project settings path resolves to the **same file** as the user settings path | The project tier is **skipped entirely** | `as_read` |
| The personal-config restriction is active | `projectSettings` and `localSettings` return `null` — **exactly** those two | — |
| A local settings file exists alongside a legacy local settings file | The two are merged; the **local** file wins | — |

The same-file case reports `as_read` rather than `none`, and the distinction is pinned by a test.

## Sandbox configuration

- Written to `<configDir>/settings.json` with mode **`0o600`**; the containing directory is created with mode `0o700`.
- Path entries are **canonicalized** — symlinks resolved through the deepest existing ancestor, with the remaining segments re-appended — before being written.
- A malformed existing settings file is **never** overwritten; the write refuses and reports.

## Conformance table

| Audit claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- |
| The two orderings exist, differ, and are not interchangeable | REA observed | F-03 | `tests/contracts/settings-precedence.test.ts` — "settings tier resolution" |
| A project or local tier never wins a top-level key | REA observed | F-04 | same file |
| The ordinary-key path is distinct from the top-level path and is labelled an underived implementation choice | implementation choice | F-04 | same file |
| A higher tier's block wins whole; the lower tier's block is not consulted | REA observed | F-04 | same file — "settings tier resolution" |
| `spellcheck` resolves user-only, and a project/local spellcheck block is ignored by every path | REA observed | F-05 | same file — "settings scope separation" |
| The enumeration order and scope map are pinned | REA observed | F-03 | same file — "settings scope separation" |
| The restrict-personal-config path suppresses exactly `projectSettings` and `localSettings` | REA observed | F-05 | same file — "settings loader" and "settings scope separation" |
| Symlink and hard link to the user settings file → linked away, no tier, read mode `none` | REA observed | F-05 | same file — "settings loader" |
| Same file as the user settings file → tier skipped, read mode `as_read` | REA observed | F-05 | same file — "settings loader" |
| A distinct project file → its own tier, with content and read mode `as_read` | REA observed | F-05 | same file — "settings loader" |
| Local settings win over the legacy local settings file | REA observed | F-05 | same file — "settings loader" |
| `policySettings` reads as `machine_admin` | REA observed | F-03 | same file — "settings loader" |
| The `flagSettings` overlay is applied and wins a top-level key | REA observed | F-03 | same file — "settings loader" |
| A malformed settings file produces an error entry and no tier | implementation choice | F-05 | same file — "settings loader" |
| The sandbox file is written `0o600` with a `0o700` directory, paths canonicalized | implementation choice | F-03 | same file — "sandbox configuration" |
| A malformed settings file is never overwritten | implementation choice | F-03 | same file — "sandbox configuration" |
| `~` and `~/` expansion | implementation choice | F-03 | same file — "sandbox configuration" |
| Unknown keys in a settings document are preserved | implementation choice | F-03 | same file — "settings document schema" |
| A settings document containing `constructor`, `toString`, `hasOwnProperty`, `valueOf`, or `__proto__` does not crash any lookup | implementation choice | F-03 | same file — "settings lookup hardening" |
| An unregistered boolean flag with no explicit union throws a clear error | implementation choice | F-05 | same file — "settings scope separation" |
