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

**The REA phase is complete and its exit gate is met.** The coverage audit at [`COVERAGE-AUDIT.md`](COVERAGE-AUDIT.md) is the authoritative record of what is established, what is partial, and what is unknown. The planning and research phases have been completed and the implementation plan is at [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md). Implementation is running against that plan; `docs/PROGRESS.md` is the live ledger.

**Three REA items were closed this session**, and two remain open:

- **Closed — the response path.** The default `parseResponse` (`ai`) is read in full, and the bundled SDK's SSE parser accepts an **extended event vocabulary** (`agent.*`, `session.*`, `span.*`, `user.*`) the public API does not document.
- **Closed — the native sandbox.** The 27-record table at `0x6c749c0` is **decoded**: the records are `{u64 nr; u64 name_ptr; u8 meta[8]}`, the names were read out of the ELF's string table, and the metadata bytes are **argument indices** (path, second path, flags/mode, dirfd, second dirfd) with `0xff` meaning absent. The supervisor **never denies** — its response struct's `error` field is never written — so the `apply-seccomp` helper is an **audit mechanism, not the sandbox boundary**.
- **Closed — the provider adapter wire shapes.** Bedrock, Vertex, Mantle and Foundry were re-derived from the target's own bundled adapters (`chunk-1njnz05e.js`, `chunk-jdnh8sjs.js`, `chunk-m5c0c57d.js`). This corrected two external-research findings: the target **throws** on a Foundry `baseURL`/`resource` conflict, and the `?beta=true` marker is a distinct path variant the Bedrock and Vertex adapters strip.
- **Closed — the `--resume` selection.** A session id or an **exact** session title (an ambiguous title is an error listing the candidates), the live-session **attach** short-circuit that `forkSession` bypasses, `--resume-session-at` with its **drop guard**, and the structured resumed state are all established.

Two items remain open:

1. **The `--continue` selection rule** (the "most recent session in this directory" rule) and the session-row index. The session controller's semantic graph is bounded by the REA transfer byte budget at 40,000 nodes, so the region holding the rule may lie outside the retained graph.
2. **The agent-loop tool scheduling** — the order of concurrent tool calls and the point at which the next model request is issued. Every call in those functions is a **member call** (`this.x(...)`), which REA does not resolve into a `calls` relation, so this needs source reading rather than a better tool. What *is* established: the tool-result content shape and the pairing rules.

### Two operational rules that are now mandatory

- **Never run a multi-module `analyze_javascript_application` for semantic work.** REA truncates a semantic graph at 20,000 nodes **per source file**, so every multi-module selection was truncated for its larger modules. Use the per-module scripts in `/home/shiva/opt/reference-agent-rea/analysis/`: `run-js-module.sh` (one module, raised ceiling), `run-js-module-retry.sh` (one module, one ceiling), `run-js-module-ladder.sh` (one module, a ceiling ladder that keeps the largest result), `run-js-module-queue.sh`, and `run-js-module-retry-queue.sh`. 21 of the 26 selected modules now have untruncated graphs; the other five hit a hard transfer-byte-budget limit at 40,000–60,000 nodes and the ladder is the best available.
- **Never seed `trace_javascript_semantics` with a function node for call-graph work.** The traversal starts at the seed, and `calls` relations live on `call-site` nodes, so a function seed returns zero relations (Evidence `ev_d03585bca46461d87174de69bc5784f7c76f8712a86e557d9e5b165886838e5b` records this: 1 node, 0 relations, 11,820 unknowns). Seed with a `semantic-node` call-site id instead; `/home/shiva/opt/reference-agent-rea/analysis/seeds.py` lists the call-site ids owned by a function, and a call-site seed is verified to traverse (Evidence `ev_07c6555c7cc727a9ae4bd4db0ed932444ed7d7438d07e49773d6e8e20239b4cb`).

Useful offline tooling, all under `/home/shiva/opt/reference-agent-rea/analysis/`: `semgraph.py` (semantic-graph queries), `fn.py` (one function's call map), `index.py` (named-function index for a module), `seeds.py` (call-site ids), `callmap.py`, `extract-graph.py` (split the embedded semantic graph out of a record), and `run-js-trace.sh` (a semantic trace against a retained record). Per-module Evidence records are in `analysis/modules/`, each with its own `evidence_id`.

## Current checkpoint

- Worktree: `/home/shiva/projects/prricode`.
- Durable current docs: `docs/PROGRESS.md` (live ledger), `docs/reverse-engineering/COVERAGE-AUDIT.md` (the behavioral spec and the gate state), `docs/reverse-engineering/reference-agent-2.1.303-partial.md` (the evidence record), and this file.
- Planning and research are complete: `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md` and `research/reference-agent-2.1.303-research.md`.
- The implementation is complete against the plan, using the `subagent-driven-development` workflow: a fresh implementer subagent per task, a task review after each, and a scoped re-review of the fixes.
- Read-only continuation preflight: `bash scripts/rea-resume-preflight.sh`.
- The REA exit gate is **MET**: all eight requirement groups in the coverage audit's §5 are met, every one of them on the target's own text. The last four were closed by source reading — the per-top-level-key settings merge (§2.7), the tool-call scheduling (§2.4), the store-level session-lookup ordering (§2.6) and the two extension lifecycles (§2.8) — and their records are in `/home/shiva/opt/reference-agent-rea/analysis/findings-*.md`.
 carries them as `CC-001` steps.
- The REA goal is **complete**: the agent-loop scheduling, the session-resume algorithm, the extension lifecycles and the native per-syscall policy are all resolved, and the gate is met.
