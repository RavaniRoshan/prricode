# Research report — the pinned reference build (2.1.303) compatible implementation

**Date:** 2026-10-19
**Depth:** deep
**Purpose:** support and refine the implementation plan at [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md)

**Authority note.** This report is **external product and protocol context**. It is not evidence about the pinned the pinned reference build `2.1.303` binary. The authority for what the target does is the [REA coverage audit](../docs/reverse-engineering/COVERAGE-AUDIT.md), which cites the retained Evidence records. Where this report describes a the reference agent's behavior, the behavior is a *documented* or *third-party-observed* one, and it is labelled as such. Several sources describe **later** the reference agent releases than the pinned target; §9 lists exactly which findings are version-sensitive so that the plan does not silently inherit post-2.1.303 behavior.

---

## Executive summary

The target is a Bun-packaged 285 MB x86-64 ELF that ships a bundled Anthropic TypeScript SDK, eight provider routes, a built-in provider-owned model catalog, a local Anthropic-shaped gateway, a permission engine with a deny→ask→allow rule precedence, a 33-event hook system, a 23-subtype control-request surface, and a JSONL session transcript under `~/.claude/projects/`. The research establishes the **wire-level contracts** this implementation must implement, the **design precedents** for the multi-provider manager that is this implementation's deliberate extension, the **library choices** that survive on Node 24, and a substantial list of **known failure modes in the target's own design** that this implementation must not reproduce.

Five findings change the plan materially. First, the provider protocol is not one protocol: Bedrock takes `anthropic_version: "bedrock-2023-05-31"` in the body with the model in the URL and no `stream` field, and its streaming is a **binary eventstream, not SSE**; Vertex takes `"vertex-2023-10-16"` with the model in the URL and *keeps* `stream`; Foundry is Anthropic-native but its `model` is an Azure *deployment name*. Second, the permission rule precedence is `deny → ask → allow` with **first match wins and specificity irrelevant** — a broad deny beats a narrow allow, which is the opposite of most users' expectation. Third, session resume is **not a file replay**: the loader indexes by id, picks the newest leaf, and walks the parent chain backwards, so a rewound branch must survive. Fourth, the target's transcript format is explicitly **internal and changes between releases**, which means this implementation's own session format must be independently versioned rather than copied. Fifth, the target has a documented history of compound-command permission bypasses — including a sub-command count cap that silently skipped every deny check — which makes this implementation's rule evaluator a security boundary it must not get wrong.

---

## Findings

### 1. Provider protocol drivers

**Provenance warning.** The *route set*, the *client construction per route*, the *credential resolution order*, and the *first-party* request shape in this section are corroborated by the REA audit's own observations of the pinned binary. The **Bedrock, Vertex, and Foundry body shapes below come from the public Anthropic, AWS, and Google SDKs and documentation, not from the target's own bundled adapters** (which live in `chunk-1njnz05e.js`, `chunk-jdnh8sjs.js`, `chunk-m5c0c57d.js`, `chunk-a3dhk724.js`, and `chunk-7qjrjq0k.js`). The REA phase has not re-derived those body field names from the bundled code, so this implementation's plan classifies them as `inference` until it does.

The plan's `CC-006` task must produce eight drivers. The wire shapes are not variations on one theme.

**First-party (Anthropic).** `POST <baseUrl>/v1/messages`; headers `x-api-key` **or** `authorization: Bearer` (never both), `anthropic-version: 2023-06-01`, `content-type: application/json`; optional `anthropic-beta` header. The body carries `model`, `messages`, `max_tokens` (required), and optionally `system`, `stream`, `tools`, `tool_choice`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `thinking`, `output_config`. The target's own canonical path adds a `?beta=true` path marker, which is a client-side artifact with no meaning on Bedrock or Vertex. ([vendor source], [vendor source])

**Streaming.** SSE framing is `event: <name>` followed by `data: <json>`, with the JSON `type` mirroring the event name. The sequence is `message_start` → (`content_block_start` → N× `content_block_delta` → `content_block_stop`)* → one or more `message_delta` → final `message_stop`; `ping` may interleave anywhere; errors arrive as `event: error`. Crucially, `usage` in the `message_delta` event is **cumulative, not incremental** — a driver that accumulates it will double-count. ([vendor source])

**Bedrock.** `POST <baseUrl>/model/<modelId>/invoke` or `/model/<modelId>/invoke-with-response-stream`. The body field is `anthropic_version: "bedrock-2023-05-31"`; `model` lives in the URL, not the body; `stream` is **removed** from the body. Betas travel in the body's `anthropic_beta` **array**, not a header — the opposite of first-party. Auth is SigV4 against service `bedrock` via the default AWS chain, unless `AWS_BEARER_TOKEN_BEDROCK` is set, in which case the bearer token takes precedence and suppresses SigV4. (https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html, https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/packages/bedrock-sdk/src/client.ts)

Bedrock streaming is **not SSE at all**: `/invoke-with-response-stream` returns a binary `application/vnd.amazon.eventstream` whose frames carry a `chunk` member holding a JSON blob of the Anthropic event, and a frame with a non-200 status surfaces as an `error` event. The target rejects a rewritten content type with a specific message rather than guessing. A driver that assumes SSE here will fail on every Bedrock stream. ([vendor source], https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/lib/bedrock/_stream_decoder.py)

**Mantle.** Anthropic-native (`POST <baseUrl>/v1/messages`, model in the body), base `https://bedrock-mantle.<region>.api.aws/anthropic`, betas in the `anthropic-beta` **header** alongside `anthropic-version: 2023-06-01`. ([vendor source])

*Scope note.* AWS also offers an Anthropic-native endpoint under `bedrock-runtime` (`/anthropic/v1/messages`). That is an **AWS API capability, not a the reference agent route**, and it is not one of the eight routes the REA audit observed. This implementation's route set is exactly those eight.

**Vertex.** `POST <host>/v1/projects/<project>/locations/<location>/publishers/anthropic/models/<model>:rawPredict` or `:streamRawPredict`. Body field `anthropic_version: "vertex-2023-10-16"`; `model` is **not** in the body; `stream` **is** retained in the body — unlike Bedrock. Auth is a Google OAuth2 bearer with the `cloud-platform` scope; the SDK explicitly refuses to fall back to an Anthropic API key. Host conventions: `global` → `aiplatform.googleapis.com`, `us` → `aiplatform.us.rep.googleapis.com`, `eu` → `aiplatform.eu.rep.googleapis.com`, otherwise `{region}-aiplatform.googleapis.com`. Model ids carry `@YYYYMMDD` suffixes. Google Cloud reads only **one** `anthropic-beta` header and ignores the rest, so multiple betas must be in a single header. (https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/packages/vertex-sdk/src/client.ts, [vendor source])

**Foundry.** Anthropic-native at `https://<resource>.services.ai.azure.com/anthropic/v1/messages`, but the body's `model` is the **Azure deployment name**, not a model id. Auth is `x-api-key` **or** an Entra ID bearer with scope `https://ai.azure.com/.default`, never both. `ANTHROPIC_FOUNDRY_RESOURCE` must be a bare resource name; a URL there is rejected with a specific message. The two base-URL variables are offered as *alternatives* in the documentation, and their precedence when both are set is not stated **in the documentation** — but the target's own bundled adapter (`chunk-m5c0c57d.js`) resolves it: `baseURL` and `resource` are **mutually exclusive** and supplying both throws `baseURL and resource are mutually exclusive`. This implementation should therefore throw rather than pick a winner. ([vendor source], [vendor source])

**Beta flags are not portable.** Bedrock rejects the **whole request** with `400 "invalid beta flag"` for an unrecognized flag, and Bedrock's spelling of some betas differs from Anthropic's (`advanced-tool-use-2025-11-20` versus `tool-search-tool-2025-10-19`). A driver that copies a beta list verbatim between platforms will break. The plan's `CC-006` therefore needs a per-driver beta translation table. (https://github.com/envoyproxy/ai-gateway/issues/2512)

**Disagreement.** Whether `bedrock-runtime` `count-tokens` is generally available is contested: the target's gateway contract lists `/model/{model}/count-tokens` as an optional Bedrock endpoint, AWS's own documentation says count-tokens is only available on `bedrock-mantle`, the Python SDK hard-raises "not supported in Bedrock yet", and the TypeScript SDK has an open PR for it. The plan's Bedrock driver must therefore treat count-tokens as *possibly unavailable* and fall back rather than assume.

**Corrected by direct REA.** Two of the wire-shape findings above were re-derived from the target's own bundled adapters (`chunk-1njnz05e.js`, `chunk-jdnh8sjs.js`, `chunk-m5c0c57d.js`) and the binary is authoritative where it disagrees with the public SDKs. The pinned binary: sets `anthropic_version` itself when the body lacks it; moves the `anthropic-beta` **header** into the body's `anthropic_beta` array, split and **trimmed**; **deletes** `model` and `stream` from the Bedrock body but only `model` from the Vertex body; selects the Vertex endpoint suffix from `body.stream`; **deletes the `beta` search parameter** on both; and throws `baseURL and resource are mutually exclusive` for Foundry. The audit's §2.2a records the exact literals and messages. ([vendor source], https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.md, https://github.com/anthropics/anthropic-sdk-typescript/pull/1081)

### 2. Multi-provider connection managers (this implementation's extension)

The target has **no** user-managed connection registry. Its route selector yields exactly one active route from environment flags, and its model catalog is built in. Everything in this section is design precedent for the extension, not target behavior.

The precedents agree on three points.

**A connection is keyed by a free-form name, not a provider type.** Kimi Code keys connections as `[providers.<name>]` with a required `type` (`kimi`, `anthropic`, `openai`, `openai_responses`, `google-genai`, `vertexai`), so several connections of the same protocol can coexist. Roo Code keys them as "API Configuration Profiles". Kimi additionally keeps a **separate `[models.<alias>]` table** — models are not nested under a provider — with an `overrides` block that explicitly *rejects* identity and routing fields (`provider`, `model`, `protocol`, `beta_api`, `base_url`), so a catalog refresh can rewrite catalog-owned metadata but never routing identity. (https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html, https://roocodeinc.github.io/Roo-Code/features/api-configuration-profiles/)

**The secret store and the config record are two different layers.** Roo removed `getProfile()` from its API outright ("Don't return api keys through the api"); Cline refactored `updateApiConfiguration` to split options from secrets. The target's own rule — credentials are references, and the catalog must not select or read them — matches this consensus. (https://github.com/roocodeinc/roo-code/issues/3399, https://github.com/cline/cline/issues/4676)

**Catalog refresh must not touch credentials or identity.** Kimi's registry-imported `env` field is only a *hint*; the CLI never auto-binds a secret to it. Kimi also isolates failures: a failed credential during a `/models` refresh fails that provider only, and a model alias pointing at a deleted provider makes session startup fail loudly *naming the broken alias* rather than silently falling back. (https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html, https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html)

**Where the sources disagree.** No two tools agree on whether the config file may hold secrets: Kimi writes `api_key` in plain text in `config.toml`; OpenCode stores plain `auth.json`; Continue resolves from `.env` files; Roo and Cline use OS secret storage; Goose **refuses** to read keys from its config file at all and mandates a keyring or a separate secrets file. This implementation's rule — credentials are *references* — sidesteps this entirely, because a reference contains no secret. They also disagree on whether an OAuth login is a registry entry: Kimi excludes managed accounts from `/provider` entirely; OpenCode folds OAuth and API keys into one namespace; Roo and Cline keep them on separate paths. And they disagree on connection granularity: Kimi by free-form name, Roo by profile, OpenCode and Goose by provider id. (https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html, https://opencode.ai/docs/providers/, https://goose-docs.ai/docs/guides/config-files)

**What no tool does.** No verified tool supports two **simultaneously live** connections to the same provider id in one process; Roo, Kimi, and Hermes all describe stored-and-switched. Hermes is the closest to this implementation's goal: it separates a terminal-time provider-setup wizard from an in-session `/model` switch that can only choose among already-configured providers, and it manages multiple credentials per provider as credential pools with fill-first rotation and per-credential cooldowns. (https://github.com/nousresearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md)

**A bug class worth designing against.** Roo found that switching to a profile using the *same* provider and model did not apply the profile's updated settings — a profile switch must invalidate the cached model handle even when provider and model are unchanged. (https://github.com/RooCodeInc/Roo-Code/issues/9208)

**The shared catalog.** models.dev is a per-provider TOML database served at `https://models.dev/api.json`, with per-model `id`, `name`, `reasoning`, `tool_call`, `cost`, `limit`, `modalities` and `status`, and a `base_model` mechanism for a provider-specific model to inherit provider-agnostic facts. Kimi imports from it and *refuses* proprietary and unrecognized protocols rather than guessing. (https://github.com/anomalyco/models.dev, https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html)

### 3. Terminal UI libraries

The choice is forced. **Ink 8** is the only viable option on Node 24.

- Ink 8.0.0 declares `engines: {node: ">=22"}` with `react: ">=19.3.0"`.
- **OpenTUI is disqualified**: `@opentui/core` 0.6.6 declares `node: ">=26.4.0"`, and its own runtime matrix requires ESM plus `--experimental-ffi`.
- `blessed` last released 2015-09-03; `neo-blessed` 2018-06-13. Both unmaintained.

(https://registry.npmjs.org/ink, https://registry.npmjs.org/@opentui/core, https://registry.npmjs.org/blessed)

Ink is also the **only** candidate with any screen-reader story — `INK_SCREEN_READER=true` plus an ARIA subset of 19 roles and 10 states, which Ink's own README describes as **basic** support. The comparative claim is what matters (OpenTUI's accessibility is an open feature request; Codex CLI has no mode at all), and this implementation's requirement is "not worse than Ink". OpenTUI's accessibility exists only as an open feature request; Codex CLI (Rust/ratatui) has no screen-reader mode at all. (https://github.com/vadimdemedes/ink, https://github.com/anomalyco/opentui/issues/423, https://github.com/openai/codex/issues/20489)

Three Ink behaviours shape the implementation. The default `maxFps` is 30 and `incrementalRendering` is **opt-in and off by default**, so a streaming turn must enable it. Ink has **no built-in markdown** — `ink-markdown` last published 2023-10-02 and is stale; the maintained option is `markdansi` (0.3.5, `node>=22`). And Ink redraws the whole visible terminal on every state change, which is exactly what forced Kiro CLI to *buffer* shell output rather than stream it live, and which costs ~500 ms of startup against ~50 ms for a native TUI. (https://github.com/vadimdemedes/ink/releases/tag/v8.0.0, https://www.npmjs.com/package/ink-markdown, https://builder.aws.com/content/3ExHwKXOYSZjNT4W6HE4aGFCtpw/from-rust-to-reactink-the-architecture-behind-kiro-clis-classic-vs-tui-mode)

Ink 8 also emits terminal **synchronized output** sequences, so a streaming frame can be made atomic rather than tearing. (Noted from the release notes; the exact emission point was not verified in the cited file, and the ANSI synchronized-output mode is `CSI ? 2025 h` — the first research pass mis-described it as "DEC 2026".)

**Architecture fit.** Terminal UIs split two ways: full-screen ones (opencode, Amp) lose terminal scrollback and search; scrollback-append ones (the reference agent, Codex, Droid) keep native scrolling and search. The target is a scrollback-append CLI, so this implementation must not use Ink's alternate-screen mode. (https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)

**Open Ink issues this implementation inherits.** #759 (CJK IME input lag and dropped characters, open since Aug 2025, Gemini CLI users affected); #870 (`useCursor().setCursorPosition` requires a component to know its own absolute coordinates, and there is no `<Cursor/>` element); #978 (native `external` memory growth when components toggle `setRawMode()`); #942 (no API to force a full re-render after a resize). #986 (an unbounded text-measurement cache, ~640 MB/hour at 10 renders/s, which OOM-killed a real streaming TUI) was **fixed in Ink 8.0.0**. (https://github.com/vadimdemedes/ink/issues/759, https://github.com/vadimdemedes/ink/issues/870, https://github.com/vadimdemedes/ink/issues/978, https://github.com/vadimdemedes/ink/issues/942, https://github.com/vadimdemedes/ink/issues/986)

One problem is unsolved in every library: the "flash of incomplete markdown" while a partial fragment streams. (synthesis)

### 4. Session persistence, resume, fork, and compaction

**Storage layout.** Transcripts live at `~/.claude/projects/<project>/<session-id>.jsonl` — one file per session, one JSON object per line, append-only. The project directory name is derived from the working directory path with non-alphanumeric characters replaced by `-`, truncated at 200 characters with a hash of the full path appended. The storage root is relocatable via `CLAUDE_CONFIG_DIR`, and the project directory name can be pinned with `CLAUDE_CODE_PROJECT_DIR_NAME`. Transcripts are deleted after 30 days by default (`cleanupPeriodDays`); `CLAUDE_CODE_SKIP_PROMPT_HISTORY` and `--no-session-persistence` suppress writes. ([vendor source])

**Disagreement on the project-directory encoding.** Anthropic's documentation says every non-alphanumeric character becomes `-`; an independent crate that measured real transcript stores reports that only `/` and `.` become `-` with everything else passing through, making the mapping lossy and non-injective (`a/b.c`, `a/b/c`, and `a-b-c` collide). This implementation should implement the documented rule and tolerate collisions. ([vendor source])

**There is no centralized session index.** A session is identified by the UUID in the filename, the project slug directory, and fields embedded in each line. (https://github.com/weirdgiraffe/reference-agent-sessions-explorer/blob/main/docs/JSONL-SCHEMA.md)

**Line schema.** Every line is a flat JSON object discriminated by a top-level `type`. Observed types: `assistant`, `attachment`, `user`, `system`, `last-prompt`, `queue-operation`, `pr-link`, `agent-name`, `custom-title`, `file-history-snapshot`, `permission-mode`, plus `progress` lines that are deliberately excluded from the parent chain. The common envelope carries `type`, `sessionId`, `uuid`, `parentUuid`, `timestamp`, `cwd`, `entrypoint`, `gitBranch`, `isSidechain`, `userType`, `version`, and `message`. Content blocks are `text`, `thinking` (persisted with the text empty and only a `signature` kept), `tool_use` (`id: toolu_…`), and `tool_result` (`tool_use_id`, `content`, `is_error`). (https://github.com/coo-labs/tjsonl/blob/main/spec/transcript-schema-spec.md, [vendor source])

**Resume is not a file replay.** The loader indexes messages into a `uuid → message` map, picks the newest leaf, walks *backwards* through `parentUuid` to get the effective chain, then applies projections (compaction boundary, preserved segments, content replacements). File order is write order only; dead branches from a rewind or fork remain in the file and are pruned. Four views of the same messages coexist: raw transcript, UI scrollback, active query view, and API wire view. (https://github.com/sweetcornna/open-reference-agent/blob/main/docs/en/internals/session-transcript-persistence.md)

**Selection.** `--continue` means the most recent session in the current directory, *skipping* live background sessions, `-p`/Agent-SDK sessions, and sessions whose first prompt was `/loop`; `-p --continue` includes them. `--resume <id>` resolves the current project directory and its git worktrees first, then every other project — and the cross-project search resolves **only when exactly one** other project holds a transcript for that id, otherwise it reports "No conversation found with session ID". ([vendor source])

**Fork.** `/branch` (alias `/fork`) copies the transcript into a new file, rewrites `sessionId` on the copied messages, and rebuilds the `parentUuid` chain; the original file is untouched. It runs in the *same* process, so "allow for this session" grants carry over, whereas `--fork-session` starts a separate process and they do not. **Disagreement:** Anthropic's public docs describe fork as creating a new session seeded with a copy of the history, while the internals guide says `--fork-session` does *not* copy a file and instead materializes a new transcript on the next write. ([vendor source], https://github.com/sweetcornna/open-reference-agent/blob/main/docs/en/internals/session-transcript-persistence.md)

**Compaction is a boundary marker, not a deletion.** A `type: "system"`, `subtype: "compact_boundary"` line with `content: "Conversation compacted"`, a `compactMetadata: {preTokens, trigger}` object, `logicalParentUuid` pointing at the last pre-compact message, and `parentUuid: null`. The summary itself is a separate `user` line flagged `isCompactSummary: true`. `compactMetadata` may also carry `postTokens`, `durationMs`, `messagesSummarized`, and a `preservedSegment.{headUuid, anchorUuid, tailUuid}` for partial compaction, whose preserved tail is re-attached during recovery. Separately, oversized `tool_result` content is replaced with a stub plus a `content-replacement` entry, so the large payload does not return to context on resume. ([vendor source], https://github.com/coo-labs/tjsonl/blob/main/spec/transcript-schema-spec.md)

**The format is explicitly unstable.** Anthropic states the entry format is internal and "changes between versions, so scripts that parse these files directly can break on any release"; the feature request for a published schema was closed as `not_planned`. A 2.0→2.1 break moved subagent sidechains out of the main JSONL into separate `subagents/agent-<id>.jsonl` files. The parent chain is not an invariant either: dangling references truncate a resume to a few messages, and a second compaction in one process can orphan hundreds of rows. ([vendor source], https://github.com/anthropics/reference-agent/issues/22526, https://github.com/anthropics/reference-agent/issues/55818)

**Provenance warning.** Nine of the claims in this section — the per-session sibling directories, the resume-by-leaf-walk algorithm, the four coexisting views, the `/resume` swap semantics, the `--fork-session` mechanism, the compaction boundary shape, the compaction variants, the content-replacement mechanism, and the read-side migration list — all cite one unaffiliated repository (`github.com/sweetcornna/open-reference-agent`). A further four (`isCompactSummary`, the "phantom parentUuid" truncation, the dangling `logicalParentUuid` case, and the `file-history-snapshot` shadowing hazard) rest on individual issue reports and one repair tool. These are **single-source** claims about a genuinely internal format. The plan therefore treats the whole resume/compaction model as **`inference`** and schedules a REA confirmation before any of it becomes a compatibility row. This implementation may implement the shape, but it must not claim compatibility with it until the binary confirms it.

**Peer formats for comparison.** Codex CLI writes `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl` with `{timestamp, type, payload}` lines, pairing tool calls by `call_id` and compressing idle rollouts to `.jsonl.zst`. OpenCode moved to SQLite with an ordered `session_message` table. Cline **rewrites the whole file** on change rather than appending. Aider uses a rolling Markdown log, not JSONL. (https://github.com/skillsynchq/txcript/blob/main/docs/formats/codex.md, https://github.com/diegoami/opencode-session-browser/blob/main/docs/OPENCODE_STORAGE.md, https://github.com/Upnit-b/cline-coding-agent/blob/main/docs/troubleshooting/task-history-recovery.mdx)

### 5. Permission models and known failure modes

**Rule precedence.** the reference agent evaluates rules **deny → ask → allow**, and the **first match wins with specificity irrelevant**: a broad `Bash(aws *)` deny beats a narrower `Bash(aws s3 ls)` allow, and an allow rule can never carve an exception out of a deny. `permissions.ask` beats `allow` and still prompts even in `bypassPermissions`. A *bare* tool-name deny (`Bash`) removes the tool from the model's context entirely; a *scoped* deny (`Bash(rm *)`) leaves it visible but blocks matching calls. ([vendor source])

**Bash matching.** Compound commands are split on `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines, and each sub-command must match independently. Wrappers are stripped before matching (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`, bare `xargs`) but `direnv exec`, `devbox run`, `mise exec`, `npx`, and `docker exec` are **not**. Bash rules match *command text, not program identity*: `Bash(curl *)` does not stop `/usr/bin/curl` or `sh -c 'curl …'`, and the documentation says outright that these are "not a security boundary around the program". Redirect targets are checked as file operations, against the Edit rules for writes and the Read rules for `< file`. ([vendor source])

**Path rules.** Four anchors: `//path` (filesystem root), `~/path` (home), `/path` (**relative to the settings source**, not absolute — a common misconfiguration), and `path`/`./path` (working directory). Deny and ask patterns match a single-segment directory at any depth; allow patterns match only at the anchored depth. `!` negation works only within the same settings file. Symlink semantics are asymmetric: an allow rule requires **both** the requested path and the resolved target to match, while a deny rule fires if **either** matches. ([vendor source])

**Modes.** Six: `default` (UI label Manual), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. Deny rules block in every mode; allow rules have no effect in `bypassPermissions`. `acceptEdits` auto-approves Edit/Write plus `mkdir, touch, rm, rmdir, mv, cp, sed`, but only for paths inside the working directory or an added directory and only after a symlink check. `auto` replaces prompts with a classifier review and **fails closed** when the review returns no verdict. The review is **server-side by default** in current releases (server-side review from v2.1.281/2.1.282, on by default for gateways and cloud providers from v2.1.278); the *local* model call is the **fallback**, not the primary path. The local model is selected by `CLAUDE_CODE_AUTO_MODE_MODEL` (which requires v2.1.302 and takes a full model id set through `settings.json` `env`, not a process environment variable), and server-side review can be disabled with `CLAUDE_CODE_AUTO_MODE_SERVER=0`. This implementation must not assume the target makes a local classifier call. `dontAsk` auto-denies anything that would prompt, and denies `AskUserQuestion`, MCP tools marked `requiresUserInteraction`, and network-path reads even if allow-listed. `plan` never auto-approves a file edit. Start-mode precedence is `--permission-mode` flag → `permissions.defaultMode` → built-in default, and `auto`/`bypassPermissions` written into a settings file are **ignored**. ([vendor source], [vendor source])

**Hooks.** PreToolUse hooks run *before* the permission prompt. A hook returning `allow` does **not** override a deny or ask rule; a hook returning `deny` holds in every mode. Multiple PreToolUse hooks combine as deny > defer > ask > allow. A `PermissionRequest` hook uses `hookSpecificOutput.decision.behavior` and can rewrite the input via `updatedInput`. A behavioral change in a later release removed the old `allow`-overrides-`ask` behavior **without a deprecation warning**. ([vendor source], https://github.com/anthropics/reference-agent/issues/36059)

**Sandbox is orthogonal to permissions.** The Bash sandbox has an auto-allow mode and a regular mode; even in auto-allow, a matching deny rule still blocks. The dangerous part: a sandbox-blocked command can be retried with `dangerouslyDisableSandbox`, and a matching **allow rule also approves the retry** — so the mitigation is an ask rule on that specific form. And the sandbox protects configuration paths while **Read, Edit, WebFetch, MCP servers, and hooks all run outside it**. ([vendor source])

**Known failure modes this implementation must not reproduce.** This is the most important section for this implementation's own security posture.

| Failure | What happened | Fix status |
|---|---|---|
| Compound-command allow bypass | Allow-list prefix matching let `echo "bypass" && ls -l` run with no prompt; the shipped matcher "explicitly skips compound commands when evaluating allow-rules" | see issue #36645 |
| Over-correction | After a fix, the whole chain must match an allow pattern, so a fully-allowed compound command still prompts; one issue was closed on the grounds that "model-level guardrails prevent constructing the bypass in practice" — a probabilistic defense used as the boundary | #27493 |
| 50-subcommand cap | A compound command with more than 50 sub-commands **skips all per-sub-command deny-rule checks** and falls back to a generic "ask" that is auto-approvable in CI | fixed in a later release |
| Single-quote stripping | A command validator stripped single-quoted text *before* running its checks, so a command carrying a payload inside single quotes passed. The nearest published advisory is GHSA-xq4m-mc3c-vvg3 (CVE-2025-66032, "Command Validation Bypass Allows Arbitrary Code Execution", Dec 2025) — **not** CVE-2026-54316, which is a different issue (see below), and the original finding's version attribution could not be confirmed against a changelog | pre-2026 |
| Symlink TOCTOU | An `Edit` authorized a pathname via a point-in-time symlink resolution, then reopened the *original* pathname after an async directory creation, letting a sandboxed process swap an in-workspace ancestor for a symlink | fixed in 2.1.251 |
| "SymJack" / "GhostApproval" | The approval prompt shows the **literal command string**, not the canonical destination; the user approves a `cp` while the kernel follows a committed symlink and writes attacker JSON into `.claude/settings.json` | reported across five agents |
| Read not sandboxed | In the GitHub Action, `Bash` ran inside Bubblewrap but `Read` was in-process, so injected content could read `/proc/self/environ` and leak the API key | fixed in 2.1.128 |
| Hooks as a bypass | A marketplace plugin can install a hook that rewrites `settings.local.json` to permanently allow a command | — |
| Project settings trusted | `enableAllProjectMcpServers` / `enabledMcpjsonServers` are not blocked from project scope the way `bypassPermissions` is | CVE-2025-59536 |

(https://github.com/anthropics/reference-agent/pull/36645, https://github.com/anthropics/reference-agent/issues/27493, https://adversa.ai/blog/critical-reference-agent-vulnerability-deny-rules-silently-bypassed-because-security-checks-cost-too-many-tokens/, https://www.securityweek.com/, https://codeant.ai/security-research/reference-agent-macos-parent-directory-toctou-vulnerability, https://adversa.ai/blog/the-approval-prompt-is-lying-to-you-symlink-rce-in-five-ai-coding-agents-reference-agent-cursor-antigravity-copilot-grok-build/, https://www.microsoft.com/en-us/security/blog/2026/06/05/securing-ci-cd-in-agentic-world-reference-agent-github-action-case/, https://flatt.tech/research/posts/poisoning-reference-agent-one-github-issue-to-break-the-supply-chain/)

**Two CVE attributions in the first research pass were wrong, and are corrected here.** CVE-2026-54316 is **GHSA-fg94-h982-f3mm, "Out-of-Band Data Exfiltration via Pre-Approved HuggingFace Domain in WebFetch"**, published 2026-06-13, severity medium — it is *not* the command-validation issue, and it post-dates the release the first pass said fixed it. The severity disagreement in that first pass was attached to the wrong advisory: the Anthropic advisory's own rating is "medium", while the 9.1 figure and the August 2026 Hacker News item belong to a different story. Separately, the symlink advisory GHSA-4q92-rfm6-2cqx (CVE-2026-25724) was published 2026-02-06, so it cannot have been "fixed in 2.1.7" (2026-01-14) — the 2.1.7 changelog entry is a *different* fix, about wildcard rules matching compound commands with shell operators. GHSA-pmw4-pwvc-3hx2 (CVE-2025-54794) is a Research Preview advisory from 2025-08-01, roughly fifteen months before the target. The "2.1.217 parent-directory TOCTOU" and "2.1.128 sensitive-`/proc`" attributions come from third-party blogs and **could not be confirmed against the changelog**; they are recorded here as *failure classes*, not as dated target facts. The one symlink fix that **is** confirmed by the 2.1.251 changelog is "file tools following a symlink swapped inside the working directory after the permission check" plus "Grep and Glob not applying `Read(...)` deny rules to files reached through a symlinked search path" — and 2.1.303 is six weeks past it.

**A structural conclusion.** A survey of eleven open-source coding agents found that ten use command guards that inspect commands as plain strings while the shell rewrites them first — string-level validation is a structurally inadequate control for an agent that hands commands to a real shell. This implementation's rule evaluator must therefore either parse the command the way the shell will, or refuse to make a security claim. (https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-ci-prompt-injection-20260807/)

**Disagreement — narrower than it first looked.** The current documentation says an allow rule must match **every** sub-command (so `Bash(safe-cmd *)` does not approve `safe-cmd && other-cmd`) and that deny/ask fire if **any** sub-command matches. That is exactly what issue #20085 describes, so the documentation and the issue **agree**. The outlier is a third-party reading of the March 2026 bundle in PR #36645, which is **closed, unmerged**, proposes a plugin rather than an upstream fix, and whose key quote is self-contradictory: it says the matcher "explicitly skips compound commands when evaluating allow-rules (`skipCompoundCheck: false`)" — and a flag named `skipCompoundCheck` set to *false* means *do not* skip. This implementation's choice is per-sub-command evaluation with deny/ask firing on any match, which matches the documentation and is the strictest reading. ([vendor source], https://github.com/anthropics/reference-agent/pull/36645, https://github.com/anthropics/reference-agent/issues/20085)

### 6. MCP and hooks ecosystem

**Two protocol eras.** The current MCP revision is `2026-07-28`, and it is **stateless**: the `initialize`/`initialized` handshake and the `Mcp-Session-Id` header were retired, and every request carries protocol version, client identity, and capabilities in `_meta`. The previous stable revision is `2025-11-25`, and the SDK defines two *eras* rather than two versions: legacy (opens with `initialize`) and modern (`2026-07-28`+, opens with `server/discover`). The `2026-07-28` schema drops `initialize`, `notifications/initialized`, `logging/setLevel`, `tasks/*`, and `resources/subscribe|unsubscribe`, and adds `server/discover` plus `subscriptions/listen`. (https://blog.modelcontextprotocol.io/posts/2026-07-28, https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)

**This is not a genuine source disagreement.** The spec repository's *current* schema (`schema/2026-07-28/schema.ts`) declares `LATEST_PROTOCOL_VERSION = "2026-07-28"` and `UNSUPPORTED_PROTOCOL_VERSION = -32022`; the earlier finding quoted the *frozen* `schema/2025-11-25/schema.ts` as if it showed the current latest. The only lag is a third-party aggregator site that still labels `2025-11-25` "Latest Stable". This implementation must support both eras, because a server that answers `initialize` and one that answers `server/discover` must both work. (https://modelcontextprotocol.info/specification)

**Transports.** Standard transports are stdio (newline-delimited JSON-RPC over a client-launched subprocess; stdout must contain only MCP messages) and Streamable HTTP. `2026-07-28` removes the GET endpoint and `Last-Event-ID` resumability, and in that revision servers do not initiate JSON-RPC requests at all — server-to-client requests are replaced by an `InputRequiredResult` the client retries with. The target supports a wider set than the spec: `stdio`, `http`, `sse` (deprecated), `ws`, and an in-process `"type": "sdk"` server. (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports, [vendor source])

**The target's batching is confirmed.** `MCP_SERVER_CONNECTION_BATCH_SIZE` defaults to 3 for local stdio servers and `MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE` to 20 for remote; `MCP_TIMEOUT` defaults to 30,000 ms and `MCP_CONNECT_TIMEOUT_MS` to 5,000 ms. A user-quoted binary fragment shows the two pools running concurrently with a hardcoded retry schedule of `[500, 1500, 4000]` and no jitter. ([vendor source], https://github.com/anthropics/reference-agent/issues/83495)

**Hook events.** The hooks reference documents **33** events. Two names that the target's static analysis surfaced — `StatusLine` and `FileSuggestion` — are **not** hook events; they are settings keys holding a display-only command handler. This implementation must not treat them as decision points. ([vendor source])

**Handler contract.** Handler types are `command`, `http`, `mcp_tool`, `prompt`, `agent`; all matching hooks in a group run in parallel. The common payload carries `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort.level`, and `hook_event_name`. The exit-code contract is `0` = success (apply the JSON output), `2` = blocking error on a blockable event, anything else = non-blocking error. Matchers are either an exact string (when they contain only letters, digits, `_`, `-`, space, `,`, `|`) or an **unanchored** JavaScript regular expression. ([vendor source])

**MCP security requirements.** Streamable HTTP servers must validate `Origin` (403 on invalid) and bind only to localhost; token passthrough is forbidden; clients must consider SSRF when following OAuth discovery URLs; local server consent must show the exact command, flag it as potentially dangerous code execution, and **sandbox spawned servers**; OAuth URLs must be restricted to `http`/`https` and never opened through a shell; tool metadata is untrusted, and hosts must obtain explicit user consent before invoking any tool. (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports, https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices)

**Known MCP issues.** CVE-2025-66414 (the TypeScript SDK did not enable DNS-rebinding protection by default), CVE-2026-11624 (servers before v0.25 did not validate `Origin`), CVE-2025-49596 (Anthropic's own MCP Inspector had RCE plus DNS rebinding), CVE-2025-6514 (`mcp-remote` command injection). Tool poisoning, tool shadowing, and "rug pull" — a tool that changes its interface after approval — are all live, and the key gap is that **clients do not notify users when a tool description changes**. Separately, a survey of the ecosystem found 20+ CVEs from stdio command injection across AI tooling, with `npx -c <command>` defeating allowlists that permit `npx`. (https://github.com/advisories/GHSA-w48q-cv73-mx4w, https://threat-modeling.com/cve-2026-11624-mcp-dns-rebinding, https://jfrog.com/blog/2025-6514-critical-mcp-remote-rce-vulnerability, https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks, https://www.ox.security/blog/mcp-supply-chain-advisory-rce-vulnerabilities-across-the-ai-ecosystem/)

**TrustFall.** the reference agent, Cursor CLI, Gemini CLI, and Copilot CLI all auto-execute project-defined MCP servers upon acceptance of the folder-trust prompt, without separately disclosing that code execution would occur. This implementation should disclose it. (https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-poisoning-auto-execution-20260701)

### 7. Node/TypeScript toolchain

**Runtime.** Node 24 is the current LTS line (Maintenance from 2026-10-20, EOL 2028-04-30). Node 22 is in Maintenance with EOL 2027-04-30, and Node 20 went EOL 2026-04-30. The proposed stack does not force Node 22: `vitest@5.0.5` accepts `^22.12.0 || ^24.0.0 || >=26.0.0`, `ink@8.0.0` requires `>=22`, and `@modelcontextprotocol/sdk@1.32.1` requires `>=18`. Moving to Node 24 costs nothing and buys a year of runway. (https://endoflife.date/nodejs, https://registry.npmjs.org/vitest/5.0.5)

**Validation.** `zod@4.6.7` is current, with `zod/v3`, `zod/v4`, `zod/mini`, `zod/v4/core`, and `zod/compile` subpaths kept permanently. Zod 4's relevant breaking changes: `.strict()`/`.passthrough()` → `z.strictObject()`/`z.looseObject()`, `.merge()` → `.extend()`, `errorMap` → `error`, `.format()`/`.flatten()` → `z.treeifyError()`, and `z.any()`/`z.unknown()` keys become **required** at parse time as of v4.4.0. Do **not** use `zod-to-json-schema` — unmaintained since November 2025; Zod 4 ships native `z.toJSONSchema()`. The MCP SDK still depends on the unmaintained package, which is an upgrade risk to track. (https://zod.dev/v4/changelog, https://github.com/StefanTerdell/zod-to-json-schema)

**Zod vs Valibot is genuinely contested.** Valibot's marketing claims parity, but bundle size favours Valibot (1.37 kB versus Zod 17.7 kB, or Zod Mini 6.88 kB, for the same schema) while Valibot's own maintainer measured Zod v4 about 22% *faster* than optimized Valibot on the valid path. For a CLI, startup and familiarity matter more than steady-state throughput, so Zod v4 is the defensible default with `zod/mini` as the tree-shakable fallback. (https://valibot.dev/guides/comparison/, https://github.com/open-circle/valibot/issues/1408)

**Testing.** `vitest@5.0.5` is current; v5 requires Vite ≥ 6.4.0 and Node ≥ 22.12.0, makes `vite` a required peer dependency, defaults `clearMocks` to true, **throws** if `vi.mock`/`vi.unmock`/`vi.hoisted` are not at module top level, and now **fails** a test with an unawaited async assertion. `node:test` is a legitimate zero-dependency alternative and is stable, but it has no rich `expect` API, no snapshot serializers, and no Actions reporter. (https://vitest.dev/guide/migration, https://nodejs.org/docs/latest-v22.x/api/test.html)

**Persistence — this is a decision, not a default.** `node:sqlite` is **not stable**: in Node 22 it is Stability 1.1 "Active development", it reached Stability 1.2 "Release candidate" only in Node 24.15.0, and the upstream stabilization issue is still open. Several 2026 blogs assert it is "fully stable and production-ready as of Node 24", which the Node 26 documentation contradicts. Its API also differs materially by Node line, and it received CVE-2026-58041 in the July 2026 security release. `better-sqlite3` is a native module with prebuilt binaries, which directly conflicts with a self-contained executable. **Conclusion: JSONL, as the plan already specifies.** (https://github.com/nodejs/node/issues/57445, https://nodejs.org/docs/latest-v22.x/api/sqlite.html, https://www.digitalapplied.com/blog/nodejs-july-2026-security-releases-shipped)

**Credentials without native modules.** The workable, dependency-light path is to shell out to the platform CLI — on macOS, `security find-generic-password -w -s '<SERVICE>' -a '<ACCOUNT>'`. Do **not** build on `keytar`: the repository was archived and made read-only on 2022-12-15, and the real-world failure modes (Windows writes, Node 24 imports, Alpine, macOS re-prompting on every binary change) are well documented. The current best practice is a layered backend with a CLI fallback, such as `cross-keychain`, which uses an optional native binding and automatically falls back to a CLI backend. (https://github.com/atom/node-keytar, https://github.com/magarcia/cross-keychain, https://github.com/microsoft/azure-devops-mcp/issues/1706)

**Packaging.** `pkg` is effectively dead. Node's Single Executable Application is still Stability 1.1; Node 22 and 24 have **no** `--build-sea` and require manual `postject` injection, while Node 26 added it. SEA also excludes macOS x64 and Alpine, which is a hard blocker for a container-distributed CLI. `bun build --compile` bundles the runtime and measured at 62 MB / 7 ms startup against Node SEA's 146 MB / 24 ms — though it ships the Bun runtime, so `node:sqlite` is unavailable and every `node:` API assumption must be re-validated. (https://www.npmjs.com/package/pkg, https://nodejs.org/api/single-executable-applications.html, https://flaviocopes.com/javascript-single-executable, https://bun.com/docs/bundler/executables)

### 7. Linux sandbox primitives

**The kernel forbids the obvious design.** The seccomp UAPI header is unambiguous: "It should be absolutely clear that this means that the seccomp notifier *cannot* be used to implement a security policy!" The reason is inherent TOCTOU — the target can rewrite pointer arguments while blocked waiting for the supervisor's response. The `seccomp_unotify(2)` manual repeats it: the mechanism "must not be used to make security policy decisions about the system call, which would be inherently race-prone"; a supervisor should only `CONTINUE` when "another security mechanism or the kernel itself will sufficiently block the system call if its arguments are rewritten to something unsafe." Christian Brauner, who designed the feature, puts it more bluntly: "In general, the seccomp notify fd cannot be used to implement any kind of security policy in userspace… 'No, you can't!'" (https://github.com/torvalds/linux/blob/master/include/uapi/linux/seccomp.h, https://man7.org/linux/man-pages/man2/seccomp_unotify.2.html, https://people.kernel.org/brauner/the-seccomp-notifier-new-frontiers-in-unprivileged-container-development)

**This is a direct finding about the target.** The pinned binary's seccomp user-notification supervisor (`0x1d22440`) reads the target's path arguments with `process_vm_readv` and resolves them with `readlinkat`, then dispatches on a 27-record table. The kernel's own documentation says the *design pattern* — a userspace supervisor deciding whether a blocked syscall proceeds, based on arguments it read out of the target's memory — cannot be a security policy. The REA record already notes that the per-syscall policy is unresolved; this research adds the stronger, sourced conclusion that the **per-syscall decision is not the boundary**, and that any path it authorizes must be re-checked against a kernel-enforced layer. This implementation's supervisor must therefore be observability and emulation, not enforcement.

Two further prohibitions follow from the kernel headers. For `SECCOMP_RET_USER_NOTIF` filters on the same syscall, the **most recently installed filter wins**, so a later USER_NOTIF filter can override an earlier filter's response with `SECCOMP_USER_NOTIF_FLAG_CONTINUE` — "essentially allowing all such filtered syscalls to be executed." And every read of the target's memory must be separated from the *use* of those bytes by a `SECCOMP_IOCTL_NOTIF_ID_VALID` check, because the target may abandon the syscall via a signal handler and overwrite the stack frame; "a write by the supervisor into the target's memory can never be considered safe." (https://github.com/torvalds/linux/blob/master/include/uapi/linux/seccomp.h, https://man7.org/linux/man-pages/man2/seccomp_unotify.2.html)

**Landlock** is an unprivileged, self-restricting, stackable LSM. Rules bind to an `O_PATH` file descriptor, so a later rename, symlink, or bind mount cannot "walk" a rule to a different object — which is the property this implementation needs against the symlink TOCTOU class. It is explicitly complementary to seccomp: object access control versus syscall-argument filtering, and it "shall not be able to programmatically communicate with user space." It cannot restrict `chdir`, `stat`, `flock`, `chmod`, `chown`, `setxattr`, `utime`, `fcntl`, or `access`; it denies `mount(2)`/`pivot_root(2)` but **not** `chroot(2)`. Its rights attach to the descriptor at open time, and descriptors opened before enforcement keep their prior rights. (https://docs.kernel.org/userspace-api/landlock.html, https://docs.kernel.org/security/landlock.html)

**io_uring is the concrete seccomp bypass.** `io-wq` worker threads call `do_filp_open()` and the VFS/network stack directly, without `syscall_enter_from_user_mode()` and therefore without `seccomp_run_filters()`. A process blocked from `openat`/`read`/`write`/`connect` can still perform all of them via SQEs. `IORING_SETUP_SQPOLL` removes even the `io_uring_enter` chokepoint, so a ring created before the filter is installed retains full I/O with no syscall surface left to filter. The effective mitigation for a seccomp sandbox is to block `io_uring_setup`. (https://kernel-internals.org/io-uring/war-stories)

**bubblewrap** is "a tool for constructing sandbox environments… not a complete, ready-made sandbox with a specific security policy"; the protection between sandbox and host is entirely determined by the argv passed, and the caller defines the security model. Its documented limitations include that without seccomp filtering of `TIOCSTI`, `--new-session` is required (CVE-2017-5226), and that "everything mounted into the sandbox can potentially be used to escalate privileges". CVE-2026-87766 (symlink traversal via the `/oldroot` staging mount) is fixed in 0.12.0 with **no backport to setuid-capable versions**, and Ubuntu's own backport broke Flatpak — so a distribution's `bubblewrap` version alone does not tell you whether the fix is present. (https://raw.githubusercontent.com/containers/bubblewrap/main/README.md, https://github.com/containers/bubblewrap/security/advisories/GHSA-pxhw-h44j-8pfx, https://github.com/containers/bubblewrap/issues/801)

**The most instructive escape class is configuration, not a bug.** CVE-2026-25725 in the reference agent: a read-only bind on `settings.json` that **did not exist at startup** meant the writable parent let the sandbox create it, injecting persistent `SessionStart` hooks that then ran with host privileges. (https://www.sentinelone.com/vulnerability-database/cve-2026-25725)

**Namespaces** are the substrate, not a boundary. Unprivileged user namespaces expand the unprivileged-reachable kernel surface — one study counts roughly 40 kernel CVEs in five years attributable to userns-reachable code — and distributions respond by *restricting* userns, which the vendor's own documentation tells users to work around for `bwrap`. `chroot` is not a security boundary; `pivot_root` alone restricts nothing but root. (https://edera.dev/stories/user-namespaces-are-not-a-security-boundary, https://arxiv.org/html/2509.18548v2)

**The target's own sandbox.** the reference agent on Linux/WSL2 uses **bubblewrap + socat**; the optional seccomp filter is a separate npm package that only adds Unix-domain-socket blocking. Network isolation works by *removing* the network namespace so all traffic must go through host proxies over bind-mounted Unix sockets. The sandbox covers the Bash/PowerShell/Monitor tools only — Read, Write, WebFetch, MCP servers, and hooks run outside it. Default read access is "most of the machine, including credential files such as `~/.ssh` and `~/.aws/credentials`", and by default a failed sandbox start **falls back to running unsandboxed**. ([vendor source], https://github.com/anthropics/sandbox-runtime)

**Verified locally on this host** (kernel `6.6.87.2-microsoft-standard-WSL2`): `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)` returns **ABI 3** — the full filesystem right set including `FS_TRUNCATE`, but **no TCP/UDP network rights** (v4/v10), no `FS_IOCTL_DEV` (v5), and no `LANDLOCK_SCOPE_*` (v6), so network policy must come from a network namespace plus a proxy, never from Landlock. `user_notif` is present in `/proc/sys/kernel/seccomp/actions_avail`, and unprivileged user namespaces work. A minimal USER_NOTIF target inside a nested PID namespace confirmed that a supervisor **from outside that namespace** receives the target's *host* PID, that `pidfd_open` succeeds, and that `readlink("/proc/<req.pid>/cwd")` and `/exe` both resolve — so the target's supervisor pattern is sound across a nested PID namespace, provided the target's PID namespace is a descendant of the listener's (otherwise `req.pid` may be 0). The observed ioctl constants match the pinned binary's Evidence exactly: `SECCOMP_IOCTL_NOTIF_RECV` = `0xc0502100` and `SECCOMP_IOCTL_NOTIF_SEND` = `0xc0182101`.

**Reference designs.** Codex CLI on Linux uses a `codex-linux-sandbox` helper combining bubblewrap, Landlock, and seccomp. Sandlock is the closest published analogue to the target's helper — Landlock plus seccomp-BPF plus seccomp user notification in a single unprivileged sandbox, no root, no cgroups, no containers, ~5 ms startup — but it requires **Linux 6.12+** for network rules and IPC scoping. Anthropic's own model is that filesystem isolation and network isolation are *both* required. For genuinely hostile code the industry answer is a microVM (Firecracker/E2B) or gVisor, because containers share one kernel across all tenants. (https://github.com/multikernel/sandlock, https://www.anthropic.com/engineering/reference-agent-sandboxing, https://northflank.com/blog/how-to-sandbox-ai-agents)

---

## 8. Disagreements and open questions

### 8.1 Disagreements between sources

1. **Compound-command semantics.** The documentation says per-sub-command evaluation; the shipped-bundle analysis says the allow path skips compound checks; an issue report says the whole chain must match. This implementation picks the strictest reading and documents it.
2. **The project-directory encoding.** Documented as "non-alphanumeric → `-`" versus measured as "only `/` and `.` → `-`, everything else preserved" (lossy and colliding).
3. **`--fork-session` mechanism.** Public documentation says the history is copied; the internals guide says the file is *not* copied and a new transcript is materialized on the next write.
4. **Fork lineage on disk.** The internals guide says `/branch` records a `forkedFrom` pointer; an issue report says no such pointer exists.
5. **Whether a config file may hold secrets.** Six tools, five different answers. This implementation's reference model sidesteps the question.
6. **Whether an OAuth login is a registry entry.** Three different answers across the precedents.
7. **MCP's stable revision.** Official channels say `2026-07-28` shipped; a third-party mirror still calls `2025-11-25` stable.
8. **Zod versus Valibot.** Valibot's marketing says parity; Valibot's own maintainer's benchmark says Zod v4 is faster.
9. **`node:sqlite` stability.** Several blogs say production-ready on Node 24; the Node 26 docs say release candidate, and the upstream issue is open.
10. **CVE-2026-54316 severity.** Anthropic scores it Moderate (CVSS v4 6.0); NVD scores 9.1 (CVSS v3.1). Not like-for-like.
11. **OpenTUI production readiness.** A March 2026 comparison and a November 2025 post both say "not production ready"; OpenTUI's current README says it powers OpenCode in production.
12. **Vendor triage versus shipped fix.** Anthropic closed "SymJack" as out of scope via HackerOne; Google and Cursor declined; OpenAI's Bugcrowd called it a false positive. This implementation should treat the class as real regardless.
13. **The minimum kernel for seccomp user notification.** `seccomp_unotify(2)` says the `NOTIF_RECV`/`SEND`/`ID_VALID` ioctls are "available since Linux 5.0", while Sandlock's requirements table says 5.6. This implementation should feature-detect rather than assume either.
14. **Whether the pinned binary's 27-record seccomp table is an allowlist or an intercept-everything design.** Not determinable from static evidence alone, and it matters: the kernel's prohibition on userspace security policy only binds when another layer backstops the decision.

### 8.2 Open questions

- **Does the pinned 2.1.303 binary actually negotiate MCP `2026-07-28`?** The target's static evidence shows only `initialize`, `tools/list`, and `tools/call` — the legacy era — yet a later changelog entry makes `2026-07-28` the default for stdio. Either the binary runs the v1 runtime, a legacy flag is in effect, the string extraction missed `server/discover`/`subscriptions/listen`, or a rollout gate kept it legacy. This implementation must support both.
- **What exactly is the per-syscall seccomp policy?** Still unresolved in the REA phase; §9 of the coverage audit carries it.
- **Is `bedrock-runtime` count-tokens generally available?** Contested across four sources.
- **Which beta-flag subset does the target send per platform?** The gateway documentation says "the subset Amazon Bedrock and Agent Platform accept" without enumerating it.
- **Does the target's `auto` classifier count as a security boundary?** The documentation says it "does not guarantee safety" and fails closed with no verdict; this implementation treats it as advisory only.
- **Windows credential access without a native binding.** No primary source was found for a supported non-native path.
- **Whether Bun's "all Node.js APIs are supported" claim holds for `node:sqlite`.** No direct source either way.

---

## 8.3 Adversarial verification — what the verification pass changed

A verification subagent read this report's findings, the plan, and the REA coverage audit, and checked the highest-consequence claims against their sources. It returned 34 issues. Every one was resolved rather than dropped; the corrections that changed the plan are listed here, because they are the most useful output of the verification step.

**Facts that were wrong and are now corrected:**

- **CVE-2026-54316** is GHSA-fg94-h982-f3mm, "Out-of-Band Data Exfiltration via Pre-Approved HuggingFace Domain in WebFetch" (2026-06-13, medium) — not the command-validation issue, and it post-dates the release the first pass said fixed it. The severity comparison in the first pass was attached to the wrong advisory. The nearest published advisory for the quote-stripping validator is GHSA-xq4m-mc3c-vvg3 (CVE-2025-66032, December 2025).
- **GHSA-4q92-rfm6-2cqx** (CVE-2026-25724) was published 2026-02-06, so it cannot have been "fixed in 2.1.7" (2026-01-14); the 2.1.7 entry is a different fix, about wildcard rules matching compound commands. **GHSA-pmw4-pwvc-3hx2** is a Research Preview advisory from 2025-08-01.
- The **"2.1.217 parent-directory TOCTOU"** and **"2.1.128 sensitive-`/proc`"** attributions come from third-party blogs and could not be confirmed against the changelog. They are now recorded as *failure classes*, not as dated target facts. The one symlink fix that **is** confirmed by the 2.1.251 changelog is the file-tool-follows-a-swapped-symlink and Grep/Glob-ignore-Read-deny-rules pair, and 2.1.303 is six weeks past it.
- **Auto mode** is server-side review by default in current releases, with the *local* model call as the fallback — the opposite of what the first pass implied, and a difference that would have produced a local classifier call the target does not make. `CLAUDE_CODE_AUTO_MODE_MODEL` requires v2.1.302 and takes a full model id set through `settings.json` `env`, not a process environment variable; `CLAUDE_CODE_AUTO_MODE_SERVER=0` disables server-side review.
- **MCP's "source disagreement"** was a research artifact: the spec repository's *current* schema declares `LATEST_PROTOCOL_VERSION = "2026-07-28"`. The earlier finding quoted the frozen `2025-11-25` schema. Only a third-party aggregator lags.
- The **compound-command "disagreement"** is narrower than it looked: the documentation and issue #20085 *agree* (an allow rule must match every sub-command; deny/ask fire if any matches). The outlier is a third-party reading of the March 2026 bundle in a **closed, unmerged** PR whose key quote is self-contradictory — it says the matcher "skips compound commands ... (`skipCompoundCheck: false`)", and a flag named `skipCompoundCheck` set to *false* means *do not* skip.
- The **"DEC 2026 synchronized output"** description was wrong: the ANSI synchronized-output mode is `CSI ? 2025 h`, and the cited Ink file only mentions the feature in a list of what Ink disables in non-interactive mode.

**Claims that were over-stated and are now scoped:**

- The plan's hook-event constraint listed 35 names including `StatusLine` and `FileSuggestion`; the hooks reference documents **33** events, and the two extras are settings-level display handlers. The constraint now says 33 and names the two as non-events.
- The plan's Global Constraints claimed to be "copied verbatim from the audit", but the session resume and compaction statements come from a single third-party repository, not from the REA audit. They are now labelled `inference` and gated on the REA confirmation step.
- The plan's Global Constraint called a set of failures "the **target's** known permission-bypass failure modes" when several are already fixed by 2.1.303. The constraint now says "observed in earlier releases and already fixed by 2.1.303, which this implementation must not reintroduce".
- The "600000 ms default non-streaming timeout" is a **fallback**; the target computes a per-model value first. The constraint and the driver task now say so.
- The auto-mode constraint omitted three availability overrides (`disableAutoMode: "disable"`, the HIPAA configuration, and a session where auto mode is unavailable). They are now in the constraint and the task.
- The plan's MCP note said "negotiate the legacy handshake **by default**" — the opposite of the target, whose changelog records stdio connections negotiating `2026-07-28` by default with `MCP_PROTOCOL_NEGOTIATION=legacy` as the opt-out. The note now requires **modern-first** with a legacy fallback, and it separates the two version-error contracts (HTTP `400` for an invalid header; JSON-RPC `-32022` with a `supported` list for an unsupported version).
- The plan conflated the **23-subtype host control dispatcher** with the separate **`can_use_tool` transport dispatcher** — the target classifies `can_use_tool` as agent-originated and not host-dispatchable. The two now have separate functions.
- The plan's `evaluateRules` was specified to rewrite the tool input. In the target, rules are pure predicates and only **hooks** rewrite input. The rewrite path moved to the hook layer; a rewritten input the tool's validator rejects must deny the call.
- The plan's permission mode union omitted `dontAsk` and the `manual` alias. Both are now in the union and in the task.
- The plan's `ANTHROPIC_FOUNDRY_RESOURCE` / `ANTHROPIC_FOUNDRY_BASE_URL` mutual exclusion was an invention; the documentation offers them as alternatives and states no precedence. The task now says the precedence is unknown and must be documented rather than claimed.
- The plan's `/v1/messages?beta=true` conditional was an invention; the target's source shows both a plain and a `?beta=true` variant. The task now implements both and records the discrepancy.
- Review Focus items 8, 9, and 13 asserted target behavior the research does not support. They are now labelled **project requirements** with an explicit `target unknown` status.
- The plan implemented only half of the settings same-file case: a project settings file that resolves to the *same* file as the user settings file is skipped and reported with the read mode `as_read`, not `none`. Both cases are now in the task.
- "DEC 2026" was corrected, Ink's screen-reader support was softened to "basic" (Ink's own README wording), and the Node line was stated with dates rather than as "the current LTS" (Node 24 is Active LTS until 2026-10-20; Node 26 becomes Active LTS on 2026-10-28).
- The **ninth route** ("Anthropic-native Bedrock") is an AWS API capability, not a the reference agent route, and was removed from the findings so it cannot leak into this implementation's route set.

**Claims that survived verification unchanged** include the permission rule precedence and mode semantics, the Bash matching rules, the path-rule anchors and symlink asymmetry, the hook exit-code contract, the MCP batching defaults, the Anthropic SSE event sequence and cumulative-usage rule, the Bedrock binary-eventstream distinction, the Vertex and Foundry body differences, the Ink and OpenTUI engine floors, the `node:sqlite` stability position, the `keytar` archive, the toolchain version floors, the session storage layout and the "no centralized index" fact, and the seccomp-notifier prohibition.

---

## 9. Version-sensitivity — what must not be read as 2.1.303 behavior

The target was built 2026-10-18 (`BUILD_TIME: "2026-10-18T20:20:57Z"`, `GIT_SHA: "07df2aedd2d01d2f60907b8404acbda187b04072"`, `VERSION: "2.1.303"` — all read directly from the pinned artifact's source). The following findings describe **later** releases or the current upstream, and the plan must not inherit them as target behavior without a fresh REA check:

| Finding | Version it describes | How the plan treats it |
|---|---|---|
| `permissions.ask` beats `allow`; `dontAsk` mode | later modes work | Needs a REA check against 2.1.303 before being treated as target behavior; this implementation may implement it as a superset |
| The 50-subcommand cap | believed fixed in 2.1.90, but the changelog phrase sits under a **PowerShell** permission context, so the Bash path is unconfirmed — single-source | This implementation must simply not have the cap |
| The command validator that stripped quoted text | pre-2026 (nearest advisory: CVE-2025-66032, Dec 2025) | This implementation must not strip quoted text before checking |
| The file-tool symlink TOCTOU fix and the Grep/Glob `Read` deny-rule fix | 2.1.251 (confirmed in the changelog) | This implementation must re-resolve the path after the check |
| The "sensitive-`/proc` block" | **not confirmed** in any changelog; the source is a vendor blog | This implementation must not expose the parent environment to a tool |
| The PreToolUse `allow`-overrides-`ask` removal | ~2.1.78/79 | This implementation picks one behavior and documents it; it must not silently change |
| `auto` as the terminal built-in default | 2.1.283 | Needs a REA check |
| `default` as the headless built-in default | 2.1.302 | Needs a REA check |
| MCP `2026-07-28` negotiation by default | 2.1.292 | This implementation supports both eras; the target's actual behavior needs a REA check |
| The `2025-11-25` MCP revision | current stable | This implementation supports both eras |
| The 2.0→2.1 transcript format break | 2.1.0, per a third-party package's skill doc — **unverified for 2.1.303** | This implementation's own format is independently versioned |
| The `auto` mode availability overrides | `disableAutoMode` "disable"; HIPAA configuration (v2.1.285+); server-side kill switch | This implementation implements all three |
| `CLAUDE_CODE_AUTO_MODE_MODEL` | requires v2.1.302 — inside the target's range, but it takes a full model id set through `settings.json` `env`, not a process env var | This implementation follows the same shape |
| `permissions.disableBypassPermissionsMode` / `disableAutoMode` | managed settings | Treat as implementation-only, not target-compatible, until checked |

**The general rule for this project:** anything in this report that is version-sensitive is a *hypothesis about the target* until a REA check against the pinned binary confirms it. The coverage audit's status vocabulary exists for exactly this, and the plan's `CC-018` task must not report a compatibility claim whose evidence class is not `REA observed`.

---

## 10. Recommendations

**Immediate — changes the plan as written:**

1. Target **Node 24**, not Node 22. It costs nothing and buys a year of runway.
2. Keep **JSONL** for sessions and **do not** adopt `node:sqlite`; the module is release-candidate status with an open CVE and a moving API.
3. Pin **zod v4** explicitly and use `z.strictObject()`/`z.looseObject()`; do not depend on `zod-to-json-schema`.
4. Use **Ink 8** with `incrementalRendering` enabled, a maintained markdown renderer, **no** alternate screen, and an explicit screen-reader pass. Assume the open CJK IME bug and the `setRawMode` memory growth are live, and soak-test both.
5. Shell out to the platform CLI for keychain access; do not use `keytar`.
6. Package with **Bun `bun build --compile`** and re-validate every `node:` API assumption under Bun.

**Immediate — security posture the plan must encode:**

7. Implement the rule evaluator as **per-sub-command** evaluation with **no sub-command cap**, and treat the evaluator as a security boundary — parse the command the way the shell will, or refuse to make the claim.
8. Re-resolve every path **after** the permission check and before the write; make allow rules require both the requested and resolved path to match, and deny rules fire if either does.
9. Show the **resolved** destination in the approval prompt, not the literal command string.
10. Make the sandbox cover `Read`/`Edit`/`WebFetch` and hooks, or state clearly that it does not — the target's own split is a documented weakness.
11. Treat an MCP tool description change as a **re-approval event**; the "rug pull" gap is the single most-cited MCP weakness.
12. Disclose, at folder-trust time, that accepting the prompt will execute project-defined MCP servers.

**For the REA phase still open:**

13. Confirm the target's MCP protocol era (legacy handshake versus stateless `_meta`) from the binary.
14. Confirm the target's permission-mode set and its built-in defaults, since the documentation is version-sensitive here.
15. Confirm the target's session-selection rules for `--continue` and `--resume`, including the skip list.

---

## 11. Full source list

**Anthropic / the reference agent documentation**
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]

**Anthropic SDK source**
- https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/packages/bedrock-sdk/src/client.ts
- https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/packages/vertex-sdk/src/client.ts
- https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/packages/foundry-sdk/src/client.ts
- https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/lib/bedrock/_client.py
- https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/lib/bedrock/_stream_decoder.py
- https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/lib/vertex/_client.py
- https://github.com/anthropics/anthropic-sdk-python/issues/2023
- https://github.com/anthropics/anthropic-sdk-typescript/pull/1081
- https://github.com/anthropics/anthropic-sdk-typescript/pull/1239

**Cloud provider documentation**
- https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html
- [vendor source]
- https://docs.aws.amazon.com/bedrock/latest/userguide/inference-messages-api.md

**MCP specification**
- https://blog.modelcontextprotocol.io/posts/2026-07-28
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
- https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns
- https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices
- https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://raw.githubusercontent.com/modelcontextprotocol/specification/main/schema/2025-11-25/schema.ts
- https://raw.githubusercontent.com/modelcontextprotocol/specification/main/schema/2026-07-28/schema.ts
- https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md
- https://modelcontextprotocol.info/specification
- https://unit42.paloaltonetworks.com/model-context-protocol-attack-vectors
- https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks
- https://www.ox.security/blog/mcp-supply-chain-advisory-rce-vulnerabilities-across-the-ai-ecosystem/
- https://github.com/advisories/GHSA-w48q-cv73-mx4w
- https://github.com/advisories/GHSA-8jxr-pr72-r468
- https://github.com/advisories/GHSA-rjr6-rcgv-9m7m
- https://github.com/advisories/GHSA-6xpm-ggf7-wc3p
- https://threat-modeling.com/cve-2026-11624-mcp-dns-rebinding
- https://www.oligo.security/blog/critical-rce-vulnerability-in-anthropic-mcp-inspector-cve-2025-49596
- https://jfrog.com/blog/2025-6514-critical-mcp-remote-rce-vulnerability
- https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-poisoning-auto-execution-20260701

**Provider-manager precedents**
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/overrides.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/slash-commands.html
- https://github.com/anomalyco/models.dev
- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/models/
- https://opencode.ai/docs/sdk/
- https://roocodeinc.github.io/Roo-Code/features/api-configuration-profiles/
- https://github.com/roocodeinc/roo-code/issues/3399
- https://github.com/RooCodeInc/Roo-Code/issues/9208
- https://github.com/RooCodeInc/Roo-Code/issues/12034
- https://github.com/RooCodeInc/Roo-Code/issues/5442
- https://docs.cline.bot/getting-started/authorizing-with-cline
- https://docs.cline.bot/features/auto-approve
- https://docs.cline.bot/sdk/guides/permission-handling
- https://github.com/cline/cline/issues/4676
- https://github.com/cline/cline/discussions/10627
- https://goose-docs.ai/docs/guides/config-files
- https://goose-docs.ai/docs/getting-started/providers/
- https://aider.chat/docs/config/api-keys.html
- https://aider.chat/docs/config/adv-model-settings.html
- https://docs.continue.dev/reference
- https://docs.continue.dev/faqs
- https://github.com/nousresearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md

**Terminal UI**
- https://registry.npmjs.org/ink
- https://registry.npmjs.org/@opentui/core
- https://registry.npmjs.org/blessed
- https://www.npmjs.com/package/ink-markdown
- https://opentui.com/docs/getting-started/runtime-support
- https://opentui.com/docs/components
- https://github.com/vadimdemedes/ink
- https://github.com/vadimdemedes/ink/releases/tag/v8.0.0
- https://github.com/vadimdemedes/ink/issues/759
- https://github.com/vadimdemedes/ink/issues/870
- https://github.com/vadimdemedes/ink/issues/978
- https://github.com/vadimdemedes/ink/issues/986
- https://github.com/vadimdemedes/ink/issues/942
- https://github.com/vadimdemedes/ink/issues/927
- https://github.com/vadimdemedes/ink/discussions/657
- https://github.com/anomalyco/opentui/issues/423
- https://github.com/anomalyco/opentui/issues/1493
- https://github.com/anomalyco/opentui/issues/1339
- https://github.com/openai/codex/issues/20489
- https://raw.githubusercontent.com/sst/opencode/dev/packages/tui/package.json
- https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- https://builder.aws.com/content/3ExHwKXOYSZjNT4W6HE4aGFCtpw/from-rust-to-reactink-the-architecture-behind-kiro-clis-classic-vs-tui-mode
- https://blog.openreplay.com/opentui-alternative-ink/
- https://pi.dev/docs/latest/tui
- https://github.com/wistrand/melker/blob/main/agent_docs/tui-comparison.md

**Toolchain**
- https://endoflife.date/nodejs
- https://www.osseva.io/eol/nodejs
- https://registry.npmjs.org/vitest/5.0.5
- https://vitest.dev/guide/migration
- https://vitest.dev/config/experimental
- https://nodejs.org/docs/latest-v22.x/api/test.html
- https://nodejs.org/docs/latest-v22.x/api/typescript.html
- https://nodejs.org/docs/latest-v22.x/api/sqlite.html
- https://registry.npmjs.org/zod/4.6.7
- https://zod.dev/v4/changelog
- https://github.com/colinhacks/zod/issues/4371
- https://github.com/StefanTerdell/zod-to-json-schema
- https://github.com/coleam00/archon/issues/1811
- https://valibot.dev/guides/comparison/
- https://github.com/open-circle/valibot/issues/1408
- https://schemabenchmarks.dev/parsing
- https://github.com/nodejs/node/issues/57445
- https://github.com/nodejs/node/pull/61262
- https://www.digitalapplied.com/blog/nodejs-july-2026-security-releases-shipped
- https://registry.npmjs.org/better-sqlite3
- https://github.com/atom/node-keytar
- https://github.com/drudge/node-keychain
- https://github.com/magarcia/cross-keychain
- https://npmjs.com/package/@napi-rs/keyring
- https://github.com/microsoft/azure-devops-mcp/issues/1706
- https://www.npmjs.com/package/pkg
- https://nodejs.org/api/single-executable-applications.html
- https://joyeecheung.github.io/blog/2026/01/26/improving-single-executable-application-building-for-node-js
- https://flaviocopes.com/javascript-single-executable
- https://bun.com/docs/bundler/executables
- https://registry.npmjs.org/@modelcontextprotocol/sdk/1.32.1
- https://github.com/stylelint/stylelint/issues/8864
- https://github.com/vitest-dev/vitest/discussions/4631

**Session and transcript format**
- https://github.com/weirdgiraffe/reference-agent-sessions-explorer/blob/main/docs/JSONL-SCHEMA.md
- https://github.com/coo-labs/tjsonl/blob/main/spec/transcript-schema-spec.md
- [vendor source]
- https://github.com/sweetcornna/open-reference-agent/blob/main/docs/en/internals/session-transcript-persistence.md
- [vendor source]
- https://github.com/anthropics/reference-agent/issues/100824
- https://github.com/anthropics/reference-agent/issues/53516
- https://github.com/anthropics/reference-agent/issues/60845
- https://github.com/anthropics/reference-agent/issues/89380
- https://github.com/anthropics/reference-agent/issues/22526
- https://github.com/anthropics/reference-agent/issues/24304
- https://github.com/anthropics/reference-agent/issues/46603
- https://github.com/anthropics/reference-agent/issues/49996
- https://github.com/anthropics/reference-agent/issues/55818
- https://github.com/anthropics/reference-agent/issues/92849
- https://github.com/anthropics/reference-agent/issues/26212
- https://github.com/anthropics/reference-agent/issues/96619
- https://github.com/anthropics/reference-agent/issues/69364
- https://github.com/ymonster/cc_jsonl_fix
- https://github.com/skillsynchq/txcript/blob/main/docs/formats/codex.md
- https://github.com/kvsankar/agent-history/blob/master/docs/codex-format.md
- https://github.com/diegoami/opencode-session-browser/blob/main/docs/OPENCODE_STORAGE.md
- https://github.com/Erickrus/opencode_migrate/blob/main/SESSION_ARCHITECTURE.md
- https://github.com/Upnit-b/cline-coding-agent/blob/main/docs/troubleshooting/task-history-recovery.mdx
- https://vshulcz.github.io/deja-vu/registry/cline.html
- https://gist.github.com/idvorkin/4c46af32afa94a7dacedb685f2bc56f2
- https://aider.chat/docs/usage/commands.html
- [vendor source]

**Permissions and security**
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- [vendor source]
- https://github.com/anthropics/reference-agent/pull/36645
- https://github.com/anthropics/reference-agent/issues/36059
- https://github.com/anthropics/reference-agent/issues/20085
- https://github.com/anthropics/reference-agent/issues/27493
- https://github.com/anthropics/reference-agent/issues/83495
- https://github.com/anthropics/reference-agent/issues/21705
- https://github.com/anthropics/reference-agent/security/advisories/GHSA-4q92-rfm6-2cqx
- https://github.com/anthropics/reference-agent/security/advisories/GHSA-66m2-gx93-v996
- https://github.com/anthropics/reference-agent/security/advisories/GHSA-pmw4-pwvc-3hx2
- https://adversa.ai/blog/critical-reference-agent-vulnerability-deny-rules-silently-bypassed-because-security-checks-cost-too-many-tokens/
- https://adversa.ai/blog/the-approval-prompt-is-lying-to-you-symlink-rce-in-five-ai-coding-agents-reference-agent-cursor-antigravity-copilot-grok-build/
- https://codeant.ai/security-research/reference-agent-macos-parent-directory-toctou-vulnerability
- https://startdebugging.net/2026/08/reference-agent-2-1-251-four-ways-around-the-permission-check/
- https://www.microsoft.com/en-us/security/blog/2026/06/05/securing-ci-cd-in-agentic-world-reference-agent-github-action-case/
- https://www.promptarmor.com/resources/hijacking-reference-agent-via-injected-marketplace-plugins
- https://flatt.tech/research/posts/poisoning-reference-agent-one-github-issue-to-break-the-supply-chain/
- https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-ci-prompt-injection-20260807/
- https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-coding-agent-cicd-secrets-20260808-csa/
- https://www.securityweek.com/
- https://thehackernews.com/2026/08/reference-agent-and-gemini-cli-flaws-let.html
- https://tracebit.com/blog/code-exec-deception-gemini-ai-cli-hijack
- https://xplo1t-sec.github.io/posts/exploiting-a-parsing-flaw-in-gemini-cli-to-execute-any-command/
- https://arxiv.org/pdf/2510.26328
- https://github.com/openclaw/openclaw/security/advisories/GHSA-mwcg-wfq3-4gjc
- https://github.com/Aider-AI/aider/pull/3773
- https://github.com/openai/codex/blob/main/codex-rs/execpolicy/README.md
- https://learn.chatgpt.com/docs/sandboxing
- https://learn.chatgpt.com/docs/agent-configuration/rules
- https://github.com/openai/codex/issues/9206
