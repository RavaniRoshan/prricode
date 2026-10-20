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

A **fourth** composition, `TIER_PRECEDENCE`, is the target's own `Ps` order seen from the top: `policySettings`, `flagSettings`, `localSettings`, `projectSettings`, `userSettings`. The target composes its effective settings in the reverse of it — user, project, local, flag, policy, increasing priority — and so does this implementation.

## Precedence rules

1. **Top-level keys** resolve strictly through `TOP_LEVEL_KEY_ORDER`. The resolver returns the full `[{ source, value }]` list for every source that defines the key; the **first** entry is effective.
2. **Merged keys** resolve through `MERGED_KEY_ORDER`; the first source defining the key wins.
3. **Block granularity.** A higher tier's block applies **as a whole** over any lower tier and is never merged key by key. The target's own message states it: "the spellcheck block in `<source>` applies (as a whole, over any lower tier)".
4. **Ordinary keys** resolve through the target's **per-top-level-key** rule, and the value is the **merged** value. The rule was closed by source reading and the audit's §2.7 no longer records it as an open gap. The value rule is a table:

   | the key's value | the rule |
   |---|---|
   | `modelPicker` | the higher tier **replaces** the value |
   | an **array** | the two arrays are **concatenated and de-duplicated** |
   | an array, key `fallbackModel` | the higher tier **replaces** the value |
   | an object, key `extraKnownMarketplaces` or `managedMcpServers` | a **one-level shallow merge** |
   | **anything else** | the higher tier **replaces** the value **wholesale** |

   The last row is the load-bearing one: an ordinary object-valued setting is **not** merged key by key, and the higher tier's object wins whole. The source that supplied a key is still the **highest** tier that defines it, which is not the same thing as the value: an array two tiers define is the concatenation of both.derived implementation choice; it is **not** claimed as target-verified.

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
| The ordinary-key path is distinct from the top-level path | REA observed | F-04 | same file |
| The settings merge is per top-level key, and the value rule is decided per key: arrays concatenate and de-duplicate, two named object keys shallow-merge one level, and everything else is replaced whole | REA observed | F-04 | same file — "the settings merge is per top-level key" |
| A merged key is won **whole** by the first source in the merged order that defines it | REA observed | F-05 | same file — "a merged key is won whole by the first source that defines it" |
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
