# blooming insights — software design audit (APOSD applied)

> Ousterhout's *A Philosophy of Software Design* (2nd ed.) is the source of every primitive named in this guide — deep modules, information hiding, complexity, layering, readability, pull-complexity-downward, errors-as-special-cases. Read the book for the framework; this guide is the audit. The companion `read-aposd/` guide (when present) teaches the primitives in their own right.

This guide applies APOSD to **this repo**. Every claim cites a real file path and, where it sharpens the point, a line range. Every finding opens with a verdict, names the one move that matters most, then ranks the rest. Where blooming insights honors the primitive, that's praise — and it's a finding. Where it violates it, that's debt — and it's named plainly, with the move.

**The 2026-06-02 → 2026-06-15 update.** All three top fixes from the original audit have landed (page.tsx three-hook extraction, `insightToAnomaly` colocation, `synthesize()` lift). Phase 2 added two strong deep moves: the `DataSource` seam (`lib/data-source/`) and the domain-tool `mcp-server-olist/` sibling package. The current audit reflects the post-Phase-2 state; the four pattern files are kept as worked examples (two RESOLVED, two updated).

## The through-line

**Complexity is the enemy. Deep modules are the weapon.** A deep module hides a lot of behavior behind a small interface — the caller learns a thin contract, the body absorbs the mess. The 2026-06-02 audit identified `McpClient`, `runAgentLoop`, and `coverageFor` as the deep canon and a 817-LOC client component as the worst shallow offender. The 2026-06-15 audit records that the page got extracted (817→462 LOC + three hooks) and the codebase grew two new deep modules at the seam level: `DataSource` (a 73-LOC interface with two adapter implementations behind it) and the `makeDataSource` factory (hides adapter selection, OAuth, subprocess spawn, dispose semantics).

```
The audit, ranked (2026-06-15)

  ┌─ what's deep and earns its place ───────────────────────┐
  │ DataSource seam      (interface 72 LOC + ~600 LOC behind it)│  ← NEW canon
  │ BloomreachDataSource (214 LOC, was McpClient — rename)  │
  │ OlistDataSource      (197 LOC, subprocess adapter)       │
  │ makeDataSource fac.  (113 LOC, hides 4 orthogonal facts) │
  │ runAgentLoop         (one fn, 4 callers, recovery lifted)│
  │ mcp-server-olist     (3 domain tools, no general SQL)    │
  │ coverageFor + cats   (pure schema gate, unchanged)       │
  └────────────────────────────────────────────────────────┘
                       │
                       │  contrast with…
                       ▼
  ┌─ where complexity leaks upward (much smaller now) ─────┐
  │ InsightCard.tsx      (495 LOC, inline-CSS heavy)        │  ← new ceiling
  │ synthesisInstruction (×4, partial pull-down opportunity)│
  │ lib/mcp/client.ts    (17-line shim, honest trade-off)   │
  └────────────────────────────────────────────────────────┘

  RESOLVED since 2026-06-02
    app/page.tsx — three hooks extracted, 817→462 LOC
    insightToAnomaly — colocated + intentional-drop comment + round-trip test
    synthesize() ×2 — lifted into runAgentLoop as parseResult/recoveryPrompt
```

## How to read this guide

Two passes:

1. **`audit.md`** — the one-pass survey. Walks the eight APOSD lenses against the codebase: complexity hotspots, deep vs shallow modules, hides and leaks, layers and pass-throughs, configuration ownership, error strategies, readability, and the red-flags capstone. Lenses with nothing get one line; lenses with significant findings cross-link to the deep walks below.

2. **`01-` through `04-`** — the discovered pattern files. Each one is a deep walk on a single design move the repo actually exercises. Read in order; later files build on earlier ones.

## Files

```
.aipe/study-software-design/
  README.md                                 (you are here)
  00-overview.md                            one-page orientation
  audit.md                                  PASS 1 — the 8-lens audit, ranked (post-Phase-2)
  01-mcp-client-deep-module.md              deep canon, now BloomreachDataSource (rename note)
  02-shallow-module-page-component.md       RESOLVED — worked example of the shallow→deep fix
  03-insight-anomaly-silent-leak.md         RESOLVED — worked example of colocate-comment-test
  04-synthesize-recovery-duplication.md     RESOLVED — worked example of lift-to-loop
```

The four pattern files all carry the original verdict at the top so the reader sees what the smell looked like before the fix, and a RESOLVED banner naming what changed. Three of the four show a fix that landed; the fourth (01-) documents the rename and points to where the new deep-module case study (the DataSource seam) is covered in `audit.md`.

## The top three findings — original set ALL RESOLVED, current set is smaller

The 2026-06-02 top three (page.tsx three-hook extraction, `insightToAnomaly` colocation, `synthesize()` lift) have all landed. The 2026-06-15 top three are LOW or MEDIUM:

1. **Clean up `InsightCard.tsx` styling drift** (495 LOC, ~150 inline `style` objects). Pull into named `CSSProperties` constants per section.
2. **Lift `buildSynthesisInstruction(shape)` into `runAgentLoop`.** Same play as the resolved `synthesize()` lift, smaller scale.
3. **Rename `r` / `cp` in `lib/insights/derive.ts`.** Trivial.

See `audit.md → Top 3 ranked findings` for the full list and the audit's per-lens diagnoses.

## What blooming insights does well, what shows up as debt

**Honest assessment (2026-06-15).** This codebase is small (~5,000 LOC of source + ~5,000 LOC of tests + the new `eval/` and `mcp-server-olist/` packages), young, and shipped by one person under demo pressure. APOSD wasn't the explicit lens — but Phase 2 was the first refactor where the design primitives drove the moves. The DataSource seam was designed as a deep module; the domain-tool MCP server is an explicit special-purpose-vs-general-purpose call; the `synthesize()` lift is a textbook "define it out of existence." The wins are real: `BloomreachDataSource` (cache + spacing + retry behind one `callTool`); `runAgentLoop` (one function shared by four agents, now with the recovery decision absorbed); `makeDataSource` (one factory hiding four orthogonal facts); `mcp-server-olist` (three domain tools instead of a general SQL hammer); `categories.ts` (pure schema gate the route trusts without thinking). The remaining debt is concentrated in styling (one component) and one partial pull-down (`synthesisInstruction` boilerplate ×4). The biggest open trade-off — `lib/mcp/client.ts` as a 17-line shim instead of a full delete-and-rename — is honest, not lazy: keeping a working seam alive while callers migrate is cheaper than 16 test renames for no behavioral win.

---
Updated: 2026-06-16 — top-three set rewritten post-Phase-2 (original three all RESOLVED); through-line ranked list updated to reflect DataSource seam, domain-tool server, and resolved shallow page; honest-assessment paragraph rewritten for the post-Phase-2 state.
