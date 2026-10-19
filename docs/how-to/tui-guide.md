# TUI Guide — the terminal is the interface

prricode is terminal-native: **everything happens in the TUI**. Launch it with
a bare `prricode` (no subcommand) and every setting, command, and
configuration is reachable from the composer — no config file required, no
separate app. The config file (`~/.config/prricode/config.toml`) and
environment variables exist as the *equivalent* surfaces for those who prefer
files or CI, and the TUI reads them at startup.

```bash
prricode                                    # the TUI (default provider/model from config or picker)
prricode --provider ollama --model qwen2.5-coder:3b   # pre-seed provider/model
```

## Running the pipeline on an existing codebase

The pipeline is greenfield by default, but it does not ignore what is already
in your workspace. When you launch it inside a project that already has a
manifest (`Cargo.toml`, `pyproject.toml`, `package.json`),

- the **survey** reads the stack, the top-level layout, and how many tests
  already exist — deterministically, no model call;
- the **spec** and **plan** prompts carry that survey, so tasks are written
  against the real files instead of beside them;
- the plan's first task becomes *read and preserve the existing project*
  rather than *scaffold a new one*, so you never end up with a second skeleton
  next to the first;
- the **gates** already detect the stack, so typecheck/build/test run the
  project's real commands;
- the **property gate** counts the suite's own tests, so "at least three
  tests" is checked against what is actually there.

Launch it from inside the project you want changed:

```bash
cd ~/code/my-existing-app
prricode                                   # then: /concept <what you want added>
```

### Tasks edit what is there

A plan task carries a `files` list — workspace-relative, and it must already
exist. That is a gate, not a convention: a plan whose task names a file that
is not there is rejected by the reuse gate, and a task that names nothing at
all is rejected too, because a task that creates its own world is exactly the
failure this prevents. The build turn is then told which files to open, so the
agent edits `src/app.py` instead of inventing a second skeleton next to it.

## The composer

| Key | Action |
|---|---|
| `Return` | Send the message |
| `Shift+Enter` / `Ctrl+J` / `Ctrl+M` | Newline (multi-line message) |
| `Alt+Enter` | Queue the message behind the running turn |
| `Ctrl+R` / `Ctrl+P` / `Ctrl+N` | History search / previous / next |
| `Ctrl+G` | Edit the draft in `$VISUAL` / `$EDITOR` |
| `Ctrl+L` | Clear the transcript |
| `Alt+B` / `Alt+F` | Move by word |
| `Ctrl+K` / `Ctrl+Y` | Kill to end / yank |
| `Ctrl+T` | Transpose characters |
| `Alt+D` | Delete word right |
| `@` | Insert a file path (workspace picker) |
| `!command` | Run a shell command in the workspace (no turn, no approval bypass) |
| `Ctrl+V` | Paste an image from the clipboard (wl-paste/xclip) |
| `Ctrl+O` | Toggle expanded tool-result view |
| `Ctrl+C` | Interrupt the running turn (press again with no turn to quit) |
| `Esc` | Cancel the turn / close pickers and modals |
| `PgUp` / `PgDn` | Scroll the transcript |

## Slash commands

Type `/` and the command, then `Return`.

### Session
| Command | What it does |
|---|---|
| `/new` | Fresh session |
| `/resume <id>` | Resume an earlier session directly by id |
| `/sessions` | Open the navigable session picker (a row per stored session; ↑/↓ or j/k move, Enter resumes, Esc closes) |
| `/clear` | Wipe or keep the scrollback |
| `/compact` | Compact context (server-side `session/compact`) |
| `/quit` (alias `/exit`) | Quit |

### Settings (all editable here)
| Command | What it does |
|---|---|
| `/model <id>` | Switch model live (`/model` alone shows the current one) |
| `/provider <name>` | Switch provider (echo, ollama, openrouter, kilo, openai…) |
| `/approval <mode>` | `open` (auto-approve) / `auto` / `closed` / `suggestive` |
| `/yolo` | Toggle unattended approval (open ↔ closed) |
| `/theme <name>` | Switch color theme (`/theme` lists the 24+ bundled JSON themes + your own) |
| `/goal <objective>` | View/set the session goal (persistent goals run via the protocol) |

### Product Builder pipeline
| Command | What it does |
|---|---|
| `/concept <idea>` | Start the pipeline from a rough idea — the interview begins |
| `/spec` | Run the Specify stage (EARS, validated) |
| `/plan` | Run the Plan stage (task graph, waves) |
| `/build` | Execute the plan in an isolated worktree, gates per task |
| `/ship` | GitHub release + install steps (confirmation-gated) |
| `/deploy` | Optional agent-arranged deploy: target proposal → credentials (masked) → deploy |
| `/operate` | Health checks + the run log |
| `/dossier` | Open the acceptance dossier |

### Info
| Command | What it does |
|---|---|
| `/help` (alias `/?`) | Show the command + key reference |
| `?` (empty composer) | Open the same help panel from the keyboard; Esc closes it |
| `/message <session> <text>` | Queue a cross-session message into the workspace's `.prricode/messages` queue (same files the `send_message` tool uses) |
| `/ts` `/ps` | Local task/process view of the active turn and pipeline state |
| `/hooks` | List the hooks registered in this runner (id, event, type) |
| `/hooks add <event>[@tool] <command> [args…]` | Register a command hook for this session. The event name is case-insensitive (`pretooluse` works). `@tool` optionally filters by tool-name pattern (`*` matches everything). Unknown events are answered with the full event list; hooks live for the lifetime of the TUI process |
| `/stats` | Workspace totals from the local database: sessions, items, usage records, tokens in/out, cost |
| `/insights` | Usage by day (`YYYY-MM-DD: <in> in / <out> out ($cost)`); honest zero state when nothing is recorded |

## Approvals — three durability tiers

Sensitive tool calls pause with a modal. The approve key relabels per risk
class (`review needed` / `elevated` / `blocking` — shown in the title):

| Key | Choice | Effect |
|---|---|---|
| `Enter` | Approve the selected row | the selected row runs |
| `Tab` | Switch row | cycles: Allow once → Allow for this session → Always allow in this workspace |
| `y` / `s` / `a` | Direct aliases | once / session / always-in-workspace |
| `Space` / `n` / `Esc` | Reject | the call is denied |

"Always allow in this workspace" persists a policy amendment
(`shell_command_exact_raw` / argv-prefix matchers) that auto-answers matching
future calls. If nobody answers, the request times out
(`PRRICODE_APPROVAL_TIMEOUT_SECS`, default 600s) and denies.

## Image paste

`Ctrl+V` reads an image from the clipboard (`wl-paste` on Wayland,
`xclip` on X11). The composer shows `image attached (N bytes)`; `Esc` clears,
`Ctrl+V` replaces. The image rides along with your message as an image part —
the model sees it. Attachments never enter the composer history.

## Theming

`/theme` lists and switches between the 24 bundled JSON themes (Catppuccin,
Dracula, Nord, Tokyo Night, Gruvbox, Ayu, Everforest, Kanagawa, Monokai,
Poimandres, Rosé Pine, Synthwave '84, GitHub, One, Houston, Snazzy) plus your
own files in `~/.config/prricode/themes/*.json` — the JSON schema is
documented in `docs/explanation/architecture.md`.

## File equivalents (optional)

Everything the TUI does has a file/env equivalent, for those who want it:

| TUI | File/env equivalent |
|---|---|
| `/model`, `/provider` | `prricode --provider … --model …`, or `[defaults]` in `config.toml` |
| `/approval`, `/yolo` | `--approval-mode` flag; session state via `session/setApprovalMode` |
| `/theme` | `~/.config/prricode/themes/*.json` |
| credentials | `prricode auth token <provider>` (0600 store) or env vars |

See `docs/how-to/connect-a-provider.md` for the full file-based reference.
