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
| `/resume` | Resume an earlier session (stored ones listed in the server's session list) |
| `/sessions` | Show the current session state |
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
| `/message` `/ts` `/ps` | Server-side surfaces (honest stubs, documented as future work) |

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
documented in `docs/ARCHITECTURE.md`.

## File equivalents (optional)

Everything the TUI does has a file/env equivalent, for those who want it:

| TUI | File/env equivalent |
|---|---|
| `/model`, `/provider` | `prricode --provider … --model …`, or `[defaults]` in `config.toml` |
| `/approval`, `/yolo` | `--approval-mode` flag; session state via `session/setApprovalMode` |
| `/theme` | `~/.config/prricode/themes/*.json` |
| credentials | `prricode auth token <provider>` (0600 store) or env vars |

See `docs/CONFIGURATION.md` for the full file-based reference.
