# Command-line surface conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.10 ("The command-line surface") and this implementation-choice labels the source carries in [`src/cli/args.ts`](../../src/cli/args.ts), [`src/cli/command.ts`](../../src/cli/command.ts), [`src/cli/headless.ts`](../../src/cli/headless.ts) and [`src/cli/output.ts`](../../src/cli/output.ts).
**Owning task:** `CC-014` (the parser, the headless mode, the output contracts) and `CC-016` (the multi-provider manager) in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
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

| Audit claim | Evidence class | Pinned by |
|---|---|---|
| `--flag=value` yields the value, and `--` ends the flag parsing | REA observed | `tests/contracts/cli-surface.test.ts` — "reads the value of --flag=value", "ends the flag parsing at --" |
| A token is a flag when it has more than one character and starts with `-` | REA observed | same file — "does not read a flag after --" |
| A short flag cluster is one token, and it is expanded only when every letter is known | REA observed + implementation choice (the widened pattern) | same file — "treats a short flag cluster as one token", "expands a short flag cluster whose letters are all known flags" |
| The repeatable set is the audit's eleven names, and each consumes every following non-flag token | REA observed | same file — "consumes every following non-flag token for a repeatable flag" |
| The optional value belongs to `-r`/`--resume`, and the **rest** of the boolean set is pure | REA observed (the flag) + **implementation choice** (the narrowing) | same file — "keeps the optional value of --resume", "takes no value for --resume when the next token is a flag", "keeps the prompt out of a boolean flag" |
| The six subcommands are the target's, and a bare subcommand is a command when it comes first | REA observed (the names) + implementation choice (the placement) | same file — "recognises the six subcommands" |
| The command tokens are commands, not flags | REA observed | same file — "takes one prompt argument for -p", "takes -c as the short form of --continue" |
| The session-id pattern, and the scan of a path for such a segment | REA observed | same file — "recognises the target’s session-id pattern", "scans a path for a session-id segment" |
| The cloud session ref and the URI arguments | REA observed | same file — "knows the cloud session ref and the URI arguments" |
| The headless rule: `--print`, `--init-only`, `--sdk-url` or a non-TTY stdout | REA observed | same file — "forces the headless mode when stdout is not a terminal", "forces the headless mode for --print, --init-only and --sdk-url" |
| The three output formats and the two input formats | REA observed | same file — "accepts the three output formats" |
| The **fourteen** validation messages, verbatim | REA observed | same file — the "the target's validation messages" block, one test per message |
| The `<mode>` placeholder's three rows, and which mode each decides | REA observed (the messages) + **implementation choice** (the reading) | same file — "reproduces the mode and resume message", "reproduces the mode and --init-only message", "reproduces the mode and --session-id message", "reproduces the mode and stream-json output message" |
| The invalid output format's wording | **implementation choice** | same file — "refuses an unknown output format" |
| The invalid permission mode's wording | **implementation choice** | same file — "refuses an unknown permission mode" |
| `--help` and `--version` win wherever they appear | **implementation choice** | same file — "writes the help whatever the order of the flags", "writes the version whatever the order of the flags" |
| An empty `--print=` is no value at all | **implementation choice** | same file — "takes an empty --print= as no prompt at all" |
| The print mode takes one prompt argument, and `--continue` and `--resume` are mutually exclusive | implementation choice | same file — "refuses a second prompt argument in print mode", "refuses --continue together with --resume" |
| Every option this implementation recognises and does not implement is **refused by the run** | **implementation choice** | same file — the "the flags this implementation refuses" block |
| The stream-json input carries JSON documents, and the model receives their **text** | **implementation choice** | same file — "reads the text the documents carry", "runs the turn with the text the documents carry, not the raw blob", "refuses a line that is not JSON" |
| The exit codes are `0`, `1` and `2` | REA observed (the two the audit names) + implementation choice (the names) | same file — "returns the argument error’s exit code and writes the message to stderr" |
| The `--settings` file is loaded as the highest-precedence overlay | **implementation choice** | same file — "loads the settings file the --settings flag names", "refuses a settings file it cannot read" |
| The start mode: the flag, the settings' default, and the three availability overrides | REA observed (the rules) + implementation choice (the wiring) | same file — "starts in the mode the --permission-mode flag names", "does not start in auto mode when a policy disables it", "does not start in auto mode for a HIPAA-configured session" |
| The manager surfaces are reachable from the command line | **project extension** | same file — "runs the multi-provider manager and returns its exit code" — and [`provider-catalog.md`](provider-catalog.md) |
