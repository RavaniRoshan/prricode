# Continue the the reference agent REA investigation

Use this file as the handoff prompt for another coding agent. From the repository root, first run `bash scripts/rea-resume-preflight.sh`; it is read-only and checks the pinned target, key Evidence, memory, and active REA/Ghidra processes. Then read [`PROGRESS.md`](../PROGRESS.md) and [`reference-agent-2.1.303-partial.md`](reference-agent-2.1.303-partial.md) before running analysis. The detailed record and Evidence store are authoritative for completed work.

This handoff is intentionally usable without this conversation. The REA goal is active and implementation is blocked until its evidence coverage audit is complete. Current rough estimate: JavaScript source parsing is complete, while behavioral REA is about 30–40% complete; request/response, agent/tool/permission, configuration/session, MCP/extension flows, and the final audit remain. Treat that estimate as a planning estimate, not a measured completeness score.

## Copy-ready prompt

```text
Continue the active reverse-engineering goal for the pinned the pinned reference build (2.1.303) Linux x86-64 artifact. Do not begin implementation. The user requires the REA phase to be completed and audited before writing the final main plan. After REA, use the writing-plans skill to create the full plan, then use deep-research to support and refine that plan. Do not implement before both phases are complete.

First read, in full:
1. docs/reverse-engineering/CONTINUE-REA-PROMPT.md
2. docs/PROGRESS.md
3. docs/reverse-engineering/reference-agent-2.1.303-partial.md
4. the existing draft at docs/superpowers/plans/2026-10-19-compatible-cli-implementation.md and research/compatible-cli.md for context only; they do not authorize implementation or replace the required post-REA planning/research phase.

Resume the exact next action recorded in docs/PROGRESS.md. Do not repeat generic property-seed traces. Latest provider Evidence `ev_da5777199119d98bc71fad2e46b559d43e0197f1a05ba19f3edece849d6f2634` selected eight modules (591,013 AST nodes; 51,368 semantic nodes; 31,693 relations; 69,615 explicit unknowns). It contains the SDK pipeline and provider adapters; the detailed source observations and limits are in the REA report. Start by inspecting call-site nodes and `calls` relations around these exact SDK function nodes in `ev_da577...`: `makeRequest` node `jsrg_node_c882e1f11557aef82dc2d15b9f11812c7a4041042bcd448b77b41b1f592b4e6c` / fingerprint `75c0bf92d7deb464ca8d5422f705b5e7226c34fd9f8e780e28cd2f1881cafacf`; `buildRequest` node `jsrg_node_7405849fbbaecd8ca2161a0bce7fe0858104ff8e1aa4991e73b44cda1873d196` / fingerprint `25d99a12572691454f1d13672a2a41e097e1327d7ef46c0144edbcdf1995974b`; `buildHeaders` node `jsrg_node_886dd770dbf7d06aeff5ee11ee6d108c24912da99a734cedd298422ba2b81a8c` / fingerprint `f97229c50964aa4de2144cea42735cb151755c313cdb33bbb3c2c44f474c43cc`; SDK `authHeaders` node `jsrg_node_347d3f741b276c9d5554a8a26d6f1055a9aceaae3b621af74754b2a2d1310326` / fingerprint `5f7043b15c3c08b98b0fa52ffa86f9245687e4b047efca15c956c75e99c084c2`; `buildURL` node `jsrg_node_f65905ada34b0756de9369e3e7b71646bb0715c079fdc5c6388cc02b78382a03` / fingerprint `6f5d3089afa1fdb7b0ec9d1364fffa48ade9becdf16aa4d36c5d8223bc0054d1`. The semantic graph stores call relations on `call-site` nodes whose `function_node_id` points to the owner function; inspect these node IDs and relation endpoints before choosing trace seeds. For the app-side Mantle check, inspect functions `O` and `z` in `chunk-n09frcwc.js` in the same Evidence. If relations remain unresolved, retain the exact call-site expression/location and mark it unknown rather than inferring runtime dispatch. The focused `Messages.create` trace `ev_6ae9...` had no resolved outgoing call edges and five dynamic member-call unknowns; source `chunk-e0p2z0nm.js` still shows standard `/v1/messages` and beta `/v1/messages?beta=true` construction, but that does not establish the runtime provider route. A fresh offline inspection of the retained supervisor Evidence and exact table bytes confirmed that syscall cases select records at `0x6c749c0`, whose entries contain syscall-name pointers and argument metadata. The supervisor uses that metadata around `process_vm_readv` and `readlinkat` to obtain and log path arguments; the exact metadata encoding and per-syscall decision policy remain unknown. Reuse completed evidence; do not repeat extraction, all-at-once Ghidra inventory, or completed source batches. Preserve the target SHA-256 and separate direct observations, static inference, official documentation, runtime behavior, and unknowns. Run only one Ghidra/REA analysis at a time. Keep long jobs detached with persisted PID/status/log files, bounded memory, and a trap that restores the installed REA runtime. Check WSL memory and runtime restoration before and after each batch. The user permits up to 1 GiB additional memory if needed, but WSL has only about 6–8 GiB total; do not increase concurrency.

The exit gate is an evidence-backed coverage audit of CLI/configuration, providers and model catalogs, provider request/response construction, agent loop and tool dispatch, permissions, sessions/resumption, MCP/plugins/hooks/extensions, and native/platform sandbox paths. Full source-path parsing is already complete; the remaining work is semantic tracing, not reparsing every file. State limits plainly. Do not claim literal completeness where REA cannot establish it. If the exit gate cannot be met, leave implementation blocked and checkpoint the precise gap and next action.

The user's product target is full observable the pinned reference build (2.1.303) parity, with a deliberate extension for multiple concurrently configured provider connections and provider-owned model catalogs (Kimi Code-style). Treat that multi-provider manager as a project requirement, not a behavior observed in the reference agent. Keep durable progress markers and update docs/PROGRESS.md after each meaningful batch with Evidence IDs, status, limitations, and the next exact action.
```

## Pinned target and local tools

- Target: `/home/shiva/opt/reference-agent-target/node_modules/@anthropic-ai/reference-agent-linux-x64/agent`
- SHA-256: `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`
- Version: `2.1.303`; only the bounded `--version` command was run. No authenticated model session/request was started.
- REA CLI: `/home/shiva/.npm/_npx/a1722018f28f9df2/node_modules/.bin/rea` (`rea-agents@6.7.0`)
- Ghidra: `/home/shiva/opt/ghidra_12.1.4_PUBLIC` (`12.1.4`), Java 21 at `/usr/lib/jvm/java-21-openjdk-amd64`
- Evidence root: `/home/shiva/opt/reference-agent-rea/evidence/`
- Native Evidence index: `/home/shiva/opt/reference-agent-rea/native-index/`
- Source-batch index: `/home/shiva/opt/reference-agent-rea/source-batches/index/`

Verify the target before analysis:

```sh
sha256sum /home/shiva/opt/reference-agent-target/node_modules/@anthropic-ai/reference-agent-linux-x64/agent
```

## Completed work

- Bun payload extracted with retained manifest and source hashes. All 2,434 parseable JavaScript source paths were covered in bounded batches; three Zstandard-compressed sources were separately decompressed and analyzed. The 4,994,887-byte source that exceeded a 512 MiB worker heap passed on an isolated 1 GiB worker heap.
- Feature-focused source Evidence exists for provider/model code (`ev_88e9...`), MCP/plugins/hooks (`ev_27fa...`), permission/session/agent flow (`ev_3cdd...`), CLI/config (`ev_832e...`), provider route/catalog (`ev_9ba...`), and MCP control/handlers (`ev_592...`). Exact full IDs and limitations are in `docs/PROGRESS.md` and the detailed REA record.
- Important provider finding: the target has built-in adapters/catalog entries for several providers but the examined selector chooses one active route. This does not establish a user-managed multi-provider connection registry.
- Native `apply-seccomp` worker `0x1d21790` was reanalyzed with observed callees seeded: Evidence `ev_03f243709e8d7a715417e1b5423040b0699e83e080e8a3e34d2bab35c52b75b0`. It names 29 direct callees and reports zero unresolved calls. Pseudocode shows environment reads, namespaces, forks, mounts, `prctl`, seccomp setup, descriptor transfer, waiting, and `execvp`.
- Native seccomp notification supervisor `0x1d22440` was reanalyzed with seven import thunks seeded: `ev_675b0f67ffcb65b3210844369bc84963d66b4e552360bc61aa68ae7987fcaf7d`. All 16 direct callees are named and `unresolved_calls` is empty. A 241-case switch table is reported at `0xfa0f30`; complete per-syscall policy is still unknown.
- Its static table at `0x6c749c0` was read byte-exactly (648 bytes), Evidence `ev_7f3b70f348ad82e0462ade7bb1e07dec88154d51f868884e8f809f20d40c5ef8`. The 27 first-word syscall IDs map to filesystem syscalls. Record schema and action per syscall remain unresolved. Do not treat field `0x2463b9` as a function pointer: an exploratory seed produced invalid disassembly and is marked rejected in `native-index/seccomp-openat-handler.json`.
- Two semantic forward traces against the provider-route Evidence were partial: property `model` had zero seed matches and 15,102 relevant unknowns (`ev_d21c1677953c2bc54d9b7003ad3e602a58ae06cdf5b2b37fb2b28eab37572b6b`; input about 162 MB); property `models` matched one ambiguous node but traversed no relations and had 15,103 relevant unknowns (`ev_d5f5ea8458626a4eecf35373beff457438da93f0259e4fe546b73cee500370cb`; input about 54 MB). The latter locates a property slot in `chunk-w4f5s3e0.js`, not behavior. Do not repeat generic property traces; inspect function fingerprints/relations and select a concrete request-construction function.
- Broad whole-binary Ghidra inventory timed out at 330 seconds and again at 900 seconds. The selected-function workflow is viable; the full image inventory is not currently available. This does not prevent targeted REA.

## Safe operating procedure for WSL

The WSL has roughly 6–8 GiB total RAM. This user authorized up to 1 GiB additional headroom if it helps, but has previously experienced WSL crashes. Stability and recoverability take priority over parallelism.

1. Never run two REA/Ghidra analyses concurrently. Keep CPU-heavy work sequential.
2. Before a native job, check `free -h`, `ps -eo pid,ppid,rss,comm,args --sort=-rss | head`, the target digest, and whether the installed REA runtime matches `/tmp/rea-runtime-stock.js`.
3. Use the established detached wrapper pattern: `nohup setsid /path/to/job.sh > /tmp/<job>.log 2>&1 < /dev/null &`; persist a PID file and write `running`/exit status to a status file. Poll every 20–40 seconds and send a short progress update if work continues.
4. Current tested native settings: `GHIDRA_HEADLESS_MAXMEM=1536M`, `REA_GHIDRA_STARTUP_TIMEOUT_MS=1200000`, two Java GC/compiler threads, and disabled expensive broad analyzers. Keep the REA Node parent cap around 2.5 GiB. Normal JS workers used 512 MiB; one unusually large JS file required 1 GiB. Increase only for an isolated job with memory available.
5. Existing wrappers temporarily copy `/tmp/rea-runtime-patched.js` over `dist/cli-runtime/binary-CWVNJhAC.js` and restore `/tmp/rea-runtime-stock.js` in an `EXIT` trap. Do not edit the installed runtime manually. After every wrapper, verify byte equality:

   ```sh
   cmp -s /tmp/rea-runtime-stock.js /home/shiva/.npm/_npx/a1722018f28f9df2/node_modules/rea-agents/dist/cli-runtime/binary-CWVNJhAC.js
   ```

   Exit status `0` means restored. Do not launch another REA process until restoration is confirmed.
6. Preserve complete returned Evidence JSON compressed under the Evidence root and add a compact metadata entry to the relevant index. Keep the per-query/source selection and target SHA visible.
7. Never execute the target beyond the already completed bounded `--version` check without explicit new user direction. The REA operations so far are static; do not start an authenticated model request.

## Next work order

1. Continue provider semantics from `ev_da577...`: inspect owner-linked call-site nodes and `calls` relations for the exact request-pipeline function nodes/fingerprints listed in the copy-ready prompt; inspect the Mantle application functions `O` and `z`. Save query Evidence and update the REA report/progress ledger. Do not reparse the source or repeat `model`/`models` property traces.
2. Trace the agent turn path from model selection/request construction through response parsing, tool-call dispatch, permission response, and continuation. Use existing permission/session Evidence and add focused source selections only where a needed module was not already covered.
3. Trace config precedence and session persistence/resumption with direct callers/callees; note which behavior is still only inferred from names.
4. Complete MCP/plugin/hook control request and lifecycle paths.
5. Reconcile the feature matrix against all requirement groups and mark each `observed`, `inferred`, `documented only`, `partial`, `unknown`, or `not applicable`, with exact Evidence links. State remaining unknowns and decide whether the REA exit gate is met. Keep implementation blocked until then.

## Current checkpoint

- Worktree: `/home/shiva/projects/prricode`.
- Durable current docs: `docs/PROGRESS.md`, `docs/reverse-engineering/reference-agent-2.1.303-partial.md`, and this file.
- Read-only continuation preflight: `bash scripts/rea-resume-preflight.sh`.
- No implementation work has started. There are existing plan/research drafts; the user requires the REA phase before final planning. After REA, use `writing-plans` first to create the main plan, then `deep-research` to support and refine it. Update the plan with the user's full-implementation and multi-provider extension requirements; do not implement before that work is complete.
- Do not mark the REA goal complete while the request/response, agent/tool/permission, session/config, MCP/extension paths and coverage audit remain.
