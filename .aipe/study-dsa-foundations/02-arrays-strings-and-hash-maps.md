# Arrays, strings, and hash maps

Industry names: indexed sequences, strings, hash sets, hash maps, dictionaries. Type: Industry standard.

## Zoom out — the heavy chapter for this repo

If Blooming Insights has a single DSA superpower, it's *"put it in a Map, then look it up."* Almost every service-layer file uses `Map` or `Set` — for cache, for session state, for tool coverage, for dedup, for schema filtering. This chapter walks the six load-bearing spots and teaches the vocabulary — hash function, collision, load factor, iteration order, prototype pollution — that separates "I used a Map" from "I picked Map for a reason."

```
  Where hash-keyed structures show up

  ┌─ UI layer ──────────────────────────────────────┐
  │  (no hash structures here — pure display)       │
  └────────────────────┬────────────────────────────┘
                       │
  ┌─ Service layer ────▼────────────────────────────┐
  │  Map<sessionId, SessionFeed>  (state/insights)  │  ← nested Maps
  │  Set<string>  (tool-coverage cross-check)       │  ← membership
  │  Set<string>  (filterToolSchemas)               │  ← allow-list
  └────────────────────┬────────────────────────────┘
                       │
  ┌─ Transport layer ──▼────────────────────────────┐
  │  Map<cacheKey, {result, expiresAt}>             │  ← the 60s cache
  │  RegExp  (parseRetryAfterMs)                    │  ← string parse
  └────────────────────┬────────────────────────────┘
                       │
  ┌─ Eval layer ───────▼────────────────────────────┐
  │  Set<string>  (runId dedup from filenames)      │  ← extract-unique
  └─────────────────────────────────────────────────┘
```

The interesting seam is the **service ↔ transport** boundary. Both sides use `Map`, but for different reasons: service Maps hold per-user session state (correctness); transport Maps hold time-bounded response cache (performance). Same primitive, different job. That's the axis worth tracing.

## Structure pass — trace *state ownership* across layers

Axis: **who owns this Map, and when does it get cleared?**

- **Service Maps** (`lib/state/insights.ts:14`): outer Map keyed by sessionId; never cleared globally; inner Maps cleared *per session* on new briefing. Ownership = *user session*.
- **Transport Map** (`lib/data-source/bloomreach-data-source.ts:122`): keyed by `${name}:${JSON.stringify(args)}`; entries expire after 60s; not cleared explicitly. Ownership = *transport instance* (per connection).
- **Set-based membership** (`filterToolSchemas`, `crossCheckToolCoverage`): built and discarded within one function call. Ownership = *stack frame*.

Seam: **between the transport Map (time-bounded) and the service Map (session-bounded).** The failure mode differs — a stale transport entry means an outdated tool result (recoverable); a bleeding service Map would leak one user's insights into another's feed (catastrophic). That's why `putInsights` at `lib/state/insights.ts:57` clears the inner Map, never the outer. Structure protects correctness.

## How it works — six primitives, six real anchors

### Move 1 — the mental model

Hash maps are the workhorse. You already reach for them without thinking. What the chapter adds is *why* JavaScript gives you two collection types and when to pick which.

```
  The kernel: a hash map lookup

  key ──► [ hash fn ] ──► bucket index
                              │
                              ▼
                         ┌──────────────┐
                         │  bucket[k]   │  ← may hold multiple entries
                         │  = value_1   │     if collision (chaining)
                         │  = value_2   │
                         └──────────────┘
                              │
                              ▼   equality check on stored keys
                          value

  what makes it O(1): hash spreads keys evenly across buckets,
                       so bucket sizes stay tiny (load factor ~ 1)
  what breaks it     : bad hash (all → same bucket) → linear scan
```

Two things can go wrong: the hash function collides all keys (unlikely with V8's implementation), or you use *the wrong container* (plain `{}` for user-controlled keys — see the `__proto__` trap below).

### Move 2 — the six load-bearing spots

**Map for session state (`Map<string, SessionFeed>`)** — `lib/state/insights.ts:14-19`.

Every warm Vercel instance can serve multiple users concurrently. Session state lives in module-level Maps keyed by sessionId, and the *inner* maps get cleared on new briefings — the *outer* map never does.

```ts
// lib/state/insights.ts:14
const state = new Map<string, SessionFeed>();

// lib/state/insights.ts:57-70
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  const s = sessionState(sessionId);
  s.insights.clear();     // clear ONLY this session
  s.anomalies.clear();
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

Load-bearing part — **`s.insights.clear()` clears the inner map, never `state.clear()`**. Drop that discipline and one user's new briefing wipes every other user's feed on the same warm instance.

Why `Map` not `{}`? Three reasons that matter here:
- **Prototype safety.** A user-controlled sessionId of `__proto__` on a plain object would let a caller write to `Object.prototype`. Not exploitable through this codebase, but the safe default is `Map`.
- **Iteration order.** `Map` iterates in insertion order, guaranteed. Plain objects mix insertion order and numeric-key sort order.
- **`.size` is O(1).** On a plain object you'd need `Object.keys(o).length` — O(n).

**Map for a time-bounded cache** — `lib/data-source/bloomreach-data-source.ts:122, 144-152`.

Every Bloomreach tool result gets cached for 60 seconds by `(name, args)`:

```ts
// lib/data-source/bloomreach-data-source.ts:122
private cache = new Map<string, { result: unknown; expiresAt: number }>();

// lib/data-source/bloomreach-data-source.ts:144-152
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

Load-bearing part — **`JSON.stringify(args)` in the cache key**. Object identity would give false negatives (`{a:1,b:2}` and `{a:1,b:2}` are different objects); JSON is the poor-man's structural equality. It's fragile — key order matters, so `{a:1,b:2}` and `{b:2,a:1}` cache separately, and functions/undefined don't serialize. Fine for this call site (args are simple JSON) but a landmine at scale.

Not shown here but worth knowing: nothing evicts entries when they expire; the Map grows monotonically until the serverless instance dies. On a single warm instance running a full day, this is a **memory leak** — small (60s TTL means each unique key lives briefly) but real. See `.aipe/study-performance-engineering/` for the fix (LRU with size cap).

**Set for allow-list filtering** — `lib/agents/tool-schemas.ts:13-15`.

```ts
// lib/agents/tool-schemas.ts:13-15
const set = new Set(allowed);
return all
  .filter((t) => set.has(t.name))
  .map((t) => ({ name: t.name, description: t.description ?? '',
                  input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'] }));
```

Kernel: `new Set(allowed)` promotes an array to O(1) membership test, then `.filter` scans the tools with O(1) probes. Drop the Set and it degrades to `allowed.includes(t.name)` inside the filter — O(n·m) instead of O(n+m). Same picture as `01-complexity-and-cost-models.md`'s Move 2, told from the Set side.

**Set for tool-name coverage** — `lib/mcp/tool-coverage.ts:39-41, 50-55`.

```ts
// lib/mcp/tool-coverage.ts:39-41
export function crossCheckToolCoverage(serverToolNames: string[]): ToolCoverageReport {
  const server = new Set(serverToolNames);
  const absent = (list: readonly string[]) => list.filter((n) => !server.has(n));

  const missing = { monitoring: absent(monitoringTools), diagnostic: absent(diagnosticTools),
                    recommendation: absent(recommendationTools), bootstrap: absent(bootstrapTools) };

  const configured = new Set<string>([...monitoringTools, ...diagnosticTools,
                                       ...recommendationTools, ...bootstrapTools]);
  // ...
}
```

Two Sets doing complementary work: `server` for "does the MCP server have this tool?" and `configured` for "does *any* agent list reference this server tool?" The two Sets meet at `unusedOnServer: serverToolNames.filter(n => !configured.has(n))`. Symmetric-difference-shaped, without needing to compute an actual symmetric difference.

**Set for dedup** — `eval/report.eval.ts:204-207`.

```ts
// eval/report.eval.ts:203-210
const files = readdirSync(RECEIPTS_DIR).filter((f) => f.endsWith('.json'));
const runIds = new Set<string>();
for (const f of files) {
  const m = f.match(/-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z)\.json$/);
  if (m) runIds.add(m[1]);
}
if (runIds.size === 0) throw new Error('No receipts found');
return [...runIds].sort().pop() as string;
```

The classic *extract-unique-from-corpus* pattern. Regex pulls a timestamp out of each filename, Set eats duplicates, `.sort().pop()` picks the newest. This is the exact shape you'd write for "find the unique users who did X" — swap filenames for events and it transfers unchanged.

**Regex over strings** — `lib/data-source/bloomreach-data-source.ts:64-71`.

```ts
// lib/data-source/bloomreach-data-source.ts:64-71
function parseRetryAfterMs(result: unknown): number | null {
  const text = JSON.stringify((result as any)?.content ?? result);
  const after = text.match(/retry[\s-]*after[^0-9]*(\d+)\s*second/i);
  if (after) return parseInt(after[1], 10) * 1000;
  const perWindow = text.match(/per\s*(\d+)\s*second/i);
  if (perWindow) return parseInt(perWindow[1], 10) * 1000;
  return null;
}
```

Two regexes with capture groups. This is the repo's clearest string-algorithm anchor — matching a pattern (`retry-after ~N second`) and extracting a numeric parameter. The interview transfer is *"parse an unstructured error string to a structured value"* — a standard shape.

Load-bearing part — **the `i` flag and the loose character-class `[^0-9]*`**. The upstream text is human-written and inconsistent; strict matching would break on the second variant.

### Move 3 — the principle

*Membership tests and keyed lookups are the primitives you'll reach for hundreds of times a year.* Getting the container right (Map vs `{}`, Set vs array) is a code-shape decision that costs nothing at write time and saves you correctness bugs (prototype pollution, false-negative dedup) and O(n·m) surprises at read time. The muscle memory: **user-controlled keys → Map**, **membership test → Set**, **cache with expiry → Map + timestamp value**.

## Primary diagram — the six anchors mapped

```
  Six hash-keyed structures across the layers

  ┌─ Service layer ─────────────────────────────────────────┐
  │                                                          │
  │  state ── Map<sessionId, {                              │
  │              insights:      Map<id, Insight>            │
  │              investigations Map<id, Investigation>      │
  │              anomalies:     Map<id, Anomaly>            │
  │            }>                                            │
  │                          ↑ session-owned, per-user clear │
  │                                                          │
  │  filterToolSchemas ── new Set(allowed) ── O(1) probe    │
  │  crossCheckCoverage ── new Set(serverTools)             │
  │                                                          │
  └──────────────────────────┬──────────────────────────────┘
                             │
  ┌─ Transport layer ────────▼──────────────────────────────┐
  │                                                          │
  │  cache ── Map<`${name}:${json}`, {result, expiresAt}>   │
  │                          ↑ time-owned, 60s TTL          │
  │                                                          │
  │  parseRetryAfterMs ── regex over error envelope         │
  │                                                          │
  └──────────────────────────┬──────────────────────────────┘
                             │
  ┌─ Eval layer ─────────────▼──────────────────────────────┐
  │                                                          │
  │  pickRunId ── new Set<string>() ── dedup filenames      │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

Hash tables were invented independently in ~1953 by Hans Peter Luhn at IBM. The load-factor / collision / chaining terminology comes from the compiler-writing tradition (symbol tables). Modern JavaScript's `Map` uses V8's internal hidden-class + SipHash implementation — it's *not* a linear-probing open-addressed table like Python's dict; the details matter if you ever hit degenerate cases.

**Prototype pollution** — the reason `Map` exists — is real: CVE-2018-3721 (lodash.merge), CVE-2019-10744 (lodash.defaultsDeep). The lesson isn't "always use Map"; it's *"know which container's contract you need"*.

For strings, learn one thing beyond regex: **Rabin-Karp fingerprinting** (rolling hashes) and **suffix arrays**. Neither appears in this repo, but they show up in interview questions constantly and both build on the hash-map intuition — a hash reduces a variable-length key to a fixed-length probe.

## Interview defense

**Q: Why `Map` instead of a plain object in `lib/state/insights.ts`?**

Answer: Three reasons. First, prototype safety — the sessionId is user-derived, and a plain object with key `__proto__` would let a caller mutate the prototype chain. Second, iteration order is guaranteed insertion-order for `Map`, whereas plain objects mix insertion and numeric-key sort order. Third, `.size` is O(1) instead of `Object.keys(o).length`'s O(n). None of them are performance sensitive here, but the safe default in TypeScript is `Map` for anything user-keyed.

```
  Why Map over {} for user-keyed state

  Map:        set(k, v) O(1)  ·  clear() O(1)  ·  size O(1)  ·  no __proto__ trap
  {}:         o[k] = v  O(1)  ·  keys().length O(n)  ·  __proto__ hazard
```

Anchor: `lib/state/insights.ts:14`.

**Q: The cache Map at `lib/data-source/bloomreach-data-source.ts:122` — what breaks first at scale?**

Answer: Memory. Nothing evicts entries when they expire, so the Map grows monotonically until the serverless instance dies. It's a slow leak — 60s TTLs mean each unique key contributes briefly — but at high uniqueness (random query params in cache key), memory grows unbounded. The fix is an LRU cap: cap size at N entries and evict on insert. That trades a bit of complexity for a hard memory ceiling.

```
  cache growth: current vs bounded

  current:   entries = ∫ writes(t) dt  →  grows forever, TTL is display-only
  bounded:   entries ≤ N, evict LRU on insert  →  hard ceiling
```

Anchor: `lib/data-source/bloomreach-data-source.ts:122,144-152`.

**Q: Talk through `filterToolSchemas` — what does the Set save you?**

Answer: The pattern is "given a list of items and a whitelist of allowed names, return the whitelisted items with their schemas mapped." Without the Set, you'd do `allowed.includes(t.name)` inside the filter — O(m) per tool, so O(n·m) total. Pre-computing the Set makes membership O(1), so total cost drops to O(n + m). At this repo's scale (40 tools, 8 allowed) the difference is invisible; the shape is what protects you at any future scale.

```
  Set-then-scan cost

  allowed.includes  :  O(m) × n tools  =  O(n·m)
  new Set(allowed)  :  O(m) once
  set.has  × n      :  O(1) × n        =  O(n)   ← total O(n + m)
```

Anchor: `lib/agents/tool-schemas.ts:13-15`.

## See also

- `01-complexity-and-cost-models.md` — the O(1)/O(n)/O(n·m) vocabulary this chapter cites.
- `03-stacks-queues-deques-and-heaps.md` — the load harness's index-queue is another use of arrays as ordered containers.
- `06-sorting-searching-and-selection.md` — `.sort().pop()` in `pickRunId`.
- `.aipe/study-security/` — for the prototype-pollution class of bug in more depth.
