# Provider Track — connections & selections for a model-agnostic harness

## 0. Goal

prricode's loop is already model-agnostic at the client level: one
OpenAI-compatible client, the Ollama native client, and echo implement the same
`ModelProvider` trait. What is missing is the **product surface** that makes an
engine a choice rather than a config-file edit:

- several named **connections** can point at several endpoints (including two
  endpoints of the same kind), each with its own credential surface;
- a connection can be **verified** before it is used — honestly, with either a
  pass (latency, model count) or a fail reason, never a fake success;
- a session can be **re-pointed at a different engine at runtime** without a
  restart;
- capability metadata (`supports_tools`, `supports_streaming`) lets the turn
  loop degrade honestly on engines that lack a feature.

This advances the product requirement "works with any model" from "works if
you hand-edit TOML" to a first-class connect/verify/select surface, reachable
from the TUI first and the file/env layer second.

## 1. Constraints (unchanged from AGENTS.md)

- Additive protocol only: new `provider/*` / `connection/*` methods, new
  fields with `#[serde(default)]`; the schema fingerprint const never changes.
- No third-party names anywhere new; provider kind ids already accepted stay.
- Credentials in the 0600 store or env vars; an inline `api_key` in a
  connection file keeps working for single-user machines but is documented as
  the discouraged surface.
- Honest degradation everywhere: a connection that cannot be built reports
  `unsupported: <why>`, never a pretend provider.
- TDD per slice; workspace suite is the gate; one commit per phase item.

## 2. Architecture decisions

- **Config layer**: `[connections.<name>]` table in `config.toml`
  (`kind` required; `base_url`, `model`, `api_key_env`, `headers` optional).
  `defaults.connection` names the startup connection; resolution order:
  `--connection` CLI flag > `PRRICODE_CONNECTION` env > `defaults.connection`
  > existing kind-based path (untouched fallback — additive).
- **Credential layer**: the store gains connection-keyed entries
  (`connection:<name>`); kind entries keep working.
- **Server layer**: a provider registry
  (`HashMap<connection_id, Arc<dyn ModelProvider>>`) built from connections at
  load, extended on demand. `SessionState` gains a `connection_id`; the turn
  resolves the runner's provider snapshot per turn so a running server can
  re-point sessions without restarts.
- **Protocol layer**: `provider/list`, `connection/test`, `session/setEngine`
  (notification `session/engineChanged`). All additive.
- **Capability layer**: `ModelInfo` gains `supports_tools` /
  `supports_streaming` (serde default `true`); the turn loop drops tools and
  streams accordingly when a model says it cannot; unknown engines default to
  capable and fail honestly per request.

## 3. Phases

1. **Named connections in config** — parse `[connections.<name>]`, resolution
   order, CLI `--connection` on `serve`/`exec`, connection-keyed credential
   entries, `create_provider_for_connection`. Tests: parse, resolve precedence,
   kind fallback, credential lookup.
2. **Protocol: connections & verification** — `provider/list` (kinds +
   connections + active), `connection/test` (list_models probe or 1-token
   chat; honest latency + failure reason), `connection/add` persisting to the
   settings table with the credential to the store (file config stays the
   primary). Tests over the dispatch surface with a mock HTTP server.
3. **Runtime engine selection** — per-session `connection_id`, provider
   registry, `session/setEngine <connection> [model]`, `engineChanged`
   notification; TUI `/provider <connection>` switches the live session (no
   restart), restart warning kept only for composer-level state that cannot
   move mid-turn. Tests: switch mid-session, turn uses the new provider
   (probe-provider pattern from the micro-compaction tests).
4. **Capability metadata & loop degrade** — `supports_tools`/`supports_streaming`
   on `ModelInfo` and `ConnectionSettings`; the request builder omits tools and
   the stream path falls back to `chat` when `false`; session/model catalog
   surfaces the flags. Tests: capability-off loop runs text-only end to end.
5. **Docs & live verification** — `connect-a-provider.md` rewritten
   connections-first, `tui-guide.md` `/connections` + `/provider` behavior,
   `run-the-tests.md` gains the connection-test + switch steps, matrix +
   tracker rows closed.

## 4. Honest degradations registered up front

- Engines whose endpoints are not OpenAI-compatible are out of the harness's
  reach today: `connection/test` failing says exactly which request failed.
- Composer-level provider state that cannot move mid-turn keeps its restart
  note; the note names what stays stale rather than claiming a full switch.
- OAuth-based provider auth remains the mcp_auth-style honest stub (existing
  disposition).

## 5. Done means

Every row in the tracker section "Track 2" is `done` (tested on Linux) or
`degraded` with a durable reason; docs ship in the same commit as their
feature; markers `| pending` / `| partial` are empty at the end.
