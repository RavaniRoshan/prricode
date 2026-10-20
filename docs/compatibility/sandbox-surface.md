# Sandbox conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.9 "Native and platform sandbox".
**Owning task:** `CC-017`.
**Matrix rows:** F-34, F-35 in [`feature-matrix.md`](feature-matrix.md).
**Kernel constraints:** [`research/reference-agent-2.1.303-research.md`](../../research/reference-agent-2.1.303-research.md) §7.

Every row names its **evidence class**: `REA observed`, `Documented only`, or `implementation choice`.

> **This implementation's sandbox is not the target's.** The target ships a **native helper** (a seccomp user-notification supervisor) plus a bubblewrap-style launcher. This implementation builds the whole policy itself, in TypeScript, and uses bubblewrap as the **backend** that applies it. The **observable guarantees** are reproduced; the **implementation** is not.

## The five layers

| # | Layer | What it does | Evidence class |
|---|---|---|---|
| 1 | **Filesystem boundary** | a mount namespace plus a user namespace with `PR_SET_NO_NEW_PRIVS`, every bind explicitly read-only or read-write, and **protected paths masked** — never relying on an absent bind target | REA observed (the mechanism) + implementation choice (the backend) |
| 2 | **Syscall surface** | a seccomp-BPF denylist that blocks `ptrace`, `process_vm_readv`/`process_vm_writev`, `io_uring_setup`/`io_uring_register`/`io_uring_enter`, `bpf`, `mount`, `pivot_root`, and `setns` into foreign namespaces | REA observed (the syscall set) |
| 3 | **Path policy** | Landlock, bound to `O_PATH` descriptors rather than path strings | REA observed (the design) + implementation choice (the seam) |
| 4 | **Network** | **no** network namespace; traffic goes through a host-side HTTP/SOCKS proxy over a bind-mounted Unix socket | REA observed (the design) + implementation choice (the proxy) |
| 5 | **Supervisor** | a seccomp-notify supervisor that **observes and emulates** path-taking syscalls — and **never enforces** | REA observed (observe, not deny) |

### Why the mask is a tmpfs, not a read-only bind

A read-only bind on a path that does not exist is a **no-op** — which is exactly how the target's own CVE-2026-25725 injected persistent hooks. This implementation therefore masks a protected path so the path is **unreadable**, not merely unwritable:

- the mask target is the **parent directory** (a tmpfs) when the parent exists and is not a bind root;
- otherwise an **empty file** is bound over the path;
- a protected path that resolves through a **symlink** is **refused with a named reason** before the backend starts;
- a mask target that would **shadow a bind** the plan grants is **refused with a named reason** — a policy that protects a directory it also grants writable is genuinely contradictory, and this implementation refuses loudly rather than silently dropping the grant;
- a missing parent is never created **on the host**.

### The supervisor never denies

The target's supervisor **observes**. The `resp.error` field of the seccomp-notify response struct is never written, so the kernel always resumes the target's call. This implementation reproduces this: the supervisor's decision is advisory, and every path it authorizes is re-checked against layers 1–3, and every read of target memory is separated from its use by a `SECCOMP_IOCTL_NOTIF_ID_VALID` re-check. A stale notification id means **no response at all**.

### The dispatch table

The 27 records are decoded as `{u64 nr; u64 name_ptr; u8 meta[8]}`, where the metadata bytes are **argument indices** — path, second path, flags/mode, dirfd, second dirfd — with `0xff` meaning "absent". The intercepted syscalls are the path-taking filesystem calls. A relative path is resolved against `/proc/<pid>/cwd` when there is no dirfd, and against `/proc/<pid>/fd/<dirfd>` when there is one.

### The Landlock ABI ladder

The layer **feature-detects** the ABI and reports **reduced protection** rather than pretending. On the reference host (WSL2, kernel 6.6) Landlock reports **ABI 3**: filesystem rights only, with **no** TCP/UDP network rights, **no** `FS_IOCTL_DEV` and **no** `LANDLOCK_SCOPE_*`. Network control therefore comes from layer 4, never from Landlock.

> **This build ships no native Landlock helper and no seccomp-notify listener** — both need raw syscalls a Node process cannot make. Layer 3 is therefore enforced by the mount namespace (kernel-enforced, but not inode-bound) and layer 5 observes nothing. **The status says so**: `layers.pathPolicy` and `layers.supervisor` are `false`, and the status never claims a layer that is not in force. The Landlock status distinguishes "the seam is not implemented in this build" from "the kernel does not implement Landlock" — this implementation never asserts a host fact it has not observed.

## The decision mapping

The policy returns one of three decisions: **allow** (run it inside the sandbox), **deny** (do not run it), **unconfined** (run it, but without the sandbox).

| Condition | Decision | Reason |
|---|---|---|
| the platform is not in `enabledPlatforms` | **unconfined** | `sandbox.enabledPlatforms excludes <platform>` |
| the sandbox is switched off | **unconfined** | `sandbox.enabled is false` |
| an excluded command | **unconfined** | `sandbox.allowUnsandboxedCommands is true` |
| the backend is missing, `failIfUnavailable` off | **unconfined** | `sandbox.failIfUnavailable is false (a missing backend would run the shell unconfined)` |
| the backend is missing, `failIfUnavailable` on | **deny** | this implementation's own `unavailableRefused` |
| otherwise | **allow** | — |

**Implementation choice.** Only the last refusal is a refusal. The target's own documented default is that "a failed sandbox start **falls back to running unsandboxed**", and a setting that switched the sandbox off would be useless if it refused the command instead. Refusing on a platform the sandbox does not support would also make this implementation unusable everywhere its backend does not run.

## The policy

The reason strings are reproduced **verbatim**:

| Reason | When |
|---|---|
| `sandbox.enabledPlatforms excludes <platform>` | the platform is not in the list |
| `sandbox.enabled is false` | the sandbox is off |
| `sandbox.failIfUnavailable is false (a missing backend would run the shell unconfined)` | no backend, and the policy says to continue |
| `sandbox.allowUnsandboxedCommands is true` | the global opt-out is set |
| the `excludedCommands` exemption | a matching entry applies |

**Only one of the four reasons refuses the command.** The decision vocabulary is `allow` | `unconfined` | `deny`, and the mapping is exact:

| Reason | Decision | What the command does |
|---|---|---|
| `sandbox.enabledPlatforms excludes <platform>` | **unconfined** | it runs on the host, and the status says why |
| `sandbox.enabled is false` | **unconfined** | it runs on the host, and the status says why |
| `sandbox.failIfUnavailable is false (a missing backend would run the shell unconfined)` | **unconfined** | it runs on the host, and the status says why |
| the `excludedCommands` exemption | **unconfined** | it runs on the host, and the status says why |
| the backend is missing and `failIfUnavailable` is **true** | **deny** | it is **refused**: the user asked for a sandbox and none can be provided |
| — | **allow** | it runs inside the sandbox |

So: a **switched-off** sandbox and an **excluded** platform run the command **unconfined**; only a **missing backend** with `failIfUnavailable` **refuses** it. The reason for that refusal is the one the audit does **not** name — *"sandbox backend is unavailable and sandbox.failIfUnavailable is true"* — and it is a reimplementation string, labelled as such in the source.

The mapping is also **order-sensitive**, and the order is this implementation's: the platform is decided first, then the switch, then the exemption, then the backend. A command that is exempt from the sandbox runs unconfined whatever the backend's state is — and a compound command must not become unconfined because one of its parts is exempt, so the exemption is decided **per sub-command**.

### The `excludedCommands` exemption

An entry must cover the **whole** sub-command, after the shell wrappers and the redirections are stripped. A part carrying a command substitution — `$( … )`, backticks, or a process substitution — is **rejected** from the comparison, and the check runs on the **raw** part, before the redirections are stripped. So `git status > "$(rm -rf /tmp/x)"` is **not** exempt, and the substitution runs inside the sandbox.

An entry of `*` exempts everything, and needs the second explicit opt-in (`allowUnsandboxedCommands`, default `false`). The hazard is surfaced rather than prevented: `SandboxStatus.exemptionScope` reports `'none' | 'partial' | 'all'`.

## The environment

Neither path — sandboxed **or** unconfined — sees the agent's credentials. The environment is filtered against an allowlist (`PATH`, `HOME`, `LANG`, `TERM`, and the proxy-socket variable) regardless of what the caller passes, and it is **not** echoed into the status, so a secret cannot reach a log line.

- The **sandboxed** path gets `HOME=/tmp` — a private tmpfs inside the sandbox.
- The **unconfined** path gets the caller's own home, because it runs **on the host**, where `/tmp` is a shared, world-writable directory.
- The unconfined path is **not** handed the proxy socket variable; the socket only exists in the sandboxed path.

## The backend probe

The launcher probes the enforcement binary's **version** and **setuid** bit and records both in `SandboxStatus.enforcement`:

- a **setuid** bubblewrap is **refused** outright — this implementation never uses a setuid helper;
- a version below the fixed one produces a **machine-readable advisory** (`status.advisory` = `{id, fixedIn, version, detail}`) and a line in `status.reducedProtection`.

This implementation **refuses a setuid bubblewrap outright** and drives the unprivileged build, so for this implementation's own use a version at or above the fixed one *does* imply the fix.

## The residual risk — stated in every module header

All five layers share **one kernel**. Any kernel privilege escalation reachable from the sandbox defeats every layer, and unprivileged user namespaces widen the reachable surface. **Only a microVM moves the boundary below the kernel.** This statement is in the header of all five modules.

## The `sandbox.filesystem` settings block

The target's `sandbox.filesystem.{allowRead, allowWrite, denyRead, denyWrite, credentials}` block is mapped onto the mount plan: `allowRead` becomes a read-only bind, `allowWrite` a read-write bind, and `denyRead`/`denyWrite`/`credentials` paths are **masked**.

> A `denyWrite`-only mask is not expressible in a mount namespace — denying a write there denies the read too — so a `denyWrite` path is masked entirely. That is the fail-safe reading, and it is labelled as such in the source.

## Implementation choices

These are this implementation's decisions, not the target's observed behavior:

- **The bubblewrap backend.** The target uses bubblewrap and socat on Linux/WSL2, so the choice is compatible; the version and setuid exposure are this implementation's own.
- **The read-only working tree by default**, with `readWritePaths` for the writable areas. This diverges from the target's writable project directory.
- **`failIfUnavailable: true` and `enabled: true` as the defaults.** The target's documented default is that a failed sandbox start **falls back to running unsandboxed**; this implementation fails closed by default.
- **`enabledPlatforms: ['linux']`.** The target's list is not pinned.
- **The sandbox does not inherit the host environment.** Safe, but observable: `~/.ssh` and `~/.aws/credentials` are unreachable, whereas the target's default read access is "most of the machine".
- **Private address ranges are refused** beyond the three named classes (loopback, link-local, cloud-metadata). This implementation's `metadata.goog` and `instance-data` names are also guesses the target does not pin.
- **The Landlock and supervisor seams**, and the fact that neither is wired in this build.
- **The `sandbox.filesystem` mapping**, including the `denyWrite` fail-safe.
- **The old-bubblewrap policy**: an old version stays available with a machine-readable advisory, rather than making the backend unavailable. Refusing the backend would be *worse* — this implementation's `failIfUnavailable: true` default would refuse the command outright, while the target's own default would run it **unconfined**, which is weaker in expectation than a sandbox carrying a known advisory.

## Conformance table

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The protected path is masked with a tmpfs or an empty-file bind, never a read-only bind on an absent path | REA observed (the mechanism) + implementation choice (the backend) | F-34 | `tests/security/sandbox.test.ts` — the mask-target tests |
| A protected path that resolves through a symlink is refused with a named reason | implementation choice | F-34 | same file — the symlink tests |
| A mask that would shadow a granted bind refuses the launch with a named reason | implementation choice | F-34 | same file — the shadowing test |
| A command substitution in any part — including a redirection target — defeats the `excludedCommands` exemption | REA observed (the exemption) + implementation choice (the rule) | F-34 | same file — the substitution tests, including the end-to-end host-file proof |
| An entry must cover the whole sub-command; `git` does not cover `git status` | REA observed | F-34 | same file |
| The four target reason strings are verbatim | REA observed | F-34 | same file — the reason-string tests |
| The decision mapping: an excluded platform, a switched-off sandbox and a missing backend with `failIfUnavailable` off all run the command **unconfined** | REA observed (the reasons) + **implementation choice** (the mapping) | F-37 | `tests/security/sandbox.test.ts` — "runs unconfined with the reason naming the platform when enabledPlatforms excludes it", "runs unconfined when the sandbox is disabled", "runs the shell unconfined, and says so, when failIfUnavailable is false" |
| Only a missing backend with `failIfUnavailable` **true** refuses the command | REA observed (the mechanism) + **implementation choice** (the reason string) | F-37 | `tests/security/sandbox.test.ts` — "denies when the backend is missing and failIfUnavailable is true", "refuses only when the backend is missing and failIfUnavailable is true" |
| An exempt command runs unconfined whatever the backend's state is | REA observed (the exemption) | F-37 | `tests/security/sandbox.test.ts` — "runs an excluded command unconfined when allowUnsandboxedCommands is true" |
| The status reports only the layers actually in force | implementation choice | F-34 | same file — the layer tests |
| The Landlock status says "the seam is not implemented in this build", never "the kernel does not implement Landlock" | REA observed (the ABI ladder) + implementation choice (the seam) | F-34 | same file — the Landlock tests |
| The ABI 3 ladder is derived, not assumed: no network rights, no `FS_IOCTL_DEV`, no scopes | REA observed | F-34 | same file |
| Neither the sandboxed nor the unconfined path sees the agent's credentials | implementation choice | F-34 | same file — the environment tests |
| The environment is not echoed into the status | implementation choice | F-34 | same file |
| The unconfined path uses the caller's real home; the sandboxed path uses `/tmp` | implementation choice | F-34 | same file |
| The IPv4-mapped loopback is classified as loopback in both spellings | REA observed | F-34 | same file — the proxy tests |
| `io_uring_setup` is refused with `EPERM` inside the sandbox, end to end | REA observed (the syscall set) | F-35 | same file — the `io_uring_setup` test |
| The 27-record dispatch table and its argument indices are exact | REA observed | F-35 | same file |
| The supervisor's `ID_VALID` re-check happens after every read and again before the response | REA observed | F-35 | same file |
| The supervisor never authorizes a path that layers 1–3 deny | REA observed | F-34 | same file |
| The proxy refuses loopback, link-local and cloud-metadata addresses, and enforces the domain allowlist | REA observed | F-34 | same file |
| The proxy socket lives in a `0700` directory with a `0600` socket | implementation choice | F-34 | same file |
| `PR_SET_NO_NEW_PRIVS` is asserted end to end | REA observed | F-34 | same file |
| A missing backend is reported gracefully, and `failIfUnavailable` decides between refusing and running unconfined | REA observed | F-34 | same file |
| The advisory is machine-readable and the backend's version and setuid bit are recorded | implementation choice | F-34 | same file — the enforcement-probe tests |
| The residual-risk paragraph is in all five module headers | implementation choice | F-34 | same file — the header test |
