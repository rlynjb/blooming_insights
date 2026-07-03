# Arrays, strings, and hash maps

*Indexed sequences · hash tables · sets · Industry standard*

## Zoom out, then zoom in

If you cut this codebase in half and looked at what's in it, you'd find arrays and hash maps. Everything else is a decoration. The picture below shows every place a hash map (`Map` or `Set`) or an array-based operation is the load-bearing primitive.

```
  Zoom out — where arrays / maps / sets live in blooming_insights

  ┌─ UI layer ───────────────────────────────────────────────────┐
  │  NDJSON reader: one string.split('\n'), one line per event   │
  │  → array of parsed events, iterated once                     │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Agent / route layer ───▼────────────────────────────────────┐
  │  ★ THIS CONCEPT LIVES HERE ★                                 │
  │  · tool-schemas.ts: allowedTools = new Set<string>()         │
  │  · categories-legacy.ts: new Set<string>() for dedup         │
  │  · flatMap over response.content blocks                      │
  │  · fault-injecting.ts: rate-check array walk                 │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Eval layer ────────────▼────────────────────────────────────┐
  │  · report.eval.ts: new Set<runId>() to dedup receipts        │
  │  · gate.eval.ts:  new Set(dims) for score-dimension check    │
  │  · load.eval.ts:  Array<Investigation> as accumulator        │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ Config / transport ────▼────────────────────────────────────┐
  │  · config.ts: base64 round-trip on JSON string               │
  │  · config.ts: isMcpConfigOverride — 3-field schema walk      │
  │  · test/mcp/config.test.ts: Record<string,string> DOM shim   │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** Three primitives, one after the other. Arrays are contiguous, index-addressable, ordered — `arr[i]` in O(1), any scan in O(n). Strings are arrays of characters (or code units, in JS's UTF-16 case) with a `.split()` and `.slice()` API. Hash maps (JS `Map`, `Set`, plain objects) are O(1) average lookup by key — the primitive behind every "have I seen this?" question in the codebase.

## Structure pass

**Layers.** Two altitudes:
  1. the *shape* of the container (array, set, map, string)
  2. the *operation* performed on it (lookup, scan, dedupe, transform)

**Axis: what's the cost of "does this contain X?"** Trace it down:
  - array (unsorted) → O(n) linear scan
  - array (sorted) → O(log n) binary search *(not exercised in this repo)*
  - hash set → O(1) average
  - string → `.includes()` is O(n × m) — Boyer-Moore or KMP inside V8

**Seams.** The load-bearing seam is between *lookup by key* (hash map) and *iteration over items* (array). Every "is this in the allowed list?" check in the agent code is a set lookup; every "process each received event" is an array scan. Get the container right and the operation costs collapse.

## How it works

### Move 1 — arrays are contiguous slots; hash maps are computed slots

You already know arrays: `[a, b, c]`, indexed by position. A hash map is the same idea but with the index *computed* from the key. You call `map.get("foo")`, the runtime hashes `"foo"` to an integer, and that integer picks the slot. Same O(1) access shape as an array — just addressed by content instead of position.

```
  Array vs hash map — how the slot gets chosen

  ARRAY:  arr[3]           →  slot 3
                              (position is the address)

  MAP:    map.get("foo")   →  hash("foo") = 8391
                           →  8391 mod capacity = slot 47
                              (content is the address)
```

Collisions happen when two keys hash to the same slot. JS `Map` handles this with chaining (linked list per slot) — search inside a slot is O(1) amortized because the load factor is bounded. This is why hash-map lookup is *average* O(1), not worst-case: an adversarial input could pile every key into one slot.

### Move 2 — the set-based dedup / membership primitive

Every "have I seen this?" question in the repo uses a `Set`. Not an array with `.includes()`, not an object with property lookup — a `Set`, because it's the primitive that says "I only care about presence."

```
  Set membership — the "is X in the collection?" primitive

  operation:      check          expected time
  ────────────────────────────────────────────
  set.has(x)      → true/false   O(1) average
  set.add(x)      → mutation     O(1) amortized
  set.delete(x)   → mutation     O(1) average

  vs array.includes(x)           O(n) linear scan
```

The canonical use in this repo — enum-membership validation:

```ts
// lib/mcp/config.ts:41-45 — the set as an enum membership check
const VALID_AUTH_TYPES = new Set<McpAuthType>([
  'oauth-bloomreach',
  'bearer',
  'anonymous',
]);
// later, inside isMcpConfigOverride:
if (!VALID_AUTH_TYPES.has(v.authType as McpAuthType)) return false;
```

Three elements — an array with `.includes()` would be fine here. The signal is the *shape of the code*: the set says "membership is the question I'm asking." When the enum grows to 30 auth types, the shape doesn't change; only the constant does.

The same primitive shows up for allowed-tool filtering:

```ts
// lib/agents/tool-schemas.ts:13 — set as an allowlist
const set = new Set(allowed);
// then: allowedTools.has(toolName)
```

And for dedup of runIds across receipts:

```ts
// eval/report.eval.ts:204 — set to collapse duplicates
const runIds = new Set<string>();
for (const f of files) {
  const m = f.match(/-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z)\.json$/);
  if (m) runIds.add(m[1]);
}
```

One line per unique runId, no matter how many files match. The set collapses N array entries into K unique keys in a single pass — O(N) time, O(K) space. The equivalent using an array + `.includes()` would be O(N²) — every add checks every previous entry.

### Move 2 — the structural type-guard as O(k) schema walk

This is where hash-map thinking meets TypeScript's `unknown` boundary. `isMcpConfigOverride` walks a small object schema — check each field's type, look up enum members in a set — and returns a boolean:

```ts
// lib/mcp/config.ts:50-60 — O(field count) type guard
export function isMcpConfigOverride(value: unknown): value is McpConfigOverride {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;                    // ← treat as hash map
  if (v.url !== undefined && typeof v.url !== 'string') return false;
  if (v.authType !== undefined) {
    if (typeof v.authType !== 'string') return false;
    if (!VALID_AUTH_TYPES.has(v.authType as McpAuthType)) return false;  // ← O(1) set check
  }
  if (v.bearerToken !== undefined && typeof v.bearerToken !== 'string') return false;
  return true;
}
```

The type guard is O(3) — one check per known field. The `Record<string, unknown>` cast is the vocabulary move: "for the purposes of validation, this unknown is a hash map from string to unknown, and I'm going to look up specific keys." That's textbook structural typing at the runtime seam.

```
  Type guard as hash-map walk — three lookups, one set check

  input: unknown
     │
     ▼
  is it an object? ──── no ───► false
     │ yes
     ▼
  v.url        : string | undefined?    ← O(1) property lookup
     │ ok
     ▼
  v.authType   : one of 3 valid enums?  ← O(1) set.has()
     │ ok
     ▼
  v.bearerToken: string | undefined?    ← O(1) property lookup
     │ ok
     ▼
  return true
```

The pattern generalizes: any "parse this JSON off the wire" boundary in a typed language looks like this. Zod, io-ts, ajv — all built on the same shape at scale. The hand-rolled version here is fine because the schema is three fields.

### Move 2 — the base64 round-trip on the string primitive

Strings are arrays of code units. Base64 is a fixed 4:3 expansion — three input bytes become four ASCII output characters, per a 64-symbol lookup table. O(n) time, O(n) space, no algorithm cleverness.

```
  Base64 — a table lookup encoded as a bit shift

  input bytes:   [11010101]  [10101100]  [11100011]     ← 3 bytes = 24 bits
                     │            │            │
                     └────────────┴────────────┘
                                  │
              take 6 bits at a time (24 / 6 = 4 outputs)
                                  │
                                  ▼
                   [110101] [011010] [110011] [100011]  ← 4 × 6-bit indices
                       │        │        │        │
                       ▼        ▼        ▼        ▼
                       '1'      'a'      'z'      'j'    ← table lookup
```

The interesting part in this codebase isn't the algorithm — it's the *runtime detection* wrapper:

```ts
// lib/mcp/config.ts:77-82 — one function, two runtimes
export function encodeConfigHeader(config: McpConfigOverride): string {
  const json = JSON.stringify(normalizeConfig(config));
  // btoa is available in browsers; Node has Buffer. Runtime detection.
  if (typeof btoa === 'function') return btoa(json);
  return Buffer.from(json, 'utf8').toString('base64');
}
```

Same output, two APIs, one function. The DSA insight: base64 has a ~33% size overhead (4 bytes out per 3 in). Cookies feel large because of this — a 3KB payload becomes ~4KB on the wire.

### Move 2 — the localStorage shim as hash-map-with-a-contract

The test-side simulation of DOM `localStorage` is a plain JavaScript object with three methods stapled on. It exists because vitest runs in Node, where `localStorage` doesn't exist:

```ts
// test/mcp/config.test.ts:127-144 — hash map wearing a DOM interface
let store: Record<string, string> = {};

(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { store = {}; },
  key: () => null,
  length: 0,
};
```

This is the Case-A hash-map application: not "look things up by key" as a raw primitive, but "conform to an interface the code under test expects, with a hash-map underneath." The `in` operator is O(1) property presence; the assignment is O(1). Behavior matches the DOM version *for the API surface the code exercises*. Anything more elaborate (a proper `Storage` implementation with quota checks, event dispatching, per-origin partitioning) would be over-engineering for a unit test.

```
  In-memory KV shim — hash map wearing a DOM contract

  ┌─ Code under test ────────────────────┐
  │  readPersistedConfig()               │
  │  → localStorage.getItem(BI_MCP_KEY)  │  ← expects DOM Storage
  └───────────────────┬──────────────────┘
                      │
  ┌─ Test seam ───────▼──────────────────┐
  │  globalThis.localStorage = {         │
  │    getItem: (k) => store[k] ?? null, │
  │    setItem: (k, v) => store[k] = v,  │
  │    removeItem: (k) => delete store[k]│
  │  }                                   │
  └───────────────────┬──────────────────┘
                      │
  ┌─ Underneath ──────▼──────────────────┐
  │  Record<string, string> = {}         │  ← the hash map
  │  O(1) get / set / delete             │
  └──────────────────────────────────────┘
```

### Move 3 — the principle

**Reach for the hash map when the question is "presence."** Reach for the array when the question is "iteration." Almost every "I need a data structure here" moment in an application codebase is one of these two — the exotic structures earn their keep only when you have a specific access pattern that neither of them serves. In this repo, both primitives cover everything.

## Primary diagram

The whole surface: three uses of hash-map thinking (set membership, structural schema walk, KV shim) and one use of an array-based transform (base64).

```
  Arrays / strings / hash maps in blooming_insights — the whole surface

  ┌─ HASH-MAP AS SET (membership) ─────────────────────────────┐
  │                                                             │
  │  VALID_AUTH_TYPES.has(v.authType)     ← config.ts:56        │
  │  allowedTools.has(toolName)           ← tool-schemas.ts:13  │
  │  runIds.add(m[1])                     ← report.eval.ts:206  │
  │                                                             │
  │  → all O(1) average per op                                  │
  └─────────────────────────────────────────────────────────────┘

  ┌─ HASH-MAP AS SCHEMA (type guard) ──────────────────────────┐
  │                                                             │
  │  isMcpConfigOverride(v)               ← config.ts:50-60    │
  │  Record<string, unknown> cast + 3 lookups + 1 set.has()     │
  │                                                             │
  │  → O(field count) = O(3)                                    │
  └─────────────────────────────────────────────────────────────┘

  ┌─ HASH-MAP AS TEST SHIM (interface conformance) ────────────┐
  │                                                             │
  │  Record<string, string> + { getItem, setItem, remove }      │
  │                                       ← config.test.ts:127  │
  │                                                             │
  │  → O(1) per DOM Storage op                                  │
  └─────────────────────────────────────────────────────────────┘

  ┌─ ARRAY / STRING (transform) ───────────────────────────────┐
  │                                                             │
  │  btoa(json) / Buffer.from(json).toString('base64')          │
  │                                       ← config.ts:77-82     │
  │                                                             │
  │  → O(n) in string length                                    │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

Hash tables were introduced by H. P. Luhn (IBM, 1953) with linear probing. The chaining variant (linked list per bucket) followed shortly after. The average-case O(1) guarantee needs a good hash function and a bounded load factor — production JS `Map` handles both, but a naive `Object` used as a map hits pathological cases (the "hash-collision DoS" bug that hit Node, Ruby, and PHP around 2011-2012 was exactly this).

TypeScript's structural typing has a specific shape at the runtime boundary: the compiler can't check that data off the wire actually has the type it's declared as, so you need a user-defined type guard (a function returning `value is T`) to promote `unknown` to the typed shape. This is the pattern `isMcpConfigOverride` implements. Libraries like Zod (`z.object(...).parse(x)`) automate the same pattern at scale, but the hand-rolled version is fine when the schema is small and there's exactly one caller.

Base64 predates the web — MIME (RFC 2045, 1996) standardized it for email attachments. The `data:` URL scheme, JWTs, and any binary-in-JSON channel use it. The 33% overhead is fundamental to any encoding that squeezes 8-bit bytes into 6-bit ASCII (2^6 = 64 safe characters).

Related reading: CLRS chapter 11 (hash tables), Sedgewick's "Algorithms" section 3.4 (hash tables, open addressing vs chaining). For string algorithms in general, Gusfield's "Algorithms on Strings, Trees, and Sequences" is the deeper text — mostly relevant when you need suffix arrays or Aho-Corasick, neither of which shows up here.

## Interview defense

**Q: This codebase uses `Set` a lot. When would you *not* reach for a `Set`?**

Three cases. First, when the collection is tiny and static — a set of 3 auth types could be an array with `.includes()` and no one would notice. The set signals intent ("membership is the question") more than it wins performance. Second, when you need ordering or iteration in insertion order without the set's guarantees — JS `Set` does preserve insertion order, but if you want indexed access (`arr[3]`), it's not the right shape. Third, when you need multiplicity — a `Set` collapses duplicates; `Array` or `Map<T, count>` keeps them.

```
  When Set vs Array vs Map

  Set     → "is X in the collection?" — presence only
  Array   → "process each item" — iteration, indexed access
  Map     → "look up value by key" — key/value pairs
```

**Anchor:** "Set is for membership; Array is for iteration; Map is for key-value. Wrong container = wrong access-cost."

**Q: The `isMcpConfigOverride` type guard is hand-rolled. When would you swap for Zod?**

When the schema grows past what a human can eyeball in one screen, or when errors need to be structured (Zod gives you an error tree pointing at which field failed and why). Three fields, one call site — hand-rolled is fine. Ten fields with nested objects and unions — Zod pays for itself in the error UX alone.

```
  Type guard scale — where to swap

  1-5 fields, 1 call site       → hand-rolled type guard  ← current
  5-15 fields, few call sites   → could go either way
  nested / union types          → Zod (or ajv, io-ts)     ← future
  spec-driven schemas           → Zod + JSON Schema export
```

**Anchor:** "Hand-rolled scales to about a dozen fields; past that, structured errors from Zod earn their keep."

**Q: What breaks if you replace `Set` with plain `Object` in `VALID_AUTH_TYPES`?**

The `has` check becomes `'authType' in obj`, which is O(1) but has the prototype-chain gotcha — `'toString' in {}` is `true`. You'd need `Object.hasOwn(obj, key)` to be safe. Plus the hash-collision DoS surface: a big attacker-controlled key set colliding to the same bucket used to hang V8 (`Map` has non-adversarial hash paths that mitigate this). For three static enum values it's a wash. For a big user-input-driven set it matters. The set is the honest primitive.

**Anchor:** "`Set` avoids the prototype-chain trap and the hash-DoS surface — small readability + defensiveness win."

## See also

  → `01-complexity-and-cost-models.md` — where the O(1) claims here get their cost-model vocabulary
  → `03-stacks-queues-deques-and-heaps.md` — the ordered-container family; sets and arrays live one level down
  → `06-sorting-searching-and-selection.md` — where "sorted array" enters the picture (and doesn't in this repo)
  → `study-testing` — the localStorage shim as a test-seam story
