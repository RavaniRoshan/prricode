# Contributing to prricode

Thanks for helping. This file covers what you need to get oriented and what
the gates expect. The short version: build the code, write the test first,
keep the diff focused, and never let a gate go red.

## Picking up work

- **[Good first issues](https://github.com/RavaniRoshan/prricode/labels/good%20first%20issue)**
  are scoped small and come with a pointer to the code that needs changing.
- **[The roadmap](https://github.com/RavaniRoshan/prricode/blob/main/docs/explanation/roadmap.md)**
  lists what is deliberately not built yet. Items there are the most useful
  contributions.
- Claim an issue with a comment before you start, so two people do not write
  the same patch.

## Setting up

```bash
git implementation https://github.com/RavaniRoshan/prricode.git
cd prricode
cargo build                 # first build takes a few minutes
cargo test --workspace      # 189 tests, all offline
```

No network access and no API keys are needed for the test suite — providers
are scripted and HTTP is mocked. To run the live-provider checks you need a
key in the environment; see
[run the tests](https://github.com/RavaniRoshan/prricode/blob/main/docs/how-to/run-the-tests.md).

## The gates

Every change must leave these green — CI runs them on every push:

```bash
cargo fmt --check                                        # formatting
cargo clippy --workspace --all-targets -- -D warnings    # lints, zero allowed
cargo test --workspace                                   # the suite
```

## How to write a change

**Test first.** Write the failing test, run it and watch it fail, implement,
watch it pass. It is the difference between "it works on my machine" and a
change that stays working.

**One concern per change.** A bug fix does not need the surrounding code
cleaned up. A new feature does not need a refactor. If you spot something
unrelated, open an issue instead of folding it in.

**Match the surrounding code.** Follow the conventions already in the file you
are editing rather than importing your preferred style.

**Comments earn their place.** Prefer no comment over one that restates the
code. When a comment is warranted, explain *why*.

## House rules

1. **The protocol is additive.** Existing method shapes and the schema
   fingerprint never change. New capabilities arrive as new methods, new
   fields with `#[serde(default)]`, new tools, or new notifications.
2. **Agent behavior is a tool or a method.** Nothing the agent can do should
   be hidden magic — it belongs in the tool registry or the dispatch match.
3. **Degrade honestly.** A feature that cannot run reports `enabled: false`
   or `unsupported: <why>`, never fake success.
4. **No third-party names.** In code, comments, docs, or commit messages.
5. **Secrets never land here.** Credentials go in environment variables or
   the 0600 credential store; deploy material is environment-only for child
   processes and redacted from every artifact.
6. **`cargo fmt` before every commit.**

## Documentation

Docs are organised by Diátaxis quadrant under `docs/`, and the site nav
mirrors it:

| Want to… | Put it in |
|---|---|
| teach a newcomer, start to finish | `docs/tutorials/` |
| solve a specific problem | `docs/how-to/` |
| describe the machinery exactly | `docs/reference/` |
| explain why something is built this way | `docs/explanation/` |

Every command, setting, and configuration must be reachable **from the TUI** —
that is the product's promise, so the docs describe the TUI path first and
the file/env equivalent second.

Preview the docs site locally:

```bash
pip install mkdocs-material
mkdocs serve     # http://127.0.0.1:8000
```

## Commit messages

Write the subject as what changed, not what you did:

```text
fix: build stage runs its turns open — every write was stalling on approval
```

Explain the *why* in the body when it is not obvious from the diff, and link
the issue if there is one.

## Reporting bugs

Use the issue templates. A good report has the command you ran, what you
expected, what happened, and the version (`git rev-parse HEAD`).

**Security issues are different.** Do not open a public issue — see
[SECURITY.md](https://github.com/RavaniRoshan/prricode/blob/main/SECURITY.md).

## Code of conduct

Be decent to each other. Harassment of any kind is not tolerated; report it
to the maintainer through the same private channel as security issues.

## License

Contributions are accepted under the repository's MIT license.
