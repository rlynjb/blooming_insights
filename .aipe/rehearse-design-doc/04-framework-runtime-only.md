# RFC-04 — Next.js as runtime only, no data primitives

**Decision in one line:** Next.js 16 is the HTTP runtime, the file-based router, and the Vercel deploy target — nothing else. No Server Components, no Suspense boundaries around data, no `use(promise)`, no React Query, no SWR. The NDJSON stream is the state machine.

---

## Context

Next.js 16 ships a whole family of data-fetching primitives — Server Components rendering async data on the server, Suspense boundaries that unwrap promises at render time, the `use(promise)` hook for client-side promise resolution, revalidation tags, cached fetches. React Query and SWR are the third-party alternatives most teams reach for on top.

blooming insights fetches exactly one kind of thing: NDJSON streams from its own routes. Every screen is either showing an in-flight stream, a resolved stream's result, or the demo snapshot. There are no static server-rendered lists, no cache invalidation stories, no "get this data once and refresh in the background."

The question is which layer owns the state-of-the-stream. The Next.js/React data primitives assume the state shape is "loading | data | error." An NDJSON stream's state shape is different: "connecting | streaming (with N accumulated events) | done | error." The two vocabularies don't compose cleanly.

---

## Decision

Use Next.js for what Next.js does uniquely well and stop there:

```
Next.js — kept vs skipped

  ┌─ what we use ──────────────────────┬─ why ─────────────────────────────┐
  │ App Router (file-based routes)      │ colocation of route + handler     │
  │ Route handlers (app/api/*/route.ts) │ standard Web `Request`/`Response` │
  │ React 19 client components          │ where every consumer of NDJSON is │
  │ Vercel deploy (maxDuration=300)     │ long-running agent runs           │
  │ globals.css + Tailwind v4           │ styling substrate                 │
  ├─────────────────────────────────────┼───────────────────────────────────┤
  │ what we skip                        │ why                               │
  │ Server Components                   │ every screen is a stream reader   │
  │ Suspense around data                │ NDJSON isn't a single promise     │
  │ use(promise)                        │ same reason                       │
  │ revalidateTag / next.revalidate     │ no cache invalidation story       │
  │ React Query / SWR                   │ same reason — a stream isn't a    │
  │                                     │  fetch/refetch shape              │
  └─────────────────────────────────────┴───────────────────────────────────┘
```

Data-flow ownership sits with three small custom hooks:

- `lib/hooks/useBriefingStream.ts` — the feed
- `lib/hooks/useInvestigation.ts` — the diagnostic + recommendation pages
- `lib/hooks/useDemoCapture.ts` — dev-only capture

Each hook owns a `useState` that accumulates events as they arrive from `readNdjson` (RFC-02). No library sits between the fetch call and the React render.

---

## Alternatives considered

**(a) Server Components rendering the feed.** Fetch anomalies on the server, render them into the initial HTML, then hydrate. Loses on the primary UX: the whole product pitch is "watch the agent think." A server-rendered feed shows nothing until the whole briefing is done — the "shows its work" `StatusLog` doesn't exist. Server Components are the wrong primitive for streaming reasoning; they optimize for TTFB on static-ish content, and this app has none.

**(b) React Query around the streaming endpoints.** Use `useQuery` with a custom `queryFn` that reads the NDJSON stream and returns the accumulated events. Loses because React Query's model is "one promise per query, cached by key" — the stream is neither a single promise (it produces N events over time) nor keyed by anything the cache invalidates on. You'd end up disabling `staleTime`, disabling refetch-on-focus, disabling cache — at which point the library is doing nothing but wrapping the hook you already wrote.

**(c) `use(promise)` for a per-event unwrap.** Model each incoming event as a promise, `use()` it in the component, let Suspense handle the boundary. Loses on both semantics and cost. Semantically, the stream is not a series of independent promises — earlier events are the context for later ones (a `tool_call_start` needs to be paired with its `tool_call_end`). Cost-wise, Suspense boundaries around streaming data force re-renders on every event, which for the ~50-event trace of a diagnostic run is 50× the work of accumulating into a single `useState` array.

---

## Consequences

**What this buys:**
- **The stream is the source of truth.** No cache to invalidate, no revalidation window to reason about, no "was that data fresh?" question. If it's in the accumulator, it came from the current stream. If the stream is closed, that's the final state.
- **Portable state.** The three custom hooks depend on `fetch` + `readNdjson` + `useState`. Zero framework-runtime coupling. Moving the app off Next.js would be a routing rewrite — the state layer would come along untouched.
- **StrictMode-survivable investigations.** `useInvestigation` intentionally does NOT cancel the in-flight fetch on cleanup (documented at the top of the hook). That's a direct consequence of not using React Query / Suspense — the hook owns its stream, so it can decide to survive a double-mount. Frameworks that own the fetch for you don't offer this choice.

**What it costs:**
- **No streaming Suspense boundaries.** A future feature that wanted "render this component when the diagnosis conclusion arrives, that other one when recommendations arrive" would have to encode that as conditional renders driven by the accumulator, not as declarative Suspense. Not a real cost today; every current screen is a straight `if (loading) ... else render(events)`.
- **Manual cache invalidation, if we ever add one.** The moment the app needs a "list of past briefings that persists across a page load" — it doesn't, and RFC-01 explains why — we'd rebuild what React Query gives you for free. Deferring that until the use case exists.
- **Framework knowledge doesn't fully transfer.** A Next.js developer who joins the project and expects Server Components and revalidation tags has to unlearn those assumptions. The counter is that they're transferring INTO the streaming-reasoning shape, which is the actual thing they need to understand.

**What the reviewer will push on:**
> "You're using Next.js for the router and nothing else. Why not a smaller framework?"

The answer: the Vercel deploy target with `maxDuration=300` on the streaming routes IS the value proposition. Next.js is not just a router; it's the shortest path to "long-running serverless functions on the edge, with a file-based routing layer a solo developer can hold in their head." Skipping the data primitives isn't a rejection of the framework — it's using the framework at the layer where it's uncontested and picking better primitives at the layer where its defaults are wrong for streaming.

---

## Open questions

- **Server Components for the SEO-facing surface?** The public-facing landing page (if we ever build one) is a case where Server Components genuinely help. Deferred until there is a landing page.
- **Route Handler cancellation.** Route handlers see the client abort via `request.signal`. Today the agents don't fully propagate that signal into the AptKit loop — a client that closes the tab mid-diagnosis lets the server-side run finish and eat cost. Instrumented in the budget tracker (RFC-07); a proper cancellation wire-through is scoped for a follow-up.
