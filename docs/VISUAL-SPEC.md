# Visual / UX Spec — terminal agent TUI

Source: static analysis of a stripped public release binary (89,089,856 bytes, ELF x86-64, non-PIE). The binary was never executed; all analysis was read-only.
Internal module paths visible in the binary corroborate the pane-plus-modal architecture (a settings renderer, panel modules, startup wiring); the specific crate paths are omitted.
Extraction date: 2026-10-14. Everything below is quoted from the binary's string table or from disassembly of the read-only binary; the binary was never executed.

Citation format: `S:"<string>"` = literal string in the binary (with file offset from `strings -t x` where useful); `D:0xADDR` = disassembly/rodata address. File offsets were converted to virtual addresses with an ELF segment map (see the method in §8).

---

## 1. Layout & screens

### 1.1 Screen model (binary-verified vocabulary)

The protocol surface's TUI is a **single scrollback pane plus modal drawers/pickers**, not a multi-pane IDE layout.

- The scrollback is called the **transcript**: `S:"Show model reasoning in the transcript."`, `S:"Drawers, pickers, and transcript movement"` (a keymap group name), `S:"Replaying saved transcript."`
- The input area is the **composer**: `S:"Move left in the composer draft."`, `S:"Edit the composer draft in $VISUAL or $EDITOR."`, `S:"...Open or close the compact shortcut overlay when the composer is empty."`
- Modal surfaces are called **drawers / pickers / overlays**: `S:"Move up through drawer, picker, list, or history rows."`, `S:"Model — Open the model picker."`, `S:"invalid plugin drawer view"`, `S:"model drawer action is missing its model id"`, `S:"effort drawer action is missing effort"`
- **No "sidebar", "panel", "tab bar", or "split pane" strings were found** — only generic HTML/CSS noise matching "panel" from bundled web content. No evidence extracted for a persistent side rail.
- Overlay/dialog surfaces evidenced by their own strings: Settings overlay (a module path embedded in the binary; layout confirmed in §7.3), Keymap overlay (`S:"Keymap"`), theme picker (`S:"No alternate themes are available"`), model drawer (`S:"no matching model"`), plugin drawer (`S:"plugins are not available in this build"`), approval modal (section 4).

### 1.2 Compact shortcut overlay (the `?` overlay)

Shown when the composer is empty. Rows are `label — key(s) — detail`, from the shortcut-definition blob. The first four rows are the `keymap-short` compact overlay per the blob's internal ordering (`App`, `shell`, `files`, `keymap-short`); the remaining rows come from the same definition table and are most likely shown in the full Keymap overlay — which subset renders in the compact overlay is inferred, not code-verified:

| Label | Key(s) | Detail |
|---|---|---|
| App | `/` | `S:"Open slash commands."` |
| Shell command | `!` | `S:"Start a shell command from the composer."` |
| File paths | `@` | `S:"Search and insert file paths."` |
| (shortcut overlay) | `?` | `S:"Open or close the compact shortcut overlay when the composer is empty."` |
| Paste images | ctrl+v, super+v | `S:"Paste image data or paths into the composer."` |
| Interrupt or exit | ctrl+c | `S:"Cancel the active operation or request exit."` |
| Suspend | ctrl+z | `S:"Suspend the terminal process when supported."` |
| External editor | ctrl+g | `S:"Edit the composer draft in $VISUAL or $EDITOR."` |

(Evidence: a contiguous keymap string blob.)

### 1.3 Startup / banner text

- System identity prompt: an identity string establishing the assistant as a terminal coding agent (truncated in the strings dump).
- Version line: a `MAJOR.MINOR.0-RNNN.N` build tag adjacent to the product label, located inside clap's argument construction (12-byte literal).
- Login onboarding: `S:"Log in with browser"`, `S:"Set an API key"`, `S:"run /login to get started, or set "`, `S:"Log in with your account: approve a code in your browser."`, `S:"Logged in to "`, `S:"You are logged in."`, `S:"4Not logged in "` (auth status line), `S:">Logged in for this session, but the key could not be saved to "`
- Billing gate: `S:"Model API requires a payment method on your account"`, `S:"use the billing link in the banner."`, `S:"Press Ctrl+Enter to open billing: "`, `S:"Validating key"`, telemetry `S:"session.payment_gate.banner_shown"`
- Trust gate: `S:"1 - press Enter to install (explicit, trust-gated)"`

### 1.4 Modal dialogs

- Quit confirmation: `S:"1. Exit anyway"` / `S:"2. Stay"` / `S:"esc cancels the message, /quit still exits"` / `S:"Press Ctrl-C again to quit"` / `S:"Press Ctrl-D again to quit"` (double-press-to-quit pattern)
- `/new` with tasks running: `S:"Esc to cancel/clear"`, `S:"1. Start fresh and stop tasks"`, `S:"2. Start fresh; keep tasks running"`, `S:"3. Cancel"`
- Generic confirm: `S:"over to you  Press enter to confirm or esc to cancel"`
- Onboarding question: `S:"Anything you want to add (optional)"`, `S:"send (no files)"`, `S:"Shift+Enter"`, `S:"Ctrl+C "`, `S:"press Enter on an option to check it, then submit"`, `S:"Enter to select"`

### 1.5 Empty states (all literal)

`S:"No other local sessions"`, `S:"No local sessions"`, `S:"no running or recent work"`, `S:"No background tasks running."`, `S:"no matching settings"`, `S:"no matching model"`, `S:"no matching session"`, `S:"no matching agent threads"`, `S:"No commands found"`, `S:"No custom commands found"`, `S:"No built-in commands found"`, `S:"No alternate themes are available"`, `S:"No plugin skills"`, `S:"No matching items"`, `S:"no in-progress search to finish"`, `S:"no retained sessions found for this workspace"`, `S:"no available export filenames"`, `S:"model catalog has no visible models"`, `S:"no matching prompt: "`, `S:"no selectable theme"` (in `S:"theme save failed: no selectable theme"`).

---

## 2. Keymap table

Data model (verified in rodata): a static table of entries with fields `(group, action id, label, key specs, detail)`; decoded sample entries:

```
ptr=…   len=14   "history-search"
ptr=…   len=14   "History search"
ptr=…   len=37   "Search composer history newest first."
```

The labels/keys/details are held in adjacent keymap string blobs (located via the method in §8).

### App-level shortcuts

| Action id | Label | Key(s) | Detail |
|---|---|---|---|
| `cancel` | Cancel or close | `esc` | Close focused UI, cancel completion, or return to the composer. |
| `interrupt` | Interrupt or exit | `ctrl+c` | Cancel the active operation or request exit. |
| `suspend` | Suspend | `ctrl+z` | Suspend the terminal process when supported. |
| `external-editor` | External editor | `ctrl+g` | Edit the composer draft in $VISUAL or $EDITOR. |
| `clear-terminal` | Clear terminal | `ctrl+l` | Clear and repaint the terminal viewport. |
| `expand-tool-output` | Expand tool output | `ctrl+o` | Toggle expanded tool-output display. |
| `voice` | Voice input | `alt+v` | (voice session start/stop) |
| `voice-tap` | Voice tap-to-talk | `alt+t` | Start or stop tap-to-talk voice input. |
| `keymap-short` | — | `?` | Open or close the compact shortcut overlay when the composer is empty. |

### Composer shortcuts — submit & history

| Action id | Label | Key(s) | Detail |
|---|---|---|---|
| `submit` | Submit | `enter` | Submit the composer message. |
| `newline` | — | `shift+enter`, `ctrl+j`, `ctrl+m` | Insert a newline without submitting. |
| `queue` | Queue while running | `alt+enter` | Queue or steer input while a run is active. |
| `complete-suggestion` | Complete suggestion | `tab` | Accept the active composer suggestion. |
| `history-search` | History search | `ctrl+r` | Search composer history newest first. |
| — | (previous history item) | `ctrl+p` | Recall the previous composer history item. |
| `history-next` | Next history | `ctrl+n` | Move forward through composer history. |
| `process-background` | Process background | `ctrl+b` | Send the selected task to the background queue. |
| `paste-images` | Paste images | `ctrl+v`, `super+v` | Paste image data or paths into the composer. |

### Text editing shortcuts

| Action id | Label | Key(s) | Detail |
|---|---|---|---|
| `move-left` | Move cursor left | `left` | Move left in the composer draft. |
| `move-right` | Move cursor right | `right`, `ctrl+f` | Move right in the composer draft. |
| `move-word-left` | Move word left | `alt+b`, `super+left`, `ctrl+left` | Move left by one word in the composer draft. |
| `move-word-right` | Move word right | `alt+f`, `alt+right`, `super+right`, `ctrl+right` | Move right by one word in the composer draft. |
| `line-start` | Line start | `ctrl+a` | Move to the start of the current line. |
| `end` | End | `ctrl+e` | Move to the end of the current line. |
| `backspace` | Backspace | `shift+backspace`, `ctrl+h` | Delete text before the cursor. |
| `delete-forward` | Delete forward | `delete` | Delete text after the cursor. |
| `delete-word` | Delete previous word | `alt+backspace`, `super+backspace`, `ctrl+backspace`, `ctrl+w`, `alt+delete`, `super+delete`, `ctrl+delete`, `alt+d` | Delete text before the cursor by word. |
| `delete-start` | — | `ctrl+u` | Delete from cursor to line start. |
| `delete-end` | — | `ctrl+k` | Delete from cursor to line end. |
| `yank` | Yank deleted text | `ctrl+y` | Paste the last killed composer text. |
| `transpose` | Transpose characters | `ctrl+t` | Swap the two characters around the cursor. |

### Navigation (drawers, pickers, transcript)

| Action id | Label | Key(s) | Detail |
|---|---|---|---|
| `navigation` / `move-row-up` | Move row up | `up` | Move up through drawer, picker, list, or history rows. |
| `navigation` / `move-row-down` | Move row down | `down` | Move down through drawer, picker, list, or history rows. |
| `scroll-up` / `scroll-down` | — | — | (action ids exist; key specs not extracted) |

### Keymap overlay UI

- Title `S:"Keymap"`.
- Group tabs (id / label / description): `all`/`All`/"All configurable shortcuts", `common`/`Common`/"Most-used shortcuts", `App-level shortcuts`, `Composer shortcuts`, `Text editing shortcuts`, `Drawers, pickers, and transcript movement`, `customized`/`Customized`/"User overrides", `Unbound`/"Shortcuts explicitly disabled".
- Footers: `S:"up/down move - tab switch tab - type filter - enter details - esc close"`, `S:"enter choose - esc close - /keymap reopen all shortcuts"`, `S:"enter save - esc cancel"`.
- Custom binding: `S:"unbound"` / `S:"Enter a key spec such as ctrl+x, shift+enter, or ;"` / `S:"Comma-separated bindings are supported."`; edit ops `S:"keymap.shortcut.replace"` ("Disable this action until it is reset or replaced."), `S:"keymap.shortcut.unbind"` ("Restore the default binding."), `S:"keymap.shortcut.reset"`.
- Errors: `S:"keymap shortcut not found"`, `S:"missing key binding"`, `S:"...binds more than one key"` (prefix truncated in table).
- Settings persist keymap via `TuiSettings.keymap` (`S:"show_reasoning reasoning_summaries away_recap_enabled voice_enabled voice_tap_enabled keymap resize_reflow_cap color_depth theme rules_import_offer_dismissed foreign_context_notice_shown verbose_output"`).

**Verification of every requested binding:** ctrl+j/ctrl+m newline ✓; shift+enter newline ✓; ctrl+r history ✓; ctrl+p/ctrl+n history ✓; ctrl+g editor ✓; ctrl+l clear ✓; alt+b / alt+f word motion ✓ (plus alt+right/super+right/ctrl+right variants); ctrl+k delete-to-end ✓; ctrl+y yank ✓; ctrl+t transpose ✓; ctrl+v paste images ✓ (super+v alias); esc close/cancel ✓; ctrl+c interrupt-or-exit ✓; tab accept-suggestion ✓. Additional bindings found beyond the requested list: ctrl+a/ctrl+e line start/end, ctrl+u delete-to-start, ctrl+h backspace, ctrl+w/alt+d delete-word, alt+enter queue/steer, ctrl+b background, ctrl+o expand tool output, ctrl+z suspend, alt+v voice, alt+t tap-to-talk, `?` shortcut overlay, `@` file paths, `!` shell command.

---

## 3. Slash command table

Source: the command-overlay string blob (`S:"Show keyboard shortcuts/help/Show help/theme/Choose color theme..."` region) plus standalone `usage:` strings.

| Command | Usage / args | Description |
|---|---|---|
| `/new` | — | Start a fresh session (asks about background tasks; §1.4) |
| `/resume` | `[--last]` | Resume an earlier session |
| `/fork` | — | Branch this session from the latest message |
| `/clear` | — | Start a fresh session (wipe or keep the scrollback) |
| `/side` | — | Start a side conversation |
| `/init` | — | Explore the workspace and create or improve AGENTS.md |
| `/message` | `<target-session-id> <body>` | Send a message to another local session |
| `/subagents` | — | View running and past subagents |
| `/model` | — | Choose model |
| `/models` | — | (listed in the command table; no distinct description string extracted) |
| `/settings` | — | Open local settings/config |
| `/keymap` | — | Show keyboard shortcuts |
| `/help` | — | Show help |
| `/theme` | — | Choose color theme |
| `/rules` | `[import]` | Show which md files govern this session |
| `/memory` | — | Listed in the command table; its own description string was not extracted (the adjacent `[transcript\|trajectory]` token belongs to `/export` — see below) |
| `/export` | `[transcript \| trajectory [--out <path>] [--redacted]]` | Save the conversation, or the full session log |
| `/copy` | — | Copy the last response to the clipboard |
| `/recap` | — | Show a recap of recent session activity |
| `/skills` | `[import\|reload\|manage\|diagnostics\|use <id-or-path> [prompt]]` | Browse and use skills |
| `/skill` | `<id-or-path> [prompt]` | Invoke a skill |
| `/plugins` | `[list\|inspect <id>\|diagnostics\|install <path\|plugin@marketplace>\|enable <id>\|disable <id>\|update <id>\|remove <id>\|marketplace ...]` | Manage plugins |
| `/effort` | `[<none\|minimal\|low\|medium\|high\|xhigh\|ultra>]` | Set the model's effort level |
| `/goal` | `[<objective>\|edit <objective>\|clear\|pause\|resume]` | Start or manage continuous work toward a goal |
| `/feedback` | `[note]` | Send quick feedback to the team |
| `/voice` | `[status\|debug]` | Manage voice input |
| `/stop` | — | Stop all background tasks |
| `/status` | — | Show current session status |
| `/usage` | — | Show session usage/cost |
| `/yolo` | — | How to restart with all actions auto-approved |
| `/tasks` | — | View and manage background tasks and terminals |
| `/ts`, `/ps` | — | Browse workflow runs (aliases of one another) |
| `/login`, `/logout` | — | `S:"Log in with an account or using an API key"` / `S:"Log out, forget the saved login, and exit"` |
| `/plugins marketplace` | `add <name> <source>` | Add a local file/directory or Git marketplace source and store a snapshot |

Additional usage/validation strings: `S:"usage: /resume [--last]"`, `S:"usage: /skills use <id-or-path> [prompt]"`, `S:"usage: /skill <id-or-path> [prompt]"`, `S:"usage: /voice status|debug"`, `S:"usage: /plugins [list|inspect|diagnostics|install|enable|disable|update|remove|marketplace]"`, `S:"usage: /goal edit <objective>"`, `S:"usage: /export [transcript | trajectory [--out <path>] [--redacted]]"`, `S:"usage: /rules [import]"`, `S:"usage: /message <target-session-id> <body>"`.

Commands checked and **not found** (no evidence extracted): `/approvals`, `/diff`. `/compact` **is** present: `S:"/compact"` with `S:"interrupt the active run before /compact"`, `S:"no compactable run is available"`, `S:"manual context compaction is not available"`, `S:"could not compact context; try again"`, `S:"automatic compaction reached the trim floor"` → `/compact` = manually compact context. `/exit` also exists as a `/quit` alias: `S:"/exit/quit"`.

---

## 4. Approval UX

### 4.1 Modal copy

Prompts by subject kind: `S:"Would you like to run the following command?"`, `S:"Would you like to allow this file access?"`, `S:"Would you like to allow this network access?"`, `S:"Would you like to allow this tool action?"`.
Context fields inside the modal: `S:"requested by:  "`, `S:"full URL:  "`, `S:"... skipped stage"`, `S:"details continue"`, `S:"... command context continues"`.

### 4.2 Keys that answer the modal

Footer strings (three variants depending on the request's risk class):

- `S:"enter approve - space reject - tab switch - esc close - type filter"` (review_needed)
- `S:"enter approve elevated - space reject - tab switch - esc close - type filter"` (elevated)
- `S:"enter approve blocking - space reject - tab switch - esc close - type filter"` (blocked)

So: **enter = approve, space = reject, tab = switch choice, esc = close, typing filters**. Expanded detail is available with ctrl+o: `S:"Interrupt turn (ctrl+o to expand)"`.

### 4.3 Choice vocabulary — including the "always" variant

- `S:"Allow once"`, `S:"Allow for this session"`, `S:"Always allow in this workspace: "` — **yes, there is an "always" variant, scoped to the workspace.**
- Availability-gated labels: `S:"Abort is not available."`, `S:"Yes is not available."`, `S:"Don't-ask-again is not available."`
- Refresh/race messages: `S:"Approval advanced to another stage; refreshing current choices."`, `S:"Approval choices changed; review before deciding."`, `S:"Approval was already resolved by another client."`, `S:"approval was already resolved"`, `S:"No approval selected."`, `S:"No approval choice selected."`, `S:"Runtime closed before approval decision was accepted."`, `S:"approval decision submitted"`, `S:"approval decision failed"`.

### 4.4 Decision & data model (binary-verified enums/structs)

- Decision kind `ReviewDecisionKind` / `ReviewDecision`: `approved`, `approved_for_session`, `approved_policy_amendment`, `denied`, `denied_policy_amendment`, `timed_out`, `abort`/`aborted`.
- Terminal outcomes: `allow:approved`, `allow:approved_for_session`, `allow:session_policy_amendment`, `allow:local_policy_amendment`.
- Choice struct: `ReviewChoice { choice_id, label, rule_preview, allow, prompt }` (`S:"ReviewChoice choice_id label rule_preview allow prompt"`, `S:"struct ... Choice with 5 elements"`).
- Policy effect / scope: `PolicyEffect { allow, session, ... }`, `PolicyAmendment { effect, durability, reason }` (4 elements), `PolicyRule` kinds: `shell_command_exact_raw`, `shell_command_argv_prefix`, `command`, `argv_prefix`, `workspace_root`, `tool_action`, `tool_name`, `filesystem`, `access`, `network`.
- Subjects: `ApprovalSubject` = `ShellCommand { raw_command, stages, command, argv_prefix }` | `ToolAction { tool_name, filesystem, network, process, origin, access }` | `Url`. Origin enum: `write`, `control`, ... (`S:"internally tagged enum ApprovalSubject"`, `S:"internally tagged enum ToolActionOrigin"`).
- Requirement-vs-choices validation: `S:"recorded action-level approval requirement or choices are invalid"` (exact string from the task brief, confirmed).
- Restart-protection errors: `S:"protected approval was aborted before restart"`, `S:"protected approval aborted before restart"` (task-brief string, confirmed as `S:"protected approval was aborted before restart"`), `S:"fresh protected approval produced no executable grant receipt"`, `S:"approval denied before restart"`, `S:"protected approval lost live target authority after restart"`, `S:"protected recovery approval chain is inconsistent"`.
- User-facing outcomes: `S:"tool denied: approval timed out"`, `S:"tool denied: approval aborted"`, `S:"tool approval cancelled"`, `S:"pending approval cancelled"`, `S:"denied by user"`, `S:"approval timed out"`.
- Approval/sandbox mode state (status line + settings): `S:"approval mode: "`, `S:"ApprovalState="`, `S:"SessionEffectiveSecurityMode"`, `S:"SessionApprovalSecurityMode"`, `S:"SessionSandboxSecurityMode"` with values `normal`, `approvals_off`, `sandbox_off`, `network_restricted`, `network_proxy_only`, `S:"runtime sandbox disabled explicitly"`, `S:"network is restricted"`.

---

## 5. Status / rail fields

There is no single status-line format string in the binary (see limitations); the fields below are the literal fragments that compose it.

- **Approval mode**: `S:"approval mode: "`, `S:"ApprovalState="`.
- **Turn state**: `S:"Waiting for approval"`, `S:"Compacting"`, `S:"Compacting context before your mes[sage]"`, `S:"Interrupting"`, `S:"No run is active."`, `S:"interrupt already requested"`, `S:"Turn interrupted. Background activity is still running ("`, `S:"Turn received"`, `S:"Reporting progress"`.
- **Tool/status verbs**: `S:"Updating goal"`, `S:"Setting goal"`, `S:"Reading goal"`, `S:"Listing schedules"`, `S:"Unschedu[ling]"` (from one contiguous verb list).
- **View mode**: `S:"browse  pgup/pgdn page"`, `S:"ctrl+o comfortable view"`, `S:"ctrl+o dense view"`, `S:"esc clear"`.
- **Key hint cluster** (adjacent literals, likely one hint line): `S:"guidance"`, `S:"Progress"`, `S:"progress"`, `S:"Workflow"`, `S:"composer"`, `S:"PROVIDER+"`.
- **Contextual Ctrl-key prompts**: `S:"Press Ctrl+C to return to the main chat first."`, `S:"Press Ctrl-C again to quit"`, `S:"Press Ctrl-D again to quit"`, `S:"Press Ctrl+Enter to open billing: "`, `S:"Validating key"`.
- **Model errors surfaced inline**: `S:"could not change the model; try again"`, `S:"model catalog has no visible models"`.
- **Session state**: `S:"idle or pick another session"`, `S:"the session owner changed "`, `S:"4Not logged in "`.
- **Not extracted**: no literal `model:` / `tokens:` / `ctx:` / `turn:` label strings for the status line were found; token accounting exists only as internal fields (`S:"tokens_used"`, `S:"requested_tokens"`). Mark: no evidence extracted.

---

## 6. Session picker

- Empty/loaded states: `S:"No other local sessions"`, `S:"No local sessions"`, `S:"local sessions loaded"` (contiguous literals).
- Footer: `S:"enter choose - esc close - type filter"` (same cluster).
- Sibling picker (for `/message` target): `S:"No other local registered sessions can receive messages."`, `S:"could not list local sessions; try again"`, `S:"loading local sessions"`, `S:"could not queue session message; try again"`, `S:"session message queued"`.
- Resume picker states: `S:"no retained sessions found for this workspace"`, `S:"no matching session"`, `S:"resume handoff was rejected"`, `S:"started a fresh session"`, `S:"use /resume to return"`.
- Workspace-scoped listing: `S:"No sessions for this workspace."`, `S:"No sessions for this workspace. Switch s[cope to all workspaces]"`, `S:"No sessions match this search."`, `S:"No selectable sessions found."`.
- Selection model: filter-as-you-type, enter to choose, esc to close (footer above); a second picker style for agent threads uses `S:"up/down move - type to filter - enter open - esc go back"`.
- Picker bypass semantics (CLI + flags): `S:"skips the picker (most recent session)."`, `S:"wins over an id parse. Bypasses the picker."`, `S:"--last               Skip the picker and export the most recent retained"`, `S:"With no argument it opens the session picker for this workspace."`, `S:"ordinary resume picker returned an unavailable takeover action"`, `S:"resume picker takeover after the user explicitly chooses it"`.

---

## 7. Style evidence

### 7.1 Themes — 24 bundled themes, JSON files with scope maps

Theme files (each `<slug>.json`), with display names:

| File | Display name |
|---|---|
| ayu-dark.json | Ayu Dark |
| ayu-light.json | Ayu Light |
| catppuccin-latte.json | Catppuccin Latte |
| catppuccin-mocha.json | Catppuccin Mocha |
| dracula.json | Dracula Theme |
| everforest-dark.json | Everforest Dark |
| everforest-light.json | Everforest Light |
| github-dark-default.json | GitHub Dark Default |
| github-light-default.json | GitHub Light Default |
| gruvbox-dark-medium.json | Gruvbox Dark Medium |
| gruvbox-light-medium.json | Gruvbox Light Medium |
| houston.json | Houston |
| kanagawa-lotus.json | Kanagawa Lotus |
| kanagawa-wave.json | Kanagawa Wave |
| monokai.json | Monokai |
| nord.json | Nord |
| one-dark-pro.json | One Dark Pro |
| one-light.json | One Light |
| poimandres.json | Poimandres |
| rose-pine-dawn.json | " Pine Dawn" (extracted verbatim; leading space suggests a split name — no "Rosé" string exists elsewhere in the binary) |
| rose-pine-moon.json | " Pine Moon" (same note) |
| snazzy-light.json | Snazzy Light |
| synthwave-84.json | Synthwave '84 |
| tokyo-night.json | Tokyo Night |

- Theme data model: `S:"struct BundledThemeSource with 10 elements"` with field names `display_name`, `source_file`, `source_model`, `license`, `source_digest`, `foreground`, `background`, `accent`, `scopes` (9 field names observed; struct declares 10 elements). Per-scope style: `S:"struct SourceScopeStyle with 3 elements"`.
- Theme files carry **TextMate scope grammars** — e.g. the catppuccin-latte cluster contains `variable.other.readwrite`, `markup.bold`, `markup.raw`, `markup.quote`, `constant.language.boolean`, `storage.type`, `entity.name.function`, `keyword.operator.word` — i.e. the themes recolor the whole syntax-highlight surface, not just chrome.
- Theme settings strings: `S:"color_depth"`, `S:"theme"`, enum `ColorDepthRepr`; `S:"No alternate themes are available"`, `S:"Theme background differs from terminal"`, `S:"light"` (terminal background detection), `S:"theme save failed: no selectable theme"`, `S:"Couldn't open a browser "`.

### 7.2 Layout constants / frames

- **No pixel/character-cell layout constants (`20px`-style) were found** — every match for `[0-9]+px` traces to bundled HTML/CSS web content, not the TUI. Mark: no evidence extracted.
- **No box-drawing/frame glyph strings** (─ │ ┌ ╭ …) were found in the string table. Mark: no evidence extracted; frame style cannot be determined from strings.
- The only layout-shaping constants visible are the keymap/settings string **lengths used inline in code** (e.g. a 21-byte push of `"Starting side chat..."`, a 5-byte push of `"/side"`), which is a Rust length-carrying `&str` push, not a UI metric.

### 7.3 Disassembly pass (bounded, 4 regions)

| Region | Contents |
|---|---|
| clap region | clap argument construction; loads the 12-byte version literal (build tag per §1.3); string addresses appear as absolute 8-byte immediates (`movq $imm`), confirming non-PIE absolute addressing for some literals. |
| side-chat region | side-chat runtime: a 21-byte push of `"Starting side chat..."` and a 5-byte push of `"/side"`. Confirms the side-chat status line and command token are adjacent runtime concepts. |
| settings region | **Settings overlay row construction.** Each row is a (label, description) pair — "Context", "Personal rules fallback", "Fall back to compatible personal rules.", "Include compatible personal skills.", "Personal skills fallback", "TUI", "Verbose output", "Transcript detail, from less to more." — passed to the settings renderer. |
| keymap table region (rodata) | Keymap static table decoded above: entries are `(group="Composer", id, label, detail)` 16-byte `(ptr,len)` records, e.g. `history-search`/`History search`/`Search composer history newest first.` then `history-next`/`Next history`, `editor` group tag. |

Adjacent-label neighborhoods confirmed by rodata dumps: the picker strings (`No other local sessions` … `local sessions loaded` … `could not list local sessions`) sit in one contiguous blob; the settings rows and approval lifecycle strings (`Runtime closed before approval decision was accepted.`, `Approval choices changed; review before deciding.`) share a separate contiguous blob — same-screen adjacency as claimed.

---

## 8. Extraction method & limitations

**Method.** (1) `strings` dump of the binary (234,833 lines) mined with bounded-context greps; (2) `strings -t x` for file offsets and a Python ELF segment map (rodata: vaddr = file-offset + 0x200000) to convert offsets to virtual addresses; (3) rodata struct decoding: located `(ptr,len)` records to enumerate the keymap table and theme metadata; (4) a numpy scan of the 73 MB executable segment for `48/4c 8D /05` (`lea reg,[rip+disp32]`) patterns to find code referencing string constants, then bounded `objdump -d --start-address/--stop-address` (4 regions, ≤ 90 instructions each) around verified references. The target binary was **never executed**; all calls were read-only.

**Binary-verified** (direct string or disassembly evidence): every keymap binding and purpose string; the slash-command set with usage strings; the approval modal copy, keys, decision enum, `ReviewChoice`/`PolicyAmendment` structs, and the "always" variant; the session-picker empty states and footer; the 24-theme list and `BundledThemeSource` metadata; the settings-overlay row pairs; the version banner.

**Inferred** (stated as such, not verified): that `"guidance"/"Progress"/"Workflow"/"composer"/"PROVIDER+"` form one status-line cluster (adjacent literals, no format string found); that the picker footer `"enter choose - esc close - type filter"` belongs to the resume/session picker specifically (it is contiguous with the `No other local sessions` blob, so attribution is likely but not code-verified); the exact pairing of `/memory`'s description (the `[transcript|trajectory]` token adjacent to it is provably `/export`'s usage, from `usage: /export [transcript | trajectory ...]`; `/memory`'s own description string: **no evidence extracted**).

**No evidence extracted** (explicitly): a persistent sidebar or panel layout (no such strings); pixel/cell layout constants; box-drawing or frame glyphs; ANSI color-escape strings (none present — color goes through the theme layer); `model:`/`tokens:` status labels; `/approvals` and `/diff` commands (absent); a key spec for `scroll-up`/`scroll-down`.

**Residual risk.** Strings-only extraction cannot prove render order or visual arrangement; the adjacency claims rest on rodata locality plus the four disassembly regions. A follow-up pass could map more `lea` sites into the render functions (dense references into the keymap-table region were observed, but delta-window attribution was inconclusive).


---

## 9. Implementation checklist (spec item -> prricode)

Every behavioral item in this spec, mapped to its implementation and test.
Updated as items land; "spec-exact" means the behavior matches the evidence,
"aligned" means our design with the behavioral contract preserved.

| # | Spec item | Evidence | Status | Implementation / test |
|---|---|---|---|---|
| 1 | Single transcript pane + modal drawers (no sidebar/split) | §1.1 strings | aligned | TUI is one conversation pane + centered modals (`ui.rs` render_main + render_approval) |
| 2 | Composer vocabulary (draft, enter send, ctrl+j newline) | §1.1 | spec-exact | `app.rs` composer keys; `typing_submits_user_message`, `ctrl_j_inserts_newline` |
| 3 | Compact shortcut overlay (`?` when composer empty) | §1.2 | partial | `/help` toggles the help panel; the literal `?`-on-empty-composer binding is a follow-up |
| 4 | Startup/banner: model + provider + approval in the status line | §1.3, §5 | aligned | `App::status_line()` renders provider/model/mode/turn/tokens |
| 5 | Quit confirmation with double-press pattern | §1.4 | aligned | Ctrl+C quits when idle (no double-press) — documented difference |
| 6 | Empty states with literal copy ("No other local sessions") | §1.5 | aligned | TUI prints equivalent messages; copy differs by design (our language) |
| 7 | Keymap: Return submit / ctrl+j newline / ctrl+r history / ctrl+p+n / ctrl+g editor / ctrl+l clear / alt+b f word moves / ctrl+k y kill-yank / ctrl+t transpose / esc cancel | §2 | spec-exact | verified verbatim; keymap tests |
| 8 | Keymap: alt+enter queue/steer | §2 | spec-exact | Alt+Enter queues behind a running turn (queue path) |
| 9 | Keymap: ctrl+b background, ctrl+o expand | §2 | honest-stub / partial | ctrl+b reports background turns unsupported; ctrl+o toggles expand flag |
| 10 | Keymap: `@` file paths, `!` shell mode, alt+d delete-word | §2 | spec-exact | `at_opens_picker_and_enter_inserts_path`, `bang_prefix_routes_to_shell_run`, `alt_d_deletes_word_right` |
| 11 | Keymap: ctrl+v / super+v paste images | §2 | spec-exact (aligned binding) | `Ctrl+V` reads the clipboard (wl-paste / xclip) and rides the message as an image part; `super+v` is a macOS keymap variant with no Linux equivalent |
| 12 | Keymap: ctrl+z suspend | §2 | future | terminal suspend is a runtime concern; not wired |
| 13 | Slash: /new /resume /clear /model /settings /help /theme /goal /yolo /export /quit /exit | §3 | spec-exact or aligned | implemented; `slash_commands*` tests |
| 14 | Slash: /fork /side /init /rules /memory /copy /recap /feedback /status /usage /stop /tasks /login /logout | §3 | honest-stub | logged as server-side/CLI surfaces with future-work comments |
| 15 | Slash: /skills /skill /plugins (full arg grammar) | §3 | partial | skill/list + import exist server-side; the in-TUI grammar is a follow-up |
| 16 | Slash: /effort | §3 | partial | protocol has setReasoningEffort; TUI command is a follow-up |
| 17 | Slash: /message /ts /ps | §3 | honest-stub | `server_side_commands_are_honest_stubs` |
| 18 | Slash: /compact (manual context compaction) | §3 | honest-stub | compaction is server-side (session/compact); TUI stub with comment |
| 19 | Approval modal copy per subject (command/file/network/tool) | §4.1 | aligned | our modal shows tool + summary; subject-specific copy is a follow-up |
| 20 | Approval keys: enter approve / space reject / tab switch / esc close / ctrl+o expand | §4.2 | spec-exact | `spec_keys_tab_switches_and_enter_approves_selected`, `space_rejects_like_esc` |
| 21 | Approval choices: Allow once / for session / always in workspace | §4.3 | spec-exact | three choice rows; `always_in_workspace_tier_records_and_matches` |
| 22 | PolicyAmendment { effect, durability, reason } + rule kinds | §4.4 | spec-exact | `PolicyAmendment { tool, matcher, durability }` persisted under `approvalAmendment:<sessionId>` |
| 23 | Decision vocabulary (approved / for_session / policy_amendment / denied / timed_out / abort) | §4.4 | partial | once/session/workspace/denied + `timed_out` implemented; `abort` is a transport-level follow-up |
| 24 | Risk-class footers relabel the approve key | §4.2 | spec-exact | modal title carries review_needed/elevated/blocking; `risk_class_maps_tools_to_footer_labels` |
| 25 | Status fields: approval mode, turn state, view mode, model errors | §5 | spec-exact | `status_line()` + inline error messages |
| 26 | Session picker (list + select; --last skips) | §6 | partial | `/sessions` shows state; the picker list is a follow-up |
| 27 | 24 bundled JSON themes | §7.1 | spec-exact | all 25 theme files bundled (`crates/prricode-tui/themes/`), `/theme` lists and switches, user themes override by slug; theme schema test |
| 28 | No box-drawing/ANSI; plain panes | §7.2 | spec-exact | ratatui default rendering, theme-driven colors |

**Legend:** spec-exact = behavior matches the binary evidence; aligned = our
design, behavioral contract preserved; partial = implemented in part with the
remainder named; honest-stub = present with a future-work comment; future =
not implemented, documented here.
