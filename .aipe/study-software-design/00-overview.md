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
  │  01-mcp-client-deep-module.md         the deep canon    │
  │  02-shallow-module-page-component.md  the shallow canon │
  │  03-insight-anomaly-silent-leak.md    the worst leak    │
  │  04-synthesize-recovery-duplication.md the define-out   │
  └─────────────────────────────────────────────────────────┘
```

## The verdict in one paragraph

This codebase is mostly well-designed at the module level. `McpClient` is a textbook deep module (172 LOC of cache + spacing + retry + error-tagging behind 3 methods); `runAgentLoop` is one function reused by four agents with no duplication; error handling clusters at three intentional boundaries. The load-bearing gap is in the UI band: `app/page.tsx` (817 LOC, 8 concerns, 14 useState slots) is the worst shallow module in the repo. The highest-priority finding is that one file — extracting three hooks retires the cognitive-load hotspot and the parser duplication it carries. Two other deliberate fixes ride along: the Insight↔Anomaly silent field-drop (three locations, TypeScript can't catch it) and the duplicated `synthesize()` recovery method (two copies of the same special case the agent loop should own).

## Reading order

1. **`audit.md`** first. The one-pass survey. Walks all eight APOSD lenses against the codebase and ranks the top 3 fixes at the end. Lenses with significant findings cross-link to the pattern files below.

2. **Pass 2 pattern files** in order:
   - `01-mcp-client-deep-module.md` — what a deep module looks like in this repo (the model to learn from).
   - `02-shallow-module-page-component.md` — the opposite shape, the file to fix first.
   - `03-insight-anomaly-silent-leak.md` — the worst information leak; the fix retires it in one diff.
   - `04-synthesize-recovery-duplication.md` — the duplicated special case; the lift deletes ~90 LOC.

## Through-line

**Complexity is the enemy; deep modules are the weapon.** Every pattern file is a different facet of the same axis — interface size vs absorbed behavior. The deep modules earn their place by hiding decisions every caller would otherwise have to make. The shallow module fails because nothing is hidden. The leak fails because the same knowledge lives in three files. The duplicated recovery fails because the same strategy lives in two. All four files are the same lesson at different scales.

## Cross-references

- `read-aposd/` (when present) — the conceptual treatment of every primitive named here. Read for the framework; read this guide for the audit.
- `study-system-design/` — the system-architecture altitude (services, boundaries, scaling). Findings about request flow, OAuth boundary, streaming NDJSON live there, not here.
- `study-dsa-foundations/` — algorithm and data-structure curriculum. Not exercised in this guide's findings; the complexity here is structural, not algorithmic.
