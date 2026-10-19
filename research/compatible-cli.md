# Research: A the reference agent CLI-Compatible Implementation

**Research depth:** Wide
**Research snapshot:** 2026-10-19
**Purpose:** Ground a full-featured, independently implemented the reference agent CLI-compatible agent, with a version-pinned compatibility target, a multi-provider/model catalog, and durable agent-to-agent project resumption. The goal is broad observable feature parity, not private source-code identity.

## Executive summary

The reference agent’s documented product surface is much larger than a prompt loop: it includes interactive and print modes, session continuation, layered settings and instruction discovery, permission controls, tool execution, and extension systems such as MCP, hooks, skills, subagents, and plugins. The project target is the complete user-visible CLI surface for a pinned release, expanded with an independently managed provider registry/catalog that can connect multiple authorized model services at once. A credible effort should establish an evidence ledger from the exact shipped artifact and declared runtime scenarios, then deliver the full feature set in verified stages. Public documentation and neighboring open-source projects can guide interfaces and architecture, but they do not prove private implementation details or behavioral parity. Applicable service terms remain a gate for any Agent service access or credential reuse; REA analysis of a locally acquired artifact is being recorded separately from service interaction.

## Findings by research question

### 1. User-visible behavior and interaction model

The published CLI supports both interactive sessions and non-interactive print runs. Its session surface includes initial prompts, piped input, continuing the latest conversation in a working directory, and resuming by session identifier or name. Print mode supports text, JSON, and streaming JSON output. Interactive mode adds transcript navigation, interruption, tool-activity inspection, history search, queued prompts, and session controls. These are suitable first compatibility contracts because they can be exercised as explicit user scenarios. [CLI usage]([vendor source]), [interactive mode]([vendor source])

The tool set covers code and shell work, with documented built-ins including file read/search, shell, edit/write, and agent tools. the reference agent exposes configurable permission behavior. The current docs say Auto is the built-in starting mode for interactive terminal and VS Code sessions in v2.1.283 and later, subject to startup and policy constraints; `default` is the configuration value for the mode labeled Manual. The plan must pin the exact target version and test the actual starting mode instead of treating “default” as a timeless product behavior. [Tools]([vendor source]), [security]([vendor source]), [permission modes]([vendor source])

Project instructions and memory are separate from hard enforcement. `CLAUDE.md`, documented `AGENTS.md` support, rules, and auto memory supply context, while permission settings and hooks govern actions. This distinction matters for a reimplementation: prompt context can inform an agent, but a tool runner must enforce access decisions outside the model. [Memory]([vendor source]), [permissions]([vendor source])

### 2. CLI, configuration, and environment contract

The published command and flag surface includes interactive/print operation, input and output formats, session resume/continue, settings injection, model and effort selection, tool filtering, permission mode, hooks, MCP and plugins, directory scope, debug controls, and several service and background execution modes. The list is version-sensitive; the reference says `agent --help` is not exhaustive. The official pages therefore give a strong starting contract, but not a substitute for inspecting and probing a pinned binary. [CLI usage]([vendor source])

Settings have user, shared-project, project-local, and managed scopes. The documented precedence for matching keys is managed settings, CLI `--settings`, project-local, shared-project, and user settings, with special merging and per-key command-line overrides. `~/.claude.json` stores other global configuration and should not be confused with `settings.json`. Environment-variable precedence varies by feature; for example, `--model` can override `ANTHROPIC_MODEL`, while `CLAUDE_CODE_EFFORT_LEVEL` can override the effort flag. Configuration compatibility should be tested as explicit precedence tables, not implemented as one generic “last value wins” rule. [Settings]([vendor source]), [environment variables]([vendor source])

Context discovery also has an opt-out: `--bare` skips discovery of several instruction and extension sources, including `CLAUDE.md`, hooks, skills, subagents, plugins, and MCP servers. Slash commands are dynamic and can come from built-ins, skills, legacy command files, plugins, and MCP. These surfaces should be recorded in the evidence matrix and scheduled as separate compatibility work rather than assumed to be one static command table. [CLI usage]([vendor source]), [slash commands]([vendor source])

### 3. Extension and integration interfaces

MCP supports local stdio and remote HTTP, with legacy SSE documented, and can expose tools, prompts, and resources. Hooks attach behavior to lifecycle events and may invoke shell commands, HTTP endpoints, MCP tools, prompts, or agents. Skills package Markdown instructions and supporting files. Subagents define delegated prompts and configurable tools, permissions, models, hooks, and skills. Plugins bundle several of these pieces. VS Code integration has its own CLI packaging and editor-context behavior. These interfaces are individually substantial and should receive independent subplans after the core CLI contract is stable. [MCP]([vendor source]), [hooks]([vendor source]), [skills]([vendor source]), [subagents]([vendor source]), [plugins]([vendor source]), [IDE integrations]([vendor source])

The official interfaces describe supported formats and user-visible scope, not private orchestration details or every version-specific edge case. The reconstruction should label each finding as observed in the target, documented, inferred, or still unknown. A documentation claim must not be reported as a runtime observation.

### 4. Multi-provider and model-catalog design

The requested provider surface is broader than the reference agent’s built-in access routes: this implementation should let a user configure several providers concurrently, each with an explicit protocol driver, endpoint, credential reference, and one or more model entries with capabilities and default-selection metadata. Kimi Code documents a concrete example of this interaction: its `/provider` manager adds/removes providers; protocol types include Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, Google GenAI, Vertex AI, and Kimi’s compatible endpoint; models are declared against providers with context and capability metadata. Its provider-import workflow reads a public catalog, falls back to a bundled snapshot offline, and supports a custom registry. This is a useful product reference, not a requirement to copy its storage format or import trust model. [Kimi Code providers and models](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers)

For the target compatibility layer, current the reference agent setup documentation lists direct API-key use and managed cloud routes including Amazon Bedrock, Google Cloud’s Agent Platform, and Microsoft Foundry. Preserve these as distinct authentication/provider adapters where the target release documents them; a general provider manager can additionally expose OpenAI-compatible gateways and direct model APIs. Keep provider selection, model catalog metadata, and credential resolution separate: catalogs may suggest model/endpoints, but must not silently choose or read a credential. Store credential references (environment/credential-store handles) instead of plaintext API values in ordinary settings and logs. [the reference agent setup and provider access]([vendor source])

The multi-provider catalog and `/provider`-style interface are explicit project requirements from the user, informed by Kimi Code. They are not evidence that the reference agent itself supports a simultaneous provider catalog. A compatibility matrix should separate target-parity features from requested product extensions.

### 5. Service access, legal terms, and security boundaries

The current Consumer Terms (effective October 8, 2025) prohibit using the vendor's services to develop competing products, reverse engineer the services, and automated access except through an API key or where expressly permitted. The Commercial Terms (effective June 17, 2025) contain related prohibitions for offerings covered by those terms. Which agreement applies depends on the access route and account. This report does not determine whether a particular independent client or analysis activity is lawful; the terms are a project gate, not a legal conclusion. [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)

The reference agent’s legal and compliance page tells third-party developers to use API keys through the vendor's console or supported cloud providers and restricts offering the vendor's site login, collecting subscription credentials, or routing Free/Pro/Max credentials through a third-party app. Its subscription sign-in exception is for running the unmodified the reference agent binary under stated conditions. A compatible implementation should therefore avoid reusing consumer OAuth or private subscription sessions and should use a provider credential that its owner is authorized to use. Confirm the current applicable terms before service integration. [Legal and compliance]([vendor source])

Permission checks, sandbox boundaries, command approval, and credential handling are central security concerns for any coding CLI with filesystem and shell access. These are documented the vendor's documented safeguards and useful engineering requirements; the pages do not establish that every independent client has a legal duty to reproduce their exact implementation. [Security]([vendor source])

### 6. Comparable projects and evaluation practice

OpenCode, Codex, Gemini CLI, Cline, Goose, Crush, Pi, and Aider are useful coding-agent references, not proven replicas. Their public architecture guides support separating terminal presentation, session/agent orchestration, and tool integrations. OpenCode describes core/server, TUI, shared-app, and desktop packages; Goose describes interface, agent loop, and extensions. [OpenCode contributing guide](https://github.com/anomalyco/opencode/blob/dev/CONTRIBUTING.md), [Goose architecture](https://github.com/aaif-goose/goose/blob/main/documentation/docs/goose-architecture/goose-architecture.md)

The public evaluation practices suggest three complementary layers: deterministic contract checks for CLI/config/tool behavior, repeated behavioral evaluations for model-driven decisions, and end-to-end coding tasks evaluated by their test outcomes. Gemini CLI documents behavioral evals and repeat handling, Cline documents contract/smoke/real-task layers while noting automation changes, and Aider describes running task tests in Docker. These are methods, not comparative parity evidence. [Gemini CLI evals](https://github.com/google-gemini/gemini-cli/blob/main/evals/README.md), [Cline evals](https://github.com/cline/cline/blob/main/evals/README.md), [Aider benchmark](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md)

GitHub issue examples are individual reports only. OpenCode issue #23703 reports deprecated permission syntax from agent creation; Aider #2394 reports a repo-map stall; Aider #5058 is an unverified security report describing a prompt-injection-to-edit chain. These justify adding targeted test cases, not asserting those projects have generally established defects. [OpenCode #23703](https://github.com/anomalyco/opencode/issues/23703), [Aider #2394](https://github.com/Aider-AI/aider/issues/2394), [Aider #5058](https://github.com/Aider-AI/aider/issues/5058)

## Analysis and recommendations

1. **Pin the target before claiming compatibility.** Record the exact the reference agent version, distribution/package, host OS, architecture, and relevant authentication/provider mode. Docs and feature flags change quickly, and settings or startup behavior can vary by version.
2. **Establish an evidence ledger before implementation.** For each behavior, store the scenario, inputs, expected output/state, evidence type (official docs, REA static evidence, runtime observation, or inference), target version, and confidence. Use REA only on a specifically identified local artifact and within the applicable authorization and service terms.
3. **Deliver full scope in dependency-ordered stages.** The plan should include every target CLI domain—interactive and print operation, settings/context, tools and permissions, sessions, provider/catalog management, extensions, terminal UX, and integrations—while implementing stable foundations first. Every domain remains an explicit deliverable with a compatibility gate.
4. **Treat tools as a security boundary.** Permission decisions and filesystem/shell limits must be enforced by this implementation’s runtime, not left to model instructions. Keep credentials out of transcripts, debug output, and test fixtures.
5. **Make compatibility claims measurable.** Maintain golden scenarios from the pinned target for help/version output, stream records, settings precedence, continuation/resumption, permission prompts, and supported tools. Keep model-dependent coding tasks separate from deterministic contract tests.
6. **Keep work resumable across agents.** Maintain stable task IDs and one committed progress ledger containing completed/active/next tasks, evidence IDs and hashes, decisions, known blockers, and the exact next action. An incoming agent must update that ledger when it starts and before it hands off; task checkboxes and the ledger are the project’s source of truth, not chat history or assumed agent memory.
7. **Split the full surface into subprojects.** Core session/CLI, terminal interaction, settings/context, tool execution/permissions, provider/model catalog, MCP/hooks, skills/subagents/plugins, and editor/integration surfaces have separable interfaces and should each have explicit implementation milestones.

## Disagreements and open questions

- The pinned target is `the pinned reference build @ 2.1.303`, Linux x86-64, with its native ELF hash recorded in `docs/reverse-engineering/reference-agent-2.1.303-partial.md`. Current online documentation may describe later releases and must be tagged as documentation rather than evidence of this exact binary.
- “Full implementation” is defined here as broad observable feature parity with the pinned CLI. It does not claim source-code identity or private protocol access. The requested multi-provider catalog is a separate product extension.
- REA analyzed the npm JavaScript wrapper and has retained native Ghidra Evidence for ELF layout/startup, entry and helper dispatch, selected native handlers, a seccomp worker, and embedded strings. The broad Ghidra inventory still timed out at 330, 360, and 900 seconds. The current native record does not recover the embedded Bun application semantics or establish model/provider behavior; see the target REA record for Evidence IDs, limitations, and the active focused query.
- Applicable Anthropic terms and local law require project-specific review before reverse engineering or service use. The legal sources do not settle every question about a clean-room compatible client.
- The exact expansion beyond the explicit multi-provider requirement should be versioned in a provider matrix (protocol adapters, service routes, auth modes, and capability gaps). The current user intent requires multiple concurrently configured providers, not a single Anthropic-only adapter.
- Whether initial implementation should target one host first or all operating systems immediately remains a sequencing decision; the full plan should record platform coverage and defer no platform silently.
- Agent Reach was not available in this environment (`agent-reach` and `mcporter` were absent). The research subagents used the available web and GitHub read tools as a fallback; no logged-in social-platform research was needed for this technical topic.

## Full source list

### Official the reference agent and Anthropic sources

- [CLI usage]([vendor source])
- [Interactive mode]([vendor source])
- [Tools]([vendor source])
- [Permissions]([vendor source])
- [Permission modes]([vendor source])
- [Security]([vendor source])
- [Memory]([vendor source])
- [Settings]([vendor source])
- [Environment variables]([vendor source])
- [Slash commands]([vendor source])
- [MCP]([vendor source])
- [Hooks]([vendor source])
- [Skills]([vendor source])
- [Subagents]([vendor source])
- [Plugins]([vendor source])
- [IDE integrations]([vendor source])
- [Advanced setup and provider access]([vendor source])
- [Legal and compliance]([vendor source])
- [Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
- [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)

### Comparable implementation and evaluation sources

- [Kimi Code provider and model catalog](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers)

- [OpenCode](https://github.com/anomalyco/opencode)
- [OpenCode contributing guide](https://github.com/anomalyco/opencode/blob/dev/CONTRIBUTING.md)
- [OpenAI Codex](https://github.com/openai/codex)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Cline](https://github.com/cline/cline)
- [Goose](https://github.com/aaif-goose/goose)
- [Goose architecture](https://github.com/aaif-goose/goose/blob/main/documentation/docs/goose-architecture/goose-architecture.md)
- [Crush](https://github.com/charmbracelet/crush)
- [Pi](https://github.com/earendil-works/pi)
- [Aider](https://github.com/Aider-AI/aider)
- [Gemini CLI evals](https://github.com/google-gemini/gemini-cli/blob/main/evals/README.md)
- [Cline evals](https://github.com/cline/cline/blob/main/evals/README.md)
- [Aider benchmark](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md)
- [OpenCode issue #23703](https://github.com/anomalyco/opencode/issues/23703)
- [Aider issue #2394](https://github.com/Aider-AI/aider/issues/2394)
- [Aider issue #5058](https://github.com/Aider-AI/aider/issues/5058)
