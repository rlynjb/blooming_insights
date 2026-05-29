# 02 — data structures & algorithms

The concrete operations this codebase performs, one file per operation. Each file includes a step-by-step execution trace (every variable at every step), not just before/after.

## Operations

- **[01-ttl-cache.md](01-ttl-cache.md)** — cache-aside with time-to-live: a `Map` keyed on `name:JSON.stringify(args)`, an `expiresAt` check, and write-on-success-only (never cache an error).
- **[02-rate-limit-and-retry.md](02-rate-limit-and-retry.md)** — fixed-interval inter-call spacing (`liveCall`'s `elapsed < minIntervalMs` wait) plus a bounded retry loop on rate-limit results.
- **[03-ndjson-line-buffering.md](03-ndjson-line-buffering.md)** — reassembling complete JSON records from arbitrary network chunks: `split('\n')` + keep the trailing partial line; plus reverse-scan reconciliation of `tool_call_start`/`tool_call_end`.
- **[04-json-from-prose.md](04-json-from-prose.md)** — lenient extraction of JSON from LLM prose (fenced block → bare parse → substring scan) followed by structural type-guard validation.
- **[05-severity-sort.md](05-severity-sort.md)** — a rank-table comparator sort (`SEV_RANK[b] - SEV_RANK[a]`) + top-N truncation, and a `new Set([...a,...b,...c])` union that dedups overlapping tool subsets.
- **[06-enrichment-derivation.md](06-enrichment-derivation.md)** — deriving business-owner display fields from held evidence: a find-first numeric-pair scan, the funnel leak via `reduce` min-by-key (`argmin`), confidence bucketing from hypotheses-tested counts, and `typeof` normalization of a string-or-object impact union.
- **[07-coverage-gate.md](07-coverage-gate.md)** — capability gating by set membership: flatten the schema into a `Set` of capability tokens once, then classify each of the 10 registry categories by testing `requires`/`enriches` against it (`every` short-circuit) — full / limited / unavailable.

## Complexity cheat sheet

`n` is the input size for that operation (cache entries, stream bytes, text length, list length). These run at tiny `n` in practice — the table is the shape, not a bottleneck.

| Operation | File | Time | Space |
|---|---|---|---|
| TTL cache get / set | 01 | O(1) average (hash map) | O(distinct `name+args` keys) — **unbounded, no eviction** |
| Inter-call spacing | 02 | O(1) per call (+ up to `minIntervalMs` wait) | O(1) (`lastCallAt`) |
| Bounded rate-limit retry | 02 | O(maxRetries) worst case (+ `retryDelayMs` waits) | O(1) |
| NDJSON line-buffering | 03 | O(n) over stream bytes | O(longest unterminated line) |
| tool-call reconciliation | 03 | O(k) per `tool_call_end` (reverse scan of k trace items) | O(1) |
| JSON-from-prose extract | 04 | O(n) over text length (regex + index scan) | O(n) (the sliced candidate) |
| Anomaly rank sort | 05 | O(n log n) (`Array.sort`) | O(n) |
| Set-union dedup | 05 | O(m) over total tool names | O(u) unique tools |
| Find-first numeric pair | 06 | O(n) over evidence entries (stops on first match) | O(1) |
| Funnel leak (argmin reduce) | 06 | O(n) over funnel stages (n = 4) | O(1) |
| Confidence bucketing | 06 | O(n) over hypotheses (filter/length counts) | O(1) |
| Impact union normalize | 06 | O(1) (`typeof` branch) | O(1) |
| Schema → capability set | 07 | O(events + properties + catalogs) | O(capability tokens) |
| Coverage classify (per category) | 07 | O(deps) `has()` + short-circuit `every` | O(1) |
| Coverage report (10 categories) | 07 | O(schema) + O(Σ deps), tiny | O(10) report |

## Flagged: an O(n) win left on the table

- **TTL cache has no eviction** (`01-ttl-cache.md`). The `Map` grows with every distinct `(name, args)` pair and is never bounded. At session scale this is harmless (a handful of distinct calls), but it is O(distinct-keys) memory with no cap — an LRU bound is the obvious fix the moment distinct keys grow large or the process is long-lived. This is called out plainly in the file's Tradeoffs.

No operation here is accidentally O(n²) where O(n) is easy — the sort is the only super-linear step, and `O(n log n)` on ≤10 items is irrelevant.

---
Updated: 2026-05-28 — added `06-enrichment-derivation.md` (find-first scan, funnel-leak argmin reduce, confidence bucketing, impact union normalize) to the operations list and the complexity cheat-sheet (all O(n) over tiny n / O(1))
Updated: 2026-05-29 — added `07-coverage-gate.md` (flatten schema → capability `Set`; per-category `requires`/`enriches` membership test → full/limited/unavailable) to the operations list and the complexity cheat-sheet
