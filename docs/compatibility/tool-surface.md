# Tool surface conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.4 ("Agent loop and tool dispatch") and §2.5 ("Permissions").
**Owning task:** `CC-008` in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md); the terminal-UI surfaces below were closed by `CC-022`.
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

## The ten built-in tools

`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `TodoWrite`, `NotebookEdit`, `Task`.

**The set is a implementation choice.** The audit records the **file-mutating** set exactly — `Edit`, `Write`, `NotebookEdit` — and records `respondToPermissionRequest` and `can_use_tool` as the target's tool-facing surfaces, but it does not pin the whole tool surface. The plan's ten are therefore a plan-level decision.

The rule engine's path-field and read-tool tables must name only tools this implementation can run. They once carried an `LS` row for a tool that is not shipped, which made a user's `LS(...)` rule half-live; the tables and the built-in set now move together, and a regression test pins it.

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

## The `Task` tool

Delegates through a `deps.delegate` seam and reports a typed `taskUnavailable` failure when there is no delegate. The **delegation scheduler is not observed** in the audit, so this implementation does not invent one; `CC-010` owns the runtime.

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
| the approval dialog's third option | `No, and tell Claude what to do differently (esc)` | `No, and tell PRRICODE what to do differently (esc)` |
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
