# Command-line surface conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.10 ("The command-line surface") and this implementation-choice labels the source carries in [`src/cli/args.ts`](../../src/cli/args.ts), [`src/cli/command.ts`](../../src/cli/command.ts), [`src/cli/headless.ts`](../../src/cli/headless.ts) and [`src/cli/output.ts`](../../src/cli/output.ts).
**Owning task:** `CC-014` (the parser, the headless mode, the output contracts), `CC-016` (the multi-provider manager) and `CC-030` (the in-session slash-command registry) in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**Matrix rows:** F-01, F-02, F-38 in [`feature-matrix.md`](feature-matrix.md), and F-40 in [`provider-catalog.md`](provider-catalog.md).

Every row names its **evidence class**: `REA observed` (established from the pinned binary), `Documented only` (external product documentation, not the pinned binary), or `implementation choice` (a decision this implementation makes). The **measured** outcome of each row is in [`results.md`](results.md).

## The parser's structure (REA observed)

The scanner walks `argv` until `--`, which **ends** the flag parsing. A token of the form `--flag=value` yields that value; a token equal to a known flag consumes the next token as its value. A token is a **flag** when it has more than one character and starts with `-` — a lone `-` is a positional.

The parser keeps three sets:

| Set | What it does |
|---|---|
| the **value** flags | a known flag consumes the next token as its value, whether or not that token looks like a flag |
| the **repeatable** subset | a flag of this set consumes **every** following non-flag token, so `--allowedTools Read Write` names two tools |
| the **boolean** flags | a flag of this set consumes the next token only when it does **not** look like a flag — so `-r`/`--resume` takes an *optional* value |

The **repeatable** set is exactly the audit's eleven names: `--allowedTools`, `--allowed-tools`, `--disallowedTools`, `--disallowed-tools`, `--tools`, `--add-dir`, `--mcp-config`, `--betas`, `--file`, `--channels`, `--dangerously-load-development-channels`.

## The command tokens (REA observed)

A token is a **command**, not a flag, when it is one of `-p`, `--print`, `--bg`, `--background`, `--routine`, `-h`, `--help`, `-v`, `-V`, `--version`, or when it starts with `--routine=`.

The **subcommands** are `attach`, `logs`, `stop`, `kill`, `respawn`, `rm`.

## The shapes (REA observed)

| Shape | The rule |
|---|---|
| A **session id** | `/^(?:session|cse)_[A-Za-z0-9_]+$/`; a path is scanned for such a segment |
| A **cloud session ref** | an 8-hex-digit id, `/^[a-f0-9]{8}$/` |
| A **URI argument** | starts with `cc://` or `cc+unix://` |
| A **short flag cluster** | `/^-[A-Za-z]{2,}$/` — one token, not two flags |

## The headless rule (REA observed)

Headless mode is forced by a **non-TTY stdout**. The headless decision is `--print` (or `-p`), `--init-only`, `--sdk-url`, **or** `!process.stdout.isTTY`.

## The formats (REA observed)

The **input format** is `text` or `stream-json`; the **output format** is `text`, `json` or `stream-json`.

## The validation messages (REA observed)

Every message below is the target's, verbatim.

| Condition | Message |
|---|---|
| an unknown input format | `Error: Invalid input format "<value>".` |
| `--input-format=stream-json` without `stream-json` output | `Error: --input-format=stream-json requires output-format=stream-json.` |
| `--input-format=stream-json` without `--print` | `Error: --input-format=stream-json requires --print.` |
| `--sdk-url` without both stream formats | `Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json.` |
| `--no-session-persistence` without `--print` | `Error: --no-session-persistence can only be used with --print mode.` |
| `--forward-home-settings` with a non-boolean | `Error: --forward-home-settings takes true or false, not <value>.` |
| `--forward-home-settings` with no cloud target | `Error: --forward-home-settings says whether this machine's settings go into a cloud session; pass --cloud (a new session, or one to attach to) or --environment` |
| a mode that cannot be combined with resume/continue/teleport | `<mode> cannot be combined with --resume, --continue, or --teleport` |
| `--init-only` or `--session-id` combined with a mode | `<mode> cannot be combined with --init-only` / `… --session-id` |
| `--environment` with `--cloud` | `Error: --environment creates a new session; it cannot be combined with --cloud <session_id|url>` |
| a non-interactive mode with a cloud description | `non-interactive <mode> reads the prompt from the positional or stdin; drop --cloud/--remote <description>.` |
| a non-interactive mode with `--output-format stream-json` | `<mode> does not support --output-format stream-json` |
| the task given twice | `Error: the task was given twice: as --cloud's value (<value>) and as the prompt. With --print, give it in one place; to name the session, use -n/--name.` |
| `--attach-serve` without the serve-only launch | `Error: --attach-serve requires the serve-only headless launch (non-interactive, --input-format stream-json and --output-format stream-json) and an enabled headless cloud client; it never falls back to a plain attach` |

### Which mode each `<mode>` row decides

The audit's `<mode>` placeholder is ambiguous: it records three rows that name a mode and does not say which mode each row is about. This implementation says, because a rule that does not say which mode it decides is not a rule:

| Row | The mode this implementation applies it to | Why |
|---|---|---|
| `cannot be combined with --resume, --continue, or --teleport` | **`background`** | The target's print mode **does** combine with `--resume`: the target's own message says "when used with `--print`". |
| `cannot be combined with --init-only` / `… --session-id` | **every** mode | `--init-only` and `--session-id` name the session; a mode names how the run talks to the user. |
| `does not support --output-format stream-json` | **`background`** | The target's print mode uses `stream-json` — the audit's own `--input-format=stream-json` rules require `--print`. |

**Implementation choice** — the audit's placeholder is ambiguous, and this implementation's reading is recorded here and in the source.

## This implementation's choices

Each of these is this implementation's own decision, labelled as such in the source it lives in.

### The boolean-flag deviation

**Implementation choice, deliberate.** The audit describes the **boolean** set as consuming the next non-flag token. Taken literally, every boolean would swallow the prompt: `agent --continue "the prompt"` would run with no prompt at all. This implementation applies the optional value to **the flag the audit names** — `-r`/`--resume` — and keeps the rest of the boolean set **pure**.

The audit's rule is therefore reproduced **for the flag it names**, and narrowed everywhere else. The narrowing is a deliberate divergence and it is recorded here rather than left implicit.

### The invalid-output-format wording

**Implementation choice.** The audit records an **input**-format message and no output-format one. This implementation's own message is:

```
Error: Invalid output format "<value>".
```

It mirrors the target's input-format message, and it is this implementation's wording.

### The invalid-permission-mode wording

**Implementation choice.** The audit records the six permission modes and no message for an unknown one. This implementation's own message is:

```
Error: Invalid permission mode "<value>".
```

### The help/version precedence

**Implementation choice.** The audit records `--help` and `--version` as command tokens but not their precedence. This implementation makes them win **wherever** they appear and **whatever else** is on the command line: a help request that loses to an earlier `--print` is a help request the user never sees.

### The empty `--print=` rule

**Implementation choice.** `--print=<value>` names the prompt. An **empty** inline value is **no value**: `--print=` names the mode, and the prompt still comes from the positional argument or from the standard input.

### The unimplemented options

**Implementation choice.** The audit records the flag names and not what they do, and this implementation does not implement them. A flag this implementation accepts and then ignores is worse than one it refuses, so each of them is **refused by the run**, before anything is set up, with a message that names it.

| Option | Why this implementation refuses it |
|---|---|
| `--sdk-url` | it names an SDK server, and this implementation has no SDK server |
| `--teleport` | it moves a session to another machine, and this implementation cannot |
| `--max-turns` | it caps the number of turns, and this implementation makes one turn |
| `--system-prompt` | it replaces the system prompt, and this implementation has none |
| `--append-system-prompt` | it appends to the system prompt, and this implementation has none |
| `--verbose` | it writes more about what the run does, and this implementation does not |
| `--debug` | it writes the run's debug trace, and this implementation does not |
| `--cloud` | it names a cloud session, and this implementation has no cloud client |
| `--remote` | it names a remote session, and this implementation has no remote client |
| `--environment` | it names a cloud environment, and this implementation has no cloud client |
| `--betas` | it names the beta flags of the request, and this implementation sends none |
| `--file` | it names the files the session starts with, and this implementation starts with none |
| `--channels` | it names the channels of the session, and this implementation has none |
| `--mcp-config` | it names the MCP configuration files, and this implementation loads none |
| `--dangerously-load-development-channels` | it loads the development channels, and this implementation loads none |
| `--name` | it names the session, and this implementation has no name for one |
| `--no-session-persistence` | it keeps the session off the disk, and this implementation always writes the transcript |

The **parser** still knows every one of them, so the audit's own validation messages fire first.

### The stream-json input

**Implementation choice.** The audit records that the input format is `text` or `stream-json`, that `--input-format=stream-json` requires `--output-format=stream-json` and that it requires `--print` — and **nothing** about the shape of a document.

This implementation reads the shape the target's own SDK protocol uses: the standard input carries **JSON documents**, one per line, and each of them is a **user message** whose content is a string or an array of `{type: 'text', text}` blocks. The **text** of the documents is the prompt — the model never sees the raw blob.

**A limitation, stated rather than hidden:** this implementation's headless run makes **one** turn, so a stream-json input that carries several user messages contributes the text of all of them to that one turn. The target's stream-json input drives a **persistent session**, one turn per message.

### The other implementation choices

| Choice | What this implementation does | Why it is this implementation's |
|---|---|---|
| The **short flag cluster** | the pattern is widened to `^-[A-Za-z0-9]{2,}$`, so the audit's own example (`-d2e`) is one token; it is expanded only when **every** letter is a known short flag | the audit's pattern does not match its own example |
| The **bare subcommand** | a subcommand is a command when it comes **first** | the audit names the six names and not where they may appear; the first token is the only placement that cannot swallow a prompt |
| The **subcommands** | the six names are recognised and **refused** by the run | the audit records their names and not their behaviour |
| The **background mode** | recognised and refused by the run | this implementation does not run it |
| The **default model** | `claude-sonnet-4-5` | the audit does not record the target's default model |
| The **version** | this implementation's own `package.json` version | this implementation does not claim to be the reference agent |
| The **help text** | this implementation's own | the audit records the flag names and no help text |
| The **output documents** | this implementation's own shapes | the audit pins the three formats and nothing about what a document contains |
| The **exit codes** | `0` success, `1` failure, `2` an argument error | the audit records this implementation's two known ones |
| The **gateway condition** | the settings key `useGateway` | the target's condition (`Br() \|\| aet() \|\| cet()`) is not resolved in the REA record |
| The **manager surfaces** | `/provider`, `catalog`, and their `--provider` / `--catalog` forms | a **project extension** — see [`provider-catalog.md`](provider-catalog.md) |

## The in-session slash-command registry (REA observed)

The target registers its **in-session** commands in one registry: the commands a user types as `/name` inside a session. Every entry carries a **name**, a **description**, an **argument hint**, a list of **aliases**, a **type** (`local` | `local-jsx` | `prompt`) and the place the target puts it.

**Source of truth:** the definitions in `chunk-4jsg44k7.js` at `:1532071`–`:2204406`, and the record the milestone names — `/home/shiva/opt/reference-agent-rea/analysis/findings-untouched-surfaces.md` §G2 and §3.3 ("The slash-command registry"), with `findings-terminal-ui.md` §11 ("The slash commands") for the argument hints and for the composer's `/`-overlay.

**Implementation:** [`src/cli/commands/slash.ts`](../../src/cli/commands/slash.ts) (the registry, the lookups and the dispatch), [`src/cli/commands/manager.ts`](../../src/cli/commands/manager.ts) (the two commands this implementation owns), [`src/cli/interactive.ts`](../../src/cli/interactive.ts) (the host that dispatches through the registry) and [`src/ui/render/prompts.ts`](../../src/ui/render/prompts.ts) (the overlay that reads the registry).

| What | How many |
|---|---|
| command definitions with a literal name | **123** — 118 of type `local`/`local-jsx`, 5 of type `prompt` |
| distinct command names | **100** |
| commands this implementation runs | **12** of the target's, plus the **2** it owns |
| commands this implementation refuses | **88** |

### The record's count, and this implementation's

The record (§G2, §3.3) counts "122 command objects, 92 distinct command names"; its table carries 122 rows and 93 distinct names, the 93rd being the plugin-registered template. Reading the same bundle with a parser finds **123** definitions and **100** names. The two readings differ in three ways, and **none** of them is a disagreement about a command the two have in common — 86 names are common to both:

1. the record's table leaves out **eleven** of the target's commands: the five `prompt`-type ones (`commit-push-pr`, `init`, `team-onboarding`, `statusline`, `insights`) and the six `local`/`local-jsx` ones whose description the target computes at run time or whose `type` member the target writes last in the object literal (`vim`, `ultrareview`, `ultraplan`, `passes`, `sandbox`, `chrome`);
2. the record counts three **template** names — `n.name` (a plugin command, `chunk-4jsg44k7.js:50437`), `e` (the stub `qYt` generates, `:1682414`) and `e.name` (an enterprise command, `:2187476`) — where this implementation resolves the first two and records the third as a template;
3. the record keeps the target's **minified** names — `xEe`, `vZ` and `oRs` — where this implementation resolves them to `low-priority`, `limit-reset` and `claim-credit`, the constants they are bound to in the bundle.

**Implementation choice, deliberate.** This implementation prefers the parsed reading and says so here: the registry is the target's, and a command the target registers is a command the registry holds.

### The names the target computes

Four of the target's registry entries have a name the target **computes** at run time. They are recorded as templates rather than as commands, because their names are not known until the session runs: the plugin-registered command (`n.name`), the enterprise command (`e.name`), the two settings stubs `qYt` generates (`vim` and `output-style` — the latter is also a command in its own right), and the prompt an MCP server contributes.

### The descriptions the target computes

Eleven of the target's descriptions and argument hints are **computed** at run time — a getter, or a template with a computed part. The registry records the **static** text of each, and the table below carries it. The rule is the same for all of them: the literal parts of the target's own text, with the computed part left out.

### The table

Every command of the registry, what the target says it does, and what this implementation's version does.

| `/add-dir` | Add a new working directory | refused: this implementation has no way to give the session another working directory | refused |
| `/cloud-plugins` | Choose whether cloud sessions use the plugins enabled on this machine | refused: this implementation has no cloud sessions | refused |
| `/auto-mode-setup` | Teach auto mode about your environment, plus optional rule tweaks | refused: this implementation has no auto-mode environment wizard | refused |
| `/artifacts` | Browse your published and shared artifacts | refused: this implementation has no published artifacts | refused |
| `/autofix-pr` | Monitor and autofix any issues with the current PR | refused: this implementation has no pull-request tracker | refused |
| `/btw` | Ask a quick side question without interrupting the main conversation | refused: this implementation has no side-question channel | refused |
| `/feedback` | Send feedback to Anthropic or report a bug | refused: this implementation has no channel to send feedback | refused |
| `/bug` | Report a bug or share your conversation | refused: this implementation has no channel to report a bug | refused |
| `/cd` | Move this session to a new working directory | refused: this implementation has no way to change the working directory of a running session | refused |
| `/clear` | Start a new session with empty context; previous session stays on disk (resumable with /resume) | starts a new session with an empty context; the previous one stays on disk | implemented |
| `/color` | Set the prompt bar color for this session | refused: this implementation has no prompt-bar colour setting | refused |
| `/copy` | Copy PRRICODE's last response to clipboard (or /copy N for the Nth-latest) | refused: this implementation has no clipboard access | refused |
| `/desktop` | Continue the current session in PRRICODE Desktop | refused: this implementation has no desktop client to hand the session to | refused |
| `/commit-push-pr` | Commit, push, and open a PR | refused: this implementation has no built-in commit-and-pull-request prompt | refused |
| `/compact` | Free up context by summarizing the conversation so far | asks the model for a summary and marks the compaction boundary | implemented |
| `/autocompact` | Set how full the context gets before auto-summarizing | refused: this implementation has no automatic compaction window | refused |
| `/config` | Open settings | reports the settings tiers and the merged settings document | implemented |
| `/vim` | Editor mode moved to /config | refused: this implementation has no editor mode | refused |
| `/output-style` | Output style moved to /config | refused: this implementation has no output styles | refused |
| `/context` | Visualize current context usage as a colored grid | reports the context’s records and characters | implemented |
| `/diff` | View uncommitted changes and per-turn diffs | refused: this implementation has no diff panel | refused |
| `/memory` | Edit CLAUDE.md files and memory settings | refused: this implementation has no memory editor | refused |
| `/pause-memory` | Pause account memory and local auto-memory for this session (run again to turn both back on) | refused: this implementation has no account memory service | refused |
| `/help` | Show help and available commands | lists the registry: every command, its description and its argument hint | implemented |
| `/ide` | Manage IDE integrations and show status | refused: this implementation has no IDE integration client | refused |
| `/import` | Import config from another AI coding agent | refused: this implementation has no reader for another agent's configuration | refused |
| `/init` | Initialize a new CLAUDE.md file with codebase documentation | refused: this implementation has no built-in codebase-documentation prompt | refused |
| `/keybindings` | Open your keyboard shortcuts file | refused: this implementation has no keyboard-shortcuts file | refused |
| `/design-consent` | Grant PRRICODE agent access to your Design projects | refused: this implementation has no Design service | refused |
| `/design-revoke` | Revoke PRRICODE agent access to your Design projects | refused: this implementation has no Design service | refused |
| `/design-login` | Authorize design-system access for /design-sync with your claude.ai account | refused: this implementation has no Design service | refused |
| `/login` | Sign in with your Anthropic account | refused: this implementation has no account sign-in | refused |
| `/logout` | Sign out from your Anthropic account | refused: this implementation has no account sign-in | refused |
| `/install-github-app` | Set up PRRICODE GitHub Actions for a repository | refused: this implementation has no GitHub Actions installer | refused |
| `/install-slack-app` | Install the PRRICODE Slack app | refused: this implementation has no Slack app installer | refused |
| `/mcp` | Manage MCP servers | refused: this implementation has no MCP server manager | refused |
| `/mobile` | Show QR code to download the PRRICODE mobile app | refused: this implementation has no mobile client to pair with | refused |
| `/voice` | Toggle voice mode | refused: this implementation has no voice input | refused |
| `/powerup` | Discover PRRICODE features through quick interactive lessons | refused: this implementation has no interactive lessons | refused |
| `/release-notes` | View release notes | refused: this implementation has no release notes | refused |
| `/rename` | Rename the current conversation | refused: this implementation has no title for the conversation | refused |
| `/resume` | Resume a previous conversation | resumes a session by its id or by its exact title | implemented |
| `/setup-bedrock` | Reconfigure Amazon Bedrock authentication, region, or model pins | refused: this implementation has no Bedrock setup flow | refused |
| `/setup-vertex` | Reconfigure Google Vertex AI authentication, project, region, or model pins | refused: this implementation has no Vertex setup flow | refused |
| `/ultrareview` | Start a cloud agent that finds and verifies bugs in your branch | refused: this implementation has no cloud review agent | refused |
| `/session` | Show cloud session URL and QR code | refused: this implementation has no cloud session | refused |
| `/scroll-speed` | Adjust mouse wheel scroll speed | refused: this implementation has no terminal scroll-speed setting | refused |
| `/skills` | List available skills | lists the skills the session found | implemented |
| `/status` | Show PRRICODE status including version, model, account, API connectivity, and tool statuses | reports the version, the model, the working directory, the session and the provider connection | implemented |
| `/tasks` | View and manage everything running in the background | refused: this implementation has no background-task registry | refused |
| `/team-onboarding` | Help teammates ramp on PRRICODE with a guide from your usage | refused: this implementation has no built-in team-onboarding prompt | refused |
| `/teleport` | Send this session to the cloud, or resume one from claude.ai | refused: this implementation has no cloud session | refused |
| `/terminal-setup` | Check terminal setup (Shift+Enter is natively supported in <Terminal>) | refused: this implementation has no probe of the terminal's capabilities | refused |
| `/ultraplan` | Draft an editable plan in a cloud session | refused: this implementation has no cloud planning agent | refused |
| `/usage` | Show session cost, plan usage, and activity stats | reports the session’s activity: the records, the turns, the answers and the tool calls | implemented |
| `/skill-doctor` | Show which loaded skills are unused and costing context | lists the skills the session loaded | implemented |
| `/theme` | Change the theme | refused: this implementation has no theme picker | refused |
| `/tui` | Set the terminal UI renderer (default \| fullscreen) | refused: this implementation has no choice of terminal renderer | refused |
| `/permissions` | Manage allow and deny tool permission rules | refused: this implementation has no permission-rule editor | refused |
| `/plan` | Enable plan mode or view the current session plan | refused: this implementation has no session plan | refused |
| `/fast` | Toggle fast mode | refused: this implementation has no fast mode | refused |
| `/passes` | Share a free week of PRRICODE with friends | refused: this implementation has no referral programme | refused |
| `/privacy-settings` | View and update your privacy settings | refused: this implementation has no privacy-settings editor | refused |
| `/hooks` | View hook configurations for tool events | refused: this implementation has no view of the hook configuration | refused |
| `/loops` | List, create, and delete loops | refused: this implementation has no loop scheduler | refused |
| `/branch` | Create a branch of the current conversation at this point | refused: this implementation has no conversation branching | refused |
| `/fork` | Spawn a background agent that inherits the full conversation | refused: this implementation has no background sessions | refused |
| `/subtask` | Send a subagent off with your full context; its result comes back here | refused: this implementation has no hand-off to a subagent | refused |
| `/agents` | (removed) Ask PRRICODE to create/manage subagents, or edit .claude/agents/ | refused: this implementation has no editor for the subagent files | refused |
| `/plugin` | Manage PRRICODE plugins | refused: this implementation has no plugin and marketplace manager | refused |
| `/reload-plugins` | Activate pending plugin changes in the current session | refused: this implementation has no plugin registry | refused |
| `/reload-skills` | Pick up skills added or changed on disk during this session | refused: this implementation has no live skill registry | refused |
| `/rewind` | Restore the code and/or conversation to a previous point | refused: this implementation has no checkpoints | refused |
| `/heapdump` | Dump the JS heap to the Desktop; on Linux with no Desktop folder, the home directory | refused: this implementation has no heap dump | refused |
| `/version` | Show this session's version (autoupdate may have a newer one) | prints the version the session runs | implemented |
| `/sandbox` | sandbox disabled (⏎ to configure) | refused: this implementation has no sandbox configuration editor | refused |
| `/chrome` | Open PRRICODE in Chrome settings | refused: this implementation has no browser extension | refused |
| `/stickers` | Order PRRICODE stickers | refused: this implementation has no sticker catalogue | refused |
| `/radio` | Listen to PRRICODE FM lo-fi radio | refused: this implementation has no radio stream | refused |
| `/advisor` | Let PRRICODE consult a stronger model at key moments | refused: this implementation has no way to consult a stronger model | refused |
| `/exit` | Exit the CLI | refused: this implementation has no way to leave the session from inside it | refused |
| `/restart` | Restart PRRICODE and keep this session | refused: this implementation has no restart of the process | refused |
| `/export` | Export the current conversation to a file or clipboard | refused: this implementation has no export of the conversation | refused |
| `/model` | Set the AI model for PRRICODE | lists the models the catalog offers; with a model, sets the session’s model | implemented |
| `/remote-env` | Choose the default environment for cloud agents | refused: this implementation has no cloud environment | refused |
| `/__remote-workflow` | Run the workflow script delivered in this session environment (server-launched sessions only) | refused: this implementation has no server-launched workflow | refused |
| `/workflow-launch-exec` | Execute a server-launched workflow handoff (workflow_launch event sessions only) | refused: this implementation has no server-launched workflow | refused |
| `/upgrade` | Upgrade to Max for higher rate limits and more Opus | refused: this implementation has no subscription upgrade | refused |
| `/usage-credits` | Configure usage credits or request them from your admin when you hit a limit | refused: this implementation has no usage credits | refused |
| `/extra-usage` | Renamed to /usage-credits | refused: this implementation has no usage credits | refused |
| `/pro-trial-expired` | Options shown when the Pro plan PRRICODE trial has ended | refused: this implementation has no trial-expiry options | refused |
| `/rate-limit-options` | Manage usage limits and upgrade options | refused: this implementation has no rate-limit options | refused |
| `/low-priority` | Continue now at lower priority after reaching your session limit; run again to stop | refused: this implementation has no lower-priority queue | refused |
| `/limit-reset` | Reset your session limit now and keep working; once a week, still counts toward your weekly limit | refused: this implementation has no session-limit reset | refused |
| `/claim-credit` | Open the page of the offer shown at start-up | refused: this implementation has no credit offer | refused |
| `/statusline` | Set up PRRICODE's status line UI | refused: this implementation has no status-line setup agent | refused |
| `/effort` | Set effort level for model usage | refused: this implementation has no effort setting | refused |
| `/wellbeing` | Configure optional break reminders and quiet-hours nudges | refused: this implementation has no break reminders | refused |
| `/focus` | Toggle focus view: just your prompt, summary, and response | refused: this implementation has no focus view | refused |
| `/insights` | Generate a report analyzing your PRRICODE sessions | refused: this implementation has no built-in session-insights prompt | refused |
| `/provider` | (the target registers no such command) | runs the manager: the connections and their credential references | implemented (project extension) |
| `/catalog` | (the target registers no such command) | runs the catalog browser: the models of the connections | implemented (project extension) |

### The clone-choice labels this milestone adds

Every row of the table above is one of three things, and the label is the same everywhere the command surfaces:

| Label | What it means | Which commands |
|---|---|---|
| **implemented** | this implementation runs the command, and it does what the target's description says | the 12 of the target's below |
| **implemented (project extension)** | the command is this implementation's own — the target registers no such command — and it says so wherever it surfaces | `/provider`, `/catalog` |
| **refused** | this implementation does not run the command, and the refusal **names the capability** the command needs and does not have | the other 88 |

The refusal's wording is this implementation's own:

```
The '/<name>' command is not implemented here: this implementation has no <capability>.
```

A command that is refused is **not** silently dropped: it is in the registry, it is in the overlay, and typing it says what would have to exist for it to run.

### The commands this implementation runs

| Command | What the target says it does | What this implementation's version does |
|---|---|---|
| `/help` | Show help and available commands | lists the registry: every command, its description and its argument hint |
| `/version` | Print the version this session is running (not what autoupdate downloaded) | prints the version the session runs — this implementation has no autoupdate |
| `/model` | Set the AI model for PRRICODE | lists the models the catalog offers; with a model, sets the session's model |
| `/status` | Show PRRICODE status including version, model, account, API connectivity, and tool statuses | reports the version, the model, the working directory, the session and the provider connection, and says that the account and the connectivity probe are not shown |
| `/usage` (aliases `cost`, `stats`) | Show session cost, plan usage, and activity stats | reports the activity — the records, the turns, the answers, the tool calls — and says that the cost and the plan usage are not shown |
| `/context` | Show current context usage | reports the context's records and characters, and says that the token count is not measured |
| `/config` (alias `settings`) | Open settings | reports the settings tiers and the merged settings document; it does not **set** a key |
| `/skill-doctor` | Show which loaded skills are unused and costing context | lists the skills the session loaded, and says that the usage is not tracked |
| `/skills` | List available skills | lists the skills the session found |
| `/clear` (aliases `reset`, `new`) | Start a new session with empty context; previous session stays on disk (resumable with /resume) | starts a new session with an empty context; the previous one stays on disk. The target's optional session **name** is not kept: this implementation has no session-title store — the same store `/rename` needs |
| `/compact` | Free up context by summarizing the conversation so far | asks the model for a summary and marks the compaction boundary with it |
| `/resume` (alias `continue`) | Resume a previous conversation | resumes a session by its id or by its exact title |
| `/provider` | *(the target registers no such command)* | runs the manager: the connections and their credential references — **project extension** |
| `/catalog` | *(the target registers no such command)* | runs the catalog browser: the models of the connections — **project extension** |

### The commands this implementation refuses

Each of them needs a capability this implementation does not have. The capability is the third column of the big table above, and it is what the refusal names.

### The overlay

The composer's `/`-overlay lists the **registry's** commands: the target's overlay module (`chunk-v7h5cwqd.js`) and its command builder (`chunk-6bp7hdav.js`, `function SB`) both read the same registry the commands are dispatched from, and this implementation's overlay reads the registry the same way.

The rules the target's overlay follows, and this implementation's:

| Rule | The target | This implementation |
|---|---|---|
| the text must begin with a slash | yes | the same |
| a text that holds a space and does not end with one | completes the **argument**, not the command | the same — and this implementation has no argument completion, so the overlay is empty |
| the query | the text after the slash, lowercased and trimmed | the same |
| an empty query | every **visible** command | the same |
| a hidden command | not listed | the same |
| the row | `<pointer> <name> – <description>`, the separator an **en dash** | the same |
| the empty message | `No commands match "<text>"` | the same |

**Implementation choice.** The target filters with a fuzzy matcher and scores the results. This implementation matches the query against the command's name and its aliases, case-insensitively, and lists the matches in the registry's order. The rule and the shape are the target's; the matching is this implementation's own.

### What the target's product name is replaced by

The registry reproduces the target's **data** — the names, the descriptions, the aliases, the argument hints and the offsets. It does not reproduce the target's **product name**: where the target's own text names its product, this implementation says **PRRICODE**.

The target's *environment variables*, *model ids*, *API hosts* and *file names* keep the target's names, because those are the data the implementation has to speak to: `CLAUDE.md`, `.claude/`, `claude.ai`, `claude-sonnet-4-5` and the rest are unchanged.

## The output contracts (REA observed + implementation choice)

The **formats** are the target's; the **documents** are this implementation's.

| Format | What is written | Evidence class |
|---|---|---|
| `text` | the assistant's text, and nothing else; the text of a failed run goes to **stderr** | implementation choice (the format is REA observed) |
| `json` | **exactly one** JSON document: the result of the run, written even when the run failed | implementation choice (the format is REA observed) |
| `stream-json` | **one JSON object per event**, one per line | implementation choice (the format is REA observed) |

**A limitation, stated rather than hidden:** the runtime returns the turn's records **when the turn is over**, so the events are produced in one batch rather than one at a time. The `stream-json` format therefore writes one object per event, but it writes them when the turn ends.

## The exit codes

| Code | When |
|---|---|
| `0` | the run finished |
| `1` | the run failed — a provider error, a failed session lookup, an unimplemented option, a subcommand |
| `2` | the arguments were wrong |

## Conformance table

| Audit claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| `--flag=value` yields the value, and `--` ends the flag parsing | REA observed | F-01 | `tests/contracts/cli-surface.test.ts` — "reads the value of --flag=value", "ends the flag parsing at --" |
| A token is a flag when it has more than one character and starts with `-` | REA observed | F-01 | same file — "does not read a flag after --" |
| A short flag cluster is one token, and it is expanded only when every letter is known | REA observed + implementation choice (the widened pattern) | F-01 | same file — "treats a short flag cluster as one token", "expands a short flag cluster whose letters are all known flags" |
| The repeatable set is the audit's eleven names, and each consumes every following non-flag token | REA observed | F-01 | same file — "consumes every following non-flag token for a repeatable flag" |
| The optional value belongs to `-r`/`--resume`, and the **rest** of the boolean set is pure | REA observed (the flag) + **implementation choice** (the narrowing) | F-38 | same file — "keeps the optional value of --resume", "takes no value for --resume when the next token is a flag", "keeps the prompt out of a boolean flag" |
| The six subcommands are the target's, and a bare subcommand is a command when it comes first | REA observed (the names) + implementation choice (the placement) | F-01 | same file — "recognises the six subcommands" |
| The command tokens are commands, not flags | REA observed | F-38 | same file — "takes one prompt argument for -p", "takes -c as the short form of --continue" |
| The session-id pattern, and the scan of a path for such a segment | REA observed | F-38 | same file — "recognises the target’s session-id pattern", "scans a path for a session-id segment" |
| The cloud session ref and the URI arguments | REA observed | F-38 | same file — "knows the cloud session ref and the URI arguments" |
| The headless rule: `--print`, `--init-only`, `--sdk-url` or a non-TTY stdout | REA observed | F-02 | same file — "forces the headless mode when stdout is not a terminal", "forces the headless mode for --print, --init-only and --sdk-url" |
| The three output formats and the two input formats | REA observed | F-02 | same file — "accepts the three output formats" |
| The **fourteen** validation messages, verbatim | REA observed | F-38 | same file — the "the target's validation messages" block, one test per message |
| The `<mode>` placeholder's three rows, and which mode each decides | REA observed (the messages) + **implementation choice** (the reading) | F-38 | same file — "reproduces the mode and resume message", "reproduces the mode and --init-only message", "reproduces the mode and --session-id message", "reproduces the mode and stream-json output message" |
| The invalid output format's wording | **implementation choice** | F-38 | same file — "refuses an unknown output format" |
| The invalid permission mode's wording | **implementation choice** | F-38 | same file — "refuses an unknown permission mode" |
| `--help` and `--version` win wherever they appear | **implementation choice** | F-38 | same file — "writes the help whatever the order of the flags", "writes the version whatever the order of the flags" |
| An empty `--print=` is no value at all | **implementation choice** | F-38 | same file — "takes an empty --print= as no prompt at all" |
| The print mode takes one prompt argument, and `--continue` and `--resume` are mutually exclusive | implementation choice | F-38 | same file — "refuses a second prompt argument in print mode", "refuses --continue together with --resume" |
| Every option this implementation recognises and does not implement is **refused by the run** | **implementation choice** | F-38 | same file — the "the flags this implementation refuses" block |
| The stream-json input carries JSON documents, and the model receives their **text** | **implementation choice** | F-02 | same file — "reads the text the documents carry", "runs the turn with the text the documents carry, not the raw blob", "refuses a line that is not JSON" |
| The exit codes are `0`, `1` and `2` | REA observed (the two the audit names) + implementation choice (the names) | F-38 | same file — "returns the argument error’s exit code and writes the message to stderr" |
| The `--settings` file is loaded as the highest-precedence overlay | **implementation choice** | F-38 | same file — "loads the settings file the --settings flag names", "refuses a settings file it cannot read" |
| The start mode: the flag, the settings' default, and the three availability overrides | REA observed (the rules) + implementation choice (the wiring) | F-38 | same file — "starts in the mode the --permission-mode flag names", "does not start in auto mode when a policy disables it", "does not start in auto mode for a HIPAA-configured session" |
| The in-session slash-command registry: the names, the descriptions, the aliases, the argument hints and the offsets | REA observed | F-38 | same file — the "the slash-command registry" block, and the "the autocomplete overlay" block |
| The manager surfaces are reachable from the command line | **project extension** | F-40 | same file — "runs the multi-provider manager and returns its exit code" — and [`provider-catalog.md`](provider-catalog.md) |
