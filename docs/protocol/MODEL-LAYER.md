# The model layer

**Our own multi-provider model layer.** This is the specification `CC-044` implements,
written from the research in `/home/shiva/opt/reference-agent-rea/analysis/findings-model-layer.md`
and from the three decisions taken in `docs/DIVERGENCE-LAYER-2.md`.

The **naming rule** applies: no third-party product or company is referenced, named or
cited. Where a *capability* is meant — an endpoint that speaks one API shape or another
— the capability is named, not the product that offers it.

---

## 1. The shape of the whole thing

**A provider is data, and one engine speaks it.** A provider entry carries:

| the field | what it is |
|---|---|
| `id` | the provider's own name, the one the user types |
| `dialect` | which API shape it speaks — see §2 |
| `endpoint` | the base URL, and the path shape |
| `credential` | a **reference** to a secret, never the secret |
| `headers` | the extra headers the endpoint wants, if any |
| `models` | the catalogue entries that belong to this provider |

**Adding a provider is adding an entry and a module.** It is never editing a registry,
and never a branch in the engine. There is exactly one code path per **dialect**, and
a provider's own quirks live in its entry.

---

## 2. The dialect seam — not a vendor switch

**The API shape a provider speaks is a property of its *path*, not of its name.** Three
dialects are first-class:

| the dialect | the shape it speaks |
|---|---|
| `chat` | the OpenAI-compatible shape: a chat-completions request, a streamed reply |
| `messages` | the Anthropic-compatible shape: a messages request, a streamed reply |
| `responses` | the response-oriented shape |

**One module per dialect**, and a provider's own behaviour — the parameter names it
wants, the fields it refuses — is layered on top as data.

**A provider that speaks a first-party shape may still be addressed as a compatible
one**, with its own endpoint and its own credential. That is a *convenience* boundary,
not a security boundary, and it is treated as one.

---

## 3. The catalogue

**The catalogue is fetched from each connected provider, and merged over a snapshot we
ship.**

The load order, and why:

1. a **local override** the user wrote — always wins;
2. the **fetched** catalogue — what the connected providers report, cached;
3. the **shipped snapshot** — what we know when a provider is not connected, or does
   not report.

So a provider that reports nothing does not empty our catalogue: its models are still
known, from the snapshot, and simply not connected.

**A fetch that returns the same bytes changes nothing** — not the cache, not the
refresh, not the notification. A client watching the catalogue is not woken for a
no-op.

### The model entry

| the field | what it is |
|---|---|
| `id` | the model's own name, as the provider writes it |
| `provider` | the provider it belongs to |
| `capabilities` | what it can do — the attachments it takes, whether it takes a temperature, whether it reasons |
| `cost` | the input and output prices |
| `limits` | its context window and its output ceiling |
| `overlays` | the named overlays this model offers — see §4 |
| `reasoning` | the **support kinds** it offers: an effort, a toggle, a token budget |

**A capability the model does not have is enforced, not ignored.** A model that cannot
take an attachment refuses it, in a form the user sees, rather than silently dropping
it from the request.

---

## 4. The overlays — where the effort lives

**The reasoning effort is not a number.** It is one of a family of **named overlays**,
and the same mechanism carries all of them:

| the overlay kind | what it does |
|---|---|
| `effort` | sets the effort the model should spend |
| `toggle` | turns a behaviour on or off — a thinking toggle |
| `budget_tokens` | caps the tokens a reasoning step may spend |
| a **named** overlay | one the user defines, carrying any request fields, headers or body |

A model entry's `overlays` is a list of these, each with the **request fields, the
headers and the body it contributes**. The engine applies an overlay and **knows no
vendor's spelling**.

> **This is the design's sharpest idea, and the one most likely to be missed.** The
> spelling of an overlay belongs to the **model and the dialect together** — so when
> the effective dialect changes, the overlays are **re-spelled**. The catalogue's
> declarative descriptor is what carries the spelling; our code does not.

**There is no "default effort" as a user-visible thing.** Selecting the pseudo-overlay
`default` means *no overlay at all* — the remote's own default, which is the only
default that is always right. A provider that has its own fallback states it in its
entry.

---

## 5. The credentials

**A store keyed by *integration*, not by provider**, in three kinds:

| the kind | what it holds |
|---|---|
| `key` | a secret the agent holds |
| `oauth` | a grant the agent holds |
| `external` | **no secret at all** — a reference to a secret managed somewhere else |

**The provider record has no secret field, ever.** A provider names an *integration*,
and the integration names the credential.

### The connections are derived, not stored

A **connection** is a way to reach an integration, and the list is *derived*:

1. the **stored** credentials for that integration, newest first;
2. then the **environment variables** that are currently set, each a connection in its
   own right.

**The first is the active one.** The environment is a first-class peer of a stored
key — not a fallback, not a lesser kind.

A connection's identity says which it is: a stored credential by its id, an environment
variable by its name.

### The storage

**The secret lives in the operating system's credential store.** Where that store is
not available, an **encrypted file** is used instead, and the difference is reported —
a caller can always ask *where* a secret came from.

---

## 6. "Connected" is one predicate

A provider is **available** when all three hold:

- it is not disabled;
- its connection has not changed since it was last checked; and
- either it is **force-enabled**, or its integration has **at least one** connection, or
  it **has no integration at all**.

**The whole picker, the availability filter and the credential resolution follow from
that one rule.** There is no second notion of "ready" anywhere.

---

## 7. Choosing a model

**The grammar is `provider/model#overlay`.** The explicit form — a provider, a model
and an overlay, given separately — is for configuration, where the parts are named
rather than written into a string.

### The precedence, in order

1. the model remembered **for this location and this agent**;
2. the **agent's** own model;
3. the model named on the command line;
4. the **configured** model;
5. the **last used**;
6. the **first available**.

### The persistence

Three separate stores, because they answer different questions:

- the **user interface's** preferences — the recent list, the favourites, and the
  overlay chosen for each model — written atomically, and **watched for edits made
  elsewhere**;
- the **durable** choice, on the session's own record;
- the **configuration's** model.

---

## 8. One model, many providers — and the choice is never made for the user

**The same model appears under many providers.** That is what the catalogue is for.

**And the agent does not choose.** There is **no cross-provider fallback**: the retry
policy retries the *same* call on the *same* provider, and a selected model that has
become unavailable **fails loudly**. A run that quietly used a different model than the
one that was asked for is a different run, and the report would be a lie.

The **only** automatic choice is the *default*: the configured default if there is one,
and otherwise the first available model that can hold text.

### The alias

**A provider may alias another provider's whole definition** — its models, its
capabilities, its cost, its limits, the spelling of its overlays — and change **only
the endpoint and the credential**. That is "the same model, but through my own
gateway", and it is the answer to having one model under many providers.

---

## 9. What we deliberately do not build

**No compatibility apparatus.** The largest cost in a design like this is the machinery
that preserves a published configuration format and an ecosystem: a version migration,
a prefix scheme, and tables of rewriting rules. **We have no published format and no
ecosystem to preserve**, so we build none of it.

**No vendor rules in our code.** Every provider-specific behaviour — the parameter
names it wants, the fields it refuses, the way it spells an effort — is **data in the
catalogue**. A rule in our code that asks what a particular model id contains is a
rule that will be wrong for the next model, and it is exactly the shape of maintenance
this design must not have.
