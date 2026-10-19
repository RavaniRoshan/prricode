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

## Conformance table

| Audit claim | Pinned by |
|---|---|
| The eight route names, exactly, with `gateway` first and `firstParty` last | `tests/contracts/provider-registry.test.ts` — "route set", "selectRoute" |
| The dispatch order is the target's, and a wrong order fails | same file — "selectRoute" |
| Each route's base-URL variable list, exactly, in the audit's order | same file — "the endpoint policy" |
| A base URL that does not match the vendor host is user-supplied | same file — "the endpoint policy" |
| A user-supplied endpoint is refused the credential unless the connection opts in, and the refusal names the host | same file — "the untrusted-endpoint guard" |
| A non-`https:` base URL is never vendor-trusted | same file — "the untrusted-endpoint guard" |
| `credentialStatus` reports presence only and never returns a secret | `tests/security/provider-credentials.test.ts` — "credentialStatus" |
| `credentialStatus` on a keychain reference never reads the keychain | same file — "the keychain reference" |
| `credentialStatus` on a file reference never reads the contents | same file — "the keychain reference" |
| `registry.list()` resolves no credential and contains no secret | same file — "the registry listing" |
| `resolveConnectionCredential` runs the endpoint check and then resolves | `src/provider/registry.ts` + its test |
| A malformed `ANTHROPIC_FOUNDRY_RESOURCE` is not vendor-trusted | `tests/contracts/provider-registry.test.ts` — "the endpoint policy" |
| The Foundry and Bedrock variable precedences are pinned | same file — "the endpoint policy" |
| `useConnection` fails loudly rather than silently not switching | same file — "the connection registry" |
| A registered flag that is explicitly disabled is not treated as set | same file — "selectRoute" |
| Two connections may share the same route | same file — "the connection registry" |
