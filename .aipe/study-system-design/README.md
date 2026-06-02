# 01 — system design (audit)

This guide audits blooming insights' architecture through eight lenses. Each file picks one question, traces it across the whole stack (UI · route · agent loop · provider/transport · external), and grounds every claim in a `file:line` reference. Verdict first, then ranked findings.

## The through-line

**Where do data, state, and work live; how do they move; where do the boundaries fail; and what changes at 10x?** That's system design. This guide doesn't re-teach patterns — it audits the architecture that's actually shipped.

## Files

```
01-system-design/
  01-system-map-and-boundaries.md           every component, every trust/process boundary
  02-request-response-and-data-flow.md      the three end-to-end flows + the cache-replay shortcut
  03-state-ownership-and-source-of-truth.md every piece of state + who owns it
  04-caching-and-invalidation.md            three caches; "restart" is the invalidation strategy
  05-storage-choice-and-durability-boundaries.md   no database; the deliberate choice + its cost
  06-failure-handling-and-reliability.md    rate-limit retry; graceful-degrade; reconnect-once
  07-scale-bottlenecks-and-evolution.md     what breaks first at 10x and 100x
  08-system-design-red-flags-audit.md       capstone — ranked checklist with fixes
```

## Reading order

Start with **01** for the trust/process boundary map — every later file references those boundaries. **02** then walks the actual flows that cross them. **03** holds state ownership constant across all eight layers. **04** and **05** are paired — caching and storage are the same question (where is freshness vs. durability traded off?). **06** names every failure path and what catches it. **07** asks "what breaks first at 10x?" with concrete numbers. **08** is the capstone: every finding in 01–07 lands here as a ranked, actionable row.

## Cross-links to foundation guides

This guide owns architectural shape. Mechanism-level depth lives elsewhere:

- **Runtime / execution model** (event loop, async, ALS) → `study-runtime-systems`
- **Network protocol behavior** (HTTP, NDJSON wire format, OAuth on the wire) → `study-networking`
- **Distributed-systems correctness** (across-instance state, the encrypted-cookie pattern) → `study-distributed-systems`
- **Database engine internals** (none here — no DB) → `study-database-systems` (mostly N/A for this repo)
- **Schema shape** (Insight/Anomaly/Diagnosis/Recommendation shapes) → `study-data-modeling`
- **DSA mechanism teaching** (TTL cache, NDJSON line buffering, rate-limit retry, set-membership classification) → `study-dsa-foundations` (these were the legacy `02-dsa/` files; mechanism-level depth lives there)
- **Specific patterns** (request flow walkthrough, OAuth boundary, provider abstraction, multi-agent orchestration, schema-gated coverage) → `.aipe/study-system-design-dsa/01-system-design/*` (archive; cited from these audit files for the deeper walkthrough)

## The verdict, in one paragraph

The architecture is small, intentional, and shaped by one external constraint (Bloomreach's ~1 req/s/user rate limit). Three pieces are load-bearing and do their jobs well: `runAgentLoop` (one function, four agents), `McpClient` (cache + spacing + retry), and the NDJSON streaming routes (long-running agent work becomes a visibly-working UI). One choice is deliberate and consequential: no database. That choice is right for hackathon scale and wrong the moment two users want a shared feed or anyone wants yesterday's anomalies. The two biggest architectural risks aren't bugs — they're places where the design's assumptions could quietly stop holding: the in-memory state in a serverless-instance world (one cold start drops the feed), and the unbounded coupling between the 1 req/s rate limit and the 300s route budget (one slow MCP day pushes investigations past the ceiling). Both are named in file 08 with the move.

---
Updated: 2026-06-01 — Initial generation as v1.55 audit-shaped guide.
