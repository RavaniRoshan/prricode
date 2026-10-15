# Build your first product

A lesson, not a reference. In about twenty minutes you will hand prricode a
rough idea, answer three questions about it, and watch it produce a spec, a
plan, a built and tested program, and an acceptance dossier that tells you
what was verified and what was not.

You do not need to know how the pipeline works to follow this. When you want
to know *why* it works that way, [`docs/PRD.md`](PRD.md) and
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) are the discussion.

## What you'll end up with

By the last step you will have:

- a working program, built and tested by the agent in an isolated worktree
- a spec whose requirements are written in a form a machine can check
- an **acceptance dossier** — the artifact you review instead of a diff

## Before you start

You need three things, and none of them take long:

1. **Rust** — `cargo --version` should print something. If not, install it
   from <https://rustup.rs>.
2. **A model.** The easiest first run uses a free hosted model with no key:

   ```bash
   prricode exec "say hi" --provider kilo --model liquid/lfm-2.5-2.6b:free
   ```

   If that prints a reply, you are ready. Prefer your own hardware? Install
   [Ollama](https://ollama.com), run `ollama pull qwen2.5-coder:3b`, and use
   `--provider ollama` instead. Either works for this lesson.
3. **The binary**:

   ```bash
   git implementation https://github.com/RavaniRoshan/prricode.git
   cd prricode
   cargo build --release
   ```

## Step 1 — Open the agent

Start the terminal UI with no arguments:

```bash
./target/release/prricode
```

You get a window with a status line at the top, a conversation pane, an input
box, and a row of key hints at the bottom.

```
prricode  session 01a13b25  kilo / liquid/lfm-2.5-2.6b:free | closed | turn: idle | tokens: 0in/0out
```

Read it left to right: which provider, which model, the approval mode
(`closed` means it asks before anything sensitive), whether a turn is running,
and how many tokens this session has spent. Press `Ctrl+C` at any time to
interrupt; the session survives.

If the provider or model on that line is not the one you want, change them
without restarting:

```
/model qwen2.5-coder:3b
/provider ollama
```

## Step 2 — Hand it a concept

Type a rough idea. It does not need to be good — that is the point of the next
step. This lesson uses a small one so the build finishes quickly:

```
/concept a tiny CLI called wc-top that counts the words in a text file and prints the ten most common words
```

Two things happen. The status line grows a pipeline rail, and the agent asks
its first question:

```
sys › pipeline: starting concept — a tiny CLI called wc-top …
sys › pipeline stage: clarify
agent › What is the core value they get?
```

## Step 3 — Answer three questions

This is the interview. answer each one in a plain sentence — what you type
here becomes the concept's `value`, `success criteria`, and `non-goals`, and
everything downstream is built from them.

```
agent › What is the core value they get?
you › it counts words and shows the ten most common ones in a table, with no setup

agent › What single success criterion says it works?
you › running wc-top on a text file prints a top-ten table, and its tests pass

agent › What is explicitly NOT part of this product?
you › no web interface, no database, no network calls
```

Three questions, because prricode already took the *who* from your idea. When
the concept is unambiguous, the gate opens:

```
sys › pipeline: concept ready — y to confirm, n to reject
```

Notice the rail in the status line now reads `· stage: concept · gate:
concept-confirmation`.

## Step 4 — Confirm the concept

Press `y`.

This is the first of the human gates, and it is worth slowing down for: the
pipeline asks you to approve the *irreversible-ish* decisions (what to build,
what the spec says) and never asks you to approve individual edits. That
trade is the whole design — read the three durability tiers once:

| Key | Meaning |
|---|---|
| `y` | approve this once |
| `s` | approve for the rest of this session |
| `a` | always approve this in this workspace (persisted) |

After `y` the rail moves to the next stage.

## Step 5 — Generate the spec

```
/spec
```

Wait for the model to come back. You will see either the spec, or — with a
smaller model — a repair line first:

```
sys › pipeline: EARS gate sent it back — requirement R5 is not EARS form; retrying (1 of 2)
sys › pipeline: spec ready — 6 requirements; y to confirm, n to reject
```

That first line is the pipeline doing its job: a requirement that is not in
the checkable form gets sent back to the model rather than silently accepted.
Press `y` to confirm the spec.

Press `y`, then look at what you approved — the requirements are the contract
every later stage is judged against:

```
R1  WHEN the user runs wc-top with a valid text file path THE SYSTEM SHALL read
    the file and compute word frequencies
R2  WHEN computing word frequencies THE SYSTEM SHALL treat a word as any
    sequence of letters, ignoring punctuation and digits
…
```

Each one is a sentence a machine can check, each carries acceptance criteria,
and each is traceable to a task in the next step.

## Step 6 — Read the plan

```
/plan
```

```
sys › pipeline: plan ready — 9 tasks in 7 waves; /build to run the build
```

The plan is a dependency-ordered task graph, grouped into **waves**. Tasks in
the same wave have no dependencies on each other and run concurrently; a later
wave waits for the ones it depends on. Every task names the requirement it
satisfies — that traceability is a gate, not a hope: a plan that leaves a
requirement uncovered is rejected and repaired.

There is no approval gate here. The plan is a proposal you can read, not a
decision you must ratify.

## Step 7 — Build it

```
/build
```

This is the longest step. Each task runs as an agent turn inside a disposable
worktree, and after every task the gates run for real — typecheck, build, and
test for the detected stack. You will see tool calls stream past:

```
tool › write_file: …/wc-top/src/wc_top/words.py
tool › shell: pytest — 5 passed, 0 failed
```

A failing gate does not stop the build; the failure is carried forward into
the step's record and the verification report, so you can see it rather than
trust a green check. When the build finishes, verification runs automatically:

```
sys › pipeline: build finished — build completed
sys › verify: gates 3/3 · verdicts 1P/0F/1U — /dossier opens the report
```

The verifier is a separate agent turn that reads the requirement and the
evidence, never the builder's conversation. It cannot be talked into agreeing
with itself.

## Step 8 — Read the dossier

```
/dossier
```

The dossier opens in your pager. It is the artifact this whole pipeline exists
to produce — what changed, what was verified and how, the evidence, the
residual risk, and **what was not tested**. A verdict of `unverified` is a
first-class outcome, not a failure: it says the oracle did not exist for that
requirement, which is exactly the information a reviewer needs.

The file lives in your data directory, so you can read it later or attach it
to a pull request:

```
~/.local/share/prricode/runs/<run-id>/acceptance-dossier.md
```

## Step 9 — Ship it (optional)

```
/ship
```

This packages what you built as a GitHub release with install steps. It uses
the `gh` CLI you already have authenticated, so no new credentials pass
through prricode. It asks for confirmation first, because a release is public
and irreversible — one of the moments the design keeps for you.

If you would rather deploy somewhere else, `/deploy` proposes a target from
the product's stack, asks for exactly the credentials it needs, and never
stores them.

## What just happened

You did five things, and only two of them needed a model:

1. You gave it a **concept** and answered three questions.
2. You approved a **spec** whose requirements are machine-checkable.
3. You let it **build** against gates that ran for real.
4. An **independent verifier** judged the result without seeing the builder's
   reasoning.
5. You got a **dossier** instead of a diff to trust.

Everything else — the interview, the EARS check, the wave scheduling, the gate
runs, the retries when a stage was rejected — was the harness refusing to let
a bad artifact through quietly.

## Where to go next

- **I want to do a specific thing** — [`docs/TUI-GUIDE.md`](TUI-GUIDE.md) for
  every command and key, [`docs/CONFIGURATION.md`](CONFIGURATION.md) for
  providers, keys, and the credential store.
- **I want to know how it works** — [`docs/PRD.md`](PRD.md) for the product
  argument, [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for the request path and
  storage, [`docs/ROADMAP.md`](ROADMAP.md) for what is deliberately not built
  yet.
- **I want the wire details** — [`docs/PROTOCOL.md`](PROTOCOL.md) is the
  reference for driving the same agent over JSON-RPC from your own editor.
- **Something went wrong** — start with
  [`docs/TESTING.md`](TESTING.md), which records what the live runs covered and
  the known limits of free model tiers.
