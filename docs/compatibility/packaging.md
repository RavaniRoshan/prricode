# Packaging, installation, and update

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.10 (the command-line surface) and §2.6 (sessions, persistence, and resumption).
**Owning task:** `CC-018`.
**Matrix rows:** F-01, F-02, F-24, F-38 (the command-line surface) and F-40 (the multi-provider manager) in [`feature-matrix.md`](feature-matrix.md).
**Test:** [`tests/compatibility/packaging.test.ts`](../../tests/compatibility/packaging.test.ts).

> **The packaging is this implementation's own.** The target ships as an npm package that the user installs with a package manager; this implementation ships as **one self-contained executable**. The two are not the same delivery, and nothing here claims that the target behaves this way. Every row below names its **evidence class**: `REA observed`, `Documented only`, `Runtime observed`, `project requirement`, `implementation choice`, or `unknown`.

## What this implementation ships

| Artifact | What it is | Evidence class |
|---|---|---|
| `dist/agent` | **one** executable: the bundled CLI **and** the runtime it needs | project requirement |
| `<configDir>/` | the configuration directory: settings, session transcripts, the multi-provider manager's state | `REA observed` (the storage root is `~/.claude`, audit §2.6) |

The executable carries its **own runtime**, so it needs **neither** the host's Node **nor** the host's `node_modules`. The build emits **one file** and nothing else beside it, and the test asserts both.

## The build

```bash
bun run scripts/build.ts                 # → dist/agent
bun run scripts/build.ts --outdir /tmp/x # → /tmp/x/agent
bun run scripts/build.ts --name other    # → dist/other
bun run scripts/build.ts --target=bun-linux-arm64
```

`scripts/build.ts` runs `bun build --compile` over `scripts/entry.ts` — the packaged executable's **entry point**, which the plan's file list does not name — and then **verifies** the result: the artifact exists, it is a regular file, and the output directory holds **nothing else**. The previous artifact is removed **before** the build, so a failed build never leaves a stale executable behind for a test to run and believe.

**Why Bun's `--compile` and not Node's SEA.** The plan fixes the path, and the two differ in ways that decide it:

| | Bun `bun build --compile` | Node SEA |
|---|---|---|
| The artifact | one file, with the runtime embedded | one file, with the runtime embedded |
| The host's Node | not needed | not needed |
| **macOS x64** | supported | **not supported** — "macOS (arm64 only; x64 is not currently supported and is skipped in the tests)", Node's own documentation of SEA |
| Tooling stability | Bun `1.4.3` | Node's SEA tooling is **Stability 1.1** |
| **Alpine (musl)** | **the artifact does not run there by default** | not applicable |

### The entry point

The plan's file list does not name an entry script, and **none existed**: `src/cli/command.ts` exports `runCommand`, but nothing in the repository called it, and a compiled binary needs a file Bun can turn into an executable. `scripts/entry.ts` is that file, and it is **thin** — it reads the command line, resolves the configuration directory, and leaves the process with the command's exit code. Every other behaviour belongs to `src/`.

## The install path

The installed binary **creates its configuration directory** and **reports the directory it will use**.

| Rule | Value | Evidence class |
|---|---|---|
| The directory the run uses | `CLAUDE_CONFIG_DIR` when it is set, otherwise `~/.claude` | project requirement (the relocation) + `REA observed` (the storage root) |
| The mode it carries | `0o700` — the owner may read, write and enter it, **nobody else** | project requirement |
| The first run | it **reports** the directory it will use, on the **standard error** | project requirement |
| The settings file inside it | `0o600` | `REA observed` (audit §2.6, "Config file security") |

The directory is created **before** the command runs, and not by the command: a `--version` that never touches the disk still leaves the installation in a state the next run can use. The mode is set **explicitly** after the creation, because `mkdir`'s mode is filtered through the process's umask and a directory that already existed may carry a wider one — and the configuration directory must not be world-readable either way.

The report goes to the **standard error** so that it never mixes with the answer a `--print` run writes to the standard output, and it happens on the **first run only**: the run that creates the directory is the first run, and a run that finds the directory has nothing to report.

**The relocation is this implementation's own.** The audit records the target's storage root (`~/.claude`) and **not** the name of a variable that relocates it, so this implementation names its own (`CLAUDE_CONFIG_DIR`) and says so here rather than claiming the target's spelling.

## The platform matrix

**What was actually built and tested here** — the reference host:

| | |
|---|---|
| Platform | Linux x86-64, Ubuntu 24.04.4 LTS (WSL2 guest) |
| Build runtime | Bun `1.4.3` |
| Test runtime | Node `24.21.0` |
| The artifact | `dist/agent`, 87.2 MiB (91 473 888 bytes), 161 modules bundled |
| The build | ~0.4 s (23 ms bundle + 372 ms compile) |
| The suite | ~1.2 s for the build **and** all ten assertions |

| Platform | Built | Exercised | Notes |
|---|---|---|---|
| **Linux x86-64 (glibc)** | **yes** | **yes** — the full suite | the reference platform; the only platform this repository claims |
| Linux arm64 (glibc) | no | no | `bun build --compile --target=bun-linux-arm64` is the documented cross-build; it **downloads** the target's Bun build. Nothing was cross-built or run here. |
| Linux x86-64 (**musl**, Alpine) | no | no | **known limit: the artifact does not run on Alpine by default.** The artifact is dynamically linked against glibc (`libc.so.6`, interpreter `/lib64/ld-linux-x86-64.so.2`), and Alpine's libc is musl; Bun ships no musl `--compile` target. A glibc-compatible Alpine image, or a `gcompat` shim, is needed. |
| macOS arm64 | no | no | Bun can target it; nothing was built or run here. |
| macOS x64 | no | no | Bun can target it. **Node's SEA alternative cannot ship here** — "x64 is not currently supported" — which is one of the two reasons this project packages with Bun. |
| Windows x64 | no | no | Bun can target it; the build was never run on or for Windows. |

**Everything outside the reference row is untested.** The claim this project makes is narrow and it is the one the test proves: *this implementation builds one self-contained executable, it starts without the host's Node, it runs a turn, and it installs a configuration directory with restrictive permissions* — **on Linux x86-64 with glibc**.

## The `node:` API audit

The plan's Step 3 requires every `node:` API the code uses to be **re-validated under Bun**. The audit below is a **runtime observed** result: every module was imported under Bun `1.4.3` and every member `src/` uses was looked up.

### The modules `src/` imports

79 import statements across 39 files. **Ten** modules, and **all ten** are supported:

| Module | Imports | The members `src/` uses | Bun `1.4.3` |
|---|---|---|---|
| `node:path` | 24 | `join`, `resolve`, `basename`, `dirname`, `sep`, `relative`, `normalize`, `isAbsolute`, `parse` | supported |
| `node:fs` | 21 | `chmodSync`, `closeSync`, `constants`, `createReadStream`, `existsSync`, `lstatSync`, `mkdirSync`, `mkdtempSync`, `openSync`, `readFileSync`, `readdirSync`, `readlinkSync`, `realpathSync`, `rmSync`, `rmdirSync`, `statSync`, `unlinkSync`, `writeFileSync` | supported |
| `node:fs/promises` | 11 | `access`, `appendFile`, `mkdir`, `readFile`, `readdir`, `stat`, `writeFile` | supported |
| `node:crypto` | 9 | `createHash`, `createHmac`, `randomBytes`, `randomUUID` | supported |
| `node:os` | 5 | `homedir`, `tmpdir` | supported |
| `node:child_process` | 5 | `execFile`, `spawn`, `spawnSync` (and the `ChildProcess` / `SpawnOptions` types) | supported |
| `node:util` | 1 | `promisify` | supported |
| `node:net` | 1 | `createServer` | supported |
| `node:http` | 1 | `createServer` | supported |
| `node:dns/promises` | 1 | `lookup` | supported |

The build scripts (`scripts/build.ts`, `scripts/entry.ts`) add `node:url` (`fileURLToPath`) on top of `node:child_process`, `node:fs` and `node:path`. `node:url` is supported.

### The modules the plan names, and the ones `src/` does not use

Every one of these **imports cleanly under Bun `1.4.3`**, and none of them is imported by `src/`:

`node:https` · `node:url` · `node:zlib` · `node:worker_threads` · `node:readline` · `node:stream` · `node:tty` · `node:assert` · `node:events` · `node:buffer` · `node:process` · `node:timers` · `node:module`

**No module `src/` imports is unsupported by Bun, and no module the plan names is unsupported.** The audit found nothing to change.

### `node:sqlite` — the plan's premise, corrected

The plan states that `node:sqlite` "is unavailable (Bun has `bun:sqlite`)", and that this is why the session store is JSONL and not SQLite. **The first half of that is no longer true for the Bun this project builds with.** The runtime observation:

- `await import('node:sqlite')` **succeeds** under Bun `1.4.3`;
- it exports `DatabaseSync`, `Session`, `StatementSync`, `backup`, `constants` and `default` — the **same** export set as Node `24.21.0`;
- a create / insert / select round trip **works**: `new DatabaseSync(':memory:')`, `exec`, `prepare(...).run(1)`, `prepare(...).all()` returned `[{"a":1}]`.

The premise held for the Bun lines that predate Bun's `node:sqlite` compatibility work; it does not hold for `1.4.3`.

**The JSONL store stands anyway, for two reasons that do not depend on Bun:**

1. **The target's own format is JSONL.** The audit records the session transcript as JSONL under a `projects` subtree of the storage root (audit §2.6), and this implementation reproduces that layout exactly (F-24). A SQLite store would be a *different* storage format from the target's, not a compatible one.
2. **`node:sqlite` is Stability 1.2 — "release candidate" — in Node, and its API differs between Node lines.** A project that must run both as a Node library and as a Bun-compiled binary would be built on an API the project cannot rely on.

This implementation therefore imports **no** SQLite API at all, and the packaged binary does not depend on `node:sqlite` — or on `bun:sqlite` — either way.

**The session store was run under Bun to prove it.** A Bun script drove this implementation's own `createSessionStore` end to end: it wrote a transcript, read it back through `readAllSessionEvents`, listed the session, and reported the project directory's mode as `0700`. The JSONL store works under Bun, and it is the store the packaged binary uses.

### The other `node:` behaviours the code depends on

| Behaviour | Bun `1.4.3` |
|---|---|
| `fs.mkdirSync(dir, { mode: 0o700 })` yields mode `0700` | yes |
| `fs.chmodSync(dir, 0o700)` **tightens** a directory that already existed at `0755` | yes |
| `fs/promises.mkdir(dir, { recursive: true, mode: 0o700 })` yields mode `0700` | yes |
| `for await (const chunk of fs.createReadStream(path, { encoding: 'utf8' }))` — the transcript reader | yes |
| `globalThis.fetch` — the provider transport | yes |
| `process.stdout.isTTY` — the headless rule | yes (`false` when the standard output is not a terminal) |
| `Buffer.byteLength` — the oversized-tool-result limit | yes |

## The implementation choices

| Choice | What it is | Why it is labelled |
|---|---|---|
| The **multi-provider manager** | the `/provider` command and the catalog browser | a **project extension**, not part of the reference agent (F-40). The packaged binary's own `--help` says so: *"The multi-provider manager (an extension, not part of the reference agent) is reached through the `/provider` command."* The test asserts that sentence is in the `--help` the **packaged** binary prints. |
| The **configuration-directory relocation** (`CLAUDE_CONFIG_DIR`) | moves the storage root | the audit records the storage root and not a relocation variable, so this implementation names its own |
| The **first-run report** | names the configuration directory on the first run | the target records no first-run behaviour; the report is this implementation's |
| The **fake-provider seam** (`CLAUDE_CODE_FAKE_PROVIDER_URL`) | points a packaged run at a **loopback** fake provider | a packaging convenience, not a product feature. It is **loopback-only** — a value naming any other host is **refused** with exit code `2` — and it **resolves no credential**, so a request that leaves through it carries no `x-api-key` and no `authorization` header. The test asserts both. |
| The **packaging path** (`bun build --compile`) | one self-contained executable | the target ships as an npm package |

**No secret is in the artifact, in a log line, or in a fixture.** This implementation's credential rule holds through packaging: the CLI never resolves a secret by itself, the entry resolves none, and the packaged binary's requests carry no credential unless a caller supplies one.

## What was **not** tested

- **Every platform outside Linux x86-64.** See the matrix above: the cross-builds were not run and the artifacts were not exercised.
- **The update path.** The milestone is titled "Packaging, installation, and update", and the **update** half is **not implemented**: there is no self-update mechanism, no version check and no channel. The target's own update behaviour is not in the audit. This implementation installs by replacing the executable.
- **The interactive terminal UI inside the packaged binary.** The UI module (`src/ui/app.ts`) exists, but `runCommand` does not call it, so a packaged run without `--print` reports that the interactive terminal UI is not implemented. This is a `src/` matter, not a packaging one.
- **The sandbox inside the packaged binary.** The sandbox code is bundled (the artifact carries the launcher, the Landlock status and the bubblewrap backend), but the sandbox was **not** exercised through the packaged binary in this milestone — it is covered by `tests/security/sandbox.test.ts` against the library.
- **The MCP transport inside the packaged binary.** It is bundled; it was not exercised through the packaged binary.

## How to reproduce

```bash
# the build
bun run scripts/build.ts --outdir /tmp/pkg

# the artifact
/tmp/pkg/agent --version
/tmp/pkg/agent --help

# the install path
CLAUDE_CONFIG_DIR=/tmp/pkg-config /tmp/pkg/agent --version   # the first run reports the directory
stat -c '%a' /tmp/pkg-config                                   # 700

# the whole suite (it builds once, into a temporary directory)
npx vitest run tests/compatibility/packaging.test.ts
```
