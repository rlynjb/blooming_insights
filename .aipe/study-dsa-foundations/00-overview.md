# DSA Foundations — overview

The reusable data-structures-and-algorithms vocabulary behind this codebase, plus the foundations the codebase doesn't yet exercise. Each chapter teaches one category, anchors to repo examples where they exist, and names the gap honestly where they don't.

---

## The verdict

This codebase is a **flat-array, hash-map, linear-scan** codebase. That's not a complaint — it's the right shape for what it does. Everything load-bearing is a `Map`, a `Set`, an `Array.prototype.sort` with a comparator, or a `for`/`reduce` over a single-digit-length array. There are no trees, no graphs, no priority queues, no dynamic-programming tables, no binary search. The closest thing to a "tree" is `lib/mcp/schema.ts`'s nested object literal, and the closest thing to a "graph" is the implicit traversal `bootstrapSchema` does over MCP tools, and even those are not algorithms — they're just loops over JSON.

That's important to say up front because it means **half of this guide teaches foundations the repo doesn't currently use.** The other half is anchored hard to real files. Both halves are deliberate. The job is to teach what the repo *does* exercise so you can defend it, *and* to name what it doesn't so you know where to practice next.

```
This codebase, ranked by what it actually exercises
─────────────────────────────────────────────────────────────────────
EXERCISED                                  NOT YET EXERCISED
─────────────────────────                  ─────────────────────────
hash maps (Map, Set)        ★★★★★          trees / tries           ☆
strings + buffers           ★★★★           graphs (BFS / DFS)      ☆
arrays + linear scans       ★★★★★          priority queues / heaps ☆
comparator-based sort       ★★★            dynamic programming     ☆
find-first / argmin reduce  ★★★            binary search           ☆
amortized cost reasoning    ★★             backtracking            ☆
recursion (one-level)       ★              union-find / segment    ☆
```

The five-star primitives below are what every chapter anchors to. The starred-zero primitives are what `08-dsa-foundations-practice-map.md` ranks for deliberate practice.

**Phase 3 eval addition (2026-06-15).** The `eval/scripts/lib/scorer.ts` (361 LOC) introduces real **set-intersection patterns** as worked examples: loose-set matching (2-of-3 dimension overlap) vs strict matching (3-of-3) compare a predicted anomaly's `{metric, scope, direction}` against the seeded ground truth. Same hash-set primitives the codebase already uses, applied to detection precision/recall scoring. A `structural-diff.ts` recursive JSON diff was also shipped for regression-eval scoring (tree-traversal-flavored, lightweight). Neither is in the production hot path — they live under `eval/` and run via `npm run eval:*`. The codebase's overall DSA shape is unchanged.

---

## The system in one diagram

Before any chapter, the whole system in one frame, with the DSA load-bearers marked.

```
┌─ UI band ────────────────────────────────────────────────────────┐
│  app/page.tsx · components/feed/InsightCard.tsx                  │
│                                                                   │
│  ★ NDJSON reader loop (string buffer + split + pop)               │
│  ★ argmin reduce over funnel stages                               │
│  ★ severity badge rendering (reads SEV_RANK output)               │
└────────────────────────────┬─────────────────────────────────────┘
                             │  HTTP NDJSON stream
┌─ Route layer ──────────────▼─────────────────────────────────────┐
│  app/api/agent/route.ts · app/api/briefing/route.ts              │
│  send(e) = enqueue(JSON.stringify(e) + '\n')                     │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌─ Agent layer ──────────────▼─────────────────────────────────────┐
│  lib/agents/{monitoring,diagnostic,recommendation,query}.ts      │
│                                                                   │
│  ★ comparator sort + slice(0,10)  (SEV_RANK rank table)           │
│  ★ Set-union dedup of tool name arrays                            │
│  ★ derive.ts: linear scans, argmin reduce, threshold buckets      │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌─ Coverage gate (pure DSA) ─▼─────────────────────────────────────┐
│  lib/agents/categories.ts                                         │
│                                                                   │
│  ★ schema → flat Set<string> of capability tokens                 │
│  ★ requires.every(has) → enriches.every(has) → full/limited/un.  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌─ MCP provider wrapper ─────▼─────────────────────────────────────┐
│  lib/mcp/client.ts                                                │
│                                                                   │
│  ★ TTL cache (Map<key, {result, expiresAt}>)                      │
│  ★ rate-limit spacing gate + bounded retry (amortized cost)       │
│  ★ JSON extraction ladder + isAnomalyArray type guard             │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌─ Bootstrap (implicit walk) ▼─────────────────────────────────────┐
│  lib/mcp/schema.ts                                                │
│  list_orgs → list_projects → 4 schema tools                      │
│  (this is the closest thing to a "graph traversal" in the repo,  │
│   but it's a fixed 6-call sequence, not an algorithm)            │
└──────────────────────────────────────────────────────────────────┘
```

Every "★" in this diagram has a chapter in this guide. The chapters in order:

```
01 complexity-and-cost-models             time/space/amortized; what to measure
02 arrays-strings-and-hash-maps           the five-star primitives — most-used
03 stacks-queues-deques-and-heaps         queues (implicit), heaps (not yet)
04 trees-tries-and-balanced-indexes       not yet — schema-as-nested-object is the closest
05 graphs-and-traversals                  not yet — bootstrap is a fixed sequence
06 sorting-searching-and-selection        comparator sort + linear scan; no binary search
07 recursion-backtracking-and-dynamic-p.  not yet — flat code, no overlapping subproblems
08 dsa-foundations-practice-map           ranked plan: applies first, then gaps
```

---

## Per-category verdict

A one-line verdict for each chapter, so you know what to expect before you read it.

```
chapter                                       verdict
─────────────────────────────────────────────────────────────────────────────
01 complexity-and-cost-models                  applies — informally, but real
02 arrays-strings-and-hash-maps                applies, exercised everywhere
03 stacks-queues-deques-and-heaps              partial — queues implicit, heaps NOT YET
04 trees-tries-and-balanced-indexes            NOT YET EXERCISED
05 graphs-and-traversals                       NOT YET EXERCISED
06 sorting-searching-and-selection             partial — comparator sort YES, binary search NOT YET
07 recursion-backtracking-and-dynamic-prog.    NOT YET EXERCISED
```

**Three categories are fully exercised** (01, 02, 06-partial). **Four are not** (03-heaps, 04, 05, 07). That ratio is the through-line: this is a flat, sequential, single-process Node app over an HTTP+SSE-ish transport. The data structures that show up are the ones a flat sequential program needs. The structures that don't show up are the ones you need when you're either (a) coordinating many things at once, (b) traversing a relational structure, or (c) sub-dividing a search space.

---

## How to read this guide

**Anchored chapters first (01, 02, 06).** Open the file, find the load-bearing repo example, walk it with the chapter. You already understand the example — the chapter gives you the vocabulary to defend it.

**"Not yet exercised" chapters second (03, 04, 05, 07).** Read these for the vocabulary, the kernel, and the "when does this become relevant?" payoff at the end. The repo doesn't anchor them yet, so the chapter teaches the foundation and names the trigger — what change in the system would make you reach for this primitive for the first time.

**Practice map last (08).** Ranks the gaps from the previous seven by *how likely you are to need them next*. Heaps and binary search rank higher than tries because they show up in interview problems you're more likely to encounter.

---

## Cross-references

These guides already cover adjacent territory; this guide intentionally doesn't re-teach them:

```
this guide                          adjacent (don't duplicate)
──────────────────────────────────  ─────────────────────────────────────────
01 complexity-and-cost-models   →   .aipe/study-software-design/audit.md#complexity-in-this-codebase
                                    (different lens: design complexity vs algo cost)
02 arrays-strings-and-hash-maps →   .aipe/study-dsa-foundations/02-arrays-strings-and-hash-maps.md
                                    (the Map-backed cache as a full case study)
03 stacks-queues-deques-and-h.  →   .aipe/study-dsa-foundations/02-arrays-strings-and-hash-maps.md
                                    (the buf string IS a one-slot queue)
06 sorting-searching-and-sel.   →   .aipe/study-dsa-foundations/06-sorting-searching-and-selection.md
                                    (rank-mapped sort as a full case study)
                                →   .aipe/study-dsa-foundations/06-sorting-searching-and-selection.md
                                    (substring scan as a search/parse strategy)
```

The legacy `study-dsa-foundations/` files are the deep dives into the seven mechanisms the codebase actually ships. This guide zooms out to the *category* each one belongs to and teaches the category. When this guide's chapter says "see also: 05-severity-sort," that's where the full case study lives.

---

## What you'll have at the end

A working vocabulary for every standard interview DSA category, anchored to a real file when the repo exercises it and named honestly when it doesn't. The practice map (08) tells you what to build next so the not-yet-exercised list shrinks.
