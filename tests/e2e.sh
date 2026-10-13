#!/usr/bin/env bash
# End-to-end scenario: drive `prricode serve` over stdio against a local
# Ollama model and verify the agent loop creates and runs a file.
#
# Requirements: ollama running locally with qwen2.5-coder:3b pulled
#   (ollama pull qwen2.5-coder:3b)
set -uo pipefail

BIN="${BIN:-./target/debug/prricode}"
MODEL="${MODEL:-qwen2.5-coder:3b}"
WORK="$(mktemp -d /tmp/prricode-e2e.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

req() { printf '{"jsonrpc":"2.0","id":%s,"method":"%s","params":%s}\n' "$1" "$2" "$3"; }

# Phase 1: create a session.
SESSION="$({ req 1 initialize '{"clientInfo":{"name":"e2e","version":"0"}}'; \
  req 2 session/start "{\"commandId\":\"00000000-0000-7000-8000-000000000001\",\"workspaceRoot\":\"$WORK\",\"approvalMode\":\"open\",\"modelId\":\"$MODEL\"}"; \
} | timeout 30 "$BIN" serve --provider ollama 2>/dev/null | python3 -c 'import sys,json
for line in sys.stdin:
    m=json.loads(line)
    if m.get("id")==2 and m.get("result"): print(m["result"]["sessionId"])')"

if [ -z "$SESSION" ]; then
  echo "FAIL: session/start did not return a session id"; exit 1
fi
echo "ok: session $SESSION"

# Phase 2: run a turn (stdin held open while the turn executes).
OUT="$({ req 3 turn/start "{\"commandId\":\"00000000-0000-7000-8000-000000000002\",\"sessionId\":\"$SESSION\",\"input\":[{\"type\":\"text\",\"text\":\"Create a file hello.py that prints hi, then run it with python3.\"}]}"; \
  sleep 180; } | timeout 200 "$BIN" serve --provider ollama 2>/dev/null)"

if echo "$OUT" | grep -q '"turn/completed"'; then echo "ok: turn completed"; else
  echo "FAIL: no turn/completed notification"; exit 1; fi
if echo "$OUT" | grep -q '"tool_use"'; then echo "ok: tool call executed"; else
  echo "FAIL: no tool_use item"; exit 1; fi
if [ -f "$WORK/hello.py" ]; then echo "ok: hello.py created"; else
  echo "FAIL: hello.py missing"; exit 1; fi

# Phase 3: unknown method returns -32601.
ERR="$({ req 4 bogus/method '{}'; } | timeout 10 "$BIN" serve --provider echo 2>/dev/null)"
if echo "$ERR" | grep -q '\-32601'; then echo "ok: unknown method -> -32601"; else
  echo "FAIL: unknown method error code"; exit 1; fi

echo "PASS: e2e scenario complete"
