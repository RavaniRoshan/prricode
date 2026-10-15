# Security Policy

## Supported Versions

prricode is pre-1.0. Security fixes land on `main` and are released as the next
tagged version; there are no maintained backports for older tags.

| Version | Supported |
|---|---|
| `main` | Yes |
| any tag | No |

## Reporting a Vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private vulnerability reporting for this repository:
**Security → Report a vulnerability**. That opens a private advisory only the
maintainers can see, and it is the fastest route to a fix.

If you cannot use that form, email the maintainer at the address listed on the
repository owner's GitHub profile.

Include, as far as you can:

- what prricode does wrong, and what an attacker gains
- the exact commands, input, or JSON-RPC messages that trigger it
- the version (a commit SHA is ideal) and your OS
- whether the problem needs a model API key, a specific model, or no
  credentials at all

## What to Expect

- Acknowledgement within 7 days
- An assessment, and either a fix or a written explanation of why it is not a
  vulnerability, within 30 days
- Credit in the release notes unless you prefer to stay anonymous

## Threat Model Notes

prricode drives a model that can run shell commands. The boundaries that matter:

- **Sandboxed execution.** The `shell` tool runs under bubblewrap with network
  toggling and path scoping. A sandbox escape is in scope; the model *asking*
  to run a command is not, because approvals gate that.
- **The approval engine.** Sensitive actions never run silently, and an
  unanswered request times out into a denial. A bypass — a call that runs
  without a verdict, or a verdict that can be forged — is in scope.
- **Credential store.** API keys live in `~/.config/prricode/credentials.toml`
  with owner-only (0600) permissions. Deploy credentials collected in the
  Product Builder flow are environment-only for the deploy child process, are
  never persisted, and are redacted from every captured artifact. A leak of
  either into a log, an artifact, the database, or git is in scope.
- **Computer use.** Screenshot and input injection over X11 or a Wayland
  portal is gated by the same approval engine as everything else.

Out of scope: the model producing wrong or harmful output, prompt injection
that results only in text the user then acts on, and anything requiring the
user to grant a permission the UI asked about.

## Disclosure

We follow coordinated disclosure: a fix or mitigation is released before the
details are made public, and we credit the reporter.
