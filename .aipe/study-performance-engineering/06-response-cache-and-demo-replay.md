# response cache and demo replay

**Industry name(s):** memoization cache · TTL cache · fixture replay · content-addressable cache key. **Type label:** Language-agnostic.

## Zoom out — where the two caches sit

Two layers of caching. The 60s response cache is a per-instance memoization inside the Bloomreach adapter. The demo replay is a static snapshot served from disk. Both cut latency and cost to ~zero for the same-question-again case, but they live in very different bands.

```
Zoom out — two caches, two bands

┌─ UI band ──────────────────────────────────────────────┐
│  ?demo=cached  →  hits /api/briefing → snapshot         │
└──────────────────────┬─────────────────────────────────┘
                       │  NDJSON with 140/180ms delay
┌─ Route band ─────────▼─────────────────────────────────┐
│  ★ DEMO REPLAY ★                                       │
│  app/api/briefing/route.ts:86                          │
│  app/api/agent/route.ts:125                            │
│  reads lib/state/demo-*.json                           │
└──────────────────────┬─────────────────────────────────┘
                       │  live path only if not demo
┌─ Data-source band ───▼─────────────────────────────────┐
│  ★ 60s RESPONSE CACHE ★                                 │
│  BloomreachDataSource                                   │
│  keyed on `${name}:${JSON.stringify(args)}`             │
└──────────────────────┬─────────────────────────────────┘
                       │  cache miss only
┌─ Provider band ──────▼─────────────────────────────────┐
│  Bloomreach MCP server                                  │
└─────────────────────────────────────────────────────────┘
```

**Zoom in — what each is.** The **response cache** is a memoization layer on the tool-call surface. Same tool name + same args within 60 seconds → serve the previous result. The **demo replay** is a completely different mechanism: pre-committed JSON snapshots that get streamed as NDJSON with a fake delay to look like a live investigation. One is a runtime optimization; the other is a presentation-reliability lever.

## Structure pass — layers · one axis · one seam

The axis worth tracing is **what generated this result**.

```
one axis held: "who generated this bytes I'm reading?"

┌─ demo replay (route level) ────────────────────┐
│  lib/state/demo-*.json                          │  → generator: A PAST LIVE RUN
│  captured, committed, replayed with fake delay  │  → time: capture-time
└───────────────────────┬─────────────────────────┘
                        │  seam: the ?demo=cached URL
┌─ live path (route → adapter) ▼─────────────────┐
│  BloomreachDataSource.cache                     │  → generator: THIS INVESTIGATION'S own earlier call
│  60s TTL, in-memory                             │  → time: seconds ago
└───────────────────────┬─────────────────────────┘
                        │  seam: cache.get(cacheKey)
┌─ Bloomreach server ───▼────────────────────────┐
│  fresh EQL execution                            │  → generator: THE REAL SERVER
│                                                 │  → time: now
└─────────────────────────────────────────────────┘
```

**The two seams.** Different by intent: the demo seam decides whether to run the model *at all*; the response-cache seam decides whether to fire a tool call. Losing the demo seam means every user runs the live path (fine, until the alpha server hiccups). Losing the response cache means every duplicate EQL query re-fires against Bloomreach (fine, until you 429).

## How it works

### Move 1 — the mental model

You've built memoization before — cache the result of `sum(a, b)` keyed on `${a}:${b}`. This is that pattern with a TTL, applied to network calls instead of pure functions. The demo replay is a different animal: a `.har`-file-shaped snapshot that the route serves as if it were live, with a `setTimeout` between events so the reveal feels natural.

```
The pattern — two caches, one contract

RESPONSE CACHE                       DEMO REPLAY
memoization + TTL                    static snapshot + fake pace
    │                                    │
    ▼                                    ▼
cache.get(cacheKey)                  readFileSync(DEMO_FILE)
    │                                    │
    ▼                                    ▼
in TTL? return          {result,     for each event in trace:
   fromCache: true, durationMs: 0}     controller.enqueue(...)
                                        await 180ms
    │                                    │
    ▼                                    ▼
miss? fire the tool call             ends when trace ends
cache.set(cacheKey, ...)             ★ never touches the model ★
```

### Move 2 — the step-by-step walkthrough

#### Step 1 — the response cache key is deterministic

`lib/data-source/bloomreach-data-source.ts:144`:

```typescript
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

Content-addressable — the same `execute_analytics_eql` call with the same args always produces the same cache key. The `fromCache: true` flag lets callers distinguish; `durationMs: 0` is honest — the fetch cost nothing this time.

**What breaks if args aren't stably serialized:** `{a:1,b:2}` and `{b:2,a:1}` are semantically equal but produce different cache keys (`JSON.stringify` doesn't sort keys). In this repo the agent always constructs args from the same code path per tool, so keys stay stable. If tool args ever came from user input directly, key normalization would matter.

#### Step 2 — cache writes are gated on success

`lib/data-source/bloomreach-data-source.ts:179`:

```typescript
// Don't cache error results — they should not poison the cache.
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}

const now = Date.now();
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
return { result: result as T, durationMs, fromCache: false };
```

Error results skip the write. This is the load-bearing invariant — if you cached errors, a transient 500 would poison every future call with the same args for 60 seconds. Named in the code comment on line 178.

**What breaks if you cache errors:** the ReAct loop tries the same query, gets the cached error, reasons around it, tries something different, calls the first query *again* — hits the cache, gets the same error. The model has no way to know the underlying condition has cleared. Silent trap.

#### Step 3 — cache is per-instance, per-request

`BloomreachDataSource` is instantiated inside `makeDataSource` per request (indirectly, via the factory at `lib/data-source/index.ts`). So the cache is scoped to one investigation, not global.

**What breaks with a global cache:** every user sees every other user's tool results. Privacy leak, plus stale data across sessions. Per-request scoping is the right shape — the cache absorbs *this* investigation's own repeats (the ReAct loop re-firing an EQL query when the model retries), not cross-user repeats.

**Design note.** If cross-user caching ever became worth it — say, a background job that computes daily aggregates — that would be a different cache layer altogether (redis, or the demo snapshot itself). Not something to bolt onto this one.

```
Layers-and-hops — cache write path

┌─ Agent turn ─────────────┐  hop 1: dataSource.callTool
│  execute_analytics_eql   │ ──────────────────────────────┐
└──────────────────────────┘                               │
                                                            ▼
                                        ┌─ cache.get(key) ──────┐
                                        │  HIT within TTL?       │
                                        │  → return, durationMs:0│
                                        └──────┬─────────────────┘
                                               │  miss
                                               ▼
                                        ┌─ liveCall (rate gates)│
                                        │  proactive + reactive │
                                        └──────┬─────────────────┘
                                               │  result
                                               ▼
                                        ┌─ isError? ────────────┐
                                        │  YES → return, NO cache│
                                        │  NO  → cache.set(...)  │
                                        └──────┬─────────────────┘
                                               │
                                               ▼
                                        ┌─ back to agent ───────┐
                                        │  { result, durationMs, │
                                        │    fromCache: false }  │
                                        └────────────────────────┘
```

#### Step 4 — the demo replay is a totally separate machine

`app/api/briefing/route.ts:86`:

```typescript
if (demo && existsSync(DEMO_FILE)) {
  let snapshot: DemoSnapshot | null = null;
  try {
    snapshot = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as DemoSnapshot;
  } catch {
    snapshot = null;
  }
  if (snapshot) {
    // ... stream the snapshot as NDJSON with REPLAY_DELAY_MS between events
  }
}
```

`?demo=cached` triggers the branch. `lib/state/demo-insights.json` is committed to the repo (comment: "the reliable presentation path"). The route reads the file, iterates its `trace` array, and enqueues NDJSON events with a 140ms delay per event (briefing) or 180ms (agent).

**Why the fake delay:** without it, all events fire at once and the UI has nothing to reveal. The delay makes the demo *look* like an investigation. It's presentation, not performance — the model isn't running.

**What breaks if the snapshot is malformed:** the JSON.parse catches, `snapshot = null`, and the branch falls through to the live path. In practice this is a rare failure mode because the snapshot is committed as regenerated JSON, not hand-edited.

#### Step 5 — capture-time is where the snapshot is made real

The "dev-only one-click capture" mentioned in the project context (`app/page.tsx`) runs a live briefing + each investigation and writes `lib/state/demo-*.json`. So the demo snapshot IS a past real run — just frozen in time. That's why the demo can survive an alpha-server outage: the answers are already on disk.

```
Layers-and-hops — capture and replay

┌─ CAPTURE (dev-time, one-click) ──────────────────────────┐
│  live briefing runs                                       │
│  every event → collected[]                                │
│  fs.writeFileSync(DEMO_FILE, JSON.stringify(collected))   │
└──────────────────────────┬───────────────────────────────┘
                           │  commit to git
                           ▼
                    lib/state/demo-*.json
                           │
                           │  request time
                           ▼
┌─ REPLAY (production, ?demo=cached) ──────────────────────┐
│  JSON.parse the file                                      │
│  for each event: enqueue NDJSON, sleep 140-180ms          │
│  never touches Anthropic or Bloomreach                    │
│  wall clock: (num events × 140ms) not (real 100-115s)     │
└───────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

The response cache and the demo replay are the same *idea* — serve the past instead of computing the present — applied at two very different scales. The response cache is small and fast (seconds ago, in-memory). The demo replay is big and durable (last dev capture, on disk). Both trade freshness for latency + reliability. Knowing WHICH one to reach for is the design skill; the primitives themselves are trivial.

## Primary diagram — the recap

```
The two-cache pattern — end to end

┌─ Request arrives ───────────────────────────────────────────────┐
│                                                                  │
│  demo=cached ?                                                   │
│      │                                                           │
│      YES → DEMO REPLAY ──────────────────────────────────────┐   │
│      │                                                        │   │
│      NO                                                       │   │
│      ▼                                                        │   │
│  Live path:                                                   │   │
│    schema bootstrap → agent loop → tool calls                 │   │
│    Every callTool passes through:                             │   │
│                                                                │   │
│      ┌─ Response cache ──────────────────────────────────┐    │   │
│      │  key = `${name}:${JSON.stringify(args)}`           │    │   │
│      │  cache.get → HIT within 60s? return                 │    │   │
│      │  cache miss → fire live call                         │    │   │
│      │  success → cache.set with expiresAt = now + 60_000  │    │   │
│      │  error → return, don't cache                         │    │   │
│      └──────────────────────────────────────────────────┘    │   │
│                                                                │   │
│      ▼                                                        │   │
│    stream NDJSON of real events                               │   │
│                                                                │   │
└──────────────────────────────────────────────────────────────┘   │
                                                                    │
                                                                    │
┌─ DEMO REPLAY branch ─────────────────────────────────────────────┘
│                                                                  │
│  readFileSync(DEMO_FILE) → snapshot                              │
│  for each event in snapshot.trace:                               │
│    controller.enqueue(NDJSON)                                    │
│    await sleep(140ms briefing / 180ms agent)                     │
│  emit final { type: 'done' }                                     │
│                                                                  │
│  wall clock: ~(events × delay), not real run time                │
│  cost: $0                                                        │
│  Anthropic / Bloomreach: never called                            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The response cache is straight-line memoization + TTL. The pattern predates everything — Lisp's memoize function, HTTP's `Cache-Control`, `functools.lru_cache` in Python. The load-bearing choices here are (1) don't cache errors, (2) per-request scoping, (3) 60s TTL matching the "same investigation" window. Change any one and the shape changes materially.

The demo replay is the same pattern as Selenium's HAR-file playback, or an integration test's fixture replay — capture the interaction once, replay it many times without the live dependency. The blooming version adds the fake `setTimeout` between events because the UI reveals progressively (streaming NDJSON), so an instant replay would defeat the presentation.

**Adjacent primitive worth naming.** The demo replay is a specialization of "record + replay" — the same shape as Playwright's traces, VCR gems in Ruby, or React DevTools' Profiler recordings. Once you've built one, you've built them all. What's specific to this codebase is the choice to make the reveal *pace-accurate*, not just correct.

**What to read next.** `05-rate-limit-spacing-and-retry-ladder.md` for how the response cache reduces gate contention (cached calls skip the gate entirely). `03-observability-report.md` for how per-tool durations flow into the report — the cache hit shows up as `durationMs: 0` in the receipt.

## Interview defense

**Q: Walk me through the two caches. Why two, not one?**

They solve different problems. The **response cache** is memoization inside the Bloomreach adapter — key is `${name}:${JSON.stringify(args)}`, 60-second TTL, per-instance so it's per-request. It absorbs the ReAct loop re-firing the same EQL query — the model reasons for a bit, calls the same query, hits the cache, gets a `durationMs: 0` result. Fine-grained, in-memory, runtime optimization.

The **demo replay** is a completely different machine — `?demo=cached` on the URL triggers the branch, reads a committed JSON snapshot from disk, and streams the recorded events as NDJSON with a 140-180ms delay so the reveal looks live. The model never runs, Bloomreach never gets called. Cost $0, wall clock ~event count × delay. It exists because the alpha MCP server revokes tokens after minutes; without the demo snapshot, a live-only demo would be one bad token away from a broken presentation.

Two caches, two intents: response cache is a runtime optimization; demo replay is a presentation-reliability lever. Same underlying idea (serve the past), different scales.

```
The anchor diagram to sketch

response cache                       demo replay
seconds ago                          last capture (weeks ago)
in-memory, per request               on disk, checked in
60s TTL                              never expires
key = tool + args                    key = ?demo=cached URL
cost: $0 on hit                      cost: $0 always
```

**Q: Why don't you cache error results?**

Cache poisoning. If a transient error — say a 500 from Bloomreach — hit the cache, the next 60 seconds of same-args calls all see that stale error even after the underlying condition clears. The ReAct loop's "try a different query" recovery gets defeated because the same query keeps returning the cached failure. The line at `lib/data-source/bloomreach-data-source.ts:179` is the guard.

**Q: What's the failure mode of the demo replay?**

Malformed snapshot JSON. The code catches `JSON.parse` and falls through to the live path, so a corrupt snapshot silently degrades to live — which is fine except live is the exact path the demo was there to bypass. In practice the snapshot is committed as a regenerated file from the capture flow, not hand-edited, so this is rare. A honest fix would be a build-time schema check on the snapshot to fail commits, not runtime.

**Q: Why not batch or debounce the tool calls to reduce cache misses further?**

The MCP protocol doesn't currently support batched tool calls on Bloomreach's side, and the agent loop issues one tool at a time by construction. Debouncing at the client side would require the model to know about it — hard to teach a prompt. The current shape (memoize + TTL) is the right lever for this repo; batching would be worth doing if the protocol grew batch support.

**Q: What's the wall-clock difference between demo and live?**

Live: ~100-115s per investigation end-to-end (schema bootstrap + agent loop + streaming). Demo: probably 30-60s of NDJSON reveal (the trace has ~200-400 events, times 180ms delay each). So demo is faster than live but not instant — the whole point is to feel *live-shaped*, not skip the reveal entirely.

## See also

- `05-rate-limit-spacing-and-retry-ladder.md` — cache hits skip the rate-limit gate entirely; the two mechanisms compose.
- `03-observability-report.md` — cached calls appear as `durationMs: 0` in per-tool-call latency stats.
- `audit.md` §6 — caching-batching-and-backpressure lens finding.
- `audit.md` §8 R2 — the 60s TTL as a mild red flag (no explicit invalidation on data change).
