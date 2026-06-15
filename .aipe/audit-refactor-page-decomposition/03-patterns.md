# Chapter 03 — Patterns

Design-pattern refactors are the moves that name a *shape* — Strategy, Observer, State Machine, Adapter — and ask whether the code would be clearer if it reached for that shape. The catalog has a reputation for being over-applied: not every two-branch conditional needs Strategy, not every event listener needs Observer. The chapter's job is to name the patterns the feed-page decomposition actually warrants (one: Custom Hook), the one it half-warrants (Strategy on the briefing source), and the ones that look tempting but would be ceremony (State Machine on the status field, Adapter on the stream).

## Map of the territory

- **DEEP — Custom Hook (the existing `useInvestigation` as exemplar; the four feed-page extractions as siblings).** The one pattern this notebook is actually about. The catalog's "design pattern" framing for hook extraction is unusual but correct — the hook IS the React-flavoured Strategy/Adapter/Observer collapsed into one primitive.
- **BRIEF — Strategy (the demo vs live mode toggle).** Today: a string discriminant inside the page. Worth becoming a `BriefingSource` strategy IF a third mode ever lands. Not before.
- **MENTION** — State Machine (the `status: 'loading' | 'error' | 'empty' | 'loaded'` field). Already a state machine in shape; doesn't earn its own type.
- **NOT FOUND** — Adapter. The `McpCaller` interface (`lib/agents/base.ts:16-22`) is the codebase's one real Adapter, and it lives in the agent layer, not the page layer.
- **NOT FOUND** — Observer / Pub-Sub. The page's event consumption is via NDJSON stream + switch, not an observer registry. Adding one would be ceremony.
- **NOT FOUND** — Command, Visitor, Decorator. None applicable.

---

### Custom Hook — the existing exemplar and the four siblings (DEEP)

**Where it shows up.** One exemplar already exists: `lib/hooks/useInvestigation.ts` (216 LOC). Two pages consume it (`app/investigate/[id]/page.tsx:38`, `app/investigate/[id]/recommend/page.tsx:37`). The pattern is well-formed: a hook that opens one NDJSON stream, drains it into typed state, hydrates from sessionStorage on re-mount, returns a small read-only contract. The four hooks the feed page should extract are siblings of this one.

```
The pattern as it exists today — the calm sibling

  ┌─ app/investigate/[id]/page.tsx (225 LOC) ─────────────────┐
  │                                                              │
  │  export default function InvestigatePage() {                │
  │    const { items, diagnosis, complete, error }              │
  │      = useInvestigation(id, 'diagnose')      ← 216 LOC hidden │
  │                                                              │
  │    return <Layout>                                          │
  │      <EvidencePanel diagnosis={diagnosis} loading={...}/>   │
  │      <StatusLog items={items} scanning={!complete}/>        │
  │    </Layout>                                                │
  │  }                                                          │
  │                                                              │
  └─────────────────────────────────────────────────────────────┘

  The hook is doing the work of four catalog patterns at once:
    · Strategy   — the step ('diagnose' | 'recommend') selects the URL
    · Adapter    — the NDJSON stream is adapted to React state
    · Observer   — each event arm calls setState
    · Template   — the hydrate-or-fetch shape is a fixed sequence

  Four patterns collapsed into one primitive. That collapse is what
  makes the Custom Hook the right level of abstraction here.
```

**Why it's like this.** Reconstructable: the investigate pages shipped second. The first page (the feed) accreted concerns inline because there was no second page to compare against. When the investigate page shipped, the team already had the pain of the feed page in mind — and the second page consciously reached for hook extraction as the seam. The result is `useInvestigation` shaped the way the feed page wants to be shaped. The exemplar exists; the pattern works; it just hasn't been applied backward to the feed.

**Take.** Apply the pattern. The four hook extractions are not new pattern adoptions — they're applying an existing pattern to a sibling component. That's the framing that matters: this isn't introducing Custom Hooks to the codebase; it's noticing that the codebase already uses them in one place and extending the same shape to the other place.

The four hooks should target the same contract shape as `useInvestigation`:

```
The contract shape — what a feed-page hook should look like

  function useXxx(...inputs): { ...nine-or-fewer typed fields }
    ── small return shape   ← the public surface, narrow
    ── fat hidden body      ← all the state, effects, mirrors
    ── deterministic        ← given the same inputs, same external behaviour
    ── consumable by JSX    ← no state setters in the return; only read shape

  the hook's signature IS the unit-test contract:
    given mode='demo', the hook eventually returns status='loaded' or 'empty'
    given mode='live', the hook eventually returns status='loaded' or 'error'
    given a 401 with needsAuth, the hook redirects to authUrl
    given a 'revoked' error in the stream, the hook calls reconnect.trigger()
```

The depth ratio matters here. `useInvestigation` returns a 5-field contract over 216 LOC of implementation — that's the canonical deep-module shape (`.aipe/study-software-design/01-mcp-client-deep-module.md` walks the same pattern at the lib/ layer). `useBriefingStream` should return a 9-field contract over ~150 LOC. The contract is wider because the briefing surface IS wider — but the discipline is the same: return ONLY what the JSX reads; don't expose setters; don't expose intermediates.

**The tradeoff.** Cost: four new hook files in `lib/hooks/`, four new test files. The page collapses to layout + composition (Chapter 01 walks the numbers). Cost of not: the page keeps its eight-concerns-at-one-altitude shape; the pattern that already exists in `useInvestigation` is half-applied; the codebase has two pages that disagree about how a streaming-data page should be shaped.

**What I'd watch for.** Three subtleties the "apply the pattern" framing makes invisible.

1. **`useBriefingStream` is a wider hook than `useInvestigation`.** The investigation hook returns 5 fields; the briefing hook returns 9. That's because the feed page genuinely has more concerns visible in the JSX (coverage tiles, trace items, query count, stepper sub-text, reconnecting flag, error message — all of these render). Don't try to compress the return shape below 9 just to match `useInvestigation`'s 5. The right discipline isn't "make the hook narrower than necessary" — it's "include only what the JSX actually reads." If the JSX reads it, the hook returns it. The contract is "JSX-readable shape," not "smallest possible shape."

2. **The `useReconnectPolicy` hook returns a triggerable action, not just state.** Most data hooks return read-only state. This one returns `{ reconnecting, triggerReconnect }` — a value AND a function. That's not a violation of the pattern; it's the correct shape for a hook that owns a side effect (the `/api/mcp/reset` + reload). The discipline: the hook owns the *implementation* of the side effect; the caller decides *when* to invoke it. Same shape as `useState`'s `[value, setValue]` tuple — and same shape as React's `useTransition` returning `[isPending, startTransition]`. The pattern is widely used; don't dress it up.

3. **The hook contract should be testable in isolation OR together — but the contract IS the test.** This is where precondition B from Chapter 02 lands as a pattern claim. The integration test from precondition B exercises the hook through the page (mount, fire a request, assert UI state changes). The unit test exercises the hook directly (render a test component that consumes the hook, fire a fake stream, assert returned-state changes). Both tests target the same contract. **The contract is what the hook returns; if the test doesn't assert against the return shape, the test isn't testing the hook — it's testing the page.** Discipline: write the contract test FIRST, against the hook's return shape, before lifting the implementation out of the page. That way the lift is provably contract-preserving.

**Verdict.** Worth doing — and the framing matters: this is applying an existing pattern, not introducing a new one. The cleanup audit and the system-design audit both reference the `useInvestigation` exemplar; this notebook upgrades that reference to "the exemplar is the spec." Each hook lift mirrors `useInvestigation`'s shape: started-ref latch, parallel closure mirror, no AbortController, sessionStorage stash where appropriate, small typed return shape. Four hooks; same shape as the one that already works.

---

### Strategy — demo vs live mode toggle (BRIEF)

**Where it shows up.** `page.tsx:122-150`. The mode is a string discriminant (`'demo' | 'live'`). The big effect branches on `isDemo` once: `const search = isDemo ? '?demo=cached' : ''` at L262. Everything downstream is mode-agnostic — the stream is the stream regardless. One branch, on one URL fragment.

**Take.** Today: don't introduce a `BriefingSource` strategy. The conditional is two lines, the branch is a URL fragment, the readers of the page understand `isDemo ? cached : live` in three seconds. Adding a strategy type with two implementations (`DemoBriefingSource`, `LiveBriefingSource`) and a factory would inflate the per-mode reasoning without paying for itself.

Tomorrow, if a third mode ever lands — `'test'` (an integration-test-fixture source), `'fallback'` (a partial-snapshot source), `'compare'` (a side-by-side mode for evals) — the conditional becomes a switch, the switch becomes a factory, the factory becomes the Strategy pattern the catalog names. At three modes, the polymorphism earns its place. **The branch is currently right; the right-ness is conditional on the cardinality staying at two.**

Worth noting for the through-line: the demo vs live mode is the lowest-risk place to LATER introduce a strategy seam, because the existing branch is so narrow (one URL fragment). If a third mode ships, it ships as a refactor opportunity, not as a debt explosion. Park the technique; mention it in the code so the next reader knows where the seam goes if it grows.

**Verdict.** Not worth it today. Worth it the moment a third mode lands. Until then, the URL-fragment branch is the cleanest expression of two modes.

---

### Mentions

- **State Machine on `status`.** The page's `status: 'loading' | 'error' | 'empty' | 'loaded'` is a 4-state machine. It already IS a state machine — the tagged union enforces the four values, and the JSX renders the four branches. Introducing an explicit state machine type (`type FeedStatus = ...` plus a transition function) would be ceremony. The codebase already does this idiomatically with tagged unions; don't add machinery. (Already named `NOT FOUND` in spirit — listed here as MENTION to acknowledge the pattern question.)

- **Observer on the trace items.** The trace items are accumulated by appending to a list (`setTraceItems((prev) => [...prev, ...])` at multiple sites). That's already the right shape; introducing a `TraceObserver` registry would be a more complicated way to express "append to an array." Pass.

- **Adapter on the NDJSON stream.** The NDJSON parser is structurally an adapter (wire format → typed events), but extracting it into `lib/streaming/ndjson.ts` (Chapter 02 precondition A) is the move — and that's Extract Module, not Adapter pattern. The Adapter framing would be the right name if the stream had multiple wire formats (NDJSON, SSE, WebSocket) and one consumer. It has one wire format and four consumers; Extract Module is the right framing. Pass on Adapter; ship the module.

---

## Chapter close

The pattern this chapter argues for is one: Custom Hook. Four extractions, all applying an existing-and-working pattern to a sibling component. The reason this chapter is short is that the codebase has been disciplined about not reaching for design patterns it doesn't need on the client side. The Strategy, Observer, State Machine framings are all available — and the page's current code idiomatically expresses each of them without naming them. That's a feature, not a bug. The catalog's design-pattern names exist to recognize shapes that earn the abstraction; the page's shapes don't yet earn anything beyond Custom Hook.

The through-line: every extraction in this notebook is the same shape as something already shipped. The NDJSON parser is the shape `useInvestigation` already uses internally. The `runBriefing(deps)` extraction is the shape `runAgentLoop(opts)` already uses. The four hooks are the shape `useInvestigation` already is. **There are no new patterns to learn; there are existing patterns to apply consistently.** That's the kindest reading of the cleanup audit's "fix-later" status — the work isn't blocked on novel design; it's blocked on the discipline to do the same thing one more time, in four more places.

The other through-line: hooks compose. Once `useBriefingStream` exists, the next page that needs a streaming briefing surface (an admin view, a comparison view, a richer analytics panel) gets the hook for free — same way the second investigation page got `useInvestigation` for free. The exemplar's payoff was that the third page would have cost a fraction of the second. The siblings' payoff is the same one altitude up. **The hooks aren't built for the feed page; they're built for the second feed-shaped page that doesn't exist yet.** That's the pattern-level argument the chapter is really making.
