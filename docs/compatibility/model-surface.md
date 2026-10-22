# The model layer — conformance

**The specification:** [`docs/protocol/MODEL-LAYER.md`](../protocol/MODEL-LAYER.md).
The specification is the design; this document says what was built against it,
and where the specification left a choice open, which reading was taken and
why.
**Owning task:** `CC-044` in
[`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**The implementation:** `src/model/` — seventeen modules.
**The test:** `tests/contracts/model-layer.test.ts` — **seventy tests**, over a
**real HTTP server on a real port** that speaks all three shapes, and over a
backend that fails.

---

## 0. The labels, and why this surface has no target rows

This surface is **our own design**. The pinned target has a model layer of its
own, and the second layer's model layer is not a copy of it — it is the
product's own, built on the first layer's foundations. So there is nothing to
compare it against and **no row in the compatibility matrix**: a divergence is
not a compatibility claim, and a compatibility row must not be weakened to
make room for one.

Every row of this document therefore carries the first layer's **clone-choice
label**:

| label | meaning | here |
|---|---|---|
| `Project requirement` | a product extension: the target does not have this behaviour, and nothing about it is a claim about the target | **every row of this document** |

and, inside the second layer, the label that says where the row comes from:

| label | meaning |
|---|---|
| `specified` | pinned by `docs/protocol/MODEL-LAYER.md` — the specification says it, and the implementation says it |
| `implementation choice` | the specification is silent, and the reading below is ours |

The two are orthogonal: a row is `Project requirement` **and** `specified`, or
`Project requirement` **and** `implementation choice`. The second column is
the honest one — it says which parts of the surface are the specification's
promise and which parts are ours, so a later milestone can move a row from the
second column to the first without guessing.

**The naming rule applies to every line of this document.** Where a
*capability* is meant — an endpoint that speaks one API shape or another — the
capability is named: `chat`, `messages`, `responses`. No product and no
company is named, in this document or in the code it describes.

---

## 1. A provider is data, and one engine speaks it

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the provider entry | it carries `id`, `dialect`, `endpoint`, `credential`, `headers` and `models` | `ProviderEntry` carries exactly those six, and nothing else | `a provider is data, and one engine speaks it › carries the identity, the shape, the endpoint, the credential reference, the headers and the models` |
| the credential member | a **reference** to a secret, never the secret | `CredentialReference` is `{ kind: 'integration', integration }` or `{ kind: 'none' }` — an integration *name* | `… › never carries a secret` |
| adding a provider | adding an entry and a module; never editing a registry, never a branch in the engine | `ProviderTable.register` takes an entry; the engine reads the entry and never branches on its name — the three shapes are reached through `dialectFor` alone | `… › registers providers as data, and adding one is not editing a registry` |
| one code path per shape | "there is exactly one code path per **dialect**" | one module per shape — `src/model/dialects/{chat,messages,responses}.ts` — and one engine method that builds, sends and parses | `the whole path, against a fake backend › sends a chat request…`; `… › sends a messages request…`; `… › sends a responses request…` |

**Implementation choice — the provider entry's members.** The specification
names six, and the entry carries exactly those six. The `enabled` flag the
model entry carries (§3) is the only addition anywhere, and it is on the
*model*, not on the provider.

---

## 2. The dialect seam — not a vendor switch

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the three shapes | `chat`, `messages`, `responses` are first-class | `DIALECTS` is exactly those three, and `isDialect` admits nothing else | `a provider is data, and one engine speaks it › names the three shapes and nothing else` |
| the shape is a property of the path | "the API shape a provider speaks is a property of its *path*, not of its name" | a provider's `dialect` is a member of its entry, and the shape decides the request path, the credential header and the reply's grammar | `the dialect seam — not a vendor switch › is a property of the path, so one provider may speak any of the three` |
| one module per dialect | "**One module per dialect**" | three modules and a registry; the engine holds no shape-specific code | `the whole path, against a fake backend › sends a chat request…`; `… › sends a messages request…`; `… › sends a responses request…` |
| a provider's own behaviour | "layered on top as data" | the provider's headers and the overlay's spelling are the only per-provider data the request carries | `the whole path, against a fake backend › puts the provider's own headers and the overlay's headers on the wire` |
| a first-party shape addressed as a compatible one | "with its own endpoint and its own credential… a *convenience* boundary, not a security boundary" | the alias: it inherits the canonical provider's definition and changes its endpoint and its credential | `the dialect seam — not a vendor switch › addresses a first-party shape as a compatible one, with its own endpoint and credential` |

**Implementation choice — the shapes' own wire vocabulary.** The three shapes
are **ours**: the credential travels in `authorization: Bearer …` for `chat`
and `responses`, and in `x-api-key` for `messages`, which also carries
`x-api-version`. The specification names the shapes and not their headers,
and the naming rule keeps a product's own header names out of this
repository. A deployment that needs a different vocabulary supplies it as a
**provider header** or an **overlay header** — which is data, and is exactly
where the specification puts a provider's own behaviour.

---

## 3. The catalogue

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the load order | a local override, then the fetched list, then the shipped snapshot | `mergeCatalogues` merges the three in that order | `the catalogue › merges a local override over a fetched list over a shipped snapshot` |
| the local override wins | "always wins" | the override's model replaces the fetched and the snapshot's model of the same id | `… › lets the local override win over the fetched list for the same model` |
| a provider that reports nothing | "its models are still known, from the snapshot, and simply not connected" | the snapshot's models stand, and the provider is simply not connected | `… › keeps a provider that reports nothing in the catalogue, from the snapshot`; `… › degrades with a reason when the fetch fails` |
| the catalogue is fetched | "fetched from each connected provider" | `ModelCatalogue.refresh(provider)` fetches the provider's own model list and parses it | `… › fetches the catalogue from a connected provider` |
| the same bytes change nothing | "not the cache, not the refresh, not the notification" | the raw response bytes are compared with the cached bytes; an identical body rewrites nothing, re-merges nothing and wakes no watcher | `… › changes nothing when a fetch returns the same bytes`; `… › does not wake a watcher when nothing changed` |
| the model entry's fields | `id`, `provider`, `capabilities`, `cost`, `limits`, `overlays`, `reasoning` | `ModelEntry` carries those seven, plus `enabled` | `the overlays — where the effort lives › applies an effort, a thinking toggle and a token budget…` |
| a capability the model does not have | "is enforced, not ignored… refuses it, in a form the user sees" | the engine refuses the turn with `model/capability-unsupported` and names the modality and the model | `the whole path, against a fake backend › refuses an attachment the model cannot take, rather than dropping it` |

**Implementation choice — the merge is per model, not per provider.** The
specification says the local override "always wins" and that a provider which
reports nothing keeps its snapshot models. Both hold under a **per-model**
merge: the override's models win over the fetched and the snapshot's models
of the same id, and the models the override does not name still come from the
fetch or the snapshot. A per-*provider* merge would satisfy the first
sentence too, but it would empty a provider's catalogue whenever the user
overrode one of its models — which is the opposite of what the specification
promises two paragraphs later.

**Implementation choice — the model entry's `enabled` flag.** The
specification's table of the model entry's fields does not carry it, but a
model must be able to become *unavailable* — one of the failures this layer
has to degrade with. The flag is the way a model is turned off, and a local
override that turns a model off leaves it in the catalogue, known and
unavailable.

**Implementation choice — what "the same bytes" means.** The comparison is
over the **raw response bytes**, before the payload is parsed. A payload that
parses to the same models but was written differently is therefore *not* a
no-op, and the catalogue is refreshed: the specification's promise is that a
fetch which returns the same bytes changes nothing, and the bytes are the
thing that is returned.

---

## 4. The overlays — where the effort lives

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the effort is a named overlay | "**The reasoning effort is not a number.** It is one of a family of named overlays" | `Overlay` is a union of four kinds — `effort`, `toggle`, `budget_tokens`, `named` — and every one of them is a named member of the model's list | `the overlays — where the effort lives › applies an effort, a thinking toggle and a token budget, all three, from the catalogue` |
| the same mechanism carries all of them | the same mechanism carries the effort, the toggle, the budget and a user's own overlay | one mechanism: `resolveOverlay`, `applyOverlay`, `withOverlay` | `… › applies an effort, a thinking toggle and a token budget, all three, from the catalogue`; `… › carries a user-defined named overlay with its own fields, headers and body` |
| each carries the request fields, the headers and the body | "each with the **request fields, the headers and the body it contributes**" | `OverlaySpelling` is exactly those three channels, and `applyOverlay` merges all three | `… › carries a user-defined named overlay with its own fields, headers and body` |
| the engine knows no vendor's spelling | "The engine applies an overlay and **knows no vendor's spelling**" | the engine reads `fields`, `headers` and `body` and nothing else; there is no rule anywhere in `src/model/` that inspects a model id | `… › takes the spelling from the catalogue, not from a rule in the code` |
| the spelling belongs to the model and the shape | "when the effective dialect changes, the overlays are **re-spelled**" | a spelling is keyed by the shape; the effective spelling is the one for the provider's shape | `… › re-spells the overlays when the effective dialect changes`; `the dialect seam — not a vendor switch › re-spells an alias that speaks another shape` |
| there is no "default effort" | "Selecting the pseudo-overlay `default` means *no overlay at all*" | `DEFAULT_OVERLAY_NAME` resolves to no overlay and an empty spelling, and contributes nothing to the request | `… › treats the pseudo-overlay "default" as no overlay at all`; `the whole path, against a fake backend › sends no overlay at all when the pseudo-overlay 'default' is chosen` |
| a support kind the model does not offer | the model entry's `reasoning` declares the support kinds it offers | an effort outside the declared ladder, a toggle without a declared toggle, and a budget outside the declared range are each refused with a reason | `… › refuses an effort the model does not declare, even when the overlay exists`; `… › refuses a toggle and a budget the model does not declare`; `… › refuses a budget outside the declared range` |

**Implementation choice — how an effort is spelled.** The catalogue declares
the ladder (`reasoning.effort.values`) and the engine checks the overlay
against it; the *spelling* — the request field the level lands in — is the
catalogue's, per shape. The engine therefore knows what an effort **is**
(a named level on a ladder) without knowing what any endpoint calls it.

**Implementation choice — the merge order.** The shape's own body, then the
overlay's **body**, then the overlay's **fields**; the headers are merged over
the shape's own. The overlay's own parameters therefore win over the fragment
it brings, and both win over the shape's defaults. The specification names
the three channels but not their order.

---

## 5. The credentials

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the store is keyed by integration | "A store keyed by *integration*, not by provider" | `CredentialStore.list(integration)`; a credential stored under one integration is not visible under another | `the credentials › keys the store by the integration, not by the provider` |
| the three kinds | `key`, `oauth`, and `external` — "**no secret at all**" | the three kinds, and an `external` credential carries a reference and no secret | `… › holds the three kinds, and the third carries no secret at all` |
| the provider record has no secret | "**The provider record has no secret field, ever.**" | the provider's only credential member is an integration name; the engine resolves the secret elsewhere | `a provider is data, and one engine speaks it › never carries a secret` |
| the connections are derived | "the **stored** credentials for that integration, newest first; then the **environment variables** that are currently set" | `deriveConnections` builds exactly that list, and the stored ones are sorted newest first | `the credentials › derives the connections: the stored credentials first, newest first` |
| the environment is a first-class peer | "not a fallback, not a lesser kind" | an environment connection is a connection in its own right, with its own identity | `… › treats the environment as a first-class peer of a stored key` |
| the first is the active one | "**The first is the active one.**" | the first derived connection is the one the resolution uses | `… › makes the first connection the active one`; `… › uses the environment alone when nothing is stored` |
| the identity | "a stored credential by its id, an environment variable by its name" | `credential:<id>` and `env:<name>` | `… › derives the connections: the stored credentials first, newest first` |
| the secret lives in the operating system's store | "Where that store is not available, an **encrypted file** is used instead, and the difference is reported" | two stores — the credential store and the encrypted file — and the resolution reports which one it came from | `… › resolves a reference to a secret and reports where the secret came from`; `… › falls back to an encrypted file when the operating system store is not available` |

**Implementation choice — the credential reference's two kinds.**
`{ kind: 'integration', integration }` names the integration that owns the
credential; `{ kind: 'none' }` means the provider **names no integration at
all** — which is the third clause of the availability predicate. It does not
mean "this provider needs no secret": whether a secret is needed is the
deployment's decision, and the engine reports the refusal when there is
none.

**Implementation choice — an external reference cannot be resolved here.**
The specification says an `external` credential carries "**no secret at all**
— a reference to a secret managed somewhere else". This layer holds no such
secret, so the resolution **refuses**, and the refusal names the reference.
It does not send an empty credential and call it a success.

**Implementation choice — where an OAuth grant lives.** The grant is one JSON
document in the secret store, under the credential's own id, and the
resolution reads the access token out of it. The credential record carries
the *metadata* of the grant; the secret material never leaves the store.

---

## 6. "Connected" is one predicate

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| not disabled | "it is not disabled" | the first clause of `providerAvailability` | `"connected" is one predicate › is unavailable when the provider is disabled` |
| the connection has not changed | "its connection has not changed since it was last checked" | the checked connection identity is compared with the current one, and a change is a refusal that names both | `… › is unavailable when the connection has changed since it was last checked`; `… › is available when the connection has not changed` |
| force-enabled, a connection, or no integration | "either it is **force-enabled**, or its integration has **at least one** connection, or it **has no integration at all**" | the third clause, in that order | `… › is available when the provider is force-enabled, even with no connection`; `… › is unavailable when the integration has no connection`; `… › is available when the provider has no integration at all` |
| the whole picker follows from it | "There is no second notion of 'ready' anywhere" | one function; the engine asks it and the selection asks the same catalogue | `the whole path, against a fake backend › refuses a provider that is not connected, with the reason` |

**Implementation choice — a force-enabled provider does not survive a changed
connection.** The specification lists the three conditions as ones that must
*all* hold, and the changed-connection check comes before the force-enabled
one. A force-enabled provider with no connection is available; a
force-enabled provider whose connection changed is not, because mixing the
previous account's endpoints with a new credential is exactly what the
predicate exists to prevent.

---

## 7. Choosing a model — and the persistence

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the grammar | `provider/model#overlay` | `parseModelRef` and `formatModelRef` | `choosing a model › reads the grammar provider/model#overlay`; `… › writes the grammar back` |
| the explicit form | "for configuration, where the parts are named rather than written into a string" | `ModelRef` is `{ provider, model, overlay? }`, and every source may be given in either form | `choosing a model › takes the remembered model first…` |
| the precedence | remembered, the agent's own, the command line, the configured, the last used, the first available | `selectModel` consults the six in that order, and reports which one decided | `… › takes the remembered model first, then the agent, the command line, the configuration and the last used` |
| the first available | "the **first available**" | the first available model that can hold text, and that meets the requirements | `… › falls back to the first available model that can hold text` |
| filtering | the milestone's deliverable: "a selector that filters by capability and by effort" | `modelSatisfies` filters by input, output, tools, temperature and effort | `… › filters by capability and by effort` |
| no cross-provider fallback | "a selected model that has become unavailable **fails loudly**" | the chain stops at the first source that *names* a model, and a model that is not available is a refusal — never a fall-through | `choosing a model › fails loudly when a named model is not available, and never falls back`; `one model, many providers › never falls back to another provider when the chosen one is gone` |
| the user interface's preferences | "the recent list, the favourites, and the overlay chosen for each model — written atomically, and **watched for edits made elsewhere**" | `ModelPreferenceStore`: an atomic write (a temporary file, then a rename) and a watcher that reports only a real change | `the persistence — three separate stores › keeps the user interface preferences, and writes them atomically`; `… › watches the preferences for an edit made elsewhere` |
| the durable choice | "on the session's own record" | `DurableModelChoice` keeps the model under the `model` member of the session's record | `… › keeps the durable choice on the session own record` |
| the configuration's model | "the **configuration's** model" | it is one of the selection sources, not a store of this layer | `choosing a model › takes the remembered model first…` |

**Implementation choice — the chain stops at the first source that names a
model.** The specification lists the six sources in order and says the
selected model that has become unavailable fails loudly. Reading the chain as
"the first source that *has* one decides" is the only reading that keeps
that promise: a chain that fell through to the next source when the named
model was unavailable would be exactly the silent substitution the
specification forbids.

**Implementation choice — the sixth step is "the first available model that
can hold text".** §7 says "the first available" and §8 says "the first
available model that can hold text". The two are read as the same rule, and
the more specific wording wins.

**Implementation choice — the recent list keeps ten.** The specification says
"the recent list" and does not say how long it is. Ten is the number this
implementation uses, and it is a constant (`RECENT_LIMIT`) rather than a
number buried in the store.

**Implementation choice — the durable choice's carrier.** The specification
says the durable choice lives "on the session's own record" and does not say
which store holds that record. The layer defines the seam
(`SessionRecordCarrier`) and ships a file-backed carrier that writes one
record per session, atomically. The repository's own session store is the
first layer's, and the agent loop's milestone wires the two together.

---

## 8. One model, many providers — and the alias

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| one model, many providers | "**The same model appears under many providers.**" | the catalogue holds one entry per (provider, model), and the identity is the pair | `one model, many providers › carries the same model under many providers, and chooses none of them` |
| the agent does not choose | "There is **no cross-provider fallback**" | the selection names a provider, and the engine runs against that provider or fails | `one model, many providers › never falls back to another provider when the chosen one is gone`; `the whole path, against a fake backend › never falls back silently: a model that is gone fails, and no other provider is tried` |
| the only automatic choice is the default | "the configured default if there is one, and otherwise the first available model that can hold text" | the last step of the chain | `choosing a model › falls back to the first available model that can hold text` |
| the alias | "alias another provider's whole definition — its models, its capabilities, its cost, its limits, the spelling of its overlays — and change **only** the endpoint and the credential" | `aliasProvider` inherits the canonical's models and re-identifies them to the alias | `the dialect seam — not a vendor switch › addresses a first-party shape as a compatible one, with its own endpoint and credential`; `… › re-spells an alias that speaks another shape` |

**Implementation choice — the alias inherits the canonical's headers.** The
specification says the alias changes "only" the endpoint and the credential,
so the headers are the canonical's. An alias that declares its own headers
adds them — the headers are part of the endpoint's own vocabulary, and an
alias whose endpoint wants one must be able to say so.

---

## 9. What we deliberately do not build

| the specification says | what was implemented | the test that pins it |
|---|---|---|
| "**No compatibility apparatus.** … We have no published format and no ecosystem to preserve, so we build none of it" | there is no version migration, no prefix scheme and no table of rewriting rules anywhere in `src/model/` | the whole test file: nothing in the layer reads a published format |
| "**No vendor rules in our code.** … A rule in our code that asks what a particular model id contains is a rule that will be wrong for the next model" | the layer's model ids are opaque strings; the engine never inspects one. The test's own model ids are deliberately neutral (`alpha`, `beta`), so a test that asked what an id contains could not be written | `the overlays — where the effort lives › takes the spelling from the catalogue, not from a rule in the code` |

---

## 10. The rules the layer keeps

| the rule | how it is kept | the test |
|---|---|---|
| **Never fake success.** A method either returns a result, or returns an error with a reason, or reports the capability as not enabled with a reason. There is no third thing. | every failure is a `ModelLayerError` with a stable code and a sentence that names what was missing; nothing returns a partial result and calls it a success | `the whole path, against a fake backend › refuses a provider that is not connected…`; `… › refuses a model that has become unavailable…`; `… › refuses an endpoint that refuses…`; `… › refuses a credential that cannot be resolved…`; `… › refuses an attachment the model cannot take…`; `… › refuses an overlay the model does not offer…` |
| **Never fall back silently.** The model a turn selected is the model it runs against, or the turn fails. | the engine resolves one provider and one model and sends one request; a missing model fails before anything reaches the wire | `the whole path, against a fake backend › never falls back silently: a model that is gone fails, and no other provider is tried` |
| **Every refusal names what is missing.** | the reason is a sentence naming the provider, the model or the modality concerned | every refusal test above reads the reason |
| **No vendor's spelling in the engine.** | the spelling is the catalogue's, per shape | `the overlays — where the effort lives › takes the spelling from the catalogue, not from a rule in the code` |
| **The naming rule.** | the layer names the capabilities (`chat`, `messages`, `responses`) and no product and no company | `tests/contracts/naming.test.ts` |

---

## 11. What was not done, and why

| what | why |
|---|---|
| the **wire vocabulary of a particular deployment** — the exact headers, the version header, the parameter names | the specification puts a provider's own behaviour in **data**, and the naming rule keeps a product's vocabulary out of this repository. A deployment supplies them as provider headers or overlay headers, and the fake backend proves the mechanism works |
| the **retry policy** | the specification says "the retry policy retries the *same* call on the *same* provider", which is a statement about a policy that is not part of this milestone's deliverable. The engine sends one request and reports the failure |
| the **model list's richness at the far end** — the engine reads the models a provider reports and merges them over the snapshot; it does not itself ask a provider to *describe* a model | the catalogue is the catalogue: what a provider reports is what it reports, and the snapshot fills the gap |
| the **wiring of the durable choice to the repository's own session store** | the seam is here (`SessionRecordCarrier`) and a file-backed carrier ships with it; the agent loop's milestone owns the session store, which is the first layer's |
| the **pipeline, the approvals and the protocol's `model/*` methods** | the pipeline is `CC-045`, the approvals are `CC-046`, and the protocol surface is `CC-043`. This milestone owns the layer they speak |
| a **compatibility row** for the model layer | a divergence is not a compatibility claim. The target has no counterpart for this surface, and the report is a statement about the parity layer |

---

## 12. The readings, in one place

Every place the specification left a choice open, and the reading taken:

| # | the ambiguity | the reading | why |
|---|---|---|---|
| 1 | the model entry's fields, and how a model becomes unavailable | the seven fields the specification names, plus `enabled` | a model must be able to become unavailable, and the specification lists that as one of the failures this layer degrades with |
| 2 | the catalogue's merge granularity | per **model**, not per provider | "always wins" holds for the models the override names, and a provider's catalogue is not emptied by overriding one of its models |
| 3 | what "the same bytes" compares | the raw response bytes, before parsing | the promise is about the bytes that were returned |
| 4 | how an overlay is spelled, and what the engine knows about an effort | the catalogue declares the ladder and the spelling; the engine knows what an effort **is** and nothing about what it is called | the engine knows no vendor's spelling, and a rule that inspected a model id would be wrong for the next model |
| 5 | the three channels' merge order | the shape's body, then the overlay's body, then the overlay's fields | the overlay's own parameters win over the fragment it brings, and both win over the shape's defaults |
| 6 | an overlay with no spelling for the effective shape | refused, with a reason | a shape the overlay is not spelled for is a shape the model does not offer it on |
| 7 | the credential reference's `{ kind: 'none' }` | the provider names **no integration**; it does not mean "needs no secret" | the third clause of the availability predicate is about a provider with no integration |
| 8 | an `external` credential | refused, naming the reference | this layer holds no secret for it, and an empty credential is not a success |
| 9 | where an OAuth grant lives | one JSON document in the secret store | the secret material never leaves the store |
| 10 | whether a force-enabled provider survives a changed connection | it does not | the specification lists the three conditions as ones that must all hold |
| 11 | the chain's sixth step | the first available model that can hold text | §8's more specific wording wins over §7's |
| 12 | whether the chain falls through when the named model is unavailable | it does not; the selection fails loudly | the chain stops at the first source that *names* a model, which is the only reading that keeps "fails loudly" |
| 13 | a model reference that is not one | refused, with the form in the reason | a malformed reference is not a model, and the refusal says what the form is |
| 14 | how long the recent list is | ten, as a named constant | the specification does not say, and a constant can be changed in one place |
| 15 | which store holds the session's record | the layer defines the seam and ships a file-backed carrier | the repository's own session store belongs to the agent loop's milestone |
| 16 | the shapes' own headers | ours: `authorization`, `x-api-key`, `x-api-version` | the specification names the shapes and not their headers, and the naming rule keeps a product's vocabulary out of the repository |
