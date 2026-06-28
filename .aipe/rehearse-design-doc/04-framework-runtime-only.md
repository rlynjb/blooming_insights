# RFC 04 — Next.js 16 as runtime, not as a data layer

**Decision:** Use **Next.js 16 (App Router) for routing, bundling, and the
edge runtime only.** Do **not** use React Server Components, Suspense for
data, `use(promise)`, React Query, SWR, or any framework-blessed data
primitive. Every page is `'use client'`; every data interaction is a `fetch`
against a route handler that streams NDJSON. The 30–90s NDJSON stream is the
product.

## Context

Next.js 16 ships with strong opinions about data: Server Components for
async data fetched on the server, Suspense for streaming-aware loading
states, `use(promise)` for inline promise consumption, the framework's
implicit cache, and a recommended pairing with React Query or SWR for client-
side state. The default "Next.js way" is to lean on these primitives heavily.

The product is a streamed agent briefing — a 30–90 second NDJSON sequence
that the UI surfaces in real time. The question was whether to express that
through the framework's data primitives or to bypass them entirely.

The framework's data primitives lost. Hard.

Note on context: this codebase's `AGENTS.md` carries a deliberate warning —
"this is NOT the Next.js you know" — because Next.js 16 contains real
breaking changes from training-data Next.js. Decisions in this RFC were
made *against the version-specific docs in `node_modules/next/dist/docs/`*,
not against assumptions from older releases.

## Goals

  → **The 30–90s stream is the first-class UX.** The user sees individual
    insights, tool calls, and reasoning steps land in real time. This is
    the pitch ("an analyst that shows its work").
  → **One mental model for "where does this state come from?"** Every page
    is a client component holding `useState` populated by a `fetch` against
    a route handler. No mixed server/client tree.
  → **No framework-magic caching.** The product is real-time monitoring
    against a workspace whose data changes constantly. A cache hit on a
    stale briefing is a bug.
  → **Survive the Next.js 16 → 17 → ... upgrade path** without painful
    cross-cutting refactors. The less framework surface used, the smaller
    the upgrade surface.

## Non-goals

  → **SEO / SSR.** The app is behind a session cookie; first paint is a
    sign-in or a cached demo. No SEO requirement.
  → **Page-level data fetching at the server.** The browser drives every
    data flow.
  → **Framework-blessed caching, revalidation, or invalidation.** All
    cache decisions live in `lib/mcp/client.ts` (rate-limit + retry +
    optional skip) — not in `fetch()`'s `next: { revalidate }` option.
  → **Mixing Server Components and Client Components in the same tree.**
    Every page tops out at `'use client'`.

## The decision

Next.js 16 carries the request, runs the route handler, and bundles the JS.
That is the entire framework surface used.

```
  Framework surface — what we use, what we ignore

  ┌─ Next.js 16 features the codebase actually uses ─────────────┐
  │  ✓ App Router file-based routing                             │
  │  ✓ Route handlers (app/api/*/route.ts)                       │
  │  ✓ Dynamic route params (app/investigate/[id]/page.tsx)      │
  │  ✓ React 19 runtime + Tailwind v4                            │
  │  ✓ maxDuration = 300 on streaming routes                     │
  │  ✓ cookies() in the route layer for session ID               │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Next.js 16 / React 19 features deliberately NOT used ───────┐
  │  ✗ React Server Components for data                          │
  │  ✗ Suspense as a data-fetching primitive                     │
  │  ✗ use(promise) for inline await                             │
  │  ✗ Server Actions ('use server')                             │
  │  ✗ fetch() with next: { revalidate, tags }                   │
  │  ✗ revalidatePath / revalidateTag                            │
  │  ✗ unstable_cache / 'cache' directive                        │
  │  ✗ React Query / SWR / TanStack Query                        │
  │  ✗ next/dynamic for code-splitting (every page client-side)  │
  └──────────────────────────────────────────────────────────────┘
```

**Verdict-first:** the framework is the router and the bundler. Everything
above that line is application code we control.

### One question, held constant down the layers

The trait that makes this decision coherent is **"who owns the data?"** asked
at every altitude:

```
  "who owns the data on this surface?"

  ┌──────────────────────────────────────┐
  │ outer:  /api/briefing  (route)       │   → ROUTE owns the stream
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ middle: useBriefingStream (hook) │   → HOOK owns the buffered events
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ inner:  page.tsx (component) │   → COMPONENT owns the rendered UI
          └──────────────────────────────┘

  the same hand-off shape on every page; no Server Component
  in the chain to muddy who's holding what
```

The same pattern repeats verbatim on every surface — feed, investigation
step 2, investigation step 3, chat. The route owns the stream; a client hook
buffers the events; a `'use client'` component renders. Nothing else.

### Page decomposition — proving the model scales

The earliest version of `app/page.tsx` was 817 lines — a single client
component that owned the stream reader, the buffered events, the demo
capture flow, and the reconnect policy. Resolved by extracting three hooks
plus the shared NDJSON kernel:

```
  app/page.tsx decomposition (RESOLVED)

  before:  app/page.tsx                    817 LOC (everything inline)
  after:   app/page.tsx                    461 LOC (composition only)
           + lib/hooks/useBriefingStream   313 LOC (stream + buffer + state)
           + lib/hooks/useDemoCapture      146 LOC (dev capture flow)
           + lib/hooks/useReconnectPolicy  123 LOC (auth-revoke recovery)
           + lib/streaming/ndjson.ts        64 LOC (shared kernel — RFC 02)
```

The hooks are pure client React. They use `useState`, `useEffect`,
`useRef`, `useCallback`. No framework data primitives, no React Query, no
Suspense. The composition surface is "page.tsx imports four hooks; each hook
does one thing."

This is what "framework as runtime, not data layer" *looks like* in
practice — the page decomposes into hooks the same way a non-Next.js React
app would.

### The route handler is the only place server code runs

`app/api/briefing/route.ts` and `app/api/agent/route.ts` are the entire
backend. Both:

  → are POST handlers returning a `Response` whose body is a `ReadableStream`
  → set `Content-Type: application/x-ndjson; charset=utf-8`
  → set `maxDuration = 300` so Vercel allows the long stream
  → read `cookies()` for the session ID
  → connect the appropriate `DataSource` (RFC 05)
  → run the appropriate agent
  → write NDJSON events to the stream as the agent emits them

No Server Component renders anything from these. No `revalidateTag` invokes
them. They are pure HTTP endpoints.

## Alternatives considered

### Alternative A — React Server Components for the briefing

A Server Component fetches the briefing on the server, streams HTML chunks
to the browser via Suspense boundaries.

**Why it lost:** This sounds right and is wrong for this product.

  1. **The briefing is not HTML; it's a sequence of typed events.** The UI
     needs each `AgentEvent` as a JS object — to push into a `Map`, to
     update a `useState`, to mutate the `StatusLog` panel. RSC streams HTML
     *strings*, not typed events.
  2. **`StatusLog` has to render live as events land**, with timestamps,
     expandable tool-call blocks, and an indeterminate progress bar.
     Suspense boundaries don't model "many events into one growing UI" —
     they model "one async value into one component."
  3. **Cancellation flows through `req.signal`, not Suspense.** When the
     user navigates away mid-briefing, `req.signal` aborts the route
     handler which aborts the Anthropic call which aborts the MCP call. RSC
     has no equivalent end-to-end cancel for streamed renders.

### Alternative B — React Query / SWR for the briefing state

A `useQuery({ queryKey: ['briefing'], queryFn: ... })` that calls the
briefing endpoint and gives back loading/error/data.

**Why it lost:** React Query models "fetch a value, cache it, refetch on
focus." The briefing isn't a value — it's a 30–90s sequence of events. Each
event mutates several local state shapes (insights, tool calls, trace,
progress). Cramming that into `useQuery`'s value model means either:

  → flatten the whole sequence into one final value (loses real-time UX), or
  → use the experimental streaming hooks that essentially re-implement what
    `useBriefingStream` already does directly

The hook we wrote IS the right level of abstraction. React Query would be
ceremony around a `fetch` we already control.

### Alternative C — Server Actions for the briefing trigger

A `'use server'` function the client calls instead of `fetch('/api/briefing')`.

**Why it lost:** Server Actions can return a streamed response, but the
ergonomics are designed around form mutations, not 90-second streams. The
on-the-wire shape is also opaque (Next.js's RSC payload), which makes
debugging via the network tab harder than a plain POST with an NDJSON body.

### Alternative D — Mix-and-match: Server Components for the static shell, client for the stream

A Server Component renders the page header + ProcessStepper; a Client
Component below it owns the stream.

**Why it lost:** Two trees, two mental models, for a shell that is ~10 lines
of static markup. The cost of the split (RSC + Client boundary serialization,
two render paths to test, "what's the network waterfall on this page?"
becomes complicated) buys us nothing.

## Tradeoffs accepted

  → **No SSR for first paint.** Every page hydrates from the client. First
    paint is empty → skeleton → live data. Acceptable; the app is behind
    auth.
  → **No automatic cache invalidation.** Cache decisions live in
    `lib/mcp/client.ts`, not in `fetch()`'s revalidate options. The MCP
    client owns rate-limit + retry + cache; route handlers ask for
    `skipCache` when freshness matters.
  → **We don't get the framework's bundle-splitting per route component.**
    Every page is fully client-side, so the JS bundle is larger than a
    Server-Component-heavy app would produce. Measured small enough on
    Vercel to not be a real issue at portfolio scale.
  → **Newer Next.js features arrive and we don't use them.** Acceptable —
    using them on a streamed-agent product would mean fighting the
    framework. The framework is the runtime; the product is the stream.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| A future contributor reaches for a Server Component "because it's the default" | This RFC + the `'use client'` directive at the top of every page makes the convention enforceable in code review. |
| Next.js 17 deprecates a primitive we depend on (e.g. route handlers' streaming Response) | Less framework surface used = smaller deprecation surface. The `node_modules/next/dist/docs/` source-of-truth practice (see `AGENTS.md`) catches breaking changes per release. |
| Bundle size grows because everything is client-side | Measured per-page on Vercel; well under any meaningful budget. Code-split if it ever matters. |
| A reviewer pushes back: "you're not using the framework you chose" | True. The framework is the runtime, not the data layer. Naming the decision in this RFC is the answer to that pushback. |

## Rollout / migration

Already shipped. The decision was made up-front; no migration was needed.
The page decomposition (817 → 461 LOC + 3 hooks + shared kernel) was a
refactor *within* the "no framework data primitives" world — it did not
introduce any.

The framework version did move (Next.js 15 → 16). The upgrade was small
because the framework surface used is small.

## Open questions

  → **Will we ever need SSR / RSC?** Open. If the product gains a public
    landing page (something like "see a demo briefing without signing in"),
    that page could be a Server Component without changing the rest of the
    architecture. The constraint is the streamed surfaces stay client.
  → **Should the route handlers move to Edge runtime?** Today they run on
    Node (Vercel Pro, `maxDuration = 300`). Edge runtime caps lower and
    doesn't support all Node primitives the MCP SDK uses. Re-evaluate when
    Edge runtime matures.
  → **Bundle size budget.** Today no explicit budget. At portfolio scale
    this is fine; at product scale, every page being client-only argues for
    a bundle-size guardrail in CI.

---

**Coach note:** The verbal frame is *"Next.js is my runtime; the stream is
my product."* If a reviewer pushes ("why are you on Next.js then?"), the
answer is: routing + bundling + edge deployment are real value; data
primitives at this version of the framework aren't the right fit for a
30-90s NDJSON stream. The framework is doing what frameworks should do; the
product is owning what the product should own.
