# Study — Performance Engineering

What is measurably slow or expensive in **blooming insights**, why, and which knob would move the needle without dragging the bottleneck somewhere else.

## Reading order

```
  start here                      then the audit                pick the pattern
  ┌──────────────────┐           ┌─────────────────┐           ┌─────────────────┐
  │ 00-overview.md   │     →     │  audit.md       │     →     │  01..04         │
  │ the whole shape  │           │  8-lens sweep   │           │  pattern files  │
  │ in one diagram   │           │  every lens     │           │  per mechanism  │
  └──────────────────┘           └─────────────────┘           └─────────────────┘
```

1. **`00-overview.md`** — the perf surface in one map. Three ceilings (300s route budget, ~1 req/s MCP spacing, per-agent tool-call caps), where the wall-clock actually goes, where the live-synthetic escape hatch buys back budget.
2. **`audit.md`** — pass 1. Eight lenses walked across the repo with `file:line` evidence. Lenses that found nothing get one honest line.
3. **Pattern files** — pass 2. The mechanisms that earn their own walkthrough:

```
  01-vercel-route-budget.md       300s as a HARD ceiling
                                  → /api/agent + /api/briefing
  02-mcp-spacing-and-retry.md     proactive 1.1s spacing
                                  + server-stated retry hint
  03-ttl-cache-no-cache-on-error  60s response cache
                                  + the bug it prevents
  04-progressive-ndjson-stream.md time-to-first-event
                                  decoupled from total-runtime
```

## Cross-links

- **`study-system-design`** — overall architecture, request flow, OAuth boundary. This guide measures and bounds those flows; it does not re-teach them.
- **`study-runtime-systems`** — the execution model (event loop, AbortSignal composition, cancellation propagation). Mechanism lives there; performance consequence (how 300s gets spent or saved) lives here.
- **`study-software-design`** — module shape and seams. Performance findings that suggest a refactor cross-link there.
