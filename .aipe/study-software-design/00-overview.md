# Overview — software design audit (one page)

This guide applies Ousterhout's *A Philosophy of Software Design* to **this repo**, in two passes.

## The shape

```
.aipe/study-software-design/
  ┌─ Pass 1: the audit ──────────────────────────────────────┐
  │  audit.md                                                  │
  │    8 lenses, one ## section each, ranked findings at end   │
  │    every claim grounded in file:line                       │
  └────────────────────────────┬─────────────────────────────┘
                               │  cross-links to ↓
  ┌─ Pass 2: discovered patterns ───────────────────────────┐
  │  01-mcp-client-deep-module.md (BloomreachDataSource post-rename)│
  │  02-shallow-module-page-component.md  RESOLVED — example │
  │  03-insight-anomaly-silent-leak.md    RESOLVED — example │
  │  04-synthesize-recovery-duplication.md RESOLVED — example│
  └─────────────────────────────────────────────────────────┘
```

## The verdict in one paragraph

**2026-06-15 state.** The codebase is well-designed at the module level. The three top fires from 2026-06-02 (page.tsx shallow module, Insight↔Anomaly leak, duplicated `synthesize()`) have all RESOLVED. Phase 2 added a textbook deep-module case study — the `DataSource` seam in `lib/data-source/` (a 73-LOC interface with two adapter implementations of ~214 and ~197 LOC behind it, plus a 113-LOC factory hiding four orthogonal facts) — and a special-purpose-vs-general-purpose call (the `mcp-server-olist/` sibling package ships three domain tools instead of one general `execute_sql`). The remaining live debt is small: inline-CSS drift in `InsightCard.tsx`, partial pull-down opportunity on `synthesisInstruction` boilerplate ×4, and two vague names in `lib/insights/derive.ts`. The biggest named trade-off is keeping `lib/mcp/client.ts` as a 17-line backwards-compat shim — explicitly to avoid 16 test renames for zero behavioral win.

## Reading order

1. **`audit.md`** first. The one-pass survey. Walks all eight APOSD lenses against the post-Phase-2 codebase. Records resolutions from the 2026-06-02 set and names the new deep-module + special-purpose-interface findings. Top 3 ranked findings (now LOW/MEDIUM) at the end.

2. **Pass 2 pattern files** as worked examples (three of four RESOLVED, kept for the lesson):
   - `01-mcp-client-deep-module.md` — the deep-module case study. Updated header notes the class rename to `BloomreachDataSource` and points to the audit's deep-vs-shallow-modules lens for the new DataSource-seam case study.
   - `02-shallow-module-page-component.md` — RESOLVED. Kept as the worked example of how the shallow→deep refactor played out (page 817→462 LOC + three hooks), with post-fix calibration on LOC vs visibility-surface deltas.
   - `03-insight-anomaly-silent-leak.md` — RESOLVED. Kept as the worked example of colocate-then-comment-then-test; the post-fix lesson names how comments carry intent TypeScript can't enforce.
   - `04-synthesize-recovery-duplication.md` — RESOLVED. Kept as the canonical "define it out of existence" worked example; the post-fix lesson names why this beat a shared helper.

## Through-line

**Complexity is the enemy; deep modules are the weapon.** Every pattern file is a different facet of the same axis — interface size vs absorbed behavior. The deep modules earn their place by hiding decisions every caller would otherwise have to make. Phase 2 added two more weapons to this rack: the DataSource seam (a deep module at the *architecture* seam, not just a single-class hide) and the domain-tool MCP server (the choice to narrow the interface rather than maximize it). The three resolved fires — shallow page, silent leak, duplicated recovery — are now case studies in how the move was made, not pieces of live debt. The lesson scales: the same axis names the wins AND the (now-historical) losses.

## Cross-references

- `read-aposd/` (when present) — the conceptual treatment of every primitive named here. Read for the framework; read this guide for the audit.
- `study-system-design/` — the system-architecture altitude. The new `DataSource` seam lives at the boundary between code-level design (this guide) and system-design (services, request flow, scaling). Findings about routing, OAuth boundary, NDJSON streaming live there.
- `study-dsa-foundations/` — algorithm and data-structure curriculum. Not exercised in this guide.

---
Updated: 2026-06-16 — verdict paragraph rewritten for post-Phase-2 state (DataSource seam, domain-tool server, 3 top fires resolved); reading order updated to flag the resolved pattern files as worked examples with kept lessons; through-line expanded to name Phase-2 additions.
