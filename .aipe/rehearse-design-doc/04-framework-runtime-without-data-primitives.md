# RFC-004: Use Next 16 + React 19's runtime, decline their data-fetch primitives

**Status:** Accepted (implemented)
**Owner:** rein
**Decision:** blooming insights runs on Next.js 16 + React 19, and uses **almost none of what each one offers** at the data-fetch layer. Every routed page is `'use client'`. There are no Server Components in the routed surface, no `<Suspense>` boundaries, no `use(promise)`, no Server Actions, no `loading.tsx` / `error.tsx` / `not-found.tsx`, no React Query / SWR / TanStack Query, no global store. The pages are SPA-shaped on top of Next's serverless runtime; data comes in over hand-written `fetch` + `ReadableStream` loops that the page or hook owns. This is on purpose. The product IS a 30-90 second NDJSON stream, and the React 19 marquee features are designed for request-response.

---

## Context

blooming insights is a Next.js 16 + React 19.2 + Tailwind 4 app on Vercel Pro. The product behavior is uniform across all three streaming surfaces (feed briefing, investigation diagnose step, investigation recommend step): the user clicks, the server runs a Claude-driven agent loop against MCP tools for 30-115 seconds, and intermediate events (`reasoning_step`, `tool_call_start`, `tool_call_end`, `insight`, `diagnosis`, `recommendation`) stream back as newline-delimited JSON over `fetch` + `ReadableStream`. The UI animates from event #1.

Three facts shape every frontend decision:

1. **The data shape is "long stream of typed events," not "request → response."** A 60-second NDJSON stream of ~20-50 small events does not fit any primitive React 19 / Next.js 16 ships. `use(promise)` waits for *one* value. `<Suspense>` falls back until *one* resolution. Server Actions are designed for *one* mutation. RSC streams component output for *one* page render. None of these are wrong; none of them are *this product*.

2. **Per-event rendering is the load-bearing behavior, not a side effect.** Every NDJSON event triggers `setState` calls that drive the UI forward. The stream cadence is the UX. Strip the per-event updates and the demo collapses to "a spinner for 60 seconds, then a final answer."

3. **The same wire format is used by live runs and demo-cache replay** (RFC-002). The consumer can't tell them apart, which means the data-fetch layer cannot be tied to any framework primitive that distinguishes server-rendered HTML from client-fetched JSON.

Plus a fourth fact that's true but not load-bearing: this is a single-engineer single-product codebase. The cost of adopting an unfamiliar framework primitive lands disproportionately when one person owns every decision.

Evidence the decision is real, not accidental:

- `app/page.tsx:1` `'use client';`
- `app/investigate/[id]/page.tsx:1` `'use client';`
- `app/investigate/[id]/recommend/page.tsx:1` `'use client';`
- `app/debug/page.tsx:1` `'use client';`
- `app/layout.tsx:1-28` — server component but only renders the body shell + `metadata`; no data fetching, no `<Suspense>`, no `<Provider>`.
- `package.json:17-19` — Next 16.2.6, React 19.2.4, React-DOM 19.2.4. React 19's `use(promise)`, server actions, `useFormStatus`, `useOptimistic`, `useTransition`: grep returns **zero hits** across `app/`, `components/`, `lib/`.
- Four hand-written `fetch` + NDJSON consumers do the data work, all calling the now-shared `readNdjson` kernel at `lib/streaming/ndjson.ts:17-64`: `lib/hooks/useBriefingStream.ts:288` (feed — extracted from `app/page.tsx` as part of the page decomposition), `lib/hooks/useInvestigation.ts:194` (both investigation steps), `lib/hooks/useDemoCapture.ts:84` (dev capture), `components/chat/StreamingResponse.tsx:108` (chat). The `app/page.tsx` feed page itself is now down to 461 LOC and composes three Blooming-owned hooks (`useBriefingStream`, `useDemoCapture`, `useReconnectPolicy`).
- The full audit of what's not exercised is in `.aipe/study-frontend-engineering/audit.md` (the "Not yet exercised" lines for each lens).

---

## Goals

- The streaming UX appears identical across feed and both investigation steps. One mental model for a contributor: `fetch` → reader → `handle(event)` switch → state.
- The two reader loops (feed + investigation) and the wire format (RFC-002) are testable without standing up React 19's concurrent-rendering machinery.
- Server work stays on serverless functions where the OAuth boundary + MCP retry + 300s `maxDuration` already live (RFC-001, RFC-003). No drift between "what the server runs" and "what the request handler exposes."
- The day a real product feature wants a request-response page (settings, account, admin), adopt RSC + Suspense for *that* page without re-architecting the streaming pages.
- A new contributor can read the data-fetch layer top-to-bottom without first learning React Query semantics, SWR cache keys, or RSC streaming SSR handoff.

## Non-goals

- Adopting React 19's marquee features for their own sake. `use(promise)` does not fit a 60-second stream; pretending it does would either degrade UX (one promise → one fallback → one resolve) or smuggle the stream consumer into a workaround.
- Server Components in the routed surface. The page bundles need the streaming reader loop, the `sessionStorage` handoff (`study-system-design/07-client-stream-handoff.md`), and the React state slots that hold accumulating events. None of that runs on the server.
- A global store (Redux / Zustand / Jotai). All state is local `useState`; the cross-page handoff happens through `sessionStorage` (per-tab durable) and URL params, not a shared client-side store. Same reasoning as RFC-001: stateful client, stateless server.
- A data-fetch library (React Query / SWR). The reader loops are 50 lines each and live inside the hook / page that consumes them. A library would add cache-key + invalidation semantics we do not have a use for (the cache is `sessionStorage` per-step, per-insight — fully owned by the hook).
- `error.tsx` / `loading.tsx` route segments. The streaming surfaces hand-roll their own loading and error UI because the *shape* of "loading" here is "event #3 of N, not done yet," not a binary suspended-or-resolved state.

---

## The decision

```
  ┌─ Framework runtime (used) ─────────────────────────────────────────┐
  │                                                                    │
  │  Next.js 16     Turbopack build, App Router file layout,           │
  │                 serverless functions, 300s maxDuration             │
  │                 (app/api/agent/route.ts:22, briefing/route.ts:19)  │
  │                                                                    │
  │  React 19       function components, hooks (useState, useEffect,   │
  │                 useRef, useParams), StrictMode (with manual        │
  │                 latch — useInvestigation.ts:44, 48-49)             │
  │                                                                    │
  │  Tailwind 4     utility classes for layout + CSS variables on      │
  │                 :root for the color palette                        │
  └────────────────────────────────────┬───────────────────────────────┘
                                       │  every routed page declares 'use client'
                                       ▼
  ┌─ Framework data-fetch primitives (DECLINED) ──────────────────────┐
  │                                                                    │
  │  Server Components in routed surface  ─ none                      │
  │  <Suspense> + use(promise)            ─ none                      │
  │  Server Actions                       ─ none                      │
  │  loading.tsx / error.tsx              ─ none                      │
  │  React Query / SWR / TanStack         ─ not installed             │
  │  Global store (Redux / Zustand)       ─ not installed             │
  │                                                                    │
  │  Why: each is designed for ONE value (one response, one mutation, │
  │  one resolution). The product is a continuous stream of N events. │
  └────────────────────────────────────┬───────────────────────────────┘
                                       │  what we did instead
                                       ▼
  ┌─ What does the data work ─────────────────────────────────────────┐
  │                                                                    │
  │  fetch() → readNdjson(body, onEvent, opts?) → per-event handler    │
  │  (the buf.split('\n') + lines.pop() + per-line JSON.parse loop     │
  │   now lives ONCE inside lib/streaming/ndjson.ts:17-64)             │
  │                                                                    │
  │  Lives in (each is a thin caller of the shared kernel):           │
  │    lib/hooks/useBriefingStream.ts:288   (feed, hook-extracted)    │
  │    lib/hooks/useInvestigation.ts:194    (investigation, in a hook)│
  │    lib/hooks/useDemoCapture.ts:84       (dev capture, in a hook)  │
  │    components/chat/StreamingResponse.tsx:108   (chat, inline)     │
  │                                                                    │
  │  State: useState in the owning hook or page. Plus a parallel       │
  │  closure mirror (useInvestigation.ts:66-68) because setState is    │
  │  async and the 'done' handler stashes synchronously.               │
  │                                                                    │
  │  Cross-mount durability: sessionStorage (per tab, per step,        │
  │  per insight id). See study-system-design/07-client-stream-       │
  │  handoff.md.                                                       │
  └────────────────────────────────────────────────────────────────────┘
```

The pattern: **the framework's runtime carries us; the framework's data-fetch primitives don't fit our data shape.** We adopt the runtime fully (serverless functions, App Router, React 19's reconciler, Tailwind 4's utility classes + CSS variables) and decline the data-fetch primitives uniformly — not selectively, not "we'll use Suspense for one page and reader loops for another." Uniform declination is the discipline that keeps the codebase legible.

Three load-bearing details that follow:

1. **`'use client'` covers every routed page.** Not "the streaming pages are client, the static pages are server." Every page. The mental model is "this is an SPA on top of Next.js's runtime." A future settings page would still be `'use client'` to stay uniform, unless and until the cost of inconsistency is genuinely lower than the cost of unifying.

2. **The reader-loop kernel is hoisted ONCE into `lib/streaming/ndjson.ts:17-64`.** All four streaming surfaces call it via `await readNdjson<E>(res.body, handle, opts?)`. The previous duplication red-flag (`study-frontend-engineering/audit.md` #2) is closed. The page decomposition shipped at the same time: `app/page.tsx` dropped from 817 to 461 LOC by extracting three hooks (`useBriefingStream` at 313 LOC, `useDemoCapture` at 146 LOC, `useReconnectPolicy` at 123 LOC). The architectural call ("do hooks own their own reader, or is there one shared kernel?") was made in favor of the shared kernel because all four surfaces wanted the same line-buffering + cancellation-polling + malformed-line tolerance — and the kernel is generic over the event type, so each surface's discriminated union (e.g. the briefing's local `BriefingEvent` superset of `AgentEvent`) rides through `<E>` without widening the shared contract.

3. **The framework's loading/error primitives aren't substitutes for streaming UI.** A `loading.tsx` segment fires once, until the route resolves. A `<Suspense>` boundary falls back until its promise resolves. Neither animates from event #1 of N. The progressive skeleton + stepper composition (`study-frontend-engineering/02-progressive-skeleton-with-stepper.md`) IS the loading UX — it's not absent, it's hand-rolled because the framework's version doesn't render the right shape.

---

## Alternatives considered

### Alternative A: RSC + `<Suspense>` + `use(promise)` for everything

The React 19 marquee. Make pages server components by default; let `<Suspense>` fall back during loading; let `use(promise)` consume the data; let the server stream HTML to the browser.

**Why it lost:**

The streaming surfaces — feed, diagnose, recommend — are not request-response. They emit 20-50 events over 30-115 seconds. `use(promise)` consumes *one* value; `<Suspense>` falls back until *one* resolution. There is no React 19 primitive that natively models "a long stream of typed events with per-event UI updates" — the closest is RSC's streaming HTML, and that streams *components* not typed application events. You cannot run the `handle(event)` switch over a stream of `Insight | Diagnosis | Recommendation | ReasoningStep | ...` discriminated-union events using `<Suspense>` — the type loses its discriminant the moment it goes through the SSR stream.

The honest version: RSC + Suspense is the right answer for pages whose product shape IS request-response. This product's shape isn't that. The day we add a settings page or an admin dashboard whose shape *is* request-response, RSC + Suspense is the right call for *those* pages. Today, the streaming surfaces are 4 of the 4 routed pages.

Secondary costs that came up:

- The cross-step handoff via `sessionStorage` + URL param (RFC-001's "stateful client, stateless server" pattern, walked in `study-system-design/07-client-stream-handoff.md`) cannot survive an RSC migration without re-architecting the OAuth + investigation flow. The handoff exists *because* the server is stateless.
- The cache-replay path (RFC-002 — same wire format, different producer) works because both producers emit NDJSON to the same client consumer. RSC streaming has no such symmetry — server-rendered HTML and client-rendered HTML aren't interchangeable.
- React StrictMode's double-effect behavior is already handled with manual latches (`startedRef`). Migrating to `use(promise)` would shift the cancellation problem into Suspense's machinery without giving us better control over "don't trigger a duplicate $0.10 agent run."

### Alternative B: SWR / React Query / TanStack Query for the data layer

Add a data-fetch library; let it own caching, invalidation, request deduplication, error retry, mount-time hydration.

**Why it lost:**

- SWR and React Query both model "fetch a value, cache it by key, revalidate it." Our data shape is "subscribe to a stream of N events whose handler mutates 14 state slots." The libraries' primitives (`useSWR(key, fetcher)`, `useQuery({ queryKey, queryFn })`) want one value back, not a reader loop. We would end up smuggling the reader loop into a `queryFn` that resolves *once* at the end of the stream, which removes the per-event UI updates that are the entire product.
- The cache layer we DO have (`sessionStorage` per step, per insight id — `useInvestigation.ts:51-64`) is owned by the hook and tested in isolation. A library cache would add cache-key semantics we do not have a use for, with invalidation rules we'd have to maintain in parallel with the existing `sessionStorage` keys.
- Both libraries add an `Provider` at the app root, which would touch `app/layout.tsx` (currently a 28-line server component with no providers). That's the kind of "small change" that becomes a discoverability tax — every new contributor has to learn the provider's semantics before reading any data-fetch code.
- The auto-retry / auto-refetch behavior that's the libraries' default value-add is *actively wrong* for non-idempotent GETs that cost Anthropic tokens (same disqualifier as SSE in RFC-002).

The honest version: these libraries are the right call when the data shape is "many small fetches with overlapping cache lifetimes, mostly idempotent." Our shape is "two long non-idempotent streams." Different problem.

### Alternative C: A global store (Redux / Zustand / Jotai) for shared state

Lift the streaming state into a global store; let pages subscribe; let the reader loop dispatch actions.

**Why it lost:**

- There is no state shared across pages that needs a global store. The feed owns its briefing state. The diagnose page owns its diagnosis state. The recommend page owns its recommendation state. The cross-page handoff IS `sessionStorage` + URL params, by design (RFC-001's "stateful client, stateless server" stance extended into the page-to-page boundary).
- Adding a global store invites the wrong refactor: "let's move the 14 `useState` slots in the feed page into the store." That doesn't fix the feed page's depth problem (documented in `study-software-design/02-shallow-module-page-component.md` — the fix is hook extraction, not state lifting). It moves the depth problem into the store.
- Same provider tax as alternative B: another `<Provider>` at the root, another concept a contributor has to learn before reading data-fetch code.
- The state that IS shared (`bi:mode` localStorage flag for demo vs live mode — now a 3-way enum `'demo' | 'live-bloomreach' | 'live-synthetic'` at `app/page.tsx:73-78` with the live-bloomreach/live-synthetic distinction belonging to RFC-005's DataSource seam) is one flag. A global store for one flag is overkill.

### Alternative D: Mix — Server Components for static pages, hand-rolled streams for live pages

The pragmatic mix: layout, settings, and any future static-content pages stay as Server Components; the streaming surfaces stay as `'use client'` with hand-rolled reader loops.

**Why it lost (today):**

There are no static-content pages today. All four routes stream. The mix would be aspirational — "we'll use RSC when we have a page that fits it" — which is already the implicit stance. Naming it as a current architecture is overstating what the codebase actually does.

The mix becomes the right call the *day* a Server-Component-shaped page lands. Today the cost of declaring an "architecture" that has zero examples is higher than the cost of saying "we're uniform `'use client'` for now, and the day a page wants RSC, we'll add it for that page."

This alternative is the open-question version of alternative A. It revisits when the product grows a page that fits the RSC shape.

### Alternative E: Adopt one React 19 feature, ignore the rest

The "use what's useful" approach. Maybe `useTransition` for the demo-mode toggle. Maybe `useOptimistic` for the future demo-capture POST. Maybe `useFormStatus` for the QueryBox input.

**Why it lost:**

- `useTransition` would let us defer the demo-mode toggle's re-render, but the toggle is one boolean change with a small subtree; the user wouldn't perceive the difference.
- `useOptimistic` is for mutation responses; the only mutation in the codebase is the dev-only `/api/capture` POST (fire-and-forget). No optimistic update needed.
- `useFormStatus` is for nested form components reading the parent form's pending state; the QueryBox is a one-input controlled form with manual submission state. The hook would be cleaner *and* would invite the question "why is this the only React 19 primitive in the codebase?"

Selective adoption invites inconsistency. Better to be uniformly declined than scattered. The day one of these features earns its place by solving a real problem, adopt it then. Don't adopt it because it exists.

```
  Alternatives matrix

  option                       fits-stream   handoff-survives   bundle-cost   chosen?
  ──────────────────────────   ───────────   ────────────────   ───────────   ───────
  hand-rolled fetch + loop     yes ★         yes (sessionStor)  ~0            ★
  RSC + Suspense + use()       no            no                 small         no (wrong shape)
  SWR / React Query            no (one val)  yes                +6-12KB       no (auto-retry wrong)
  global store                 n/a           yes                +2-8KB        no (no shared state)
  RSC for static + stream for  yes (someday) yes                small         deferred
    live (mixed)
  selective React 19 adoption  varies        yes                small         no (scattered)
```

---

## Tradeoffs accepted

We chose to decline the framework's data-fetch primitives uniformly, accepting:

1. **The reader-loop kernel and the feed-page extraction both landed.** RESOLVED — `lib/streaming/ndjson.ts` is the one shared kernel; `app/page.tsx` dropped from 817 to 461 LOC after extracting `useBriefingStream` (313 LOC), `useDemoCapture` (146 LOC), `useReconnectPolicy` (123 LOC). *What we still accept: each hook owns its own `fetch` + state plumbing — only the inner `readNdjson` loop is shared. That is the deliberate seam: the kernel is event-type-agnostic, the hooks own the discriminated-union dispatch for their surface.*

2. **Loading and error UX are hand-rolled per route — but the auth-revoked path is now one hook.** The previous duplication (`app/page.tsx:407` + `:650`) is closed: the auth-revoked auto-reconnect lives in `lib/hooks/useReconnectPolicy.ts` (`isAuthErrorAuto` regex at `:33`, `useReconnectPolicy()` hook at `:68`), composed into the feed via callbacks (`onAuthError: reconnectPolicy.handle`, `onStreamComplete: reconnectPolicy.clearFlag` at `app/page.tsx:111-112`). *We accept what remains: each page still hand-rolls its own loading + error JSX (no shared `<RouteError>` component yet). The `error.tsx` segment doesn't help because errors mid-stream are not the same as errors-loading-the-route.*

3. **No `<Suspense>` means no concurrent-rendering primitives.** `useTransition`, `useDeferredValue`, the whole concurrent-rendering surface stays unused. *We accept this — the streaming UX is the product's bottleneck, and concurrent rendering doesn't help with "20-50 events over 60 seconds" in a measurable way.*

4. **No React Query / SWR means no built-in cache invalidation.** `sessionStorage` is the cache; clearing it is manual. *We accept this — invalidation is per-step, per-insight, owned by the hook, and the test coverage is in place (`useInvestigation.ts:51-64` is the hydrate path, tested at `test/hooks/useInvestigation.test.ts`).*

5. **The bundle ships React 19 + React-DOM 19 but uses ~30% of their feature surface.** ~50KB of features we don't reach for. *We accept this — the alternative (downgrading to React 18 to "use what we use") would lose the StrictMode improvements and the React 19 bug fixes we DO benefit from, while adding the migration cost of a major-version downgrade.*

6. **Future contributors will ask "why no Suspense?"** The question is reasonable. The answer is in this RFC. *We accept the discoverability tax — the answer is documented; the question is welcome.*

---

## Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Contributor adds `<Suspense>` to one page on instinct → drift between framework-primitive and hand-rolled approaches | Medium | This RFC is the canonical answer to "why no Suspense?" Cross-referenced from `study-frontend-engineering/audit.md` rendering-and-reactivity lens. |
| A future framework version makes the hand-rolled reader loop unnecessary (e.g., a React `useStream(asyncIterable)` primitive ships) | Low today | We re-evaluate. The reader loop is 50 lines; a migration to a first-party primitive is mechanical. |
| The reader-loop duplication grows from 3 copies to 4+ as more streaming surfaces are added | Closed | `lib/streaming/ndjson.ts` is the shared kernel; every surface calls `readNdjson<E>(body, onEvent, opts?)`. New surfaces add a fifth caller, not a fifth copy. |
| A product feature lands that genuinely fits RSC — e.g., a settings page, an admin dashboard — and we keep the uniform `'use client'` stance out of habit | Medium | The non-goals explicitly call this out: the day a page fits RSC, adopt RSC *for that page*. Uniform declination is a default, not a rule. |
| Bundle size grows as the React 19 + Next.js 16 surface area we ship-but-don't-use grows | Low | We ship default Turbopack output; no manual bundle splitting. If the production bundle crosses a threshold the user perceives, revisit. Not a concern today. |
| The auth-revoked regex duplication causes drift between the in-stream handler and the JSX render branch | Closed | Regex hoisted to `lib/hooks/useReconnectPolicy.ts:33` (`AUTH_ERROR_RE_AUTO`); the hook exports `isAuthErrorAuto` for the in-stream check and `isAuthErrorButton` for the JSX render branch. One regex, two consumers, one tested file. |

---

## Rollout / migration

Day-one shape — every routed page has been `'use client'` since the first commit, and no streaming surface has ever used a framework data-fetch primitive. There is no rollout question for the current state.

The interesting migration scenario is *future*: the day a page lands that genuinely fits RSC.

**If/when a Server-Component page lands:**

1. The new page is a Server Component (`'use client'` omitted). It uses RSC + `<Suspense>` + `use(promise)` natively for whatever data shape it has.

2. The streaming surfaces stay as `'use client'` with hand-rolled reader loops. They don't migrate. The mix becomes real.

3. `app/layout.tsx` stays as the server-component shell. No provider added for the new page unless the page's product shape demands one.

4. The RFC successor documents the mix — naming the seam between "RSC-shaped pages" and "streaming-shaped pages" so the next contributor knows which side of the line their new page lands on.

**If/when a data-fetch library lands** (probably for a request-response page that *does* fit SWR / React Query):

1. The library wraps *only* the pages whose data shape fits its primitives. The streaming reader loops stay as they are.

2. The provider lands at the closest common ancestor of the library-using pages, not at the root.

3. The library's cache lives alongside `sessionStorage`, not replacing it. Each owns a different concern (library = request-response cache; `sessionStorage` = per-step result memoization).

**If we never grow a fitting RSC page:** the uniform `'use client'` stance is genuinely complete for this product's scope. The streaming surfaces are the product.

---

## Open questions

1. **When does the reader-loop duplication earn an extraction?** RESOLVED — extracted to `lib/streaming/ndjson.ts` as `readNdjson<E>(body, onEvent, opts?)`; consumed by all four streaming surfaces. The companion page decomposition shipped at the same time (feed page 817 → 461 LOC; three hooks extracted). The next question in this thread is "do the per-hook fetch + state plumbings themselves want a higher-level `useStreamingFetch<E>` abstraction?" — open. Today each hook owns its own state shape and that's deliberate (different surfaces accumulate different state slots).

2. **What's the trigger for adopting RSC + `<Suspense>` for a new page?** Tentative answer: when a new routed page's data shape is request-response and the page has at least one non-trivial async data dependency. A settings page reading user preferences from an API fits. A streaming surface doesn't.

3. **Do we ever ship the auth-revoked auto-reconnect as a route-segment `error.tsx`?** The current implementation (regex + `sessionStorage` guard + full-page reload) works. An `error.tsx` segment could own the auth-revoked branch and let the streaming surface focus on the data path. The cost: `error.tsx` runs on rendering errors, not on in-stream errors, so the regex check has to stay in the stream handler regardless. The benefit is small. Deferred.

4. **Bundle-size budget.** No formal budget today. Production bundle size grows quietly. The day it crosses a perceived threshold for the user, revisit Server Components for the layout shell + a per-page bundle audit.

5. **Should we adopt `useTransition` for the demo-mode toggle?** Today the toggle re-renders synchronously; the user perceives no jank. The day the feed's accumulated state grows large enough that the toggle stutters, `useTransition` is the cheap fix.

6. **What's the canonical example for "framework primitive we'd reach for first if the shape fit"?** Probably `use(promise)` inside a Server Component for a future user-preferences page. Naming the example matters because it makes the non-adoption stance falsifiable — if `use(promise)` lands somewhere obvious, this RFC's framing has shifted.

---

## What a reviewer will push on (and the framing that holds)

> "You're on React 19 — why no Suspense?"

`<Suspense>` falls back until one promise resolves. Our data shape is a 60-second stream of 20-50 typed events that drive per-event UI updates. There's no one promise to suspend on; the stream IS the loading state. We hand-rolled the loading UX (progressive skeleton + stepper, walked in `study-frontend-engineering/02-progressive-skeleton-with-stepper.md`) because the framework's version doesn't render the right shape for this data.

> "Every page is `'use client'`. You're not using Next.js — you're using it as a static-asset host."

We're using Next.js's serverless functions (the `/api/agent`, `/api/briefing`, `/api/mcp/*` routes — 300s `maxDuration` is a Vercel Pro feature), the App Router file layout, Turbopack's build pipeline, and the default code splitting per route segment. What we're declining is RSC at the routed surface. That's a deliberate choice based on the product's shape, not framework illiteracy.

> "Why not React Query for the streams?"

React Query models "fetch a value, cache it by key, revalidate it." Our streams aren't values — they're sequences of typed events with per-event handlers. The library's `useQuery({ queryKey, queryFn })` would want the `queryFn` to resolve once at the end of the stream, which removes the per-event UI updates that are the entire product. The auto-retry default is *actively wrong* for non-idempotent GETs that cost Anthropic tokens (same disqualifier as SSE in RFC-002).

> "What's the upgrade path when React 22 ships something that does what your reader loops do?"

50-line reader loop → first-party primitive. Mechanical migration, well-scoped. The architecture survives because the *boundary* (a hook returns `{ items, complete, error }`) doesn't depend on what's behind it. The day the first-party primitive ships, we migrate one hook at a time without touching the consumer pages.

> "You're paying for React 19's bundle without using its features. That's waste."

We ship ~50KB of features we don't use. We benefit from React 19's StrictMode improvements (which the codebase uses, via the `startedRef` latch), the reconciler improvements, the bug fixes. Downgrading to React 18 to "use what we use" would lose those benefits *and* add the major-version migration cost. Not worth it.

> "Three copies of the reader loop is a smell."

Was — closed. `lib/streaming/ndjson.ts` is the one shared kernel; the four streaming surfaces (`useBriefingStream`, `useInvestigation`, `useDemoCapture`, `StreamingResponse`) call it. The page decomposition that gated the call (817 → 461 LOC on `app/page.tsx`, three hooks extracted) shipped at the same time. The architectural call landed: hooks own their own state plumbing, the kernel is the shared inner loop. Generic over the event type so the briefing's local `BriefingEvent` superset rides through without widening the shared `AgentEvent` contract.

---

## References

- `package.json:17-19` — Next 16.2.6, React 19.2.4, React-DOM 19.2.4 (the runtime we adopted)
- `next.config.ts:3` — empty config (no `experimental` flags, no overrides)
- `app/layout.tsx:1-28` — the only server component in the routed surface (body shell + `metadata` only)
- `app/page.tsx:1` — `'use client'` (feed)
- `app/page.tsx` — 461 LOC, composes `useBriefingStream` + `useDemoCapture` + `useReconnectPolicy`
- `app/investigate/[id]/page.tsx:1, :38` — `'use client'` + `useInvestigation(id, 'diagnose')`
- `app/investigate/[id]/recommend/page.tsx:1, :37` — `'use client'` + `useInvestigation(id, 'recommend')`
- `app/debug/page.tsx:1` — `'use client'`
- `lib/streaming/ndjson.ts:17-64` — the shared `readNdjson<E>` kernel (one file, four consumers)
- `lib/hooks/useBriefingStream.ts:288` — feed consumer
- `lib/hooks/useInvestigation.ts:194` — investigation consumer
- `lib/hooks/useInvestigation.ts:51-64` — `sessionStorage` hydrate path (the cache we have)
- `lib/hooks/useInvestigation.ts:44, 48-49` — `startedRef` StrictMode latch (the React 19 surface we DO use)
- `lib/hooks/useDemoCapture.ts:84` — dev-capture consumer
- `lib/hooks/useReconnectPolicy.ts:33, 38, 43, 68` — auth-revoked regex + `isAuthErrorAuto` / `isAuthErrorButton` + the `useReconnectPolicy` hook
- `components/chat/StreamingResponse.tsx:108` — chat consumer
- `.aipe/study-frontend-engineering/audit.md` — the full audit of what's there and what's not yet exercised
- `.aipe/study-frontend-engineering/01-ndjson-stream-reader-hook.md` — the hook-shaped reader loop pattern walk
- `.aipe/study-frontend-engineering/02-progressive-skeleton-with-stepper.md` — the loading UX we built instead of `loading.tsx`
- `.aipe/study-software-design/02-shallow-module-page-component.md` — the page-decomposition story (now shipped)
- `.aipe/study-system-design/07-client-stream-handoff.md` — the `sessionStorage` cross-page handoff (the pattern that would break under RSC)
- `.aipe/rehearse-design-doc/02-ndjson-fetch-stream-over-sse.md` — the wire-format / transport RFC (this RFC is the consumer-side complement)
- React 19 release notes — the marquee features we deliberately don't use
- WHATWG Streams spec — the primitive that makes the hand-rolled reader loop work
