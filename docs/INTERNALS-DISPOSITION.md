# Internals Disposition

Every internal struct family found in the engine surface (364 Debug-visible
names, 251 families) is dispositioned in
`crates/prricode-core/src/internals.rs` — a queryable inventory:

```rust
let (implemented, flagged) = prricode_core::internals::counts();
for surface in prricode_core::internals::inventory() { /* family, members, disposition, location */ }
```

**Dispositions:**
- **Implemented** — the concept exists in prricode under our own naming
  (sessions, items, goals, workflow runs, tool results, model catalogs,
  approvals + policy amendments, subagents, worktrees, media, usage, MCP,
  themes, ship/verify/pipeline). These types had no protocol-wire presence;
  mirroring their internal names would add compatibility debt, not conformance.
- **Flagged** — present in the inventory with a `future work:` note naming what
  is not built: agent inbox/reminder delivery, peer admission, branch-seed
  diagnostics, async-owner attempt links, code-mode grants, cost-forecast and
  audit-wire families, and other runtime-only concepts.

A test asserts every family carries an explicit disposition and that flagged
entries name their future work, so the inventory cannot silently drift.

**Why this replaces "deliberately not mirrored":** the earlier phrasing left
internals unaccounted. The inventory makes each one an explicit, greppable
decision — implemented or flagged — which is what zero-open-gaps means for the
engine surface.
