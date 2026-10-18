# Parity Target

## In scope for v1 parity

Core CLI runtime, interactive REPL, tool surface, slash command surface, permission/approval flows, MCP client and server surfaces, skills, sessions and history, settings and keybindings, themes, sandbox, git helpers, LSP, voice, vim mode, remote/bridge/server mode, coordinator and multi-agent mode, tasks and cron, plugins, and the existing product-builder pipeline layered on top.

## Exclusions (with reasons)

- Ant-only or account-gated internals that require proprietary services: excluded; degrade with `unsupported: requires proprietary service`.
- Telemetry and analytics collection: excluded by public repo hygiene and no-telemetry posture.
- Platform-specific native binaries that cannot be redistributed: excluded; use host prerequisites or degrade.
- Features that cannot run on the current host: degrade with an explicit reason, never fake success.

## Deprecation policy

The product-builder pipeline is retained and layered on top of the parity base. It is not removed during parity work; pipeline commands remain available.

## Naming policy

No third-party product or company names appear in code, docs, commits, or identifiers. The reference implementation is referred to generically as "the reference terminal agent" in shipped artifacts.
