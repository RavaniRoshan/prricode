# Extension surface conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.8 "MCP, plugins, and hooks".
**Owning tasks:** `CC-011` (MCP and the control surface), `CC-012` (hooks), `CC-013` (skills, subagents, plugins, marketplaces, IDE).
**Matrix rows:** F-28 … F-33 in [`feature-matrix.md`](feature-matrix.md).

Every row names its **evidence class**: `REA observed`, `Documented only`, or `implementation choice`.

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

The hooks reference documents **33** events. This implementation adds one reason kind, `noRuleMatch`, to distinguish "no rule matched" from the audit's `permissionPromptTool` ("a **named tool** requires approval for this command") — a **implementation addition**.

### The result merge rules

When two hook results are combined:

- a **permission decision** is merged by **strictness**, with `allow: 1`, `ask: 2`, `deny: 3` — the **stricter** decision wins, and the reason is taken from the stricter one;
- `additionalContext` and `watchPaths` are **concatenated**; every other member takes the newer value;
- the block reason is `permissionDecisionReason`, or `Blocked by hook` when the hook denied without giving a reason;
- an `allow` decision carrying `updatedPermissions` maps each permission, and a `setMode` permission's mode is **normalized** before it is applied;
- when a hook result is merged into a permission-request result, the result carries `permissionBehavior`, `hookPermissionDecisionReason`, `permissionRequestResult`, and the `updatedInput` **only when the behavior is `allow`**.

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

## Conformance table

| Claim | Evidence class | Pinned by |
|---|---|---|
| The host dispatcher handles exactly the 23 subtypes, and `can_use_tool` is not among them | REA observed | `tests/contracts/mcp-control.test.ts` — the subtype-list and per-subtype tests |
| The callback-absence error text is exact | REA observed | same file — the callback-absence test |
| The directional policy refuses agent-originated subtypes sent by a host | REA observed | same file — the directional-policy test |
| The two dispatchers stay separate, and the transport one delegates to the existing permission dispatcher | REA observed (the separation) + implementation choice (the delegation) | same file — the dispatcher-separation test |
| The stdio transport spawns with `shell: false` and the pipe stdio, merging the environments | REA observed | `tests/contracts/mcp-manager.test.ts` — the transport test |
| The modern revision is probed first and the legacy handshake is the fallback | REA observed (the default) + implementation choice (the ladder) | same file — the negotiation tests |
| The batching is 3 local and 20 remote | REA observed | same file — the batching tests |
| The connect memo is dropped on an identity change, when stale, or explicitly | REA observed | same file — the memo tests |
| The capabilities are fetched separately and aggregated | REA observed | same file |
| There are four fetch variants and four distinct timeouts | REA observed | same file |
| A tool description change is surfaced (the target does not do this) | implementation choice | same file — the rug-pull test |
| A caller-supplied server name is data, never an inherited member | implementation choice | same file — the prototype-key test |
| The hook decision merge is strictest-wins, and the context lists concatenate | REA observed | `tests/contracts/hooks.test.ts` (the `CC-012` task) |
| The matcher is an exact string in the simple case and an unanchored regex otherwise | REA observed | same file |
| The skill override modes are exactly four, and the resolution order is settings → session → policy/flag | REA observed | `tests/contracts/extensions.test.ts` (the `CC-013` task) |
| The skill-save protocol selects its mode by the target's rule and uses the target's wording | REA observed | same file |
| The marketplace install reports the disable reason, the enable hint, and distinguishes refused from failed | REA observed | same file |
| The extension-point registry is the fixed set above, with `tool.call`'s generated `tool_use_id` and `telemetry.log`'s default destination | REA observed | same file |
| The skill frontmatter must carry a text description, and the target's exact error text is used | REA observed | same file |
| The plugin manifest's directory keys and file keys, the top-level/`experimental` split, and the single-string/array value shapes | REA observed | same file |
| A plugin is `ok` when a `SKILL.md` exists at its root, and a non-object manifest is `broken` | REA observed | same file |
| A command's name is `<plugin>:<basename>`, or `<plugin>:<metadata key>` when a `source` resolves to the same path | REA observed | same file |
| A directory with no `.md` files and no `SKILL.md` in subdirectories is a warning, not an error | REA observed | same file |
| A command file over the byte limit is skipped with the target's wording | REA observed | same file |
