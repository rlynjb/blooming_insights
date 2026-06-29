# RFC 04 — Next.js 16 as runtime only (no Server Components, no Suspense, no React Query)

**One-line summary.** Next.js 16 is used for its app-router runtime — routing, route handlers, and Vercel deployment — and for nothing else; React Server Components, Suspense, `use(promise)`, React Query, and SWR are absent on purpose. The 30–90s NDJSON stream IS the data primitive.

---

## Context

This is the decision a reviewer is most likely to push on, because it inverts what "modern Next.js" usually means. The natural assumption when you see `app/` directory + Next.js 16 + React 19 is:

- Pages are Server Components by default
- Data fetching happens server-side, often inside `use(promise)` or async components
- Loading states use Suspense boundaries
- Client cache lives in React Query or SWR
- Streaming is via React's streaming SSR

This repo does none of those things. Every page in `app/` is a Client Component (`'use client'` at the top). Data flows from `fetch()` to a hook to React state — no `use()`, no `<Suspense>`, no library cache. The hooks that drive the streams (`useBriefingStream`, `useInvestigation`, `useDemoCapture`) are 100% client code.

The constraints that forced this:

- **The product IS a long-running stream.** A live briefing takes 30–90s and emits ~20–40 events. The user has to *watch* it run — the reasoning trace is the value. Patterns that hide the work behind a Suspense boundary defeat the product.
- **The stream's consumer needs to track cancellation, errors, reconnect.** A user who unmounts mid-stream needs the fetch to abort cleanly. A user who hits an `invalid_token` needs auto-reconnect. None of this is what Server Components or React Query are designed for — they assume short, idempotent requests.
- **No cache invalidation story is needed.** Each briefing IS the current feed (RFC 01); there's no "stale data → revalidate" cycle. React Query's headline feature (smart cache + invalidation) solves a problem this product doesn't have.
- **The route handlers are doing the long work.** `app/api/briefing/route.ts` and `app/api/agent/route.ts` run for tens of seconds, holding the stream open. They're a different kind of Next.js — *the route handler runtime*, not the page-render runtime.

---

## Decision

**Next.js 16 is used for three things, and three things only:**

```
  What Next.js is used for in this repo

  ┌─ Used ───────────────────────────────────────────────┐
  │                                                       │
  │  1. Routing & file-based pages (app/ directory)       │
  │     app/page.tsx, app/investigate/[id]/page.tsx, …    │
  │                                                       │
  │  2. Route handlers as long-running stream hosts       │
  │     app/api/briefing/route.ts (export maxDuration)    │
  │     app/api/agent/route.ts                            │
  │                                                       │
  │  3. Vercel deployment target                          │
  │     reactStrictMode, build pipeline, edge config      │
  │                                                       │
  └───────────────────────────────────────────────────────┘

  ┌─ NOT used ───────────────────────────────────────────┐
  │                                                       │
  │  ✗ React Server Components                            │
  │  ✗ Server Actions                                     │
  │  ✗ <Suspense> boundaries                              │
  │  ✗ use(promise) for data fetching                     │
  │  ✗ React Query / SWR / TanStack Query                 │
  │  ✗ Streaming SSR (React's built-in)                   │
  │  ✗ Static generation / ISR                            │
  │                                                       │
  └───────────────────────────────────────────────────────┘
```

**The data primitive is the stream.** Every screen that shows agent output drives a `fetch()` → `readNdjson` (RFC 02) → React state pipeline:

```
  The stream IS the data primitive — no library between fetch and state

  ┌─ Browser (Client Component, 'use client') ───────────┐
  │                                                       │
  │  useEffect(() => {                                    │
  │    const res = await fetch('/api/briefing', ...)      │
  │    await readNdjson(res.body, (event) => {            │
  │      setState(prev => reduce(prev, event))            │
  │    }, { cancelOn: () => cancelled })                  │
  │  }, [...deps])                                        │
  │                                                       │
  │  → state IS the cache                                 │
  │  → cancelOn IS the cleanup                            │
  │  → fetch IS the transport                             │
  │                                                       │
  └─────────────────────┬─────────────────────────────────┘
                        │  one fetch, one stream, one consumer
                        ▼
  ┌─ Vercel route handler (Node runtime, 300s budget) ───┐
  │                                                       │
  │  export const maxDuration = 300                       │
  │  POST handler returns ReadableStream<Uint8Array>      │
  │  controller.enqueue(encodeEvent(...)) per event       │
  │                                                       │
  └───────────────────────────────────────────────────────┘
```

No React Query holds the result. No Suspense holds the loading state. The hook owns it directly — `loading` is "fetch hasn't yielded yet," `error` is "fetch threw or emitted an `error` event," `data` is whatever the reducer over events produced.

---

## Alternatives considered

### React Server Components + Suspense + `use(promise)`

The 2024–2025 default for new Next.js apps. Pages are Server Components, async data is awaited at the component boundary, loading states are Suspense fallbacks.

**Why it lost.** Server Components serialize their output and ship it to the client. They're built for *render this with data, send the HTML*. They are not built for "this connection stays open for 90 seconds and emits 40 events." The mismatch shows up as soon as you try: either you `await` the whole stream on the server (defeats the live trace) or you bail out to a Client Component anyway (the Server Component bought nothing). For a request/response page (a marketing site, a dashboard with snapshots) RSC is the right tool. For a streaming reasoning trace it's a layer the product would have to fight.

### React Query / SWR for client-side state

`useQuery({ queryFn: fetchBriefing, queryKey: ['briefing'] })` — cache, dedup, refetch-on-focus, mutation invalidation.

**Why it lost.** Two reasons:

1. **The model assumes idempotent queries.** React Query's value is "ask me for X, I'll give you the cached X or fetch it." A briefing is not idempotent — running it twice runs the agents twice, costs tokens twice, may return different anomalies. There's no `queryKey` that captures "the result of running monitoring against Bloomreach at this exact moment."
2. **The cache it provides isn't the cache the product needs.** The product needs: (a) instant snapshot replay on demo mode (RFC 01 handles this with a JSON file), and (b) handoff between investigation steps (the hooks handle this with `sessionStorage`). React Query would sit alongside both, adding a third cache.

### Long-poll / chunked transfer with React's built-in streaming SSR

Stream the page itself. React's streaming SSR yields HTML chunks; render the trace as it arrives.

**Why it lost.** Server SSR streaming sends *HTML* chunks. It's optimized for "render the page in pieces, hydrate as it arrives." The reasoning trace is structured data the client needs to mutate over time — adding a node, updating a tool call's duration, filtering. Forcing that through SSR-streamed HTML means re-serializing the world on every event. The fetch+stream+state shape models the actual data flow.

---

## Consequences

**What this cost — owned, not apologized for:**

- **No SEO, no static prerender.** The pages render empty server-side; the client has to mount before anything appears. Acceptable because the product is an authenticated tool, not a public-facing site. If a marketing landing page is ever added, it would be a separate page (or a separate static deploy) — not a retrofit of the existing app shell.
- **Bundle size is "everything client-side."** Every page ships its React + the streaming hooks + the components. No Server Component pruning. Today this is fine (the app is small and the audience is on broadband), but it sets a cap on how complex any single page can get before bundle size starts to matter.
- **Loses the "modern Next.js" feature checkbox.** A reviewer who scans for RSC + Suspense + Server Actions and grades on presence will mark this down. The defense is that those features solve problems this product doesn't have — but the reviewer has to be willing to hear it.
- **Manual loading/error/cleanup at every consumer.** No `<Suspense fallback>` shortcut. Each hook handles its own `loading`, `error`, and unmount cancellation explicitly. That's why those hooks exist — the kernel (`readNdjson`) factors the parse; the hooks factor the state machine.

**What this bought:**

- **The stream is honest.** What the user sees on screen IS what the route emitted, in the order it emitted. No framework layer is buffering, reordering, or holding for hydration. The "show your work" pitch lands because the work is literally what they see.
- **Cancellation works.** `cancelOn: () => cancelled` in the kernel, set by the hook's cleanup. A user who clicks away during a 90s briefing cancels the fetch — the route handler sees `req.signal.aborted` and stops burning tokens. With Suspense + RSC this story is much harder.
- **Strict Mode doesn't break the stream.** React 19's `reactStrictMode` is on. The investigation hook explicitly survives StrictMode's double-invocation by NOT cancelling the in-flight fetch on cleanup — that decision lives in `useInvestigation`. Server Components + `use(promise)` would have made this dance much messier.
- **The framework is replaceable.** Because Next.js does only routing + route-handler hosting + Vercel deploy, replacing it with Remix, TanStack Start, or even plain Express + Vite would touch the routing files and `maxDuration` configuration — not the agents, not the hooks, not the kernel. The investment in the product layer survives a framework swap.

---

## Open Questions

- **Does the next phase ever need RSC?** If the product grows a "shareable briefing report" surface that needs to render server-side (for OG previews, for emailing a link with embedded HTML), one route's worth of RSC would earn its place. The bet is that surface lives next to (not on top of) the streaming product, so RSC would be local, not a refactor.
- **Should the hooks consolidate into a small client-side stream library?** Today there are four hooks doing similar shapes (fetch + readNdjson + state machine). The kernel handles the parse; the rest is genuinely different per consumer (different events, different state shapes, different cancellation policies). At a fifth hook the consolidation conversation becomes real; today four is below the threshold.
- **When the alpha MCP server's behavior stabilizes, does anything change?** If tokens stop revoking after minutes and rate limits relax, the "long-running stream IS the product" framing weakens — short request/response with React Query becomes viable for some flows. The architecture would still be right (the trace is the product); the *transport* would still be NDJSON streaming; only the surrounding UX guards (auto-reconnect, demo-mode-default) would relax.
