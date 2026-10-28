# Deep research: the target's latest state (2026)

**Topic:** The target's (reference build 2.1.312) latest release state as of 2026-10-28 — architecture, UI, tool set, commands/flags, providers/models, permissions/sandbox/settings, new features, and changelog/community sentiment.

**Depth:** deep. **Sources:** 8 parallel research subagents, each 6+ searches and 5+ full fetches; adversarial verification folded into the open-questions section.

**Naming note:** This repository's standing rule forbids third-party product/company names, so the target is referred to as "the target" throughout; model ids, hosts, env vars and config keys keep their target-defined names (data, not names).

---

## Executive summary

The target's latest published version is **2.1.312** (released 2026-10-27), nine releases ahead of the pinned 2.1.303 this repository clones. The 2026 trajectory moves the target from a Node/npm-distributed CLI to a **standalone native binary** with background auto-update, from a coding assistant to a persistent "environment for operating agents" (cloud sessions, scheduled tasks, agent teams, MCP channels, artifacts, computer use), and from a single vendor API to a multi-provider surface (Bedrock, Vertex/Agent Platform, Foundry, Mantle, CPAWS, LLM gateways, named profiles/OIDC). The UI gained a fullscreen renderer, a model picker with effort levels, an interactive `/permissions` panel, `/diff` side panel, `/rewind` checkpoints, output styles, and a customizable status line. The tool set grew to ~60 built-ins including browser (Chrome extension/native host), WebSearch, LSP, cron/scheduler, worktree, agent teams, MCP resources, Monitor, and native clipboard/audio support. Permission/sandbox systems are substantially more elaborate than the pinned build's surface (auto mode with a classifier, credentials deny/mask with proxy substitution, managed-settings enforcement). Community sentiment is mixed: enthusiasm for capability growth alongside complaints about regressions, quality variance, and naming/version confusion.

---

## 1. Architecture and release state

- Latest version **2.1.312** (npm `@anthropic-ai/reference-agent`), published 2026-10-27; 552 versions total.
- CLI entry `agent`; package built in TypeScript, compiled/run via Bun; entrypoint `src/entrypoints/cli.tsx` (fast-path bootstrap).
- TUI: React Ink (custom reconciler + Yoga flexbox), double-buffered ANSI diff rendering; `src/ink/` (reconciler.ts, layout/, termio/); ~144 UI component files.
- Agent loop: `QueryEngine` singleton owning `mutableMessages`; async-generator loop with 7 continue sites (streaming tokens via `yield`, tool_use → permission check → execute → append tool_result → continue, end_turn breaks).
- Distribution: standalone native binary now recommended (vendor installer script → `~/.local/bin/agent`, auto-updates, no Node); npm method deprecated as of v2.1.15 (Jan 21, 2026) but package still published; also winget.
- Five architecture layers: Entrypoints → Runtime → Engine → Tools & Caps → Infrastructure; Bridge layer abstracts transport so the engine is frontend-agnostic.
- Tools: ~43–60 built-in tools (Bash, FileRead/Edit/Write, Glob, Grep, WebFetch/Search, Agent, MCP, tasks, teams, plan mode, worktree, cron, LSP, PowerShell, etc.).
- Multi-agent: Agent sources (BuiltIn/Custom/Plugin), 7 task isolation types (InProcessTeammate via AsyncLocalStorage, LocalAgent, RemoteAgent/CCR, LocalShell, Dream, Workflow, MonitorMcp), file-based Team mailboxes.
- Memory: 4-type taxonomy (User/Feedback/Project/Reference), `~/.claude/projects/<slug>/memory/MEMORY.md` index (200-line cap) + topic files, Dream background consolidation.
- Context compression: 4 tiers — autoCompact, apiMicrocompact (API context_management), reactiveCompact (on context-too-large error), snip (emergency).
- Permissions/security: 3 modes (ask/bubble/allow), PreToolUse/PostToolUse hooks, platform sandbox (macOS sandbox-exec, Linux namespaces, Windows restricted).
- Plugins/skills: plugin manifest (commands/agents/skills/hooks/mcpServers/lspServers/userConfig), marketplace registries (GitHub/npm/URL/local), skill Markdown with YAML frontmatter and `paths` progressive disclosure.
- Unreleased feature flags: KAIROS (long-term assistant + autoDream), VOICE_MODE, WORKFLOW_SCRIPTS, PROACTIVE, DAEMON.
- Source exposure: v2.1.88 npm package shipped a 59.8 MB source map (March 30–31, 2026), exposing ~512K lines / ~1,884–2,000 TS files; takedowns followed.

## 2. Terminal UI

- Built-in theme presets: `auto`, `dark`, `light`, `dark-daltonized`, `light-daltonized`, `dark-ansi`, `light-ansi` (60+ color values each). Brand accent orange `rgb(215,119,87)`; daltonized swaps red/green for blue/yellow. Custom themes as JSON in `~/.claude/themes/` with `name`, `base`, `overrides`; tokens include `claude`, `text`, `permission`, `planMode`, `diffAdded`, `diffRemoved`, shimmer pairs, and `<color>_FOR_SUBAGENTS_ONLY` / `rainbow_*`. Auto mode detects dark/light via `$COLORFGBG` or OSC 11.
- Spinner frames (third-party tweakcc): `['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']`; verbs customizable (e.g. "Cerebrating…").
- Welcome screen: `✻Welcome to [the target]!` plus model name with effort level; grayed prompt suggestion from git history.
- Glyphs: `✕` close, `✦ Heads up` note, `↑ N more`/`↓ N more`, `Jump to bottom`, `PR #N`/`MR !N`.
- Two renderers: classic (conversation in scrollback; `/diff` opens a bordered dialog above prompt) and fullscreen (alternate screen buffer, input box fixed at bottom, only visible messages rendered, mouse support, auto-follow with `Jump to bottom`, scroll shortcuts, transcript mode via `Ctrl+O` with search).
- Composer: Enter submits; newline via `Ctrl+J`, `\`+Enter, Shift+Enter; supports `/` commands, `!` shell mode, `@` file mentions, `:` emoji shortcodes, collapsed pastes, prompt suggestions, vim mode, spellcheck underline, stash (`Ctrl+S`).
- Approval dialogs: `permission` color borders; Shift+Tab cycles modes; Tab adds a comment; Esc declines; Left/Right cycles dialog tabs; plan approval via `Ctrl+G` external editor; file permission prompt offers session-wide allow.
- Keybindings: extensive documented table (general controls, text editing, vim NORMAL/VISUAL motions, transcript viewer keys, queueing).
- Markdown: code blocks with syntax highlighting (toggle via `Ctrl+T` in `/theme` picker); `/btw` overlay copies raw Markdown.
- Model picker: `/model` opens picker; effort control in same menu; effort levels low/medium/high/xhigh/max (model-dependent); "More models" for full list.
- `/help`: command menu filters as you type; since v2.1.307 shows short descriptions for bundled skills.
- `/diff`: fullscreen → side panel beside conversation (files list with +/- counts, source picker T1/T2/Current); classic → bordered dialog.
- Empty states: not explicitly documented; inferred (task list collapsed until tasks exist, prompt suggestions only after first response, diff panel collapses pre-session changes).

## 3. Tool set (~60 built-ins)

Authoritative list from the official tools reference: `Agent`, `Artifact`, `AskUserQuestion`, `Bash`, `CronCreate`, `CronDelete`, `CronList`, `Edit`, `EndConversation`, `EnterPlanMode`, `EnterWorktree`, `ExitPlanMode`, `ExitWorktree`, `Glob`, `Grep`, `ListAgents`, `ListMcpResourcesTool`, `LSP`, `Monitor`, `NotebookEdit`, `PowerShell`, `PushNotification`, `Read`, `ReadMcpResourceTool`, `RemoteTrigger`, `ReportFindings`, `ScheduleWakeup`, `SendFeedback`, `SendMessage`, `SendUserFile`, `ShareOnboardingGuide`, `Skill`, `SubagentHandback`, `TaskCreate/Get/List/Output/Stop/Update`, `TodoWrite`, `ToolSearch`, `WaitForMcpServers`, `WebFetch`, `WebSearch`, `Workflow`, `Write`.

- **Browser (Chrome):** browser extension (v1.0.36+) over a native messaging host; launch with `--chrome` or `/chrome`; supported browsers Chrome/Edge/other Chromium (Brave, Arc, Vivaldi, Opera); not WSL; requires direct plan. Capabilities: live debugging, design verification, web app testing, authenticated apps, data extraction, form automation, file uploads (≤10 MB), GIF recording, screenshots. Browser actions exposed as MCP tools under `claude-in-chrome` server.
- **WebSearch:** vendor backend; titles/URLs only; up to 8 backend searches per call; `allowed_domains`/`blocked_domains`; permission rule takes no specifier; session limit 200 calls (refill ~100/hour, v2.1.290+); `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`; `/clear` resets. Available on vendor API, CPAWS, Foundry; Vertex (Opus 4/Sonnet 4/Haiku 4.5+); not Bedrock.
- **LSP:** go-to-definition, find references, type info, symbols, implementations, call hierarchies; auto-reports type errors after edits. Inactive until a code intelligence plugin + binary installed; not started in cloud sessions.
- **Scheduler/cron:** `CronCreate/List/Delete`, `/loop`, `ScheduleWakeup`, `RemoteTrigger`; session-scoped, restored on resume/continue (except expired); up to 50 tasks; 7-day expiry; jitter; disable via `CLAUDE_CODE_DISABLE_CRON=1`.
- **Worktree:** `EnterWorktree/ExitWorktree`, `--worktree` flag, `.worktreeinclude`, subagent isolation, non-git VCS via hooks.
- **Agent teams:** experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; lead + teammates; `Agent` with `name`, `SendMessage`, `ListAgents`; `/list-agents` (alias `/peers`); requires v2.1.224+.
- **MCP resources:** `ListMcpResourcesTool`, `ReadMcpResourceTool`; `ToolSearch` discovers deferred MCP tools; `WaitForMcpServers`. Deferral activates when MCP tool definitions exceed ~10K tokens.
- **Memory:** `CLAUDE.md`/`AGENTS.md` + auto memory; loaded at session start; treated as context.
- **Monitor:** background command streaming each output line; WebSocket support; deadlines 5 min default / 30 min max / 10 min non-interactive.
- **Native clipboard/audio:** voice dictation uses built-in native audio module (macOS/Linux/Windows; Linux falls back to arecord/rec); `/copy [N]` copies assistant response; musl-built binaries so clipboard/audio-capture add-ons load on affected Linux (version not confirmed). Computer Use (macOS, research preview) can request clipboard access.
- **Version-gated tools:** `Task*`/`TodoWrite` default only on older models unless opted in; `EndConversation` only on Opus 4.8/Sonnet 5/Fable 5+ in interactive terminal; `TaskOutput` removed in v2.1.277 (use `Read` on output file); `Glob`/`Grep` absent by default on macOS/Linux/WSL.

## 4. Slash commands and CLI flags

- ~90+ built-in slash commands (official docs authoritative; third-party lists are smaller/stale).
- Key commands: `/permissions` (alias `/allowed-tools`) opens interactive dialog, applicable mid-turn since v2.1.234; `/help` shows short descriptions since v2.1.307; `/diff` fullscreen side panel since v2.1.260; `/rewind` (aliases `/checkpoint`, `/undo`) with Restore code/conversation/both, Summarize from here/up to here; `/resume` (alias `/continue`) with background-session attach since v2.1.285; command palette highlighting rules since v2.1.236.
- Removed/changed: `/pr-comments` removed v2.1.91; `/vim` removed v2.1.92 (use `/config`); `/ultraplan` removed v2.1.222; `/ultrareview` now alias of `/code-review ultra`; `/review` alias of `/code-review`; `/agents` wizard removed v2.1.198; `/output-style` removed then re-added; `/extra-usage` renamed to `/usage-credits`; `/cost` and `/stats` aliases of `/usage`; `/fork` and `/subtask` swapped roles v2.1.212.
- CLI subcommands: `agent`, `agent "query"`, `agent -p`, `agent -c/--continue`, `agent -r/--resume`, `agent update`, `agent gateway`, `agent install`, `agent auth login/logout/status`, `agent agents`, `agent attach`, `agent auto-mode defaults/config/reset`, `agent daemon logs/run/status/stop`, `agent doctor`, `agent import`, `agent logs`, `agent mcp` (+ login/logout), `agent plugin` (alias plugins), `agent purge`, `agent remote-control`, `agent respawn`, `agent rm`, `agent self-hosted-runner`, `agent setup-token`, `agent stop` (alias kill), `agent ultrareview`.
- CLI flags: extensive list including `--add-dir`, `--advisor`, `--agent(s)`, `--allow-dangerously-skip-permissions`, `--allowedTools`, `--append-system-prompt(-file)`, `--append-subagent-system-prompt(-file)`, `--autocompact`, `--ax-screen-reader`, `--bare`, `--betas`, `--bg/--background`, `--channels`, `--chrome/--no-chrome`, `--cloud/--remote` (deprecated), `--continue/-c`, `--dangerously-load-development-channels`, `--dangerously-skip-permissions`, `--debug/--debug-file`, `--desktop`, `--disable-slash-commands`, `--disallowedTools`, `--effort`, `--environment`, `--exclude-dynamic-system-prompt-sections`, `--exec`, `--fallback-model`, `--fork-session`, `--forward-subagent-text`, `--from-pr`, `--ide`, `--init/--init-only`, `--include-hook-events`, `--include-partial-messages`, `--input-format`, `--json-schema`, `--maintenance`, `--max-budget-usd`, `--max-turns`, `--mcp-config`, `--model`, `--name/-n`, `--no-session-persistence`, `--output-format`, `--permission-mode`, `--permission-prompt-tool`, `--permission-prompts`, `--plugin-dir`, `--plugin-url`, `--print/-p`, `--prompt-suggestions`, `--ref`, `--remote-control/--rc`, `--remote-control-session-name-prefix`, `--replay-user-messages`, `--restricted`, `--resume/-r`, `--safe-mode`, `--session-id`, `--setting-sources`, `--settings`, `--strict-mcp-config`, `--system-prompt(-file)/--system-prompt-snapshot`, `--teleport`, `--teammate-mode`, `--tmux`, `--tools`, `--verbose`, `--version/-v`, `--worktree/-w`.
- System prompt flags behavior (v2.1.257+): by default the system prompt is recorded on the conversation's first request and reused on resume/continue until compaction; `--system-prompt-snapshot off` rebuilds every request.

## 5. Providers and models

- Providers: first-party vendor (subscription, Console) plus Amazon Bedrock, Google Cloud's Agent Platform (Vertex), Microsoft Foundry, vendor platform on AWS, enterprise apps gateway (self-hosted IdP front-end), and LLM gateways/proxies via `ANTHROPIC_BASE_URL`.
- Provider selection is env-flag driven: `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE`. A gateway session outranks the cloud flags.
- Mantle: `CLAUDE_CODE_USE_MANTLE=1`, `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`, `CLAUDE_CODE_SKIP_MANTLE_AUTH`; model IDs use `anthropic.` prefix without version suffix (e.g. `anthropic.claude-sonnet-5`); can run alongside Invoke API; gateway routing supported.
- Routing by model ID: Mantle routing by prefix; `modelOverrides` maps vendor model IDs to provider-specific strings (Bedrock ARNs, Vertex version names, Foundry deployment names); `ANTHROPIC_DEFAULT_*_MODEL` pins per family.
- Auth flows: first-party (browser OAuth via vendor portal, Console login with/without API key v2.1.242+, `setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` 1-year for CI); cloud providers (Bedrock AWS SDK chain/SSO/console creds/Bedrock API key `AWS_BEARER_TOKEN_BEDROCK`, `awsAuthRefresh`/`awsCredentialExport`; Vertex ADC/service account/`gcpAuthRefresh`/X.509 WIF; Foundry API key/Entra ID default chain/bearer token `ANTHROPIC_FOUNDRY_AUTH_TOKEN`); gateway (IdP sign-in, gateway token sole credential, `/login` with corporate SSO); named profiles/OIDC federation (named profiles under `~/.config/anthropic` or `%APPDATA%\Anthropic`; modes `oidc_federation` WIF or `user_oauth`).
- Auth precedence (highest first): gateway session; cloud provider flags; `ANTHROPIC_AUTH_TOKEN`; `ANTHROPIC_API_KEY`; `apiKeyHelper`; `CLAUDE_CODE_OAUTH_TOKEN`; named profile/federation; subscription OAuth. Managed `forceLoginMethod: "gateway"` can restrict to gateway only.
- Org/host/device controls: `forceLoginMethod` (`claudeai`/`console`/`gateway`), `forceLoginOrgUUID`, `allowedProviders`, `availableModels`, `deniedModels`, `availableModelsMatch`, `enforceAvailableModels`, org default model, org effort limits, org model restrictions (Enterprise, per-role). Delivery via managed settings/MDM/server-managed settings; sessions on third-party providers don't receive server-managed settings.
- Multiple accounts via `CLAUDE_CONFIG_DIR`.
- Credential storage: macOS encrypted Keychain (fallback `~/.claude/.credentials.json` mode 0600 in SSH/locked sessions); Linux `~/.claude/.credentials.json` mode 0600; Windows `%USERPROFILE%\.claude\.credentials.json` with profile ACLs; `CLAUDE_CONFIG_DIR` relocates and keys Keychain entry. Credential types: vendor portal, vendor API, Foundry Auth, Bedrock Auth, Vertex Auth, profile & WIF, gateway session tokens. `apiKeyHelper` custom script with refresh intervals. MCP OAuth tokens in system keychain (macOS) or credentials file; client secret stored securely, not in config.
- Model catalog/picker: model setting accepts alias or full model name (API full name; Bedrock inference profile ARN; Foundry deployment name; Vertex version name). Aliases: `default`, `best`, `fable`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`. `/model` picker: Enter saves default, `s` session-only. Prices shown only on API/gateway. Custom model option via `ANTHROPIC_CUSTOM_MODEL_OPTION` (+ name/description); `modelPicker` lineup; gateway model discovery via `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`. Pinning via `ANTHROPIC_DEFAULT_FABLE/OPUS/SONNET/HAIKU_MODEL`, `modelOverrides`, per-pinned-model display/capability env vars. Allowlist: `availableModels`, `deniedModels`, `availableModelsMatch` (`exact`), `enforceAvailableModels`. Context: 1M default for Fable/Sonnet 5+/Opus 4.7+ on all providers; `[1m]` suffix for Opus/Sonnet 4.6; `CLAUDE_CODE_DISABLE_1M_CONTEXT`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.
- MCP auth: OAuth 2.0 for remote HTTP/SSE servers (dynamic client registration, CIMD auto-discovery, pre-configured `--client-id`/`--client-secret` with `--callback-port`, `authServerMetadataUrl` override); tokens stored securely, auto-refresh; HTTPS/localhost token endpoints only; `agent mcp login`/`logout`; `/mcp` panel.
- Fallback: `--fallback-model`/`fallbackModel` setting, max 3 after dedup, drops out-of-allowlist and smaller-context-window entries during compaction. Automatic safety-classifier fallback (Fable/Opus 5.5/Sonnet 5.5/Opus 5 → Opus 5/Opus 4.8) for cybersecurity/biology. `opusplan` hybrid; tier availability fallback on Bedrock/Vertex when model disabled mid-session.

## 6. Permissions, sandbox, settings, output styles, status line, checkpoints

**Permissions:**
- Tiered by tool type: Read-only (no prompt in working dirs), Bash (prompt except built-in read-only commands), File modification (prompt, lasts session), WebFetch (prompt except preapproved domains), WebSearch (prompt).
- Modes: `default`/`manual`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. `auto` uses a background classifier.
- Rule evaluation order: **deny → ask → allow**, first match wins; specificity does not override order.
- Rule syntax: `Tool` or `Tool(specifier)`. Bash wildcards with compound-command awareness and wrapper stripping (timeout/time/nice/nohup/stdbuf/command/builtin/noglob, plus safe env-var assignments, bare xargs). Read/Edit use gitignore-style path patterns with anchors `//` (fs root), `~/` (home), `/` (settings source), relative. WebFetch uses `domain:`. MCP uses `mcp__server__tool`. Agent uses `Agent(name)`. Cd rules exist.
- Parameter matching for deny/ask: `Tool(param:value)` with `*` wildcard; cannot match primary content fields (command/file_path/path/url) — ignored with startup warning.
- Working directories: `--add-dir`, `/add-dir`, `additionalDirectories`; network paths (UNC, /net) special-cased.
- Symlink handling: allow requires both requested and resolved path match; deny applies if either matches.
- Redirections and `tee` targets checked against file rules.
- Auto mode classifier: built-in allow/deny/soft_deny; `autoMode` setting adds prose rules; `classifyAllShell` (v2.1.193+) routes all shell through classifier.
- Mods (plugins) `tool.check` can approve after hooks, subject to managed-settings/Team/Enterprise login gates.
- Hooks: PreToolUse can deny/allow/ask; blocking hook (exit 2) takes precedence over allow rules.
- Managed: `allowManagedPermissionRulesOnly`, `disableBypassPermissionsMode`, `disableAutoMode`. Settings precedence: managed highest; deny at any scope blocks across scopes.

**Sandbox (native helper / seccomp):**
- OS enforcement: macOS Seatbelt; Linux/WSL2 bubblewrap + socat. Native Windows unsandboxed (use WSL2). Built on `@anthropic-ai/sandbox-runtime`.
- Optional seccomp filter (Unix domain socket blocking) via `npm install -g @anthropic-ai/sandbox-runtime`; Dependencies tab in `/sandbox` shows missing pieces.
- Covers Bash/PowerShell/Monitor commands + children. File tools, MCP servers, hooks, LSP, status line command run outside sandbox.
- Default access: writes to working dir + per-user temp + added dirs (protected paths still denied); reads most of machine (incl. credentials); network via proxy with empty allowlist; env inherited.
- Settings: `sandbox.enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, `excludedCommands`, `allowUnsandboxedCommands`, `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `allowNestedUserNamespaces`, `bwrapPath`, `socatPath`, `ignoreViolations`, `ripgrep`, plus `filesystem` (allowWrite/denyWrite/denyRead/allowRead/disabled/allowManagedReadPathsOnly), `network` (allowedDomains/deniedDomains/allowUnixSockets/allowLocalBinding/allowAllUnixSockets/httpProxyPort/socksProxyPort/tlsTerminate/strictAllowlist/allowManagedDomainsOnly), `credentials` (files/envVars with deny/mask, awsPairs, sigv4, extract/decode/maskClaims).
- Modes: auto-allow (sandboxed commands auto-approved) vs regular permissions. Strict sandbox mode disables unsandboxed retry.
- Credentials: deny (file read blocked, env unset) or mask (sentinel + proxy substitution, requires tlsTerminate + allowed destination + trusted scope). AWS SigV4 re-sign (v2.1.221+). macOS file masking degrades to deny.
- Filesystem isolation can be disabled (`filesystem.disabled`) keeping network isolation; only user/managed/--settings can set it; locked when managed configures filesystem or credential deny entries.
- Protected paths (settings files, skills, agents, hooks, .mcp.json, shell rc, .git hooks/config, bare-repo sentinels, ~/.claude contents) denied even inside writable dirs; symlink-aware.
- Network: proxy checks hostname; tools ignoring proxy vars can't connect; UDP/QUIC/ICMP blocked; local-address resolution check; per-command allowed domains in auto mode (v2.1.271+); IPv6 bracketed form (v2.1.229+); strictAllowlist (v2.1.219+).
- Managed enforcement: admin-required sandbox when `allowUnsandboxedCommands:false` or `allowManagedDomainsOnly:true` in managed; repository settings ignored for loosening keys; locks without admin-required sandbox (deniedDomains/strictAllowlist/filesystem denyRead).
- Custom proxy ports; corporate proxy via HTTPS_PROXY.

**Settings schema:**
- 247 settings keys across topics. Files: managed (MDM/server-managed), user `~/.claude/settings.json`, project `.claude/settings.json`, local `.claude/settings.local.json`, global config `~/.claude.json`.
- Scopes labeled Any file / User / Project / Local / Managed / Global config.
- Precedence: managed highest; user/project/local/--settings below; command-line args can add restrictions but not override managed deny.
- Arrays (sandbox filesystem, credentials deny) merge across scopes; Booleans: managed overrides; some keys "hold" (e.g., user `false` holds against project `true` for allowUnsandboxedCommands since v2.1.285).
- Managed-only keys: `allowManagedPermissionRulesOnly`, `allowManagedMcpServersOnly`, `allowManagedHooksOnly`, `allowManagedReadPathsOnly`, `allowManagedDomainsOnly`.
- Permission keys: `permissions.allow/ask/deny/additionalDirectories/blockReadsOutsideWorkingDirectories/defaultMode/disableBypassPermissionsMode`, plus top-level `disableAutoMode`, `autoMode`, `skipAutoPermissionPrompt`, `skipDangerousModePermissionPrompt`, `useAutoModeDuringPlan`.
- Settings edits take effect mid-session for some keys (sandbox lists).

**Output styles:**
- 4 built-in beyond default: Proactive, Concise, Explanatory, Learning. Default = no style instructions.
- Custom: Markdown files in `~/.claude/output-styles/`, `.claude/output-styles/` (nested discovery, closest wins), managed dir, plugins `output-styles/`. Frontmatter: `name`, `description`, `keep-coding-instructions` (default false), `force-for-plugin` (plugin only).
- `outputStyle` setting key (case-sensitive built-in names). Switch via `/output-style`, `/config` menu, VS Code (v2.1.257+), desktop via settings file (v2.1.261+ create in VS Code).
- Applies to main conversation + forks; subagents use own prompt. Full system prompt keeps coding instructions section unless keep-coding-instructions true (requires `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0` for full prompt).
- Built-in style version gates: Concise requires v2.1.237; switching mid-session applies next message (v2.1.251+; before, needed /clear).

**Status line:**
- `statusLine` setting: `{type:"command", command, padding, refreshInterval, hideVimModeIndicator}`. `subagentStatusLine` for agent panel rows.
- Script receives JSON on stdin (model, workspace, cost, context_window, rate_limits, prompt_cache, session_id/name, pr, worktree, vim, agent, output_style, etc.); prints stdout. Updates on events (new assistant message, /compact, permission mode change, vim toggle, command change, refreshInterval, rate-limit/prompt-cache expiry). 300ms debounce; command change skips debounce.
- Trust required; `disableAllHooks`/`allowManagedHooksOnly` gates; runs outside sandbox.
- Fields may be absent/null; examples provided in docs.

**Checkpoints:**
- Automatic tracking: every prompt starting a turn creates checkpoint; 100 most recent kept; snapshots saved with conversation; retention sweep ~30 days (`cleanupPeriodDays`).
- `/rewind` or double Esc: restore code & conversation / conversation only / code only / summarize from here / summarize up to here / never mind. Summarize compresses context; original messages remain in transcript.
- Limitations: Bash-only changes not tracked unless file already edited by the agent; subagent edits usually not restored (foreground forked skill exception); external/concurrent changes not tracked; mid-turn messages marked No code restore; symlinked/hard-linked paths skipped with warning; not a VCS replacement.

## 7. New/advanced features

- **Agent teams:** experimental, disabled by default; enable with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. One session acts as lead; teammates are independent full sessions with own context windows, shared task list, and direct mailbox messaging. Display modes in-process or split panes (tmux or iTerm2 with `it2`); `teammateMode` can be `in-process`, `auto`, `tmux`, or `iterm2`; CLI flag `--teammate-mode` is experimental and not in `--help`. Model selection follows prompt-named model, subagent definition model, `CLAUDE_CODE_SUBAGENT_MODEL`, then lead model, with force override via `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`.
- **MCP channels (inbound):** research preview; an MCP server pushes events into a running session, with two-way replies through the same channel; events only arrive while the session is open. Supported channels: Telegram, Discord, iMessage, plus fakechat demo; requires Bun; enabled via `--channels plugin:<name>@official-plugins`; Team/Enterprise organizations must enable channels in managed settings.
- **IDE integration:** official docs cover VS Code extension as recommended. JetBrains IDEs supported via dedicated plugin (IntelliJ IDEA, PyCharm, Android Studio, WebStorm, PhpStorm, GoLand) with diff viewing, selection context, file references, diagnostics. Zed not described as supporting the native IDE integration protocol in official docs; community discussion describes Zed as supporting the target as an ACP agent but not the native protocol.
- **Checkpoints/rewind:** automatic file snapshots before each turn; 100 most recent checkpoints retained; snapshots retained with conversation and cleaned up after ~30 days by default. `/rewind` or double Esc opens restore menu. Limitations: Bash-only changes not tracked; most subagent edits not restored (foreground forked skill exception); symlink/hard-link paths skipped; external/manual changes not tracked.
- **Cost & usage accounting:** `/usage` shows session token usage and estimated cost computed locally from token counts at list price, with prompt-cache statistics, plan usage bars, attribution, recommendations, loops, and usage-credits row. Cost resets on `/clear`; data-residency 1.1x multiplier applies; status line exposes `cost.total_cost_usd`; enterprise spend reports and CSV export available.
- **Output styles:** four built-in styles beyond default: Proactive, Concise, Explanatory, Learning. Custom styles are Markdown files with frontmatter under `~/.claude/output-styles`, `.claude/output-styles`, or managed policy directory; plugins can ship them. Switch with `/output-style`, `/config`, or settings `outputStyle`; `keep-coding-instructions` controls retention of software-engineering instructions.
- **Status line:** customizable bar running a shell command receiving JSON on stdin; configured via `statusLine` in settings or `/statusline`; supports multi-line output, colors, links, `refreshInterval`, padding, `hideVimModeIndicator`; exposes model, workspace, cost, duration, context window, git/worktree/repo, prompt-cache fields.
- **Prompt management:** system prompt can be replaced or appended via `--system-prompt`, `--append-system-prompt`, `--append-system-prompt-file`; output styles provide persistent personas; CLAUDE.md provides project knowledge.
- **Plugin/marketplace protocol:** a marketplace is a directory/repository with `.claude-plugin/marketplace.json`; plugins are installed units containing skills, agents, hooks, MCP servers, commands, and optional output styles; official marketplace added by default in interactive sessions; install scopes and `/plugin` commands manage lifecycle. Channels are also installed as plugins.
- **Autoupdater:** native installer updates in background; `agent update` manual; disable with `DISABLE_AUTOUPDATER=1` or `autoUpdates: false`, but user reports/issues indicate native installs may set `autoUpdatesProtectedForNative: true`, making `autoUpdates: false` ineffective, while `DISABLE_UPDATES=1` works in v2.1.118+. `FORCE_AUTOUPDATE_PLUGINS=1` can keep plugin updates enabled when auto-updates are disabled.
- **Self-hosted runner:** `agent self-hosted-runner` turns own machines/containers into compute for sessions; available to Team and Enterprise in public beta; includes guided setup, Docker image build, and Prometheus metrics; keeps code/secrets on customer infrastructure.

## 8. Changelog and community sentiment (2026)

- Latest version **2.1.312** (released 2026-10-27); 481 curated updates tracked by Releasebot.
- Recent release highlights (2.1.307–2.1.312): cloud sessions routine editing, Bash editor with colors/line numbers/Copy, effort level in model picker, self-hosted runner idle-session retention and checkout-hook 30-min default, Slack skills analytics and retry notices, Code Review outdated-commit fixes and `@agent review stop/off/pause`, VS Code syntax coloring and long-prompt folding, Monitor tool + plugin monitors on Bedrock/Vertex/Foundry, `--bare`, `--channels` permission relay, `--trust-workspace` for `agent ultrareview`, sed -i runs as written, `DISABLE_COMPACT` can only turn compaction off, `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT`/`CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK` toggles, OpenTelemetry `claude_code.safety_event` added in 2.1.307 then removed in 2.1.312, sandbox/worktree/profile-store/MCP-config security fixes.
- Model family evolution 2026: Feb Opus 4.6/Sonnet 4.6 (1M context beta); Apr Opus 4.7; May Opus 4.8; Jun Sonnet 5, Fable 5/Mythos 5 (suspended Jun 12, restored Jul 1); Jul Opus 5, HIPAA self-serve; Sep Fable 5.1/Mythos 5.1 (Sep 1), Opus 5.5 (Sep 22), Sonnet 5.5 (Sep 28); Oct Haiku 5.5 (Oct 7), Duet proactive agent research preview (Oct 21, Pro/Max). "ultrathink" raises effort to xhigh on Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1.
- Major capability themes: computer use (Mar 23, Pro/Max), auto mode (input prompt-injection probe + output transcript classifier), remote control/mobile continuity, scheduled tasks on vendor-managed cloud infra, interactive artifacts/charts/diagrams, Cowork (GA Apr 2026 on macOS/Windows), Slack delegation (Jun 2026), Code Review (Mar 2026), Monitor tool, agent teams, artifacts.
- Deprecations: Opus 4 and 4.1 removed from model selector (Jan 16, 2026); fast mode deprecated for Opus 4.6 (~30 days after launch); two API models deprecated June 15, 2026 (errors after that date); `claude_code.safety_event` OTel event added 2.1.307 then stopped 2.1.312.
- Breaking changes (API/platform): API version 2026-10-21 removes `temperature`/`top_p`/`top_k` (400), errors on `document` blocks in assistant messages, Admin/Analytics API field renames, RBAC groups return `role_ids`/`rbac_group_id`, API keys lose `workspace_id` for `scope`; Bedrock 2026-10-21 only works with target 4.7+ models. New SDK majors (TS 1.0, Python 2.0, Go 2.x) send 2026-10-21 by default; old SDKs keep 2023-06-01. Target 2.1.307 added `/agent-api api-version` to migrate code.
- Roadmap signals: sustained/long-running agent workflows (scientific computing guide recommends root CLAUDE.md, CHANGELOG.md as working memory, tmux for multi-day sessions); phone-based continuity; cloud auto-fix of PRs/CI; Duet proactive agent (research preview); artifacts as reviewable interfaces; shift from "coding assistant" to "environment for operating agents."
- Community sentiment: Reddit complaints that regressions with each release test users' patience; users report ~10% quality degradation during Sep 2026 elevated-error incidents; changelog-display parsing failures on 2.1.0. Hacker News: "The Great Productivity Panic of 2026" — "thin, jittery, frayed weariness," gambling-like inconsistent dopamine, scope creep. Third-party (Builder.io): maturation toward persistent operational agent; Code Review cost high enough teams use it selectively. Disagreement/discrepancy: model naming confusing (5.5 family coexists with "Fable 5.1"/"Mythos 5.1" and "Opus 5"/"Sonnet 5"); third-party aggregators repackage official changelog; naming/versioning of the target's own changelog (2.1.x) vs model versions (4.x/5.x) frequently conflated in community posts.

## Disagreements & open questions

- **Version gap:** the target's latest (2.1.312) is 9 releases ahead of the pinned 2.1.303 this repository clones. Many features in the current docs require v2.1.221+ through v2.1.312; parity against 2.1.303 means some documented behaviors may not exist in the pinned build.
- **Tool count drift:** the target's built-in tool count is reported as ~43 in one analysis and ~60 in the official tools reference; the difference is provider/version gating and bundled skills.
- **Native binary runtime:** sources say "TypeScript + Bun (build)" but shipped binary runtime unspecified.
- **KAIROS/PROACTIVE/DAEMON/VOICE_MODE/WORKFLOW_SCRIPTS:** gated, not confirmed shipped in 2.1.312.
- **Seccomp:** docs call it optional (npm sandbox-runtime), but community reports say it may not be forwarded into runtime in some versions — possible doc/code drift.
- **Autoupdater:** official docs and user reports disagree on which disable controls work on native installs (`autoUpdates: false` vs `DISABLE_UPDATES=1`).
- **IDE integration:** Zed/Neovim support is community-reported (ACP agent), not officially documented as native protocol.
- **Empty states, `/help` layout, welcome-screen ASCII:** not specified in official docs; inferred from feature behavior.
- **Community sentiment:** Reddit/HN content was excerpt-level (partly blocked by scrapers); sentiment claims are paraphrases, not full-thread analysis.
- **Model naming:** 5.5 family coexists with "Fable 5.1"/"Mythos 5.1" and "Opus 5"/"Sonnet 5"; third-party aggregators repackage the official changelog; changelog (2.1.x) vs model versions (4.x/5.x) frequently conflated.
- **Duet proactive agent** (Oct 21 research preview) integration with the CLI vs separate app unclear.
- **June 15, 2026 model deprecations:** exact retirement dates and full list not captured.
- **Fast mode for Opus 4.6** removal as of Oct 28, 2026 not verified.

## Full source list

- [vendor package repository: reference-agent]
- [vendor docs: en changelog]
- [vendor repository: releases]
- [vendor repository: CHANGELOG.md]
- [vendor support: release notes]
- [release tracking: reference-agent updates]
- [analysis blog: reference-agent updates]
- [vendor platform: release notes overview]
- [vendor platform: api migration 2026-10-21]
- [migration blog: sdk migration 2026-10-21]
- [community discussion: hacker news 47467922]
- [community forum: user reports]
- [architecture analysis: source structure]
- [architecture analysis: runtime patterns]
- [technical writeup: code structure review]
- [vendor docs: en setup]
- [vendor docs: en terminal-config]
- [theme guide: terminal styling]
- [vendor docs: en fullscreen]
- [vendor docs: en interactive-mode]
- [vendor docs: en tools-reference]
- [vendor docs: en commands]
- [vendor docs: en cli-reference]
- [vendor docs: en permissions]
- [vendor docs: en sandboxing]
- [vendor docs: en settings]
- [vendor docs: en output-styles]
- [vendor docs: en statusline]
- [vendor docs: en checkpointing]
- [vendor docs: en costs]
- [vendor docs: en agent-teams]
- [vendor docs: en channels]
- [vendor docs: en vs-code]
- [vendor docs: en jetbrains]
- [vendor docs: en plugins overview]
- [vendor docs: en plugins create-marketplace]
- [vendor docs: en self-hosted-environments quickstart]
- [vendor docs: en self-hosted-environments deploy]
- [vendor docs: en self-hosted-environments reference]
- [community issue: 56723]
- [architecture review: misfeature analysis]
- [community discussion: 58338]
- [tooling guide: plan reader]
- [educational guide: effort level selection]

## Recommendations (immediate)

1. **Version alignment decision:** the pinned 2.1.303 is 9 releases behind 2.1.312. Decide whether to re-pin to 2.1.312 (and re-run the REA sweep) or keep 2.1.303 as the parity target. Many documented behaviors (Mantle routing, channels, agent teams, output styles, status line, checkpoints) are newer than 2.1.303 and may not exist in the pinned build — they should not be assumed present in the pinned artifact.
2. **Do not import community/third-party tool lists as truth:** official docs (tools reference, commands, cli-reference) are authoritative; third-party summaries are stale/smaller.
3. **Treat the target's "native binary" shift as a mechanism difference** (like the sandbox helper): the target now ships a standalone binary with background auto-update, while this repository ships `dist/prricode` via Bun. Behavior parity is unaffected, but distribution/install parity is not claimed.
4. **Re-run the REA sweep on 2.1.312** before adding any new "match" rows for features that may not exist in 2.1.303 (channels, agent teams, self-hosted runner, output styles, status line, checkpoints, Monitor, LSP, browser).
5. **Honesty discipline:** the compatibility report's probe depth must match its detail claims (see the F-39/F-19/F-22 strengthening done in this session). New surfaces should be added only with probes that actually assert the claimed behavior, and rows where the target has no counterpart stay `not-tested`.
