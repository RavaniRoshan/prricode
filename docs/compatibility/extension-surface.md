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

**Two rules are this implementation's.** §2.8 observes only the two `mcp__ide__executeCode` / `mcp__ide__getDiagnostics` tools; there is no observed lock-file, port or discovery mechanism in the audit. Two rules are this implementation's:

- an **action is validated as a single path segment** — no empty, `.`, `..`, `/`, `\` or NUL — before anything is sent;
- the default transport **refuses a host that is not a loopback address**.

**The rest of the surface is the target's own**, and was closed by reading the
target's source in `CC-036` — see [The IDE integration surface](#the-ide-integration-surface-cc-036).

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

## The MCP channels surface (CC-035)

**The target has MCP channels, and this implementation has no channel
transport.** A server declares a `claude/channel` capability and pushes
**inbound** messages; the target's gate decides what happens to one. There is
no server that pushes here, no admission pipeline in a live session and no
channel registry, so the surface is **recorded and shaped, never faked**: the
capability's form, the message form, the admission decisions, the
`--channels` grammar, the allowlist and the permission relay's rules are
implemented, and every operation that would need a live channel-capable server
**refuses** with a typed failure that names the capability it needed.

The reading is
`/home/shiva/opt/reference-agent-rea/analysis/findings-mcp-channels.md`; every
claim there carries the target's own file and byte offset. The target's whole
surface is **one module** (`chunk-sgtr8b3g.js` in the pinned build), and the
semantic names come from the barrel that re-exports it
(`chunk-5fg1q3cj.js`).

### The count is the record's, corrected

**The baseline record listed seven admission-decision kinds, and the
milestone brief said six. The target's gate holds eight.** The record omitted
`capability` — the **first** check the gate makes.

The eight kinds were read by extracting the gate's body and enumerating every
`kind:"…"` literal in it, then pairing each with the `reason:` literal in the
same `return`. The gate has no other `kind:` literal, and the target's own
`isChannelGateHardRevocation` predicate names four of the eight explicitly —
a second, independent confirmation that there are more than six.

### The capability and the methods

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the message capability | `function _ot(e){return!!e?.experimental?.["claude/channel"]}` | `chunk-mdxktt4k.js:11` | the same name, and the same **truthiness** read |
| the permission capability | `ikt(r.capabilities,"claude/channel") && ikt(r.capabilities,"claude/channel/permission")` | `chunk-hct0ak23.js:6029` | the same two names, and the same **both-or-neither** rule |
| the message method | `notifications/claude/channel` | `chunk-sgtr8b3g.js:1159` | the same |
| the permission request method | `notifications/claude/channel/permission_request` | `chunk-sgtr8b3g.js:1400` | the same |
| the permission answer method | `notifications/claude/channel/permission` | `chunk-sgtr8b3g.js:1268` | the same |
| the message params | `{content: string, meta?: Record<string, string>}` | `chunk-sgtr8b3g.js:1159` | the same, and the same refusal for a non-string member |
| the answer params | `{request_id: string, behavior: "allow" \| "deny"}` | `chunk-sgtr8b3g.js:1314` | the same |
| the request the client sends | `{request_id, tool_name, description, input_preview}` | `chunk-7h94ekrj.js:44183` | the same four members; the two bounded ones are **recorded**, not reproduced |
| the answer's two outcomes | `allow` accepts the call; `deny` rejects it with `Denied via channel <server>` | `chunk-7h94ekrj.js:44183` | the same two outcomes |

### The admission decisions

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the kinds | **eight** — `capability`, `era`, `provider`, `disabled`, `policy`, `session`, `marketplace`, `allowlist` | `chunk-sgtr8b3g.js:2606`–`:4162` | the same eight, in the same order |
| the order | capability → era → provider → disabled → policy → session → marketplace → allowlist | `chunk-sgtr8b3g.js:2552` | the same, and the order is load-bearing: the **first** failing check is the one reported |
| the hard revocations | `provider`, `disabled`, `capability`, `era` | `chunk-sgtr8b3g.js:1986` | the same four |
| the soft kinds | `policy`, `session`, `marketplace`, `allowlist` | `chunk-sgtr8b3g.js:2552` | the same four; a soft skip **preserves** a handler that was already registered, and a hard one **removes** it |
| the capability reason | `server did not declare claude/channel capability` | `chunk-sgtr8b3g.js:2624` | the same text |
| the era reason | `connection negotiated a modern protocol revision with no unsolicited notification path` | `chunk-sgtr8b3g.js:2731` | the same text |
| the provider reason | `channels are not available on third-party providers` | `chunk-sgtr8b3g.js:2888` | the same text |
| the disabled reason | `channels feature is not currently available` | `chunk-sgtr8b3g.js:2996` | the same text |
| the policy reason | `channels not enabled by org policy (set channelsEnabled: true in managed settings)` | `chunk-sgtr8b3g.js:3122` | the same text |
| the session reason | `server <name> not in --channels list for this session` | `chunk-sgtr8b3g.js:3275` | the same text |
| the marketplace reason | `you asked for plugin:<name>@<marketplace> but the installed plugin is <…>` | `chunk-sgtr8b3g.js:3458` | the same text |
| the allowlist reasons | `… is not on your org's approved channels list (set allowedChannelPlugins in managed settings)` and `… is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)` | `chunk-sgtr8b3g.js:3867`, `:4179` | the same two texts, and the same split between the org list and the ledger list |

### The session list

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the entries | `{kind:"server", name}` and `{kind:"plugin", name, marketplace, dev?}` | `chunk-081t8575.js:129110` | the same two shapes |
| the value grammar | `plugin:<name>@<marketplace>` and `server:<name>` — a value **must** be tagged | `chunk-081t8575.js:129110` | the same, and the same refusal |
| the fatal message | `<flag> entries must be tagged: <values>` followed by the two grammar lines | `chunk-081t8575.js:129110` | the same text, and the message names the flag |
| the flags | `--channels` and `--dangerously-load-development-channels`, both **value-taking** and **repeatable** | `chunk-0y0ptpy9.js:1106`, `:2667` | the flags stay the CLI's, and the CLI's own refusal stands (see the boundary below) |
| the plugin-provided server's name | `plugin:<pluginName>:<serverKey>` | `chunk-4jsg44k7.js:2736862` | the same, and a plugin entry matches the **plugin name** — the server key is not part of the match |
| the bare server entry | a bare server entry needs the development flag to be exempt from the allowlist | `chunk-sgtr8b3g.js:4162` | the same |

### The message form

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the envelope | `<channel source="<server>" <meta…>>` … `</channel>` | `chunk-sgtr8b3g.js:1483`, `chunk-kmrt4q1v.js:9623` | the same tag, the same attribute order, and the same parser-free shape |
| the meta-key rule | `/^[a-zA-Z_][a-zA-Z0-9_]*$/` | `chunk-sgtr8b3g.js:1454` | the same rule, and the same **drop** (not an error) |
| the drop warning | `[channel] <server>: dropped <n> meta key(s) that don't match <rule>: <keys>` | `chunk-sgtr8b3g.js:1483` | the same text, with the count and the names |
| the attribute escaping | `"` → `&quot;` and `'` → `&apos;`, and nothing else | `chunk-estvrnfh.js:24402` | the same |
| the body | the body cannot open a nested `<channel>` envelope | `chunk-sgtr8b3g.js:1483` | the same effect; the target neutralises **every** recognised tag, and this implementation neutralises the `channel` tag only — a named implementation choice |
| the delivery | the message becomes a **queued prompt** (`priority: "next"`, `isMeta: true`, `origin: {kind:"channel", server}`, `skipSlashCommands` and `skipAttachments` both true) | `chunk-6bp7hdav.js:1604464` | **recorded, not reproduced** — there is no queue here |

### The allowlist and the policy

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the effective list | the org's list wins when it is **set** — **even when it is empty**, which allows nothing; otherwise the ledger list | `chunk-sgtr8b3g.js:1896` | the same, including the empty-org-list rule |
| the ledger | the growth-book value `tengu_harbor_ledger`, parsed as `{marketplace, plugin}`; a parse failure yields an empty list | `chunk-1gmref8w.js:847` | **recorded, not reproduced** — the ledger is server-side |
| the setting | `channelsEnabled` — a boolean, and the only value an organisation may set in managed settings is `false` | `chunk-c9s0jh80.js:311876`, `:185839` | the same key, and the same shape |
| the second setting | `allowedChannelPlugins` — `{marketplace, plugin}` or the string `"<plugin>@<marketplace>"` | `chunk-c9s0jh80.js:312196`, `:241208` | the same key and the same two forms |
| the policy block | a first-party `team` or `enterprise` session needs `channelsEnabled: true`; any other session needs it too; absent managed settings do **not** block | `chunk-sgtr8b3g.js:2069` | the same rule |
| the feature switch | the growth-book flag `tengu_harbor` and the entitlement `allow_channels` | `chunk-1gmref8w.js:942`, `:1006` | **recorded, not reproduced** — both are server-side |

### The permission relay

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the request id | five characters of `abcdefghijkmnopqrstuvwxyz` — twenty-five letters, no `l` — derived deterministically from `${toolUseId}:${agentId}` by an FNV-1a hash, retried with `:0`…`:9` until the result holds none of the blocked substrings | `chunk-hct0ak23.js:1335`, `:957` | the same alphabet, the same derivation, and the same blocked list |
| the id's case | the id is matched **case-insensitively**, when it is registered and when it is resolved | `chunk-hct0ak23.js:6227` | the same |
| an unknown answer | dropped — `no pending entry — stale or unknown ID` | `chunk-6bp7hdav.js:1604991` | the same: the resolve reports `false` |
| a drawn-twice id | dropped with `Channel permission relay: a request ID was drawn twice in one session; channel replies with that ID are ignored — answer in the terminal` | `chunk-hct0ak23.js:6227` | the same, and the same warning |
| the eligible servers | connected, in the `--channels` list, declaring **both** capabilities, registered by the permission prompt, and **not** a modern-era connection | `chunk-hct0ak23.js:6029` | the same five conditions |
| the outcome | `allow` accepts the call; `deny` rejects it and reports `Denied via channel <server>` | `chunk-7h94ekrj.js:44183` | the same two outcomes |

### The registration lifecycle

The target registers a server's channel handlers in three places — on
**connect**, on **reconnect**, and on the `channel_enable` request — and the
rules it applies there are the same. This implementation carries the **rules**;
it installs nothing, because there is no channel transport here.

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the register branch | `Channel notifications registered`, and the server joins the registered set | `chunk-6bp7hdav.js:1604464` | the same |
| a hard revocation | the handlers are removed — `notifications/claude/channel` **and** `notifications/claude/channel/permission` — and the server leaves the registered set | `chunk-6bp7hdav.js:1605579` | the same: the state is tracked, and nothing is installed |
| a soft skip of a registered server | `Channel gate says skip:<kind> but was previously registered — preserving handler` — and the handlers stay | `chunk-6bp7hdav.js:1605579` | the same |
| the skip log | `Channel notifications skipped: <reason>` | `chunk-6bp7hdav.js:1605579` | the same |
| the warning's dedupe | the warning is shown **once per kind**; the `era` kind is deduped **per server** | `chunk-6bp7hdav.js:1605579` | the same |
| the warning's condition | the `capability` and `session` kinds never warn, and any other kind warns only when the server is in the session's list — except `marketplace` and `allowlist`, which always warn | `chunk-6bp7hdav.js:1605579` | the same |
| the warning's shape | a **high** priority warning, in the warning colour, for **12 000 ms** | `chunk-6bp7hdav.js:1605868` | the same |
| the warning's key | `channels-blocked-<kind>`, and `channels-blocked-era-<server>` for the era kind | `chunk-6bp7hdav.js:1605868` | the same |
| the reconnect | the gate runs again and the handlers are re-installed: `Channel notifications re-registered after reconnect` | `chunk-e7w77ts3.js:729115` | the same rule, applied by the same state |

### The plugin manifest

| what | the target's own statement | where | this implementation |
|---|---|---|---|
| the key | `channels` — an array of `{server, displayName?, userConfig?}`, and the object is **strict** | `chunk-c9s0jh80.js:95232` | the same key and the same shape |
| the server member | a non-empty string naming a key of the plugin's own `mcpServers` | `chunk-c9s0jh80.js:95232` | the same |
| the scaffold | the target writes a plugin scaffold whose server declares `experimental: { 'claude/channel': {} }` and whose `instructions` say that a reply must go through the plugin's own reply tool | `chunk-d5fv7pr3.js:31780` | **recorded, not reproduced** — the scaffold is a writer, and this implementation writes no plugin |

### The honest boundary

| the call | the refusal | the capability it names |
|---|---|---|
| registering a server's channel notifications | `Registering MCP channel notifications needs a channel-capable MCP server connection, which this session does not have, so the channel was not registered.` | a channel-capable MCP server connection |
| asking a channel to answer a permission request | `Requesting a permission over an MCP channel needs a channel-capable MCP server connection, which this session does not have, so the request was not sent.` | a channel-capable MCP server connection |

**The CLI's own refusal stands.** `--channels` and
`--dangerously-load-development-channels` are already refused by the run with
the message *"it names the channels of the session, and this implementation has
none"*. That refusal is still true: this milestone adds the **shapes**, and a
shape is not a transport. The milestone's file list does not include the CLI,
and the flag's behaviour there is `CC-031`'s.

**Nothing is faked.** There is no stub that pretends a server pushed a
message, no fake queue and no invented transport.

### The clone-choice labels this milestone adds

| Label | What it means | Which entries |
|---|---|---|
| `reproduced` | the name, the value, the shape, the message, the rule and the order are the target's own, and the product's name is the only substitution | the two capability names; the three method names; the eight decision kinds and their eight reasons; the four hard revocations; the message params and the answer params; the meta-key rule and the drop warning; the envelope's tag and attribute order; the attribute escaping; the session list's two entry shapes; the value grammar and the fatal message; the allowlist's two sources and the empty-org-list rule; the policy block's rule; the request id's alphabet and derivation; the relay's case-insensitive matching and its two drops; the registration lifecycle's four outcomes, its three log lines and its warning's shape, condition and key |
| `refused` | the call ends in a typed failure that names the **capability** it needs and this session does not have | registering a server's channel notifications; asking a channel to answer a permission request |
| `recorded, not reproduced` | the surface is **named** and nothing here runs it | the queued-prompt delivery; the permission request's bounded `description` and `input_preview`; the growth-book ledger; the `tengu_harbor` feature switch and the `allow_channels` entitlement; the plugin scaffold the target writes; the `channel_enable` request |
| `not reproduced` | the target's own rule is recorded, and this implementation has **no counterpart** for it | the CLI's two flags — they stay `CC-031`'s refusal; the `tengu_quiet_elephant` session's random request ids — the derivation is implemented, the *draw* is the target's |

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



## The MCP channels — conformance

The channels surface was **absent from the coverage audit entirely**. It was
closed by **reading the target's own source**, so the surface's facts are
**REA observed**; the rows below name the part of each rule that is the
target's and the part that is this implementation's.

**The matrix row is not assigned yet.** The feature matrix and the compatibility
report are the orchestrator's, and the surface is **not** a row of
`feature-matrix.md` at the time of writing. The rows below therefore name
**F-30** — the row that carries the target's **MCP transport** — and the
orchestrator may re-file the surface under a row of its own when it
re-measures. The measured outcome is in [`results.md`](results.md).

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The two capability names are `claude/channel` and `claude/channel/permission`, and the second is **separate** — a server that declares only the first is not eligible for the permission relay | **REA observed** | F-30 | `tests/contracts/mcp-channels.test.ts` — "names the two capabilities the target declares", "reads a server that declares no channel capability as declaring none" |
| The three method names are the target's own | **REA observed** | F-30 | same file — "names the three methods the target uses" |
| The admission decisions are **eight** kinds, in the target's order, and the milestone brief's six and the baseline record's seven were both wrong | **REA observed** | F-30 | same file — "holds exactly eight kinds, in the target's order" |
| The four hard revocations are `provider`, `disabled`, `capability` and `era`, and the other four are soft | **REA observed** | F-30 | same file — "holds exactly four hard revocations", "tells the hard revocations from the soft ones" |
| The gate runs the checks in the target's order, and the **first** failing check is the one reported | **REA observed** | F-30 | same file — "checks the capability before anything else" |
| Each of the eight reasons is the target's own text | **REA observed** | F-30 | same file — the eight per-kind tests |
| The policy block's rule is the target's own — a first-party `team` or `enterprise` session needs `channelsEnabled: true`, any other session needs it too, and absent managed settings do not block | **REA observed** | F-30 | same file — the four policy-block tests |
| The `--channels` values must be tagged, and an untagged value is fatal with the target's own message, which names the flag | **REA observed** | F-30 | same file — the four grammar tests |
| The message form is the target's own, and a member of the wrong type is refused | **REA observed** | F-30 | same file — "reads a message that carries content", "refuses a message with no content", "refuses a meta member that is not a string" |
| The answer form is the target's own, and a behaviour that is not `allow` or `deny` is refused | **REA observed** | F-30 | same file — "reads a permission answer", "refuses a permission answer that is not one of the two behaviours" |
| The meta-key rule is the target's own, and a key that does not match is **dropped** rather than refused | **REA observed** | F-30 | same file — "splits the meta keys on the identifier rule" |
| The envelope is the target's own tag with the target's attribute order and the target's escaping | **REA observed** | F-30 | same file — "wraps a message in the channel envelope", "escapes the attribute values" |
| A body cannot open a nested `<channel>` envelope | **REA observed** (the effect) + **implementation choice** (this implementation neutralises the `channel` tag only; the target neutralises every recognised tag) | F-30 | same file — "escapes a channel opener in the body" |
| The effective allowlist prefers the org's list when it is **set**, **even when it is empty**, and falls back to the ledger otherwise | **REA observed** | F-30 | same file — the three allowlist tests |
| The request id is five characters of the target's twenty-five-letter alphabet, derived deterministically from the tool use id and the agent id | **REA observed** | F-30 | same file — the three request-id tests |
| The relay matches the id case-insensitively, drops an answer for an unknown id, and drops a cancelled one | **REA observed** | F-30 | same file — "resolves an answer against the pending request", "drops an answer for an unknown request id", "drops an answer after the request was cancelled" |
| The registration lifecycle's four outcomes are the target's own — registered, removed, preserved and skipped — and a hard revocation removes the handlers while a soft skip of a registered server preserves them | **REA observed** | F-30 | same file — "registers a server the gate admitted", "removes a hard revocation", "preserves a soft skip of a server that was registered", "skips a soft skip of a server that was not registered" |
| The warning's condition, its once-per-kind dedupe, its per-server dedupe for the era kind, its four texts, its key and its twelve-second life are the target's own | **REA observed** | F-30 | same file — the six warning tests |
| Registering a server's channel notifications **refuses**, and the refusal names the capability it needed | **implementation choice** (the refusal; the capability is REA observed) | F-30 | same file — "refuses to register notifications and names the capability" |
| Asking a channel to answer a permission request **refuses**, and the refusal names the capability it needed | **implementation choice** (the refusal; the capability is REA observed) | F-30 | same file — "refuses to request a permission and names the capability" |
| The queued-prompt delivery, the permission request's bounded members, the growth-book ledger, the feature switch and the plugin scaffold are **recorded, not reproduced** | **REA observed** (the rules) + **not reproduced** (nothing here runs them) | F-30 | — |
| The two CLI flags stay `CC-031`'s refusal | **not reproduced** (this implementation has no channel session) | F-30 | — |

## The IDE integration surface (CC-036)

The audit's §2.8 mentions only that `mcp__ide__executeCode` and
`mcp__ide__getDiagnostics` are special-cased. The target's **whole** IDE
surface — the IDE table, the lock-file protocol and the diagnostics subsystem
— was absent from it, and was closed by **reading the target's own source**.
Every fact below carries the file and the byte offset it was read from; the
full reading is in
`/home/shiva/opt/reference-agent-rea/analysis/findings-ide-integration.md`.

**The matrix row is not assigned by this milestone.** The feature matrix and
the compatibility report are the orchestrator's. The rows below therefore
name **F-33** — the row that already carries the **IDE** — and the
orchestrator may re-file the surface under a row of its own when it
re-measures. The measured outcome is in [`results.md`](results.md).

### The surface, part by part

| the part | what the target has | where it came from | what this implementation does | implemented or refused |
|---|---|---|---|---|
| the IDE table | **18** entries, in a fixed order, each with an `ideKind`, a `displayName` and per-OS process keywords | `chunk-f27ph7ed.js:661418` — the literal `var LMt={…}`, read with a **parser** | the same table, entry for entry, in `src/integration/ide/registry.ts` | **implemented** |
| the IDE kinds | exactly **two** — `vscode` (**3** entries) and `jetbrains` (**15**) | `chunk-f27ph7ed.js:661418` | the same, with the kinds deciding the install path | **implemented** |
| the editor display-name table | a **second** table, **12** entries, naming editors as well as IDEs | `chunk-f27ph7ed.js:661418`+ — the literal `var Wv={…}` | the same table, kept apart from the IDE table | **implemented** |
| the display-name resolver | empty → `"IDE"`; a registry key → its display name; an editor key → its name; otherwise the part **before the first space**, reduced to its **basename** | `chunk-f27ph7ed.js:661418`+ — `Kw(e)` | the same rule, in the same order | **implemented** |
| the process-detection commands | three — `ps aux \| grep -E …` on macOS and Linux, `tasklist \| findstr /I …` on Windows | `chunk-4jsg44k7.js:4017676`+ — `O7r()` | the three commands, as data, and the rule that reads a listing | **implemented** |
| the detection rule | macOS matches **case-sensitively**; Windows lower-cases both sides; Linux matches as-is, and does **not** report VS Code when the listing holds `cursor` or `appcode` | `chunk-4jsg44k7.js:4017676`+ | the same rule, in the same registry order | **implemented** |
| the lock directories | the configuration root's `ide`; `~/.claude/ide` when the root is overridden or blank; under WSL the Windows profile's and every `/mnt/c/Users/<user>/.claude/ide`, except the four shared accounts | `chunk-a8rm68wf.js:794259` — `vWn()` | the same rule, in the same order | **implemented** |
| the Windows → WSL mapping | `C:\Users\x` → `/mnt/c/Users/x`; anything else is not mapped | `chunk-wz3ehw15.js:651` — `znn(t)` | the same | **implemented** |
| the lock files | the lock files are ordered by the moment they were last written, the **newest first** | `chunk-4jsg44k7.js:4009753`+ — `Hbr()` | the same ordering | **implemented** |
| the lock body | JSON with `{workspaceFolders, port, pid, ideName, transport, runningInWindows, authToken}`, or — when the body does not parse as JSON — a newline-delimited list of workspace folders | `chunk-4jsg44k7.js:4009265` — `DOn(e)` | the same, and the same drop of a `pid`, an `ideName` and an `authToken` that are not of the right type | **implemented** |
| the port | the **file name's** suffix, not the JSON's `port` | `chunk-4jsg44k7.js:4009265` | the same | **implemented** |
| staleness | a dead **pid** is enough outside WSL; under WSL the port must also refuse a connection; a lock that cannot be parsed is deleted | `chunk-4jsg44k7.js:4009753`+ — `T7r()`, `IOn(e)`, `Bot(host, port, 500)` | the same **rule**; the probe and the deletion are **injected**, so nothing here opens a socket or removes a file | **implemented** (the rule) / **not reproduced** (the deletion) |
| the workspace relation | **three** values — `contains-cwd`, `inside-cwd`, `unrelated` — from a containment test that splits on the **first** space's counterpart, the path separator | `chunk-4jsg44k7.js:4012440`+ — `POn`, and `chunk-z2dde3wc.js:24927` — `Yse` | the same three values and the same test | **implemented** |
| the IDE record | `{url, name, workspaceFolders, port, isValid, workspaceContainsCwd, authToken, ideRunningInWindows}`, with the URL `ws://<host>:<port>` or `http://<host>:<port>/sse` | `chunk-4jsg44k7.js:4011960`+ — `Lbr(e)` | the same record and the same two URLs | **implemented** |
| the detection loop | **30 000 ms** of polling, every **1000 ms**, and exactly one IDE whose workspace holds the session's directory | `chunk-4jsg44k7.js:4012440`+ — `Dbr()` | the same two durations and the same "exactly one" rule | **implemented** |
| the diagnostics shape | `{message, severity, range{start,end}, code?, source?}` per diagnostic, and `{uri, diagnostics[]}` per file | `chunk-4jsg44k7.js:555731`+ — `class rCt` | the same shape | **implemented** |
| the severity vocabulary | **four** severities behind **five** keys — `information` and `info` are the same one; a severity outside the set is **dropped** | `chunk-4jsg44k7.js:4021561` — the table in `N7r` | the same, and a severity outside the set is dropped | **implemented** |
| the payload validation | a file that is not an object, whose `uri` is not a string or whose `diagnostics` is not an array is dropped; a diagnostic whose `message` is not a string, or whose `range.start` is not a pair of numbers, is dropped; a file whose diagnostics **all** drop out is dropped too; the range end falls back to the range start | `chunk-4jsg44k7.js:4021561` — `cHn(e)` | the same rule, and the same two counts | **implemented** |
| the baseline | a `getDiagnostics` for the one file, under a **500 ms** timeout; the reply's path must match; three timeouts in a row disable the baselines, and the manager logs the target's own sentence | `chunk-4jsg44k7.js:555731`+ — `beforeFileEdited(e)` | the same rule, the same timeouts, the same cutoff and the same log line | **implemented** |
| the fetch | a workspace-wide `getDiagnostics` under a **2000 ms** timeout; only the files in the baseline count; only the diagnostics that are **not** in the baseline are new | `chunk-4jsg44k7.js:556998`+ — `getNewDiagnostics()` | the same rule and the same timeouts | **implemented** |
| the rendering | the file's name, the severity glyph, the **one-based** position, the message, the code and the source; the block is cut at **4000** characters and given the ellipsis marker | `chunk-4jsg44k7.js:4021561`+ — `L7r(e)`, `UAe(e)` | the same form, the same glyphs and the same truncation | **implemented** |
| the diagnostics telemetry | `ide_diagnostics_baseline` and `ide_diagnostics_fetch`, with the target's kinds | `chunk-4jsg44k7.js:556058`+ | the two event names and the kinds | **implemented** (as data) |
| the `ide_*` telemetry namespace | exactly **12** event names | `chunk-dt3pd9ft.js:594288`+ — the event-name registry, read with a parser | the two names this surface emits are carried; the other ten belong to other surfaces | **implemented** (as data) |
| the IDE MCP server | two server shapes — `sse-ide` and `ws-ide` — inside a `type` vocabulary of `stdio`, `sse`, `sse-ide`, `http`, `ws`, `sdk` | `chunk-c9s0jh80.js:67384`, `:65965` | the two shapes and the six-type vocabulary | **recorded, not reproduced** — this implementation ships no MCP server of its own for an IDE |
| the `/ide` command | `local-jsx`, *"Manage IDE integrations and show status"*, `argumentHint: "[open]"` | `chunk-4jsg44k7.js:1684406` | the shape and the wording | **recorded, not reproduced** — the command is not this milestone's file list |
| the `--ide` flag | *"Automatically connect to IDE on startup if exactly one valid IDE is available"* | `chunk-t0c9yez3.js:62564` | the flag stays the CLI's own refusal | **not reproduced** — `CC-031`'s refusal stands |
| the settings | `autoConnectIde` (default `false`) and `autoInstallIdeExtension` (default `true`) | `chunk-c9s0jh80.js:208277`, `chunk-5befw1yz.js:28721` | the keys are the target's own; this milestone does not read them | **recorded, not reproduced** |
| the environment variables | `CLAUDE_CODE_AUTO_CONNECT_IDE`, `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL`, `CLAUDE_CODE_IDE_SKIP_VALID_CHECK`, `CLAUDE_CODE_IDE_HOST_OVERRIDE`, `CLAUDE_CODE_SSE_PORT`, `FORCE_CODE_TERMINAL` | `chunk-68z1nb51.js` — the environment-variable schema | the two the discovery reads — `CLAUDE_CODE_SSE_PORT` and `CLAUDE_CODE_IDE_SKIP_VALID_CHECK` — are read; the rest are **recorded** | **implemented** (two) / **recorded** (four) |
| the extension install | the VS Code extension id `anthropic.claude-code`, the JetBrains plugin directory `claude-code-jetbrains-plugin`, and **15** JetBrains product directories | `chunk-4jsg44k7.js:4015800`+, `:4006008` | the id, the directory name and the product directories are carried as data | **implemented** (as data) / **refused** (the install) |
| connecting to an IDE | the target connects to the `ide` MCP server it discovered | `chunk-faqnk9sf.js:23174` | **refuses** | **refused** — names *a running IDE with its extension or plugin installed* |
| asking an IDE for diagnostics | the target asks the `ide` MCP client | `chunk-6s9yz1tm.js:151452` — `callIdeRpc` | **refuses** | **refused** — names *a connected IDE client* |
| installing the extension | the target runs the IDE's own launcher | `chunk-4jsg44k7.js:4015800`+ | **refuses** | **refused** — names *the IDE's own command-line launcher* |

### The honest boundary

**This implementation has no IDE to talk to.** There is no extension, no
plugin, no lock file written by an IDE, no socket and no diagnostics channel.
So the surface is **recorded and shaped, never faked**:

- the **table**, the **protocol** and the **shapes** are implemented, and the
  rules are the target's own;
- the three operations that need an IDE — connecting to one, asking one for
  diagnostics, and installing the extension into one — **refuse**, and each
  refusal **names the capability** it needed:
  - *"Connecting to VS Code needs a running IDE with its extension or plugin installed, which this session does not have, so it was not attempted."*
  - *"Requesting IDE diagnostics needs a connected IDE client, which this session does not have, so it was not attempted."*
  - *"Installing the extension into Cursor needs the IDE's own command-line launcher, which this session does not have, so it was not attempted."*

**Nothing is faked.** There is no stub that pretends an extension connected,
no invented socket and no fake diagnostics channel.

**Two earlier rules stand.** The IDE bridge's **action validation** — an
action is a single path segment — and the default transport's **loopback
refusal** are still this implementation's own, and are still pinned by
`tests/contracts/extensions.test.ts`.

**The bridge's lock-file reading is now the target's**, with two **fallbacks**
kept so that the earlier `CC-013` surface does not change: the `ide` and
`workspacePath` members, which the target's own lock file does not carry.
Where the target's own fields are present they win; the port comes from the
**file name** whenever the name carries one.

### The clone-choice labels this milestone adds

| Label | What it means | Which entries |
|---|---|---|
| `reproduced` | the name, the value, the shape, the message, the rule and the order are the target's own | the eighteen IDEs and their five fields each; the two kinds; the twelve editor names; the display-name resolver; the three detection commands and the detection rule; the lock directories; the Windows-to-WSL mapping; the lock body and its newline-delimited fallback; the port-from-the-file-name rule; the staleness rule and its WSL difference; the three workspace relations; the IDE record and its two URLs; the detection window and interval; the diagnostic shape; the severity vocabulary; the validation rule and its two counts; the baseline, the fetch and their three timeouts; the cutoff and its log line; the rendering, the glyphs and the truncation; the two diagnostics telemetry names; the six environment-variable names; the extension id, the plugin directory and the fifteen product directories |
| `refused` | the call ends in a typed failure that names the **capability** it needs and this session does not have | connecting to an IDE; asking an IDE for diagnostics; installing the extension into an IDE |
| `recorded, not reproduced` | the surface is **named** and nothing here runs it | the two IDE MCP server shapes and the six-type server vocabulary; the `/ide` command; the two settings keys; the extension install and the JetBrains plugin search |
| `not reproduced` | the target's own rule is recorded, and this implementation has **no counterpart** for it | the `--ide` flag — it stays `CC-031`'s refusal; the **deletion** of a stale lock file, and the TCP probe it needs — the rule is implemented and the side effect is not |

### Conformance table

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The IDE table holds **18** entries in the target's order, and the count was verified with a **parser** and not with a pattern | **REA observed** | F-33 | `tests/contracts/ide-integration.test.ts` — "has exactly eighteen IDEs, in the target's order" |
| The table has exactly **two** kinds, **three** of one and **fifteen** of the other | **REA observed** | F-33 | same file — "has exactly two IDE kinds, three of one and fifteen of the other" |
| Every entry's display name and its three per-OS keyword lists are the target's own | **REA observed** | F-33 | same file — "gives every IDE its own display name and its own per-OS process keywords" |
| Aqua, Gateway and Fleet carry **no** macOS and **no** Linux keyword | **REA observed** | F-33 | same file — "leaves the macOS and Linux keyword lists of Aqua, Gateway and Fleet empty" |
| The editor display-name table is a **different** table with **12** entries | **REA observed** | F-33 | same file — "has twelve editor display names, in a table of its own" |
| The display-name resolver follows the target's own order, including the "before the first space, then the basename" rule | **REA observed** | F-33 | same file — "resolves a display name the way the target does" |
| A caller-supplied IDE key never resolves to an inherited member | **implementation choice** (the guard; the target's own map is safe) | F-33 | same file — "resolves a key through a guard, so an inherited member is not an IDE" |
| The three detection commands are the target's own, and the detection rule is per-platform — case-sensitive on macOS, case-insensitive on Windows, and the Linux rule that does not report VS Code when AppCode or Cursor is running | **REA observed** | F-33 | same file — "holds the target's own detection command for each platform", "detects an IDE from a macOS process listing, case-sensitively", "detects an IDE from a Windows process listing, case-insensitively", "detects an IDE from a Linux process listing", "does not report VS Code on Linux when AppCode or Cursor is running" |
| An IDE the target does not know has **no** keywords at all | **REA observed** | F-33 | same file — "gives an unknown IDE no keywords at all" |
| The lock directories are the target's, and the home directory's is added only when the configuration root is overridden or blank | **REA observed** | F-33 | same file — "lists the lock directories the target lists", "adds the home directory's lock directory when the root is overridden or blank" |
| Under WSL the Windows-side directories are added and the **four** shared accounts are skipped | **REA observed** | F-33 | same file — "adds the Windows-side directories under WSL, and skips the four shared accounts", "skips exactly the four shared Windows accounts" |
| The Windows → WSL mapping is the target's, and a path without a drive letter is not mapped | **REA observed** | F-33 | same file — "maps a Windows profile to its WSL path" |
| The **port is the file name**, not the JSON's `port` | **REA observed** | F-33 | same file — "takes the port from the file name, not from the JSON" |
| A lock body that does not parse as JSON is a newline-delimited list of workspace folders, and the trailing empty line is kept | **REA observed** | F-33 | same file — "reads a body that is not JSON as a newline-delimited list of folders" |
| Only the exact value `true` makes a lock say the IDE runs on Windows | **REA observed** | F-33 | same file — "only calls the IDE running on Windows when the lock says so" |
| The staleness rule is the target's, and it differs under WSL | **REA observed** | F-33 | same file — "calls a lock stale when its process is dead", "does not call a lock stale under WSL when the port still answers", "calls a lock with no process stale when the port refuses" |
| The workspace relation has exactly **three** values | **REA observed** | F-33 | same file — "has three workspace relations" |
| The containment test takes the **candidate first**, and it is case-sensitive | **REA observed** (the order and the case) + **implementation choice** (the case-insensitive mode) | F-33 | same file — "tests containment the way the target does: the candidate comes first" |
| The IDE record carries the target's eight members and the target's two URLs | **REA observed** | F-33 | same file — "keeps the IDE whose workspace holds the session's directory", "builds the two urls the target builds" |
| An IDE whose workspace is unrelated is dropped, unless the unrelated ones are asked for | **REA observed** | F-33 | same file — "drops the IDE whose workspace is unrelated, unless they are asked for" |
| The detection window is **30 000 ms** and the poll interval is **1000 ms**, and exactly one containing IDE is chosen | **REA observed** | F-33 | same file — "waits thirty seconds for an IDE, polling every second", "calls the one IDE the target connects to, and only when there is exactly one" |
| The IDE's own name is normalised the target's way — `windsurf` becomes `Devin Desktop`, in any case | **REA observed** | F-33 | `tests/contracts/ide-integration.test.ts` — "normalizes the IDE name the way the target does", "shows a lock that names Windsurf as Devin Desktop, the way the target does" |
| The IDE table's `ideKind` decides which family an IDE belongs to, and the family decides the install path | **REA observed** | F-33 | same file — "has fifteen JetBrains product directories and none for the VS Code family" |
| The operating systems the target detects on are named **macOS**, **Windows** and **Linux** | **REA observed** | F-33 | same file — "names the three operating systems the target detects on" |
| The lock files are ordered by the moment they were last written, the **newest first** | **REA observed** | F-33 | same file — "orders the lock files newest first" |
| A lock file that parses as JSON is read the target's way | **REA observed** | F-33 | same file — "reads a JSON lock file the target's way" |
| The two environment variables the discovery takes are **parsed** the way the target parses them — a boolean is `1`, `true`, `yes` or `on`, and an integer that is not a number is absent | **REA observed** | F-33 | same file — "parses a boolean environment variable the way the target does", "parses an integer environment variable the way the target does", "reads the two environment variables the discovery takes" |
| The severity vocabulary is **four** severities behind **five** keys, and an unknown severity is **dropped** | **REA observed** | F-33 | same file — "has four severities, and five keys that name them" |
| The validation rule drops a malformed file and a malformed diagnostic, counts both, and drops a file whose diagnostics all drop out | **REA observed** | F-33 | same file — "drops a malformed file and counts it", "drops a malformed diagnostic and counts it", "drops a payload that is not an array" |
| A surviving diagnostic's severity is normalized to the target's own spelling | **REA observed** | F-33 | same file — "normalizes the severity of a surviving diagnostic" |
| The range end falls back to the range start, and only a string code and a string source are kept | **REA observed** | F-33 | same file — "falls back to the range start when the range end is not a pair of numbers", "keeps only a string code and a string source" |
| Only the diagnostics that are not in the baseline are new | **REA observed** | F-33 | same file — "finds only the diagnostics that are not in the baseline" |
| The rendered block is the target's own form, with the **one-based** position and the target's glyphs | **REA observed** | F-33 | same file — "renders the new-diagnostics block the target's way" |
| The rendered block is cut at **4000** characters and given the ellipsis marker | **REA observed** | F-33 | same file — "truncates the rendered block at four thousand characters" |
| The three timeouts are **500 ms**, **2000 ms** and a cutoff of **3**, and the cutoff logs the target's own sentence | **REA observed** | F-33 | same file — "holds the target's own three timeouts and its cutoff", "disables the baselines after three consecutive timeouts, and says so" |
| The manager's lifecycle is the target's: initialize once, `shutdown` clears the cutoff counter and `reset` does not | **REA observed** | F-33 | same file — "follows the target's lifecycle: initialize once, shutdown clears, reset keeps the counter" |
| The server the target leaves out of the baselines is left out here too; its name is a **parameter**, because this repository may not name the target's product | **REA observed** (the rule) + **implementation choice** (the name is a parameter) | F-33 | same file — "does not baseline the server the target leaves out" |
| The baseline and the fetch report only what is new | **REA observed** | F-33 | same file — "baselines a file and reports only the diagnostics that are new" |
| Asking for diagnostics **refuses**, and the refusal names the capability it needed | **implementation choice** (the refusal; the capability is REA observed) | F-33 | same file — "refuses a diagnostics request that has no client, and names the capability" |
| The bridge carries the target's **18** IDEs and reads a lock file the target's way | **REA observed** | F-33 | same file — "exposes the target's eighteen IDEs", "reads a lock file the target's way" |
| The bridge hands out the diagnostics manager, and the manager refuses too | **implementation choice** (the refusal; the capability is REA observed) | F-33 | same file — "hands out the diagnostics manager, and it refuses too" |
| Connecting to an IDE **refuses**, and the refusal names the capability it needed and the IDE it was about | **implementation choice** (the refusal; the capability is REA observed) | F-33 | same file — "refuses to connect to an IDE, and names the capability" |
| Asking an IDE for diagnostics **refuses**, and the refusal names the capability it needed | **implementation choice** (the refusal; the capability is REA observed) | F-33 | same file — "refuses to ask an IDE for diagnostics, and names the capability" |
| Installing the extension **refuses**, and the refusal names the capability it needed and the IDE it was about | **implementation choice** (the refusal; the capability is REA observed) | F-33 | same file — "refuses to install the extension, and names the capability" |
| The IDE bridge's **action validation** and the default transport's **loopback refusal** remain this implementation's own | **implementation choice** | F-33 | `tests/contracts/extensions.test.ts` — the IDE action and IDE transport tests |

## The native addons (CC-039)

The target's payload holds **exactly two** native objects, and the coverage
audit never mentions either of them: they are separate ELF files, so the
whole-image native inventory that timed out (row `F-36`) would not have
covered them either.

**Evidence.** The extraction manifest's own `kind` field, parsed as JSON —
`extraction-manifest-patched.json` → `files[]` — gives **2 686** payload files:
2 433 `JS (bun)`, 143 `data`, 79 `markdown`, 24 `text`, 5 `JavaScript` and
**2 `ELF x86-64`**. The two are `clipboard-napi.node` (1 072 864 B,
`sha256 4881da9229654a04bdec176cb70c818b872dd6bc74aaa881f021dbe20cdcbea7`)
and `audio-capture.node` (492 368 B,
`sha256 4bf312cbbc81f577d5ed0bcdcba803bfaa219c05ac4a1cca729ec81628561e88`).
The full record, every claim with a file and a byte offset, is
`/home/shiva/opt/reference-agent-rea/analysis/findings-native-addons.md`.

**The loaders.** Both addons are loaded by a lazy `import.meta.require` of the
file beside the bundle, with **four** vendored per-architecture paths behind
it, and the **attempt is cached — including a failure** — so a machine with no
addon never tries again. The loader **never throws**: it answers `null`.

**The exports.** The clipboard addon carries **two** — `setLinuxClipboardText`
(synchronous, answers a boolean) and `getLinuxClipboardText` (asynchronous,
answers a promise). The audio addon carries **eight** — `isPlaying`,
`isRecording`, `stopPlayback`, `startPlayback`, `stopRecording`,
`startRecording`, `writePlaybackData` and `microphoneAuthorizationStatus`, in
that registration order. Both are Rust `napi-rs` 2.16.17 addons; the
clipboard one drives `wl-clipboard-rs` and `x11rb`, the audio one drives
ALSA.

### The surface, part by part

| The part of the surface | What the target has | Where it came from | What this implementation does | |
|---|---|---|---|---|
| the inventory | **two** native addons — a clipboard and an audio capture — with their file names, their sizes and their digests | `extraction-manifest-patched.json` → `files[]`, `kind: "ELF x86-64"` | the same two, as data | **implemented** |
| the export sets | **two** and **eight** names, in the target's own registration order | `clipboard-napi.node:73781`/`:74390`; `audio-capture.node:42291`, `:42421`, `:43811`, `:47315`, `:47760`, `:47774`, `:48813`, `:49294` | the same names, as data | **implemented** |
| the loader | the packaged copy, then **four** vendored paths; the attempt is cached, including a failure; `null` rather than a throw | `chunk-v57qk004.js:653`, `chunk-vjnh31ch.js:704`, `chunk-yp10c36w.js:1994` | the same loader, the same order, the same cached attempt — and `null` on every machine, because there is nothing to find | **implemented** |
| the export lookup | the target reads an export off the loaded object | `chunk-yp10c36w.js:6555`, `:8259` | the **own-property** guard: an export the object only inherits is not the addon's export | **implemented** (the guard) |
| the clipboard probe | `wl-copy` → `xclip` → `xsel` → **`addon`** → `none`, and the addon is **demoted after one failed write** | `chunk-yp10c36w.js:3738`, `:4115` | the same five-way decision, the same demotion rule | **implemented** |
| the clipboard status | `not_linux` \| `not_probed` \| the tool's name \| `none` | `chunk-yp10c36w.js:4699` | the same four answers | **implemented** |
| the clipboard write | the target writes through the mechanism the probe chose, and the addon write answers a boolean | `chunk-yp10c36w.js:6555` | **refuses** — names *a clipboard write path* | **refused** |
| the clipboard read | the target reads through the mechanism the probe chose, strips the trailing newline, and answers `null` when there is no display | `chunk-yp10c36w.js:8259` | **refuses** — names *a clipboard read path* | **refused** |
| the audio wrapper | **nine** functions, and each has the target's own answer when the addon is absent: `false` for the three queries, nothing for the two stops, and **`0`** for the microphone authorization status | `chunk-vjnh31ch.js:1048`–`:1505` | the same nine, and the same absent-values | **implemented** |
| the audio recording | the target calls `startRecording` with **two** callbacks and answers a boolean | `chunk-mhdmymcx.js:5292` | **refuses** — names *a native audio capture addon* | **refused** |
| the microphone permission rule | **no native addon → the request is granted**; an addon that starts a recording → granted; an addon that does not → refused | `chunk-mhdmymcx.js:3653` | the same rule, plus this implementation's own first question: **no capture path at all → refused**, and the refusal names the capability | **implemented** |
| the `/voice` option parsing | `hold` \| `tap` \| `off`; the empty argument means **no mode**; anything else is invalid; the rejection quotes the **trimmed** argument | `chunk-v47hn89x.js:3865`, `:4371` | the same parser and the same message | **implemented** |
| the packaging | the target's package carries the two `.node` files | the manifest, as above | the artifact carries **none**, and the build **fails** when a `.node` file appears beside it | **implemented** (the check) |

### The honest boundary

**This implementation ships no native addon**, and nothing in it pretends
otherwise. A native module is a **mechanism** difference — the target's
clipboard is a Rust addon over Wayland and X11, and its audio capture is a
Rust addon over ALSA — and the report records the mechanism separately from
the behaviour.

The **shapes** are reproduced and the **operations refuse**:

- the inventory, the loader, the candidate paths, the cached attempt, the
  own-property guard, the clipboard probe and its status vocabulary, the audio
  wrapper's nine operations and their absent-values, the microphone permission
  rule and the `/voice` option parsing are **the target's own**;
- the operations that would need an addon **refuse**, and each refusal names
  the capability it would have needed — *a clipboard write path*, *a clipboard
  read path* and *a native audio capture addon*. The clipboard capabilities are
  the **general** ones, because the target's own `wl-copy`/`xclip`/`xsel`
  fallbacks would have done the work as well as the addon, and neither the addon
  nor the fallbacks are here; the audio capability names the **native** addon,
  because the operation is the native one;
- **nothing shells out** to a clipboard or an audio binary to stand in for an
  addon, and no stub pretends to be one.

**The target's own fallbacks are not implemented, and the surface says so
rather than pretending:**

| The target's fallback | What it is | Here |
|---|---|---|
| `wl-copy`, `xclip`, `xsel` | the commands the target writes and reads the clipboard with when the addon is not the mechanism | **not implemented** |
| the OSC 52 terminal copy | the escape sequence the target emits so the **terminal's** clipboard holds the text | **not implemented** |
| `arecord`, and SoX's `rec` | the recorders the target falls back to when the native audio addon is absent | **not implemented** |
| the voice stream | the websocket the target transcribes the recording over | **not implemented** — a different surface |
| the voice availability probes | `checkVoiceDependencies` and `checkRecordingAvailability`, with the target's seven reasons | **not implemented** — they belong to the voice surface, and without a recorder they could only report a host diagnosis this implementation has no use for |

### The clone-choice labels this milestone adds

| Label | What it means | Which entries |
|---|---|---|
| **implemented** | the shape is read, validated and reproduced — the target's own names, values, rules and orders | the **two** addons of the inventory, their file names, sizes and digests; the **two** and **eight** export names, in the target's registration order; the loader, its candidate order and its cached attempt; the own-property guard on an export; the clipboard probe's five-way decision and the demotion rule; the clipboard status vocabulary; the audio wrapper's nine operations and their absent-values; the microphone permission rule; the `/voice` option parsing and its message; the packaging check |
| **refused** | the operation is understood, and the refusal names the **capability** it needs and this implementation does not have | the clipboard write; the clipboard read; the native audio recording; the native audio playback |

The refusals are **return values**, not exceptions: a caller reads the
capability and knows what would have to exist for the operation to run.

### Conformance table

**The matrix row is not assigned yet.** The feature matrix and the
compatibility report are the orchestrator's, and the surface is **not** a row of
`feature-matrix.md` at the time of writing. The rows below therefore name
**F-36** — the row that carries the target's **native inventory** — and the
orchestrator may re-file the surface under a row of its own when it
re-measures. The native **addons** are the part of that inventory this
milestone establishes; the **whole-image** inventory stays `unknown`, because
three whole-image attempts timed out (330 s, 360 s, 900 s) and the audit says
it is not closable by effort. The measured outcome is in
[`results.md`](results.md).

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The target's payload holds exactly **two** native objects, and the manifest's `kind` field says so | **REA observed** | F-36 | `tests/contracts/native-addons.test.ts` — "names exactly the two addons the target ships" |
| The clipboard addon carries exactly **two** exports, and the audio addon exactly **eight**, in the target's registration order | **REA observed** | F-36 | same file — "carries the clipboard addon own two exports", "carries the audio addon own eight exports, in the registration order" |
| The candidate paths are the packaged copy and **four** vendored paths, in the target's order, and the `-musl` variant is added only on Linux | **REA observed** | F-36 | same file — "offers the packaged copy first and the vendored paths in the target order", "drops the musl variant away from linux, as the target does" |
| The attempt is **cached, including a failure**, and the loader never throws | **REA observed** | F-36 | same file — "caches the attempt, so a failure is not retried", "returns null when the addon is not there, and never throws" |
| An export is read only when the loaded object **owns** it | **REA observed** (the target reads the export) + **implementation choice** (the guard) | F-36 | same file — "refuses an export the object only inherits" |
| The clipboard probe is a five-way decision, and the addon is demoted after one failed write | **REA observed** | F-36 | same file — "prefers wl-copy when a wayland display and the command are there", "prefers xclip over xsel, and needs a display for either", "falls to the addon when the external tools are not there", "demotes the addon after one failed write", "keeps the addon after a successful write" |
| The clipboard status is `not_linux` \| `not_probed` \| the tool's name \| `none` | **REA observed** | F-36 | same file — "reports the four statuses the target reports" |
| The clipboard write and the clipboard read **refuse**, and each refusal names the capability it needed | **implementation choice** (the refusal; the capability is REA observed) | F-36 | same file — "refuses the write and names the capability it would need", "refuses the read and names the capability it would need" |
| The audio wrapper's nine operations keep the target's own absent-values, and the microphone authorization status is **`0`** | **REA observed** | F-36 | same file — "returns the target own zero for the microphone authorization status", "reports that the native audio addon is not available" |
| The audio recording and the audio playback **refuse**, and each refusal names the capability it needed | **implementation choice** (the refusal; the capability is REA observed) | F-36 | same file — "refuses every operation that needs the addon", "names the capability the recording refuses for" |
| The microphone permission rule is the target's own: **no native addon → granted**, a recording that started → granted, a recording that did not → refused | **REA observed** | F-36 | same file — "grants when there is no native microphone to authorize", "grants when the native recording started", "refuses when the native recording did not start" |
| The rule asks this implementation's own first question — **no capture path at all → refused** | **implementation choice** | F-36 | same file — "refuses when there is no capture path at all" |
| The `/voice` option parsing is the target's own — `hold` \| `tap` \| `off`, the empty argument means no mode, and the rejection quotes the trimmed argument | **REA observed** | F-36 | same file — "accepts the three modes the target accepts", "trims and lower-cases the argument", "reads an empty argument as no mode at all", "rejects anything else", "uses the target own rejection message" |
| The repository and the packaged artifact ship **no** native addon, and the build fails when one appears | **implementation choice** | F-36 | same file — "ships no native addon in this repository"; `scripts/build.ts` — `nativeAddonFilesIn` |
