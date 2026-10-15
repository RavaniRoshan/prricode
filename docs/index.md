# prricode documentation

prricode is an autonomous AI coding agent for the terminal: a TUI you drive
with words, a stable JSON-RPC surface over stdio, and a Product Builder
pipeline that carries a concept through to a verified, shippable product.

## Start here

- **Never used it?** [Build your first product](tutorials/first-product.md) —
  a twenty-minute lesson from a rough idea to an acceptance dossier.
- **Just installed it?** [Connect a provider](how-to/connect-a-provider.md)
  and [the TUI guide](how-to/tui-guide.md).
- **Want the argument for the design?**
  [The product builder](explanation/prd-onepager.md).

## The four kinds of documentation here

This documentation follows the Diátaxis split, so you can tell at a glance
whether something will teach you, solve a problem, describe the machinery, or
explain a decision.

| | |
|---|---|
| **[Tutorials](tutorials/first-product.md)** | Lessons. Follow one start to finish and you end up with a working product and an understanding of the stages. |
| **[How-to guides](how-to/tui-guide.md)** | Recipes for a specific job: connect a model, run the tests, author a skill, set up computer use, contribute. |
| **[Reference](reference/protocol.md)** | The machinery, described exactly: the JSON-RPC surface, the TUI spec, the conformance report. |
| **[Explanation](explanation/prd.md)** | Why it is built this way: the product requirements, the architecture, the roadmap, and the decisions the conformance pass made. |

## Quick answers

| Question | Where |
|---|---|
| What command starts the agent? | `prricode` with no arguments — see [the TUI guide](how-to/tui-guide.md) |
| Which models can I use? | [Connect a provider](how-to/connect-a-provider.md) |
| How do I drive it from my own editor? | [The protocol reference](reference/protocol.md) |
| What is verified before a build advances? | [Protocol conformance](reference/protocol-conformance.md) and [the pipeline stages](explanation/prd.md) |
| What is deliberately not built yet? | [The roadmap](explanation/roadmap.md) |
| Where does the project stand? | [Launch status](explanation/launch-status.md) |

## Contributing

[CONTRIBUTING.md](https://github.com/RavaniRoshan/prricode/blob/main/CONTRIBUTING.md)
covers the gates, the naming rules, and how to pick up work. Security reports
go through [SECURITY.md](https://github.com/RavaniRoshan/prricode/blob/main/SECURITY.md),
never a public issue.
