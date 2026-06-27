# Arrays, strings, and hash maps

**Industry name(s):** indexed sequences, character sequences (strings), associative arrays (hash maps / sets), bucketed-hash open-addressing tables
**Type:** Industry standard · Language-agnostic

> The three primitives every other data structure is built from: arrays for ordered storage with O(1) index access, strings for character sequences (which behave like arrays-of-chars plus a few specialized ops), and hash maps/sets for O(1) keyed lookup. This codebase is built almost entirely from them.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Arrays, strings, and hash maps are the five-star primitives of this codebase — load-bearing in every layer. The TTL cache is a `Map<string, {result, expiresAt}>` (`lib/mcp/client.ts` L80). The coverage gate's capability check is a `Set<string>` of flattened tokens (`lib/agents/categories.ts` L116–L127). The NDJSON reader is a string `buf` plus `buf.split('\n')` and `lines.pop()` (`lib/hooks/useInvestigation.ts` L184–L208). The tool dedup is a Set-union spread (`lib/mcp/tools.ts` L38–L40). The anomaly array is just an `Array<Anomaly>` from start to finish. The codebase doesn't reach for anything beyond these primitives because it doesn't need to.

```
Zoom out — where arrays/strings/hash maps live

┌─ UI band ────────────────────────────────────────────────┐
│  string buffer (NDJSON reader)                            │
│  Array.prototype.map over items                           │
└────────────────────────────┬─────────────────────────────┘
                             │
┌─ Agent / mapping band ─────▼─────────────────────────────┐
│  Array<Anomaly>, Array<Recommendation>                    │
│  ★ Map (TTL cache key → {result, expiresAt}) ★            │  ← we are here
│  ★ Set (queryTools dedup, schemaCapabilities)  ★          │  ← we are here
│  ★ string buf for NDJSON reader ★                         │  ← we are here
└────────────────────────────┬─────────────────────────────┘
                             │
┌─ Storage / transport ──────▼─────────────────────────────┐
│  bytes over HTTP (Uint8Array, decoded to string)          │
└──────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when do you reach for each of these three primitives, and what makes them different from each other? The answer is the access pattern. **Array** = ordered, O(1) by integer index, O(N) by value lookup. **String** = ordered character sequence with specialized ops (concat, split, slice, indexOf) — behaviorally an array of chars plus a length-prefix and an immutability guarantee. **Map / Set** = unordered (Map preserves *insertion* order, but you don't access by it), O(1) by key. The codebase's pattern is to *use the access pattern to pick the primitive*: integer-indexed iteration → array; character framing → string; keyed lookup → Map/Set. The next sections name each primitive, walk its kernel operations, and pin them to the load-bearing repo examples.

---

## Structure pass

**Layers.** Each primitive has the same three-layer stack: the **abstract operation** (get-by-key, get-by-index, append, scan), the **concrete implementation** (V8 arrays use packed/holey/dictionary modes; strings are immutable UTF-16 sequences; Maps use a hash table with linear-probing buckets), and the **observed cost** (most ops O(1) average, scans O(N), some surprises around growth and rehashing). For 99% of the code you write, the abstract layer is the only one you need — the implementation honors the cost contract V8 promises.

**Axis: control.** Who decides what gets stored, in what order, and how it's accessed? For an Array, *the caller* decides order via insertion index. For a String, the *characters' positions* are decided by the source bytes; the caller only chooses what to append/slice. For a Map/Set, *the hash function* decides physical layout; the caller decides logical layout (insertion order). The axis flips at each primitive — which is why mixing them up costs you. Trying to access a Map "at index 3" is asking the wrong question; trying to dedup an array with `arr.includes` is also asking the wrong question (it's O(N²)).

**Seams.** Two seams matter; one is load-bearing. **Seam 1 (load-bearing): "do I look up by integer index or by key?"** This is the seam that picks Array vs Map. Get the seam wrong and you've picked the wrong primitive. **Seam 2: "do I need uniqueness or do I need the value too?"** This picks Set vs Map. Need to *know* whether X is present? Set. Need to *retrieve* X's value when present? Map. The two are the same data structure with one stored field instead of two.

```
Structure pass — arrays, strings, hash maps

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Abstract op (get/append/scan) · Concrete impl      │
│  (V8 hash / packed array / UTF-16 string) ·         │
│  Observed cost (O(1) avg, O(N) scan)                 │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  control: who decides order — caller (Array), source │
│  bytes (String), hash function (Map/Set)             │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: integer index vs keyed lookup ★load-bearing     │
│      (Array vs Map)                                   │
│  S2: presence vs presence+value                       │
│      (Set vs Map)                                     │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

```
S1 seam — "how do I look up X?" answered two ways

┌─ Integer index ─────┐    seam     ┌─ Keyed lookup ────────┐
│  arr[i]: O(1)       │ ═════╪═════►│  map.get(key): O(1)    │
│  scan by value: O(N)│  (it flips) │  has any key: O(1)     │
│  ordered            │             │  unordered (insertion- │
│                     │             │   ordered iteration)   │
└─────────────────────┘             └────────────────────────┘
        ▲                                       ▲
        └────── same axis (control), two answers ─┘
                → picking the wrong side here is the most common
                  performance bug in JavaScript
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

---

## How it works

### Mental model

Three primitives. One for ordered indexed storage (Array). One for character sequences with framing operations (String). One for keyed lookup (Map, and Set as the value-less variant). You build everything else from these.

```
                  THE THREE PRIMITIVES

  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
  │   ARRAY      │   │   STRING     │   │  MAP / SET   │
  │              │   │              │   │              │
  │  [a,b,c,d]   │   │  "abcd"      │   │  {a→1, b→2}  │
  │              │   │              │   │              │
  │  by index    │   │  by char/    │   │  by key      │
  │  O(1)        │   │   substring  │   │  O(1) avg    │
  │              │   │  O(1)/O(N)   │   │              │
  │  ordered     │   │  immutable   │   │  unordered*  │
  └──────────────┘   └──────────────┘   └──────────────┘
                                          *insertion-ordered iteration
                                           in JS Map/Set, but you
                                           don't *access* by index
```

The trick everyone learns: when you need to know "is X in this collection?", you don't scan the array (O(N)) — you put it in a Set (O(1) per query). When you need to know "what value is associated with X?", you use a Map. When you need "the i-th element," you use an Array.

### Move 1 — Array: indexed sequence

An array is a sequence of values addressable by integer index. In JavaScript, that's `Array.prototype` — internally V8 picks one of three representations (packed-smi, packed-elements, holey-elements, or dictionary-mode for sparse arrays) based on what you store and how you access it. You almost never need to know which.

```
  index:   0    1    2    3
  array: [ A    B    C    D ]
            ▲
            arr[0] = A     O(1)
            arr.push(E)    O(1) amortized
            arr.pop()      O(1)
            arr.length     O(1)
            arr.includes(C) O(N)   ← linear scan, no hash
            arr.indexOf(D)  O(N)
            arr.sort()     O(N log N) (Timsort, stable)
            arr.map(f)     O(N)
            arr.filter(p)  O(N)
            arr.reduce(f)  O(N)
            arr.find(p)    O(N) — but short-circuits on first match
```

**The load-bearing array operations in this codebase:**

- `.map` over a fixed registry — `CATEGORIES.map(cat => coverageFor(cat, available))` in `lib/agents/categories.ts` L145.
- `.filter` for derivation — `h.filter(x => x.supported)` in `lib/insights/derive.ts` L58.
- `.reduce` for argmin — the funnel-leak reduce in `components/feed/InsightCard.tsx` L159–L161.
- `.sort` with a comparator — `[...parsed].sort((a, b) => SEV_RANK[...])` in `lib/agents/monitoring.ts` L119.
- `.slice` for top-N — `.slice(0, 10)` immediately after the sort.
- A `for` loop for type narrowing — `findCurrentPrior` in `lib/insights/derive.ts` L12–L20 (a hand-rolled `.find` so TypeScript narrows inside the body).

### Move 2 — String: character sequence with framing ops

A string is an immutable sequence of characters (UTF-16 code units in JavaScript, with surrogate pairs for chars outside the BMP). The operations that matter for framing:

```
  s.length              O(1)        char count (NOT byte count)
  s.charAt(i) / s[i]    O(1)        single char
  s.slice(start, end)   O(end-start) substring (new string, no copy of original)
  s.split(delim)        O(N)        array of substrings
  s.indexOf(needle)     O(N·M)      worst case; usually faster
  s.search(regex)       O(N·M)      or worse depending on regex
  s.match(regex)        O(N·M)      or worse
  s.concat / s + t      O(N + M)    creates new string (immutable)
  s += chunk            same as concat, can be slow in tight loops
                        (V8 has rope optimization but don't rely on it)
```

**Immutability matters.** Every operation that "modifies" a string returns a new one. `buf += decoded` allocates. For NDJSON reading this is fine because chunks are bounded by the network MTU; in a tight loop you'd reach for an array-of-strings + `.join` instead.

**The load-bearing string operations in this codebase:**

- `buf += dec.decode(value, { stream: true })` — string accumulation in the NDJSON reader (`lib/hooks/useInvestigation.ts` L190).
- `buf.split('\n')` — delimiter-based framing in the same loop (L191).
- `JSON.stringify(args)` — building the TTL cache key from a serialized args object (`lib/mcp/client.ts` L102).
- `text.match(/```(?:json)?\s*([\s\S]*?)```/i)` — fenced-block regex extraction in `lib/mcp/validate.ts` L4.
- `candidate.search(/[[{]/)` and `candidate.lastIndexOf(']')` — substring scan for JSON extraction in `lib/mcp/validate.ts` L7–L8.

**Code in this codebase — String + Array compose in the NDJSON line buffer (`lib/hooks/useInvestigation.ts` L184–L208).**

```ts
// lib/hooks/useInvestigation.ts L184–L208 (excerpt)
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line) as AgentEvent);
    } catch { /* ignore malformed line */ }
  }
}
```

Two primitives composing: a String (`buf`) that accumulates partial bytes across chunks, and an Array (`lines`) that splits the buffer at the delimiter. The Array's `.pop()` is what holds the invariant — the last element is either an incomplete record (saved back to `buf`) or empty (when the chunk ended on `\n`).

### Move 3 — Map: hash table for keyed lookup

A Map is a hash table — `get(key)` and `set(key, value)` are O(1) average. The "average" matters: hash collisions degrade to O(N) in pathological cases, but for normal data the average bound is operational.

```
  m.get(key)            O(1) average
  m.set(key, value)     O(1) average (amortized — internal table grows)
  m.has(key)            O(1) average
  m.delete(key)         O(1) average
  m.size                O(1)
  m.keys() / .values()  O(N) to iterate; one yield is O(1)

  iteration order:      INSERTION ORDER (JS spec since ES2015)
  key equality:         SameValueZero (similar to ===, but NaN === NaN)
  key types:            anything — primitives, objects, functions
```

**Set is the same thing without the value.** `s.has(x)` is O(1) average; you store one field per entry instead of two. Use Set when you only need to test presence; use Map when you need to retrieve a stored value.

**The load-bearing Map/Set operations in this codebase:**

- `new Map<string, {result, expiresAt}>()` — the TTL cache (`lib/mcp/client.ts` L80). One `Map.get` per `callTool`; the entire caching strategy depends on its O(1) lookup.
- `new Set<string>()` + `set.add` — the capability set built by `schemaCapabilities` (`lib/agents/categories.ts` L116–L127). Flatten the schema once, then every `has` is O(1).
- `new Set([...a, ...b, ...c])` — the queryTools dedup (`lib/mcp/tools.ts` L38–L40). Set's identity rule does the dedup for free.

**Code in this codebase — Map: the TTL cache (`lib/mcp/client.ts` L80, L102–L108).**

```ts
// lib/mcp/client.ts L80
private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

```ts
// lib/mcp/client.ts L102–L108
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

The Map's whole job is O(1) keyed lookup. `cache.get(cacheKey)` is the load-bearing op — it runs on every `callTool` invocation, and its O(1) cost is what makes the cache cheaper than the live call (which would otherwise dominate). Why not an array of `{key, value, expiresAt}` records? Because lookup on that would be `arr.find(e => e.key === cacheKey)` — O(N). At the small N this codebase has, both would be fast; the Map version stays correct as N grows.

**Code in this codebase — Set: the capability gate (`lib/agents/categories.ts` L116–L127).**

```ts
// lib/agents/categories.ts L116–L127
export function schemaCapabilities(schema): Set<string> {
  const set = new Set<string>();
  for (const e of schema.events ?? []) {
    set.add(e.name);
    for (const p of e.properties ?? []) set.add(`${e.name}.${p}`);
  }
  for (const c of schema.catalogs ?? []) set.add(`catalog:${c.name}`);
  return set;
}
```

```ts
// lib/agents/categories.ts L131–L136
export function coverageFor(cat, available): CategoryCoverage {
  const has = (dep: string) => available.has(dep);
  if (!cat.requires.every(has)) return 'unavailable';
  if (cat.enriches && cat.enriches.length > 0 && !cat.enriches.every(has)) return 'limited';
  return 'full';
}
```

The Set turns a nested-schema-walk-per-dep into a one-time flatten plus O(1) `has` per dep. The kernel insight: **Set membership for any string token, regardless of which kind of thing it represents** — event name, `event.property`, or `catalog:name`. The string-shape contract is what unifies three different ontologies into one membership-testable structure.

**Code in this codebase — Set-union: the `queryTools` dedup (`lib/mcp/tools.ts` L38–L40).**

```ts
// lib/mcp/tools.ts L38–L40
export const queryTools = [
  ...new Set<string>([...monitoringTools, ...diagnosticTools, ...recommendationTools]),
] as const;
```

Three overlapping arrays collapsed into one ordered, deduplicated array — in one expression. The Set does the dedup (insert ignores duplicates by `===`); the spread converts back to an array, preserving insertion order. Insertion order is the load-bearer: it's what makes the result deterministic across reloads.

**Code in this codebase — where the codebase deliberately *stays* in array world (`lib/agents/categories.ts` L139–L141).**

```ts
// lib/agents/categories.ts L139–L141
export function missingFor(cat, available): string[] {
  return [...cat.requires, ...(cat.enriches ?? [])].filter((d) => !available.has(d));
}
```

`missingFor` uses `.filter` (array operation) instead of `.every` (which `coverageFor` uses for the gate). Why? Because here we need *the list of missing deps*, not a boolean. `.filter` produces the array; `.every` produces the boolean. Same iteration, different result type. The distinction matters for the UI's "missing X, Y, Z" copy. This is the array-vs-set distinction in miniature: when you need the *value* of what's missing, you stay in array world; when you need the *boolean* answer, you call `.has` against the Set.

### Move 2 variant — the irreducible kernel of each primitive

Each primitive has a kernel: the operations that *are* the primitive. Strip the kernel and the primitive's no longer useful for its job.

```
ARRAY kernel
─────────────────────────────────
  index access (arr[i])
  length (arr.length)
  push / pop (O(1) at the end)

  without index access:  it's a list, not an array
  without length:        you can't iterate or bound a loop
  without push/pop:      it's frozen — can't grow

STRING kernel
─────────────────────────────────
  length (s.length)
  char access (s[i] / s.charAt)
  concat (s + t)
  slice (s.slice(a, b))

  without length:        no bounds for iteration
  without char access:   not addressable
  without concat:        can't build new strings
  without slice:         can't extract substrings (framing breaks)

MAP/SET kernel
─────────────────────────────────
  get/has (O(1) lookup)
  set/add (O(1) insertion)
  delete (O(1) removal — sometimes optional)

  without O(1) get:      you have an array of pairs, not a map
  without O(1) set:      you'd resort each insert
  without delete:        cache eviction becomes O(N)
```

**Skeleton vs hardening for hash maps specifically:**

```
SKELETON (the kernel)              HARDENING (advanced extras)
─────────────────────────────      ─────────────────────────────────
hash function                      sized initial capacity
bucket array                       custom hash function for objects
collision resolution               LRU eviction
                                   weak references (WeakMap)
                                   ordered iteration (spec'd in JS)
```

This codebase uses the kernel and one piece of hardening (insertion-ordered iteration, which is what makes `[...set]` preserve first-seen order in the dedup).

### Step-by-step execution trace — the three primitives interacting in one call

Trace `callTool("search", {q: "react"})` to show all three primitives at once.

**Step 1 — build the cache key (string concat + JSON serialization).**
```
  name = "search"        ← Array of chars (immutable string)
  args = {q: "react"}    ← Object — needs to become a key

  cacheKey = name + ':' + JSON.stringify(args)
           = "search" + ':' + '{"q":"react"}'
           = "search:{\"q\":\"react\"}"   ← new string, O(name + json)
```

**Step 2 — Map lookup.**
```
  cached = this.cache.get(cacheKey)
        = this.cache.get("search:{\"q\":\"react\"}")
  cost: O(1) average — hash the key, find the bucket, return entry
```

**Step 3 — if hit, return; if miss, fall through to live call.**

**Step 4 — Array iteration over evidence (after live call returns).**
```
  for (const e of result.evidence) {
    // O(1) per element, O(N) total
  }
```

Three primitives, three jobs, one call. They compose without friction because each picks the right shape for its job.

### Move 3 — the principle

**Pick the access pattern first, then the primitive.** Are you accessing by integer index? Array. By substring? String. By key? Map. The most common performance bug in JavaScript code is using `Array.prototype.includes` for what should be a `Set.has` — O(N) per lookup where O(1) was available. The codebase avoids this by reaching for Set/Map whenever the access pattern is keyed.

---

## Primary diagram

The three primitives, their kernel ops, their cost, and where each lives in this codebase.

```
                        THE THREE PRIMITIVES IN THIS CODEBASE

  ┌───────────────────────────┬───────────────────────────┬────────────────────────────┐
  │ ARRAY                     │ STRING                    │ MAP / SET                  │
  │ ─────────────────────     │ ─────────────────────     │ ─────────────────────       │
  │ indexed by integer i      │ indexed by char position  │ keyed by any value         │
  │ ordered                   │ immutable                 │ unordered (insertion iter) │
  │                           │                           │                            │
  │ arr[i]         O(1)       │ s[i] / s.charAt O(1)     │ m.get(k)        O(1) avg   │
  │ arr.push()     O(1)       │ s.length       O(1)      │ m.set(k,v)      O(1) avg   │
  │ arr.pop()      O(1)       │ s.slice(a,b)   O(b-a)    │ m.has(k)        O(1) avg   │
  │ arr.length     O(1)       │ s.split(d)     O(N)      │ m.delete(k)     O(1) avg   │
  │ arr.includes(x) O(N)      │ s + t          O(N+M)    │ s.add(x)        O(1) avg   │
  │ arr.sort()     O(N log N) │ s.indexOf(n)   O(N·M)    │ [...set]        O(N)       │
  │ arr.map/filter/red. O(N)  │ s.match(re)    varies    │                            │
  │                           │                           │                            │
  │ USED IN:                  │ USED IN:                  │ USED IN:                   │
  │ • CATEGORIES.map           │ • buf in NDJSON reader    │ • TTL cache (Map)         │
  │   categories.ts L145       │   useInvestigation L190   │   client.ts L80            │
  │ • [...parsed].sort         │ • cacheKey concat         │ • schemaCapabilities (Set)│
  │   monitoring.ts L119       │   client.ts L102          │   categories.ts L116–L127 │
  │ • h.filter                 │ • fenced-block regex      │ • queryTools dedup (Set)  │
  │   derive.ts L58            │   validate.ts L4          │   tools.ts L38–L40         │
  │ • funnel-leak reduce       │ • substring scan          │                            │
  │   InsightCard L159         │   validate.ts L7–L8       │                            │
  └───────────────────────────┴───────────────────────────┴────────────────────────────┘
```

---

## Elaborate

### Where it comes from

These three primitives are the oldest in computing. Arrays are the original FORTRAN data type (1957). Strings followed quickly — every language since has them. Hash tables date to the 1950s (Hans Peter Luhn at IBM, 1953); the modern open-addressing implementation V8 uses for `Map` and `Set` was refined in the 1970s. Every higher-level data structure — trees, graphs, queues, even other hash tables — is built on top of arrays and hash maps internally.

The JavaScript-specific quirks: arrays in V8 are not contiguous C arrays — they're packed/holey/dictionary based on what you store and the access pattern. Strings are immutable UTF-16 with internal *rope* optimization for long concats. Maps and Sets were added in ES2015 to replace the "use a plain object" hack; the new versions guarantee O(1) for any key type and insertion-order iteration.

### The deeper principle

**The three primitives correspond to the three ways data is addressed**: by *position* (array), by *content* (string slice, regex), and by *identity* (hash map key). Every more complex data structure picks one of these as its primary address and layers structure on top. Trees address by path-from-root (a sequence of indices). Graphs address by adjacency (a Map of node → list of neighbors). Tries address by character sequence (a chain of indexed children).

If you can't see which primitive a higher-level structure is built from, you don't understand it. A `Map<string, Array<X>>` adjacency list is a graph; a `Map<string, Node>` with `Node` having `.children: Node[]` is a tree. The primitives are the alphabet.

### Where it breaks down

- **`arr.includes(x)` for membership is O(N).** Every "is X in this collection?" query that walks an array is a hidden O(N²) waiting to happen when used inside a loop. The fix is a Set, but you have to *notice* the pattern.

- **String concat in a tight loop allocates each time.** `buf += chunk` is fine for the NDJSON reader (one allocation per network chunk, bounded). It's bad for `for (const c of huge) { result += c; }` — that's O(N²). The fix is an array of strings plus `.join('')` at the end.

- **Map keys are by identity for objects, by value for primitives.** `map.set({a:1}, "x"); map.get({a:1})` returns `undefined` — the second object literal is a different reference. Use a *serialized* form (like `JSON.stringify(args)` in the cache key) when you want value-equality semantics.

- **Set deduplicates by `===`-equivalent (SameValueZero), not by deep equality.** Two arrays with identical contents are different references, so Set treats them as distinct.

### What to explore next

- **WeakMap and WeakSet** — for keys you want garbage-collected automatically (e.g. attaching metadata to DOM nodes or fetched objects without leaking memory). Not used in this codebase but commonly needed in long-lived web apps.

- **TypedArrays (`Uint8Array`, `Int32Array`)** — for numeric arrays where you want guaranteed contiguous memory and no boxing. Used implicitly in this codebase via `reader.read()` returning `Uint8Array`.

- **LRU caches** — the next step up from a plain Map: bounded size with eviction. The TTL cache here doesn't bound its size; an LRU would. See the "TTL cache" case study's Elaborate block for the design.

---

## Interview defense

**What they are really asking.** Whether you can name what each primitive is good at and pick the right one for the access pattern. Senior: whether you know the cost surprises (O(1) average vs worst, string immutability, Map keys by identity vs value). Architect: whether you can explain why this codebase reaches for these primitives and nothing else.

---

**[mid] "Why use a `Set` for the queryTools dedup instead of a `.filter` over the array?"**

Because `Set` does dedup in O(N), while the natural array version is O(N²). The natural version is `arr.filter((x, i) => arr.indexOf(x) === i)` — `indexOf` is O(N), the filter does it N times. The Set version uses hash-based insertion: each `.add` is O(1), one pass over N elements is O(N). For 15 tool names the difference is invisible; the principle is what scales. Cite `lib/mcp/tools.ts` L38–L40.

```
  filter + indexOf:  O(N²)   ← natural-looking, quietly bad
  new Set(arr):      O(N)    ← one extra concept, asymptotically right
```

---

**[senior] "The TTL cache uses `JSON.stringify(args)` to build the key. What's the load-bearing assumption there, and what breaks it?"**

The assumption is *value-equality via serialization*. `Map.get` uses identity for objects (`===`), so `m.get({a:1})` after `m.set({a:1}, "x")` returns `undefined` — different references. Serializing to a string converts the comparison to string equality, which is content-based. The load-bearer is that `JSON.stringify` is *deterministic for the same input* — which it almost is, with one caveat: **object key order is not deterministic across all engines.** V8 preserves insertion order for string keys (and integer-string keys are reordered to numeric ascending), so two args objects with keys inserted in different order produce different cache keys. `{q:"react", limit:10}` and `{limit:10, q:"react"}` would produce different strings and therefore different cache entries — a known acceptable trade for simplicity. Cite `lib/mcp/client.ts` L102.

```
  args1 = {q:"react", limit:10}    → "{\"q\":\"react\",\"limit\":10}"
  args2 = {limit:10, q:"react"}    → "{\"limit\":10,\"q\":\"react\"}"
                                       │
                                  different strings → different cache slots
                                  same logical query → same live result
                                  fetched twice
```

The fix is to sort keys before stringifying; the codebase accepts the duplication because callers don't shuffle their argument order.

---

**[arch] "This codebase uses arrays, strings, and hash maps everywhere — what's the case for reaching for something more complex?"**

Three triggers. **Tree** when the data is genuinely hierarchical and you need to navigate parent/child relationships *recursively* — like a file system, a comment thread, or a DOM. A nested-object literal isn't a tree just because it's nested; it's a tree when the navigation algorithm is recursive. **Graph** when relationships are many-to-many — like "what calls what" in a tool dependency graph or "who follows whom" in a social graph. **Priority queue** when you need O(log N) extract-min/max — like a Dijkstra fringe, a job scheduler, or a top-K stream of incoming items. The codebase has none of these because: the schema isn't navigated recursively (it's read top-down once in `bootstrapSchema`); the tool relationships are flat (one-to-many from agent to tool); there's no scheduling that needs ordering by priority. Add any of those and the primitive-only approach starts costing you.

```
  trigger              today's codebase           what would change
  ──────────────────   ────────────────────────   ──────────────────────────
  hierarchical data    schema = nested object,    recommendation explanations
                       read top-down once         that branch on each other
  many-to-many edges   tools and agents flat      agent A wants tool from
                                                  agent B's set conditionally
  O(log N) order ops   no priority scheduling     job queue ordered by ETA
                                                  or anomaly severity stream
```

---

**The dodge: "do you ever pick an array even when Set would be 'better'?"**

Yes, when N is small and stable. `CATEGORIES` in `lib/agents/categories.ts` is an array of 10 entries because the *primary access pattern* is iteration (`.map`), not lookup. The order matters for the UI grid. Putting it in a Set or Map would lose the registry-order guarantee without buying anything — the lookups (which would be O(1) in a Map) don't happen; we always touch all 10. The principle: don't reach for hash-based structures when the access pattern is sequential.

---

**Anchors (cite these in your answer)**

- `lib/mcp/client.ts` L80, L102–L108 — Map with serialized key
- `lib/agents/categories.ts` L116–L127, L131–L136 — Set with three string-token shapes
- `lib/mcp/tools.ts` L38–L40 — Set-union spread for dedup
- `lib/hooks/useInvestigation.ts` L190–L192 — string buf + split/pop
- `lib/agents/monitoring.ts` L119 — array sort + slice composition
- `lib/insights/derive.ts` L58 — array filter for count derivation

---

## See also

→ `01-complexity-and-cost-models.md` (the cost framework these primitives are evaluated under) · → `06-sorting-searching-and-selection.md` (where Array.prototype.sort and substring scan live) · → `.aipe/study-dsa-foundations/02-arrays-strings-and-hash-maps.md` (the Map case study) · → `.aipe/study-dsa-foundations/02-arrays-strings-and-hash-maps.md` (the Set case study) · → `.aipe/study-dsa-foundations/02-arrays-strings-and-hash-maps.md` (the string-buffer case study)
