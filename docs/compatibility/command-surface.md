# Command-line surface conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.10 ("The command-line surface"), the REA record `/home/shiva/opt/reference-agent-rea/analysis/findings-untouched-surfaces.md` §3.4 ("The CLI flags — the complete list") and §G3 ("The CLI command tree"), and the target's own source — `chunk-0y0ptpy9.js` (the flag registry and the parser), `chunk-t0c9yez3.js` (the root command's option declarations), `chunk-64447bxa.js` (the `plugin` tree), `chunk-dmqgh1rk.js` (the `mcp` tree), `chunk-9y799w6p.js` (the `auth`, `auto-mode`, `sandbox` and `project` trees and the root commands) and `chunk-mancccdx.js` (the hidden editor commands) — together with this implementation-choice labels the source carries in [`src/cli/args.ts`](../../src/cli/args.ts), [`src/cli/command.ts`](../../src/cli/command.ts), [`src/cli/headless.ts`](../../src/cli/headless.ts) and [`src/cli/output.ts`](../../src/cli/output.ts).
**Owning task:** `CC-014` (the parser, the headless mode, the output contracts), `CC-016` (the multi-provider manager), `CC-030` (the in-session slash-command registry) and `CC-031` (the complete flag list and the subcommand tree) in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**Matrix rows:** F-01, F-02, F-38 in [`feature-matrix.md`](feature-matrix.md), and F-40 in [`provider-catalog.md`](provider-catalog.md).

Every row names its **evidence class**: `REA observed` (established from the pinned binary), `Documented only` (external product documentation, not the pinned binary), or `implementation choice` (a decision this implementation makes). The **measured** outcome of each row is in [`results.md`](results.md).

## The parser's structure (REA observed)

The scanner walks `argv` until `--`, which **ends** the flag parsing. A token of the form `--flag=value` yields that value; a token equal to a known flag consumes the next token as its value. A token is a **flag** when it has more than one character and starts with `-` — a lone `-` is a positional.

The target's own parser lives in `chunk-0y0ptpy9.js` and is **seven sets and six functions**. This implementation reproduces the functions one for one, and the sets are the flag list below.

| The target's | What it does | This implementation's |
|---|---|---|
| `ejt(e)` (`:5387`+ region) | a token looks like a flag when it is longer than one character and starts with `-` | `isFlagToken` |
| `Ibt(e, n)` (`:3038`) | the index of the **last** token the flag at `n` owns | `flagValueEnd` |
| `x(e)` (`:5387`+) | whether a token is a **flag** | `isKnownFlag` |
| `S(e)` (`:5387`+) | whether a token is a **command token** | `isCommandToken` |
| `c(e)` (`:4441`+ region) | the index of the first token that is not a flag | `firstPositionalIndex` |
| `Bjo(e)` (`:4383`+ region) | the index of the session-management subcommand, or `-1` | `sessionSubcommandIndex` |

### The three shapes a flag can have

`Ibt` is the whole of the consumption rule, and it is **commander's** rule:

| Shape | The rule | An example |
|---|---|---|
| a **value** flag | owns the **next** token, whether or not that token looks like a flag | `--model --print` gives `--print` to `--model` |
| a **repeatable** value flag | owns the next token — **whatever it looks like** — and every token after it that does not look like a flag | `--tools --print Read` gives two values to `--tools` |
| an **optional-value** flag | owns the next token only when that token does **not** look like a flag | `--resume session_abc` names a session; `--resume --print` names none |
| a **boolean** flag | owns **nothing** | `--verbose what is the weather?` keeps the prompt |

**The audit's summary was wrong, and this milestone corrects it.** The audit describes the **boolean** set as consuming the next non-flag token, and names `-r`/`--resume` as the flag that takes an optional value. The target's own source says otherwise: the boolean set is **pure**, and the optional value belongs to a set of **fourteen** flags — `-d`, `--debug`, `-r`, `--resume`, `--from-pr`, `-w`, `--worktree`, `--teleport`, `--cloud`, `--remote`, `--project`, `--remote-control`, `--rc`, `--prompt-suggestions`. This implementation now applies the optional value to **all fourteen**, which is the target's rule.

### The three flags the scanner does not count

`h` holds `--exec`, `-m` and `--handle-uri`. They **take a value** — `Ibt` consumes it — but `x()` excludes them, so the session-subcommand scanner does not treat them as flags. The exclusion is reproduced: `isKnownFlag` returns `false` for all three.

`x()` also reads the `--flag=value` form by the name **before** the `=`, and matches a boolean flag **whole**: `--model=x` is a flag, `--verbose=x` is **not**.

## The complete flag list (REA observed)

**Source of truth:** the target's own flag registry, `chunk-0y0ptpy9.js` — the five sets and the parser that reads them. The record's §3.4 is the list; the parser is what the list **means**.

| Set | What it holds | How many | Where |
|---|---|---|---|
| `l` | flags that take a value | **85** | `chunk-0y0ptpy9.js:1112` |
| `LBr` | of those, the **repeatable** ones | **11** | `chunk-0y0ptpy9.js:2671` |
| `d` | flags that take an **optional** value | **14** | `chunk-0y0ptpy9.js:2871` |
| `f` | **boolean** flags | **45** | `chunk-0y0ptpy9.js:4539` |
| `m` | tokens that are **commands**, not flags | **10** | `chunk-0y0ptpy9.js:4441` |
| `g` | the **session-management** subcommands | **6** | `chunk-0y0ptpy9.js:4383` |
| `h` | value-taking flags the scanner does **not** count as flags | **3** | `chunk-0y0ptpy9.js:5387` |

The totals are therefore **88** value-taking flags (85 + the 3 carve-out), **45** boolean flags, **14** optional-value flags, **11** repeatable flags, **10** command tokens and **6** session subcommands — which is what the record's §3.4 concludes.

### The 85 value-taking flags

```
  --prefill                      --permission-mode
  --prefill-b64                  --inherit-permission-mode
  --deep-link-repo               --proactivity
  --deep-link-last-fetch         --debug-file
  --deep-link-cwd-b64            --system-prompt
  --handle-uri                   --system-prompt-file
  --settings                     --append-system-prompt
  --managed-settings             --append-system-prompt-file
  --setting-sources              --system-prompt-snapshot
  --client-data-url              --append-subagent-system-prompt
  --watch-artifact               --append-subagent-system-prompt-file
  --watch-artifact-no-autoreact  --plan-mode-instructions
  --team-name                    --permission-prompt-tool
  --agent-id                     --permission-prompts
  --agent-name                   --json-schema
  --agent-color                  --fallback-model
  --parent-session-id            --advisor
  --agent-type                   --agents
  --model                        --name
  --agent                        -n
  --routine                      --allowedTools
  --effort                       --allowed-tools
  --fast-mode                    --disallowedTools
```

```
  --disallowed-tools             --plugin-dir
  --tools                        --plugin-dir-no-mcp
  --add-dir                      --plugin-url
  --mcp-config                   --remote-control-session-name-prefix
  --betas                        --exec
  --file                         -m
  --channels                     --sdk-url
  --dangerously-load-development-channels
                                 --thinking
  --autocompact                  --thinking-display
  --rewind-files                 --max-thinking-tokens
  --resume-session-at            --max-turns
  --resume-drops-turn            --max-budget-usd
  --workload                     --task-budget
  --output-format                --teammate-mode
  --input-format                 --messaging-socket-path
  --session-id                   --environment
  --pool                         --ref
  --on-branch                    --correlation-id
  --forward-home-settings        --project-config-root
  --attach-serve
```

### The 11 repeatable flags

```
  --allowedTools                 --allowed-tools
  --disallowedTools              --disallowed-tools
  --tools                        --add-dir
  --mcp-config                   --betas
  --file                         --channels
  --dangerously-load-development-channels
```

### The 14 optional-value flags

```
  -d                             --debug
  -r                             --resume
  --from-pr                      -w
  --worktree                     --teleport
  --cloud                        --remote
  --project                      --remote-control
  --rc                           --prompt-suggestions
```

### The 45 boolean flags

```
  -d2e                           --debug-to-stderr
  --verbose                      -p
  --print                        --bare
  --safe-mode                    --init
  --init-only                    --maintenance
  --include-hook-events          --include-partial-messages
  --forward-subagent-text        --session-mirror
  --await-claim                  --await-initialize
  --dangerously-skip-permissions --allow-dangerously-skip-permissions
  --replay-user-messages         --host-auth-is-org-sign-in
  --enable-auth-status           --restricted
  --allow-other-models           --exclude-dynamic-system-prompt-sections
  --include-unsupported-models   -c
  --continue                     --fork-session
  --deep-link-origin             --no-session-persistence
  --reply-on-resume              --ide
  --desktop                      --strict-mcp-config
  --disable-slash-commands       --chrome
  --no-chrome                    --tmux
  --enable-auto-mode             --bg
  --background                   --brief
  --ax-screen-reader             --plan-mode-required
  --hard-fail
```

### The 10 command tokens

```
  -p                             --print
  --bg                           --background
  --routine                      -h
  --help                         -v
  -V                             --version
```

### The 6 session-management subcommands

```
  attach                         logs
  stop                           kill
  respawn                        rm
```

### The 3 flags the scanner does not count

```
  --exec                         -m
  --handle-uri
```

### The argument hints

The **argument hint** of a flag is the target's own, read from the root command's option declarations in `chunk-t0c9yez3.js` (and from `chunk-081t8575.js:75750`, where the target registers `--model` with the alias `-m`). The hint says what shape a flag's value has, and this implementation carries all of them.

| Flag | Hint | Flag | Hint |
|---|---|---|---|
| `--model` | `<model>` | `--session-id` | `<uuid>` |
| `--allowedTools`, `--allowed-tools` | `<tools...>` | `--output-format` | `<format>` |
| `--disallowedTools`, `--disallowed-tools` | `<tools...>` | `--input-format` | `<format>` |
| `--tools` | `<tools...>` | `--permission-mode` | `<mode>` |
| `--add-dir` | `<directories...>` | `--resume-session-at` | `<message id>` |
| `--mcp-config` | `<configs...>` | `--system-prompt` | `<prompt>` |
| `--betas` | `<betas...>` | `--json-schema` | `<schema>` |
| `--file` | `<specs...>` | `--fallback-model` | `<model>` |
| `--channels` | `<servers...>` | `--attach-serve` | `<session_id>` |
| `--dangerously-load-development-channels` | `<servers...>` | `--handle-uri` | `<uri>` |
| `--name`, `-n` | `<name>` | `--exec` | `<command>` |
| `--settings` | `<file-or-json>` | `--routine` | `<name>` |
| `--forward-home-settings` | `<true\|false>` | `--project` | `<name>` |
| `--resume` | `[value]` | `--debug` | `[filter]` |
| `--teleport` | `[session]` | `--cloud` | `[description\|session_id\|url]` |
| `--remote` | `[description\|session_id\|url]` | `--worktree` | `[name]` |
| `--from-pr` | `[value]` | `--prompt-suggestions` | `[value]` |
| `--remote-control`, `--rc` | `[name]` | `--verbose` | *(no value)* |

## The command tokens (REA observed)

A token is a **command**, not a flag, when it is one of `-p`, `--print`, `--bg`, `--background`, `--routine`, `-h`, `--help`, `-v`, `-V`, `--version`, or when it starts with `--routine=`.

The **session-management subcommands** are `attach`, `logs`, `stop`, `kill`, `respawn`, `rm` — the set `g` of `chunk-0y0ptpy9.js:4383`.

## The subcommand tree (REA observed)

**Source of truth:** the target's own command registrations, read against the record's §G3 table:

| Group | Entries | Where |
|---|---|---|
| `plugin` (alias `plugins`) | 19 | `chunk-64447bxa.js:16382`, and its description registry at `chunk-kctf5bfr.js:693` |
| `mcp` | 15 | `chunk-dmqgh1rk.js:19834` |
| `auth` | 4 | `chunk-9y799w6p.js:34608` |
| `auto-mode` | 5 | `chunk-9y799w6p.js:39124` |
| `sandbox` (hidden) | 3 | `chunk-9y799w6p.js:42028` |
| `project` (hidden) | 3 | `chunk-9y799w6p.js:21667` |
| the **root** commands | 13 | `chunk-9y799w6p.js` |
| the **hidden editor** commands | 7 | `chunk-mancccdx.js:2065` |
| the **session-management** subcommands | 6 | `chunk-0y0ptpy9.js:4383` |

**77** entries in all: **8** groups and **69** commands.

The record says "~60 subcommands in eight groups"; the reading against the source finds **77** entries. The difference is that the record's table lists the *leaf* commands and leaves out the **group** nodes (`plugin marketplace`, `mcp xaa`) and the two registrations of `purge` — the visible `purge` at the root and the hidden `project purge` — and the three root commands the record's row does not name (`apply-project-settings`, `import-conversations`, `edit-hook`).

### The table

| Path | Usage | Hidden | Where |
| --- | --- | --- | --- |
| `plugin` | `plugin` | no | `chunk-64447bxa.js:16382` |
| `plugin init` | `plugin init <name>` | no | `chunk-64447bxa.js:16669` |
| `plugin validate` | `plugin validate <path>` | no | `chunk-64447bxa.js:17288` |
| `plugin tag` | `plugin tag [path]` | no | `chunk-64447bxa.js:17778` |
| `plugin list` | `plugin list` | no | `chunk-64447bxa.js:18371` |
| `plugin eval` | `plugin eval [target]` | no | `chunk-64447bxa.js:19085` |
| `plugin eval init` | `plugin eval init [name]` | no | `chunk-64447bxa.js:23408` |
| `plugin test` | `plugin test [dir]` | yes | `chunk-64447bxa.js:24175` |
| `plugin details` | `plugin details <name>` | no | `chunk-64447bxa.js:24806` |
| `plugin marketplace` | `plugin marketplace` | no | `chunk-64447bxa.js:25087` |
| `plugin marketplace add` | `plugin marketplace add <source>` | no | `chunk-64447bxa.js:25180` |
| `plugin marketplace list` | `plugin marketplace list` | no | `chunk-64447bxa.js:26599` |
| `plugin marketplace remove` | `plugin marketplace remove <name>` | no | `chunk-64447bxa.js:26900` |
| `plugin marketplace update` | `plugin marketplace update [name]` | no | `chunk-64447bxa.js:27489` |
| `plugin install` | `plugin install <plugin>` | no | `chunk-64447bxa.js:27903` |
| `plugin uninstall` | `plugin uninstall <plugin>` | no | `chunk-64447bxa.js:30601` |
| `plugin prune` | `plugin prune` | no | `chunk-64447bxa.js:31451` |
| `plugin enable` | `plugin enable <plugin>` | no | `chunk-64447bxa.js:31968` |
| `plugin disable` | `plugin disable [plugin]` | no | `chunk-64447bxa.js:32434` |
| `plugin update` | `plugin update <plugin>` | no | `chunk-64447bxa.js:32953` |
| `plugin configure` | `plugin configure <plugin>` | no | `chunk-64447bxa.js:34171` |
| `mcp` | `mcp` | no | `chunk-dmqgh1rk.js:19834` |
| `mcp add` | `mcp add <name> <commandOrUrl> [args...]` | no | `chunk-dmqgh1rk.js:10959` |
| `mcp add-json` | `mcp add-json <name> <json>` | no | `chunk-dmqgh1rk.js:22953` |
| `mcp add-from-claude-desktop` | `mcp add-from-claude-desktop` | no | `chunk-dmqgh1rk.js:23455` |
| `mcp remove` | `mcp remove <name>` | no | `chunk-dmqgh1rk.js:20925` |
| `mcp list` | `mcp list` | no | `chunk-dmqgh1rk.js:21324` |
| `mcp get` | `mcp get <name>` | no | `chunk-dmqgh1rk.js:21777` |
| `mcp login` | `mcp login <name>` | no | `chunk-dmqgh1rk.js:22243` |
| `mcp logout` | `mcp logout <name>` | no | `chunk-dmqgh1rk.js:22688` |
| `mcp reset-project-choices` | `mcp reset-project-choices` | no | `chunk-dmqgh1rk.js:23757` |
| `mcp serve` | `mcp serve` | no | `chunk-dmqgh1rk.js:19948` |
| `mcp xaa` | `mcp xaa` | no | `chunk-dmqgh1rk.js:15447` |
| `mcp xaa setup` | `mcp xaa setup` | no | `chunk-dmqgh1rk.js:15519` |
| `mcp xaa login` | `mcp xaa login` | no | `chunk-dmqgh1rk.js:17310` |
| `mcp xaa show` | `mcp xaa show` | no | `chunk-dmqgh1rk.js:18798` |
| `mcp xaa clear` | `mcp xaa clear` | no | `chunk-dmqgh1rk.js:19460` |
| `auth` | `auth` | no | `chunk-9y799w6p.js:34608` |
| `auth login` | `auth login` | no | `chunk-9y799w6p.js:34685` |
| `auth status` | `auth status` | no | `chunk-9y799w6p.js:35187` |
| `auth logout` | `auth logout` | no | `chunk-9y799w6p.js:35574` |
| `auto-mode` | `auto-mode` | no | `chunk-9y799w6p.js:39124` |
| `auto-mode defaults` | `auto-mode defaults` | no | `chunk-9y799w6p.js:39214` |
| `auto-mode config` | `auto-mode config` | no | `chunk-9y799w6p.js:39695` |
| `auto-mode reset` | `auto-mode reset` | no | `chunk-9y799w6p.js:40064` |
| `auto-mode critique` | `auto-mode critique` | no | `chunk-9y799w6p.js:40453` |
| `sandbox` | `sandbox` | yes | `chunk-9y799w6p.js:42028` |
| `sandbox install` | `sandbox install` | yes | `chunk-9y799w6p.js:42069` |
| `sandbox status` | `sandbox status` | yes | `chunk-9y799w6p.js:42363` |
| `project` | `project` | yes | `chunk-9y799w6p.js:21667` |
| `project purge` | `project purge [path]` | yes | `chunk-9y799w6p.js:21776` |
| `purge` | `purge [path]` | no | `chunk-9y799w6p.js:21776` |
| `gateway` | `gateway` | no | `chunk-9y799w6p.js:33972` |
| `setup-token` | `setup-token` | no | `chunk-9y799w6p.js:35913` |
| `agents` | `agents` | no | `chunk-9y799w6p.js:36231` |
| `ultrareview` | `ultrareview [target]` | no | `chunk-9y799w6p.js:38379` |
| `remote-control` | `remote-control` | yes | `chunk-9y799w6p.js:40856` |
| `doctor` | `doctor` | no | `chunk-9y799w6p.js:41274` |
| `apply-project-settings` | `apply-project-settings` | yes | `chunk-9y799w6p.js:41592` |
| `update` | `update` | no | `chunk-9y799w6p.js:42646` |
| `install` | `install [target]` | no | `chunk-9y799w6p.js:42825` |
| `import` | `import` | no | `chunk-9y799w6p.js:43139` |
| `import-conversations` | `import-conversations <exportPath>` | yes | `chunk-9y799w6p.js:43668` |
| `edit-hook` | `edit-hook` | yes | `chunk-9y799w6p.js:20517` |
| `edit-permission-rules` | `edit-permission-rules` | yes | `chunk-mancccdx.js:2065` |
| `edit-memory-settings` | `edit-memory-settings` | yes | `chunk-mancccdx.js:2821` |
| `edit-skill-overrides` | `edit-skill-overrides` | yes | `chunk-mancccdx.js:3554` |
| `edit-sandbox-settings` | `edit-sandbox-settings` | yes | `chunk-mancccdx.js:4304` |
| `design-login` | `design-login` | yes | `chunk-mancccdx.js:5036` |
| `edit-chrome-settings` | `edit-chrome-settings` | yes | `chunk-mancccdx.js:6017` |
| `drop-worktree-registrations` | `drop-worktree-registrations` | yes | `chunk-mancccdx.js:6759` |
| `attach` | `attach <session>` | no | `chunk-0y0ptpy9.js:4383` |
| `logs` | `logs <session>` | no | `chunk-0y0ptpy9.js:4383` |
| `stop` | `stop <session>` | no | `chunk-0y0ptpy9.js:4383` |
| `kill` | `kill <session>` | no | `chunk-0y0ptpy9.js:4383` |
| `respawn` | `respawn <session>` | no | `chunk-0y0ptpy9.js:4383` |
| `rm` | `rm <session>` | no | `chunk-0y0ptpy9.js:4383` |

The six **session-management** subcommands are the target's set `g`, and the target's set carries the six names and **no description** — the descriptions in the table are this implementation's own.

### The aliases

| Alias | The command it answers to |
|---|---|
| `plugins` | `plugin` |
| `new` | `plugin init` |
| `i` | `plugin install` |
| `remove`, `rm` | `plugin uninstall` |
| `autoremove` | `plugin prune` |
| `rm` | `plugin marketplace remove` |
| `rc` | `remote-control` |
| `upgrade` | `update` |

### The clone-choice labels this milestone adds

| Label | What it means | Which entries |
|---|---|---|
| **implemented** | the parser knows the entry, and the dispatcher reaches its handler | none — this implementation runs **no** command of the tree |
| **refused** | the parser knows the entry, the dispatcher reaches it, and the refusal names the **capability** the command needs and this implementation does not have | all **69** commands |

The refusal's wording is this implementation's own:

```
The '<path>' command is not implemented here yet: this implementation has no <capability>.
```

A command that is refused is **not** silently dropped: it is in the tree, it is in the help, and naming it says what would have to exist for it to run.

### What the target's product name is replaced by

The tree reproduces the target's **data** — the paths, the usage strings, the descriptions, the aliases, the hidden flag and the offsets. It does not reproduce the target's **product name**: where the target's own text names its product, this implementation says **PRRICODE**.

The target's *environment variables*, *model ids*, *API hosts* and *file names* keep the target's names, because those are the data the implementation has to speak to: `CLAUDE.md`, `.claude/`, `.claude-plugin/`, `claude.ai`, `claude-sonnet-4-5`, and the command name `mcp add-from-claude-desktop`, are unchanged.

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

## The documents a run writes (REA observed)

**Source of truth:** the target's own source, read into
`/home/shiva/opt/reference-agent-rea/analysis/findings-permissions-and-headless.md` §2.
Every claim below carries a file and a byte offset there.

| Format | stdout | stderr | Exit code |
|---|---|---|---|
| `text` | the result document's `result` text, plus a newline | the failure's detail, when the run failed | `0` on success, `1` on failure |
| `json` | **exactly one** document: the **result** document | — | as above |
| `stream-json` | **one document per line**, one per message, the **result** last | — | as above |

The **result document** is the target's own, and this implementation builds it: the member set, the member **order** and the nested shapes are the target's (`chunk-pj5cyqhw.js:300922` for the success variant, `:326977` for the error variant, `:178563` for the `usage` object and `:288789` for a `permission_denials` entry). The target builds the document by spreading the **common** members, then the **variant** members, then `type`, `duration_ms` and `uuid` (`chunk-pj5cyqhw.js:171561`), and this implementation does the same — so the members arrive on the wire in the target's order.

The members the target fills and this implementation cannot are the target's **own defaults**: `total_cost_usd` is `0` and `modelUsage` is the empty record (this implementation has no cost model and no per-model ledger), and `duration_api_ms` is `0` (this implementation does not time the provider's requests separately from the turn). The `usage` object is the target's own zeroed object with the token counts filled in (`chunk-05nax923.js:11`).

A `--print` run **is a session**: the result document carries a `session_id`, and the session's transcript is appended to disk as the turn runs — the append-only JSONL the [session format](session-format.md) describes — unless `--no-session-persistence` turns it off. The split is: **stdout carries the format's output; the disk carries the transcript.**

### The three divergences this milestone keeps, in the output

**Implementation choice, deliberate.** Each is pinned by a contract test this milestone does not own (`tests/contracts/cli-surface.test.ts`), and each is **named** here rather than hidden.

| # | The target's own behaviour | This implementation | Why |
|---|---|---|---|
| 1 | the error variant's `subtype` is one of `error_during_execution`, `error_max_turns`, `error_max_budget_usd` and `error_max_structured_output_retries` (`chunk-pj5cyqhw.js:326977`) | `error` | the `CC-014` contract test pins `subtype: 'error'` for a failed run, in both the `json` and the "no result event" cases |
| 2 | a run that produced **no** result document writes `Error: No messages returned from query` to **stderr**, writes **nothing** to stdout and exits `1` (`chunk-e7w77ts3.js:529318`) | a document that says the run failed | the `CC-014` contract test pins a document on stdout for that case |
| 3 | the `text` format writes the result's text at the **end of the turn** and, on a failure, the format's own line on stdout (`Execution error`, `Error: Reached max turns (n)`, …) with the failure's detail on stderr (`chunk-e7w77ts3.js:445913`) | the assistant's text as it arrives, and nothing on stdout for a failure | the `CC-014` contract test pins the text format's stdout and stderr for both the success and the failure case |

The **stream-json** documents are this implementation's **events**, one per line, with the target's **result** document last. The target's own documents are the SDK message kinds — `system`/`init`, `assistant`, `user`, `stream_event` and `result` (`chunk-pj5cyqhw.js:333857`, `:261767`, `:239906`, `:352585`) — and this implementation's event vocabulary is its own; the result document is the target's, because the target's `json` format writes exactly that document.

**Pinned by:** `tests/contracts/headless-output.test.ts` — the result document's members and their order, the three formats' stdout, and the turn's own accounting.

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

### The boolean-flag deviation — **now resolved against the audit**

**The audit was wrong, and the target's own source settles it.** The audit describes the **boolean** set as consuming the next non-flag token. The target's parser (`chunk-0y0ptpy9.js`) says the opposite: a boolean flag owns **nothing**, and the optional value belongs to a set of **fourteen** flags (`-d`, `--debug`, `-r`, `--resume`, `--from-pr`, `-w`, `--worktree`, `--teleport`, `--cloud`, `--remote`, `--project`, `--remote-control`, `--rc`, `--prompt-suggestions`).

This implementation now applies the optional value to **all fourteen**, which is the target's rule, and the boolean set is **pure** — as the target's own root command declares it (`-p, --print`, `-c, --continue`, `--verbose`, … carry no argument). The narrowing this implementation made in `CC-014` is therefore **withdrawn**: the target's own behaviour is reproduced everywhere, and the divergence is gone.

### The three divergences this milestone keeps

**Implementation choice, deliberate.** Three places where this implementation's behaviour is not the target's, each pinned by an existing contract test:

| The flag | The target's own rule | This implementation | Why |
|---|---|---|---|
| `-d2e` | a **short form** of `--debug-to-stderr`, and a boolean flag of the target's `f` set | an **unknown option** | the `CC-014` contract test and the compatibility scenario `F-01` both pin the message `Error: unknown option '-d2e'.` The **vocabulary** still carries it among the target's forty-five boolean flags, and the target's own scanner (`isKnownFlag`) still counts it — only the **parser** refuses it |
| `--attach-serve` | a **value** flag, `--attach-serve <session_id>`: it owns the next token, and a line without one is a missing-argument error | it owns the next token only when that token does **not** look like a flag | the `CC-014` contract test pins both the target's `--attach-serve` message for a line that gives the flag without a session id, and that the flag does not swallow the `--print` that follows it. The **vocabulary** still carries it among the target's eighty-five value flags |
| `--print=<value>` | the target declares `--print` as a **boolean**, and takes the prompt from the positional argument | `--print=<value>` names the prompt | this implementation's own extension, kept because the `CC-014` contract test pins it |

### The discrepancies between the record and the target's source

The record's §3.4 and §G3 were read against the target's own source, and the two readings disagree in five places. The **parser's** reading is the one this implementation follows, for the same reason the `CC-030` milestone followed the parser's reading of the slash-command registry: the registry is the target's, and a thing the target registers is a thing the surface holds.

| # | The record says | The target's source says | The reading this implementation took |
|---|---|---|---|
| 1 | "roughly ninety value-taking flags and forty boolean ones" | exactly **85** value-taking (+ the 3 carve-out = 88) and **45** boolean | the **source**: the exact figures are 85 + 3 and 45, and the record's own §3.4 totals agree |
| 2 | the **boolean** set consumes the next non-flag token, and `-r`/`--resume` is the flag that takes an optional value | the boolean set consumes **nothing**; the **optional-value** set has **fourteen** members | the **source**: the optional value is applied to all fourteen, and the boolean set is pure. The `CC-014` narrowing is withdrawn |
| 3 | "~60 subcommands in eight groups" | **77** entries: **8** groups and **69** commands | the **source**: the record's table lists the leaf commands and leaves out the group nodes (`plugin marketplace`, `mcp xaa`), the two registrations of `purge`, and the three root commands its row does not name (`apply-project-settings`, `import-conversations`, `edit-hook`) |
| 4 | the record's `plugin` row lists **18** subcommands | the target registers **19** entries under `plugin` (the record's list plus the `marketplace` **group** node) | the **source**: the group node is in the tree, because it is a thing the target registers |
| 5 | the target's flag registry ends with `...[]]` — a spread of an **empty** array — in the value and boolean sets | the same | the **source**, as extracted: the literal members are the whole of both sets, and the counts are 85 and 45. The spread is recorded here so that a reader who finds it knows it was seen |

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

This milestone extends the rule from the audit's seventeen names to **every** flag of the target's vocabulary that the run does not act on. The parser knows **144** flags, and there is no third case for any of them — a flag is either acted on or refused:

| | How many | Which |
|---|---|---|
| **acted on** by the run | **19** | `--model`, `--settings`, `--allowedTools`, `--allowed-tools`, `--disallowedTools`, `--disallowed-tools`, `--tools`, `--add-dir`, `--output-format`, `--input-format`, `--session-id`, `--resume-session-at`, `--permission-mode`, `--continue`, `--resume`, `--fork-session`, `--init-only`, `--dangerously-skip-permissions`, `--print` |
| **refused by the run** | **115** | every flag of the vocabulary that is not acted on, and not one of the four rows below |
| **refused by the background mode** | **2** | `--bg`, `--background` |
| **the short form** of a flag above | **7** | `-n`, `-m`, `-c`, `-r`, `-p`, `-d`, `-w` |
| **refused by the parser** as an unknown option | **1** | `-d2e` |

The contract test "refuses every flag of the target's vocabulary that the run does not act on" says so, and the refusal list itself is checked against the vocabulary from the other side.

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

The **rest** of the refused flags — the target's other **98** — are refused for the same reason and with the same shape; their reason is in `UNIMPLEMENTED_OPTIONS` in [`src/cli/command.ts`](../../src/cli/command.ts), one line each, next to the flag it names.

The **parser** still knows every one of them, so the audit's own validation messages fire first.

### The unimplemented commands

**Implementation choice.** The target's command tree holds **69** commands, and this implementation runs **none** of them: the plugin manager, the MCP configuration surface, the account sign-in, the auto mode classifier configuration, the Windows sandbox, the project purge, the enterprise gateway, the autoupdater, the native build installer, the agent importers, the remote control and the editor bridge are all **later milestones** or **other products**.

Each command is therefore **recognised** — the parser knows its path, its aliases and its arguments — and **refused** with a message that names the capability it needs:

```
The 'plugin init' command is not implemented here yet: this implementation has no plugin manager.
```

A **group** named with no command of its own writes the group's help to the error stream and exits with `1`; a group named with a command it does not have is an **unknown command** and exits with `2`.

### The stream-json input

**Implementation choice.** The audit records that the input format is `text` or `stream-json`, that `--input-format=stream-json` requires `--output-format=stream-json` and that it requires `--print` — and **nothing** about the shape of a document.

This implementation reads the shape the target's own SDK protocol uses: the standard input carries **JSON documents**, one per line, and each of them is a **user message** whose content is a string or an array of `{type: 'text', text}` blocks. The **text** of the documents is the prompt — the model never sees the raw blob.

**A limitation, stated rather than hidden:** this implementation's headless run makes **one** turn, so a stream-json input that carries several user messages contributes the text of all of them to that one turn. The target's stream-json input drives a **persistent session**, one turn per message.

### The other implementation choices

| Choice | What this implementation does | Why it is this implementation's |
|---|---|---|
| The **short flag cluster** | the pattern is widened to `^-[A-Za-z0-9]{2,}$`, so the target's own example (`-d2e`) is one token; it is expanded only when **every** letter is a known short flag | the target's pattern does not match its own example, and the target does not expand clusters at all — its own `S()` treats a cluster as a *command token* |
| The **bare command** | a command's name is a command when it comes **first** | the target's dispatcher is commander's, and a command's name is always its first argument; the first token is the only placement that cannot swallow a prompt |
| The **command tree** | the target's **77** entries are recognised and **refused** by the run | the target's commands need capabilities this implementation does not have — see "The unimplemented commands" |
| The **background mode** | recognised and refused by the run | this implementation does not run it |
| The **default model** | `claude-sonnet-4-5` | the audit does not record the target's default model |
| The **version** | this implementation's own `package.json` version | this implementation does not claim to be the reference agent |
| The **help text** | this implementation's own, **generated** from the vocabulary and the tree | the audit records the flag names and no help text; generating it means the help and the parser cannot drift apart |
| The **output documents** | the **result** document is the target's own — its member set, its member order and its nested shapes; the other documents are this implementation's own events | the audit pinned the three formats and nothing about the documents; the reading that establishes them is `findings-permissions-and-headless.md` §2, and the three divergences this milestone keeps are named above |
| The **exit codes** | `0` success, `1` failure, `2` an argument error | the audit records this implementation's two known ones |
| The **gateway condition** | the settings key `useGateway` | the target's condition (`Br() \|\| aet() \|\| cet()`) is not resolved in the REA record |
| The **manager surfaces** | `/provider`, `catalog`, and their `--provider` / `--catalog` forms | a **project extension** — see [`provider-catalog.md`](provider-catalog.md) |
| The **run's credential** | the **active connection's** credential, resolved through `resolveConnectionCredential`; a run with **no** connection is exactly the run it always was | a **project extension** — the target has no connection table, and its credential comes from the environment. See [`provider-catalog.md`](provider-catalog.md), "A run uses the active connection" |

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
| The **optional value** belongs to the target's **fourteen** optional-value flags, and the **boolean** set is pure | REA observed (the target's parser) — the audit's summary was wrong | F-38 | same file — the "the target’s flag shapes" block: "gives an optional-value flag the next token only when it does not look like a flag", "gives a boolean flag nothing" |
| A **value** flag owns the next token, whether or not that token looks like a flag | REA observed | F-38 | same file — "gives a value flag the next token, even one that looks like a flag" |
| A **repeatable** flag owns the next token whatever it looks like | REA observed | F-38 | same file — "gives a repeatable flag a first token that looks like a flag" |
| The **three** flags the target's scanner does not count (`--exec`, `-m`, `--handle-uri`) | REA observed | F-38 | same file — "counts the three flags the target’s scanner does not count" |
| The target's **flag registry**: 85 value-taking, 11 repeatable, 14 optional-value, 45 boolean, 10 command tokens, 6 session subcommands, 3 carve-out | REA observed | F-38 | same file — the "the complete flag vocabulary" block |
| The target's **argument hints** | REA observed | F-38 | same file — "carries the target’s argument hints" |
| The target's **parser**: the flag test, the command-token test, the first-positional rule and the session-subcommand rule | REA observed | F-38 | same file — "reproduces the target’s command-token test", "reproduces the target’s first-positional rule", "reproduces the target’s session-subcommand rule" |
| The target's **command tree**: 77 entries in eight groups, with their usages, aliases, hidden flags and offsets | REA observed | F-38 | same file — the "the subcommand tree" block |
| Every command of the tree **dispatches**, and the ones this implementation does not have are **refused** with a named capability | **implementation choice** (the refusal) | F-38 | same file — the "the command dispatch" block |
| The six session-management subcommands are the target's, and a bare command is a command when it comes first | REA observed (the names) + implementation choice (the placement) | F-01 | same file — "recognises the six subcommands" |
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
| Every option this implementation recognises and does not implement is **refused by the run** | **implementation choice** | F-38 | same file — the "the flags this implementation refuses" block, and the "the flags the run refuses" block |
| Every flag of the target's vocabulary is either **acted on** or **refused** — there is no third case | **implementation choice** | F-38 | same file — "refuses every flag of the target’s vocabulary that the run does not act on" |
| The stream-json input carries JSON documents, and the model receives their **text** | **implementation choice** | F-02 | same file — "reads the text the documents carry", "runs the turn with the text the documents carry, not the raw blob", "refuses a line that is not JSON" |
| The exit codes are `0`, `1` and `2` | REA observed (the two the audit names) + implementation choice (the names) | F-38 | same file — "returns the argument error’s exit code and writes the message to stderr" |
| The `--settings` file is loaded as the highest-precedence overlay | **implementation choice** | F-38 | same file — "loads the settings file the --settings flag names", "refuses a settings file it cannot read" |
| The start mode: the flag, the settings' default, and the three availability overrides | REA observed (the rules) + implementation choice (the wiring) | F-38 | same file — "starts in the mode the --permission-mode flag names", "does not start in auto mode when a policy disables it", "does not start in auto mode for a HIPAA-configured session" |
| The in-session slash-command registry: the names, the descriptions, the aliases, the argument hints and the offsets | REA observed | F-38 | same file — the "the slash-command registry" block, and the "the autocomplete overlay" block |
| The manager surfaces are reachable from the command line | **project extension** | F-40 | same file — "runs the multi-provider manager and returns its exit code" — and [`provider-catalog.md`](provider-catalog.md) |
