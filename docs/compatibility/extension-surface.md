# Extension surface conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.8 "MCP, plugins, and hooks".
**Owning tasks:** `CC-011` (MCP and the control surface), `CC-012` (hooks), `CC-013` (skills, subagents, plugins, marketplaces, IDE), `CC-011b` (the subagent definition lifecycle and the standalone skill scan), `CC-034` (the agent-team surface).
**Matrix rows:** F-28 … F-33 in [`feature-matrix.md`](feature-matrix.md).

Every row names its **evidence class**: `REA observed`, `Documented only`, or `implementation choice`.

The `CC-011b` milestone closed the residual the audit had left: the **subagent definition lifecycle** and the **standalone (non-plugin) skill directory scan** were *"not traced to resolved relations"*, and the residual was then closed by **reading the target's own source**. The rules of both surfaces are therefore **REA observed** below, and the sections that used to call them *"entirely a implementation choice"* now say which part of each rule is the target's and which part is this implementation's.

## The host control-request surface

The host dispatcher handles **exactly 23** control-request subtypes. `can_use_tool` is **not** one of them: the target classifies it as *agent-originated* and refuses it when a host sends it.

```
initialize                 set_model                 set_max_thinking_tokens
set_permission_mode        rename_session            set_color
file_suggestions           read_file                 get_workspace_diff
get_context_usage          get_usage                 mcp_status
mcp_authenticate           mcp_oauth_callback_url    mcp_reconnect
interrupt                  apply_flag_settings       mcp_set_servers
stop_task                  background_tasks          cancel_async_message
side_question             fork_conversation
```

### The callbacks

| Subtype | Callback | Extra argument |
|---|---|---|
| `mcp_authenticate` | `onMcpAuthenticate` | `request.redirectUri` |
| `mcp_oauth_callback_url` | `onMcpOauthCallbackUrl` | `request.callbackUrl` |
| `mcp_reconnect` | `onMcpReconnect` | — |

When the required callback is **not registered**, the reply is a `control_response` of subtype `error` with the message:

```
<subtype> is not supported in this context (callback not registered)
```

`mcp_status` replies with `{ mcpServers: [] }` in the observed context. `fork_conversation` replies with `{ forked: false, error: "unsupported", reason: "requires_remote_control_server" }` when the remote control server is absent.

### The directional policy

The target refuses control-request subtypes **by direction**, and the wording differs per direction:

| Direction | Subtypes | The target's wording |
|---|---|---|
| service → agent | `mcp_tasks_changed` | "sent to a cloud agent by the service, not by a host" |
| attached client → agent | `register_device_hooks`, `upload_device_hook_template`, `remote_tools_announce` | "sent to a cloud agent by the attached client, not by a host" |
| agent-originated | `can_use_tool`, `hook_callback`, `elicitation`, `request_user_dialog`, `oauth_token_refresh`, `host_auth_token_refresh`, `remote_tool_call`, `remote_plumbing_call`, `remote_tools_probe`, `remote_tools_reannounce`, `remote_control_work_secret` | "agent-originated and cannot be sent by a host" |

## The transport permission dispatcher

`can_use_tool` arrives at a **separate** dispatcher. This implementation reuses the one in `src/permissions/prompts.ts` rather than duplicating its validation. Its observable rules:

- only the `can_use_tool` subtype is accepted;
- a `request_id` that is **not a string** is **dropped with no response** — no response is possible;
- a malformed request is denied with a synthesized denial;
- an in-flight `request_id` is not dispatched twice;
- a computer-folder prompt whose input is not exactly three string arguments is denied;
- a path or computer name containing CR, LF, U+2028 or U+2029 is denied;
- a path not equal to its own normalized form is denied.

## The MCP client lifecycle

| Element | Behavior | Evidence class |
|---|---|---|
| Connect | `connectToServer` / `ensureConnectedClient` | REA observed |
| Connect memo | memoized; dropped on an identity-epoch change, when stale, or explicitly | REA observed |
| State | `hasLiveConnection`, `hasUnsettledDial` | REA observed |
| Batching | 3 local, 20 remote | REA observed |
| Negotiation | the modern revision is probed **first**; the legacy handshake is the fallback; `MCP_PROTOCOL_NEGOTIATION=legacy` opts out | REA observed (the target's default); the exact fallback ladder is a implementation choice |
| Capabilities | tools, commands, resources and resource templates are fetched **separately** and aggregated | REA observed |
| Listing | a listing-hydration path alongside the fetch path, with a discover-prior memo | REA observed |
| Tool composition | the tool the model sees is composed, with its instructions capped | REA observed |
| Calling | a tool call, with a URL-elicitation retry variant | REA observed |
| Auth failures | classified, with the error body inspected for a code | REA observed |
| Fetch variants | four — a vendor first-party proxy fetch, a first-party API fetch, a CLI-owned bearer fetch, and a CCR proxy fetch | REA observed |
| Timeouts | four — armed-request, request, tool, and tool-**idle** | REA observed |
| Teardown | detach-and-close, dispose-detached, cleanup of the connected clients | REA observed |
| Reconnect | a deliberately inert reconnect shape | REA observed |
| Events | a connection event is published | REA observed |

### The stdio transport

The process is spawned with `shell: false`, `stdio: ["pipe", "pipe", stderr ?? "inherit"]`, an environment merged from the parent plus the server's own `env`, and `windowsHide` only on Windows. The server types are `stdio` and `sdk`; the observed protocol methods are `initialize`, `tools/list` and `tools/call`.

### Tool naming

`mcp__<server>__<tool>`. `mcp__ide__executeCode` and `mcp__ide__getDiagnostics` are special-cased and are exempt from the general "hide `mcp__ide__` tools" filter.

## The known MCP gap this implementation closes

The known MCP weakness is that **clients do not notify the user when a tool description changes**, so a "rug pull" — a tool that changes its interface after approval — goes unnoticed. This implementation treats the notification as a **project requirement**, not as target behavior, and the module header says so.

## Hooks

### The event surface

The hooks reference documents **33** events. This implementation adds **no** reason kind: the vocabulary is the target's six, and the case where no rule matched at all is the target's `permissionPromptTool` ("a **named tool** requires approval for this command"). The distinction this implementation still needs is carried by the decision's own `noRuleMatched` marker, which is not a reason kind.

### The result merge rules

When two hook results are combined:

- a **permission decision** is merged by **strictness**, with `allow: 1`, `ask: 2`, `deny: 3` — the **stricter** decision wins, and the reason is taken from the stricter one;
- `additionalContext` and `watchPaths` are **concatenated**; every other member takes the newer value;
- the block reason is `permissionDecisionReason`, or `Blocked by hook` when the hook denied without giving a reason;
- an `allow` decision carrying `updatedPermissions` maps each permission, and a `setMode` permission's mode is **normalized** before it is applied;
- when a hook result is merged into a permission-request result, the result carries `permissionBehavior`, `hookPermissionDecisionReason`, `permissionRequestResult`, and the `updatedInput` **only when the behavior is `allow`**.

### The `PreToolUse` decision — this implementation's pick

The target changed this behaviour in a later release without a deprecation warning, so the target's own behavior at `2.1.303` is ambiguous from the outside. This implementation picks the **stricter** of the two:

- a `PreToolUse` hook returning `allow` does **not** override a deny rule and does **not** override an ask rule;
- a `PreToolUse` hook returning `deny` holds in **every** mode, `bypassPermissions` included;
- a rewritten input is re-checked with the **whole** permission check against the **effective** input, and a rewritten input the tool's validator rejects **denies** the call.

**Evidence class:** REA observed (the mechanism — a `PreToolUse` hook can return `permissionDecision` of `allow | deny | ask | defer` and an `updatedInput`) + **implementation choice** (which of the target's two behaviors this implementation takes, and the exact precedence between the `PreToolUse` seam and the `PermissionRequest` seam).

### The matcher semantics

A matcher containing only letters, digits, `_`, `-`, space, `,` and `|` is an **exact-string** (or `|`-separated) match; anything else is an **unanchored** JavaScript regular expression. A bare `mcp__memory` matches nothing, while `mcp__memory__.*` matches all of a server's tools.

### The exit-code contract

`0` is success and applies the JSON output; `2` is a blocking error on a blockable event; anything else is a non-blocking error. A `PreToolUse` hook can return `permissionDecision` of `allow` | `deny` | `ask` | `defer` and an `updatedInput` to rewrite the tool arguments.

## Skills

### The override modes

A skill's override mode is one of exactly four:

| Mode | Meaning |
|---|---|
| `on` | fully enabled |
| `name-only` | mentioned by name only, not auto-invoked |
| `user-invocable-only` | only the user can invoke it |
| `off` | disabled |

The override for a skill is resolved by searching, in order: the **merged settings** `skillOverrides`, then the **session's** `skillOverrides`, then the `skillOverrides` of the `policySettings` and `flagSettings` tiers. The first source that defines the skill wins. The lookup is null-safe, and the target itself **guards against `__proto__`** as a skill name.

### The save protocol

A skill folder that holds **synced copies of the user's account skills** is special: a change or a new file there is **not** saved to the account, the model must not report it as saved, and the next account sync can overwrite or remove it. The note the target appends is:

> Note: this file is inside the folder that holds synced copies of the user's account skills. A change or new file here is not saved to their account, so do not report it as saved, and the next sync from their account can overwrite or remove it.

The tool that saves a skill is described by a capability set (`review`, `card`, `cloud`, `linked`, `policy`) and five guidance modes, each with its own wording:

| Mode | The guidance |
|---|---|
| `save_tool` | "To save a skill change for the user, use the `<tool>` tool." |
| `propose_tool` | "To let the user save this change, call `<tool>` with the complete SKILL.md." |
| `send_file` | "To pass this change to the user, send them the complete SKILL.md with the `<tool>` tool." |
| `no_save_tool` | "This session has no tool that saves a skill to the user's account: tell the user that this change is not saved, and point them to their claude.ai settings, where skills are managed." |
| `report_unsaved` | "Say in your reply that this change is not saved to the user's account." |

The mode is selected as follows: a **remote call**, or a call with an `agentId`, or a file list containing no `skill.md` (compared case-insensitively by basename), all select `report_unsaved`. Otherwise the session's tools are inspected: when the mode would be `send_file` but there is no send-capable tool, the answer is `no_save_tool`; otherwise the mode stands. The folder note is appended only for a known mode.

## The extension-point registry

The target exposes a fixed set of extension points, and a plugin or SDK host registers a handler for each:

```
tool.call        tool.check         tool.describe      command.run      command.describe
config.set       config.describe    telemetry.log      telemetry.mark   prompt.submit
prompt.fill      prompt.edit        prompt.change      prompt.autocomplete
prompt.suggest   prompt.section     prompt.context     prompt.attachment
prompt.mention   prompt.compose     agent.offer        agent.spawn      skill.prompt
attribution.text session.start     session.receive    session.append   session.send
session.compact  session.attach     session.detach     session.measure  session.end
turn.start       turn.step          turn.complete      ui.scroll        ui.focus
```

Two carry a documented default. `tool.call` is given a `tool_use_id` when the caller did not supply one, of the form `toolu_<uuid without dashes>`. `telemetry.log` is given a destination of `anthropic` unless the caller asked for `collector`.

**The skill frontmatter rule.** A skill's frontmatter must carry a **text** description. The `skill.prompt` extension point validates it: it finds the first of `source`, `pluginName`, `path`, or `frontmatterProblem` whose value is not a string, and throws `$.skill.prompt: called with a frontmatter that <that> is no text`; when the frontmatter is itself a plain string it throws `$.skill.prompt: called with a frontmatter that is no text`. The resolved skill then carries a `source`, defaulting to `built-in`.

## Plugins

### The manifest schema

A plugin's manifest declares its content in two groups of keys:

| Group | Keys |
|---|---|
| **directory** | `commands`, `agents`, `skills`, `outputStyles`, `themes`, `workflows`, `monitors` |
| **file** | `mcpServers`, `lspServers`, `hooks` |

Each key may be declared at the **top level** or under **`experimental`**, and a value may be a **single path string** or an **array of path strings**. `commands` may additionally be an **object** whose entries carry a `source` path. A manifest that is not a JSON object is `broken` with the reason *"it is not a JSON object"*. A plugin can present **several manifest candidates** (for example `.claude-plugin/plugin.json`). A plugin is `ok` when a **`SKILL.md` exists at the plugin root**.

The target's own schema declares **twenty-nine** keys in all, in three groups — the **identity** group, the **content** group and the **experimental** group — and the full list, with the types and the defaults, is in the section below.

### The command discovery rules

A plugin's `commandsPaths` are loaded in two shapes:

- a **directory** — its `.md` files are the commands; a directory with neither `.md` files nor `SKILL.md` in subdirectories is a **warning**, not an error: *"Warning: No commands found in plugin `<name>` custom directory: `<path>`. Expected .md files or SKILL.md in subdirectories."*;
- a **file** — it must end in `.md`; a file that exceeds the command **byte limit** is skipped with *"Skipping plugin command `<path>`: exceeds `<N>` byte limit"*.

A command's **name** is `<plugin>:<basename without the .md>`, unless a `commandsMetadata` entry declares a `source` that resolves to the same path, in which case the name is `<plugin>:<metadata key>`. A `commandsMetadata` entry with `content` but **no** `source` is an **inline** command: its name is `<plugin>:<key>` and its path is the pseudo-path `<inline:<plugin>:<key>>`.

The frontmatter is parsed with **key normalization**, and the parse reports the frontmatter **as written** alongside a **problem** describing what was wrong with it — so a malformed frontmatter is surfaced rather than silently dropped. The skill body is **interned**, so identical skill contents are stored once.

The skill telemetry events observed are `tengu_propose_skills`, `tengu_propose_skills_read_check` and `tengu_propose_skills_kept_lines`, plus a `skills_load_ms` timing event. The `propose_skills` path has its own read check — it refuses a proposal whose file it cannot `stat` or read.

### The marketplace install flow

The result of `installPluginFromMarketplace` carries `{ success, message, depNote, installedDisabled, installedDisabledByDefault, enableHint, otherProjectsNote }`.

- The install records the plugin's **version**, the **install source** (`ui-suggestion` or `ui-discover`), the **trigger**, and the **surface**.
- The install can **succeed while the plugin stays disabled**. The result distinguishes the two reasons: `installedDisabledByDefault` is reported as `by-default` and `installedDisabled` (a setting turned it off) as `in-settings`.
- A successful install returns an **enable hint** — `enable it in /plugin` or `enable it in /plugin or run: <command>`.
- A **refused** install is distinct from a **failed** one. A refusal is logged at `info` level with `installPluginFromMarketplace refused for <plugin>: <reason>` and a failure reason of `command-source-refused` — the install is refused when the **command source** is not trusted — while a genuine failure is logged at `error` level with `failed`. The telemetry carries the reason (`failureCode`, `command-source-refused`, or `unexpected-error`), an `errorKind`, the plugin id, the marketplace name, the trigger, and the surface.
- A **stray orphan marker** left in a staged plugin is removed, with the warning `Could not drop a stray orphan marker from the staged plugin: <reason>`.
- A version transition is computed as a `{ from, to }` pair.

## The plugin and marketplace protocol

**REA observed.** The protocol was read out of the target's own source — the zod
schemas, the loader, the cache and the autoupdater — and every claim below names
the file and the offset it came from. The full record, with the method and the
discrepancies against the earlier sweep, is
`/home/shiva/opt/reference-agent-rea/analysis/findings-marketplace.md`.

The claims below are pinned by **`tests/contracts/plugin-protocol.test.ts`**. The
compatibility harness's own probe for the matrix row that carries them
(`tests/compatibility/scenarios.ts`) does not measure them yet — that file is
the orchestrator's, and the row is re-measured when this milestone's report is
regenerated.

### The marketplace source types — ten, and eleven in the policy lists

The target's schema is a **discriminated union** on the key `source`
(`chunk-c9s0jh80.js:105243`), and it has **ten** declarable members:

| `source` | The fields | What it reaches |
|---|---|---|
| `url` | `url`, `headers?`, `headersHelper?` | an HTTP fetch |
| `github` | `repo`, `ref?`, `path?`, `sparsePaths?`, `skipLfs?` | a clone |
| `git` | `url`, `ref?`, `path?`, `sparsePaths?`, `skipLfs?` | a clone |
| `npm` | `package`, `version?`, `registry?` | an npm registry |
| `file` | `path` | a local catalogue file |
| `directory` | `path` | a local directory |
| `skills-dir` | — | a **policy-list sentinel** |
| `hostPattern` | `hostPattern` | a **policy-list sentinel** |
| `pathPattern` | `pathPattern` | a **policy-list sentinel** |
| `settings` | `name`, `plugins`, `owner?` | a settings file |

The **policy lists** — the managed-settings allowlist and blocklist — carry **one**
more member, `pluginDirectory`, the built-in Directory marketplace
(`chunk-c9s0jh80.js:114636`). The target's own description says it *"cannot be
added or declared anywhere else"*.

Two more source values are accepted by the target's own switch but are
**runtime-only** — the runtime produces them, nobody authors them: `claudeai`
and `pluginDirectory` (`chunk-4jsg44k7.js:4156876`).

The **canonical form** of a source is the target's own (`K1`,
`chunk-4jsg44k7.js:4156876`): `github:<repo>[@<ref>]`, the sanitised URL for
`url`, `git:<url>[@<ref>]`, `npm:<package>`, `file:<path>`, `dir:<path>`,
`hostPattern:<pattern>`, `pathPattern:<pattern>`, `skills-dir`,
`settings:<name> (N plugins)`, `claude.ai`, `Anthropic Directory`, and
`unknown source` for a source the target does not know.

The **description** of a source is the target's own (`HPt`,
`chunk-4jsg44k7.js:4155409`): the repository, the sanitised URL, the path,
`settings:<name>`, `claude.ai`, `Built in`, and `Unknown source` for the four
types the target does not describe — `npm`, `skills-dir`, `hostPattern` and
`pathPattern`.

**This implementation.** `src/extensions/plugins/marketplaceSources.ts` carries the
ten types, the eleventh, the two runtime-only ones, the canonical form, the
description, and the capability each source needs.

### The plugin source types — seven named, and eight canonical kinds

The target's schema is a **union** whose first member is a bare **path string**
(`chunk-c9s0jh80.js:116671`):

| The source | The fields |
|---|---|
| a path string | the plugin root, relative to the marketplace root |
| `npm` | `package`, `version?`, `registry?` |
| `url` | `url`, `ref?`, `sha?` |
| `github` | `repo`, `ref?`, `sha?` |
| `git-subdir` | `url`, `path`, `ref?`, `sha?` |
| `archive` | `url`, `sha256?` |
| `command` | `command`, `timeout?`, `mode?` |
| `unsupported` | `error?` — a **parse-time placeholder**, never authored |

The **named** set is `Sy` — the seven `npm`, `url`, `github`, `git-subdir`,
`archive`, `command`, `unsupported` (`chunk-c9s0jh80.js:126841`) — and the
**canonical kinds** are `iss` — the eight `local`, `npm`, `github`, `git`,
`subdir`, `archive`, `command`, `unknown`
(`chunk-4jsg44k7.js:4481234`). A path becomes `local`, a `url` becomes `git`, a
`git-subdir` becomes `subdir`, and the kind is also the **directory name** the
plugin is cached under.

**This implementation.** `src/extensions/plugins/pluginSources.ts` carries both
vocabularies, the shapes, the validation (the `sha` is a full 40-character
lowercase commit SHA, the `sha256` a 64-character hex digest, the archive's URL
`https`, the command printable ASCII with no runs of four spaces), and the
capability each source needs.

### The plugin manifest — twenty-nine keys

`chunk-c9s0jh80.js:102436` — the target's manifest is **one object schema
composed of seventeen sub-schemas**, and it declares **twenty-nine** keys:

| Group | The keys |
|---|---|
| **identity** | `$schema`, `name`, `displayName`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `defaultEnabled`, `dependencies`, `metadata` |
| **content** | `hooks`, `commands`, `agents`, `skills`, `outputStyles`, `themes`, `workflows`, `channels`, `mcpServers`, `lspServers`, `monitors`, `settings`, `types`, `userConfig`, `binaries` |
| **experimental** | `experimental` |

Only **`name`** is required, and only two keys carry a default the target's own
text names: `defaultEnabled` is **true**, and the catalogue entry's `strict` is
**true**. Every path a manifest declares is **relative to the plugin root** and
**starts with `./`** (`chunk-c9s0jh80.js:80773`).

**This implementation.** `src/extensions/plugins/manifestSchema.ts` carries the
twenty-nine keys with their types and their defaults, and validates a manifest
against them — naming the key a manifest gets wrong.

### The frontmatter — forty-two, twenty-two and four

The target parses three kinds of frontmatter, and **all three are strict**
(`chunk-4jsg44k7.js:731474`):

| The file | The keys | Where |
|---|---|---|
| a **skill** (`SKILL.md`) | **42** | `chunk-4jsg44k7.js:724143`, `:725756` |
| an **agent** (`agents/*.md`) | **22** | `chunk-4jsg44k7.js:728221` |
| an **output style** (`output-styles/*.md`) | **4** | `chunk-4jsg44k7.js:730964` |

The value types are the target's own three shorthands: the **scalar**
(`string | number | boolean | null`), the **list** (the scalar, or an array of
strings), and the **free** (any value). The defaults the target's text names are
a skill's `name` (the file's name), a skill's `shell` (**bash**, on every
platform), an agent's `observeSubagents` (**true**), and an output style's
`name` (the file's name).

**The two lists that are not the schema.** The target keeps a **62-key**
normalisation list (`chunk-gdvkvrkd.js:4198`) and a **42-key** skill
declared-field list (`chunk-081t8575.js:100908`). Both are supersets of the
schema keys and carry keys no schema declares — `type`, `originSessionId`,
`evals`, `compatibility`, `hide-from-slash-command-tool` — so they are the
**telemetry's** lists, not the schema.

**This implementation.** `src/extensions/plugins/frontmatterSchema.ts` carries the
three key sets, their types and their defaults, and validates a frontmatter
against the schema for its kind.

### The marketplace catalogue — the manifest and the entries

The **marketplace manifest** (`chunk-c9s0jh80.js:128721`) declares **ten** keys:
`$schema`, `name`, `version`, `description`, `owner`, `plugins`,
`forceRemoveDeletedPlugins`, `metadata`, `allowCrossMarketplaceDependenciesOn`,
`renames`. The `renames` map is **append-only** — an old plugin name to the
current one, or `null` when the plugin was removed — and the target parses it
with a **catch**, so a malformed map is dropped and the manifest still loads.

The **catalogue entry** (`chunk-c9s0jh80.js:124812`) is the **whole plugin
manifest, every key optional**, plus `name`, `source`, `headers`, `headersHelper`,
`category`, `tags`, `strict` (**true** by default) and `relevance`.

An entry that does not parse is **stubbed** — `{name, source: {source:
"unsupported"}, strict: true}` — and **kept**, so that the delisting check does
not read it as removed; an entry with **no name** is **dropped** instead
(`chunk-c9s0jh80.js:126147`). A source whose *type* the target does not know
carries **no reason** in the stub; a known type whose fields are wrong carries
the reason.

**This implementation.** `src/extensions/plugins/catalogue.ts` carries the ten
keys, the entry's shape, the stub and the drop, and the append-only rename map.

### The autoupdater

The **update operation** reports one of four outcomes — `updated`, `up_to_date`,
`skipped`, `failed` (`chunk-4420d0hq.js:102585`) — and the **autoupdater** maps
them onto its own vocabulary (`chunk-wqmf3c8h.js:2646`):

| The operation | The autoupdater |
|---|---|
| `updated` | the plugin id |
| `up_to_date` | nothing |
| `skipped` + `entry_helper_deferred` | `autoupdate-deferred-entry-helper` |
| `skipped` + a pinner | `autoupdate-blocked-by-pinner`, with the version held at, the pinners, and the disabled pins |
| `failed` + a policy code | `autoupdate-disabled-by-policy` |
| `failed` + anything else | **failed** |

The block types are exactly four: `autoupdate-deferred-entry-helper`,
`autoupdate-blocked-by-pinner`, `autoupdate-disabled-by-policy` and
`generic-error`. The **skip reasons** the plugin path produces are exactly three:
`pinner_blocked`, `entry_helper_deferred` and `snapshot_file_refused` — the other
`skipReason` values in the tree (`bare_repo`, `git_error`, `not_git`, `too_large`
and the rest) belong to the **checkpoint** surface, not to plugins.

The failure codes are the target's own — the codes its failure-code map carries
(`chunk-4420d0hq.js:8161`), the entry-helper codes
(`chunk-p9jh4s48.js:25526`), and the ones the plugin surface raises elsewhere:
**67** in all.

**This implementation.** `src/extensions/plugins/autoupdate.ts` carries the
vocabularies and the classification, and the target's own error text for a
Directory plugin whose background update failed.

### The honest boundary — what this implementation refuses

This implementation has **no marketplace server, no plugin registry and no
account**. The **protocol** is reproduced exactly; the **marketplace behind it**
is not, and nothing pretends otherwise.

| The capability a source needs | Which sources | What this implementation does |
|---|---|---|
| `http-fetch` | the `url` marketplace source | **refused** |
| `git-clone` | the `github` and `git` marketplace sources | **refused** |
| `npm-registry` | the `npm` marketplace source | **refused**, with the target's own words — *"NPM marketplace sources not yet implemented"* |
| `filesystem` | the `file` and `directory` marketplace sources | **refused** — the catalogue is *read*, but no catalogue is *reached* |
| `skills-directory` | the `skills-dir` marketplace source | **refused** |
| `policy-list` | the `hostPattern` and `pathPattern` marketplace sources | **refused** |
| `settings-file` | the `settings` marketplace source | **refused** |
| `filesystem` | a path plugin source | **refused** |
| `npm-registry` | the `npm` plugin source | **refused** |
| `git-clone` | the `url` and `github` plugin sources | **refused** |
| `sparse-git-clone` | the `git-subdir` plugin source | **refused** |
| `https-archive` | the `archive` plugin source | **refused** |
| `command-runner` | the `command` plugin source | **refused** |

Every refusal **names the capability it needs**, so a caller can tell a clone
from a fetch from a registry client. The refusal is a **return value**, not an
exception, and it is what `resolveMarketplaceSource` and
`pluginSourceCapability` produce.

### The clone-choice labels

| Label | What it means | Which entries |
|---|---|---|
| **implemented** | the shape is read, validated and reproduced — the target's own keys, types, defaults and rules | the **ten** marketplace source types and their **eleventh** policy-list member; the **seven** named plugin source types and the **eight** canonical kinds; the **twenty-nine** manifest keys; the **forty-two**, **twenty-two** and **four** frontmatter keys; the **ten** catalogue-manifest keys and the catalogue entry; the autoupdater's vocabulary, its codes and its classification; the output styles' remote filter |
| **refused** | the operation is understood, and the refusal names the **capability** it needs and this implementation does not have | every source that would **reach** a marketplace or **install** a plugin — `resolveMarketplaceSource` and `resolvePluginSource` |

The refusals are **return values**, not exceptions: a caller reads the
capability and knows what would have to exist for the operation to run. A
refused source is **not** silently dropped — it is in the vocabulary, it has a
capability, and naming it says what would have to exist.

**Pinned by:** `tests/contracts/plugin-protocol.test.ts` — the source-type, the
capability and the refusal tests.

## Output styles — the remote session

**REA observed.** Over **Remote Control**, or from a **relayed message**, the
target lets the session pick **only the built-in styles**. The predicate is the
target's own — `dispatchedOverBridge === true || submissionVerifiedSlackHumanTurn
=== true` (`chunk-720ca63b.js:1447`) — and a style is remotely selectable only
when it is the built-in "no style" entry, which the target holds as `null`, or
when its source is `built-in` (`chunk-4jsg44k7.js:2269007`).

The target's own note is appended to the command's output:

> Custom output styles can't be selected over Remote Control or from a relayed
> message. Select one in the session itself, or pick a built-in style here.

and the current style is reported as **"a custom style"** when the session is
remote and the current style is not a built-in one.

The command also shows the **list** for a word that asks for the list — `list`,
`show`, `display`, `current`, `view`, `get`, `check`, `describe`, `print`,
`version`, `about`, `status`, `?` — and for the help words `help`, `-h`,
`--help` (`chunk-kmrt4q1v.js:10467`).

**This implementation.** `src/config/outputStyles.ts` carries the predicate, the
filter, the note, the label and the word lists; `src/cli/commands/slash.ts`
applies them.

**Pinned by:** `tests/contracts/output-styles.test.ts` — the remote-session tests.

## Plugins — the manifest's path boundary

**Implementation choice.** §2.8 says nothing about a plugin reaching outside its own root, so the rule is this implementation's. The plan's Global Constraint requires "path boundaries … enforced by **implementation-owned** code, independent of model instructions".

A manifest-declared path is used only when it is inside the plugin root — **lexically** and through **`realpath`** — and a refusal carries one of two named reasons: *"it resolves outside the plugin root"* or *"it is a symlink that resolves outside the plugin root"*. The check applies to the commands, the skills, the agents, the metadata sources and every other manifest key. A path that does not exist is allowed, and it is **reported** — in the log and in the manifest's `problems`, exactly as a refused path is. The `commands` key reports it **twice**: once by the containment at load time (naming the declared path) and once by the command discovery (naming the resolved path, where the commands are read).

**Pinned by:** `tests/contracts/extensions.test.ts` — the path-boundary tests.

## Skills — the discovery order and the scan

The five **origins** — `project`, `local`, `user`, `plugin`, `mcp` — are the plan's. The **order** they take precedence in (`project > local > user > plugin > mcp`) and the meaning of `local` are this implementation's.

The **standalone (non-plugin) skill directory scan** is **REA observed** — the rules are in the section below.

**Pinned by:** `tests/contracts/extensions.test.ts` — the precedence and override tests.

## The standalone skill directory scan

**REA observed** (the residual was closed by reading the target's own source).

### The sources, and the merge

The target reads its skill roots **separately** and **merges them later**: the **managed** directory, the **user** directory (`~/.claude/skills`), the **synced** subtree beneath it, the **host catalog**, every **project** ancestor's `.claude/skills`, each **additional working directory**'s `.claude/skills`, and the **plugin** skills. The **standalone** list and the **plugin** list stay **two separate lists**, and the standalone skills come **first** in the merge.

This implementation reads the **standalone** roots (the caller names them, and each names the tier it stands for) and the **contributions** (the plugin and MCP skills) as two separate lists, and merges them with the standalone first. The **host catalog** is a source this implementation does not have — it is not a filesystem directory, and the merged list is the one place it would have entered.

### The scan of one root

- the scan is a **single `readdir`** — **depth 1, not recursive**;
- each entry must be a **directory or a symlink**;
- the skill file is the **fixed name `SKILL.md`**, with that exact case, **directly** inside the entry.

### The skips

| The entry | The target's rule |
|---|---|
| not a directory or a symlink | dropped |
| the reserved entry name `synced` | skipped with a warning |
| a name that contains `:` — in the **synced** scan only | skipped with a warning |
| an entry whose **plugin is disabled** | skipped |
| a `SKILL.md` that is **not a regular file** | skipped with a warning |
| a `SKILL.md` over **1 000 000 bytes** | skipped with a warning |
| a skill whose **own name is reserved** (`anthropic-skills`) | skipped with a warning |
| a directory that cannot be read | the root yields nothing, with an error |

The **reserved entry name** is compared after the target's fold — the case is folded and the trailing dots and spaces are stripped — so `Synced` and `synced.` are the same name. The **reserved skill name** is `anthropic-skills`, the name "reserved for the skills synced from your claude.ai account"; the refusal says so.

### The frontmatter

**A frontmatter parse failure is not a skip.** It is reported at **error** level and the frontmatter is **ignored** — the skill still loads, without its frontmatter. Any *other* failure while building a skill skips **that one skill**, and the scan continues.

### The cache

The result is **cached per process** and invalidated by the same reload path the agent catalogue uses. This implementation has no file watcher, so the single invalidation point is the explicit **`reload()`** on each registry — the host makes the call on both at once, so the two catalogues are invalidated together. A **new** registry — a new process — reads the disk again.

**Pinned by:** `tests/contracts/extensions.test.ts` — the standalone-scan tests.

## Plugins — the command byte limit

**Implementation choice** for the number; the **wording** is REA observed. The limit is **10 000** bytes and the warning is *"Skipping plugin command `<path>`: exceeds `10000` byte limit"*.

**Pinned by:** `tests/contracts/extensions.test.ts` — the byte-limit tests.

## Plugins — a name two plugins provide

**Implementation choice.** No naming or collision rule for plugin skills exists in §2.8. Two plugins that provide the same skill or subagent name **collide**; the collision is **reported** — a warning naming both providers, and a `collidesWith` field on the resolved record — and the names are **not** namespaced.

**Pinned by:** `tests/contracts/extensions.test.ts` — the collision tests.

## Skills — the `skillOverrides` merge

**Implementation choice — a documented divergence.** The merged settings' `skillOverrides` block merges **per leaf**, so a user tier's override for one skill survives a local tier that declares a different one. The audit's `Ble` order is **per key** (*"the first source that defines a key wins"*), so under the target's model the local block would replace the user block whole. The divergence is inherited from the settings tier model and is labelled in the source.

**Pinned by:** `tests/contracts/extensions.test.ts` — the per-leaf merge test.

## Skills — a frontmatter field that is present but `undefined`

**Implementation choice — a documented divergence.** Such a field is treated as **absent**. The audit's literal reading — *"the first of `source`, `pluginName`, `path`, or `frontmatterProblem` **whose value is not a string**"* — would throw on it, since `undefined` is not a string.

**Pinned by:** `tests/contracts/extensions.test.ts` — the undefined-field test.

## Subagents

**REA observed** (the residual was closed by reading the target's own source), with the exceptions the section below names.

### The lifecycle

- a subagent is a **markdown file with YAML frontmatter** inside an **`agents/` directory**. The **file name is free-form**: the agent's name comes from the **frontmatter**;
- discovery is a **recursive `*.md` scan** of each `agents/` directory, with a **bounded timeout**, **following symlinks** and **skipping a directory it has already visited**;
- parsing requires a `name` **and** a `description`; a file without the description is **refused by name**;
- a name that starts with a dash, is longer than **256** characters, or contains a colon is refused too;
- **nothing is persisted.** The raw scan and the parsed catalogue live in an **in-memory cache**, and both are dropped on a file-watch event, on the `/agents` command and on a plugin reload. Across a **restart** everything is re-read from disk, and a resumed session's main-thread agent is **reconstructed by name** against the freshly read catalogue;
- when two sources define the same name, the later one wins, in the order **built-in, plugin, user settings, project settings, feature flags, machine policy**.

### What is this implementation's

- the **within-tier** rule: two definitions of the **same** tier are won by the **first** declared. The target's own rule is a last-writer one, which would change the plugin-collision report the `CC-013b` milestone pinned;
- the **message** the reconstruction reports when the agent is no longer available — the target says so, but the REA findings do not carry its wording;
- the **extra frontmatter fields** this implementation reads are the target's, but only the subset the audit names;
- the **local** origin, which the target does not have, sits between the user's and the project's.

### The rule that cannot fire on its own

The **reconstruction by name** needs the main-thread agent's **name**. This implementation's transcript vocabulary has **no record that carries it**, so the rule fires only when the caller supplies the name — `reconstruct(name)` takes it as its argument. The catalogue it is reconstructed against is the one that was read when the cache was cold: after a **restart**, or after a **`reload()`**.

**Pinned by:** `tests/contracts/extensions.test.ts` — the subagent-lifecycle tests.

## The IDE bridge

**Entirely a implementation choice.** §2.8 observes only the two `mcp__ide__executeCode` / `mcp__ide__getDiagnostics` tools; there is no observed lock-file, port or discovery mechanism to copy. Two rules are this implementation's:

- an **action is validated as a single path segment** — no empty, `.`, `..`, `/`, `\` or NUL — before anything is sent;
- the default transport **refuses a host that is not a loopback address**.

**Pinned by:** `tests/contracts/extensions.test.ts` — the IDE action and IDE transport tests.

## The telemetry destination

**Implementation choice** for the rewriting; the **default** is REA observed. `telemetry.log` is given a destination of `anthropic` unless the caller asked for `collector`. This implementation additionally **normalizes an unrecognised caller destination to `anthropic`** — the audit's literal wording, but a **behaviour change** from passing any destination through.

**Pinned by:** `tests/contracts/extensions.test.ts` — the telemetry tests.

## The self-hosted runner surface (CC-033)

**The target has a self-hosted runner and this implementation does not.** The
target ships **nine** runner tools, a runner process, a registration protocol
and **forty-one** environment variables. There is no runner, no registration,
no environment secret and no account here, so the surface is **recorded and
shaped, never faked**: the nine tools exist, with the target's names,
descriptions, input schemas, result shapes, endpoints, Admin-UI paths,
read-only flags, concurrency flags and permission rules; the environment
variables are reproduced as **data**; and every one of the nine **refuses**
with a typed failure that names the capability it needed.

The reading is `/home/shiva/opt/reference-agent-rea/analysis/findings-self-hosted-runner.md`;
every claim there carries the target's own file and byte offset.

### The nine tools, in the target's order

`chunk-c4brmbaw.js:16557` — the target's export array.

| # | tool | the capability it needs | what this implementation does |
|---|---|---|---|
| 1 | `self_hosted_runner_get_pool` | the self-hosted environment management API | **Refuses**: it needs the self-hosted environment management API, which this session does not have. |
| 2 | `self_hosted_runner_list_runners` | the self-hosted environment management API | **Refuses**: the same. |
| 3 | `self_hosted_runner_list_sessions` | the self-hosted environment management API | **Refuses**: the same. |
| 4 | `self_hosted_runner_list_secrets` | the self-hosted environment management API | **Refuses**: the same. |
| 5 | `self_hosted_runner_spawn_local` | a self-hosted runner process | **Refuses**: it needs a self-hosted runner process, which this session does not have. |
| 6 | `self_hosted_runner_read_health` | a local self-hosted runner | **Refuses**: it needs a local self-hosted runner, which this session does not have. |
| 7 | `self_hosted_runner_read_metrics` | a local self-hosted runner | **Refuses**: the same. |
| 8 | `self_hosted_runner_tail_log` | a local self-hosted runner | **Refuses**: the same. |
| 9 | `self_hosted_runner_requeue_session` | the self-hosted environment management API | **Refuses**: the same. |

### The permission rules

| rule | the target's own statement | this implementation |
|---|---|---|
| the seven read tools are read-only and concurrency safe | `isReadOnly(){return!0}, isConcurrencySafe(){return!0}` on each of the seven | the same; the concurrency flag is declared, so a call may run beside another |
| the two write tools are neither | `isReadOnly(){return!1}` and **no** `isConcurrencySafe` — the target's own default for a tool that does not declare the flag is "not concurrency safe" | the same: the flag is left off, so the tool is not concurrency safe |
| a **whole-tool** allow rule does not apply to the two write tools | `ignoresWholeToolAllowRule(){return!0}` | the whole-tool allow rules for the tool are dropped before the check runs, so `allow: ["self_hosted_runner_spawn_local"]` does not wave it through |
| the two write tools **ask**, with the target's own message, in every mode but `auto` | `checkPermissions` returns `{behavior:"ask", message:…}` | the same: the tool's own check is the tool's own safety check, so it answers after the deny rules and before the mode dispatch |
| in `auto` mode the two write tools go to the **classifier** | `{behavior:"passthrough", message:"… requires classifier review."}` | the tool's own check stands aside in `auto` mode and the standard check runs, so the classifier decides |
| the "don't ask again" affordance does not persist an always-allow rule for the two write tools | `suppressesAlwaysAllowRule(){return!0}` | **not reproduced**: this implementation has no always-allow persistence, so the flag has no counterpart. The flag is carried on the tool definition and named here rather than pretended at |
| the log-tail tool is the only one with a path | `getPath(e){return e.log_path}` — and only it declares one | the same: `log_path` is the tool's path field |
| the requeue and the spawn name their own content | `toAutoClassifierInput` names `session_id`/`runner_id` and `secret_file_path`/`base_dir` | the same: those are the tools' primary content fields, so a scoped rule matches them |
| the five read tools declare **neither** a path nor a classifier input | they declare neither | the same: a scoped rule on one of them matches nothing |

### The environment variables

**Forty-one** names: **thirty-seven** the runner reads, and **four** it refuses
or ignores on purpose. The record's §3.5 list held **thirty-one** and called
them thirty; the derivation that produced it only saw the names read as
`process.env.NAME`, and **ten** more are read through a variable.

| variable | the target's default | the target's validation |
|---|---|---|
| `SELF_HOSTED_RUNNER_BASE_DIR` | `/workspace` | — |
| `SELF_HOSTED_RUNNER_BG_RESULT_GRACE_MS` | `30000` | 0 or unusable falls back to the default — the hold cannot be disabled |
| `SELF_HOSTED_RUNNER_CLIENT_LABEL` | unset | trimmed |
| `SELF_HOSTED_RUNNER_CONFIGURE_GIT` | `false` | a boolean |
| `SELF_HOSTED_RUNNER_CONFINE_REPO_SETTINGS` | `warn` | `enforce`/`warn`/`off`; an invalid value fails closed at startup |
| `SELF_HOSTED_RUNNER_DEBUG_DIR` | unset | the orchestrator's debug directory |
| `SELF_HOSTED_RUNNER_DEBUG_TOKEN_DIR` | unset | debug only |
| `SELF_HOSTED_RUNNER_DEFER_SHUTDOWN_MAX_MS` | `0` (off) | — |
| `SELF_HOSTED_RUNNER_DRAIN_GRACE_MS` | `0` | max 604 800 000 ms |
| `SELF_HOSTED_RUNNER_DRAIN_MARKER_FILE` | unset | — |
| `SELF_HOSTED_RUNNER_DRAIN_WAIT_BG_TASKS_MS` | `0` | the deprecated alias of `DRAIN_WAIT_MS` |
| `SELF_HOSTED_RUNNER_DRAIN_WAIT_MS` | `0` | max 86 400 s |
| `SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET` | unset | the environment secret |
| `SELF_HOSTED_RUNNER_EXEC_PATH` | the process's own binary | — |
| `SELF_HOSTED_RUNNER_HEALTH_PORT` | `8080` | an integer in `[0, 65535]`; 0 disables `/healthz` |
| `SELF_HOSTED_RUNNER_HOOKS_DIR` | unset | — |
| `SELF_HOSTED_RUNNER_HOST_CONFIG_DIR` | `~/.claude` | — |
| `SELF_HOSTED_RUNNER_HOST_CONFIG_SNAPSHOT` | `disk` | `disk`/`memory` |
| `SELF_HOSTED_RUNNER_IDLE_SHUTDOWN_MS` | `0` (never) | — |
| `SELF_HOSTED_RUNNER_LOCK_TO_ACCOUNT` | unset | — |
| `SELF_HOSTED_RUNNER_LOG_FILE` | unset | — |
| `SELF_HOSTED_RUNNER_MAX_LIFETIME_GRACE_MS` | `900000` | floored at the post-session budget |
| `SELF_HOSTED_RUNNER_MAX_LIFETIME_MS` | `0` (never) | — |
| `SELF_HOSTED_RUNNER_POOL_SECRET` | unset | the deprecated alias of `ENVIRONMENT_SECRET` |
| `SELF_HOSTED_RUNNER_POST_SESSION_HOOK_TIMEOUT_MS` | `60000` | — |
| `SELF_HOSTED_RUNNER_POST_TURN_SETTLE_MS` | `7000` | — |
| `SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_COMMAND` | unset | only one of the two proxy variables may be set |
| `SELF_HOSTED_RUNNER_PROXY_AUTHORIZATION_FILE` | unset | the same |
| `SELF_HOSTED_RUNNER_PUSH_OUTCOME_ON_RELEASE` | `false` | a boolean |
| `SELF_HOSTED_RUNNER_REMOVE_SESSION_STATE` | `false` | a boolean |
| `SELF_HOSTED_RUNNER_RETIRE_AT` | `0` (never) | a Unix timestamp in whole seconds, a safe integer in `[1e9, 1e11]` |
| `SELF_HOSTED_RUNNER_SERVER_AUTO_MODE_LISTS` | `no-allow` | `all`/`no-allow`/`none` |
| `SELF_HOSTED_RUNNER_SESSION_IDLE_MS` | `0` (never) | — |
| `SELF_HOSTED_RUNNER_SESSION_STOP_GRACE_MS` | `5000` | — |
| `SELF_HOSTED_RUNNER_SIGKILL_GRACE_MS` | `30000` | — |
| `SELF_HOSTED_RUNNER_STARTUP_TIMEOUT_MS` | `900000` | — |
| `SELF_HOSTED_RUNNER_TRUST_WORKSPACE` | `true` | a boolean |

**The four the target refuses or ignores**, with the target's own behaviour:

| variable | the target |
|---|---|
| `SELF_HOSTED_RUNNER_SIGKILL_TIMEOUT_MS` | **fatal** — it was renamed to `SELF_HOSTED_RUNNER_SESSION_STOP_GRACE_MS`, and the runner exits 1 |
| `SELF_HOSTED_RUNNER_RELEASE_IDLE_SESSION_MIN` | **ignored**, with a warning |
| `SELF_HOSTED_RUNNER_SESSION_IDLE_MIN` | **ignored**, with a warning |
| `SELF_HOSTED_RUNNER_SESSION_IDLE_SEC` | **ignored**, with a warning |

Two names under the same prefix are **not** environment variables:
`SELF_HOSTED_RUNNER_TOOLS` is the export name of the tool array, and
`SELF_HOSTED_RUNNER_PLAN` is the export name of the runner's home-seed plan.

### The protocol, the registration and the lifecycle

The runner's own protocol is **ten** calls, and the five account-side tools
call five more. The full table, with the target's own timeouts, is in
`src/tools/builtins/selfHostedRunner.ts` and in the findings.

| what | the target's own statement | this implementation |
|---|---|---|
| the runner's calls | `POST /v1/code/runners/self-hosted/runners/register`, `…/spawn-hints/poll`, `…/spawn-hints/nack`, `…/runners/{id}/poll`, `…/sessions/{id}/token`, `…/sessions/{id}/report-failure`, `…/sessions/{id}/release`, `…/deregister`, `POST /v1/code/auth/refresh`, and the `…/runners/{id}/work-hints/stream` event stream | **recorded, not reproduced** — there is no runner here |
| the headers | `anthropic-version: 2023-06-01` and `x-self-hosted-runner-version: 2.1.303` on every call | **recorded** |
| the auth chain | the environment secret → `runner_token` → `session_token` → inference, in four tokens | **recorded** |
| the registration body | `{ runner_version, use_anthropic_git_proxy, server_auto_mode_lists, client_label?, lock_to_account_id? }` | **recorded** |
| the account-side tools' endpoints | `GET …/pools/{pool_id}`, `GET …/pools/{pool_id}/sessions`, `GET …/runners?pool_id=`, `GET …/pools/{pool_id}/secrets`, `POST …/sessions/{session_id}/requeue` | **recorded**; the tools refuse |
| the account-side tools' transport | the operator's OAuth session, `anthropic-version: 2023-06-01`, a 20 000 ms timeout, and a 403 when the provider is not the first-party one | **recorded**; the tools refuse |
| the metrics the tool parses | the `claude_code_self_hosted_runner_*` Prometheus gauges, less every `*_bucket`, `session_idle_seconds` and `poll_errors_total` | **recorded**; the tool refuses |
| the CLI tree | `self-hosted-runner` and its five subcommands — `orchestrator`, `setup`, `doctor`, `code-sign`, `decode-token` | **not shipped**: there is no runner to orchestrate, set up, diagnose, sign or decode |
| the gate | the nine tools exist only while the setup wizard's **one-way** latch is open | **not reproduced**: the tools are registered, and the latch has no counterpart here |

### The clone-choice labels this milestone adds

| Label | What it means | Which entries |
|---|---|---|
| `reproduced` | the name, the description, the input schema, the result shape, the endpoint, the Admin-UI path, the flag and the default are the target's own, and the product's name is the only substitution | the nine tools; the thirty-seven environment variables the runner reads |
| `refused` | the tool exists, with the target's name, its schema and its permission rules, and the call ends in a typed failure that names the **capability** the tool needs and this session does not have | all **nine** tools |
| `recorded, not reproduced` | the surface is **named** — the protocol, the registration, the lifecycle, the metric names, the CLI tree — and nothing here runs it | the runner's ten protocol calls; the five account-side endpoints; the CLI subcommand tree; the metric prefix and the two dropped gauges |
| `not shipped` | the thing does not exist here at all, and its absence is stated rather than stubbed | the runner process; the registration; the `self-hosted-runner` subcommand tree |
| `renamed for the product` | the target's product name inside the tool's own text — its login command, its process — was replaced by `PRRICODE`. The tool's **own name** was not: a tool's name is data | the five operator-tail descriptions; the reworked `SIGKILL_TIMEOUT_MS` message |
| `not reproduced` | the target's own rule is recorded, and this implementation has **no counterpart** for it | `suppressesAlwaysAllowRule` — this implementation has no always-allow persistence |

## The agent-team surface (CC-034)

**The target has agent teams, and this implementation has no team backend.**
The target ships a **teammate mode**, a **cross-session inbound** gate, a
**name-collision ledger** and a **team lifecycle** around them. There is no
account, no teammate service, no cross-session transport, no pane backend and
no `it2` CLI here, so the surface is **recorded and shaped, never faked**: the
mode's states, the ledger's rules, the inbound gate's policy and the
lifecycle's record shapes are implemented, and every operation that would
need a teammate runtime or a transport **refuses** with a typed failure that
names the capability it needed.

The reading is `/home/shiva/opt/reference-agent-rea/analysis/findings-agent-teams.md`;
every claim there carries the target's own file and byte offset.

### The teammate mode

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the states | `Iqs=["auto","tmux","iterm2","in-process"]` | `chunk-wwqhf5t7.js:893` | the same four, in the same order |
| the default | `var TKn="in-process"` | `chunk-9hxmx5h0.js:735` | the same: `in-process`, **not** `auto` |
| the setting | `teammateMode:()=>U(Iqs).optional().catch(void 0).describe("How spawned teammates execute (tmux, iterm2, in-process, auto)")` | `chunk-c9s0jh80.js:320848` | the same key and the same shape |
| the capture | the CLI override wins; otherwise the settings value, and the default when the settings say nothing | `chunk-9hxmx5h0.js:1193` | the same |
| the read before the capture | `Error("getTeammateModeFromSnapshot called before capture - this indicates an initialization bug")` | `chunk-9hxmx5h0.js:1439` | the same message, and the same refusal |
| clearing the override | the clear **also sets** the mode | `chunk-9hxmx5h0.js:1051` | the same |
| the CLI's own validation | a mode that is not one of the four becomes `undefined`, not an error | `chunk-081t8575.js:107996` | the same |
| the CLI's own rule | `--agent-id`, `--agent-name` and `--team-name` must all be provided together | `chunk-081t8575.js:115213` | **not wired**: this implementation has no CLI team flags |
| the headless rule | a non-interactive session is always in-process | `chunk-vqa3vv4s.js` | the same |
| the `auto` rule | in-process unless the session is inside tmux or iTerm2, or the fallback is armed | `chunk-vqa3vv4s.js` | the same |
| the backend detection | inside tmux → tmux; inside iTerm2 with `it2` → iTerm2; inside iTerm2 without `it2` but with tmux → tmux and `needsIt2Setup`; outside both with tmux → tmux | `chunk-vqa3vv4s.js:4245` onward | the same, and the selection is reproducible |
| the explicit-iTerm2 failures | `teammateMode is set to "iterm2" but this session is not running inside iTerm2…` and `…but the it2 CLI is not reachable…` | `chunk-vqa3vv4s.js:4245`, `:4361` | the same messages, with the product name substituted |
| the `auto` fallback | `Couldn't open a teammate pane — running in-process instead.` | `chunk-xbdsavh3.js:31375` | the same text and the same key (`teammate-auto-fallback`) |

**The honest boundary.** The **detection** is the target's own and is
reproducible. The **pane** is not: there is no tmux and no iTerm2 here, and no
`it2` CLI, so a mode that names a pane backend **refuses** — with the
capability named — and the `auto` mode takes the target's own in-process
fallback.

### The cross-session inbound gate

The gate is one module in the target (`chunk-v01p0e5r.js`) and every rule below
is read out of it.

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the values | `var FBt=["accept","hold","refuse"]` | `chunk-c9s0jh80.js:236597` | the same three |
| the strictness order | `var f={accept:0,hold:1,refuse:2}` | `chunk-v01p0e5r.js:1377` | the same |
| the resolution order | `policySettings`, `flagSettings`, `userSettings` — the first that defines the key wins | `chunk-v01p0e5r.js:2941` | the same |
| the repository rule | a repository value replaces the resolved one **only when it is stricter**; an equal value only changes the attribution | `chunk-v01p0e5r.js:2941` | the same |
| an unrecognised value in a **policy** source | it becomes `refuse` — the most restrictive reading | `chunk-c9s0jh80.js:427318` | the same |
| an unrecognised value anywhere else | the key is dropped, and the resolved value becomes `hold` with the `invalid-setting` cause | `chunk-v01p0e5r.js:3487` | the same |
| the default gate | the kill switch, then an explicit setting, then a **fail-closed** unknown mode, then the bypass class | `chunk-v01p0e5r.js:3816` | the same |
| the mode-parity rule | the sender's class must **equal** the receiver's; a mismatch is held | `chunk-v01p0e5r.js:4277` | the same |
| a sender that asserted no class | held only while the receiver bypasses prompts | `chunk-v01p0e5r.js:4277` | the same |
| a message the session sent to itself | always accepted | `chunk-v01p0e5r.js:4277` | the same |
| the hold buffer | **100** parked messages; the hundred-and-first evicts the oldest, settled as `expired` | `chunk-v01p0e5r.js:1377` | the same |
| the receipts | `delivered`, `held`, `refused`, `expired`, `denied`, `dropped` | `chunk-v01p0e5r.js:5798`, `:9389` | the same six |
| the approval outcomes | `delivered`, `dropped`, `dropped-by-guard`, `gone` | `chunk-v01p0e5r.js:9389` | the same four |
| the hold causes | `managed-setting`, `repo-setting`, `invalid-setting`, `explicit-setting`, `mode-unknown`, `bypass-default`, `mode-mismatch`, `no-mode-asserted` | `chunk-v01p0e5r.js:1146` and the gate | the same eight |
| the refuse causes | `opt-out`, `kill-switch` | `chunk-v01p0e5r.js:3582`, `:3750` | the same two |
| the inbound message form | `<cross-session-message from="…" from-session="…" hop-chain="…" from-name="…" from-mode="…" from-plugin="…">` | `chunk-fvj2e8y8.js` | the same tag, the same six attributes, the same order, and the same parser |
| the `isolatePeerMachines` rule | the setting asks, with the `safetyCheck` reason, when a message may reach another machine | `chunk-sy98zctw.js:51379` | **not wired**: this implementation has no Remote Control peer, so there is no cross-machine message to gate |

**The honest boundary.** The **gate** is implemented. The **transport** is not:
there is no socket, no bridge and no cloud peer here, so the operation that
would carry a message to the receiving session **refuses** and names the
capability it needed. A receipt of `delivered` means what the target's own log
means by it — *released* — and the release is the gate's, not the transport's.

### The name-collision ledger

**The baseline record was wrong here**, and the correction is recorded in the
findings file: `recordSource` carries the **request's source**, not a settle
value, and `settle` has **six** values, not five.

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the reserved names | `main`, `team-lead`, `user`, `system` — compared after normalisation, so the test is spelling-insensitive | `chunk-jdykmg3v.js:3389`, `:9134` | the same four, and the same normalisation |
| the agent-id shape | `^a(?:[\w-]{1,63}-)?[0-9a-f]{16}$` | `chunk-mtkqr4r9.js:354` | the same |
| the name shape | `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` | `chunk-fvj2e8y8.js:2391` | the same, and the same three messages |
| the unique-name rule | a colliding name takes `-2`, then `-3`; the comparison is case-insensitive | `chunk-xbdsavh3.js:20415` | the same |
| the teammate id | `${name}@${team}` | `chunk-fvj2e8y8.js:2175` | the same |
| the sanitisation | every `@` becomes a `-` | `chunk-qsxcbpmk.js:1531` | the same |
| the settle values | `pre-decided`, `own-name`, `superseded`, `held`, `yielded`, **`kept`** | `chunk-4jsg44k7.js:3562216` | the same six |
| the outcomes | `superseded`; `yielded` and `held` → `yielded`; `kept`, `own-name` and `pre-decided` → `kept` | `chunk-4jsg44k7.js:3563019` | the same |
| the record sources | `collision`, `auto`, `user`, `peer`, `hook` — a collision or a peer request is recorded as a hook request | `chunk-4jsg44k7.js:3562193` | the same five |

### The team lifecycle

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the team file | `<root>/teams/<slug>/config.json`, the slug being the name with every non-alphanumeric character turned into a `-` and lowercased | `chunk-qsxcbpmk.js:1463`, `:1576`, `:1613` | the same layout |
| the inbox | `<root>/teams/<slug>/inboxes/<agent>.json` | `chunk-2pn9kb04.js:22932` | the same layout |
| the member record | `{agentId, name, color, joinedAt, tmuxPaneId, subscriptions, …}` | `chunk-xbdsavh3.js:18951` | the same fields |
| the control-character refusal | `Invalid name: control characters are not allowed in agent or team names` | `chunk-xbdsavh3.js:18951` | the same message |
| the team context | `{teamName, teamFilePath, leadAgentId, teammates}` | `chunk-xbdsavh3.js` | the same fields |
| the write | under a `config.json.lock`, with **five** attempts and a **50 ms** base backoff on `Unavailable`/`LockSuspect` | `chunk-qsxcbpmk.js:3751`, `:4431` | **recorded, not reproduced** — this implementation writes no team file |
| the stale-removal guard | a member that was **re-added** after a removal started is not removed | `chunk-qsxcbpmk.js:6947` | **recorded, not reproduced** — there is no team file to remove a member from |
| the teardown | every member with a pane is killed, and the team's directory is removed | `chunk-qsxcbpmk.js:8924`, `:9568` | **recorded, not reproduced** — there is no pane and no team directory |
| the `TeammateIdle` payload | `{hook_event_name:"TeammateIdle", teammate_name, team_name}` | `chunk-4jsg44k7.js:3560929` | the same payload |
| the teammate-message form | `<teammate-message teammate_id="…" color="…" summary="…" verified="false">` | `chunk-2pn9kb04.js:31586` | the same tag and the same attributes |
| a named `Agent` spawn | a **named** spawn is a **teammate** — an agent the session can address with `SendMessage` | `chunk-1vypyz65.js:20202` | the same: the `Agent` tool routes a named spawn to the teammate path |
| the named spawn's result text | `Spawned successfully. (This tool result is internal metadata — never quote or paste any part of it, including the ID below, into a user-facing reply.)` and the two lines that follow it | `chunk-1vypyz65.js:46339` | the same text |

### The refusals this milestone adds

| the call | the refusal | the capability it names |
|---|---|---|
| a pane backend | `The teammate mode needs a tmux pane backend, which this session does not have, so the teammate was not spawned.` | a tmux (or iTerm2) pane backend |
| the cross-session transport | `The cross-session inbound path needs a cross-session transport, which this session does not have, so the message was not delivered.` | a cross-session transport |
| starting a teammate | `Starting a teammate needs a teammate runtime, which this session does not have, so the teammate was not started.` | a teammate runtime |
| tearing a team down | `Tearing a team down needs a teammate runtime, which this session does not have, so the team was not torn down.` | a teammate runtime |
| a named `Agent` spawn | `The 'Agent' tool needs a teammate runtime to start a named agent, which this session does not have, so the call was refused.` | a teammate runtime |

### The clone-choice labels this milestone adds

| Label | What it means | Which entries |
|---|---|---|
| `reproduced` | the state, the value, the name, the message, the rule and the shape are the target's own, and the product's name is the only substitution | the four teammate-mode states and the default; the three inbound values and the strictness order; the eight hold causes and the two refuse causes; the six settle values and the three outcomes; the five record sources; the four reserved names; the two name shapes; the unique-name rule; the teammate id; the team-file layout; the member record; the `TeammateIdle` payload; the `Agent` tool's `name` description and its three validation messages |
| `refused` | the call ends in a typed failure that names the **capability** it needs and this session does not have | the pane backends; the cross-session transport; the teammate runtime (starting a teammate, tearing a team down, and a named `Agent` spawn) |
| `recorded, not reproduced` | the surface is **named** and nothing here runs it | the team-file write and its lock and retry; the member operations; the teardown; the peer transport |
| `not reproduced` | the target's own rule is recorded, and this implementation has **no counterpart** for it | the `--agent-id` / `--agent-name` / `--team-name` CLI trio — this implementation has no CLI team flags; the `isolatePeerMachines` gate — this implementation has no cross-machine peer |

## Conformance table

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The host dispatcher handles exactly the 23 subtypes, and `can_use_tool` is not among them | REA observed | F-28 | `tests/contracts/mcp-control.test.ts` — the subtype-list and per-subtype tests |
| The callback-absence error text is exact | REA observed | F-28 | same file — the callback-absence test |
| The directional policy refuses agent-originated subtypes sent by a host | REA observed | F-29 | same file — the directional-policy test |
| The two dispatchers stay separate, and the transport one delegates to the existing permission dispatcher | REA observed (the separation) + implementation choice (the delegation) | F-28 | same file — the dispatcher-separation test |
| The stdio transport spawns with `shell: false` and the pipe stdio, merging the environments | REA observed | F-30 | `tests/contracts/mcp-manager.test.ts` — the transport test |
| The modern revision is probed first and the legacy handshake is the fallback | REA observed (the default) + implementation choice (the ladder) | F-30 | same file — the negotiation tests |
| The batching is 3 local and 20 remote | REA observed | F-30 | same file — the batching tests |
| The connect memo is dropped on an identity change, when stale, or explicitly | REA observed | F-31 | same file — the memo tests |
| The capabilities are fetched separately and aggregated | REA observed | F-30 | same file |
| There are four fetch variants and four distinct timeouts | REA observed | F-30 | same file |
| A tool description change is surfaced (the target does not do this) | implementation choice | F-31 | same file — the rug-pull test |
| A caller-supplied server name is data, never an inherited member | implementation choice | F-31 | same file — the prototype-key test |
| The hook decision merge is strictest-wins, and the context lists concatenate | REA observed | F-32 | `tests/contracts/hooks.test.ts` (the `CC-012` task) |
| The matcher is an exact string in the simple case and an unanchored regex otherwise | REA observed (the two-mode rule) + **implementation choice** (the supported regex subset) | F-32 | same file |
| There are exactly 33 hook events, and `StatusLine`/`FileSuggestion` are display handlers outside that set | REA observed | F-32 | same file |
| The exit-code contract is `0` applies, `2` blocks a blockable event, anything else is a non-blocking error | REA observed | F-32 | same file |
| The blockable-event set is the audit's 11 decision-capable events plus `PermissionRequest` | REA observed (the 11) + **implementation choice** (the addition) | F-32 | same file |
| The handler types are `command`, `http`, `mcp_tool`, `prompt`, `agent`; only `command` and `mcp_tool` are dispatched | REA observed (the vocabulary) + **implementation choice** (the non-dispatch) | F-32 | same file |
| The hook payload carries `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort.level`, `hook_event_name`, and `agent_id`/`agent_type` for subagents | REA observed | F-32 | same file |
| A caller-supplied event, server name, hook id or matcher never resolves to an inherited member | implementation choice | F-32 | same file |
| A `PreToolUse` `allow` never overrides a deny or an ask rule, and a `PreToolUse` `deny` holds in every mode | REA observed (the mechanism) + **implementation choice** (the pick) | F-19 | `tests/contracts/permission-hook.test.ts` (the `CC-007b` task) |
| The two hook seams (`PreToolUse` and `PermissionRequest`) cannot cancel each other — the stricter wins | **implementation choice** | F-19 | same file |
| A matcher this implementation cannot compile is **refused at registration**, not silently ignored | **implementation choice** | F-32 | same file |
| The matcher engine's compiled program is bounded by a node budget, and an over-large matcher is refused with a reason | **implementation choice** | F-32 | same file |
| A command hook runs through `/bin/sh -c` with the payload on stdin and a 60 s timeout | **implementation choice** | F-32 | same file |
| A malformed matcher matches nothing rather than being treated as a literal | **implementation choice** | F-32 | same file |
| `updatedPermissions` accepts both a map and a list of typed updates | **implementation choice** | F-32 | same file |
| A manifest-declared path is used only when it is inside the plugin root — lexically and through `realpath` — and a refusal carries one of two named reasons, reported both as a `manifest.problems` entry and as a log record | **implementation choice** (the target's behavior is unobserved; the plan's Global Constraint requires implementation-owned path boundaries) | F-33 | `tests/contracts/extensions.test.ts` — the path-boundary tests, one per check |
| The standalone (non-plugin) skill directory scan — a **single `readdir`**, **depth 1**, the fixed file name `SKILL.md`, the skips, and the frontmatter failure that is **not** a skip — is the target's | **REA observed** (the residual was closed by reading the target's own source) | F-33 | same file — the standalone-scan tests |
| The precedence order `project > local > user > plugin > mcp`, and the meaning of `local`. The five **names** are the plan's | **implementation choice** (the order and `local`'s meaning) | F-33 | same file — the precedence test |
| Two plugins that provide the same skill or subagent name collide; the collision is **reported** and the names are **not** namespaced. One plugin providing a name twice is reported as a different situation | **implementation choice** | F-33 | same file — the collision tests |
| `collidesWith` is **absent** when nothing collided, **present and empty** when one provider shipped the name twice, and **present and non-empty** naming the **other** providers — never the winner's own | **implementation choice** | F-33 | same file — the collision-semantics tests |
| The merged settings' `skillOverrides` block merges **per leaf**, so a user tier survives a local tier | **implementation choice — a documented divergence** from the audit's per-key order | F-33 | same file — the per-leaf merge test |
| A frontmatter field that is present but `undefined` is treated as absent | **implementation choice — a documented divergence** from the audit's literal reading | F-33 | same file — the undefined-field test |
| An IDE action is validated as a single path segment (no empty, `.`, `..`, `/`, `\`, NUL) before anything is sent, in `apply()` and in the transport | **implementation choice** | F-33 | same file — the IDE action tests |
| The default IDE transport refuses a host that is not a loopback address | **implementation choice** | F-33 | same file — the IDE transport tests |
| A skill file over **1 000 000 bytes** is **skipped** — the target never reads it — and a subagent definition file over **1 048 576 bytes** is skipped by the markdown scan | **REA observed** (the two limits and the two skips) | F-33 | same file — "skips a skill file over the byte limit", "skips a subagent file over the byte limit" |
| A `telemetry.log` destination other than `collector` is normalized to `anthropic` | **implementation choice** (the **default** is REA observed; the **rewriting** is this implementation's reading and a behavior change) | F-33 | same file — the telemetry tests |
| A subagent's name comes from its **frontmatter**, not from its file's name; a name two contributors provide is a reported collision | **REA observed** (the name comes from the frontmatter) + **implementation choice** (the collision report) | F-33 | same file — "takes the agent name from the frontmatter, not from the file name" |
| The skill override modes are exactly four, and the resolution order is settings → session → policy/flag | REA observed | F-33 | `tests/contracts/extensions.test.ts` (the `CC-013` task) |
| The skill-save protocol selects its mode by the target's rule and uses the target's wording | REA observed | F-33 | same file |
| The marketplace install reports the disable reason, the enable hint, and distinguishes refused from failed | REA observed | F-33 | same file |
| The extension-point registry is the fixed set above, with `tool.call`'s generated `tool_use_id` and `telemetry.log`'s default destination | REA observed | F-33 | same file |
| The skill frontmatter must carry a text description, and the target's exact error text is used | REA observed | F-33 | same file |
| The plugin manifest's directory keys and file keys, the top-level/`experimental` split, and the single-string/array value shapes | REA observed | F-33 | same file |
| A plugin is `ok` when a `SKILL.md` exists at its root, and a non-object manifest is `broken` | REA observed | F-33 | same file |
| A command's name is `<plugin>:<basename>`, or `<plugin>:<metadata key>` when a `source` resolves to the same path | REA observed | F-33 | same file |
| A directory with no `.md` files and no `SKILL.md` in subdirectories is a warning, not an error | REA observed | F-33 | same file |
| A command file over the byte limit is skipped with the target's wording | REA observed | F-33 | same file |
| The marketplace source vocabulary is **ten** declarable types, **eleven** in the policy lists, and the two runtime-only ones the target's own switch accepts | REA observed | F-33 | `tests/contracts/plugin-protocol.test.ts` — the source-type tests |
| The canonical form of a marketplace source is the target's own `K1`, and its description is the target's own `HPt` | REA observed | F-33 | same file — the canonical-form and description tests |
| The plugin source vocabulary is **seven** named types, and the canonical kinds are the **eight** the target's cache names a directory after | REA observed | F-33 | same file — the plugin-source tests |
| The plugin manifest declares **twenty-nine** keys in three groups, only `name` is required, and `defaultEnabled` defaults to **true** | REA observed | F-33 | same file — the manifest tests |
| The frontmatter key sets are **42**, **22** and **4**, and all three schemas are **strict** | REA observed | F-33 | same file — the frontmatter tests |
| The marketplace manifest declares **ten** keys, the catalogue entry is the whole plugin manifest plus the entry's own keys, `strict` defaults to **true**, an unparseable entry is **stubbed and kept**, and a nameless one is **dropped** | REA observed | F-33 | same file — the catalogue tests |
| The autoupdater's outcomes, its four block types, its three skip reasons and its failure codes are the target's | REA observed | F-33 | same file — the autoupdater tests |
| The autoupdater's classification of an operation outcome is the target's own | REA observed | F-33 | same file — the classification tests |
| Every source that would reach a marketplace or install a plugin is **refused**, and the refusal **names the capability it needs** | **implementation choice** (the refusal itself; the capability each source needs is REA observed) | F-33 | same file — the refusal and capability tests |
| Over a remote or relayed session only the **built-in** output styles may be picked, and the target's own note and the "a custom style" label are used | REA observed | F-33 | `tests/contracts/output-styles.test.ts` — the remote-session tests |

## The subagents — conformance

The subagent definition lifecycle was *"Partial … not traced"* in §2.8; the residual was closed by **reading the target's own source**, so the lifecycle's rules are **REA observed**. The rows below name the part of each rule that is the target's and the part that is this implementation's, and the measured outcome of the row is in [`results.md`](results.md).

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The subagent registry discovers a project subagent and a plugin subagent | **REA observed** (the discovery) + **implementation choice** (the two sources) | F-33 | `tests/contracts/extensions.test.ts` — "discovers a project subagent and a plugin subagent" |
| A subagent is resolved by name, and an inherited member is never resolved as one | **implementation choice** (the prototype-key guard) | F-33 | same file — "resolves a subagent by name and refuses an inherited member" |
| A session may use only the subagents it is allowed to use | **implementation choice** | F-33 | same file — "applies the subagents a session may use" |
| The agent's name comes from the **frontmatter**, not from the file's name | **REA observed** | F-33 | same file — "takes the agent name from the frontmatter, not from the file name" |
| The scan is **recursive**, for `*.md` files only | **REA observed** | F-33 | same file — "scans an agents directory recursively, for markdown files only" |
| A definition without a `description` is **refused by name** | **REA observed** | F-33 | same file — "refuses a definition without a description, by name" |
| A name that starts with a dash, is longer than 256 characters, or contains a colon is refused | **REA observed** | F-33 | same file — "refuses a definition whose name the target refuses" |
| A name two sources define is won by the target's per-source order — built-in, plugin, user settings, project settings, feature flags, machine policy | **REA observed** (the order) + **implementation choice** (the within-tier rule, and the `local` origin) | F-33 | same file — "resolves a name two sources define by the target's precedence" |
| The definition carries the frontmatter fields the target's carries — the model, the tools, the disallowed tools, the skills, the initial prompt, the permission mode, the effort, the colour and the turn ceiling | **REA observed** (the fields) + **implementation choice** (the subset this implementation reads) | F-33 | same file — "reads the frontmatter fields the target's definition carries" |
| A runtime registration beats a project definition | **REA observed** (the flag tier) | F-33 | same file — "lets a runtime registration beat a project definition" |
| The catalogue is **cached** per process and dropped on a **reload** | **REA observed** (the cache and its invalidation) + **implementation choice** (the explicit `reload()`, in place of the target's file watcher) | F-33 | same file — "caches the catalogue, and re-reads it after a reload" |
| Everything is re-read from disk across a **restart** | **REA observed** (nothing is persisted) | F-33 | same file — "re-reads the catalogue across a restart" |
| A resumed session's main-thread agent is **reconstructed by name**, and the target says so when it is no longer available | **REA observed** (the reconstruction) + **implementation choice** (the wording) | F-33 | same file — "reconstructs an agent by name against the freshly read catalogue", "says so when the agent is no longer available" |
| A subagent file over the byte limit is **skipped**, never read | **REA observed** | F-33 | same file — "skips a subagent file over the byte limit" |
| A subagent name two plugins provide is **reported**, not dropped silently | **implementation choice** | F-33 | same file — "reports a subagent name two plugins provide, instead of dropping one silently" |

## The standalone skill scan — conformance

The standalone (non-plugin) skill directory scan was *"not traced to resolved relations"* in §2.8; the residual was closed by **reading the target's own source**, so the scan's rules are **REA observed**. The measured outcome of the row is in [`results.md`](results.md).

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The scan of a root is a **single `readdir`** — **depth 1** — and the skill file is the fixed name `SKILL.md` | **REA observed** | F-33 | `tests/contracts/extensions.test.ts` — "scans a root one level deep, and takes the fixed file name SKILL.md" |
| An entry that is not a directory or a symlink is skipped | **REA observed** | F-33 | same file — "skips an entry that is not a directory or a symlink" |
| A symlinked skill directory is followed | **REA observed** | F-33 | same file — "follows a symlinked skill directory" |
| The reserved entry name `synced` is skipped | **REA observed** | F-33 | same file — "skips the reserved entry name …" |
| An entry whose name contains `:` is skipped in the **synced** scan | **REA observed** | F-33 | same file — "skips an entry whose name contains …" |
| An entry whose **plugin is disabled** is skipped | **REA observed** | F-33 | same file — "skips an entry whose plugin is disabled" |
| A `SKILL.md` that is not a regular file is skipped | **REA observed** | F-33 | same file — "skips a SKILL.md that is not a regular file" |
| A skill whose own name is reserved (`anthropic-skills`) is skipped | **REA observed** | F-33 | same file — "skips a skill whose own name is reserved" |
| A frontmatter that does not parse is **not** a skip: it is reported at error level and the frontmatter is ignored, and the skill still loads | **REA observed** | F-33 | same file — "loads a skill whose frontmatter does not parse, ignoring the frontmatter" |
| A directory that cannot be read yields nothing, with an error, and the scan goes on | **REA observed** | F-33 | same file — "reports a skills directory it cannot read, and scans the other roots" |
| The standalone list and the plugin list stay apart, and the standalone skills come **first** in the merge | **REA observed** (the two lists and their order) | F-33 | same file — "keeps the standalone skills and the plugin skills apart, and merges the standalone first" |
| The scan is **cached** per process and dropped on a **reload** | **REA observed** (the cache and its invalidation) + **implementation choice** (the explicit `reload()`, in place of the target's file watcher) | F-33 | same file — "caches the scan, and re-reads it after a reload" |
| The scan is re-read across a **restart** | **REA observed** (nothing is persisted) | F-33 | same file — "re-reads the skills across a restart" |

## The IDE bridge — conformance

§2.8 observes only the two `mcp__ide__executeCode` / `mcp__ide__getDiagnostics` tools; there is no observed lock-file, port or discovery mechanism to copy. Every row of this table is therefore a **implementation choice**, and the measured outcome of the row is in [`results.md`](results.md).

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The bridge lists the IDE integrations it discovers and resolves one by name | **implementation choice** | F-33 | `tests/contracts/extensions.test.ts` — "lists the IDE integrations it discovers and resolves one by name" |
| A request is applied to the resolved IDE, and one that cannot be resolved is refused | **implementation choice** | F-33 | same file — "applies a request to the resolved IDE", "refuses a request for an IDE it cannot resolve" |
| The two observed actions are `executeCode` and `getDiagnostics` | REA observed (the two names) + **implementation choice** (the set) | F-33 | same file — "names the two observed IDE actions" |
| An action is validated as a **single path segment** — no empty, `.`, `..`, `/`, `\` or NUL — before anything is sent | **implementation choice** | F-33 | same file — "refuses an action that is not a single path segment", "refuses an action that carries a path separator", "refuses an action that is empty, a dot, a dot-dot, or carries a separator or a NUL" |
| An action outside the observed set is accepted, as a single path segment | **implementation choice** | F-33 | same file — "applies an action outside the observed set, as a single path segment" |
| A request is never sent to a host that is not a loopback address | **implementation choice** | F-33 | same file — "refuses to send an IDE request to a host that is not a loopback address" |

## The self-hosted runner — conformance

The self-hosted runner surface was **absent from the coverage audit entirely**.
It was closed by **reading the target's own source**, so the surface's facts
are **REA observed**; the rows below name the part of each rule that is the
target's and the part that is this implementation's. The measured outcome is in
[`results.md`](results.md).

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The target ships **nine** runner tools, and this implementation carries all nine, in the target's own order | **REA observed** | F-17 | `tests/contracts/self-hosted-runner.test.ts` — "carries the target's nine runner tools, in the target's order" |
| Each tool's **description** is the target's own text | **REA observed** | F-17 | same file — "carries the target's own descriptions" |
| Each tool's **input schema** is the target's own, and it is a **strict** object | **REA observed** | F-17 | same file — "carries the target's own input schemas" |
| The **result shapes**, the **endpoints** and the **Admin-UI paths** are the target's own | **REA observed** | F-17 | same file — "carries the target's result shapes, endpoints and Admin-UI paths" |
| The seven read tools are read-only and concurrency safe; the two write tools are neither, and the target's own default for a tool that does not declare the flag is "not concurrency safe" | **REA observed** | F-17 | same file — "carries the target's read-only and concurrency flags" and "is concurrency safe only for the seven read tools" |
| The **environment-variable surface** is **thirty-seven** names the runner reads — the record's list held thirty-one and called them thirty, and ten more are read through a variable | **REA observed** | F-17 | same file — "carries the target's environment-variable surface — thirty-seven names" |
| The **defaults** and the **validation messages** are the target's own | **REA observed** | F-17 | same file — "carries the target's environment-variable defaults" and "validates the environment variables the way the target does" |
| The two durations whose hold "cannot be disabled" fall back to their default on a zero, and the retire-at is bounded to the target's own range | **REA observed** | F-17 | same file — "applies the target own fallbacks and bounds" |
| The four variables the target **refuses or ignores** are named, with the target's own behaviour and message | **REA observed** | F-17 | same file — "names the four environment variables the target refuses or ignores" |
| The runner's **protocol** is ten calls, the request headers are the target's own, and the CLI tree has five subcommands | **REA observed** | F-38 | same file — "carries the target's runner protocol and the CLI subcommand tree" |
| Every one of the nine **refuses**, with a typed failure that names the capability it needed | **implementation choice** (the refusal; the capability each tool needs is REA observed) | F-17 | same file — "refuses every runner tool and names the capability it needs" and "names the capability each runner tool needs in the refusal" |
| No runner tool pretends to run a runner | **implementation choice** (deliberate) | F-17 | same file — "does not let a runner tool pretend to run a runner" |
| The two write tools **ask**, with the target's own message, and a **deny rule** still blocks them | **REA observed** | F-20 | same file — "asks for the two write tools, with the target own message" and "lets a deny rule block the two write tools" |
| A **whole-tool** allow rule does not apply to the two write tools | **REA observed** | F-20 | same file — "ignores a whole-tool allow rule for the two write tools" |
| A call whose input does not match the target's schema is **rejected** | **implementation choice** (the validator) | F-17 | same file — "rejects a runner call whose input does not match the target own schema" |
| No runner description names the target's product | **implementation choice** (the substitution) | F-17 | same file — "names no target product name in any runner description" |
| The "don't ask again" affordance does not persist an always-allow rule for the two write tools | **REA observed** (the target's flag) + **not reproduced** (this implementation has no always-allow persistence) | F-20 | — |
| The runner's **process**, its **registration** and the `self-hosted-runner` **subcommand tree** are **not** shipped | **implementation choice** — the honest boundary | F-38 | — |

## The agent team — conformance

The agent-team surface was **absent from the coverage audit entirely**. It was
closed by **reading the target's own source**, so the surface's facts are
**REA observed**; the rows below name the part of each rule that is the
target's and the part that is this implementation's.

**The matrix row is not assigned yet.** The feature matrix and the compatibility
report are the orchestrator's, and the surface is **not** a row of
`feature-matrix.md` at the time of writing. The rows below therefore name
**F-33** — the row that carries the target's **tool inventory**, and so the
three team tools (`SendMessage`, `ListAgents` and `SubagentHandback`) — and the
orchestrator may re-file the surface under a row of its own when it
re-measures. The measured outcome is in [`results.md`](results.md).

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The teammate mode carries the target's **four** states and the target's **default** — `in-process`, not `auto` | **REA observed** | F-33 | `tests/contracts/agent-teams.test.ts` — "carries the target's four states and the target's default" |
| The snapshot captures the **CLI override** before the settings value, and reading it before the capture is refused with the target's own message | **REA observed** | F-33 | same file — "captures the CLI override before the settings value", "refuses to report a mode before it has been captured" |
| Clearing the CLI override **also sets** the mode | **REA observed** | F-33 | same file — "clears the CLI override and sets the mode" |
| A headless session is always in-process, and `auto` is in-process outside tmux and iTerm2 | **REA observed** | F-33 | same file — "runs a non-interactive session in-process, whatever the mode says", "runs the auto mode in-process outside tmux and iTerm2" |
| The backend detection is the target's own — tmux inside tmux, iTerm2 with `it2`, the tmux fallback with `needsIt2Setup`, and the two explicit-iTerm2 failures with the target's own messages | **REA observed** | F-33 | same file — the four backend-selection tests |
| A pane backend **refuses**, and the refusal names the capability it needed | **implementation choice** (the refusal; the capability is REA observed) | F-33 | same file — "names the capability a pane backend needs when it refuses" |
| The `auto` mode takes the target's own in-process fallback, with the target's notification text | **REA observed** (the text and the fallback) + **implementation choice** (that the fallback always applies here) | F-33 | same file — "falls back to in-process, with the target's own notification, when the mode is auto", "carries the target's own fallback notification" |
| The reserved names are `main`, `team-lead`, `user` and `system`, and the test is spelling-insensitive | **REA observed** | F-33 | same file — "rejects the reserved names, in any spelling" |
| A name with the shape of an **agent id** is refused, and the agent-id shape is the target's own | **REA observed** | F-33 | same file — "rejects a name that has the shape of an agent id" |
| The `Agent` tool's `name` field carries the target's own description and the target's own three validation messages | **REA observed** | F-33 | same file — "carries the target's own description for the name field", "applies the target's own three rules to the name field" |
| A colliding name takes `-2`, then `-3`, and the comparison is case-insensitive | **REA observed** | F-33 | same file — "suffixes a colliding name with -2, then -3" |
| The teammate id is `${name}@${team}`, and the `@` is sanitised to a `-` | **REA observed** | F-33 | same file — "sanitises the name and builds the teammate id" |
| The `settle` vocabulary is the target's **six** values and the outcome map is the target's three — the baseline record's list was short by one and mixed the two axes up | **REA observed** | F-33 | same file — "carries the target's six settle values and its three outcomes", "carries the target's record sources" |
| The inbound setting resolves in the target's order, and a repository setting may only **tighten** | **REA observed** | F-33 | same file — "resolves the setting in the target's order", "lets a repository setting only tighten", "never lets a repository setting loosen a policy setting", "lets a repository setting tighten a policy setting" |
| An unrecognised value becomes `refuse` in a policy source and `hold` everywhere else | **REA observed** | F-33 | same file — "turns an unrecognised value in a policy source into refuse", "turns an unrecognised value anywhere else into hold" |
| The default gate accepts when the session prompts and holds when it bypasses, and the mode-parity rule holds a mismatched sender and a sender that asserted no class | **REA observed** | F-33 | same file — the five default-gate and mode-parity tests |
| A message the session sent to itself is always accepted, and the setting's `refuse` refuses with the `opt-out` cause | **REA observed** | F-33 | same file — "accepts a message the session sent to itself", "refuses when the setting is refuse", "refuses when the kill switch is on" |
| The hold buffer holds **100** messages and evicts the oldest as `expired` | **REA observed** | F-33 | same file — "parks a held message and reports the receipt", "evicts the oldest parked message when the buffer is full" |
| An approved message is released with a `delivered` receipt and a denied one is dropped with a `denied` receipt | **REA observed** | F-33 | same file — "delivers an approved held message", "drops a denied held message with a denial receipt" |
| The cross-session transport **refuses**, and the refusal names the capability it needed | **implementation choice** (the refusal; the capability is REA observed) | F-33 | same file — "refuses to deliver a cross-session message, naming the capability it needs" |
| The inbound message form is the target's own tag and its own six attributes, and the parser reads them back | **REA observed** | F-33 | same file — "carries the inbound message form", "reads nothing out of a text that is not an envelope" |
| The teammate-message form — `<teammate-message teammate_id="…" color="…" summary="…" verified="false">` — is the target's own | **REA observed** | F-33 | same file — "carries the teammate-message form the target uses for an inbox entry" |
| The team file and the inbox sit where the target puts them, under the configuration root | **REA observed** | F-33 | same file — "carries the target's team file layout" |
| The identity reservation takes the unique name, builds the id, and refuses a control character with the target's own message | **REA observed** | F-33 | same file — "reserves the teammate identity the way the target does", "refuses a name that carries a control character" |
| Starting a teammate and tearing a team down **refuse**, and both name the capability they needed | **implementation choice** (the refusal; the capability is REA observed) | F-33 | same file — "refuses to spawn a teammate, naming the capability it needs", "refuses to tear a team down, naming the capability it needs" |
| The `TeammateIdle` hook payload is the target's own | **REA observed** | F-33 | same file — "carries the target's TeammateIdle hook payload" |
| The lifecycle runs — spawn, the team context, the idle transition and the teardown — when the session supplies a teammate runtime | **REA observed** (the fields and the transitions) + **implementation choice** (the state names) | F-33 | same file — "runs the lifecycle when the session supplies a teammate runtime" |
| A **named** `Agent` spawn is a teammate, and it refuses without a teammate runtime | **REA observed** (the named spawn is the target's) + **implementation choice** (the refusal) | F-33 | same file — "refuses a named spawn, naming the capability it needs", "starts a named agent through the teammate runtime the session supplies" |
| The named spawn's **result text** is the target's own | **REA observed** | F-33 | same file — "starts a named agent through the teammate runtime the session supplies" |
| The team file's **write**, its lock, its retry, the member operations and the teardown are **recorded, not reproduced** | **REA observed** (the rules) + **not reproduced** (this implementation writes no team file) | F-33 | — |


