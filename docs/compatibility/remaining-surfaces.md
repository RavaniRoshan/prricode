# The remaining surfaces — conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256
`375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Evidence:** `/home/shiva/opt/reference-agent-rea/analysis/findings-remaining-surfaces.md` — every claim there carries a file and a byte offset.
**Owning task:** `CC-041` in
[`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).

These are the seven surfaces the coverage audit never opened. Each is **implemented**,
**implemented with a named difference**, or **refused with the capability it needs** —
and the differences are named here rather than hidden.

---

## 1. The site-configuration bundle

**The target.** The target ships a default **site-configuration bundle**
(`chunk-f27ph7ed.js:260401`): `twoStageClassifier`, `sameTurnSiblingContext`,
`editRemovalVisibility`, `editRemovalCap: 3000`, `outcomeVisibility`, `repoVisibility`,
`gitStatusType`, `gitStatusUploads`, `tagConnectorWrites`, and the per-model
`severityByModel` table — `claude-sonnet-5[1m]` and `claude-sonnet-5` at
`{t1: 25, t2: 35}`, `claude-opus-4-8[1m]` and `claude-opus-4-8` at `{t1: 45, t2: 35}`.
The thresholds default to `{t1: 15, t2: 20}` (`chunk-4jsg44k7.js:1646178`) and the
resolution prefers **the bundle's own severity**, then **the per-model entry**, then
**the defaults** (`chunk-4jsg44k7.js:1646348`).

**This implementation.** `src/config/siteConfig.ts` ships the bundle with the target's
own data, frozen, and reproduces the resolution order exactly — including the
"off" value that switches the thresholds off for a site, the alias fallback, and the
rule that a value which is not a percentage in `[0, 100]` is not a threshold.

**The difference.** The thresholds are the **auto-mode safety classifier's** two-stage
thresholds: the classifier asks a model to classify a tool call and compares the
model's severity score with `t1` and `t2`. This implementation has **no auto-mode
safety classifier** — its `auto` mode takes the verdict from a caller-supplied
callback (`src/permissions/decision.ts`). The bundle is present and resolvable, and
**nothing applies it**. That difference is what the compatibility report recorded as
`F-32`.

---

## 2. The target's own git and GitHub rule templates

**The target.** Seven command templates (`chunk-4jsg44k7.js:1676004`):
`git checkout -b *`, `git add *`, `git status *`, `git commit -m *`,
`gh pr create --title * --body *`, `gh pr edit --title * --body *`, `gh pr view *`.
They become `Bash(...)` rules and `PowerShell(...)` rules
(`chunk-swcca8bf.js:3896`), and **one** PowerShell rule is dropped on purpose —
`PowerShell(git checkout -b *)`. The target also holds **certified** command prefixes
(`chunk-4jsg44k7.js:788097`) — `certified: git status`, `certified: git add`,
`certified: git commit`, `certified: git checkout -b`, `certified: git log`,
`certified: git diff`, `certified: git branch --show-current`,
`certified: gh pr create`, `certified: gh pr edit`, `certified: gh pr view`,
`certified: git push `, `certified: git push origin` — and **strips** the rules that
carry the marker out of the always-allow list before it decides
(`chunk-4jsg44k7.js:787667`).

**This implementation.** `src/permissions/templates.ts` carries all of it: the seven
templates, the five read-only git templates, the three tool names, the conversion, the
dropped PowerShell rule, the certified prefixes, and the stripping.

**The difference.** The target certifies the commands **it** runs. This
implementation has no certified-command source, so nothing certifies a command here
and the stripping has nothing to strip in an ordinary run.

---

## 3. The status line

**The target.** The `statusLine` setting is
`{type: "command", command, padding?, refreshInterval?, hideVimModeIndicator?}`
(`chunk-c9s0jh80.js:283237`). The target writes one JSON document to the command's
standard input (`chunk-4jsg44k7.js:2367468`) and takes the command's standard output
as the line; a failure is swallowed (`chunk-4jsg44k7.js:2366659`). The two constants
are a 300 ms debounce and a 1000 ms minimum gap (`chunk-4jsg44k7.js:2366573`). The
command is **not** run when `disableAllHooks` is true, and it is **skipped** when the
workspace trust is not accepted.

**This implementation.** `src/ui/statusLine.ts` builds the payload in the target's own
member order and with the target's own member names — they are an interface a user's
script reads — runs the command through the shell with the payload on standard input,
takes the standard output as the line, swallows a failure, and implements both gates
with the target's own messages. The `statusLine` setting was already in
`src/config/schema.ts`, in the target's own shape.

**The difference.** Two, and both are named:

  - the **`version` block** carries the running program's own build metadata, so this
    implementation writes **its own** there; the target's values are recorded in the
    findings file;
  - the target registers a status line **per interactive site** and re-runs it on the
    debounce, on the refresh interval and on every event that changes the payload.
    This implementation has no interactive-site registry, so the **scheduling** is a
    plain debounce and a refresh interval, and the interactive host does not yet
    render the line.

---

## 4. Output styles

**The target.** An output style is a **markdown file** under an `output-styles`
directory (`chunk-4jsg44k7.js:2255227`), in the configuration root and in every
project directory from the working directory up to the home directory
(`chunk-4jsg44k7.js:737660`). Its frontmatter carries `name`, `description`,
`keep-coding-instructions` and `force-for-plugin`, and the schema is **strict**
(`chunk-4jsg44k7.js:730783`). The description falls back to the first non-empty line
of the body, and the styles are sorted by the **depth** of their directory
(`chunk-4jsg44k7.js:737733`). The target ships **five** built-in styles — `default`,
`Proactive`, `Concise`, `Explanatory` and `Learning` (`chunk-4jsg44k7.js:2262166`) —
and the `/output-style` command lists them and saves the choice to the **local**
tier, `.claude/settings.local.json` (`chunk-qm7dk4mx.js:11720`).

**This implementation.** `src/config/outputStyles.ts` loads the styles in the target's
own shape and `src/config/outputStyleBuiltins.ts` carries the four built-in styles'
**own prompts**, transcribed out of the target's source by a script that copies the
literals — so the transcription cannot drift. The `/output-style` command lists the
styles, refuses an unknown one with the target's own wording, says when the style is
already the active one, and saves the choice to the project's local settings file the
way the target does.

**The difference.** The target also loads a plugin's `output-styles` directory. The
plugin **protocol** landed with `CC-040` — the manifest, the frontmatter, the
catalogue and the source types — but this implementation loads no plugin's
directory, so the styles it loads are the **file** styles only.

---

## 5. Cost and usage accounting

**The target.** The price row carries six numbers — the input, the output, the
five-minute cache write, the one-hour cache write, the cache read and the web search
— and the cost of a request is computed in US dollars per million tokens, with the
long-prompt tier, the two cache-write rates, the web-search price and the
data-residency factor of `1.1` (`chunk-dt3pd9ft.js:265535`). The **ledger**
(`chunk-d8mq0b21.js:25854`) keeps the cost, the API and tool durations, the changed
lines, the spent tokens and the per-model record; `recordCost` **replaces** a model's
record rather than adding to it (`chunk-4jsg44k7.js:712480`). The result document
carries `total_cost_usd` and `modelUsage` (`chunk-c9s0jh80.js:269535`).

**This implementation.** `src/provider/cost.ts` reproduces the price row, the cost
formula and the ledger, over the catalog's own `pricing_tiers` table
(`src/provider/catalogs/builtin.json`), and `src/cli/headless.ts` now fills the
result document's `total_cost_usd` and `modelUsage` instead of leaving the target's
zeroed defaults.

**The difference.** The target reads the **managed** `modelPricing` setting from a
machine-managed settings document, and the target's own rule is that the setting is
honoured **only** from that tier. This implementation has no managed tier, so the
multiplier and the overrides are read from the settings it does have, and the
`costBasis` a run reports can be `list` or `unknown` but never `managed`.

---

## 6. Checkpointing

**The target.** The setting is `fileCheckpointingEnabled`
(`chunk-c9s0jh80.js:320524`). The switch (`chunk-4jsg44k7.js:1244724`) is: **off** in
the SDK; in a host application, on only when `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`
is set and `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` is not; otherwise the **setting**
decides — and the setting **defaults to on** — with
`CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` switching it off whatever the setting says.
The history keeps a list of **snapshots**, each with the message it belongs to and the
**backup** of every file it tracks; the list is capped at **100**
(`chunk-kmrt4q1v.js:10067`) and the evicted snapshots' backups are deleted.

**This implementation.** `src/session/checkpoints.ts` reproduces the switch, the
snapshot shape, the cap and the eviction rule.

**The difference — a refusal.** The target's `/rewind` restores a file from a
**backup on disk**, and this implementation writes **no** backup store. The command
therefore **refuses**, and the refusal names the capability it needs: *a file backup
store, which `/rewind` restores a file from and this implementation does not write*.

---

## 7. The prompt-management surface

**The target.** `prompt.section` is one of the target's extension points
(`chunk-4jsg44k7.js:41782`). Its dispatch (`chunk-4jsg44k7.js:44481`) is: with no
handler, the section's text stands; with one, the handler receives **`{name, text}`**
and the result's **`text`** replaces it. The core handler is the identity
(`chunk-4jsg44k7.js:53395`). The `type:"prompt"` command kind is a whole command
shape (`chunk-4jsg44k7.js:1742093`): `progressMessage`, `contentLength`,
`userFacingName()`, `source`, `disableModelInvocation`, `allowedTools`,
`disallowedTools`, `policyGate`, `requires` and `getPromptForCommand()`. The five
built-in prompt commands and their progress messages are `commit-push-pr` ("creating
commit and PR", `chunk-4jsg44k7.js:1683834`), `init` ("analyzing your codebase",
`:1713935`), `team-onboarding` ("scanning usage data", `:1732230`), `statusline`
("setting up statusLine", `:2198875`) and `insights` ("analyzing your sessions",
`:2203807`). The flags the sweep found — `--permission-prompt-tool`,
`--permission-prompts` (`chunk-0y0ptpy9.js:1112`), `/heapdump`
(`chunk-4jsg44k7.js:2181918`), `pause-memory` (`:1683784`) and `edit-chrome-settings`
— are already carried by this implementation.

**This implementation.** `src/extensions/prompts/section.ts` implements the section
composition, and `src/cli/commands/slash.ts` gives the `type:"prompt"` command kind
the target's own shape — the progress message, the content length, the source, the
model-invocation flag, the policy gate and the requirements — with the target's own
values for the five built-in prompt commands.

**The differences.**

  - a handler that returns **no** text leaves the section as it was. The target would
    take the missing text as it stands, which is a footgun this implementation does
    not reproduce;
  - the prompt commands' **prompts themselves** are not reproduced: the target builds
    them from the repository's own state and from a plugin, and this implementation
    **refuses** each of the five with the capability it needs (a built-in
    commit-and-pull-request prompt, a built-in codebase-documentation prompt, a
    built-in team-onboarding prompt, a status-line setup agent, a built-in
    session-insights prompt).

---

## Conformance table

| Audit claim | Evidence class | Pinned by |
| --- | --- | --- |
| The target ships a default site-configuration bundle, and the resolution prefers the bundle's own severity, then the per-model entry, then the defaults | REA observed | `tests/contracts/site-config.test.ts` — "ships the target's own nine members with the target's own values", "prefers the bundle's per-model entry", "falls back to the model's aliases when the exact id is not in the table" |
| The target offers its own git and GitHub rule templates, and one PowerShell rule is dropped on purpose | REA observed | `tests/contracts/rule-templates.test.ts` — "carries the target's seven templates, in the target's order", "drops the one PowerShell rule the target drops", "builds the pull-request flow's rules the way the target does" |
| The target's certified command prefixes are stripped out of the always-allow list before a permission decision | REA observed | `tests/contracts/rule-templates.test.ts` — "strips the certified rules out of a list", "recognises a certified rule by its content" |
| The status line's payload, its member order and its member names are the target's | REA observed | `tests/contracts/status-line.test.ts` — "writes the members in the target's own order", "carries the cost block", "carries the context-window block" |
| The status line's runner takes the command's standard output and swallows a failure | REA observed | `tests/contracts/status-line.test.ts` — "writes the payload to the command's standard input and takes its output", "swallows a failure of the command" |
| The status line's gates are the target's own | REA observed | `tests/contracts/status-line.test.ts` — "does not run the command when all hooks are disabled", "skips the command when the workspace trust is not accepted" |
| The target's built-in output styles, their frontmatter and their order | REA observed | `tests/contracts/output-styles.test.ts` — "carries the target's four styles and the default name", "reads the four keys the target's schema names", "puts the built-in styles before the file styles, and the file styles replace them" |
| `/output-style` lists the styles and saves the choice to the local tier | REA observed | `tests/contracts/output-styles.test.ts` — "lists the styles", "refuses a style it does not know, and names the ones it does", "saves the style it is given" |
| The target's cost formula, its price row and its ledger | REA observed | `tests/contracts/cost.test.ts` — "charges the input and the output per million tokens", "charges the two cache-write rates apart", "replaces a model's record rather than adding to it" |
| The result document carries the target's cost members | REA observed | `tests/contracts/cost.test.ts` — "carries the cost and the per-model usage", "prices a turn out of the catalog" |
| The target's checkpointing switch, its default and its environment variables | REA observed | `tests/contracts/checkpoints.test.ts` — "is on by default", "is switched off by the environment variable, whatever the setting says", "is off in the SDK" |
| The target's file history, its cap and its eviction rule | REA observed | `tests/contracts/checkpoints.test.ts` — "evicts the oldest snapshots past the cap", "deletes only the backups no kept snapshot refers to" |
| `/rewind` restores a file from a backup on disk, which this implementation does not write | REA observed (the target) + **refusal** (this implementation) | `tests/contracts/checkpoints.test.ts` — "refuses and names the capability it needs" |
| The `prompt.section` extension point receives `{name, text}` and its result rewrites the section | REA observed | `tests/contracts/prompt-surface.test.ts` — "hands the handler the section's name and its text", "leaves the text as it is when no handler is registered" |
| The `type:"prompt"` command kind carries the target's own shape and values | REA observed | `tests/contracts/prompt-surface.test.ts` — "registers exactly the target's five built-in prompt commands", "carries the target's own progress messages", "carries the target's own policy gates" |
