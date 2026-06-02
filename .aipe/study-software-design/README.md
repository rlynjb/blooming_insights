# blooming insights — software design audit (APOSD applied)

> Ousterhout's *A Philosophy of Software Design* (2nd ed.) is the source of every primitive named in this guide — deep modules, information hiding, complexity, layering, readability, pull-complexity-downward, errors-as-special-cases. Read the book for the framework; this guide is the audit. The companion `read-aposd/` guide (when present) teaches the primitives in their own right.

This guide applies APOSD to **this repo**. Every claim cites a real file path and, where it sharpens the point, a line range. Every finding opens with a verdict, names the one move that matters most, then ranks the rest. Where blooming insights honors the primitive, that's praise — and it's a finding. Where it violates it, that's debt — and it's named plainly, with the move.

## The through-line

**Complexity is the enemy. Deep modules are the weapon.** A deep module hides a lot of behavior behind a small interface — the caller learns a thin contract, the body absorbs the mess. Most of what's healthy in this codebase is two or three modules that do exactly that (`McpClient`, `runAgentLoop`, `coverageFor`). Most of what's debt is one place where the opposite happened — a 817-line client component that owns rendering and stream-parsing and reconnect-policy and demo-capture and mode-toggling all at once.

```
The audit, ranked

  ┌─ what's deep and earns its place ──────────┐
  │ McpClient            (172 LOC, 3 methods)  │
  │ runAgentLoop         (one function, 4 callers)│
  │ coverageFor + categories (pure schema gate)│
  └────────────────────────────────────────────┘
                       │
                       │  contrast with…
                       ▼
  ┌─ where complexity leaks upward ────────────┐
  │ app/page.tsx        (817 LOC, one file)    │  ← biggest debt
  │ useInvestigation    (NDJSON parsing in a hook)│
  │ insightToAnomaly    (the same mapping, 3 places)│
  └────────────────────────────────────────────┘
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
  audit.md                                  PASS 1 — the 8-lens audit, ranked
  01-mcp-client-deep-module.md              the canonical deep module (172 LOC, 3 methods)
  02-shallow-module-page-component.md       the canonical shallow module (817 LOC, 8 concerns)
  03-insight-anomaly-silent-leak.md         the worst information leak (3 files, silent drop)
  04-synthesize-recovery-duplication.md     the duplicated special case (~90 LOC to delete)
```

## The top three fixes, ranked

The audit (`audit.md → Top 3 ranked findings`) carries the full list; these are the calls.

1. **Split `app/page.tsx` (817 LOC).** It's the worst shallow-module-in-a-file in the repo: rendering, NDJSON streaming, reconnect policy, demo capture, mode toggling, and feed status all live in one client component. Lift each into its own hook (`useBriefingStream`, `useReconnectPolicy`, `useDemoCapture`) and shrink the file to layout + composition. This single move retires the biggest cognitive-load hotspot. See `02-shallow-module-page-component.md`.

2. **Promote `insightToAnomaly` to a single source.** The same mapping ships in `app/api/agent/route.ts:29-31`, and the inverse `anomalyToInsight` lives in `lib/state/insights.ts:8-28`. Each one is small, but they encode the same knowledge of "what fields cross between an Anomaly and an Insight" — change one and the other drifts. Move them next to each other in `lib/state/insights.ts` and import. See `03-insight-anomaly-silent-leak.md`.

3. **Define out the "agent won't emit JSON" special case.** `diagnostic.ts` and `recommendation.ts` both ship a `synthesize` method that re-runs the model tool-less to force a structured answer (`lib/agents/diagnostic.ts:86-126` / `lib/agents/recommendation.ts:82-132`). Two copies of the same recovery path is the smell; the fix is to lift it into `runAgentLoop` as a `parseResult` + `recoveryPrompt` pair and delete both. See `04-synthesize-recovery-duplication.md`.

## What blooming insights does well, what shows up as debt

**Honest assessment:** This codebase is small (~5,000 LOC of source + ~2,900 LOC of tests), young, and shipped by one person under demo pressure. APOSD wasn't the explicit lens — but several modules accidentally landed deep because the constraints forced it (the 60s Vercel budget, the 1 req/s MCP limit, the offline test discipline). The wins are real and worth naming: `McpClient` is a textbook deep module (cache + spacing + retry behind one `callTool` method); `runAgentLoop` is one function shared by four agents with no duplication; `categories.ts` is a pure schema gate that the route trusts without thinking. The debt is concentrated in two places — the 817-line page component, and the two copies of `insightToAnomaly` / `synthesize` that should be one. Neither is a fundamental design mistake; both are the kind of cleanup that takes an afternoon and removes the biggest reasons the next contributor would get lost.
