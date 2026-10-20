# An observably-compatible the reference agent implementation

An independently implemented coding-agent CLI, written from scratch against the
**static** structure of `the pinned reference build @ 2.1.303` (Linux x86-64, SHA-256
`375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`), plus a
**multi-provider manager** the target does not have.

> **What "observably compatible" means here.** No Anthropic source, credential or
> private API was used. The target binary was read **statically** — its extracted
> JavaScript and its Ghidra output — and every behavior this implementation reproduces is
> traced to a named artifact in that evidence, recorded in
> [`docs/reverse-engineering/COVERAGE-AUDIT.md`](docs/reverse-engineering/COVERAGE-AUDIT.md)
> and **measured** in
> [`docs/compatibility/results.md`](docs/compatibility/results.md).

## Quick start

```bash
bun install                 # the build never consults bun.lock; the tests do
bun run test                 # the whole suite
bun run typecheck            # tsc --noEmit
bun run build                # → dist/agent, one self-contained executable
```

The built executable needs **neither** the host's Node **nor** the host's
`node_modules`:

```bash
./dist/agent --version
./dist/agent --print 'hello' --output-format json
```

`CLAUDE_CONFIG_DIR` relocates the configuration root; the first run creates it
`0700` and reports where it put it.

## What is in here

| Path | What it is |
|---|---|
| `src/config/` | the five settings tiers and the two distinct precedence orderings |
| `src/provider/` | the eight route adapters, the provider-owned model catalog, the credential registry, the transport (retry loop, SigV4) |
| `src/permissions/` | the rule engine, the decision vocabulary, the modes, the `PreToolUse` and `PermissionRequest` seams |
| `src/tools/` | the tool registry, the runner, and the built-in tools |
| `src/session/` | the JSONL event store, the resume algorithm, the compaction boundary |
| `src/agent/` | the turn loop, the tool dispatch, the abort path |
| `src/extensions/` | MCP, hooks, skills, subagents, plugins, marketplaces |
| `src/platform/sandbox/` | the five-layer sandbox (filesystem, syscall denylist, Landlock, network proxy, seccomp-notify supervisor) |
| `src/cli/`, `src/ui/` | the command-line surface, the headless modes, the Ink terminal UI |
| `scripts/` | the `bun build --compile` build and the packaged entry point |

## The evidence

| Document | What it holds |
|---|---|
| [`docs/reverse-engineering/COVERAGE-AUDIT.md`](docs/reverse-engineering/COVERAGE-AUDIT.md) | the coverage audit: what is **observed** in the pinned artifact, what is **inferred**, what is **documented only**, and what remains **unknown** — with the exit gate and its four bounded residuals |
| [`docs/reverse-engineering/reference-agent-2.1.303-partial.md`](docs/reverse-engineering/reference-agent-2.1.303-partial.md) | the REA record: the decoded tables, the adapter shapes, the evidence identifiers |
| [`docs/compatibility/feature-matrix.md`](docs/compatibility/feature-matrix.md) | the 42-row contract list, each with a status, an **evidence class**, an owning task and a pinning test |
| [`docs/compatibility/results.md`](docs/compatibility/results.md) | the **measured** result per row — `match`, `partial`, `mismatch`, `not-tested` or `unknown` — with the command that reproduces it |
| [`docs/compatibility/`](docs/compatibility/) | the per-surface conformance tables: [permissions](docs/compatibility/permission-matrix.md), [sessions](docs/compatibility/session-format.md), [the command line](docs/compatibility/command-surface.md), [extensions](docs/compatibility/extension-surface.md), [the sandbox](docs/compatibility/sandbox-surface.md), [providers](docs/compatibility/provider-catalog.md), [the UI](docs/compatibility/tool-surface.md), [settings](docs/compatibility/settings-precedence.md), [packaging](docs/compatibility/packaging.md) |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | the live ledger: every milestone, its review, and its outcome |
| [`docs/superpowers/plans/`](docs/superpowers/plans/) | the implementation plan — 27 milestones, 307 steps, each with its file paths, its interfaces and its test-first order |
| [`research/`](research/) | the deep-research report and its version-sensitivity table |

## The three rules this code holds to

1. **Credentials are references, never values.** A connection carries an
   environment-variable name, a file path or an OS credential-store key. The
   only path that turns a reference into a value is
   `resolveConnectionCredential`, and nothing it produces reaches a log line, a
   settings file, a session record or a fixture.
2. **The multi-provider manager is a project extension**, labelled as one
   wherever it surfaces — the output, the `--help`, every machine-readable
   document and the picker.
3. **Every compatibility claim names its evidence class.** A claim is either
   `REA observed`, `Documented only` or a labelled `implementation choice`, and the
   report measures it rather than asserting it.

## The honest gaps

Four requirement groups are **partial**, each with a named artifact and a
implementation-visible consequence, recorded in the audit's §5 and measured in the
results:

- the target's **ordinary per-key** settings merge (this implementation merges per leaf);
- the target's **concurrent tool-call scheduling order** (this implementation runs them
  sequentially, in message order);
- the target's **store-level session-lookup ordering** (this implementation selects the
  newest session and says so when it is already running);
- the target's **subagent definition lifecycle** and **standalone skill scan**
  (both entirely this implementation's).

The whole-image native inventory produced no Evidence record, so that row is
`unknown` rather than `partial`. None of these is a claim that the target does
something this implementation has not established.
