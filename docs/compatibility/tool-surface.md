# Tool surface conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.4 ("Agent loop and tool dispatch") and §2.5 ("Permissions"), and — for the inventory itself — [`docs/reverse-engineering/SURFACE-INVENTORY.md`](../reverse-engineering/SURFACE-INVENTORY.md) ("The tool registry"), which the repository's own verifier re-derives from the target's source.
**Owning task:** `CC-008` in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md); the terminal-UI surfaces below were closed by `CC-022`; the **tool inventory** was closed by `CC-027`.
**Matrix rows:** F-17, F-18 in [`feature-matrix.md`](feature-matrix.md), and F-39 (the interactive terminal UI) below.

Every row names its **evidence class**: `REA observed`, `Documented only`, or `implementation choice`.

## The tool contract (implementation design, shaped by the audit)

```ts
interface ToolDefinition<I, O> {
  name: string;
  description: string;
  inputSchema: unknown;
  mutatesFiles: boolean;
  checkPermissions(input: I, ctx: ToolContext): Promise<PermissionDecision | undefined>;
  validateInput(input: I, ctx: ToolContext): Promise<{ ok: true } | { ok: false; message: string; errorCode: number }>;
  execute(input: I, ctx: ToolContext): Promise<O>;
  recheckPermission(input: I, ctx: ToolContext): Promise<ToolRecheck>;
}
```

`recheckPermission` re-runs the **whole** permission check against a rewritten input. It may only **restrict** the call — the stricter of the two verdicts wins — and the re-check's own hook keeps its **denial** but loses its **approval** and its **rewrite**, because the approval was given for the original call. This is a **implementation choice** with no target counterpart, and it exists because a hook that rewrites the input would otherwise be a permission bypass.

## The tool inventory (CC-027)

The target's registry names **88** tools. The verifier re-derives the list from the
target's own source and writes it to
[`SURFACE-INVENTORY.md`](../reverse-engineering/SURFACE-INVENTORY.md) under
**"The tool registry"**; this implementation now holds **45** of those names —
**44** canonical tools plus the `Task` alias — and **one** tool of its own
(`TodoRead`).

**The browser surface is a second registry, and it is not in that count.** The
target's twenty-two browser tools are **MCP tools** — the model calls them
`mcp__<server>__<tool>` — so they are not in the target's own eighty-eight-tool
registry and they are not counted above. `CC-032` added them; see
[the browser surface](#the-browser-surface-cc-032) below.

**The names and the aliases are the target's.** The target keeps one alias table
and maps a legacy name to the canonical one (`chunk-y3kmvs94.js:663`, read out of
the pinned build):

| legacy name | canonical name |
|---|---|
| `Task` | `Agent` |
| `KillShell` | `TaskStop` |
| `KillBash` | `TaskStop` |
| `ListPeers` | `ListAgents` |
| `Brief` | `SendUserMessage` |
| `ListMcpResources` | `ListMcpResourcesTool` |
| `ReadMcpResource` | `ReadMcpResourceTool` |
| `ReadMcpResourceDir` | `ReadMcpResourceDirTool` |

The registry resolves an alias to the canonical tool, so a call that names
`Task` reaches the `Agent` tool and the tool's **own** name is what the rule
engine sees.

**The rule engine's tool tables follow the inventory.** A rule that names a tool
the inventory has reaches it: `WebSearch(...)` matches the **query**, `Cd(...)`
matches the **path**, `Edit(...)` matches a **`MultiEdit`** call (the target's own
rule validation says the `Edit` rules cover every file-editing tool), and the
`Read(...)` rules reach `NotebookRead`, `Glob`, `Grep` and the other read tools
through their path fields.

**A tool whose capability is absent is not faked.** The target's inventory names
subsystems this implementation does not have: a browser, a language server, an
agent team, a scheduler, a worktree manager, an MCP channel, a self-hosted
runner, the account's plugin and skill catalogue, the artifact surface. A tool
that drives one of them keeps its **name**, its **input schema**, its **alias**
and its **permission behaviour**, and it **refuses** with a typed failure
(`capabilityUnavailable`) that names the missing capability. A stub that
returned a plausible answer would be worse than a refusal, because the model
would act on it.

### The tools this implementation ships

The **Tier** column is the order the plan gives: **Tier 1** is the set a coding
session needs and this implementation did not have; **Tier 2** is the rest, in
the inventory's own order.

| tool | the target's own one-line statement of what it is for | what this implementation's version does | tier |
|---|---|---|---|
| `Agent` | delegate work to a subagent | Delegates through the session's `delegate` seam and reports what the sub-agent said. `Task` is its alias. | 1 |
| `AskUserQuestion` | prompt the user with a multiple-choice question | Asks the session's dialog, one to four questions of two to four options each, and reports the answers. | 1 |
| `Bash` | execute shell commands | Runs through `/bin/sh -c` inside the sandbox, with the filtered environment. Unchanged. | 2 |
| `Cd` | — (the target's inventory names it; the target's own search hint was not read) | Resolves the path, refuses a path that is not a directory, and moves the session through the `changeDirectory` seam. | 2 |
| `Edit` | modify file contents in place | Replaces a string in a file, exactly, and re-resolves the path before the write. Unchanged. | 2 |
| `EndConversation` | end the conversation — only for sustained user abuse, or when the user explicitly asks to see it demonstrated | Ends the session through the `endConversation` seam. | 2 |
| `EnterPlanMode` | switch to plan mode to design an approach before coding | Switches the session's permission mode through the `setPermissionMode` seam. | 2 |
| `ExitPlanMode` | present plan for approval and start coding (plan mode only) | Refuses outside plan mode with the target's own message; in plan mode it presents the plan through the session's dialog. | 1 |
| `GetTask` | check on a background shell command by task ID | Reads the session's background-task registry and reports the task's state and output. | 2 |
| `Glob` | find files by name pattern or wildcard | Finds the files, filtered through the `Read(...)` deny rules. Unchanged. | 2 |
| `Grep` | search file contents with regex (ripgrep) | Searches the files, filtered through the `Read(...)` deny rules. Unchanged. | 2 |
| `LSP` | code intelligence (definitions, references, symbols, hover) | Performs one of the target's own nine operations through the session's language server. | 2 |
| `ListAgents` | list agents you can SendMessage to | Lists the agents the session's team exposes. `ListPeers` is its alias. | 2 |
| `ListMcpResourcesTool` | list resources from connected MCP servers | Lists the resources the session's MCP servers expose. `ListMcpResources` is its alias. | 1 |
| `MultiEdit` | — (the target's inventory names it; the target's own search hint was not read) | Applies the edits in order and writes the file **once**; a failed edit writes nothing. | 1 |
| `Monitor` | watch, monitor, or keep an eye on a process/log/command or WebSocket — stream each stdout line as a live notification | Starts a monitored task through the session's monitor and reports its task id. | 2 |
| `NotebookEdit` | edit Jupyter notebook cells (.ipynb) | Edits the cell. Unchanged. | 2 |
| `NotebookRead` | — (the target's inventory names it; the target's own search hint was not read) | Reads the notebook's cells and reports them in the target's own cell shape. | 1 |
| `OfferChromeSetup` | offer the user the one-time setup of the browser, so this task can use their own signed-in browser | **Refuses**: it needs the browser extension setup card, which this session does not have. Its name, its description, its long prompt, its input schema and its four result strings are the target's own. | 2 |
| `PowerShell` | execute Windows PowerShell commands | Runs `powershell.exe` with the filtered environment; **refuses** on any other platform. | 2 |
| `ProposeGoal` | propose a session goal condition for the user to approve with one keypress | Puts the condition to the session's dialog and reports whether the user was asked. | 2 |
| `Read` | read files, images, PDFs, notebooks | Reads the file. Unchanged. | 2 |
| `ReadMcpResourceDirTool` | list the children of an MCP directory resource | Lists the children through the session's MCP servers. `ReadMcpResourceDir` is its alias. | 1 |
| `ReadMcpResourceTool` | read a specific MCP resource by URI | Reads the resource through the session's MCP servers. `ReadMcpResource` is its alias. | 1 |
| `ReportFindings` | report code-review findings as a structured list | Reports the findings in the target's own finding shape, at most thirty-two of them. | 2 |
| `SendMessage` | send messages to agent teammates | Sends the message through the session's team. | 2 |
| `SendUserMessage` | send a message to the user — your primary visible output channel | Delivers the message through the session's channel. `Brief` is its alias. | 1 |
| `Skill` | invoke a slash-command skill | Resolves the skill through the session's catalogue and returns its instructions; a leading `/` is stripped and an unknown skill is refused with the target's own wording. | 1 |
| `StructuredOutput` | return the final response as structured JSON | Checks that the value is a JSON object and returns it as the session's structured output. | 2 |
| `SubagentHandback` | deliver your final report to the agent that spawned you | Delivers the report through the session's team; an empty report is refused with the target's own wording. | 2 |
| `TaskCreate` | create a task in the task list | Creates the task and answers with `{ task: { id, subject } }`, the target's own shape. | 1 |
| `TaskGet` | retrieve a task by ID | Answers with the task, or with a **null** task when there is none — the target's own shape. | 1 |
| `TaskList` | list all tasks | Lists the tasks; a dependency that is completed is not reported as a blocker, as the target does. | 1 |
| `TaskStop` | kill a running background task | Stops the task through the session's background-task registry. `KillShell` and `KillBash` are its aliases. | 1 |
| `TaskUpdate` | update a task | Changes the named fields and reports the fields it changed. | 1 |
| `TodoRead` | — (**not a target tool**; this implementation's own) | Reports the session's task checklist — the same list `TodoWrite` writes. **Labelled as an extension.** | 1 |
| `TodoWrite` | manage the session task checklist | Records the list in the session's store and reports the list it replaced; the list is cleared when every item is completed, as the target does. | 2 |
| `ToolSearch` | — (the target's own search hint is absent; the target's own wording is "Query to find deferred tools") | Searches the session's tool catalogue by keyword, or by name for a `select:<name>` query. | 1 |
| `WebFetch` | fetch and extract content from a URL | Fetches the URL under a byte cap. Unchanged. | 2 |
| `WebSearch` | search the web for current information | Searches through the session's web-search backend and reports the hits. | 1 |
| `Write` | create or overwrite files | Writes the file. Unchanged. | 2 |
| `memory_list` | list the memory stores and the documents in them | Lists the stores, or the documents of one store, through the session's memory surface. | 2 |
| `memory_read` | read a document from a memory store | Reads the document through the session's memory surface. | 2 |
| `memory_write` | save a document to a memory store | Writes the document through the session's memory surface. | 2 |
| `javascript_tool` | execute JavaScript code in the context of the current page | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `read_page` | get an accessibility tree representation of elements on the page | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `find` | find elements on the page using natural language | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `form_input` | set values in form elements using element reference ID from the read_page tool | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `computer` | use a mouse and keyboard to interact with a web browser, and take screenshots | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `browser_batch` | execute a sequence of browser tool calls in ONE round trip | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `navigate` | navigate to a URL, or go forward/back in browser history | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `resize_window` | resize the current browser window to specified dimensions | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `gif_creator` | manage GIF recording and export for browser automation sessions | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `upload_image` | upload a screenshot you took with the computer tool's screenshot action to a file input or drag & drop target | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `get_page_text` | extract raw text content from the page, prioritizing article content | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `tabs_context_mcp` | get context information about the current MCP tab group | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `tabs_create_mcp` | create a new empty tab in the MCP tab group | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `tabs_close_mcp` | close a tab in the MCP tab group by its ID | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `read_console_messages` | read browser console messages from a specific tab | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `read_network_requests` | read HTTP network requests from a specific tab | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `shortcuts_list` | list all available shortcuts and workflows | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `shortcuts_execute` | execute a shortcut or workflow in a new sidepanel window using the current tab | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `file_upload` | upload one or multiple files to a file input element on the page | **Refuses**: it needs a connected browser extension, which this session does not have. | 2 |
| `switch_browser` | send a connection request to every Chrome browser with the extension installed and wait for the user to pick one | **Refuses**: it needs the browser extension account connection, which this session does not have. | 2 |
| `list_connected_browsers` | list all Chrome browsers currently connected to this account | **Refuses**: it needs the browser extension account connection, which this session does not have. | 2 |
| `select_browser` | select a specific Chrome browser by deviceId for browser automation | **Refuses**: it needs the browser extension account connection, which this session does not have. | 2 |
| `self_hosted_runner_get_pool` | read a self-hosted environment's aggregate state | **Refuses**: it needs the self-hosted environment management API, which this session does not have. | 2 |
| `self_hosted_runner_list_runners` | list runners registered to a self-hosted environment | **Refuses**: it needs the self-hosted environment management API, which this session does not have. | 2 |
| `self_hosted_runner_list_sessions` | list sessions queued/assigned in a self-hosted environment | **Refuses**: it needs the self-hosted environment management API, which this session does not have. | 2 |
| `self_hosted_runner_list_secrets` | list self-hosted environment secrets (metadata only) | **Refuses**: it needs the self-hosted environment management API, which this session does not have. | 2 |
| `self_hosted_runner_spawn_local` | start a local self-hosted runner process for try-it-out | **Refuses**: it needs a self-hosted runner process, which this session does not have. | 2 |
| `self_hosted_runner_read_health` | probe local self-hosted runner /healthz endpoint | **Refuses**: it needs a local self-hosted runner, which this session does not have. | 2 |
| `self_hosted_runner_read_metrics` | read self-hosted runner Prometheus gauges from /metrics | **Refuses**: it needs a local self-hosted runner, which this session does not have. | 2 |
| `self_hosted_runner_tail_log` | tail self-hosted runner log file with secret redaction | **Refuses**: it needs a local self-hosted runner, which this session does not have. | 2 |
| `self_hosted_runner_requeue_session` | requeue a stuck self-hosted runner session onto another runner | **Refuses**: it needs the self-hosted environment management API, which this session does not have. | 2 |

### The tools this implementation does **not** ship

Each one is **named** here with the capability it needs. A tool that cannot be
implemented honestly is omitted and named — never faked.

| tool | the capability it needs | why it is not here |
|---|---|---|
| `AppifactRepl` | the account's artifact SDK | The artifact surface is the account's own; this implementation has no account and no artifact runtime. |
| `ClaudeDesign` | the account's design projects | The design surface lives in the account; there is nothing here to work with. The **name** is the target's own, because a tool's name is the interface the model calls. |
| `CronCreate` | a scheduler | A schedule is a long-lived timer the session owns; the CLI has no scheduler, and a cron entry that never fires would be worse than none. |
| `CronDelete` | a scheduler | The same. |
| `CronList` | a scheduler | The same. |
| `DesignSync` | the account's design projects | The same as `ClaudeDesign`. |
| `EnterWorktree` | a worktree manager | The session's working directory is fixed for the life of a session here, so a worktree the session cannot switch into would be a directory nothing uses. |
| `ExitWorktree` | a worktree manager | The same. |
| `FetchInboxMessage` | the inter-session relay | The relay is the account's own; a session here has no inbox to read. |
| `JavaScript` | a JavaScript runtime in the tool loop | The tool loop runs tools, not arbitrary JavaScript, and running model-supplied code outside the sandbox would be a hole. |
| `ListConnectors` | the connector registry | The registry is the account's marketplace. |
| `ListPlugins` | the account's plugin catalogue | The catalogue is the account's own. |
| `ListSkills` | the account's skill catalogue | The catalogue is the account's own. |
| `ObserverReport` | the harness's observation channel | The harness that produced it is not part of this implementation. |
| `Poll` | the harness event queue | The queue is the harness's own. |
| `Projects` | the account's project surface | The project lives in the account. |
| `PublishPlugin` | the account's plugin library | The library is the account's own. |
| `PushNotification` | a mobile push channel | There is no phone here to push to. |
| `REPL` | an interactive REPL in the tool loop | The tool loop is not a REPL. |
| `ReadNotifications` | the webhook and trigger queue | The queue is fed by the account's own webhooks. |
| `RefreshMcpTools` | live MCP channels | The extension layer manages the MCP connections; this implementation's MCP seam exposes the **resources** only. |
| `RemoteTrigger` | the cloud agent runtime | The cloud runtime is the product's own. |
| `ScheduleWakeup` | the dynamic `/loop` scheduler | The same scheduler the cron tools need. |
| `SearchMcpRegistry` | the connector registry | The registry is the account's marketplace. |
| `SendFeedback` | the feedback queue | The queue is the account's own. |
| `SendFile` | the inter-session relay | The relay is the account's own. |
| `SendUserFile` | the account's file delivery | The delivery is the account's own. |
| `ShareOnboardingGuide` | the account's guide library | The library is the account's own. |
| `ShowOnboardingRolePicker` | the account's onboarding | The onboarding is the account's own. |
| `SuggestConnectors` | the connector registry | The registry is the account's marketplace. |
| `SuggestPluginInstall` | the plugin marketplace | The marketplace is the account's own. |
| `SuggestSkills` | the account's skill catalogue | The catalogue is the account's own. |
| `SearchPlugins` | the account's plugin catalogue | The catalogue is the account's own. |
| `SearchSkills` | the account's skill catalogue | The catalogue is the account's own. |
| `TestingPermission` | the product's own test harness | The tool is the product's own permission probe; this implementation's permission engine is tested by its contract tests instead. |
| `WaitForMcpServers` | live MCP channels | The same as `RefreshMcpTools`. |
| `Workflow` | a deterministic-JavaScript sub-agent orchestrator | The orchestrator runs model-supplied JavaScript; the sub-agent seam is the `Agent` tool's `delegate`. |
| `propose_skills` | the account's skill catalogue | The catalogue is the account's own. |

**Two names in the inventory are not tools.** `latest` and `mcp` are the
verifier's scan picking up two entries of the target's tool-set arrays that are
not tool definitions. They are listed here so that the inventory and this
document agree, and they are not tools.

**One name the sweep derives is not in the record, and it is not a tool
either.** The verifier's sweep of the target's tool factory derives a name
`worker_state` that the generated record does not carry; `worker_state` is a
**worker event subtype** of the target's worker protocol, not a tool
definition. `scripts/verify-rea.ts` reports that gap at `HEAD` as well, before
this task, and the generated record is not this task's to regenerate — so the gap
is **named** here rather than papered over.

**The inventory and the registry are checked against each other.** The contract
test reads the generated inventory and asserts that **every** name in it is
either a tool this implementation registers (directly or through an alias) or a
name this document lists — so a tool that is added to one and not the other
fails the suite.

## The runner's order and its failure envelopes

**The order is check permissions → validate input → execute.** Every failure still produces an envelope (`isError: true`) rather than throwing.

| Situation | Result | Evidence class |
|---|---|---|
| The check **denies** | An error envelope with the decision attached; `execute` is never called | REA observed |
| The **validation** fails | An error envelope with the typed error code and a message naming the offending field | REA observed |
| The tool expresses **no opinion** | Refused — fail closed | implementation choice (deliberate) |
| The check produces an unresolved **ask** | Refused; the session's approval service is the only way to settle it | implementation choice |
| A hook **rewrote** the input | The rewritten input is what executes | REA observed |
| A rewritten input the tool's **validator** rejects | Denied, with a hook-sourced decision and the typed code | REA observed |
| A hook rewrote the input and the rewrite is **not permitted** | The whole permission check runs again on the effective input; the stricter verdict wins | implementation choice |
| The path the check approved **changed** before the write | Refused with `nonExecutionKind: 'path_changed'` | implementation choice |

## The file-mutating path

`Write`, `Edit` and `NotebookEdit` resolve their path, and the resolution is **bracketed**: the path the check approved is re-resolved immediately before the execution, and the tools re-resolve again immediately before the write call. A swap between the two is refused.

**Scope, stated honestly.** The guarantee covers the file-mutating tools. A shell command's redirection target is checked by the rule engine against the file rules, but the shell resolves the target when it runs, so this implementation does **not** claim the same guarantee for a shell redirection.

This is the property the `CC-007` review found missing: the seam existed but was never called, so "re-resolve after the check" was a promise rather than a behaviour.

## The `Read` deny filter (REA observed)

`Glob` and `Grep` filter their results through the `Read(...)` rules, so a file reached through a **symlinked search path** is excluded when a deny rule fires on either the requested or the resolved path. This reproduces the target's own `2.1.251` fix.

## The `Bash` tool

Runs through `/bin/sh -c` with the **filtered** environment — the session's own environment from `BuiltinToolDeps.env`, filtered against the sandbox's allowlist, so a command never sees the agent's credentials — a 120 s default and 600 s maximum timeout, and `timeout: 0` refused by the validator.

The command runs **inside the sandbox** when the session carries a sandbox policy, and **unconfined** when the policy says so — an excluded platform, a switched-off sandbox, an excluded command, or a missing backend with `failIfUnavailable` off. The result says which: `sandboxed`, `sandboxReason`, `sandboxEstablishmentReason`, `sandboxExemptions`, `sandboxExemptionScope` and `sandboxAvailability`. See [`sandbox-surface.md`](sandbox-surface.md).

**One difference from the launcher's own unconfined path, stated plainly.** The tool runs an unconfined command itself rather than through the launcher, so an unconfined run produces **no** `SandboxStatus` — the launcher's unconfined path would also carry the note that the sandbox plan was never established. The tool's own report carries the reason, the scope and the availability, so nothing about the run is hidden, but the two paths are not the same implementation.

**Two things are implementation choices and are labelled as such:** the shell is `sh` per call rather than the target's persistent shell session, and the timeout values are unpinned by the audit. `dangerouslyDisableSandbox` is accepted but never skips a rule check.

**A Bash rule matches command text, not program identity.** `Bash(curl *)` does not stop `/usr/bin/curl` or `sh -c 'curl …'`. This implementation matches text and says so rather than implying a stronger guarantee.

## The `Agent` tool

The target's canonical name for the sub-agent tool is **`Agent`**, and `Task` is
its alias: the target's alias table maps `Task` to `Agent` and the tool itself
declares `aliases: ["Task"]`. This implementation therefore names the tool
`Agent`, and the registry resolves `Task` to it.

It delegates through a `deps.delegate` seam and reports a typed `taskUnavailable` failure when there is no delegate. The **delegation scheduler is not observed** in the audit, so this implementation does not invent one; `CC-010` owns the runtime.

## The capability seams

The tools the target's inventory names need subsystems this implementation does
not have. Those subsystems are **seams**: `BuiltinToolDeps.capabilities` carries
the browser, the language server, the agent team, the scheduler, the MCP
resource surface, the memory surface, the background-task registry, the worktree
manager, the monitor, the skill catalogue, the web-search backend, the channel to
the user, the dialog that asks the user a question, and the session's own
permission mode and working directory.

**A tool whose capability is absent refuses.** It does not pretend: the refusal
is a typed failure (`capabilityUnavailable`) whose message names the tool and
the capability. The seams are this implementation's own design — the target holds
the subsystems directly — and they are labelled as such in the code.

## The browser surface (CC-032)

**Specification:** `/home/shiva/opt/reference-agent-rea/analysis/findings-browser.md`
— the surface inventory, every tool with its schema and its description, the
two group sets, the timeout table, the result caps, the setup tool and the
transport, each claim carrying the target's own file and byte offset.

**Owning task:** `CC-032`. **Evidence class:** `REA observed` — the target's
browser surface was read out of the extracted bundle, by **evaluating** the
target's own tool module and walking the consuming modules' ASTs, so the twenty
-two names, their order, their descriptions, their schemas and the two group
sets are the target's own and not a pattern's guess.

**The target has a browser surface and the audit never mentioned one.** The
target ships **twenty-two** browser tools and a **setup** tool, and it reaches
them through a Chrome extension over a local socket to the browser's
native-messaging host. It also ships a **second, independent implementation**
of the browser tooling as data assets inside the bundle (`playwright-mcp.mjs`,
`ct.mjs`, `ctbrowser.mjs`, `signin.mjs`, `live-page.mjs`, `fence-proxy.mjs`,
`guard.mjs`, `run-tools.mjs`, `tools.mjs`, `psl-data.json` and the rest — the
extraction manifest's list).

### The twenty-two tools

The names are the target's **bare** names: the target reaches them through a
browser MCP server, so the model calls them `mcp__<server>__<tool>`, and the
tool array itself holds the bare names. This implementation registers the bare
names.

| tool | the target's own statement of what it is for | group | what this implementation's version does |
|---|---|---|---|
| `javascript_tool` | execute JavaScript code in the context of the current page | — | **Refuses**: it needs a connected browser extension. |
| `read_page` | get an accessibility tree representation of elements on the page | — | **Refuses**: it needs a connected browser extension. |
| `find` | find elements on the page using natural language | — | **Refuses**: it needs a connected browser extension. |
| `form_input` | set values in form elements using an element reference ID | — | **Refuses**: it needs a connected browser extension. |
| `computer` | use a mouse and keyboard to interact with a web browser, and take screenshots | — | **Refuses**: it needs a connected browser extension. |
| `browser_batch` | execute a sequence of browser tool calls in ONE round trip | — | **Refuses**: it needs a connected browser extension. |
| `navigate` | navigate to a URL, or go forward/back in browser history | — | **Refuses**: it needs a connected browser extension. |
| `resize_window` | resize the current browser window to specified dimensions | session | **Refuses**: it needs a connected browser extension. |
| `gif_creator` | manage GIF recording and export for browser automation sessions | session | **Refuses**: it needs a connected browser extension. |
| `upload_image` | upload a screenshot to a file input or drag & drop target | — | **Refuses**: it needs a connected browser extension. |
| `get_page_text` | extract raw text content from the page, prioritizing article content | — | **Refuses**: it needs a connected browser extension. |
| `tabs_context_mcp` | get context information about the current MCP tab group | session | **Refuses**: it needs a connected browser extension. |
| `tabs_create_mcp` | create a new empty tab in the MCP tab group | session | **Refuses**: it needs a connected browser extension. |
| `tabs_close_mcp` | close a tab in the MCP tab group by its ID | session | **Refuses**: it needs a connected browser extension. |
| `read_console_messages` | read browser console messages from a specific tab | — | **Refuses**: it needs a connected browser extension. |
| `read_network_requests` | read HTTP network requests from a specific tab | — | **Refuses**: it needs a connected browser extension. |
| `shortcuts_list` | list all available shortcuts and workflows | session | **Refuses**: it needs a connected browser extension. |
| `shortcuts_execute` | execute a shortcut or workflow in a new sidepanel window | session | **Refuses**: it needs a connected browser extension. |
| `file_upload` | upload one or multiple files to a file input element on the page | — | **Refuses**: it needs a connected browser extension. |
| `switch_browser` | send a connection request to every Chrome browser with the extension installed | session, selection | **Refuses**: it needs the browser extension account connection. |
| `list_connected_browsers` | list all Chrome browsers currently connected to this account | session, selection | **Refuses**: it needs the browser extension account connection. |
| `select_browser` | select a specific Chrome browser by deviceId | selection | **Refuses**: it needs the browser extension account connection. |

**The group column is the target's own two sets.** The **session** group is the
target's nine-tool set of the tools that manage the browser session rather than
the content of a page (`tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`,
`shortcuts_list`, `shortcuts_execute`, `resize_window`, `switch_browser`,
`list_connected_browsers`, `gif_creator`). The **selection** group is the
target's three-tool set of the tools that need the account-wide browser roster
(`switch_browser`, `list_connected_browsers`, `select_browser`); the target
withholds those three from the tool list unless the session has a bridge
connection.

### The timeouts and the result caps

Every number below is the target's own.

| what | the target's value | where it is used |
|---|---|---|
| the default tool-call timeout | `60000` ms | every browser tool |
| the `browser_batch` timeout | `90000` ms | the target's **one** per-tool override |
| the wait for the extension peer to connect | `10000` ms | the client, before a call |
| the extension-discovery deadline | `5000` ms | the client's extension roster |
| the local-device-ids lookup | `3000` ms | the roster's "on this computer" hint |
| the external-message timeout | `150000` ms, capped at `270000` ms | the pairing broadcast |
| the `switch_browser` wait | `120000` ms | the two minutes the description names |
| the hidden tab-context lookup | `8000` ms | the lookup `navigate` performs for itself |
| the result-size cap | `{"anthropic/maxResultSizeChars": 60000}` | on `read_page`, `browser_batch` and `get_page_text` — and on **no other** tool |
| the `OfferChromeSetup` result cap | `2000` characters | the setup tool |

`read_page`'s own schema says its default output limit is **50 000** characters
and the `_meta` cap is **60 000**; the target keeps both numbers, and so does
this implementation.

### The permission rules

| rule | the target's behaviour | this implementation |
|---|---|---|
| the rule engine | every browser tool consults it | the same |
| the **safe** subset | a tool of the session group that the target's own predicate calls *safe* is **allowed** without a prompt | the same — and only the *generic* prompt becomes an allow, so a **deny rule** and an **ask rule** both still win |
| a non-web URL | **denied**: *"Can't interact with browser-internal or unparseable URLs."* | not implemented — there is no URL to judge |
| an unresolvable tab | **denied**: *"Couldn't determine which page this action targets."* | not implemented — there is no tab to resolve |
| a domain rule | the target's own pseudo-tool, matched on the host | not implemented — there is no site to allow or deny |
| a blanket allow | the target **excludes** the browser tools from every whole-tool allow rule | not implemented — this implementation's rule engine has no whole-tool-allow concept to exclude, so a user's `allow: ["navigate"]` allows the call (and the call then refuses) |

A **scoped** rule on a browser tool does match, and it matches the call's own
content: the URL for `navigate`, the code for `javascript_tool`, the query for
`find`, the action for `computer` and the `deviceId` for `select_browser`. A
rule written `navigate(https://example.com/*)` therefore blocks that URL and
leaves every other one alone.

The **safe** predicate is the target's own: five tools are always safe
(`list_connected_browsers`, `resize_window`, `shortcuts_list`, `switch_browser`,
`tabs_close_mcp`), and three more are safe unless they change something
(`tabs_context_mcp` unless it creates a group, `read_console_messages` and
`read_network_requests` unless they clear).

### The setup tool

`OfferChromeSetup` is in the target's own eighty-eight-tool registry, and
`CC-032` added it here. Its name, its search hint, its one-line description,
its long prompt, its input schema (one optional `reason`, at most 200
characters), its output vocabulary (`connected`, `not_now`, `no_attempt_yet`)
and its four result strings are the target's own. **It refuses**: it needs the
setup card, and there is none here. The target's own permission check is an
**ask** — *"Set up the browser?"* — and so is this one's.

### How the browser is reached — recorded, not reproduced

| the target's layer | what it is | here |
|---|---|---|
| the browser MCP server | a server named for the browser, version `1.0.0`, capabilities `{tools:{listChanged:true},logging:{}}`, reachable in-process or as a stdio subprocess behind a CLI flag | not reproduced |
| the transport | a local Unix socket to the browser's native-messaging host (a named pipe on Windows), or a WebSocket bridge, or a pool of sockets | not reproduced |
| the wire protocol | a four-byte little-endian length prefix and a JSON frame, after a local pairing handshake | not reproduced |
| the extension | the browser extension instance, addressed by a `deviceId`, discovered over the socket | not reproduced |
| the session tab | the **tab group**: `tabs_context_mcp` returns the group's tabs and a `tabGroupId`, and every tab tool's schema names the group | not reproduced |
| the connector | a user-invocable bundled command that adds the browser server, gated by a browser permission setting | not reproduced |

### The honest boundary

**This implementation has no browser.** There is no extension, no
native-messaging host, no socket, no tab group and no setup card here, so
every one of the twenty-three tools **refuses** with a typed
`capabilityUnavailable` whose message names the tool and the capability it
needed. **No tool pretends to drive a browser**: none of them returns a page,
a screenshot, a tab list or a text extraction, and none of them opens a
socket.

### The clone's own choices on the browser surface

Each one is labelled in the code as well as here.

- the **refusal** — the target has a browser, so the target never refuses; the refusal, its wording and its error code are this implementation's own;
- the **safe-subset rule** — the rule is the target's own, but the target's hook decides it on the whole rule engine while this implementation decides it on the *generic prompt* marker; that is why a deny rule and an ask rule both still win here;
- the **validation** — the target validates its own input inside its MCP server; the check that runs here, and the typed codes it reports, are this implementation's own;
- the **schemas** — the target's, byte for byte, and they do **not** close their object, so a browser call may carry an argument the schema does not name. The rest of this implementation's tools close theirs; the browser tools do not, because the target's do not;
- the **tool names** — the target's **bare** names, not the server-prefixed ones the model calls, because the server prefix carries the product's own name and the bare names are what the target's own tool array holds;
- the **rule matching** — because the names are bare, a rule is written `navigate(...)` and not with the server prefix. A scoped rule on a browser tool matches the call's own content — the URL for `navigate`, the code for `javascript_tool`, the query for `find`, the action for `computer` and the `deviceId` for `select_browser` — so a scoped rule is never half-live;
- the **output shapes** — the target's tools answer with an MCP tool result; there is no such envelope here, and none is invented;
- the **unimplemented rules** — the non-web-URL denial, the unresolvable-tab denial, the domain rule and the exclusion from every blanket allow are the target's own rules and they are **not** implemented here, because each of them judges a site or a tab and there is neither.

## Unpinned surfaces (implementation choices, labelled in the code)

- The `nonExecutionKind` vocabulary: `unknown_tool`, `permission_denied`, `permission_unresolved`, `permission_check_failed`, `validation_error`, `path_changed`, `execution_failed`. The audit pins the *field*, not the values.
- The error codes, **except** `7` (invalid path) and `14` (a suppressed write), which the audit names. The numbering is implementation-internal; its gaps are not an alignment with any target table.
- The tool **output** shapes — `{type:'text', text, files, truncated}` for `Glob`, `{text, stdout, stderr, exitCode, truncated}` for `Bash` — and the `ToolErrorContent` `{type:'error', message, errorCode}`. These reach the model and the session log, and the audit pins only the tool-result *metadata*.
- **Implementation choice (`CC-008b`).** The `Bash` output gained the sandbox members — `sandboxed`, `sandboxReason`, `sandboxEstablishmentReason`, `sandboxExemptions`, `sandboxExemptionScope`, `sandboxAvailability` — and `timedOut`. The audit records no such members; they are this implementation's, and the shape is additive.
- `Grep`'s bounds (a 512-character pattern, a 1 MiB file, 2 000 examined files), `Glob`'s result cap, and `WebFetch`'s timeout and byte cap.


### The one deliberate difference: the product's name

The target's UI is reproduced **value for value** — the same colours, the same
glyphs, the same order, the same keybindings, the same markdown rules, the same
strings. The one thing that is **not** reproduced is the **product's own name**, in
the three places it appears:

| where | the target says | PRRICODE says |
|---|---|---|
| the approval dialog's third option | the target's own product name in place of the agent's | `No, and tell PRRICODE what to do differently (esc)` |
| the assistant's screen-reader gutter | `claude:` | `prricode:` |
| the theme's role names | `claude`, `claudeShimmer`, … | `prricode`, `prricodeShimmer`, … |

The **values** of the theme roles are the target's, verbatim — `rgb(215,119,87)` and
the rest — so the pixels are identical. Only the *name* is PRRICODE's own, and the
divergence is recorded here rather than papered over. The target's own environment
variables, model ids, API hosts and the MCP proxy header keep the target's names,
because those are the data the implementation has to speak to.

## The terminal UI (F-39)

**Specification:** `/home/shiva/opt/reference-agent-rea/analysis/findings-terminal-ui.md` — the surface inventory, every string, the layout of every surface, the theme's colours, the rule that maps a role to one, the keybindings, the markdown rules and the observable behaviours. Every claim in that document carries the target's own file and byte offset.

**Owning task:** `CC-022`. **Evidence class:** `REA observed` — the target's terminal UI was read out of the extracted bundle, so the surfaces below are compared against the target's own strings, order, colours and keys.

### What is compared

| Surface | What the specification established | What the clone does | Match |
| --- | --- | --- | --- |
| The **theme** | The dark theme, value for value, and the role→colour rule (`qn`/`dMt`) — §1.1, §1.2 | `src/ui/theme.ts` carries the target's 72 roles verbatim and resolves a role to its literal with an own-property lookup | yes |
| The **glyph set** | `●`/`⏺`, `❯`/`>`, `✔`/`√`, `✘`/`×` and the platform deltas — §1.4 | `glyphs()` reproduces the rule, not one platform's answer | yes |
| The **transcript** | The user's prompt, the assistant's reply, a thinking block, a tool call and a tool's result: the markers, the order and the colours — §3.1–§3.6 | `renderTranscript` produces the target's rows, with the roles the colours come from. The thinking block's renderer is the target's, but this implementation's records carry no thinking block, so the row has no producer yet | yes, for the rows that have a producer |
| The **composer** | The prompt glyph (with its non-breaking space), the top rule in `promptBorder`, and the dimmed, inverted-cursor placeholder — §2.1–§2.3 | The app draws the glyph, the `promptBorder` top rule and the `Try "…"` placeholder | yes |
| The **hint line** | The dim hint line, its parts and the `" · "` separator — §2.4 | `hintLineItems` produces the parts; the app joins them with `" · "` | yes |
| The **`?` shortcuts overlay** | The overlay's lines, in the target's order, and the `<chord> to <action>` form — §2.5 | `shortcutOverlayLines` produces the target's lines; `?` on an empty line opens the overlay | yes, for the lines; the overlay's *chrome* is not established |
| The **approval dialog** | The title, the question, the options (no numbers), the pointer, the tick and the input guide — §4.1–§4.3 | `approvalPromptParts` and `optionSegments` produce the target's dialog | yes |
| The **keybindings** | The contexts, the chords, the actions and the platform deltas — §9.1, §9.2 | `keybindings()` is the target's table, with the paste and cycle-mode chords resolved per platform | yes |
| The **spinner and the status line** | The six frames, the two-second oscillation, the gutter arrow and the verb `Working` — §5.1, §5.2 | `SPINNER_FRAMES` and `spinnerFrame` are the target's; the app draws `↓ <frame> Working` | yes |
| The **markdown** | The heading, code-block, inline-code, list, table, blockquote, rule, image, link and strike-through rules — §10.1 | `renderMarkdownSegments` implements the target's rules and produces the roles | yes |
| The **two gestures** | `Esc again to clear` and `Press ctrl+c again to exit` — §12.3 | The app arms the first press and acts on the second; `ctrl+c` is not Ink's own exit key | yes |

### What the specification did **not** settle — left alone, and named

Nothing below was invented. Each is a surface the specification explicitly could not establish, or a surface this implementation does not have.

| Surface | Why it is left alone |
| --- | --- |
| The **`/permissions` panel's chrome** | The specification did not locate the component (§8, §13.1). This implementation has no permissions panel. |
| The **composer's bottom rule** | The specification's §2.2 quotes a border whose `borderBottom` is set, while its prose and its closing section (§13.2) say the bottom rule was **not** established. The specification contradicts itself here, so the clone follows the closing section and draws the **top rule only** — and says so rather than picking a side silently. |
| The **session-title banner** in the composer's rule | The target puts the session's title in the rule's `borderText` (§2.2, §12.7). This implementation has no session title, so the rule is plain. |
| The **shell mode's switch** | Typing `!` into an empty prompt enters the shell mode (§12.8), whose glyph and hint are reproduced — but this implementation has no shell mode to enter, so the switch is not made. |
| The **permission-mode pill** and the mode cycling | The mode *labels* are established (§4.4) and the `shift+tab` binding is (§9.1), but the pill's own rendering is not, and this implementation's permission mode is fixed for the session. |
| The **token counter** (`↓ N tokens`) | The target's format is established (§5.2); this implementation's runtime does not surface a token count, so the counter has no producer. |
| The **transcript's empty state** | No empty-state string was found (§13.3). The clone has no empty state. |
| The **thinking block's producer** | The block's *shape* is established (§3.4) and the renderer is the target's, but this implementation's session records carry a thinking block only as a raw provider event, and the plan fixes the message list as one block per assistant message and one per tool call. The renderer exists; nothing feeds it yet. |
| The **per-tool summary text** inside `( … )` | The *shape* is established; the seven `renderToolUseMessage` texts were not read (§13.4). The clone's own summary fields are used, and the shape is the target's. |
| The **`/help` and `/diff` layouts** | Neither body was read (§13.5, §13.7). |
| The **welcome screen** | The version line is established, but the banner art is not, and this implementation has no welcome screen. |
| The **model picker** | The target's picker is a different surface from this implementation's multi-provider picker, which is a **project extension** (`CC-016`). |
| The **slash-command registry** | §11's 92 commands are `CC-030`'s work; this task changed no command. |
| The **diff panel's chrome** | The colour roles are established, the panel's layout is not (§13.7). |
| The **input field's readline-style key map** | §9.3 establishes the target's field: the word motions, `home`/`end`, the `ctrl+a`…`ctrl+y` family and the `meta` motions. This implementation's composer is a single line of text with no cursor, so those chords have nothing to move. The chords it *can* act on are implemented: `enter`, `escape`, `ctrl+j`, `ctrl+l`, `ctrl+c`, `ctrl+d`, the backspace and delete keys, and the approval dialog's arrows. |

### The clone's own choices on the compared surfaces

These are the places where the clone differs from the target *by choice*, each one labelled in the code:

- the **ARIA region labels and roles** (`Conversation`, `Message input`, the approval listbox) — the target's regions were not established; the target labels its **gutters** (`you:`, `prricode:`, `tool:`, `thinking:`), and the clone does that too;
- the **denial marker** (`denied (source: …, reason type: …)`) and the **sandbox status lines** — the target reports a denial as the tool's own error result;
- the **persistent option's label** — the target's own labels are per-tool templates, and the specification did not establish which template applies to which case;
- the **reason line** under the question — the target's own line is the "always allow is not available" note, which this implementation has no equivalent for;
- the **syntax highlighter** and the **terminal hyperlink** — the clone has neither, so a code block's body is verbatim and a link carries its URL without an OSC 8 sequence;
- the **nested list's indent** (two columns per level), the **spinner's cosine**, the **placeholder's rotation** and the **frame rate** — implementation choices, each labelled where it is made;
- the **toast's placement** — the target renders its notifications in a right-hand column (§5.4, §12.4); the clone renders them on a line under the hint line, joined with the target's `" · "` separator;
- the **`?` overlay's opening rule** — the target's footer advertises `? for shortcuts` (§2.4) but the specification does not say how the overlay is opened; the clone opens it on `?` **on an empty line**, so a question mark can still be typed into a prompt.

## Conformance table

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The file-mutating set is exactly `Edit`, `Write`, `NotebookEdit`, derived from the permission module | REA observed | F-21 | `tests/contracts/tool-registry.test.ts` — "derives the file-mutating tool set from the permission module" |
| The runner's order is check → validate → execute | REA observed | F-18 | same file — "the tool runner" |
| A denial produces an envelope with the decision attached, and `execute` is not called | REA observed | F-18 | same file |
| A validation failure produces the typed code and a message naming the field | REA observed | F-18 | same file |
| A tool with no opinion fails closed | implementation choice | F-18 | same file |
| An unresolved ask is refused | implementation choice | F-18 | same file |
| A hook rewrite is what executes, and a validator-rejected rewrite denies | REA observed | F-18 | same file |
| A rewrite triggers the whole re-check, and the stricter verdict wins | implementation choice | F-18 | same file — the ask / allow-scope / `acceptEdits` rewrite tests and the negative control |
| The path the check approved is re-resolved before the write, and a swap is refused | implementation choice | F-18 | same file — the "refuses a write whose path was re-resolved to another target after the check" and "refuses a write whose rewritten path was swapped while the re-check ran" tests |
| Every built-in consults the rule engine | REA observed | F-20 | same file — "the built-in tools and the rule engine" |
| No tool rewrites its own input | implementation choice (deliberate) | F-20 | same file |
| `Glob`/`Grep` apply the `Read` deny rules through a symlinked search path | REA observed | F-20 | same file |
| The approval prompt shows the resolved destination | implementation choice | F-18 | `tests/security/permission-rules.test.ts` — "the approval prompt" |
| A Bash rule matches command text, not program identity | Documented only | F-20 | same file |
| The malformed-call path reaches the audit's `errorCode: 7` / `3` end-to-end | REA observed | F-20 | `tests/contracts/tool-registry.test.ts` — the end-to-end malformed cases |
| The rule engine's tool tables name only shipped tools | implementation choice | F-20 | `tests/security/permission-rules.test.ts` — "the rule engine's tool tables" |
| The registry carries the target's **alias table**, and an alias resolves to its canonical tool | REA observed | F-17 | `tests/contracts/tool-registry.test.ts` — "carries the target's alias table" and "resolves an alias to the canonical tool" |
| The sub-agent tool is the target's **`Agent`**, and `Task` is its alias | REA observed | F-17 | same file — "the Agent tool" — "is the target’s `Task` alias" |
| A tool whose capability is absent **refuses** with a typed failure that names the capability | implementation choice (deliberate) | F-17 | same file — "the tools the target’s inventory names" |
| The `WebSearch` tool searches through the session's backend and refuses a call that names both domain lists | REA observed (the bounds are the target's; the backend seam is this implementation's) | F-17 | same file — "searches the web through the backend the session supplies" |
| The `ExitPlanMode` tool refuses outside plan mode with the target's own message | REA observed | F-17 | same file — "refuses to leave plan mode outside plan mode" |
| The `AskUserQuestion` tool refuses a question with fewer than two options | REA observed | F-17 | same file — "refuses a question with fewer than two options" |
| An `Edit(...)` rule governs a `MultiEdit` call | REA observed | F-20 | same file — "lets an Edit rule govern a MultiEdit call, as the target says" |
| A `MultiEdit` that fails one edit writes **nothing** | implementation choice | F-18 | same file — "writes nothing when an edit of a MultiEdit fails" |
| The envelope's members carry the **target's** names — `id`, `non_execution_kind`, `user_feedback`, `remedy` and `permission_decision { decision, source, reason_type }` | REA observed (audit §2.4) | F-18 | `tests/contracts/tool-registry.test.ts` — "names the envelope's members the way the target names them" |
| The previous spellings (`toolUseId`, `permissionDecision`, `nonExecutionKind`, `userFeedback`) are the **migration path**: the reader accepts them and returns the target's names | implementation choice (the migration) | F-18 | `tests/contracts/session-store.test.ts` — "reads a record whose envelope carries the previous member names" |
| The `Skill` tool invokes a skill the extension layer's registry discovered | REA observed (the registry is the target's; the seam is this implementation's) | F-17 | `tests/contracts/extensions.test.ts` — "the Skill tool and the skill registry" |
| The browser surface is **twenty-two** tools, and the first of them is **`javascript_tool`** — `javascript_exec` is the value of its `action` argument, not a tool name | REA observed | F-17 | `tests/contracts/tool-registry.test.ts` — "the browser surface" — "carries the target's twenty-two browser tools, in the target's order" and "carries the target's own input schemas" |
| The browser tools' **descriptions and input schemas** are the target's own, with the product's name replaced | REA observed | F-17 | same file — "carries the target's own descriptions" and "names no target product name in any browser description" |
| The browser tools' **two group sets** — the nine-tool session group and the three-tool selection group — are the target's | REA observed | F-17 | same file — "carries the target's two tool groups" |
| The browser **timeout table**, the `browser_batch` override, the two-minute `switch_browser` wait and the three result caps are the target's | REA observed | F-17 | same file — "carries the target's timeouts and result caps" |
| The browser tools' **safe subset** and its predicate are the target's | REA observed | F-17 | same file — "reproduces the target's safe subset" |
| A browser tool of the **safe subset** is allowed without a prompt, and a deny rule and an ask rule both still win | REA observed (the rule is the target's; the *generic prompt* is this implementation's marker) | F-20 | same file — "allows the target's safe subset and asks for everything else", "lets a deny rule block a safe browser tool" and "lets an ask rule ask for a safe browser tool" |
| A **scoped** rule on a browser tool matches the call's own content, and a rule on one URL leaves the others alone | REA observed (the target's MCP tools are matched by their arguments) | F-20 | same file — "lets a scoped rule match a browser call's own content" |
| Every browser tool **refuses** and names the capability it needs; none of them pretends to drive a browser | implementation choice (deliberate) | F-17 | same file — "refuses every browser tool and names the capability it needs", "names the browser capability in the refusal" and "does not let a browser tool pretend to drive a browser" |
| The `OfferChromeSetup` tool carries the target's name, description, prompt, schema and result strings, and **refuses** | REA observed (the data) / implementation choice (the refusal) | F-17 | same file — "carries the setup tool and refuses it" and "asks before offering the setup, the way the target does" |
| The terminal UI's **theme** is the target's, value for value, and the role→colour rule is the target's | REA observed | F-39 | `tests/contracts/ui-render.test.ts` — "the theme — the target's colours and the role rule" |
| The terminal UI's **glyphs** carry the target's platform deltas | REA observed | F-39 | same file — "the glyphs — the target's platform deltas" |
| The terminal UI's **transcript** rows carry the target's markers, order and colours | REA observed | F-39 | same file — "the transcript — the target's rows" |
| The terminal UI's **composer** shows the target's glyph, top rule and placeholder | REA observed | F-39 | same file — "the composer" |
| The terminal UI's **hint line** joins its parts with the target's separator | REA observed | F-39 | same file — "the hint line" |
| The terminal UI's **approval dialog** shows the target's title, question, options and guide | REA observed | F-39 | same file — "the approval prompt — the target's dialog" |
| The terminal UI's **keybindings** are the target's table, with the target's platform deltas | REA observed | F-39 | same file — "the keybindings — the target's table" |
| The terminal UI's **spinner** and **status line** carry the target's frames and verb | REA observed | F-39 | same file — "the spinner" |
| The terminal UI's **markdown** follows the target's rendering rules | REA observed | F-39 | same file — "renderMarkdown — the target's rules" |
| The terminal UI's two **gestures** are the target's (`Esc again to clear`, `Press ctrl+c again to exit`) | REA observed | F-39 | same file — "the app — the two gestures" |
