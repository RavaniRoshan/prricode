#!/usr/bin/env bash
# Read-only checkpoint for continuing the the reference agent REA investigation.
# It validates the pinned target and retained artifacts, reports resource/process
# state, then points the next agent to the authoritative handoff documents.
set -euo pipefail

readonly TARGET="/home/shiva/opt/reference-agent-target/node_modules/@anthropic-ai/reference-agent-linux-x64/agent"
readonly EXPECTED_SHA256="375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450"
readonly REA="/home/shiva/.npm/_npx/a1722018f28f9df2/node_modules/.bin/rea"
readonly EVIDENCE_ROOT="/home/shiva/opt/reference-agent-rea/evidence"
readonly HANDOFF="docs/reverse-engineering/CONTINUE-REA-PROMPT.md"
readonly PROGRESS="docs/PROGRESS.md"
readonly REPORT="docs/reverse-engineering/reference-agent-2.1.303-partial.md"

failures=0
check_file() {
  local label="$1" path="$2"
  if [[ -f "$path" ]]; then
    printf 'OK   %s: %s\n' "$label" "$path"
  else
    printf 'MISS %s: %s\n' "$label" "$path"
    failures=$((failures + 1))
  fi
}

printf '%s\n' 'the reference agent REA continuation preflight (read-only)'
printf '\n%s\n' 'Pinned target:'
check_file 'target' "$TARGET"
if [[ -f "$TARGET" ]]; then
  actual_sha="$(sha256sum "$TARGET" | cut -d ' ' -f 1)"
  if [[ "$actual_sha" == "$EXPECTED_SHA256" ]]; then
    printf 'OK   target SHA-256: %s\n' "$actual_sha"
  else
    printf 'FAIL target SHA-256 mismatch: expected %s, got %s\n' "$EXPECTED_SHA256" "$actual_sha"
    failures=$((failures + 1))
  fi
fi

printf '\n%s\n' 'Required tools and checkpoint documents:'
check_file 'REA 6.7.0 entrypoint' "$REA"
check_file 'handoff prompt' "$HANDOFF"
check_file 'progress ledger' "$PROGRESS"
check_file 'partial REA report' "$REPORT"
check_file 'latest provider-client Evidence' "$EVIDENCE_ROOT/ev_da5777199119d98bc71fad2e46b559d43e0197f1a05ba19f3edece849d6f2634.json.gz"
check_file 'Messages.create trace Evidence' "$EVIDENCE_ROOT/ev_6ae9a5cef8da13a2582ad70ea23915648b175cd6cbb58e0e2ed5bd08425b0fea.json.gz"

printf '\n%s\n' 'Available memory:'
if [[ -r /proc/meminfo ]]; then
  awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ { print "  " $0 }' /proc/meminfo
else
  printf '%s\n' '  /proc/meminfo unavailable'
fi

printf '\n%s\n' 'Potentially active REA/Ghidra analyses:'
if command -v pgrep >/dev/null 2>&1 && pgrep -af 'analyzeHeadless|rea analyze-|rea mcp|rea-agents' | grep -v 'rea-resume-preflight' ; then
  printf '%s\n' 'Review the listed processes before starting another analysis.'
else
  printf '%s\n' '  none detected'
fi

printf '\n%s\n' 'Next steps:'
printf '  1. Read %s, then %s and %s.\n' "$HANDOFF" "$PROGRESS" "$REPORT"
printf '%s\n' '  2. Follow the exact next action in PROGRESS.md; do not implement before the REA coverage audit.'
printf '%s\n' '  3. Keep one REA/Ghidra job at a time; use bounded memory and persist logs/status for long jobs.'
printf '%s\n' '  4. Update the handoff, progress ledger, and evidence report before ending the session.'

if (( failures > 0 )); then
  printf '\n%s\n' 'Preflight found missing or mismatched prerequisites; reconcile them before analysis.'
  exit 1
fi
