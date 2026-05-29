# Coverage gate

**Industry name(s):** capability/feature gating by set membership, schema-driven feature detection, requirement satisfaction check
**Type:** Industry standard · Language-agnostic

> Classify each item in a fixed registry as fully / partially / not supported by testing its declared dependencies for membership in a set of capabilities derived from the live schema.

**See also:** → ../01-system-design/08-schema-gated-coverage.md · → 05-severity-sort.md

---

## Why care

You keep a list of features, and each feature only works if the backend exposes certain fields. You hard-code which features to show. Then a workspace turns up that doesn't emit one of those fields, the feature renders anyway, calls the missing field, and returns garbage. The question is: given a list of required dependencies per feature and a set of what the backend actually provides, how do you decide — cheaply, for every feature at once — which features are fully supported, which are degraded, and which can't run at all?

That is what a coverage gate answers: build one `Set` of everything the schema exposes, then for each registry item run a membership test of its declared deps against that set.

**The stakes are concrete.** The monitoring agent has a checklist of 10 ecommerce anomaly categories. Each category needs specific events (`conversion_drop` needs `view_item`, `checkout`, `purchase`). A workspace that never emits `search` events can't run the `search_failure` category — querying for it wastes an EQL call against the ~1 req/s budget and produces a meaningless zero. The gate filters the checklist to the runnable categories *before* the agent spends a single call, and labels the rest honestly so the UI shows a ghost tile instead of faking a result.

One-line reduction: a coverage gate is `requires ⊆ available ?` evaluated per registry item, with a softer `enriches ⊆ available ?` deciding full-vs-degraded.

---

## How it works

### Mental model

Two halves. First, flatten the schema into a flat `Set<string>` of capability tokens — one membership-testable string per thing the workspace can do. Second, walk the registry; for each item, ask whether its hard deps are all in the set (if not → `unavailable`), then whether its soft deps are all in the set (if not → `limited`), else `full`. The set turns a nested schema into O(1) `has()` lookups; the per-item test is a couple of `every()` scans over tiny dep lists.

```
 schema (nested)                 capability set (flat)            registry item
 ───────────────                 ─────────────────────            ─────────────
 events:[                        {                                requires:[a,b]
   {name:a, props:[x]}    ──►      "a", "a.x",            ──►      enriches:[c]
   {name:b, props:[]}             "b",                                 │
 ]                                "catalog:k"                     requires ⊆ set?
 catalogs:[{name:k}]            }                                  ├ no  → unavailable
                                  │                                └ yes → enriches ⊆ set?
                              has(token) is O(1)                          ├ no  → limited
                                                                         └ yes → full
```

The set is built once per briefing; the membership tests are pure functions of it. Nothing here touches the network — it is a classification over data already in hand.

---

### Building the capability set

`schemaCapabilities` flattens three kinds of thing into one set of strings: an event name (`"purchase"`), an event property (`"session_start.utm_source"`), and a catalog (`"catalog:inventory_level"`). The string *shape* is the contract: a dependency declares itself in exactly one of these three forms, so a single `set.has(dep)` answers it.

```
for each event e:
    set.add(e.name)                      "purchase"
    for each property p of e:
        set.add(e.name + "." + p)        "session_start.utm_source"
for each catalog c:
    set.add("catalog:" + c.name)         "catalog:inventory_level"
```

One pass over the schema, O(events + properties + catalogs). The output is a `Set<string>` whose only job is fast membership.

---

### The per-item test

`coverageFor` is the whole gate in three lines. `requires` are hard deps — miss any and the item is `unavailable`. `enriches` are soft deps — present-but-incomplete only downgrades to `limited`. Everything present → `full`.

```
coverageFor(cat, available):
    has = dep => available.has(dep)

    if NOT cat.requires.every(has):                  → 'unavailable'
    if cat.enriches?.length AND NOT enriches.every(has): → 'limited'
    else:                                            → 'full'
```

The order matters: the hard-dep check short-circuits first, so a category missing a required event is never even considered for `limited`. `every` is itself short-circuiting — it stops at the first absent dep.

```
 conversion_drop  requires [view_item, checkout, purchase]   enriches —
   view_item ✓  checkout ✓  purchase ✓   → requires all present, no enriches → full

 campaign_perf    requires [session_start]   enriches [session_start.utm_source]
   session_start ✓ → requires ok; utm_source ✗ → enriches incomplete → limited

 search_failure   requires [search]   enriches —
   search ✗ → requires.every short-circuits false → unavailable
```

---

### Mapping the registry

`coverageReport` maps `coverageFor` (plus `missingFor`, which collects the absent deps for the ghost-tile copy) over all 10 `CATEGORIES`, preserving registry order so the UI grid is stable. `runnableCategories` is the same walk filtered to `!== 'unavailable'` — the list handed to the monitoring agent so it only queries what the data supports.

```
CATEGORIES (10, fixed order)
      │  map
      ▼
 coverageReport → [ {category, label, coverage, missing?}, … ]   (all 10, for the grid)
      │  filter coverage !== 'unavailable'
      ▼
 runnableCategories → [ AnomalyCategory, … ]                      (subset, for the agent)
```

Two consumers, one classification: the report drives the UI (every tile, including ghosts), the runnable subset bounds the agent's work.

---

### Step-by-step execution trace

Scenario: the wobbly-ukulele workspace emits `view_item, cart_update, checkout, session_start, purchase` (events only — no `utm_source` property, no inventory catalog, no `search` / `return` / `payment_failure`).

Capability set after `schemaCapabilities`:
```
{ "view_item", "view_item.<props…>", "cart_update", "cart_update.<props…>",
  "checkout", "session_start", "purchase", … }      (event names + their props)
note: NO "session_start.utm_source", NO "catalog:inventory_level",
      NO "search", NO "return", NO "payment_failure"
```

Walking `CATEGORIES` in order:
```
# │ category          │ requires (all in set?)        │ enriches (all in set?)        │ result
──┼───────────────────┼───────────────────────────────┼───────────────────────────────┼─────────────
1 │ conversion_drop   │ view_item,checkout,purchase ✓ │ —                             │ full
2 │ cart_abandonment  │ cart_update,checkout,purch. ✓ │ —                             │ full
3 │ product_demand    │ purchase ✓                    │ —                             │ full
4 │ revenue_drop      │ purchase ✓                    │ —                             │ full
5 │ customer_churn    │ purchase,session_start ✓      │ —                             │ full
6 │ inventory         │ purchase ✓                    │ catalog:inventory_level ✗     │ limited (missing catalog)
7 │ campaign_perf     │ session_start ✓               │ session_start.utm_source ✗    │ limited (missing utm)
8 │ search_failure    │ search ✗ → short-circuit      │ (not reached)                 │ unavailable (needs search)
9 │ return_spike      │ return ✗                      │ (not reached)                 │ unavailable (needs return)
10│ fraud             │ payment_failure ✗             │ (not reached)                 │ unavailable (needs payment_failure)
```

`coverageReport` → 10 items: 5 full, 2 limited, 3 unavailable.
`runnableCategories` → the 7 non-`unavailable` → handed to `MonitoringAgent.scan(hooks, runnable)`.

The principle: derive a flat capability set once, then every "can this run?" question is a short-circuiting membership test — no rerun of the schema, no network, no fabricated result for missing data.

---

## Coverage gate — diagram

Primary recap: schema → set → per-item classification → two consumers.

```
WorkspaceSchema { events:[{name,properties}], catalogs:[{name}] }
        │
        ▼  schemaCapabilities  (one pass, O(events+props+catalogs))
┌──────────────────────────────────────────────────────────────┐
│  Set<string>                                                   │
│   event names            "purchase", "session_start", …        │
│   event.property         "session_start.utm_source"            │
│   catalog:<name>         "catalog:inventory_level"             │
└──────────────────────────────────────────────────────────────┘
        │
        ▼  coverageFor(cat, set)  for each cat in CATEGORIES[10]
   ┌──────────────────────────────────────────────┐
   │  requires.every(has) ?                        │
   │     no ──────────────────────►  unavailable   │
   │     yes                                        │
   │       │                                        │
   │  enriches?.every(has) ?                        │
   │     no  ─────────────────────►  limited        │
   │     yes ─────────────────────►  full           │
   └──────────────────────────────────────────────┘
        │
        ├── coverageReport → CoverageItem[10]  (all tiles, incl. ghosts) ──► CoverageGrid
        └── runnableCategories → AnomalyCategory[]  (full+limited only) ───► MonitoringAgent.scan
```

The set is the pivot: it collapses a nested, variable schema into a flat structure whose only operation is the one the gate needs — `has`.

---

## In this codebase

**File:** `lib/agents/categories.ts`
**Function / class:** `schemaCapabilities`, `coverageFor`, `missingFor`, `coverageReport`, `runnableCategories` (over the `CATEGORIES` registry / `AnomalyCategory` interface)
**Line range:** L7–L15 (`AnomalyCategory`), L19–L112 (`CATEGORIES`), L116–L127 (`schemaCapabilities`), L131–L136 (`coverageFor`), L139–L141 (`missingFor`), L144–L155 (`coverageReport`), L158–L160 (`runnableCategories`)

The registry item shape (L7–L15) — `requires` are hard deps, `enriches` are soft:

```ts
export interface AnomalyCategory {
  id: CategoryId;
  label: string;
  requires: string[];   // hard deps (event names) — missing any → unavailable
  enriches?: string[];  // soft deps (event.property / catalog:<name>) — missing → limited
  whyItMatters: string;
  eql: (projectId: string) => string;
  thresholds: { critical: number; warning: number };
}
```

Building the capability set (L116–L127):

```ts
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

The gate (L131–L136) and the registry walk (L144–L155):

```ts
export function coverageFor(cat, available): CategoryCoverage {
  const has = (dep: string) => available.has(dep);
  if (!cat.requires.every(has)) return 'unavailable';
  if (cat.enriches && cat.enriches.length > 0 && !cat.enriches.every(has)) return 'limited';
  return 'full';
}

export function coverageReport(available): CoverageReport {
  return CATEGORIES.map((cat) => {
    const coverage = coverageFor(cat, available);
    const missing = missingFor(cat, available);
    return { category: cat.id, label: cat.label, coverage,
             ...(coverage !== 'full' && missing.length ? { missing } : {}) };
  });
}
```

Consumed in `app/api/briefing/route.ts` L202–L204 (`schemaCapabilities` → `coverageReport` → `runnableCategories`), then `runnable` is passed to `agent.scan(...)` at L223. Verified against the unit test in `test/agents/categories.test.ts`.

GitHub: https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/categories.ts#L116-L160

---

## Elaborate

### Where it comes from

This is feature detection — the same shape as `if ('IntersectionObserver' in window)` before using it, or `caniuse`-driven progressive enhancement. The browser doesn't guarantee an API exists, so you test for it and degrade. Here the "browser" is a Bloomreach workspace and the "API" is an event/property/catalog; the test is set membership instead of an `in` check, and the degradation is three-valued (full / limited / unavailable) instead of boolean.

It is also requirement satisfaction: a package manager resolving whether a dependency's constraints are met by what's installed does the same `required ⊆ available` test, just over version ranges instead of string tokens.

### The deeper principle

Normalize the haystack once, then make every needle O(1). The schema arrives nested and heterogeneous (events have properties, catalogs are separate). Rather than re-traverse it per category — which would be O(categories × events × properties) — you pay one O(schema) pass to flatten it into a set, and every subsequent question is `has()`.

```
 naive:  for each category: for each dep: search the nested schema   → O(C · D · schema)
 gate:   flatten once → Set;  for each category: dep in Set          → O(schema) + O(C · D)
```

The two-tier dependency split (`requires` vs `enriches`) is the second idea: not every missing thing is fatal. Hard deps gate existence; soft deps gate quality. That maps cleanly to a three-valued result, which maps cleanly to three UI states.

### Where it breaks down

**String-token coupling.** A dep is matched by exact string. If the schema names an event `purchases` but a category declares `requires: ['purchase']`, the gate silently reports `unavailable` — a typo reads as missing data. There is no fuzzy match or alias table.

**Presence ≠ populated.** Membership proves the workspace *declares* an event, not that it has *data* in the window. `coverageFor` says "runnable"; the monitoring agent's own volume check (does the last 90 days actually contain events?) is a separate, later guard. The gate prevents querying impossible categories, not empty ones.

**Flat properties only.** `schemaCapabilities` flattens one level (`event.property`). A dep on a nested property path (`event.cart.items[].sku`) has no token, so it can't be expressed as an `enriches` entry without extending the flattening.

### What to explore next

- **Alias / normalization layer** — lower-case and alias event names before adding to the set, so `Purchase` / `purchase` / `purchases` resolve together; trades exactness for resilience to schema naming drift.
- **Weighted coverage** — instead of three buckets, score each category `met/total` deps and rank; lets the UI sort "almost runnable" categories first.
- **Reverse index** — map each capability token → the categories that need it, to answer "what unlocks if this workspace adds `search`?" in O(1) for an onboarding nudge.

---

## Tradeoffs

| Dimension | Flatten-to-Set gate (this) | Re-traverse schema per dep | Hard-coded category list |
|---|---|---|---|
| Set build | O(events + props + catalogs), once | none | none |
| Per-category test | O(deps) `has()` lookups | O(deps × schema) nested search | O(1) — but wrong when schema varies |
| Total for 10 categories | O(schema) + O(Σ deps) | O(10 × deps × schema) | O(1) |
| Correctness across workspaces | adapts to live schema | adapts (slower) | breaks on any workspace missing a field |
| Three-valued output | yes (full/limited/unavailable) | possible | no |
| Memory | O(capability tokens) | O(1) | O(1) |
| Coupling | exact string tokens | exact string tokens | none (but unsafe) |

**What was given up.** The set costs memory proportional to the schema's surface (every event + every property + every catalog becomes a string). For a workspace with hundreds of properties that's a few hundred short strings — negligible here, but it is not free, and it is rebuilt every briefing rather than cached.

**Alternative cost.** Re-traversing the nested schema for each dependency avoids the set allocation but multiplies the per-category cost by the schema size, and you write the nested-search logic by hand for three shapes (event, event.property, catalog) instead of one `has()`. A hard-coded category list is O(1) and zero-allocation but is simply incorrect the moment a workspace's schema differs from the one you coded against — which is the entire reason the gate exists.

**Breakpoint.** Flatten-to-Set is right while the registry and schema are small and the classification runs per request. It needs a reverse index or caching when either the registry grows large (hundreds of categories) or the same schema is gated repeatedly within one request, at which point rebuilding the set each time becomes the waste the gate was meant to avoid.

---

## Tech reference (industry pairing)

### JavaScript Set (membership store)

- **Role:** the flattened capability store; O(1) average `has`/`add`; the single structure the whole gate tests against.
- **Leader:** native `Set` — no dependency, exact-match membership, used directly in `schemaCapabilities`.
- **Runner-up:** a plain object used as a map (`{[token]: true}`) — works, but `Set` states the intent (membership, not key→value) and has cleaner `has`.
- **Key API surface:** `set.add(token)`, `set.has(token)`, spread `[...set]`.
- **What it does not do:** no fuzzy / prefix matching, no aliasing — exact string equality only; the dependency tokens must match the schema's naming exactly.

### Array.prototype.every (the gate predicate)

- **Role:** the all-deps-present test; short-circuits on the first absent dep, which makes `requires.every(has)` the hard gate.
- **Leader:** native `every` — built-in, short-circuiting, reads as the spec ("every required dep is available").
- **Runner-up:** `requires.filter(d => !has(d)).length === 0` — equivalent result but builds an intermediate array and does not short-circuit; `missingFor` uses exactly this `filter` form precisely *because* it wants the full list of absentees, not a boolean.
- **Contrast:** `every` answers "are all present?" (boolean, short-circuit); `filter` answers "which are absent?" (list, full scan) — the gate uses the first, the ghost-tile copy uses the second.

### feature detection / capability gating (the pattern)

- **Role:** decide at runtime what a variable backend supports rather than assuming; degrade instead of erroring.
- **Leader:** runtime feature detection (`'IntersectionObserver' in window`, `caniuse`-driven progressive enhancement) — the front-end form of the same idea.
- **Runner-up:** dependency/constraint resolution (a package manager checking `required ⊆ installed`) — the same `subset?` test over version ranges.
- **Industry use:** GraphQL introspection gating UI to the fields a schema actually exposes is structurally identical — flatten the schema's capabilities, test each feature's needs against it.

---

## Summary

`lib/agents/categories.ts` gates a fixed 10-category registry against a live workspace schema. `schemaCapabilities` flattens the schema once into a `Set<string>` of event names, `event.property` tokens, and `catalog:<name>` tokens. `coverageFor` then classifies each category by membership: missing any hard `requires` dep → `unavailable`; hard deps present but a soft `enriches` dep missing → `limited`; all present → `full`. `coverageReport` maps this (plus `missingFor`, the absent-deps list) over all 10 categories in registry order for the UI grid, and `runnableCategories` filters to the non-`unavailable` subset handed to the monitoring agent. The classification is pure, network-free, and short-circuiting.

- Flatten once, test many: one O(schema) pass turns nested schema into O(1) `has()` lookups.
- Two-tier deps map to three states: `requires` gate existence (unavailable), `enriches` gate quality (limited).
- `every` short-circuits and gives the boolean gate; `filter` (in `missingFor`) gives the absent-deps list for ghost-tile copy.
- Registry order is preserved so the grid is stable across briefings.
- Membership proves a field is *declared*, not *populated* — the agent's volume check is a separate later guard.
- Matching is exact-string: a naming mismatch reads as missing data, with no aliasing.

---

## Interview defense

**What they are really asking.** Whether you reach for a set to turn a repeated nested lookup into O(1), whether you understand why the dependency split is two-tier, and whether you know the gap between "declared" and "populated."

---

**[mid] Why build a `Set` first instead of searching the schema for each dependency?**

Because the dependency test runs many times (10 categories × a few deps each) against the same schema. Searching the nested schema per dep is O(deps × schema); flattening once is O(schema) then O(1) per dep. The set also unifies three shapes — event, `event.property`, `catalog:name` — into one `has()` call, so the gate doesn't branch on dep kind.

```
 per-dep nested search:  O(C·D·schema)
 flatten → Set:          O(schema) + O(C·D),  each has() = O(1)
```

---

**[senior] Why `requires` vs `enriches` — why not one flat list of dependencies?**

Because not all missing data is equally fatal, and the UI needs three states, not two. A category whose required event is absent literally cannot run (`unavailable` → ghost tile). A category that can run but is missing an enriching property/catalog runs with reduced confidence (`limited` → amber tile, still monitored). Collapsing them to one list loses the "degraded but useful" middle, which is exactly the case worth surfacing — `campaign_perf` still counts sessions without `utm_source`, it just can't attribute the channel.

```
 requires ⊄ available  → unavailable   (can't run at all → ghost)
 requires ⊆, enriches ⊄ → limited       (runs, reduced quality → amber)
 requires ⊆, enriches ⊆ → full          (runs fully → clear/firing)
```

---

**[arch] The gate says a category is runnable, the agent queries it, and it returns zero. Did the gate fail?**

No — it answered a different question. Membership proves the workspace *declares* the event, which is all the gate can know statically. Whether the *window* contains data is a runtime fact the gate has no access to. That's why the monitoring prompt runs its own volume check first and bails on empty windows. The two guards compose: the gate prevents querying *impossible* categories (no `search` event ever), the volume check prevents reporting on *empty* ones (no purchases in the last 90 days). Conflating them would push runtime data-presence into a static schema test, which can't see it.

```
 gate (static):    requires ⊆ schema?      → don't even query the impossible
 volume (runtime): count(event, window)>0? → don't report on the empty
```

---

**The dodge: "what happens if the schema names an event slightly differently than the registry expects?"**

The category reads as `unavailable`. Matching is exact string equality — `requires: ['purchase']` against a schema event named `purchases` finds no member, so `requires.every(has)` is false. A typo or naming drift is indistinguishable from genuinely-missing data. The mitigation is a normalization/alias layer (lower-case, alias table) applied both when building the set and when declaring deps; the current code accepts the exactness as a simplicity trade-off because the registry and the workspace schema are both controlled.

---

**Anchors (cite these in your answer)**

- `lib/agents/categories.ts` L116–L127: flatten the schema into the capability `Set`.
- `lib/agents/categories.ts` L131–L136: the three-valued `coverageFor` gate (requires → enriches → full).
- `lib/agents/categories.ts` L139–L141: `missingFor` uses `filter` (list of absentees) vs the gate's `every` (boolean).
- `lib/agents/categories.ts` L144–L160: `coverageReport` (all 10, registry order) and `runnableCategories` (the agent's subset).
- `app/api/briefing/route.ts` L202–L204, L223: where the gate runs and feeds `scan`.

---

## Validate your understanding

### Level 1 — Reconstruct

Without looking, write `coverageFor` from scratch: the `has` closure, the `requires.every` hard gate, the `enriches.every` soft gate, the `full` fallthrough — in that order. Then write `schemaCapabilities`: the three `add` forms (name, `name.prop`, `catalog:name`). Compare to `lib/agents/categories.ts` L116–L136. Operator and order should match (hard gate before soft gate).

### Level 2 — Explain

Walk a workspace that emits `purchase` and `session_start` (events only, no properties, no catalogs) through all 10 categories. For each, state `requires`, whether every required token is in the set, `enriches` (if any) and whether it's satisfied, and the resulting `CategoryCoverage`. Then state what `runnableCategories` returns. Cite `lib/agents/categories.ts` L131–L136 for the gate and L158–L160 for the filter.

### Level 3 — Apply

**Scenario:** A workspace emits `view_item`, `checkout`, `purchase`, and `session_start` *with* a `utm_source` property, and has a catalog named `inventory_level`. Run `inventory` (requires `purchase`, enriches `catalog:inventory_level`) and `campaign_perf` (requires `session_start`, enriches `session_start.utm_source`) through `coverageFor`. What does each return now, and how does that differ from the wobbly-ukulele trace in this file? What does `missingFor` return for each? Check your answer against `lib/agents/categories.ts` L131–L141 and the `CATEGORIES` entries at L65–L84.

### Level 4 — Defend

Your teammate says: "Drop `enriches` — just have `requires`, and a category is either runnable or not. Two states is simpler." Counter-argue or agree. Consider: what `campaign_perf` and `inventory` lose, how many UI states the grid needs, and whether 'limited' is information a user acts on. Reference the `[senior]` answer above.

### Quick check

- What three string shapes does `schemaCapabilities` add to the set? `lib/agents/categories.ts` L121–L125.
- Why does `coverageFor` test `requires` before `enriches`?
- Which function uses `every` and which uses `filter`, and why the difference?
- Does a `full` classification guarantee the category will fire an anomaly? Why or why not?
- What does `runnableCategories` exclude, and which consumer receives its output?
