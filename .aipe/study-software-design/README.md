# Software design — this repo, through the AOSD lens

Applied audit of **blooming_insights** through John Ousterhout's
*A Philosophy of Software Design* (AOSD). Deep modules, information
hiding, complexity, layering, readability — grounded in real files,
line ranges, and named fixes.

The book supplies the ideas. Every claim below cites your code.

## The through-line

**Complexity is the enemy. Deep modules are the weapon.**
A deep module is one where a small interface hides a large body of
work: `DataSource` is 71 LOC of interface hiding ~740 LOC of adapter
work (Bloomreach + Synthetic + FaultInjecting). Shallow modules —
where the interface is nearly as complex as the body — accumulate.
The nine `*-legacy.ts` files under `lib/agents/` are the biggest
shallowness surface in this repo today.

Every module you write in this codebase should be pushed toward
depth: hide more, expose less. Every leaked decision (a fact that
must be edited in two places to stay consistent) should be pulled
into one owner.

## Reading order

1. `audit.md` — the 8-lens walk. **Read first.** Names every finding
   with `file:line`; cross-links to the pattern files where the deep
   walk lives.
2. `01-datasource-port.md` — deep module: the port / adapter seam.
3. `02-aptkit-bridge.md` — information hiding: the three-class
   adapter bundle that fences the aptkit dependency inside one file.
4. `03-fault-injecting-decorator.md` — decorator: same interface,
   extended behavior. The seam's third live use.
5. `04-optional-hooks.md` — additive extensibility: `onCapabilityEvent`
   and `budget` as optional hooks that keep existing callers unchanged.
6. `05-fallback-chain.md` — nullish-coalesce composition:
   `estimateCost(...) ?? estimateAnthropicCost(...)` as the primary+
   fallback shape.
7. `06-ndjson-kernel.md` — pulled complexity downward: one 64-LOC
   kernel absorbs the fetch → reader → decoder → split → parse loop
   from three call sites.

## Top three fixes, ranked

1. **Delete `lib/agents/*-legacy.ts` (9 files, ~1000 LOC).** Only two
   test files import from `base-legacy.ts`; nothing production
   references any of the seven others. The rollback receipt has
   outlived its usefulness. See audit.md → lens 2, lens 8.
2. **Fold aptkit's per-call arg count down from 6.**
   `AnthropicModelProviderAdapter` takes `(anthropic, agent,
   sessionId, model, logSite, budget)` — the two agent call sites
   pass `undefined, undefined, hooks.budget` positionally. Convert to
   a named-options object. See audit.md → lens 7 (obviousness).
3. **Name the `unwrap<T>()` seam explicitly on the `DataSource`
   port.** `ToolResult.[key: string]: unknown` (types.ts:32) is the
   most permissive part of the interface — it exists so
   `structuredContent` rides through, but the port doesn't tell you
   that. Documenting the escape hatch on the type itself would fold
   a fact currently spread across `unwrap()` and the adapter into
   one place. See audit.md → lens 3.

## Cross-links

- `.aipe/read-aposd/` — the book itself, chapter by chapter. Every
  primitive named below is defined there.
- `.aipe/study-system-design/` — service-level architecture at the
  next altitude up (auth boundary, provider abstraction, streaming
  NDJSON). Module/interface moves live here; service boundaries live
  there.
- `.aipe/audits/refactors/design-*.md` — the action-shaped companion.
  Same eight lenses, but the output is per-finding refactor specs
  instead of teaching. Run `/aipe:audit-software-design` when you
  want to *act* on what's below; run this to *understand* it.

## Source

The primitives (deep module, information hiding, pulled complexity
downward, red flags, etc.) come from *A Philosophy of Software
Design* by John Ousterhout. This guide teaches the ideas in
original words and never reproduces the book's prose. Read the
book. It's short and it's the best thing written on this topic.
