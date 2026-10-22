# Reference-catalogue conformance — the environment variables and the telemetry events

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Owning task:** `CC-042`.
**The record:** [`docs/reverse-engineering/SURFACE-INVENTORY.md`](../reverse-engineering/SURFACE-INVENTORY.md), generated from the target's own source by `scripts/verify-rea.ts` and checked by it.
**The implementation:** `src/config/environmentCatalogue.ts`, `src/config/environment.ts`, `src/telemetry/vocabulary.ts`, `src/telemetry/emitter.ts`.
**The test:** `tests/contracts/reference-catalogues.test.ts`.

> The two catalogues are **reference surfaces**, not features. The target reads
> **1 285** environment variables and emits **3 084** `tengu_*` events. A clone
> that ignores a variable the target honours behaves differently; a clone that
> emits a different event name is not observable in the same way.

Every claim below names its **evidence class**: `REA observed` (read out of the
target's own source, with a file and an offset), `implementation choice` (this
implementation's own decision, where the target's behaviour is not established),
or `not established` (a gap, named as a gap).

---

## 1. The environment-variable surface

### 1.1 What the catalogue carries

| | count | where |
|---|---|---|
| the derived surface | **1 285** | `ENVIRONMENT_VARIABLE_NAMES` |
| the names the derivation cannot see, established by reading | **2** | `ENVIRONMENT_VARIABLE_NAMES_BEYOND_THE_DERIVATION` |
| the surface this implementation carries | **1 287** | `ENVIRONMENT_VARIABLE_SURFACE` |

**REA observed.** The derivation (`scripts/verify-rea.ts:297`) unions three
sources: a **direct** read (`process.env.NAME`), an **accessor** — a helper
whose own body reads `process.env[`, called with an environment-shaped literal
— and the target's **lazy namespace**, the keys of the `Mr(target, {…})`
descriptor objects in `chunk-68z1nb51.js`, each of which is a getter over
`process.env`.

**The names are the target's data**, so they keep the target's spelling. This
implementation reads the ones that change behaviour under the target's own
names.

### 1.2 The two blind spots, and what they cost

**Blind spot A — a read through a parameter that defaults to `process.env`.**

`chunk-zjm15h4n.js:17211` reads `r[P_n]` and `chunk-zjm15h4n.js:17238` reads
`r[I_n]`, where `r` is a **parameter** of `function Xe(e, r = process.env)`.
The literal `process.env[` is nowhere in the body, so the accessor form does
not fire. Resolving the identifiers through the import graph gives the two
names the target's own error message names:

- `SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_COMMAND`
- `SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_FILE`

Both are carried, with the file and the offset they were read at. A sweep of
the tree for `[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*process\.env` finds **80 files**
with such a parameter; these are the only two that resolve to an
environment-shaped name.

**Blind spot B — a name held in a literal list.**

The target holds environment-shaped names in **array literals**: the
propagation sets, the endpoint-policy sets, the credential sets. The
derivation reads names where they are **read**, so a name that appears only in
a list is invisible to it.

**The size of the blind spot, measured.** 687 distinct environment-shaped
names appear in array literals across the tree; **427** of them are not in the
1 285, and **51** of those are the target's own (`CLAUDE_*`, `ANTHROPIC_*`,
`SELF_HOSTED_RUNNER_*`). The lists, with their offsets:

| the list | where |
|---|---|
| the entrypoint/messaging propagation set | `chunk-081t8575.js:10145` |
| the bridge/oauth propagation set | `chunk-1f6s1a9t.js:1100` |
| the credential-file set | `chunk-3r7fz8m2.js:171473` |
| the MCP timeout set | `chunk-3r7fz8m2.js:179285` |
| the name-prefix set | `chunk-3r7fz8m2.js:182191` |
| the credential-scrub set | `chunk-3r7fz8m2.js:188164` |
| the managed-settings set | `chunk-7dkjjfkc.js:9223` |
| the certificate set | `chunk-4jsg44k7.js:3536177` |
| the plugin/project path set | `chunk-4jsg44k7.js:3686841` |
| the credential-input set | `chunk-4sn6hdt2.js:29039` |
| the helper set | `chunk-4sn6hdt2.js:40154` |
| the runner's deprecated-name set | `chunk-56g9kk6e.js:246036` |
| the TUI propagation set | `chunk-6bp7hdav.js:146537` |
| the model/capability propagation set | `chunk-9y799w6p.js:22461` |
| the route-selection set | `chunk-c9s0jh80.js:195393` |
| the endpoint policy set | `chunk-c9s0jh80.js:199739` |
| the model default set | `chunk-c9s0jh80.js:201046` |

**Not established.** Whether the target *reads* a name that appears only in a
propagation set. `CLAUDE_CODE_ENABLE_AUTO_MODE` is in
`chunk-9y799w6p.js:22461` and has **no** read anywhere in the tree;
`CLAUDE_CODE_USE_BEDROCK` is read **twice** (`process.env.…` and `a.…`) and is
in the 1 285. The distinction cannot be drawn without a per-chunk alias
resolution the derivation does not do.

**Therefore the 1 285 is a lower bound on the target's environment surface**,
and so is the catalogue this milestone carries.

### 1.3 The names behind the prefixes

Four of the 51 are **prefixes**, not names: `CLAUDE_CODE_HOST_`,
`CLAUDE_CODE_RELAUNCH_`, `CLAUDE_CODE_SDK_` and `CLAUDE_CODE_SESSION_`. The
target appends to them, so no finite list of names can hold them.
**Not established.**

### 1.4 The reader, and the target's rules

`src/config/environment.ts` is the **one** place this implementation reads the
environment. The rules are the target's:

| rule | the target's own source | evidence class |
|---|---|---|
| the truthy tokens are `1`, `true`, `yes`, `on` | `chunk-c5n7mysv.js:717` (`Ne`) | REA observed |
| the falsy tokens are `0`, `false`, `no`, `off` | `chunk-c5n7mysv.js:859` (`ws`) | REA observed |
| the environment namespace's schema: `str` (trimmed, empty is unset), `bool` (`Ne`), `triBool`, `int`, `enum` | `chunk-5jcc28n0.js` | REA observed |
| a value is trimmed, and a blank value is **unset** | the target's own `H.str()` | REA observed |
| the traffic mode: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` **by presence**, then `DISABLE_TELEMETRY` **by presence**, then `DO_NOT_TRACK` **by the boolean parse** | `chunk-kmrt4q1v.js:14089` (`fjt`) | REA observed |
| the name of the variable that turned the traffic mode off | `chunk-kmrt4q1v.js:14412` (`ZBr`) | REA observed |
| the configuration root is `CLAUDE_CONFIG_DIR`, or `~/.claude` | `process.env.CLAUDE_CONFIG_DIR\|\|ce()` | REA observed |

The **presence**-versus-**boolean** distinction is the one a text sweep cannot
see, and it is observable: `DISABLE_TELEMETRY=0` turns the target's telemetry
**off**, and `DO_NOT_TRACK=0` leaves it **on**.

**Implementation choice.** A **relative** `CLAUDE_CONFIG_DIR` is resolved
against the process's working directory. The target carries a message about
the variable being "empty or relative" and a configuration directory that "is
worked out from each of three folders" (`chunk-8fgrwnc5.js:209487`); that
rule is **not established** here and is not reproduced.

### 1.5 The rules that were **wider** before this milestone

This implementation read six of the variables above by a rule **wider** than
the target's, and a wider rule is a difference: it turned a switch on when the
target leaves it off. The milestone narrowed each one to the target's own
rule.

| variable | the rule before | the target's rule | the difference it made |
|---|---|---|---|
| `CLAUDE_CODE_USE_*` (the route flags) | "not false" — any value outside `0`/`false`/`no`/`off` turned the route **on** | the **boolean** parse | `CLAUDE_CODE_USE_BEDROCK=2` selected Bedrock here and does not in the target |
| `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` | "not false" in the permission module, and **presence** in the CLI and the slash command | the **boolean** parse | `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG=2` restricted the personal configuration here and does not in the target |
| `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` | **presence** | the **boolean** parse | `=0` switched the checkpointing off here and does not in the target |
| `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | **presence** | the **boolean** parse | `=0` switched the host checkpointing on here and does not in the target |
| `INK_SCREEN_READER` | `=== 'true'` | the **boolean** parse | `=1` left the screen reader off here and does not in the target |
| `CLAUDE_CODE_ENABLE_XAA` | **presence** | the **boolean** parse | `=0` enabled the XAA feature here and does not in the target |
| `CLAUDE_CONFIG_DIR` (the IDE lock directories) | **presence** | the **string** parse — trimmed, empty is unset | an **empty** variable added the home directory's lock directory here and does not in the target |

---

## 2. The telemetry vocabulary

### 2.1 What the catalogue carries, and the count

| | count | where |
|---|---|---|
| the **distinct event names** | **3 084** | `TELEMETRY_EVENT_NAMES` |
| the **(file, name) placements** the record lists | **3 554** | `docs/reverse-engineering/SURFACE-INVENTORY.md` |
| the total occurrences in the target's source | **4 528** | — |

**The verifier's own count is the pair count, not the name count.**
`scripts/verify-rea.ts:141` adds `line.replace(/^"|"$/g, '')` to a line that
`grep -H` has already prefixed with `./chunk-<id>.js:`, so the leading `"` is
never at position 0 and is never stripped, and the recorded row is
`` `./chunk-03g7mcz9.js:"tengu_chrome_auto_enable_prompt_shown` `` — a file and
a name. The record and the derivation agree, because both sides apply the same
transformation; the **label** is what is wrong.

The 470 extra placements are the events the target ships in more than one
chunk; the busiest is `tengu_ccr_bundle_upload`, in `chunk-4jsg44k7.js`, 38
places.

**The vocabulary is the 3 084 names**, and the catalogue carries them as a
literal tuple, so the type `TelemetryEventName` is derived from the list.

### 2.2 The event model

**REA observed** (`chunk-333wmdtg.js`, the target's telemetry module):

| what | where |
|---|---|
| `stripProtoFields(metadata)` — drops every `_PROTO_`-prefixed key | `chunk-333wmdtg.js:686` |
| the queue's capacity, `1000` | `chunk-333wmdtg.js:798` |
| the queue — a full queue drops its **oldest** event and counts the drop | `chunk-333wmdtg.js:874` |
| `attachAnalyticsSink(sink)` — the sink's interface is `{logEvent, logEventAsync}` | `chunk-333wmdtg.js:1047` |
| the flush — a **microtask** replays the queue when a sink arrives | `chunk-333wmdtg.js:1047` |
| `logEvent(eventName, metadata)` | `chunk-333wmdtg.js:1312` |
| `logEventAsync(eventName, metadata)` | `chunk-333wmdtg.js:1429` |

An event is therefore a **pair** — a name and a metadata object. There is no
envelope, no channel and no schema version. `src/telemetry/emitter.ts`
reproduces that model exactly.

### 2.3 The events this implementation raises

The names are typed as the target's own event names (`satisfies
TelemetryEventName`), so a rename, or an event the target does not emit, is a
**compile error**.

| event | the properties the target attaches | the target's own source | what this implementation raises |
|---|---|---|---|
| `tengu_session_resumed` | `entrypoint`, `success`, `resume_duration_ms`, `interruption_kind`, `failure_reason`, `error_name`, `error_code` | `chunk-9y799w6p.js:76172`, `chunk-e7w77ts3.js:736798`, `chunk-6bp7hdav.js:357058`, `chunk-y8arze2n.js:29878` | the same properties |
| `tengu_continue` | `success`, `resume_duration_ms`, `entrypoint`, `error_name` | `chunk-9y799w6p.js:57109`, `chunk-e7w77ts3.js:734066` | the same properties |
| `tengu_resume_print` | **none** — the payload is `{}` | `chunk-e7w77ts3.js:736480` | the same: the payload carries no property but the name |
| `tengu_carried_prompts_taken` | `count`, `already_delivered`, `outcome`, `age_ms` | `chunk-6bp7hdav.js:58863` | the same four properties; `count` is `1` for a prompt taken and `0` for one that was not, and `age_ms` is the age of the **row** rather than of the file, because this implementation's store is a row store |
| `tengu_unknown_model_cost` | `model`, `shortName` | `chunk-dt3pd9ft.js:268732` | the same two properties: the **model** is the id the run asked for and the **short name** is the **canonical** id the catalog knows it by, and the id is reported the way the target's own sanitiser reports it — `"nonconforming"` for an id outside its shape, and absent for an absent id |

**Implementation choice.** The carried-prompt event's `count` and `age_ms` are
this implementation's own semantics — the target takes a **file** of prompts
and reports the file's age, and this implementation takes one **row** at a
time. The property **names** and their **types** are the target's.

**Implementation choice.** The unknown-cost event's **short name** is the
catalog's canonical id. The target's short name comes from its **served
catalog**, and this implementation has a **built-in** catalog and a
provider-owned one; where the catalog knows the model, the two agree, and
where it does not, the short name is absent — the target's own rule for an
absent id.

### The events that are carried as data only

Two of the target's events belong to behaviour this implementation has, but
**not the behaviour the event describes**, and they are therefore not raised:

| event | why it is not raised |
|---|---|
| `tengu_tool_use_tool_result_mismatch_error` | the target's event reports a **normalisation** mismatch in the message sequence — it carries the normalised and the pre-normalised sequences, the message counts and the offending blocks. This implementation reports an unmatched `tool_result` in the transcript, which is a **different** check; raising the target's event name for it would rename the event's meaning |
| `tengu_propose_skills`, `tengu_propose_skills_read_check`, `tengu_propose_skills_kept_lines` | the target's `propose_skills` **tool** does not exist here, so there is no behaviour that warrants the events. The read check the module owns is a different thing, and it is not the target's tool |

**Not established.** The target's carried-prompt outcome vocabulary has
**eight** members — `unbound`, `bound`, `altered`, `no_row`, `job_has_run`,
`too_old`, `future_dated`, `sent` — while this implementation's has the
**seven** the audit records (`F-26`). The missing one is `unbound`, which the
target reaches when its binding hash is absent; this implementation binds by
session id instead. The seven this implementation emits are all the target's.

### 2.4 The rules the emitter enforces

1. **An event the target does not emit is not emitted.** The name is checked
   against the vocabulary and an unknown name is refused with
   `UnknownTelemetryEventError`. The only names outside the vocabulary that
   may be raised are the **declared** ones, and each declaration carries a
   reason and a kind.
2. **An event is not renamed.** The type is derived from the vocabulary.
3. **A telemetry switch the target honours is honoured here.** The traffic
   mode turns the emitter off, exactly as it turns the target's off.

### 2.5 The declared names outside the vocabulary

The target emits **timing** events under names that are not `tengu_*`, and the
derivation's literal scan does not see that namespace. Two are declared:

| name | kind | where the target emits it |
|---|---|---|
| `skills_load_ms` | `target-timing` | the target's skills load |
| `qe_plugin_skills_load_ms` | `target-timing` | the target's plugin skill load |

**Not established.** The target's timing-event namespace as a whole: a literal
scan finds **128** `*_ms` names, and many of them are ordinary property names
(`duration_ms`, `interval_ms`) rather than events. The namespace is not
enumerated.

### 2.6 What is **not** reproduced

The target's analytics **backend** — the first-party event log and the
Datadog forwarder — is not reproduced: this implementation has no account, no
session identity and no bucket to report. The **model** is reproduced; the
backend is not.

**REA observed**, for the record: the target's sink enriches the metadata
before it leaves — the `model` member is rewritten to the *served* model id
(`dYn`), and the Datadog path adds `envContext`, `head_sha`,
`is_clean_tree_at_start`, `changed_file_count_at_start`,
`untracked_file_count_at_start`, `userBucket`, `ddsource` and `ddtags`
(`chunk-…`, `xNt`). The first-party path carries its own envelope
(`event_type`, `event_id`, `observedTimestamp`, `body`). None of that is
reproduced, and none of it is claimed.

---

## 3. The honest boundary

| the part of the catalogue | the target's count | what this implementation carries | what it does with it |
|---|---|---|---|
| the environment vocabulary | 1 285 derived, plus ≥ 2 established by reading, plus ≥ 51 in literal lists | the 1 285 and the 2, as **data** | the reader resolves the variables that change behaviour; the rest are carried as data |
| the environment **reader** | the target's trimming, boolean and presence rules | the rules, in one module | every behaviour-changing read goes through it |
| the telemetry vocabulary | 3 084 names, in 3 554 placements | the 3 084 names, as **data** | the emitter refuses a name outside it |
| the telemetry **emitter** | `(eventName, metadata)` into a sink, a 1 000-event queue that drops its oldest | the same model, the same queue, the same sink interface | the session modules raise through it; the run's sink receives the record |

### The variables that change behaviour here

| variable | the target's rule | what it changes |
|---|---|---|
| `CLAUDE_CODE_USE_BEDROCK`, `…_USE_VERTEX`, `…_USE_FOUNDRY`, `…_USE_ANTHROPIC_AWS`, `…_USE_ANTHROPIC_GOOGLE_CLOUD`, `…_USE_MANTLE` | the **boolean** parse | the **route** the provider layer selects. A value outside `1`/`true`/`yes`/`on` leaves the route off |
| `CLAUDE_CONFIG_DIR` | the **string** parse — trimmed, empty is unset | the **configuration root**: the settings tiers, the session store, the provider manager's state, and the IDE lock directories |
| `DISABLE_TELEMETRY` | **presence** | the **telemetry**: no event is emitted |
| `DO_NOT_TRACK` | the **boolean** parse | the **telemetry**: no event is emitted |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | **presence** | the **telemetry**: no event is emitted |
| `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` | the **boolean** parse | the **settings scope** (the project-side tiers are suppressed) and the **host-level gate** |
| `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` | the **boolean** parse | the **checkpointing** |
| `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | the **boolean** parse | the **checkpointing** in a host application |
| `INK_SCREEN_READER` | the **boolean** parse | the **screen reader** |
| `CLAUDE_CODE_ENABLE_XAA` | the **boolean** parse | the **XAA** requirement check |
| `CLAUDE_CODE_IDE_SKIP_VALID_CHECK` | the **boolean** parse | the **IDE lock** validity |

**The rules are the target's, and the evidence is the target's environment
namespace.** The namespace's schema (`chunk-5jcc28n0.js`) is the whole of it:

| the target's schema | the rule |
|---|---|
| `H.str()` | the trimmed value; an empty value is **unset** |
| `H.bool()` | `Ne` — `1`, `true`, `yes`, `on`, and **nothing else** |
| `H.triBool()` | true, false, or unset |
| `H.int({…})` | a number, with the bounds the namespace declares |
| `H.enum([…])` | the trimmed value when it is in the list, and unset otherwise |

Every variable above was read out of that namespace, and the schema it carries
is the schema this implementation now applies.

### The variables carried as data only

The other **1 279** derived names — and the 51 in the literal lists, and the
four prefixes — are carried as **data**. They belong to capabilities this
implementation does not have (the browser, the agent teams, the remote
sessions, the marketplace, the self-hosted runner's own orchestrator, the
vendored cloud SDKs), and reading one here would be inventing a behaviour the
target has and this implementation does not.

### The events carried as data only

The other **3 079** event names are carried as **data**. They belong to
capabilities this implementation does not have, and raising one "to make the
count look right" would be inventing an event the target emits in a place
this implementation has no behaviour at all.

---

## 4. What this milestone did **not** establish

- **Whether the target reads a name that appears only in a propagation set.**
  51 names are in that state; no read could be shown for any of them.
- **The names behind the four prefixes.** The target appends to them.
- **The target's timing-event namespace.** Two of its members are declared; the
  namespace is not enumerated.
- **The target's analytics backend and its enrichment.** Not reproduced, and
  not claimed.
- **The target's handling of a relative `CLAUDE_CONFIG_DIR`.** The three-folder
  rule is named in the target's own message and is not reproduced here.
- **The target's carried-prompt `unbound` outcome.** This implementation binds
  by session id and has no such outcome.
