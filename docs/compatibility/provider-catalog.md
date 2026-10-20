# Provider, route, and catalog conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.1 (providers and catalogs), §2.2 (request construction), §2.2a (the adapter wire shapes, re-derived from the pinned binary).
**Owning task:** `CC-004` (registry, credentials, route selection) and `CC-005` (catalog) in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**Matrix rows:** F-06 … F-15 in [`feature-matrix.md`](feature-matrix.md).

## The eight routes

Exactly eight, with the target's dispatch order:

| Order | Route | Target provider flag | Base-URL variables | Vendor host shape |
|---|---|---|---|---|
| 1 | `gateway` | gateway condition (a settings key) | — | — |
| 2 | `bedrock` | `CLAUDE_CODE_USE_BEDROCK` | `ANTHROPIC_BEDROCK_BASE_URL`, `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, `AWS_ENDPOINT_URL_BEDROCK`, `AWS_ENDPOINT_URL` | `bedrock`/`bedrock-runtime` regional host |
| 3 | `foundry` | `CLAUDE_CODE_USE_FOUNDRY` | `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_RESOURCE` | `<name>.services.ai.azure.com` |
| 4 | `anthropicAws` | `CLAUDE_CODE_USE_ANTHROPIC_AWS` | `ANTHROPIC_AWS_BASE_URL` | `aws-external-anthropic` regional host |
| 5 | `anthropicGoogleCloud` | `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` | `ANTHROPIC_GOOGLE_CLOUD_BASE_URL` | `claude` / `*.googleapis.com` |
| 6 | `mantle` | `CLAUDE_CODE_USE_MANTLE` | `ANTHROPIC_BEDROCK_MANTLE_BASE_URL` | `bedrock-mantle` regional host |
| 7 | `vertex` | `CLAUDE_CODE_USE_VERTEX` | `ANTHROPIC_VERTEX_BASE_URL` | `aiplatform` / `*.googleapis.com` |
| 8 | `firstParty` | (default) | — | `api.anthropic.com` |

The route selector returns **exactly one** active route. The target's own per-model override layers on top: with Bedrock and Mantle both enabled, an `anthropic.*` model resolves to `mantle`; otherwise, if the catalog has no id for the selected route but has one for `mantle`, the model resolves to `mantle`.

## What is the target's, and what is this implementation's extension

| Surface | Target | Implementation |
|---|---|---|
| Route selection | one active route from environment flags | **same** — this implementation reproduces it |
| Model catalog | **built in**, provider-owned, one row per logical model with a `provider_ids` map across all eight providers | **same** — this implementation reproduces the catalog |
| Connection registry | **does not exist** | **the extension**: N concurrent connections, each with a free-form name, a route, a base URL, and a credential *reference* |
| Credential model | per-route credential resolution order (bearer-token env var → skip-auth → AWS credential chain → provider-chain resolver) | **the extension**: credentials are always *references* (env var name, file path, OS keychain key) and never values in a catalog |

The registry is labelled as an extension in `src/provider/registry.ts` (file header and the `Connection` doc comment), and the audit's negative finding is cited by name.

## Credentials are references

- `credentialStatus` reports **presence only** and never returns a secret.
- For a **keychain** reference it does not touch the keychain at all, so a listing can never trigger an OS prompt.
- For a **file** reference it uses `stat`/`access` and never reads the contents, so a status check never pulls a secret into memory.
- `resolveCredential` is the single resolution point; nothing else resolves.
- `registry.list()` resolves nothing, and `JSON.stringify(registry.list())` contains only the reference.

**The guarded resolution entry point.** `resolveConnectionCredential(connection)` is the documented way to obtain a credential for a request: it runs the endpoint check **and then** resolves, throwing with the offending host named when the check refuses. The endpoint check refuses a credential for a **user-supplied** base URL — one that does not match the provider's vendor-host pattern — unless the connection explicitly opts in, and it refuses any base URL that is not `https:`.

**Known consequence of the observed vendor-host shapes.** The audit's `anthropicGoogleCloud` and `vertex` host shapes both accept `*.googleapis.com`, so a base URL such as `https://attacker.googleapis.com` is classified as a vendor host. This is **spec-conformant** — it is what the target declares — and it is pinned by a test so a future change is deliberate. This implementation's `CC-006` driver layer may narrow it, but it must not claim vendor-trust semantics the target does not have.

## The provider-owned model catalog

Each catalog row is `{ id, family, display_name, knowledge_cutoff?, provider_ids, eager_input_streaming?, vertex_region_env_var?, max_output_tokens: { default, upper }, pricing?, capabilities[] }`.

`provider_ids` carries a key per route — `first_party`, `bedrock`, `vertex`, `foundry`, `anthropic_aws`, `anthropic_google_cloud`, `mantle`, `gateway` — with a `null` value meaning **"not served by this provider"**. The distinction from "unknown" is load-bearing: a `null` id is a fact, and the route selector uses it to fall back to `mantle`. This implementation models this with an absent key rather than a nullable one, so "not served" can never be confused with "not yet known".

## The adapter wire shapes (observed in the pinned binary)

Read from the target's own bundled adapters — `chunk-1njnz05e.js` (Bedrock and Mantle), `chunk-jdnh8sjs.js` (Vertex), `chunk-m5c0c57d.js` (Foundry).

**Bedrock**
- Body field `anthropic_version: "bedrock-2023-05-31"`, set by the adapter when the body does not already carry it.
- The rewritten paths are exactly `/v1/complete`, `/v1/messages`, and `/v1/messages?beta=true`.
- The `anthropic-beta` **header** is moved into the body's `anthropic_beta` array, split on `,` and **trimmed**, and only when the body does not already carry it.
- `model` and `stream` are **deleted from the body**; the path becomes `/model/<model>/invoke` or `/model/<model>/invoke-with-response-stream`, chosen by the body's `stream` flag; the `beta` **search parameter is deleted**.
- A non-JSON body throws `Expected request body to be a JSON object for post <path>`.
- Auth is SigV4 with service `bedrock` and region `awsRegion`, unless a Bedrock bearer token is present, which takes precedence and suppresses SigV4.

**Mantle**
- Anthropic-native body; base `https://bedrock-mantle.<region>.api.aws/anthropic`; the SigV4 **service name is `bedrock-mantle`**; betas travel in the `anthropic-beta` **header**.

**Vertex**
- Body field `anthropic_version: "vertex-2023-10-16"`, set when absent.
- `model` is **deleted from the body but `stream` is kept**, and the endpoint suffix follows the body's `stream`: `streamRawPredict` when true, `rawPredict` otherwise. The path becomes `<prefix>/projects/<projectId>/locations/<region>/publishers/anthropic/models/<model>:<suffix>`; the `beta` search parameter is deleted.
- `count_tokens` becomes `.../models/count-tokens:rawPredict`.
- A missing project throws `No projectId was given and it could not be resolved from credentials. The client should be instantiated with the 'projectId' option or the 'ANTHROPIC_VERTEX_PROJECT_ID' environment variable should be set.`

**Foundry**
- `baseURL` and `resource` are **mutually exclusive**: both ⇒ `baseURL and resource are mutually exclusive`; neither ⇒ `Must provide one of the 'baseURL' or 'resource' arguments, or the ANTHROPIC_FOUNDRY_RESOURCE environment variable`. With only a resource, the base URL is `https://<resource>.services.ai.azure.com/anthropic/` **with a trailing slash**.
- `apiKey` and `azureADTokenProvider` are **mutually exclusive**: both ⇒ `The 'apiKey' and 'azureADTokenProvider' arguments are mutually exclusive; only one can be passed at a time.` Neither ⇒ `Missing credentials. Please pass one of 'apiKey' and 'azureTokenProvider', or set the ANTHROPIC_FOUNDRY_API_KEY environment variable.` (the target's own message names `azureTokenProvider` while the parameter is `azureADTokenProvider`).
- The API key may be an **async function**; `authHeaders` awaits it.
- The Foundry adapter exposes **no models API**.

**The beta path marker is a distinct path variant, not a conditional.** The target's own path set contains both `/v1/messages` and `/v1/messages?beta=true`, and the Bedrock and Vertex adapters both **strip** the `beta` search parameter on the way out. This implementation implements both variants and records the discrepancy rather than gating the marker on a flag.

## Request and response construction

- `Messages.create` warns on deprecated models and on `thinking.type === "enabled"`, computes the timeout as `options.timeout ?? client._options.timeout` and otherwise from the model's output-token limit and the requested `max_tokens`, merges beta headers, and posts to `/v1/messages` with a `600000` ms **fallback**.
- `shouldRetry` retries on `401` when a cached token was used and not yet refreshed, honours `x-should-retry` in both directions, and retries `408`, `409`, `429`, and any status `>= 500`.
- `buildHeaders` sets `Accept`, `User-Agent` (`Anthropic/JS <version>`), `X-Stainless-Retry-Count`, `X-Stainless-Timeout` (seconds), `anthropic-version: 2023-06-01`, and `anthropic-dangerous-direct-browser-access: true` when `dangerouslyAllowBrowser` is set.
- The default `parseResponse` is `ai(client, context)`: streaming → `SSEParser.fromSSEResponse`; `204` → `null`; a binary-response option → the raw response; a JSON content type → `buildMessage(await response.json(), response)`, which attaches the **non-enumerable** `_request_id` (from `request-id`) and `_workspace_id` (from `anthropic-workspace-id`); anything else → `response.text()`.
- The SDK's SSE parser accepts an **extended event vocabulary** beyond the public API: `agent.*` (twelve names), `session.*` (thirteen), `span.*` and `outcome_evaluation.*` (five), `user.*` (six), plus `event_start`, `event_delta`, `system.message` and a legacy `completion`. The application bundle references only `agent.message` and `user.interrupt` from the extended set, so this is a **forward-compatible parser**, not evidence of a multi-agent protocol. This implementation must accept the core events and **tolerate** the extended ones.

## The local gateway

`chunk-z6a1zj5w.js` contains a first-party local gateway that proxies Anthropic-shaped traffic: `POST /v1/messages` and `POST /v1/messages/count_tokens`; a `cc-gateway/<version>` user agent; a body containing `workspace_id` rejected with `400 invalid_request_error: "workspace_id: not supported through the gateway"`; Bedrock `count_tokens` computed locally or answered `501 not_supported` with `x-should-retry: false`; the upstream stream re-framed as SSE with keep-alive comments and a rewritten `message_start.message.model`; and, for Bedrock upstreams, the `anthropic-beta` header moved into the request body.

## The manager surfaces (project extension)

**The whole surface is a project extension.** The target has **no** user-managed registry of provider connections and no catalog browser: its route selector yields exactly one active route from environment flags, and the model catalog is built in and provider-owned (audit §2.1, "Important negative finding"). Everything below is this implementation's own product surface, and every one of its outputs **says so** — in the text output, in the `--help`, and in the machine-readable document.

### The credential status vocabulary

The listing reports a **status**, never a value. The vocabulary is exactly four names:

| Status | Meaning |
|---|---|
| `resolved` | the reference names something that is present. For a keychain reference this reports the **reference's** completeness, because a listing never reads the OS credential store. |
| `unresolved` | nothing is there. |
| `unreadable` | something is there, but it cannot be read. |
| `refused` | the reference is fine, but this implementation refuses to deliver the credential to the connection's endpoint (the untrusted-endpoint guard). The refusal names the **host**, which is a fact about the endpoint and not about the secret. |

### The two credential columns

The `list` output carries **two** credential columns and no third:

| Column | What it holds |
|---|---|
| `CREDENTIAL` | the **reference** — `env:<name>`, `file:<path>` or `keychain:<service>/<account>` — never a value |
| `STATUS` | the status from the vocabulary above |

The line under the table says so in words: *CREDENTIAL is a reference, never a value.*

### The verbs

The manager's verbs are **five**: `list`, `add`, `remove`, `use` and `test`. The catalog browser has **five** of its own: `list`, `search`, `show`, `refresh` and `override`.

| Verb | What it does |
|---|---|
| `list` | prints one row per connection: its id, name, route, base URL, credential reference and credential status |
| `add` | registers a connection; the credential is a **reference**, and a raw value is refused before anything else happens |
| `remove` | removes a connection and reports an unknown id |
| `use` | makes a connection the active one |
| `test` | resolves the credential through the guarded resolver and probes the endpoint, with the value **redacted** out of every message it reports |

### The `use` refusal

`use` **refuses an unusable connection and names it**. A connection whose credential cannot be resolved is unusable **for that connection only**: the listing reports it and keeps going, the other connections are untouched, and the active-connection resolution refuses to select it rather than routing to a route that cannot work.

An `add --use` runs the same usability check **before** the connection is added, so a refused `--use` leaves the registry exactly as it was.

### The two argv forms

Every manager surface is reachable in **two** forms, and the decision between them lives in **one** place (`src/cli/commands/manager.ts`), so the two surfaces cannot drift:

| Form | Example |
|---|---|
| the **word** form | `provider list`, `catalog list` — the word is read only when it is the **first** token, the placement a subcommand may take |
| the **flag** form | `--provider list`, `--catalog list` — the flag form wins over the word form, because `--catalog list` is unambiguous while a prompt that merely mentions "catalog" is not |

The flag form writes a **machine-readable** document, and every such document carries the extension label.

### The catalog source location

A connection says **where its catalog is read from**, in its `catalogSource` member: `builtin`, `file` or `url`. The connection is the routing identity; the catalog is the model metadata; the source is the join between them. A connection whose source is a file and that names no catalog file is refused with a named reason, and the same holds for a URL.

### The catalog and the connection table are two records

This is the load-bearing rule of the catalog surface, and it is what keeps a refresh from rewriting routing identity:

| Record | Holds | A refresh rewrites it |
|---|---|---|
| the **connection** | the id, the name, the route, the base URL, the credential **reference**, the catalog source | **never** |
| the **catalog** | the rows, their families, their per-route provider ids | **yes** |

A **user override** of a catalog-owned field lives in its **own** record and survives a refresh, because the refresh rewrites the catalog and not the overrides.

## Conformance table

| Audit claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- |
| The eight route names, exactly, with `gateway` first and `firstParty` last | REA observed | F-06 | `tests/contracts/provider-registry.test.ts` — "route set", "selectRoute" |
| The dispatch order is the target's, and a wrong order fails | REA observed | F-08 | same file — "selectRoute" |
| Each route's base-URL variable list, exactly, in the audit's order | REA observed | F-09 | same file — "the endpoint policy" |
| A base URL that does not match the vendor host is user-supplied | REA observed | F-09 | same file — "the endpoint policy" |
| A user-supplied endpoint is refused the credential unless the connection opts in, and the refusal names the host | implementation choice | F-09 | same file — "the untrusted-endpoint guard" |
| A non-`https:` base URL is never vendor-trusted | implementation choice | F-09 | same file — "the untrusted-endpoint guard" |
| `credentialStatus` reports presence only and never returns a secret | project requirement | F-11 | `tests/security/provider-credentials.test.ts` — "credentialStatus" |
| `credentialStatus` on a keychain reference never reads the keychain | implementation choice | F-11 | same file — "the keychain reference" |
| `credentialStatus` on a file reference never reads the contents | implementation choice | F-11 | same file — the `credentialStatus` block |
| `registry.list()` resolves no credential and contains no secret | project requirement | F-11 | same file — "the registry listing" |
| `resolveConnectionCredential` runs the endpoint check and then resolves | project requirement | F-10 | `src/provider/registry.ts` + its test |
| A malformed `ANTHROPIC_FOUNDRY_RESOURCE` is not vendor-trusted | REA observed | F-09 | `tests/contracts/provider-registry.test.ts` — "the endpoint policy" |
| The Foundry and Bedrock variable precedences are pinned | REA observed | F-09 | same file — "the endpoint policy" |
| `useConnection` fails loudly rather than silently not switching | project requirement | F-10 | same file — "the connection registry" |
| A registered flag that is explicitly disabled is not treated as set | implementation choice | F-08 | same file — "selectRoute" |
| Two connections may share the same route | project requirement | F-10 | same file — "the connection registry" |

## The manager surfaces — conformance

Every row of this table is a **project extension**: the target has no such surface, so there is no target behaviour to match. The measured outcome of the row is in [`results.md`](results.md).

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The credential status vocabulary is exactly `resolved`, `unresolved`, `unreadable` and `refused` | implementation choice | F-40 | `tests/contracts/provider-command.test.ts` — "reports a connection whose credential cannot be resolved as unusable, for that connection only", "reports a credential path that exists but cannot be read as unreadable", "reports a refused endpoint as refused, names the host, and never resolves the credential" |
| The listing carries **two** credential columns — `CREDENTIAL` (the reference) and `STATUS` — and never a value | implementation choice | F-40 | same file — "provider list prints one row per connection with its id, name, route, base URL, and credential status", "provider list shows no credential value even when the underlying environment variable is set" |
| The manager's verbs are `list`, `add`, `remove`, `use` and `test` | implementation choice | F-40 | same file — "provider add registers a connection whose credential is a reference, never a value", "provider remove removes a connection and reports an unknown id", "provider test resolves the credential through the guarded resolver and never prints the value" |
| `use` refuses an unusable connection and names it, and an `add --use` leaves the registry untouched | implementation choice | F-40 | same file — "provider use refuses an unusable connection and names it in the error", "provider add --use leaves the registry untouched when the connection is unusable" |
| The surfaces are reachable in **two** argv forms — the word form and the `--provider` / `--catalog` flag form — and both are machine-readable | implementation choice | F-40 | same file — "exposes the same operations as --provider style flags with machine-readable output", "dispatches the --provider and the --catalog forms through one entry point" |
| A connection's `catalogSource` says where its catalog is read from — `builtin`, `file` or `url` | implementation choice | F-40 | same file — "rewrites the catalog without changing a connection id, name, route, or credential reference" |
| The catalog and the connection table are **two records**: a refresh rewrites the catalog and never the connection, and a user override survives the refresh | implementation choice | F-40 | same file — "rewrites the catalog without changing a connection id, name, route, or credential reference", "keeps a user override of a catalog-owned field across a refresh" |
| A keychain credential is shown as configured without ever reading the OS credential store | implementation choice | F-40 | same file — "shows a keychain credential as configured without ever reading the OS credential store" |
| Every surface labels itself as a project extension | project requirement | F-40 | same file — "labels the provider manager as a project extension wherever it surfaces" |

## Catalog conformance

| Audit claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- |
| The built-in catalog is the target's literal, digest for digest | REA observed | F-07 | `tests/contracts/provider-catalog.test.ts` — "is the target's literal, digest for digest" (pinned SHA-256 `77b3c0cadfe76ee1dccaadc617edf8ad9c7d488d50e05782087be987cf91a8f8`, `_provenance` excluded) |
| The pinned digest changes when a model id or a provider id changes | implementation choice | F-07 | same file — "changes the pinned digest when a model id or a provider id changes" |
| All 22 model ids, in order, and every per-provider id, are pinned | REA observed | F-07 | same file — "pins every model id and every provider id of the target's literal" |
| The 11 pricing-tier keys and the 4 alias keys are pinned | REA observed | F-07 | same file — "pins the pricing-tier keys and the alias keys" |
| The catalog's `provider_ids` key names are the target's own eight (`anthropic_aws`, `anthropic_google_cloud`, `bedrock`, `first_party`, `foundry`, `gateway`, `mantle`, `vertex`) | REA observed | F-07 | same file — "maps the target's provider ids onto the routes explicitly" |
| Nine models are served by all eight routes and thirteen omit at least one | REA observed | F-07 | same file — "serves one model by all eight routes", "omits at least one route for another model" |
| A `null` provider id means "not served", and is distinct from "unknown" | REA observed | F-07 | same file — "reports a route the model does not serve as absent, not as unknown" |
| An `Object.prototype` member name never resolves to a provider id | implementation choice | F-07 | same file — "does not resolve inherited Object.prototype members as provider ids" |
| The mantle half of the target's `wd(model)` rule is implemented | REA observed | F-07 | same file — "implements the mantle half of the target's rule" |
| The Bedrock+Mantle `anthropic.*` override is **not** implemented, and says so | REA observed + implementation choice | F-07 | same file — "does not implement the Bedrock+Mantle anthropic.* override, and says so" |
| "Not served" is a documented superset of the audited `=== null` predicate, differing by exactly one row | implementation choice | F-07 | same file — "is a superset of the audited predicate, and the difference is exactly one row" |
| A caller cannot corrupt the shared catalog table | implementation choice | F-07 | same file — "hands out copies, so a caller cannot corrupt the shared table" |
| The catalog never reads the credential store | implementation choice | F-07 | same file — "never reads the credential store while the catalog is listed, imported, normalized or resolved" |
| A model that declares no `context` still normalizes | implementation choice | F-07 | same file — "normalizes a model that declares no context" |
| `listModels` matches the family and the query case-insensitively | implementation choice | F-07 | same file — "matches the family and the query case-insensitively" |
| `importCatalog` rejects an unknown `eager_input_streaming` key, a malformed alias key, and a `context` with no `window` | implementation choice | F-07 | same file — the three "rejects …" tests |

**Catalog facts, for the record.** 22 models. Families: `haiku`, `sonnet`, `opus`, `fable`, `mythos` (the target's order of first appearance). Nine models carry all eight route ids — `claude-haiku-4-5`, `claude-sonnet-5`, `claude-sonnet-5-5`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1` — and thirteen omit at least one. Eleven pricing tiers. Four aliases (`opus`, `sonnet`, `haiku`, `fable`) and four `latest_per_family` entries.

**Known limit, stated plainly.** The target's `wd(model)` rule has two halves. This implementation implements the "no id for the selected route but one for `mantle`" half. The **Bedrock+Mantle `anthropic.*` override is target-observed and not implemented**, because it needs the enabled-flag set, which the catalog API does not take. The wiring point is `resolveRouteForModel` in `src/provider/catalog.ts`; the code says so in the file header and on the function.

**A second, smaller divergence.** This implementation treats an **absent** `provider_ids` key as "not served", which is a superset of the audited `provider_ids[route] === null` predicate. The two agree on 21 of 22 rows; the difference is exactly `claude-haiku-5-5` on `gateway`, the one row whose `gateway` key the target's literal omits entirely rather than setting to `null`. The superset is documented and pinned, not silently kept.
