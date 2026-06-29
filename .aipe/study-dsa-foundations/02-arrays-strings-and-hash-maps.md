# Arrays, Strings, and Hash Maps

Array · string · hash map · set — Industry standard

## Zoom out — where this concept lives

These are the structures that show up in literally every layer of this codebase. The session feed is a hash map; the schema is an array of events; the NDJSON parser is a string buffer; the tool-coverage check is a set. **They're the substrate.** The diagram marks where the load-bearing ones sit — the session map at the service layer is the one that holds the whole multi-tenant story together.

```
  Zoom out — where the everyday primitives live

  ┌─ UI (browser) ─────────────────────────────────────────────────┐
  │  array      schema.events[], evidence[], steps[]                │
  │  string     headline construction, summary template            │
  │  set        new Set(ev.map(e=>e.tool))  (dedupe in card)        │
  └────────────────────────────────────────────────────────────────┘
                          ▼  fetch + NDJSON
  ┌─ Service (Next API) ───────────────────────────────────────────┐
  │  hash map   ★ state: Map<sessionId, SessionFeed> ★             │   ← we are here
  │             cache: Map<key, {result, expiresAt}>                │
  │             activeToolCalls: Map<toolName, ToolCall[]>          │
  │  set        schemaCapabilities, tool-coverage server set        │
  │  string     buffer in readNdjson, JSON.parse/stringify          │
  └────────────────────────────────────────────────────────────────┘
                          ▼  MCP transport
  ┌─ Storage (Bloomreach) ─────────────────────────────────────────┐
  │  (opaque)                                                       │
  └────────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

Three primitives, one shared property: **O(1) access by the right key.** Array is access by *index*, string is access by *position*, hash map (and set) is access by *value identity*. The choice between them is the choice of what you want to look up things by.

In this codebase the answer is mostly "by string id" — session id, insight id, cache key, tool name — which is why Map is the workhorse. Array shows up when order matters or when the structure came in as JSON; string shows up at the seams where bytes become objects (NDJSON parse, JSON.stringify cache keys).

## Structure pass — layers · axes · seams

One axis traced: **what is the lookup key, and what does the structure cost to find by it?**

```
  one axis — "lookup by what, costing what?"

  ┌─ array  ──────────────────────────────────────────────┐
  │  lookup by index:     O(1)                              │
  │  lookup by value:     O(n)  ← linear scan, the seam     │
  └────────────────────────────────────────────────────────┘
  ┌─ string ──────────────────────────────────────────────┐
  │  lookup by position:  O(1)                              │
  │  lookup by substring: O(n+m)  ← KMP, regex              │
  └────────────────────────────────────────────────────────┘
  ┌─ hash map / set ──────────────────────────────────────┐
  │  lookup by key:       O(1) average, O(n) worst         │
  │  lookup by value:     O(n)  ← same scan as array        │
  └────────────────────────────────────────────────────────┘

  the seam: when you find yourself scanning an array to
  find an element by some property, that's the moment to
  build a Map keyed on that property (one O(n) pre-pass,
  then O(1) lookups). this codebase does this 6+ times.
```

The recurring pattern: a list arrives, the code needs to dedupe / look up / index by some field, and it spends one O(n) to build a Set or Map keyed on that field. After that, every check is O(1). The seam between "scan the array" and "build a Set first" is where you watch for whether `n` is large enough or the lookups are repeated enough to make the prep worthwhile.

## How it works

### Move 1 — the mental model

A hash map (`Map`) takes a key, hashes it into a bucket index, and stores the value there. Lookups hash the same key and read the same bucket. The hash makes a value-identity lookup as fast as an index lookup — **O(1) average**, instead of the O(n) scan you'd pay walking an array looking for a matching field.

You already use this every time you key a React list with `<li key={item.id}>`. The key isn't decoration — React internally builds a Map from key to fiber so it can pair the next render's items to the previous render's nodes in O(1) per item, instead of comparing every old node to every new node in O(n²).

A Set is a Map without values — same bucket trick, the only question is "is this key in here?" answered in O(1).

```
  hash map — the pattern

  insert("session_abc", feedObj)
       │
       │ hash("session_abc") → bucket 47
       ▼
  ┌─────────────────────────────────────────────┐
  │ bucket 0   bucket 47   bucket 99   bucket … │
  │  ⋮         (k,v) ──    ⋮           ⋮         │
  └─────────────────────────────────────────────┘

  get("session_abc")
       │
       │ hash("session_abc") → bucket 47 → read (k,v)
       ▼
  O(1) — same key, same bucket, direct read
```

### Move 2 — the moving parts

#### the session map — multi-tenancy in one Map

This is the load-bearing hash map in the codebase. A single warm Vercel instance serves multiple users concurrently; without a per-session sub-map, the `clear()` inside `putInsights` would wipe another user's feed mid-briefing.

```ts
// lib/state/insights.ts:8-23
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};

const state = new Map<string, SessionFeed>();

function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}
```

Read it line by line:

- **`state = new Map<string, SessionFeed>()`** — the outer hash map (`state`), keyed on session id. Lookup by session id is O(1) regardless of how many concurrent users this instance is serving.
- **`SessionFeed`** is itself three nested Maps. Each insight is keyed by its UUID; same for investigations and the raw anomalies.
- **`sessionState(sessionId)`** — the get-or-create pattern. If the session is new, build the three sub-maps and store them. This is the only place the outer map is written.

What breaks without it: if `state` were a single flat `Map<string, Insight>` shared across sessions, the `putInsights` clear (line 65) would wipe **every user's** feed. The two-level Map is the multi-tenancy primitive.

```
  the two-level map — what each level does

  outer map (state)               inner maps (SessionFeed)
  ┌─────────────────────┐         ┌────────────────────────┐
  │ "session_abc"       │ ──────► │ insights:       Map<…> │
  │ "session_xyz"       │ ──────► │ investigations: Map<…> │
  │ "session_def"       │ ──────► │ anomalies:      Map<…> │
  └─────────────────────┘         └────────────────────────┘
  outer NEVER cleared             inner cleared per briefing
   (would drop a user)             (the briefing IS the feed)

  one user clearing their feed has zero effect on the others
```

Bridge from what you know: this is the same shape as a React reducer with `state[userId] = {...}` — namespace the data by an identity key so mutations stay scoped. The Map is just the right primitive for that, because `string` keys are exactly what `state.get(userId)` answers in O(1).

#### the response cache — Map as a TTL store

The Bloomreach adapter caches every successful tool call for 60 seconds keyed on `name + args`. The Map's job: turn a one-line cache lookup into O(1) so the rate-limit retry ladder doesn't fire on repeats.

```ts
// lib/data-source/bloomreach-data-source.ts:122 + 144-150
private cache = new Map<string, { result: unknown; expiresAt: number }>();

// ... inside callTool:
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

- **`cacheKey = name:JSON.stringify(args)`** — the string composition is the cheap, deterministic key. Two calls with the same name and the same args produce the same string, hence the same hash, hence the same bucket.
- **`{result, expiresAt}`** — the value carries its own TTL. Cleanup is lazy: an expired entry is ignored on read and overwritten on the next miss.
- **`durationMs: 0, fromCache: true`** — the cache hit short-circuits the entire rate-limit ladder. Saves seconds.

What breaks without it: every repeat call pays the rate-limit ceiling. Under the parsed retry hint of ~10s, two agent turns asking the same EQL would block for 10s on the second one. The cache turns that into a microsecond Map lookup.

#### `activeToolCalls` — Map of queues, keyed on tool name

When the AptKit trace sink converts `tool_call_start` / `tool_call_end` events back into Blooming's `ToolCall` shape, it needs to pair an end with its matching start. The Map indexes one queue per tool name:

```ts
// lib/agents/aptkit-adapters.ts:101 + 114-128
private readonly activeToolCalls = new Map<string, ToolCall[]>();

// on tool_call_start:
const existing = this.activeToolCalls.get(event.toolName) ?? [];
existing.push(toolCall);
this.activeToolCalls.set(event.toolName, existing);

// on tool_call_end:
const toolCall = this.activeToolCalls.get(event.toolName)?.shift() ?? this.toBloomingToolCall(event);
```

- the Map keys by `toolName`, so two simultaneous `execute_analytics_eql` calls don't collide with a concurrent `list_projects` call.
- the **value is a queue (an array used FIFO)** — push at the start, shift at the end. The first start is paired with the first end of the same name — see the next file (`03-stacks-queues-deques-and-heaps.md`) for the queue discipline.

What breaks without it: pair a start and an end by global order across all tools, and two interleaved tool calls of different names get crossed wires (start-A, start-B, end-A pairs with B's queue head). The keyed Map keeps each tool's pairing in its own lane.

#### the dedupe set — one O(n) pass for O(1) lookups

The `InsightCard` builds a deduplicated list of tools that produced the insight:

```ts
// components/feed/InsightCard.tsx:89
const tools = [...new Set(ev.map((e) => e?.tool).filter((t): t is string => !!t))];
```

Read right-to-left: map to extract `tool` strings, filter out nulls, **stuff into a Set to dedupe (one O(n) hash pass)**, spread back to an array for the join. The whole expression is O(n) where n is the number of evidence entries (small — usually 1-3).

The instinct here is the seam from the structure pass: any time you'd write "if I haven't seen this value before, add it" in a manual loop, a Set is the one-liner.

#### the capability set — gate categories against the schema

```ts
// lib/agents/categories-legacy.ts:116-127
export function schemaCapabilities(schema: {
  events: { name: string; properties: string[] }[];
  catalogs?: { name: string }[];
}): Set<string> {
  const set = new Set<string>();
  for (const e of schema.events ?? []) {
    set.add(e.name);
    for (const p of e.properties ?? []) set.add(`${e.name}.${p}`);
  }
  for (const c of schema.catalogs ?? []) set.add(`catalog:${c.name}`);
  return set;
}
```

Each capability is a string with a discriminator prefix (`event.property`, `catalog:name`). The Set is the lookup table: `coverageFor` then asks `available.has(dep)` for each of a category's `requires` and `enriches`. That `has` is O(1); if `available` were a plain array, every `has` would scan the list — and `coverageFor` runs across 10 categories × (3-5 deps each) = ~40 checks, so the difference is real.

```
  the gate, drawn

  schema.events[] ──┐
                    │  schemaCapabilities (one O(n) build)
  schema.catalogs[] ┤
                    ▼
                  Set<string> = { "view_item", "purchase",
                                  "purchase.total_price",
                                  "catalog:inventory_level", … }
                    │
                    │  10 categories × 3-5 deps each
                    ▼
              coverageFor(cat, set)  →  has(dep) is O(1)
```

#### string buffers — the NDJSON kernel

Strings get reached for at the network seam. The NDJSON reader holds an in-progress buffer across chunks because a JSON line can split mid-arrival:

```ts
// lib/streaming/ndjson.ts:29-50
const decoder = new TextDecoder();
let buf = '';
try {
  while (true) {
    if (opts?.cancelOn?.()) { await reader.cancel(); return; }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try { onEvent(JSON.parse(line) as E); }
      catch (err) { opts?.onMalformed?.(line, err); }
    }
  }
```

- **`buf += decoder.decode(...)`** — string concatenation as accumulation. Each chunk lands at the end.
- **`buf.split('\n')`** — turn the buffer into lines. The last element is the partial line (or `''` if the chunk ended on `\n`).
- **`buf = lines.pop() ?? ''`** — keep the partial as the new buffer; emit the complete lines as events.

What breaks without the partial-line keep-back: a JSON event that spans two TCP chunks gets parsed as two malformed halves. The buffer is the load-bearing part — drop it and the parser becomes wrong, not just slow.

```
  the buffer — execution trace

  chunk 1 = '{"a":1}\n{"b":2'
  buf = '{"a":1}\n{"b":2'
  split('\n') → ['{"a":1}', '{"b":2']
  pop() → buf = '{"b":2'
  emit: {"a":1}

  chunk 2 = '}\n{"c":3}\n'
  buf = '{"b":2}\n{"c":3}\n'
  split('\n') → ['{"b":2}', '{"c":3}', '']
  pop() → buf = ''
  emit: {"b":2}, {"c":3}
```

### Move 3 — the principle

Arrays answer "what's at position k?" in O(1). Strings answer "what byte is at position k?" in O(1). Hash maps answer "what value sits at this key?" in O(1) — and the key can be anything stringifiable, which is why they're the universal indirection primitive in dynamic-language code. **The art is not the data structure; it's noticing the moment your code is scanning an array to find something it could be looking up directly.** Every Map and Set in this repo is the result of that noticing.

## Primary diagram

The recap — every Map and Set in the codebase, indexed by what they answer.

```
  arrays / strings / hash maps in blooming_insights

  ┌─ hash maps (Map<string, …>) ─────────────────────────────────────┐
  │  state                       Map<sessionId, SessionFeed>          │
  │  ├─ insights                 Map<insightId, Insight>              │
  │  ├─ investigations           Map<insightId, Investigation>        │
  │  └─ anomalies                Map<insightId, Anomaly>              │
  │  cache (Bloomreach)          Map<"name:args", {result, expiresAt}>│
  │  activeToolCalls             Map<toolName, ToolCall[]>            │
  │  memStore (auth)             Map<sessionId, SessionAuthState>     │
  │  mem (investigations)        Map<insightId, AgentEvent[]>         │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ sets (Set<string>) ─────────────────────────────────────────────┐
  │  schemaCapabilities          Set<"event" | "event.prop" | "cat:…"> │
  │  filterToolSchemas allowed   Set<toolName>                         │
  │  tool-coverage server set    Set<serverToolName>                   │
  │  InsightCard tool dedupe     Set<toolName>                         │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ arrays + strings (everywhere) ──────────────────────────────────┐
  │  schema.events[], evidence[], steps[], hypothesesConsidered[]    │
  │  buf in readNdjson  (string accumulator across chunks)            │
  │  cacheKey = `${name}:${JSON.stringify(args)}` (string composition)│
  │  Buffer.concat in auth (AES bytes, not text)                      │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

Hash maps trace back to Luhn (1953) at IBM — the first chaining-based hash table. Modern JS `Map` is spec'd in ES2015; under the hood V8 uses a small-integer-friendly HashTable for plain objects and a tuned open-addressing variant for `Map` instances. **The practical performance difference between `Map` and a plain object** is real for hot-loop integer keys but invisible for string keys at this codebase's scale — use `Map` for the explicit key/value semantics and the size-tracking, not for speed.

The string-buffer pattern in `readNdjson` is the same shape as a TCP framing parser — every line-delimited or length-prefixed protocol has this loop. Once you see it once, you see it in: SSE parsers, log tailers, IRC clients, MIME-multipart upload handlers. The trick is always "keep the partial; emit the complete; the seam is the delimiter."

Read next: file 03 (queues + the `activeToolCalls` pattern in depth), file 06 (where the sort comparator lives).

## Interview defense

### Q: Why is `state` a Map of Maps instead of one flat Map?

Multi-tenancy. A single warm Vercel instance serves multiple users at once. `putInsights` clears the feed on every briefing — if everyone shared one flat `Map<insightId, Insight>`, that clear would wipe another user's feed mid-stream. The two-level shape namespaces by `sessionId`: the outer Map is never cleared, the inner Maps are cleared per-session per-briefing.

```
  the bug a flat map would have

  flat:  Map<insightId, Insight>
         user A briefs → clear() → user A writes → user B's items gone

  nested: Map<sessionId, {insights: Map<insightId, Insight>, …}>
          user A briefs → sessionState("A").insights.clear() → A writes
          user B's sessionState("B") untouched
```

The lookup is two `.get()` calls (outer then inner), both O(1), so the namespacing costs nothing.

Anchor: `lib/state/insights.ts:14, 57-71`.

### Q: When would you reach for a Set instead of an array?

When the operation you keep doing on the data is `includes` — i.e., "is this value already in here?" — and the data is more than tiny. Set.has is O(1); array.includes is O(n). Two real examples here:

- `schemaCapabilities` builds a Set once (O(events × props)) so that the coverage gate can ask `available.has(dep)` for 40+ deps cheaply. If it were an array, each `has` would scan the list.
- `filterToolSchemas` builds a Set from the allowed-tools list to filter the full tool catalog. With ~20 tools it doesn't matter on paper, but the code makes the intent explicit: "I want a membership test, not a list."

```
  the seam — when does Set beat array?

  one-shot includes:         array is fine
  repeated includes (loop):  Set is right — pay O(n) once,
                             save O(n) on every lookup after
```

The other reason: Set spread-then-pop is the canonical dedupe one-liner: `[...new Set(arr)]`. That's how `InsightCard` dedupes tool names.

Anchors: `lib/agents/categories-legacy.ts:120`, `lib/agents/tool-schemas.ts:13`, `components/feed/InsightCard.tsx:89`.

### Q: What's the load-bearing part of the NDJSON reader?

The partial-line carry-over: `buf = lines.pop() ?? ''`. A TCP chunk has no relationship to a JSON line boundary — a 5KB chunk might contain 3 full JSON lines and the first 200 bytes of a fourth. The reader splits on newlines, takes the last element off (the partial), and saves it as the new `buf`. The next chunk's bytes get appended to that buffer before the next split.

```
  the kernel, two-chunk trace

  chunk 1: '{"a":1}\n{"b":2'
    split('\n') → ['{"a":1}', '{"b":2']
    pop()       → buf = '{"b":2'
    emit:       {"a":1}

  chunk 2: '}\n{"c":3}\n'
    buf += chunk2 → '{"b":2}\n{"c":3}\n'
    split('\n')   → ['{"b":2}', '{"c":3}', '']
    pop()         → buf = ''
    emit:         {"b":2}, {"c":3}
```

Drop the pop-and-save and `{"b":2` parses as malformed in chunk 1 and `}` parses as malformed in chunk 2 — you lose the event entirely. The string buffer is the kernel; the rest is decoration.

Anchor: `lib/streaming/ndjson.ts:30, 39-41`.

## See also

- 01-complexity-and-cost-models.md — for the O(1) / O(n) cost calculus these primitives sit inside.
- 03-stacks-queues-deques-and-heaps.md — for `activeToolCalls`' FIFO discipline.
- 06-sorting-searching-and-selection.md — for what to reach for when array scan stops being enough.
- `.aipe/study-system-design/00-overview.md` — for the multi-tenant warm-instance shape the session map serves.
