# Settings precedence conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.7 "Configuration", and — for the **document** itself — the target's own settings schema, read out of the pinned build at `chunk-c9s0jh80.js:253945`–`323785` (the settings-shape factory `cc()` at `253478`) and `chunk-z6a1zj5w.js:1015027` / `:1116122` (the two sibling documents).
**Owning task:** `CC-003` and `CC-029` in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md). The **tier model** was closed by `CC-003`; the **document's shape** — the 183 keys, the gated blocks, the `permissions` and `sandbox` blocks, the defaults and the two sibling configuration documents — was closed by `CC-029`.
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

## The settings document

The audit covers the **merge algorithm** — which tier wins a key. It does not cover the **shape of the document**: which keys the target accepts, what type each one has, and what it means. That is the other half of the configuration surface, and it is what `CC-029` closed.

The target builds the whole document with one helper — `Mr(schema, { NAME: … })` — and every key carries the target's own `.describe()` prose, so the target states in its own words what each setting is for. This implementation reproduces that prose, with the target's **product name** replaced by `PRRICODE`.

| group | keys | what the target says about it | what this implementation does |
|---|---|---|---|
| the settings document | **183** | The object literal the target's settings factory returns; every key carries the target's own prose | The same **183** names, the same types, the same defaults, and the target's prose as each key's description. Accepted as one **loose** object, because the target's is (`cc(…)` + `.passthrough()`): a settings file written by a newer release keeps its extra keys. |
| the gated blocks | **7** | Five blocks — `autoMode`, `deepLink`, `voice`, `briefView`, `screenReader` — whose shapes the target merges into the document; their keys are easy to miss because they are not in the 183 | The same **7** top-level keys (`skipAutoPermissionPrompt`, `useAutoModeDuringPlan`, `autoMode`, `disableDeepLinkRegistration`, `voiceEnabled`, `defaultView`, `axScreenReader`), plus the eighth key the `autoMode` block contributes to the **permissions** shape (`disableAutoMode`). |
| the `permissions` block | **7** (+1 gated) | "Tool usage permissions configuration" | The same **7** keys — `allow`, `deny`, `ask`, `defaultMode`, `disableBypassPermissionsMode`, `blockReadsOutsideWorkingDirectories`, `additionalDirectories` — plus the gated `disableAutoMode`. `defaultMode` accepts `manual` as an **alias** for `default` and normalizes it, as the target's own schema does. |
| the `sandbox` block | **16** | "Run Bash commands inside the sandbox. Default: false." | The same **16** keys. Fifteen are named by the target's own schema; the sixteenth, `enabledPlatforms`, is read by the target's policy code from the raw block and is named by the audit as one of the five keys the sandbox block carries. |
| the **workspace config** | **28** | The managed-config surface for a third-party distribution, with its own key set and its own `readers` (`desktop`, `code`) | A **separate document** with its own schema, its own 28 keys and its own runtime defaults. It is not a variant of the settings document. |
| the **flat managed config** | **22** | The flat (dot-path) form of the managed configuration, with a `FLAT_KEY_TO_NESTED_PATH` registry and the two discriminators `inferenceProvider` and `inferenceCredentialKind` | A **separate document** with its own schema and its own 22 sections, the two discriminators, and a `materializeFlatManagedConfig` that expands a flat document into the nested shape. It is not a variant of the settings document. |

### The two counts the record got wrong

The record's **lists** are right; two of its **counts** are one too high, and the source settles both:

- the **workspace config** has **28** keys, not 29 — the object literal at `chunk-z6a1zj5w.js:1015027` names 28;
- the **sandbox** block has **15** keys in the target's own schema, not 16 — but the target's policy code reads a sixteenth, `enabledPlatforms`, from the raw block, so **16** is the number of keys the block carries.

### The defaults

The target's schema carries **no** defaults: `cc()` returns a shape whose members are `.optional()` and nothing more. The default of a key lives in the code that *reads* the key, and the target's own `.describe()` prose states it for the keys that have one. `SETTINGS_DEFAULTS` records those, keyed by the dotted path of the setting, and `settingsDefault()` reads them.

**A key with no default is not a key whose default is `false`.** The table records a default only where the target states one; a key the target leaves to the plan, to a server-side rollout or to the machine is **not** in the table, because the target's default is then not a value a document can carry. `settingsDefault('verbose')` is `undefined`; it is not `false`. The **plan-dependent** defaults are the clearest case: `workflowSizeGuideline` defaults to `"medium"` — or `"small"` on Pro plans — and `channelsEnabled` is off for a claude.ai Teams/Enterprise organization and on for Console, so neither is in the table.

The two documents that *do* carry their defaults in a registry — the workspace config's `runtimeDefault` and its `failClosedValue` — are kept apart, because they are different things: the **default** is the value the setting has when nothing sets it, and the **fail-closed stand-in** is the value it takes when the source that carried it could not be read at all. The target's own `runtimeDefault` reads the first and **ignores** an object default, and several of the workspace config's defaults are marked "display-only" — the *display* shows a default and the runtime has none. Those are absent from `WORKSPACE_CONFIG_DEFAULTS`.

### The product name

The target's **product name** never appears in this repository. The **key names** are the target's, because a settings file is an interface: a document that says `syncClaudeAiSkills` has to be accepted, and a clone that renamed it would reject a file the target accepts. The **prose** is the target's too, with the product name replaced by `PRRICODE` — the same convention the tool surface uses ("the **name** is the target's own, because a tool's name is the interface the model calls"). The target's **environment variable names**, **model ids**, **API hosts**, **file names** and **on-disk paths** keep their own names, because they are the data the implementation has to speak to.

## The clone choices

Every key group above carries a **clone-choice label**, and the label says what this implementation did with the group's shape:

| label | meaning |
|---|---|
| `reproduced` | The key, its type and its default are the target's, and the target's own prose is the key's description. |
| `reproduced, interior loose` | The key and its **outer** type are the target's, but the shape **inside** it is loose: the target's own sub-schema for that member was not read, so a member of the wrong shape inside it is accepted rather than refused. |
| `accepted, not acted on` | The document accepts the key and validates it; this implementation has **no behaviour** for it yet. The key is part of the interface, so it is accepted whether or not anything reads it. |
| `renamed for the product` | The target's product name inside the key's own data — its name, its description, a command it names — was replaced by `PRRICODE`. The key's **own name** was not: a key's name is data. |
| `not established` | The target's behaviour could not be established, and nothing is claimed about it. |

| group | keys | clone choice |
|---|---|---|
| the settings document | 183 | `reproduced` — with the interiors that could not be read marked `reproduced, interior loose` (the MCP server entries, the marketplace entries, the policy-helper entries, the hook commands) |
| the gated blocks | 7 (+1) | `reproduced` |
| the `permissions` block | 7 (+1) | `reproduced`; the **per-tool** permission-rule validators are `not established` and are not reproduced — only the rule's *shape* is checked |
| the `sandbox` block | 16 | `reproduced`; the credential-entry interiors are `reproduced, interior loose` |
| the workspace config | 28 | `reproduced`; the `allowedFolders` and `allowedEgressHosts` interiors are `reproduced, interior loose` |
| the flat managed config | 22 | `reproduced` at the section level; the **leaf** registry of the flat document is `not established` — this implementation carries the 22 section names and the two discriminators, not every leaf of the field tree |
| every key | — | `accepted, not acted on` for the keys this implementation has no behaviour for: the document **accepts** all 183, and only the settings this implementation reads are acted on |

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
| the **flat managed config** and the **workspace config** | `policySettings` only | The two sibling documents are admin-controlled: the target reads them from the managed-settings sources, never from a checked-in project file or a user's local settings. `MANAGED_CONFIG_SOURCES` is the single place that scope is declared, and `readManagedConfigSection` reads a section out of the machine-admin tier. |

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
| The settings document is **183** top-level keys, in the target's own order, each with the target's own prose | REA observed | F-03 | same file — "names the 183 keys the target accepts" |
| A document carrying a value for **every one** of the 183 keys parses | REA observed | F-03 | same file — "accepts every key the target accepts" |
| The document rejects **none** of its keys for being absent: the target builds the schema for the keys a document carries | REA observed | F-03 | same file — "requires none of its keys, because the target never rejects a document for omitting one" |
| A known key whose type is wrong is refused, and a value outside a bound the target states is refused | REA observed | F-03 | same file — "rejects a known key whose type is wrong" |
| A value the target **catches** is dropped rather than refused | REA observed | F-03 | same file — "rejects a value outside the bound the target states" |
| No description carries the target's product name | implementation choice | F-03 | same file — "names no target product name in any description" |
| The gated blocks contribute **7** top-level keys and one key to the permissions shape | REA observed | F-03 | same file — "contributes the seven keys the target adds outside the 183" |
| The `permissions` block has the target's **7** keys plus the gated one | REA observed | F-03 | same file — "has the seven keys the target names, plus the one the gated block adds" |
| The `sandbox` block has **16** keys | REA observed | F-03 | same file — "has the sixteen keys the target names" |
| A key with **no** default is not a key whose default is `false` | REA observed | F-03 | same file — "distinguishes a key with no default from a key whose default is false" |
| The **workspace config** is a separate document with **28** keys, and the **flat managed config** is a separate document with **22** | REA observed | F-04 | same file — "the two sibling config systems" |
| A managed-config section is read from the machine-admin tier only | implementation choice | F-05 | same file — "reads a managed-config section from the machine-admin tier only" |
| A malformed managed config is reported and does not stop the settings from loading | implementation choice | F-05 | same file — "reports a malformed managed config without failing the settings load" |
