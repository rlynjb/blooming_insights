# Arrays, strings, and hash maps

*Indexed sequences, strings/buffers, sets, maps — Industry standard · ★★★★★ exercised*

## Zoom out — the workhorses of this codebase

```
  Hash maps and arrays — where they actually live
  ───────────────────────────────────────────────

  ┌─ UI layer ────────────────────────────────────┐
  │  arrays:  insights.map(...) renders cards     │
  │  arrays:  funnelStages.reduce(argmin) → leak  │
  │           components/feed/InsightCard.tsx     │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Streaming kernel ─────▼──────────────────────┐
  │  strings: split('\n') · buf.pop() leftover    │
  │           lib/streaming/ndjson.ts             │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Service layer ────────▼──────────────────────┐
  │  ★ MAPS  · state: Map<sessionId, SessionFeed> │
  │            cache: Map<key, {result, expiresAt}>│
  │  ★ SETS  · capabilities: Set<string>          │
  │            tool allowlist: Set<string>        │
  │  arrays:  tool-name lists, anomaly arrays     │
  └────────────────────────┬──────────────────────┘
                           │
  ┌─ Provider boundary ────▼──────────────────────┐
  │  buffers: AES-256-GCM Buffer.concat (auth)    │
  └───────────────────────────────────────────────┘
```

Zoom in: this is *the* concept file for this repo.
Almost every piece of state — sessions, caches,
capability gates, tool allowlists — is a `Map` or a
`Set`. Almost every transformation — render lists,
top-K, coverage cross-checks — is an array method
chain. If you only learn one DSA primitive from this
codebase, learn the hash map.

## Structure pass — what these primitives share

Three primitives (Array / String / Hash-table-backed
collections), one question held constant: *"how do
you reach a specific element?"*

```
  One question, three answers
  ───────────────────────────

  "how do you reach element X?"

  ┌─ Array ─────────────────────────┐
  │ by INDEX (0..N-1) → O(1)        │
  │ by VALUE         → O(N) scan    │
  └─────────────────────────────────┘

  ┌─ String (immutable in JS) ──────┐
  │ by INDEX (charAt)  → O(1)       │
  │ by SUBSTRING       → O(N + M)   │
  │ by SPLIT-DELIMITER → O(N) once  │
  └─────────────────────────────────┘

  ┌─ Hash map / Set ────────────────┐
  │ by KEY → O(1) average           │
  │ by VALUE → not supported        │
  │   (build a reverse Map for it)  │
  └─────────────────────────────────┘
```

The seam where it flips: **indexed vs keyed access**.
Arrays index by position; maps index by anything
hashable. The choice is "do I have a stable id, or do
I have an ordered sequence?" Get this wrong and you
end up calling `Array.find` in a hot loop — which
this repo deliberately avoids.

Hand off to How it works.

## How it works

#### Move 1 — the mental model

You build forms with a `<input value={state}
onChange={...}>` pattern: a single source of truth
keyed by a string name (`"email"`, `"password"`).
That's a hash map. You render a list with
`items.map(i => <Card key={i.id} ... />)`. That's
an array. The two primitives compose: the *array* is
the ordered view, the *map* is the keyed lookup. Most
real state lives in both at once.

```
  The compose move — map for lookup, array for order
  ──────────────────────────────────────────────────

         insertion order
            ╲                ┌───────────────────┐
             ╲               │ Map.values()      │
              ╲              │ → arr in insert    │
               ╲             │   order (preserved)│
                ╲            └────────┬──────────┘
                 ▼                    │
            ┌──────────┐              │
            │   Map    │              │ when you need order:
            │  by id   │ ─────────────▶   spread Map.values()
            │  for O(1)│              │   into an Array
            │  lookup  │              │
            └──────────┘              │
                 ▲                    │
                 │ when you need lookup:
                 │ key by .id into a Map
                 │
            ┌──────────┐
            │  Array   │
            │ from API │
            └──────────┘
```

This is exactly the move `lib/state/insights.ts`
makes, walked next.

#### Move 2 — the operations, anchored to your code

**Hash map by primary key — `Map<sessionId,
SessionFeed>`**

The single most load-bearing data structure in this
repo. The "what breaks without it" test: drop it and
session B's `putInsights` clears session A's feed in
the middle of session A's briefing. The Map is what
makes per-session isolation cheap.

```ts
// lib/state/insights.ts:8-23
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};

const state = new Map<string, SessionFeed>();
//                ▲
//   outer map: O(1) session lookup
//   value is itself a struct of three inner maps,
//   each keyed by insight/investigation id

function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);              // ← O(1)
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);                 // ← O(1) amortized
  }
  return s;
}
```

The shape pop: a *Map of Maps* is the right move
when you have two orthogonal axes of identity
(session × insight). The alternative — a
`Map<{sessionId, insightId}, Insight>` keyed by a
composite — works but loses the cheap "clear all of
session B" operation that `s.insights.clear()` gives
you.

**Set as a capability gate — `Set<string>`**

A `Set` is "a `Map<K, true>` with nicer syntax." Use
it whenever the question is *membership*, not lookup.

```ts
// lib/agents/categories-legacy.ts:120-127
export function schemaCapabilities(schema: {
  events: { name: string; properties: string[] }[];
  catalogs?: { name: string }[];
}): Set<string> {
  const set = new Set<string>();
  for (const e of schema.events ?? []) {
    set.add(e.name);                              // ← event name as capability
    for (const p of e.properties ?? []) set.add(`${e.name}.${p}`);
    //                                       ▲
    //  encode the (event, property) pair as a single string
    //  → membership check is now ONE Set.has() call
  }
  for (const c of schema.catalogs ?? []) set.add(`catalog:${c.name}`);
  return set;
}
```

The Set is then queried with `available.has(dep)` for
every category dependency. **The pattern to internalise:**
when the workload is "I have list A and list B, which
of B's items are absent from A?", the answer is
*always* "convert A to a Set first, then filter B."
The naive approach is `B.filter(b => !A.includes(b))`
which is O(A × B). The Set version is O(A + B).

Worked next:

```ts
// lib/mcp/tool-coverage.ts:39-41
const server = new Set(serverToolNames);          // ← O(S), build once
const absent = (list: readonly string[]) =>
  list.filter((n) => !server.has(n));             // ← O(L) per list
//                    ▲ O(1) per check, not O(S)
```

Without the Set, `list.filter(n => !serverToolNames.includes(n))`
is O(L × S). The Set takes one extra line and turns a
quadratic into a linear. **This is the single highest-
leverage DSA move you'll make in real code.**

**Array transforms — the chain that builds the schema
summary**

Arrays are mostly iterated, not indexed. The chain is
`filter → map → sort → slice → join` — declarative,
each step O(N), composing into the final string.

```ts
// lib/agents/monitoring.ts:28-34
const eventsText = schema.events
  .slice(0, MAX_EVENTS)                                 // ← O(K), K=20
  .map((e) => {
    const props = e.properties.slice(0, MAX_PROPS_PER_EVENT).join(', ');
    return `  - ${e.name} (${e.eventCount}): ${props || '(no properties)'}`;
  })
  .join('\n');                                          // ← O(K)
```

Read it top-to-bottom: bound the size, transform each,
serialize. The `.slice(0, MAX_EVENTS)` is a **token-
budget bound**, not a performance bound — feeding all
of a 112KB schema to Claude would blow the prompt
budget. The DSA primitive (slice) is solving a *cost*
problem (tokens), not a *complexity* problem.

```
  Method-chain execution trace — schema with 50 events
  ────────────────────────────────────────────────────

  schema.events                        N = 50
       │
       ▼  .slice(0, 20)               ┐
  [e0..e19]                          │ O(K) each
       │                              │ K = 20
       ▼  .map(e => "  - name (n): props")
  ["...", "...", ...]                 │
       │                              │
       ▼  .join('\n')                  ▼
  one string, ~20 lines             O(K)

  total: O(K) for the whole chain
  cost driver: the resulting STRING goes into a Claude
               prompt — every char counts toward $$
```

**Map cache with TTL — `Map<key, { result, expiresAt
}>`**

The hash map's "extra power" is that the *value* can
carry metadata. Caching with expiry is just "store
the timestamp alongside the value":

```ts
// lib/data-source/bloomreach-data-source.ts:122
private cache = new Map<string, { result: unknown; expiresAt: number }>();
// ...:144-152
const cacheKey = `${name}:${JSON.stringify(args)}`;
//   ▲ composite key encoded as a string — Map's only
//     hashable key for objects is identity, so encode
const ttl = options.cacheTtlMs ?? 60_000;
if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);             // ← O(1)
  if (cached && cached.expiresAt > Date.now()) {       // ← check expiry inline
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

The pattern: **stringify the composite key** because
JavaScript's `Map` hashes object keys by reference,
not by value. If you want `{name, args}` to hash to
the same bucket across calls, you have to serialise
it yourself. (This is also why `JSON.stringify` order
matters — different key order = different string =
cache miss.)

**Strings as a line-buffer — the NDJSON kernel**

The single most consequential string operation in
this repo is the line buffer in `ndjson.ts`. It
solves a real problem: **a network chunk does not
align to a line boundary.** You might receive
`{"type":"reasoning"` in one chunk and `_step",...}\n`
in the next. The fix is universal — split on `\n`,
keep the last piece (which may be incomplete), and
prepend it to the next chunk.

```ts
// lib/streaming/ndjson.ts:38-50
buf += decoder.decode(value, { stream: true });
const lines = buf.split('\n');
buf = lines.pop() ?? '';
//        ▲
//   pop() removes the LAST element and returns it
//   — this is the partial line that might continue
//   in the next chunk
for (const raw of lines) {
  const line = raw.trim();
  if (!line) continue;
  try {
    onEvent(JSON.parse(line) as E);
  } catch (err) {
    opts?.onMalformed?.(line, err);
  }
}
```

```
  The buffer kernel — handling a partial line at chunk boundary
  ─────────────────────────────────────────────────────────────

  chunk 1: '{"type":"x"}\n{"type":"y'
  chunk 2: '"}\n{"type":"z"}\n'

  step 1: buf = '{"type":"x"}\n{"type":"y'
          split → ['{"type":"x"}', '{"type":"y']
          pop()  → buf = '{"type":"y'        (saved for next round)
          process: ['{"type":"x"}']          (the complete line)

  step 2: buf = '{"type":"y' + '"}\n{"type":"z"}\n'
              = '{"type":"y"}\n{"type":"z"}\n'
          split → ['{"type":"y"}', '{"type":"z"}', '']
          pop()  → buf = ''
          process: ['{"type":"y"}', '{"type":"z"}']

  invariant: buf always holds whatever follows the last '\n'
  break case: if you DON'T pop(), you JSON.parse(incomplete)
              and crash on every chunk boundary
```

This is the single most reusable string-buffer
pattern in working code. Anywhere you parse a stream
of delimited records — newline-delimited JSON, CSV,
SSE — this kernel is the answer.

#### Move 3 — the principle

Hash maps and arrays are not interchangeable. The
question that picks between them is *"how do I reach
the element I want?"* If you have a stable identity,
reach for a `Map` (or a `Set` if you only care about
membership). If you have a position or an ordering,
reach for an `Array`. Most real state needs both at
once — Map for lookup, Array (or `Map.values()` spread)
for iteration order.

## Primary diagram

```
  The four data-structure moves in this repo
  ──────────────────────────────────────────

  ┌───────────────────────────────────────────────────┐
  │ 1. Map for keyed state                            │
  │    state.get(sessionId)?.insights.get(id)         │
  │    → O(1) per hop                                 │
  ├───────────────────────────────────────────────────┤
  │ 2. Set for capability membership                  │
  │    available.has(`${event}.${property}`)          │
  │    → O(1); turns O(N × M) coverage into O(N + M)  │
  ├───────────────────────────────────────────────────┤
  │ 3. Array chain for transforms                     │
  │    arr.slice(0, K).map(...).join('\n')            │
  │    → O(K) total; bound input first                │
  ├───────────────────────────────────────────────────┤
  │ 4. String split('\n') + pop() for line buffers    │
  │    buf.split('\n'); buf = lines.pop() ?? ''       │
  │    → handles partial-line at chunk boundary       │
  └───────────────────────────────────────────────────┘
```

## Elaborate

The reason `Map` (added in ES2015) is preferred over
`{}`-as-map: object literals coerce all keys to
strings, can't iterate in guaranteed insertion order
in older runtimes, and inherit prototype properties
(so `obj["toString"]` is always a function, not
`undefined`). `Map` keys are typed, iteration is
insertion-ordered by spec, and `Map.size` is O(1).
Use plain objects only for static config; use `Map`
for anything you build at runtime.

The reason `Set` is preferred over `Array.includes`:
membership tests over a Set are O(1); over an Array
they're O(N). The break-even is around 5-10
elements, which means for almost any non-trivial
workload, `Set` wins. The exception is when you need
ordered iteration and de-dup — Set gives you both,
but you don't need it.

Strings in JS are immutable: every "modification" is
a fresh allocation. For large concatenation
workloads, `Array.prototype.join` is the idiom (build
the array, join once) — V8 optimizes the join into a
single contiguous allocation. This is what the
schema summary chain above relies on.

For deep grounding, see *Algorithms 4th Ed*
(Sedgewick) §3.4 on hash tables, and the V8 docs on
the internals of Map (uses "ordered hash table" —
hash table that also stores insertion order).

## Interview defense

**Q: Walk me through your session state. Why nested
Maps?**

```
  The shape — Map of Maps for two orthogonal ids
  ──────────────────────────────────────────────

  Map<sessionId, SessionFeed>
       │
       ▼  .get(sessionId) → O(1)
  SessionFeed {
    insights:       Map<insightId, Insight>
    investigations: Map<insightId, Investigation>
    anomalies:      Map<insightId, Anomaly>
  }
       │
       ▼  .insights.get(insightId) → O(1)
  Insight
```

Model answer: "Each warm Vercel instance serves
many concurrent users. If I put insights in one flat
`Map<insightId, Insight>` at module scope, session
B's `putInsights` would call `.clear()` and wipe
session A's feed. The outer Map keys by sessionId
and the inner Maps key by insightId, giving me O(1)
session isolation and O(1) insight lookup in one
move. Anchor: `lib/state/insights.ts:14`."

**Q: Why a `Set<string>` for capabilities, not a
`Map<string, boolean>`?**

Model answer: "A Set *is* a Map<K, true> — same hash
table underneath. I reach for Set when the answer to
'is X here?' is the entire question. The schema
capabilities are membership: 'is the `purchase`
event present? is the `purchase.total_price` property
present?' One `Set.has(...)` call answers it in O(1).
A Map would force me to write `.get(key) === true`
which is noisier and reads worse. Anchor:
`lib/agents/categories-legacy.ts:120`."

**Q: The NDJSON parser uses `buf.split('\n')` and
then `buf = lines.pop() ?? ''`. Why?**

Model answer: "A network chunk doesn't align to a
line boundary. The last element of `split('\n')` is
either an empty string (chunk ended on a newline) or
a partial line (chunk ended mid-record). `pop()`
takes that last piece off and saves it as the next
chunk's prefix. Without the pop, I'd `JSON.parse` an
incomplete object and crash every chunk boundary.
This is the load-bearing invariant: `buf` always
holds whatever's after the last newline. Anchor:
`lib/streaming/ndjson.ts:40-42`."

**Q: When would `Array.find` be wrong here?**

Model answer: "In a hot path with a stable id. If
`getInsight` did `insights.find(i => i.id === id)`,
the cost goes from O(1) to O(N). For 5 insights it's
fine; for a long-running session with hundreds, it's
not. The general rule: any time you have a stable
identity and you'll look it up more than once, the
data structure should be a Map keyed by that
identity. Anchor: `lib/state/insights.ts:73`."

## See also

- `01-complexity-and-cost-models.md` — when the Big-O
  story applies vs when wall-clock takes over
- `03-stacks-queues-deques-and-heaps.md` — the
  ordering disciplines that arrays *don't* give you
- `06-sorting-searching-and-selection.md` — the
  comparator move on top of arrays
- `08-dsa-foundations-practice-map.md` — tries (Map
  of Maps stretched deeper)
