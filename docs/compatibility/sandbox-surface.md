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

## The target's helper and its supervisor — behaviour reproduced, mechanism different

The target's `apply-seccomp` worker is a **native** program, and the target's supervisor is a **native** program that holds the kernel's notification descriptor. This implementation is a TypeScript program, and it does not ship a native helper. The two facts are kept apart: the **behaviour** is the target's, and the **mechanism** is not.

**What is reproduced (the behaviour).**

- The helper's **decisions** — the environment it reads (`SRT_OBSERVE_SOCK`, `SRT_ENCODED_CMD`), the namespaces it unshares (`pid`, `mount`, `user`), the mounts it performs (the private root and `/proc`), the `prctl` it sets (`PR_SET_NO_NEW_PRIVS`), the seccomp flags it installs the filter and the listener with (`SECCOMP_FILTER_FLAG_TSYNC_ESRCH` and `SECCOMP_FILTER_FLAG_NEW_LISTENER`), the descriptors it hands over with `sendmsg`, and the order it does its work in (`read-environment` → `socketpair` → `unshare` → `fork` → the mounts → `prctl` → the filter → the listener → `sendmsg` → `waitpid` → `execvp`). `buildSandboxHelperPlan` in `src/platform/sandbox/launcher.ts` produces it.
- The **filter** that notifies: the target's 27 observed syscalls are handed to the listener with `SECCOMP_RET_USER_NOTIF` (`buildSeccompFilter` in `src/platform/sandbox/seccomp.ts`). The **enforcement** filter — the one the backend installs, where no listener is attached and a notified syscall would answer `ENOSYS` — is built with `notify: false`.
- The **listener** (`createSandboxNotificationListener`): it receives with the target's own ioctl request `0xc0502100` and answers with `0xc0182101`, dispatches on the notified syscall number, resolves the path against the target's `/proc/<pid>/cwd` and `/proc/<pid>/fd/<dirfd>`, and **never denies** — the response's error stays `0` and the `SECCOMP_USER_NOTIF_FLAG_CONTINUE` flag is set.
- The dispatch table's **27 records** and their argument indices, the JSON record the observation is written as, and the observe-never-deny rule.

**What differs (the mechanism).**

- The target's helper is a native ELF worker that performs the namespace, mount and `prctl` work **itself**. This implementation's helper is a **module** whose decisions the backend executes; the namespaces, the mounts and the `prctl` calls are performed by the unprivileged backend, not by a worker this implementation ships.
- The target's supervisor holds the kernel's notification descriptor and issues the `ioctl(2)` calls itself. This implementation's listener is **in process**, and the kernel's `seccomp(2)`, `ioctl(2)` and `process_vm_readv(2)` calls live behind the `NotifierChannel` seam — the native seam `src/platform/sandbox/seccomp.ts` already documents. A Node process cannot issue those calls.
- Therefore the **supervisor layer is not in force** in this build: the status reports it as such and says why. The layer is observability and emulation, never enforcement, so nothing about the sandbox's *boundary* depends on it — the boundary is the namespace, mount and `PR_SET_NO_NEW_PRIVS` isolation, and the kernel-enforced layers underneath it.

## The `sandbox.filesystem` settings block

The target's `sandbox.filesystem.{allowRead, allowWrite, denyRead, denyWrite, credentials}` block is mapped onto the mount plan: `allowRead` becomes a read-only bind, `allowWrite` a read-write bind, and `denyRead`/`denyWrite`/`credentials` paths are **masked**.

> A `denyWrite`-only mask is not expressible in a mount namespace — denying a write there denies the read too — so a `denyWrite` path is masked entirely. That is the fail-safe reading, and it is labelled as such in the source.

## The target's sandbox routing (REA observed — read from the target's own source)

**This section is the `CC-024` reading.** The audit recorded the `sandboxOverride` reason kind and never read the rule behind it, so `F-37` was `unknown`. The rule is in the target's own bundle, and it was read there.

### Where the reading came from

| What | Where |
|---|---|
| the POSIX `Bash` tool's permission check | `/home/shiva/opt/reference-agent-rea/extracted-patched/chunk-4jsg44k7.js`, offset `4761941` |
| the routing predicate — "must this command be sandboxed?" | the same file, offset `999205` |
| the Windows/PowerShell tool's **identical** rule | `chunk-tt5xyzk8.js`, offset `97149` |
| `areUnsandboxedCommandsAllowed` and the strict-mode test | `chunk-a8rm68wf.js`, offset `939287` |
| the `sandbox.allowUnsandboxedCommands` settings description | `chunk-c9s0jh80.js`, offset `164183` |
| the `unsandboxedCommandsDisabled` **feature flag** | `chunk-640jjsts.js`, offset `968` |

### The flag is the target's own

The target's `Bash` tool declares the field in its **input schema**, and describes it: *"Set this to true to dangerously override sandbox mode and run commands without sandboxing."* The tool's permission check reads that same field.

**The plan's assumption was wrong.** `docs/PROGRESS.md` and the `CC-024` milestone both record `dangerouslyDisableSandbox` as **this implementation's** flag. It is the **target's**, and the label goes the other way: the flag is **REA observed**, reproduced under the target's own name.

### The routing rule

The target asks its own predicate — *"must this command be sandboxed?"* — **twice**: once with the flag and once without. The flag is what changes the routing when the two answers differ.

The predicate, in the target's own order:

1. the sandbox is switched off, or the platform is excluded → the command is not sandboxed, and the flag changes nothing;
2. the flag is set **and** the policy **permits** unsandboxed commands → the command is **not** sandboxed;
3. the command is covered by the `excludedCommands` list → the command is not sandboxed, and the flag changes nothing;
4. otherwise the command is sandboxed.

The policy's permission is the target's `sandbox.allowUnsandboxedCommands`, and the target's own settings block says what it means: *"Allow commands to run outside the sandbox via the `dangerouslyDisableSandbox` parameter. When false, the `dangerouslyDisableSandbox` parameter is completely ignored and all commands must run sandboxed. Default: true."*

### The report

The target does not honour the flag silently. Its permission check produces an **ask**:

```js
{ behavior: 'ask', decisionReason: { type: 'sandboxOverride', reason: 'dangerouslyDisableSandbox' },
  message: 'Run outside of the sandbox' }
```

and it produces it only when **all** of the following hold:

| # | Condition |
|---|---|
| 1 | the call carries the flag |
| 2 | the ordinary decision is neither a `deny` nor an `ask` — an **allow** |
| 3 | the ordinary decision's reason is **not** rule-derived (a rule, or a compound escalation whose every part is a rule) |
| 4 | the flag is what changes the routing |

A **denial** keeps its own reason. An **ask** that was already put to the user is not asked again. A **rule-derived** allow keeps its rule: the target's own test asks whether the decision's reason is a rule, and a rule-derived allow is left alone.

### What this implementation reproduces, and what it does not

| The target's | This implementation |
|---|---|
| the flag's name and its place in the input schema | **reproduced** — the same field, the same name |
| the routing rule of points 1–4 | **reproduced** — `sandboxRoutingOf` in `src/tools/builtins/bash.ts` |
| the `sandboxOverride` **ask**, with the message "Run outside of the sandbox" | **reproduced** — `sandboxOverrideDecision` in `src/permissions/decision.ts` |
| a shell the **user typed** (`!` in the composer) runs outside the sandbox whatever the settings say | **not reproduced** — this implementation has no user-typed shell dispatch |
| a **remote** session that requires the sandbox refuses an unsandboxed command outright | **not reproduced** — this implementation has no remote session |
| the **Windows** enterprise policy refuses a compound command that would run unsandboxed | **not reproduced** — this implementation's backend is Linux-only |
| the target's `sandbox.allowUnsandboxedCommands` default is **`true`** | **this implementation's default is `false`** — see "Implementation choices" |
| the target's `excludedCommands` list works whatever `allowUnsandboxedCommands` says | **this implementation's list needs `allowUnsandboxedCommands`** — the two switches are one here, and the target's are two |

### The clone-choice labels

- The **flag** (`dangerouslyDisableSandbox`) is **the target's own** — REA observed, not an implementation choice. The plan's assumption that it was this implementation's was wrong, and this is the label that says so.
- The **routing predicate** and the **override ask** are **the target's** — REA observed.
- The **sandbox policy's defaults** are **this implementation's own**: `enabled: true` (the target's documented default is `false`), `failIfUnavailable: true` (the target's is `false`), `allowUnsandboxedCommands: false` (the target's is `true`), and `enabledPlatforms: ['linux']` (the target's list is not pinned).
- The **per-command refusal** when the backend is missing is **this implementation's own**: the target refuses at **start-up**, not per command.
- The **filtered environment**, the **refusal's own wording** and the **result's own members** (`sandboxReason`, `sandboxExemptions`, `sandboxExemptionScope`, `sandboxAvailability`) are this implementation's own.

## Implementation choices

These are this implementation's decisions, not the target's observed behavior:

- **The bubblewrap backend.** The target uses bubblewrap and socat on Linux/WSL2, so the choice is compatible; the version and setuid exposure are this implementation's own.
- **The read-only working tree by default**, with `readWritePaths` for the writable areas. This diverges from the target's writable project directory.
- **`failIfUnavailable: true`, `enabled: true` and `allowUnsandboxedCommands: false` as the defaults.** The target's documented default is that a failed sandbox start **falls back to running unsandboxed**; this implementation fails closed by default. The target's `allowUnsandboxedCommands` default is `true`, and this implementation's is `false` — so **the `dangerouslyDisableSandbox` flag is inert until a settings document sets `sandbox.allowUnsandboxedCommands: true`**. The target's own settings text is the rule: "when false, the `dangerouslyDisableSandbox` parameter is completely ignored and all commands must run sandboxed". The default is this implementation's own, and it is named here rather than papered over.
- **`enabledPlatforms: ['linux']`.** The target's list is not pinned.
- **The sandbox does not inherit the host environment.** Safe, but observable: `~/.ssh` and `~/.aws/credentials` are unreachable, whereas the target's default read access is "most of the machine".
- **Private address ranges are refused** beyond the three named classes (loopback, link-local, cloud-metadata). This implementation's `metadata.goog` and `instance-data` names are also guesses the target does not pin.
- **The Landlock and supervisor seams**, and the fact that neither is wired in this build. The supervisor's *behaviour* is reproduced (the notifying filter, the listener, the dispatch table, the observe-never-deny answer); its *attachment* to the kernel's notifications is the native seam, and this build ships no native helper.
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
| The **helper's plan** is the target's: the environment it reads (`SRT_OBSERVE_SOCK`, `SRT_ENCODED_CMD`), the namespaces it unshares (`pid`, `mount`, `user`), the mounts it performs (the private root and `/proc`), the `prctl` it sets (`PR_SET_NO_NEW_PRIVS`), the seccomp flags (`SECCOMP_FILTER_FLAG_TSYNC_ESRCH` and `SECCOMP_FILTER_FLAG_NEW_LISTENER`), the descriptors it hands over and the order it does its work in | REA observed (audit §2.9) | F-34 | same file — "builds the plan the target's helper executes" |
| The **filter** hands the target's 27 observed syscalls to the notification listener with `SECCOMP_RET_USER_NOTIF`, and the **enforcement** filter never does | REA observed (audit §2.9) | F-35 | same file — "hands the observed syscalls to the notification listener", "notifies for every one of the target's 27 observed syscalls" |
| The **listener** serves the notifications with the target's own ioctl requests — `0xc0502100` to receive and `0xc0182101` to answer — and never denies | REA observed (audit §2.9) | F-35 | same file — "serves the notifications with the target's own ioctl requests", "never denies: the listener answers every call it serves", "reports that no listener is attached when there is no channel" |
| The `dangerouslyDisableSandbox` field is the **target's own** — its name, its place in the input schema, and the description the target gives it | REA observed | F-37 | `tests/security/bash-sandbox.test.ts` — "routes the command outside the sandbox, and says why" |
| The routing rule: the flag is consulted **before** the command's own exemption, and only when the policy permits unsandboxed commands | REA observed | F-37 | same file — "routes the command outside the sandbox, and says why" |
| The override is an **ask** with the `sandboxOverride` reason kind and the message "Run outside of the sandbox" | REA observed | F-37 | same file — "asks the user before a call that asks for an unsandboxed run" |
| A rule-derived allow keeps its own reason, and an ask that was already put to the user is not asked again | REA observed | F-37 | same file — "keeps the rule of an allow the rules produced", "keeps the ask of a call that was already put to the user" |
| The flag is **completely ignored** when the policy forbids unsandboxed commands | REA observed | F-37 | same file — "ignores the flag when the policy forbids unsandboxed commands" |
| No question is asked when the command would run outside the sandbox anyway | REA observed | F-37 | same file — "asks nothing when the command would run outside the sandbox anyway" |
| The `sandbox.allowUnsandboxedCommands` default is **this implementation's own** (`false`), and the target's is `true` | implementation choice | F-37 | same file — "ignores the flag when the policy forbids unsandboxed commands" |
