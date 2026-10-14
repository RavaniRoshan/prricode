# Configuration

prricode resolves settings in this order, first match wins:

1. CLI flags (`--provider`, `--model`, `--base-url`, `--api-key`, `--api-key-env`)
2. Environment variables (per provider, below)
3. Config file (`~/.config/prricode/config.toml`, or `$PRRICODE_CONFIG`)
4. Preset defaults

## Providers

| Provider | `--provider` | Default base URL | API key env | Notes |
|---|---|---|---|---|
| Echo (offline) | `echo` | — | — | No network; replies with `echo: <input>`. For tests and protocol debugging. |
| Ollama (local) | `ollama` | `http://localhost:11434` | — | Native `/api` surface (tools, `think`, token counts). Override host with `OLLAMA_HOST`. |
| Ollama Cloud | `ollama-cloud` | `https://ollama.com` | `OLLAMA_API_KEY` | Hosted models with your Ollama account. Override host with `OLLAMA_CLOUD_BASE_URL`. |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | Sends `HTTP-Referer`/`X-Title` attribution headers. |
| Kilo AI Gateway | `kilo` | `https://api.kilo.ai/api/gateway` | `KILO_API_KEY` | OpenAI-compatible. `:free` models are usable anonymously (rate-limited). `KILO_ORG_ID` adds the `X-KiloCode-OrganizationId` header. |
| OpenAI | `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | |
| Custom | `custom` | required (`--base-url`) | your env var | Any OpenAI-compatible endpoint: `--base-url https://... --api-key-env MY_KEY`. |

## Config file

```toml
[defaults]
provider = "ollama"
model = "qwen2.5-coder:3b"

[providers.ollama]
base_url = "http://localhost:11434"

[providers.kilo]
api_key_env = "KILO_API_KEY"
default_model = "liquid/lfm-2.5-2.6b:free"

[providers.custom]
base_url = "https://my-gateway.internal/v1"
api_key_env = "MY_GATEWAY_KEY"
default_model = "my-model"
```

Per-provider keys: `base_url`, `api_key` (inline; prefer `api_key_env`),
`api_key_env` (name of an environment variable), `default_model`, `headers`
(extra HTTP headers).

## Secrets

Keep API keys in environment variables or `api_key_env` references. The config
file lives under `~/.config/prricode/` — never commit it. There is no telemetry;
keys are only sent to the provider you select.

## Data locations

| What | Where |
|---|---|
| Config | `~/.config/prricode/config.toml` (override: `$PRRICODE_CONFIG`) |
| Database, uploads | `~/.local/share/prricode/` (override: `--data-dir`) |
| Product Builder run worktrees | `<data-dir>/runs/<session-id>/` (a git worktree when run inside a git repository, otherwise a plain directory) |

## Product Builder stack presets

The spec domain defines five stack presets, but v0.1 passes no preset into the
pipeline: no preset is chosen during the Clarify interview. The Specify stage's
agent molds the stack from the concept itself (its prompt asks for the simplest
stack that fits the concept). Preset-guided selection during the pipeline is a
follow-up.

| Preset | Stack |
|---|---|
| TAN stack | TanStack Start + Postgres + Drizzle |
| Next.js | Next.js full-stack: App Router + Postgres + Prisma |
| MERN | MongoDB + Express + React + Node |
| FastAPI | Python + FastAPI + Postgres |
| Static + API | Static site generator + serverless functions directory |

## Examples

```bash
# local model, one-off turn
prricode exec "explain this workspace" --provider ollama --model qwen2.5-coder:3b

# Kilo free model, no key needed
prricode exec "say hi" --provider kilo --model liquid/lfm-2.5-2.6b:free

# any OpenAI-compatible gateway
prricode exec "say hi" --provider custom --base-url https://gw.example/v1 --api-key-env GW_KEY --model m1

# list models for a provider
prricode model-profile --provider openrouter

# serve the JSON-RPC protocol
prricode serve --provider ollama --model qwen2.5-coder:3b
```
