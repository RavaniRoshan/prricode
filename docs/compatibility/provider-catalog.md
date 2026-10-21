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
| The override is decided by the **enabled-flag set** the route layer hands in, and it is off when a caller supplies none | implementation choice (the target's own set is not observed) | F-07 | `tests/contracts/provider-registry.test.ts` — "is off when the enabled-flag set is not supplied" |

The route selector returns **exactly one** active route. The target's own per-model override layers on top: with Bedrock and Mantle both enabled, an `anthropic.*` model resolves to `mantle`; otherwise, if the catalog has no id for the selected route but has one for `mantle`, the model resolves to `mantle`. **This implementation reproduces the route selector and only the second half of the override**: the Bedrock+Mantle `anthropic.*` override is target-observed and not implemented, so the rows `F-07` and `F-08` are reported as `mismatch` in [`results.md`](results.md) — see the known limit below.

## What is the target's, and what is this implementation's extension

| Surface | Target | Implementation |
|---|---|---|
| Route selection | one active route from environment flags, and the per-model `wd(model)` override on top | **same selector** — this implementation reproduces the dispatch order, the single active route and **both** halves of the per-model override |
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

`provider_ids` carries a key per route — `first_party`, `bedrock`, `vertex`, `foundry`, `anthropic_aws`, `anthropic_google_cloud`, `mantle`, `gateway` — with a `null` value meaning **"not served by this provider"**. The distinction from "unknown" is load-bearing: a `null` id is a fact, and the route selector uses it to fall back to `mantle`. This implementation keeps the target's three states apart — a string for a route that serves the model, the target's `null` for one that does not, and **no key** for the one route the target's literal omits — so "not served" can never be confused with "not yet known", and the predicate is the target's own.

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

Every manager surface is reachable in **two** forms, and the **surface** selection lives in one place (`src/cli/commands/manager.ts`); the **form** — flag or word — is recorded by the parser (`src/cli/args.ts`) and reconstructed by the dispatcher (`src/cli/command.ts`), so the two surfaces cannot drift:

| Form | Example |
|---|---|
| the **word** form | `provider list`, `catalog list` — the word is read only when it is the **first** token, the placement a subcommand may take |
| the **flag** form | `--provider list`, `--catalog list` — the flag form names the surface unambiguously, because `--catalog list` cannot be a prompt; the **word** form names it only when it comes first |

The flag form writes a **machine-readable** document, and every such document carries the extension label.

### A run uses the active connection

**Project extension.** The target has no user-managed connection table, so it has no "active connection" for a run to use: its route selector yields exactly one route from environment flags, and its credential comes from the environment. The rule below is this implementation's own, and it exists because the manager is otherwise inert — a connection that can be registered, activated and resolved but that no run consults is a table nothing reads.

| Situation | What the run does |
|---|---|
| the connection table has **no** enabled connection | the run is **exactly** as it was: the route the environment selects, and no credential |
| the table has **one** enabled connection | the run uses that connection's **route**, its **base URL** and its **credential** |
| the active connection's credential **cannot** be resolved | the run is **refused**, and the refusal **names the connection** and the reference that is missing — never the secret |
| the table has **more than one** enabled connection | the run is **refused**, and the refusal names the connections: the table holds mutually exclusive choices |

The credential comes from **one** place: `resolveConnectionCredential`, the provider layer's only path from a reference to a value, and the path that runs the untrusted-endpoint guard first. The CLI never resolves a secret itself.

The **active connection wins** over the programmatic `credential` seam of `CommandOptions`: the connection table is the user's own configuration, and a run that ignored it would make the manager inert. The seam is what a caller uses when the session has **no** connection.

### The catalog source location

A connection says **where its catalog is read from**, in its `catalogSource` member: `builtin`, `file` or `url`. The connection is the routing identity; the catalog is the model metadata; the source is the join between them. A connection whose source is a file and that names no catalog file is refused with a named reason, and the same holds for a URL.

### The catalog and the connection table are two records

This is the load-bearing rule of the catalog surface, and it is what keeps a refresh from rewriting routing identity:

| Record | Holds | A refresh rewrites it |
|---|---|---|
| the **connection** | the id, the name, the route, the base URL, the credential **reference**, the catalog source | **never** |
| the **catalog** | the rows, their families, their per-route provider ids | **yes** |

A **user override** of a catalog-owned field lives in its **own** record and survives a refresh, because the refresh rewrites the catalog and not the overrides.

## The five authentication flows

**Target:** the pinned reference build `2.1.303`. The target has **five** distinct sign-in
paths, and they are not five spellings of one path: they differ in who issues the credential,
in what the credential is, in where it is stored, and in what the flow needs in order to run.

| Flow | The target's own names | Credential kinds | What it needs |
|---|---|---|---|
| `firstParty` | `claude auth login`, `claude auth status`, `claude auth logout`, `setup-token` | an OAuth access/refresh token, an API key | a registered OAuth client and a browser |
| `local` | the local endpoint table, `USE_LOCAL_OAUTH`, `USE_STAGING_OAUTH` | an OAuth access/refresh token, an API key | a local OAuth server and a client registered with it |
| `mcp` | `claude mcp login`, `claude mcp logout` | an MCP server's own OAuth token | the server's RFC 8414 registration and a browser |
| `sep990` | `claude mcp xaa setup｜login｜show｜clear` | an `id_token`, an IdP client secret | an OIDC identity provider |
| `hostDeviceOrg` | `CLAUDE_CODE_HOST_AUTH_ENV_VAR`, `CLAUDE_TRUSTED_DEVICE_TOKEN`, `forceLoginMethod` | a host-supplied credential, a trusted-device token | the host application, or an enrolled device |

**This implementation has no account and no login.** There is no OAuth client, no device flow,
no OIDC provider and no token store here. What it reproduces is the **shape** — the
discriminators, the state machines, the validation, the credential kinds and the storage — and
every flow **refuses** when it is invoked, and every refusal **names the capability it needed**.
Nothing pretends to authenticate.

### The state machines

Each flow's states are the target's own, and each is a *form* rather than a running machine.

| Flow | The states |
|---|---|
| `firstParty`, `local` | `idle`, `ready_to_start`, `console_method`, `platform_setup`, `waiting_for_login`, `polling`, `about_to_retry`, `success`, `storage_failed`, `error`, `account_on_hold`, `confirm_account` |
| `mcp` | `server_not_found`, `server_pending_approval`, `server_rejected`, `server_config_error`, `unsupported_transport`, `anthropic_hosted`, `claudeai_proxy`, `no_login_required`, `awaiting_redirect`, `cancelled`, `succeeded` |
| `sep990` | `url_input`, `connecting`, `trust_prompt`, `polling`, `token_cached`, `error` |
| `hostDeviceOrg` | `host_managed`, `device_enrollment_required`, `device_enrollment_disabled`, `org_pinned`, `not_applicable` |

The first-party and the local flow **share** their states: they are the same machine over two
different endpoint tables, and the target switches between the tables rather than between two
machines.

### The discriminators

| Discriminator | The target's rule | Matrix row | Pinned by |
|---|---|---|---|
| the login method | the managed settings can pin exactly three — `claudeai`, `console`, `gateway`; the forced method wins over the flags; a declared `gateway` is **suppressed** unless the host application manages the machine; a declared method that disagrees with the chosen one is reported | F-11 | `tests/contracts/auth-flows.test.ts` — "the login-method discriminator" |
| the MCP server kind | four kinds — `claudeai-proxy`, `unsupported-transport`, `anthropic-hosted`, `oauth` — decided in that order; the vendor-hosted case names the server and, when the record's scope allows it, the removal command | F-11 | same file — "the MCP server discriminator" |
| the MCP auth source | four sources — `static_auth_header`, `first_party_auth`, `first_party_design_auth`, `none` — checked in that order; every source but `none` means there is **no login to perform** | F-11 | same file — "the MCP auth-source discriminator" |
| the flow detector | the first-party flow always applies; the local flow applies when one of the three `CLAUDE_LOCAL_OAUTH_*_BASE` variables is set — the two switches `USE_LOCAL_OAUTH` and `USE_STAGING_OAUTH` are **not** part of the rule, because the pinned build's environment-kind function returns the literal `"prod"`; the MCP flow when there are servers to sign in to; the SEP-990 flow when the IdP is configured; the host/device/org flow when the host supplies a credential, a trusted-device token is present, or an organization is pinned | F-11 | same file — "the flow detector" |
| the first-party credential kind | exactly six — `none`, `third_party`, `claude.ai`, `api_key_helper`, `oauth_token`, `api_key` — decided in that order, with the `loggedIn` predicate beside it | F-11 | same file — "the first-party credential-kind discriminator" |

### The validation

Each rule is the target's own, and each carries the target's message.

| Rule | Message | Matrix row | Pinned by |
|---|---|---|---|
| the SEP-990 issuer must be `https:`, except on loopback | `Error: --issuer must be a valid URL (got "…")` / `Error: --issuer must use https:// (got "…")` | F-11 | `tests/contracts/auth-flows.test.ts` — "requires an https issuer, except on loopback" |
| the fixed callback port | `Error: --callback-port must be an integer in [1, 65535]` | F-11 | same file — "bounds the callback port" |
| the IdP client secret comes from the environment, never the command line | `Error: --client-secret requires MCP_XAA_IDP_CLIENT_SECRET env var` | F-11 | same file — "reads the IdP client secret from the environment, never the command line" |
| what an `--xaa` server is still missing | `Error: --xaa requires: --client-id, --client-secret, 'claude mcp xaa setup' (settings.xaaIdp not configured)` | F-11 | same file — "lists every requirement an --xaa server is missing" |
| the login flags are mutually exclusive | `Error: --console and --claudeai cannot be used together.` | F-11 | same file — "refuses --console together with --claudeai" |
| a custom OAuth endpoint must be on the approved list | `CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.` | F-11 | same file — "refuses a custom OAuth URL that is not on the approved list" |
| a refresh token needs its scopes | `CLAUDE_CODE_OAUTH_SCOPES is required when using CLAUDE_CODE_OAUTH_REFRESH_TOKEN.` | F-11 | same file — "requires scopes with a refresh token" |
| a sign-in that cannot be used is refused, for one of three reasons | no inference access, no refresh token, no expiry | F-11 | same file — "refuses a sign-in that cannot be refreshed" |

### The credential kinds and the storage

The credential kinds carry the target's own record keys and variable names: `claudeAiOauth`,
`mcpXaaIdp`, `mcpXaaIdpConfig` and `trustedDeviceToken` in the **secure storage**, and the
variables `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `MCP_XAA_IDP_CLIENT_SECRET`,
`CLAUDE_CODE_HOST_AUTH_ENV_VAR` and `CLAUDE_TRUSTED_DEVICE_TOKEN` in the environment. An MCP
server's own OAuth token lives in the **auth cache**, under a key of the form
`<server name>|<sixteen hex characters>` — a SHA-256 of the canonical JSON of the server's type,
URL and headers, truncated to sixteen characters.

**The trusted-device variable is `CLAUDE_TRUSTED_DEVICE_TOKEN`, not
`CLAUDE_CODE_TRUSTED_DEVICE_TOKEN`.** The untouched-surface record has the wrong name, and the
name is load-bearing: it is the variable the target reads, so an implementation that used the
other spelling would never see the token.

The credential file's **shape** is recorded — `.credentials.json`, mode `0600`, a 1 MiB read
ceiling, `O_NOFOLLOW` (a symlink is refused rather than followed), and the five read states
`absent`, `read-failed`, `corrupt`, `refused-symlink` and `present`. That file is the
**plaintext backend** of the target's secure storage — the same records the keychain backend
holds, in a file instead of the OS credential store. **No token store is shipped**: the
descriptor records where a credential *would* live and how it would be protected, and nothing
here writes one.

The **storage backends** are the target's own five — `keychain`, `plaintext`,
`windows-credman`, `keychain-with-plaintext-fallback` and
`windows-credman-with-plaintext-fallback` — and the **session-auth** vocabulary is its own
three — `fresh`, `previous` and `none`. The `auth status` command exits `0` when the session is
signed in and `1` when it is not.

### The refusals

| Flow | The capability it needs |
|---|---|
| `firstParty` | `oauth-authorization-code` |
| `local` | `local-oauth-server` |
| `mcp` | `mcp-server-oauth-registration` |
| `sep990` | `oidc-identity-provider` |
| `hostDeviceOrg` | `host-application-or-enrolled-device` |

A connection may name the flow that supplies its credential. Such a connection **refuses to
resolve** it, and the refusal names the capability; a connection that names no flow is
untouched, and its credential resolves exactly as it did before.

### The matrix row is not assigned by this milestone

The feature matrix and the compatibility report are the orchestrator's, and the five
authentication flows are **not** a row of `feature-matrix.md` at the time of writing. The rows
below therefore name **F-11** — the row that carries the **credential model** — and the
orchestrator may re-file the flows under a row of their own when it re-measures. The measured
outcome is in [`results.md`](results.md).

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
| A run with **no** enabled connection is exactly the run it always was, and a run with an active one uses that connection's route, base URL and credential | project requirement | F-10 | `tests/contracts/cli-surface.test.ts` — "CC-021 — a run uses the active connection" |
| The target has **five** distinct authentication flows, and this implementation names all five | REA observed | F-11 | `tests/contracts/auth-flows.test.ts` — "the five authentication flows" |
| Each flow carries the target's own credential kinds, its own state machine, and its own storage | REA observed | F-11 | same file — "the credential kinds and their storage", "the state machines" |
| The login method is one of exactly three, the forced method wins over the flags, and a declared `gateway` is suppressed unless the host manages the machine | REA observed | F-11 | same file — "the login-method discriminator" |
| The MCP server kind is one of exactly four, and the MCP auth source is one of exactly four | REA observed | F-11 | same file — "the MCP server discriminator", "the MCP auth-source discriminator" |
| The validation the target performs — the issuer rule, the callback port, the IdP secret, the `--xaa` requirements, the login flags, the custom endpoint, the refresh-token scopes and the unusable sign-in — is reproduced with the target's messages | REA observed | F-11 | same file — "the validation the target performs" |
| The first-party credential kind is one of exactly six, and the `loggedIn` predicate is the target's | REA observed | F-11 | same file — "the first-party credential-kind discriminator" |
| The credential file's shape — the name, the mode, the ceiling, the symlink refusal and the read states — is recorded | REA observed | F-11 | same file — "the credential store shape" |
| Every flow refuses, and every refusal names the capability it needed | project requirement | F-11 | same file — "refuses every flow by name, and names the capability it needed" |
| A connection that names a flow refuses to resolve its credential; a connection that names none is untouched | project requirement | F-11 | same file — "a connection that names an auth flow" |

## The manager surfaces — conformance

Every row of this table is a **project extension**: the target has no such surface, so there is no target behaviour to match. The measured outcome of the row is in [`results.md`](results.md).

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The credential status vocabulary is exactly `resolved`, `unresolved`, `unreadable` and `refused` | implementation choice | F-40 | `tests/contracts/provider-command.test.ts` — "reports a connection whose credential cannot be resolved as unusable, for that connection only", "reports a credential path that exists but cannot be read as unreadable", "reports a refused endpoint as refused, names the host, and never resolves the credential" |
| The listing carries **two** credential columns — `CREDENTIAL` (the reference) and `STATUS` — and never a value | implementation choice | F-40 | same file — "provider list prints one row per connection with its id, name, route, base URL, and credential status", "provider list shows no credential value even when the underlying environment variable is set" |
| The manager's verbs are `list`, `add`, `remove`, `use` and `test` | implementation choice | F-40 | same file — "provider add registers a connection whose credential is a reference, never a value", "provider remove removes a connection and reports an unknown id", "provider test resolves the credential through the guarded resolver and never prints the value" |
| `use` refuses an unusable connection and names it, and an `add --use` leaves the registry untouched | implementation choice | F-40 | same file — "provider use refuses an unusable connection and names it in the error", "provider add --use leaves the registry untouched when the connection is unusable" |
| The surfaces are reachable in **two** argv forms — the word form and the `--provider` / `--catalog` flag form — and the **flag** form is the machine-readable one | implementation choice | F-40 | same file — "exposes the same operations as --provider style flags with machine-readable output", "dispatches the --provider and the --catalog forms through one entry point" |
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
| A `null` provider id means "not served", and an **absent** key means the target's literal does not carry the route at all | REA observed | F-07 | same file — "reports a route the model does not serve as the target does" |
| An `Object.prototype` member name never resolves to a provider id | implementation choice | F-07 | same file — "does not resolve inherited Object.prototype members as provider ids" |
| The mantle half of the target's `wd(model)` rule is implemented | REA observed | F-07 | same file — "implements the mantle half of the target's rule" |
| The Bedrock+Mantle `anthropic.*` override is implemented, and says so | REA observed | F-07 | same file — "implements the Bedrock+Mantle anthropic.* override, and says so" |
| The "not served" predicate is the target's own `provider_ids[route] === null`, and not a superset of it | REA observed | F-07 | same file — "uses the audited predicate, and not a superset of it", "does not fall back for a route whose key the target's literal omits" |
| A caller cannot corrupt the shared catalog table | implementation choice | F-07 | same file — "hands out copies, so a caller cannot corrupt the shared table" |
| The catalog never reads the credential store | implementation choice | F-07 | same file — "never reads the credential store while the catalog is listed, imported, normalized or resolved" |
| A model that declares no `context` still normalizes | implementation choice | F-07 | same file — "normalizes a model that declares no context" |
| `listModels` matches the family and the query case-insensitively | implementation choice | F-07 | same file — "matches the family and the query case-insensitively" |
| `importCatalog` rejects an unknown `eager_input_streaming` key, a malformed alias key, and a `context` with no `window` | implementation choice | F-07 | same file — "rejects an unknown eager-input-streaming key", "rejects a malformed alias per_provider key", "rejects a context without a window" |

**Catalog facts, for the record.** 22 models. Families: `haiku`, `sonnet`, `opus`, `fable`, `mythos` (the target's order of first appearance). Nine models carry all eight route ids — `claude-haiku-4-5`, `claude-sonnet-5`, `claude-sonnet-5-5`, `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1` — and thirteen omit at least one. Eleven pricing tiers. Four aliases (`opus`, `sonnet`, `haiku`, `fable`) and four `latest_per_family` entries.

**The target's `wd(model)` rule has two halves, and this implementation implements both.** The "no id for the selected route but one for `mantle`" half is the mantle fallback; the **Bedrock+Mantle `anthropic.*` override** — with both routes enabled, an `anthropic.*` model resolves to `mantle` — is implemented through the **enabled-flag set** the route layer hands in (`enabledRoutes`), and it is **off** when a caller supplies none, so the two-argument callers keep their behaviour.ot implemented**, because it needs the enabled-flag set, which the catalog API does not take. The wiring point is `resolveRouteForModel` in `src/provider/catalog.ts`; the code says so in the file header and on the function.

**The "not served" predicate is the target's own.** The target's `provider_ids` has three states per route: a string (the route serves the model), `null` (the route does not) and an **absent** key (the target's literal does not carry it). The target's route selector tests `provider_ids[route] === null`, and an omitted key is **not** `null`: the target does not treat `claude-haiku-5-5` as unserved by `gateway`, and neither does this implementation. This implementation keeps the three states apart — `providerIds` carries the target's `null` verbatim, and `notServedOn` is the target's predicate, character for character. The two agree on **every** row of the built-in table.

---

# The endpoint catalogue and the corporate proxy

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** the target's own source, read out of the pinned build. Every claim below carries the file and the byte offset it was read at; the whole reading is in `/home/shiva/opt/reference-agent-rea/analysis/findings-endpoint-catalogue.md`.
**Owning task:** `CC-038` in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**Pinned by:** `tests/contracts/endpoint-catalogue.test.ts`.

## What this surface is, and what it is not

The **per-provider endpoint policy** above is one thing: the base-URL variables and the vendor-host pattern of each of the eight routes. The **endpoint catalogue** is a different thing: the table of **every host the product talks to**, the purpose each host serves, and the toggle that switches a whole service off. The target keeps it in the module `Jw` of `chunk-z6a1zj5w.js` — the **gateway** chunk — and it drives the target's *Egress Requirements* report.

The **corporate proxy** is a third thing again: the `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` environment, the `proxyAuthHelper` setting, and the proxy agent the target installs on its HTTP clients. It lives in `chunk-3q7vcbxf.js`.

**The honest boundary.** This implementation reaches the network through the provider driver. It has **no egress firewall**, **no catalogue of its own** and **no corporate proxy**. So:

- the catalogue and the rules that decide on it are **reproduced as data and as pure functions** — the target's own eleven services, its own toggle keys, its own host constants, its own grammar;
- the two **operations** that need a capability this implementation does not have — installing a corporate-proxy agent, and enforcing the egress firewall — **refuse**, and each refusal **names the capability it needed**;
- **no firewall is faked**. The catalogue this implementation carries is the target's catalogue, transcribed; it is not an invented allowlist, and nothing here claims to filter a request.

## The catalogue

**Eleven services**, in the target's own declaration order (`chunk-z6a1zj5w.js:1 256 200` – `1 259 100`).

| # | service | toggle | group | what it is for |
|---|---|---|---|---|
| 1 | `vm-bundle` | — | Core | the VM workspace bundle and the CLI binary |
| 2 | `model-catalog` | — | Core | the signed model-catalog metadata, polled every 5–15 minutes |
| 3 | `updater` | `disableAutoUpdates` | Auto-updates | the update feed and the binary releases |
| 4 | `sentry` | `disableEssentialTelemetry` | Essential telemetry | crash and error reporting |
| 5 | `datadog-rum` | `disableEssentialTelemetry` | Essential telemetry | performance timing |
| 6 | `anthropic-telemetry` | `disableNonessentialTelemetry` | Nonessential telemetry | analytics events, and the usage telemetry the sandboxed agent sends |
| 7 | `connector-favicons` | `disableNonessentialServices` | Nonessential services | connector favicons |
| 8 | `artifact-sandbox` | `disableNonessentialServices` | Nonessential services | the artifact-preview iframe and its asset CDNs |
| 9 | `mcp-app-sandbox` | `disableNonessentialServices` | Nonessential services | the MCP App widget iframe and the fonts it loads |
| 10 | `spellcheck-dictionary` | `disableNonessentialServices` | Nonessential services | the Linux spellcheck dictionary and its redirect targets |
| 11 | `dictation` | — | Core | the dictation service's `connect-src` source |

**The endpoint record.** `{host, path?, pathSuffix?, exactPath?, followRedirects?, origin: "renderer"|"main"|"subprocess", purpose?, cspDirective?, cspScheme?, firewallAlso?, firewallAlsoPurpose?, undeliveredAs503?, platforms?}`.

> **A discrepancy with the record.** `findings-untouched-surfaces.md` §G12 writes the field as `undeclaredAs503`. The target's own field name is **`undeliveredAs503`** (`chunk-z6a1zj5w.js:1 257 830`). This implementation uses the source's spelling, and the test pins it.

## The rules that decide

| rule | what the target does | where | what this implementation does |
|---|---|---|---|
| `resolveEndpoints` | calls the function form of a service's endpoints with the host context, then keeps an endpoint whose `platforms` list names the context's platform (an endpoint with no `platforms` is kept everywhere) | `chunk-z6a1zj5w.js:1 258 990` | **implemented** — `resolveEgressEndpoints` |
| `hostsForService` | the endpoint's host **plus** its `firewallAlso` companions | `:1 259 100` | **implemented** — `egressHostsForService` |
| `enabledServicesFromConfig` | a service with **no** toggle is always enabled; a service with a toggle is enabled until that toggle is on | `:1 259 400` | **implemented** — `enabledEgressServices` |
| the toggle resolver | the nested form wins over the flat one (`autoUpdate.disabled` over `disableAutoUpdates`; `telemetry.disableEssential` over `disableEssentialTelemetry`), and the value must be **exactly** `true` | `:1 259 300` | **implemented** — `egressToggleDisabled` |
| `firewallHostsForServices` | every enabled service's hosts, each paired with the service's toggle (or `null` for the core group) | `:1 259 600` | **implemented** — `firewallHostsForEgressServices` |
| `subprocessHostsForServices` | the hosts of the `origin:"subprocess"` endpoints | `:1 259 800` | **implemented** — `egressSubprocessHosts` |
| `rendererEgressRules` | the `origin:"renderer"` endpoints, reduced to `{host, path?, pathSuffix?, exactPath?, followRedirects?, undeliveredAs503?}` | `:1 259 950` | **implemented** — `rendererEgressRules` |
| `serviceLabelForToggleKey` | the core label for a toggle that names no service; the first service's label for a toggle it names; nothing for an unknown toggle | `:1 260 200` | **implemented** — `egressServiceLabel` |
| `computeEgressRequirements` | the enabled services' hosts, de-duplicated by host, each with the toggle that governs it (or `"core"`), **then** the managed fields whose `egressRequirements` name hosts | `:1 260 480` | **implemented for the service half** — `computeEgressRequirements`. The **managed-config half is not implemented**: this implementation has no managed-config field-meta table. The two producers the target declares for the fields this implementation's own settings document carries are implemented as `singleHostEgress` and `allowedEgressHostsRequirement`, and a caller supplies their output. |
| `egressRequirementLabel` | the service label for a toggle key, the managed field's own label otherwise | `:1 260 900` | **implemented for the service half** — `egressRequirementLabel`; an unknown field key has no label here |

## The host constants

**Twenty-six** host constants, plus the domain lists, all read from the module `pr` in `chunk-z6a1zj5w.js` (offsets **667 780** – **672 300**): `VM_BUNDLE_HOST` `downloads.claude.ai`, `UPDATE_FEED_HOST` `releases.claude.com`, `ANTHROPIC_API_HOST` `api.anthropic.com`, `CLAUDE_AI_HOST` `claude.ai`, `GCS_SIGNED_URL_HOST` `storage.googleapis.com`, `PLATFORM_CLAUDE_HOST` `platform.claude.com`, `FAVICON_PROXY_HOST` `www.google.com`, `GSTATIC_WILDCARD` `*.gstatic.com`, `ARTIFACT_IFRAME_HOST` `www.claudeusercontent.com`, `FRAME_ARTIFACT_CONTENT_HOSTS` (2), `MCP_APP_SANDBOX_WILDCARD_HOST` `*.claudemcpcontent.com`, `MCP_APP_SANDBOX_BASE_HOST` `sandbox.claudemcpcontent.com`, `ANTHROPIC_ASSETS_HOST` `assets.claude.ai`, `SENTRY_WILDCARD_HOST` `*.sentry.io`, `SENTRY_INGEST_HOST` `o1158394.ingest.us.sentry.io`, `SPELLCHECK_DICTIONARY_HOST` `redirector.gvt1.com`, `SPELLCHECK_DICTIONARY_WILDCARD` `*.gvt1.com`, `MICROSOFT_LOGIN_HOST` `login.microsoftonline.com`, `GOOGLE_ACCOUNTS_HOST` `accounts.google.com`, `GOOGLE_OAUTH2_HOST` `oauth2.googleapis.com`, `GOOGLE_STS_HOST` `sts.googleapis.com`, `GOOGLE_IAMCRED_HOST` `iamcredentials.googleapis.com`, `DATADOG_INTAKE_HOSTS` (7), `VERTEX_AUTH_HOSTS` (4), `MINIMAL_EGRESS_DOMAINS` (4), `DEPENDENCY_INSTALL_DOMAINS` (**19**), `PYTHON_EXTENSION_RUNTIME_HOSTS` (4).

## The egress-entry grammar

The target's own statement (`chunk-z6a1zj5w.js:672 200`):

> `` `*`, `localhost`, `host[:port]`, or `*.host[:port]` (port 1-65535; no port on bare `*`; no scheme, path, or IPv6 literal) ``

**Implemented** — `parseEgressHostEntry`, `stripEgressEntryPort` and `dropPortScopedEgressEntries`. The port is 1–65535; a bare `*` may not carry a port; an entry with a scheme, a path or an IPv6 literal is refused; the host is lowercased.

## The other helpers of the host-constant module

The target's host-constant module (`pr`) carries a few more helpers that belong to this surface, and they are implemented here:

| helper | what the target does | where | what this implementation does |
|---|---|---|---|
| `EGRESS_NOT_PROBED` | the four reasons a host is not probed for: `wildcard`, `ip-literal`, `plain http via proxy`, `link-local or cloud-metadata address` | `chunk-z6a1zj5w.js:671 000` | **implemented** — `EGRESS_NOT_PROBED`, `isEgressNotProbed` |
| `egressHostPort` | a cleartext address with no explicit port is `host:80`; every other address is its host | `:671 100` | **implemented** — `egressHostPort` |
| `splitEgressAddress` | only a cleartext address is split; every other address is an `https:` one **whole** | `:671 160` | **implemented** — `splitEgressAddress` |
| `egressAddress` | a secure URL is reduced to its host, a cleartext URL keeps its scheme | `:671 250` | **implemented**, with one named gap — see the clone-choice labels |
| `isAnthropicHost`, `isAnthropicFirstPartyHost` | the vendor's own host, and the first-party set (`anthropic.com`, `claude.ai`, `claude.com` and their subdomains) | `:667 930`, `:668 100` | **implemented** |
| the **derived** cloud hosts — `vertexInferenceHost`, `bedrockRuntimeHost`, `mantleRuntimeHost`, `foundryResourceHost`, `bedrockControlPlaneHost`, `awsSsoOidcHost`, `awsSsoPortalHost`, `bedrockSsoHosts`, `bedrockHosts` | the regional hosts the cloud providers are reached at | `:671 280` – `:671 800` | **not re-implemented here** — the per-provider endpoint policy and the driver layer already own the regional hosts, and the milestone says not to do that work twice |

## The corporate proxy

| part | what the target has | where | what this implementation does |
|---|---|---|---|
| the proxy variable | the **first** of `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY` that holds a truthy value wins; the lower-case name comes first | `chunk-3q7vcbxf.js:42 592` | **implemented** — `resolveProxyUrl` |
| the bypass list | `no_proxy` and `NO_PROXY`: `"*"` bypasses everything; otherwise both are used when they differ, and the one that is set when they agree | `:43 300` | **implemented** — `resolveNoProxy` |
| the bypass matcher | the list is split on commas and whitespace; an entry with a colon is compared against `host:port`; an entry that starts with a dot matches the host itself or any name ending with it; any other entry must equal the host | `:43 450` | **implemented** — `matchesNoProxy` |
| the invalid-proxy message | `Invalid proxy URL in <source>: "<value>" cannot be parsed as a URL.` / `Proxy settings must be a complete URL including the scheme, e.g. "http://proxy.example.com:8080".` / `Fix or unset <source> and restart <product>.` — the value's control characters are stripped first | `:42 790` | **implemented** — `proxyUrlError`. The last line names this implementation's product, because a **name** is not reproduced. |
| the proxy-auth helper's setting | `proxyAuthHelper`, a shell command that prints a `Proxy-Authorization` value | `chunk-c9s0jh80.js:253 428` | **implemented** — the setting is already in `src/config/schema.ts`; its configuration shape is `readProxyAuthHelperConfig` |
| the helper's configuration | `{helper, fromProjectOrLocal, trustAccepted, sources:"personAndPolicy"}`; the policy tier wins over the user tier; `fromProjectOrLocal` is true when the policy has none, the user has one, and the project or the local tier carries **the same** string | `chunk-8659jdnp.js` (the whole file) | **implemented** — `readProxyAuthHelperConfig` |
| the helper's switch | the helper runs **only** when `CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER` is set | `chunk-3q7vcbxf.js:45 060` | **implemented** — the variable is named by `PROXY_AUTH_HELPER_ENABLED_VARIABLE` |
| whether the helper may run | no helper → nothing to run; the switch off → nothing to run; a helper that came from a **project or a local** tier → **never** run | `chunk-3q7vcbxf.js:45 220`, `chunk-8659jdnp.js` | **implemented** — `decideProxyAuthHelper` |
| the helper's cache | five minutes by default; `CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS` overrides it when it names a number that is not negative | `:45 100` | **implemented** — `PROXY_AUTH_HELPER_TTL_MS`, `proxyAuthHelperTtl` |
| the two messages | `a proxy helper set by this project is not run by this command` and `Error: the proxy setting named above is refused.` | `chunk-8659jdnp.js` | **implemented** — `PROXY_AUTH_HELPER_PROJECT_MESSAGE`, `PROXY_SETTING_REFUSED_MESSAGE` |
| the proxy agent | the target installs a proxy agent on the API client and a global dispatcher on the fetch client, and runs the helper to fill the `Proxy-Authorization` header | `:45 000` | **refused** — `installCorporateProxyAgent` throws `CorporateProxyCapabilityError`, naming the capability `an outbound HTTP proxy agent that can carry a Proxy-Authorization header` |
| the mTLS client certificate | `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` | `:43 400` | **recorded, not implemented** — the target's client-certificate handling belongs to its HTTP client, which this implementation's driver layer owns |
| the CCR agent proxy | `AGENT_PROXY_URL` / `AGENT_PROXY_AUTH_TOKEN` and the `CCR_AGENT_PROXY_*` family | `chunk-c4r14hjp.js:50 024` | **recorded, not implemented** — this is the **remote-session relay**, not the corporate proxy; it is a different surface, and this milestone does not implement it |

## The sandbox network policy — the firewall's own side

The target's sandbox runtime declares the `sandbox.network` block in `chunk-3rfnbzz0.js` (offsets **11 700** – **14 600**). The block's keys are the target's own: `allowedDomains`, `deniedDomains`, `deniedDomainReasons`, `strictAllowlist`, `deniedResolvedAddresses`, `allowUnixSockets`, `allowAllUnixSockets`, `allowLocalBinding`, `allowMachLookup`, `httpProxyPort`, `socksProxyPort`, `mitmProxy`, `filterRequest`, `tlsTerminate`, `parentProxy`.

| rule | what the target does | where | what this implementation does |
|---|---|---|---|
| the host matcher | `*` covers every host; an entry that starts with `*.` covers a host that **ends with** the rest of the entry — so `*.corp.com` covers `a.corp.com` and `a.b.corp.com` but **not** `corp.com` — and it never covers an **address literal**; any other entry must equal the host | `chunk-ew44hcmm.js:21 523` | **implemented** — `sandboxHostMatches` |
| the entry's port | the port is the text after the **last** colon, and it is a port only when it is 1–65535 | `:21 314` | **implemented** — `parseSandboxHostEntry` |
| the port restriction | an entry that carries a port restricts itself to that port | `:21 900` | **implemented** — `sandboxHostEntryMatches` |
| the deny list | the **deny** list wins over the allowlist — "Domains that are always blocked, even if matched by allowedDomains" | `chunk-3rfnbzz0.js:11 700` | **implemented** — `evaluateSandboxEgress` |
| `deniedDomainReasons` | the reason is keyed by the **exact** entry string; an entry with no key uses a generic reason | `chunk-3rfnbzz0.js:11 700` | **implemented** — `evaluateSandboxEgress` |
| `strictAllowlist` | a host that is not on the allowlist is denied "without consulting the ask callback" | `chunk-3rfnbzz0.js:11 700` | **implemented** — `evaluateSandboxEgress` returns `deny` in that case, and `ask` otherwise |
| the merge across settings sources | `network.deniedDomains` is a **union**; every other member is taken **whole** from the highest source that sets it | `chunk-5gektv5j.js:5 899` | **implemented** — `mergeSandboxNetworkPolicies` |
| the enforcement | the target filters the request inside the sandbox runtime, before it is dialled | — | **refused** — `enforceSandboxEgress` throws `EgressFirewallCapabilityError`, naming the capability `the sandbox runtime egress firewall (the domain filter, the deny list, the strict allowlist and the resolved-address check)` |

## The enterprise gateway's internal-network allowlist

The `gatewayInternalNetworks` setting names the **public blocks** the organisation numbers its internal network from, so that a gateway inside one of them is reachable. The record (§G12) points at `chunk-c9s0jh80.js:338 751` — that is where the **settings schema** catches an invalid value and substitutes the unreadable stand-in. The **validator** is elsewhere: `chunk-dt3pd9ft.js:148 943` (`nh`).

**The target's rules, in its own order.**

1. a list that carries the stand-in `(unreadable)` is refused outright;
2. every entry is an IPv4 block written as **first-address/prefix**, with a prefix of at least `/8` and at most `/32`;
3. no entry may overlap the private, the shared, the documentation or the reserved address space;
4. the list carries **at most four** blocks;
5. no two entries overlap each other.

**Implemented** — `validateGatewayInternalNetworks`, with the target's own reason texts and the target's own message `gatewayInternalNetworks in managed settings <reason>.` The ranges the target declares are `GATEWAY_PRIVATE_NETWORKS` (6), `GATEWAY_SHARED_NETWORKS` (5, of which 3 are the documentation ranges), `GATEWAY_DOCUMENTATION_NETWORKS` (3) and `GATEWAY_RESERVED_NETWORKS` (3).

## The clone-choice labels this milestone adds

- The **catalogue** — the eleven services, their keys, their toggle keys, their group labels, their endpoints, their purposes, and the host constants — is **the target's own data**, REA observed, not an implementation choice. The only change is the two purpose strings and the core group label that name the target's product: this implementation names **PRRICODE** there, because a **name** is not reproduced and a **datum** is.
- The **rules** — the endpoint resolution, the platform filter, the service enablement, the toggle resolution, the firewall-host list, the subprocess hosts, the renderer rules, the service labels, the egress requirements, the egress-entry grammar, the `no_proxy` matcher, the proxy-variable precedence, the helper's TTL and the helper's configuration shape — are **the target's own**, REA observed.
- The **refusals** — the corporate-proxy agent and the egress-firewall enforcement — are **this implementation's own**, and each names the capability it needed.
- The **managed-config half of `computeEgressRequirements`** is **not reproduced**: this implementation has no managed-config field-meta table. The two producers the target declares for the fields this implementation's own settings document carries — `singleHostEgress` and the `allowedEgressHosts` rule — **are** implemented, and a caller supplies their output.
- The **credential-family refusal** in `egressAddress` is **not reproduced**: the target also refuses a URL whose authority matches one of the ten credential-family key patterns it declares. That table belongs to the credential-redaction surface, and this implementation refuses user information only. **A named gap.**
- The **sandbox network block's** members that this implementation does not act on — `deniedResolvedAddresses`, `mitmProxy`, `filterRequest` and `parentProxy` — are **recorded, not implemented**: they need the sandbox runtime's own proxy, which this implementation does not have.
- The **`gatewayInternalNetworks`** setting (the enterprise gateway's internal-network allowlist) is **implemented**: the validator is the target's own, with the target's reason texts, and the CIDR containment helper it uses is the target's own `H2` (`chunk-3q7vcbxf.js:35 560`) — which lives in the **proxy** module, so the two surfaces share it. The sign-in decision the list feeds — whether a gateway inside a listed block is accepted over a direct connection, and only when this machine's own address is inside the same block — is **not** implemented: it is the `/login` flow, and `CC-037` closed the authentication flows.

## What could not be established

- **Where the catalogue is consumed.** The catalogue and `computeEgressRequirements` live in the target's **gateway** chunk, which the CLI loads dynamically (`chunk-9y799w6p.js`, the `gateway` sub-command's `import("./chunk-z6a1zj5w.js")`). The report the requirements feed — the *Egress Requirements* panel — is therefore a **desktop** surface, and its rendering is not in this milestone's scope.
- **The `EGRESS_NOT_PROBED` reasons.** The target declares four — `wildcard`, `ip-literal`, `plain http via proxy`, `link-local or cloud-metadata address` (`chunk-z6a1zj5w.js:671 000`) — but the function that consumes them is not in the extracted tree, so the probe they belong to is **not established**.
- **The target's own host-entry drop behaviour for the sandbox allowlist.** The `allowedEgressHosts` field's own description says an invalid entry is "dropped with a log warning"; the drop is implemented in the managed-config layer, which this implementation does not have.
