# framework-runtime-only

## Framework-as-runtime (project-specific)

Next.js is here for its *runtime* — App Router conventions, streaming responses inside `ReadableStream`, edge cookie helpers, the `maxDuration` budget knob, and the serverless function lifecycle on Vercel. It is *not* here for SSR/SSG, ISR, image optimization, or any of the rendering features that usually justify Next.js. The whole UI is a single client component tree; SSR would buy nothing here.

This is the pattern this repo's "this is NOT the Next.js you know" `AGENTS.md` warning points at: most assumptions you bring from a typical Next.js codebase do not apply.

## Zoom out — where this pattern lives

Next.js sits as the *runtime shell* under the routes and the route's streaming machinery. It is not the structural anchor of the UI.

```
  Zoom out — Next.js as runtime, not as UI architecture

  ┌─ UI layer ────────────────────────────────────────────────────────┐
  │  one client-component tree                                         │
  │  app/page.tsx + investigate/[id] + recommend     ALL 'use client'  │
  │  no SSR boundaries, no Server Components in user space             │
  └────────────────────────────┬──────────────────────────────────────┘
                               │
  ┌─ ★ FRAMEWORK RUNTIME ★ ───▼──────────────────────────────────────┐ ← we are here
  │  App Router file conventions  (app/api/*/route.ts)                 │
  │  Route handler signature      (GET(req: NextRequest) → Response)   │
  │  Streaming response support   (Response with ReadableStream body)  │
  │  Edge cookie helpers          (cookies() from next/headers)        │
  │  maxDuration export           (per-route serverless budget)        │
  │  dev/prod environment switch  (process.env.NODE_ENV)               │
  └────────────────────────────┬──────────────────────────────────────┘
                               │
  ┌─ Vercel platform ─────────▼──────────────────────────────────────┐
  │  serverless functions, ephemeral, 300s budget on Pro              │
  │  CDN + per-deploy hosts (x-forwarded-host)                        │
  │  encrypted env vars                                               │
  └───────────────────────────────────────────────────────────────────┘
```

## Structure pass

Three layers carry this pattern: the **UI** layer (client components only), the **framework** layer (Next.js conventions + helpers), the **platform** layer (Vercel's serverless model). One axis worth tracing: **what does the framework do for each layer?**

```
  Axis: what does the framework actually do?

  ┌─ UI layer ──────────────┐    nothing structural — just file-based routing
  │  no SSR boundaries      │   ═════╪═════►
  │  no Server Components   │
  └─────────────────────────┘
       ┌─ framework layer ─────────┐    A LOT
       │  route handlers           │
       │  ReadableStream streaming │   ═════╪═════►
       │  cookies() helper         │
       │  maxDuration export       │
       └────────────────────────────┘
            ┌─ platform layer ──────┐    runtime constraints
            │  300s budget          │
            │  ephemeral instances  │
            └────────────────────────┘
```

The axis flips: the UI layer treats the framework as a thin file-router; the route layer treats the framework as the runtime; the platform imposes the constraints both layers honor. That's why this file exists as a discovered pattern — the *atypical* shape (Next.js as runtime, not as renderer) is itself architecturally load-bearing.

## How it works

### Move 1 — the mental model

You've used `useEffect` with a `fetch` to talk to a backend. The frontend is React; the backend is a Node server. The framework on the backend matters for *runtime* concerns (cookie parsing, request body, response streaming) but it doesn't shape the React app at all — the React app would look the same in front of Express, Fastify, or a custom Node server.

This repo is exactly that shape, with Next.js as the backend runtime. The React app would look the same in front of any framework that supported (a) file-based routing, (b) streaming HTTP responses, (c) cookie helpers, (d) per-route timeout configuration. Next.js happens to provide all four; that is the entire reason it is here. The features that usually justify Next.js — SSR, Server Components, ISR, image optimization, route prefetching — are unused.

```
  The pattern: framework picked for runtime traits, not rendering features

  ┌─ what we use ─────────────────┐   ┌─ what we don't ─────────────┐
  │  App Router (file conventions)│   │  ╳ Server Components in app │
  │  route.ts → Response          │   │  ╳ SSR / SSG / ISR          │
  │  ReadableStream body          │   │  ╳ next/image               │
  │  next/headers (cookies)       │   │  ╳ next/link prefetch (page │
  │  maxDuration = 300            │   │     navigation, not data)   │
  │  middleware (none here)       │   │  ╳ revalidate / cache tags  │
  │  process.env switching        │   │  ╳ form actions             │
  └───────────────────────────────┘   └─────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

#### the App Router file conventions — file-based API routing

`app/api/*/route.ts` is the entire API surface:

```
  app/
    api/
      briefing/route.ts           → GET /api/briefing
      agent/route.ts              → POST /api/agent
      mcp/
        callback/route.ts         → GET /api/mcp/callback
        reset/route.ts            → POST /api/mcp/reset
        call/route.ts             → POST /api/mcp/call
        tools/route.ts            → GET /api/mcp/tools
        tools/check/route.ts      → POST /api/mcp/tools/check
        capture/route.ts          → POST /api/mcp/capture
        capture-demo/route.ts     → POST /api/mcp/capture-demo
    page.tsx                      → /
    investigate/
      [id]/page.tsx               → /investigate/:id
      [id]/recommend/page.tsx     → /investigate/:id/recommend
    layout.tsx                    → app shell
```

Two patterns at play. (a) `route.ts` is the route handler convention — export a function named after the HTTP verb (`GET`, `POST`, …), receive `NextRequest`, return `Response`. (b) `[id]` is a dynamic segment. There's no `next.config.ts` magic, no per-route generation — the file paths are the routing.

#### route handler signature — the runtime concrete

Every route handler has the same shape:

```ts
// app/api/briefing/route.ts:77, 19
export const maxDuration = 300;
…
export async function GET(req: NextRequest) {
  const demo = req.nextUrl.searchParams.get('demo') === 'cached';
  …
  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store, no-transform' },
  });
}
```

Three load-bearing pieces. (a) `export const maxDuration = 300` is the per-route budget — Vercel Pro tops out at 300s; without this export, the route defaults to a lower ceiling (60s on most plans). The monitoring scan with 10 categories and rate-limited MCP calls can easily exceed 60s; the export buys the headroom. (b) `req.nextUrl.searchParams` is the framework's URL helper — same parsing as `URL` in browser JS, but with the framework's pre-built `nextUrl`. (c) The return value is a standard `Response` — the framework hands it back to the platform without further transformation.

```
  Pattern — the route handler as a runtime contract

  ┌─ Next.js platform ─┐
  │  receives request  │
  └─────────┬──────────┘
            │
            │  maps URL → app/api/<...>/route.ts
            │  picks exported fn matching method
            ▼
  ┌─ your code ────────────────────────────────┐
  │  export async function GET(req: NextRequest)│
  │  {                                          │
  │    /* do work, can be long-running */       │
  │    return new Response(...)                 │
  │  }                                          │
  └─────────┬──────────────────────────────────┘
            │
            │  framework returns Response to platform
            ▼
  ┌─ Next.js platform ─┐
  │  honours headers,  │
  │  streams body if   │
  │  ReadableStream    │
  └────────────────────┘
```

#### streaming responses inside `ReadableStream`

The framework supports a `Response` whose body is a `ReadableStream<Uint8Array>` — the framework does not buffer; chunks land on the wire as they're enqueued. The briefing route uses this directly:

```ts
// app/api/briefing/route.ts:190-194
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
    …
```

This is *the* runtime feature that makes the live agent path possible. Without streaming, the route would have to await the full scan, build the result, then return — meaning the UI would see nothing for 30-60 seconds while the agent ran, and any timeout would kill the whole request. With streaming, every NDJSON event hits the wire as it's produced; the UI renders progressively; partial-progress is meaningful even when the route hits the budget cap.

The framework's contract here is: if `body` is a `ReadableStream`, every `controller.enqueue(...)` becomes a chunk. The framework owns chunked transfer encoding; this repo owns the framing (NDJSON, terminating each event with `\n`).

#### `cookies()` from `next/headers` — the cookie helper

Cookies are the only store this app has in production (no DB, no Redis). The framework's `cookies()` helper is the access point:

```ts
// lib/mcp/session.ts:16-23
export async function getOrCreateSessionId(): Promise<string> {
  const jar = await cookies();
  let id = jar.get(COOKIE)?.value;
  if (!id) {
    id = crypto.randomUUID();
    jar.set(COOKIE, id, sessionCookieOpts());
  }
  return id;
}
```

```ts
// lib/mcp/auth.ts:88-94
const { cookies } = await import('next/headers');
const raw = (await cookies()).get(AUTH_COOKIE)?.value;
const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
const result = await requestStore.run(ctx, fn);
if (ctx.dirty) {
  (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), { … });
}
```

Two atypical details. (a) The helper is *async* — `await cookies()`. In a typical request-handling library, the cookie jar is synchronously available; here the framework returns a promise to support edge runtimes. (b) The read/write split. Reads in `cookies()` return the *request* cookie; writes via `jar.set(...)` set the *response* cookie. A read after a write in the same request returns the OLD value. This is why `withAuthCookies` in the auth boundary file uses `AsyncLocalStorage` to hold the per-request store and only writes the cookie ONCE at the end. → see `02-auth-boundary.md` for the full pattern.

The dynamic import (`await import('next/headers')`) is a precaution against running this code outside a request context — in tests, there's no request, so the import gracefully fails instead of crashing module load.

#### the dev/prod environment switch

`process.env.NODE_ENV` is the discriminator for several runtime decisions:

```ts
// lib/mcp/auth.ts:34
const PERSIST = process.env.NODE_ENV === 'development';
// lib/mcp/session.ts:11-14
return process.env.NODE_ENV === 'production'
  ? { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/' }
  : { httpOnly: true, sameSite: 'lax' as const, path: '/' };
// lib/mcp/connect.ts:43
if (process.env.NODE_ENV === 'production') { … host-aware redirect_uri … }
```

The framework sets `NODE_ENV` by command — `next dev` → `development`, `next build` + `next start` → `production`, the test runner → `test`. The repo's code uses that to pick storage backends, cookie settings, and the OAuth redirect URI. None of this is framework magic — `process.env.NODE_ENV` is plain Node — but the framework's command surface is what makes the switch reliable.

#### what is *not* used — the negative space matters

```
  Comparison — typical Next.js vs this repo

  ┌─ typical Next.js app ──────────┐    ┌─ blooming_insights ────────────┐
  │ Server Components for fetching │    │ ╳ all client components         │
  │ SSR for SEO                    │    │ ╳ no SEO (auth-gated tool)      │
  │ revalidate / cache tags        │    │ ╳ no Next caching at all        │
  │ next/image for assets          │    │ ╳ no images                     │
  │ middleware for auth            │    │ ╳ auth in route handlers        │
  │ form actions                   │    │ ╳ fetch + JSON instead          │
  │ generateStaticParams           │    │ ╳ all routes dynamic            │
  │ next/font                      │    │ ╳ Tailwind tokens               │
  │ ISR for content                │    │ ╳ data is live or replayed JSON │
  └────────────────────────────────┘    └────────────────────────────────┘
```

This is the load-bearing observation. A new contributor opening this repo with a typical-Next.js mental model will expect Server Components and SSR and `revalidate`; they will find none of it. The `AGENTS.md` warning ("This is NOT the Next.js you know") is documenting this gap.

#### platform constraints from Vercel

Three platform realities shape the runtime:

```
  Layers-and-hops — Vercel constraints on the runtime

  ┌─ Vercel platform ─────────────────────────────────────────┐
  │                                                            │
  │  1. ephemeral functions      hop A: cold start / warm hit   │
  │     instances spin up + down  ─── shared module-level state │
  │                                   only lives on warm hits   │
  │                                                            │
  │  2. 300s budget on Pro       hop B: route exceeds → killed  │
  │     maxDuration = 300         ─── partial progress preserved│
  │                                   via NDJSON stream         │
  │                                                            │
  │  3. per-deploy hostnames     hop C: redirect_uri must match │
  │     x-forwarded-host          ─── connect.ts derives URI    │
  │                                   from request headers      │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

Each constraint shapes a specific piece of the code. Ephemeral functions are why the auth store has a cookie backend instead of memory. The 300s budget is why streaming exists and why every phase is signal-aware. Per-deploy hostnames are why `redirectUri()` reads `x-forwarded-host` from `next/headers` instead of a static config value.

### Move 3 — the principle

A framework can be a *runtime* (the surface you build against) or an *architecture* (the shape your code takes). They are different decisions. Next.js is famously both; this repo uses it as the first and rejects it as the second. The reason: this app is an authenticated, agent-driven, real-time-streaming tool. SSR is hostile to authenticated content. Server Components don't compose with NDJSON streaming. ISR is meaningless for live data. The runtime features (route handlers + streaming + cookies + budget) earn their keep; the rendering features would actively get in the way.

The transferable lesson: when picking a framework, separate "what's the runtime model" from "what's the rendering model." A framework's rendering model can be irrelevant to your application without making the framework wrong — you're using one half of it. The honest framing is "this app uses Next.js for the App Router + streaming + cookies + maxDuration; we don't use SSR/ISR/Server Components/etc." That sentence is the architecture choice. Hiding it costs the next contributor a week of confusion.

## Primary diagram

```
  framework-runtime-only — full picture

  ┌─ UI layer (this repo, client-only) ─────────────────────────────────────┐
  │  app/page.tsx                              'use client'                  │
  │  app/investigate/[id]/page.tsx             'use client'                  │
  │  app/investigate/[id]/recommend/page.tsx   'use client'                  │
  │  app/layout.tsx                            (root shell, server boundary  │
  │                                             but no fetching)             │
  │  → all data flows through hooks (fetch + readNdjson + sessionStorage)    │
  └────────────────────────────┬────────────────────────────────────────────┘
                               │
  ┌─ Framework runtime (Next.js, App Router) ──────────────────────────────┐
  │                                                                          │
  │  File conventions:                                                       │
  │    app/api/*/route.ts → exported GET/POST/… → mounted as API routes      │
  │    app/.../page.tsx   → mounted as pages                                 │
  │                                                                          │
  │  Helpers used:                                                           │
  │    next/headers cookies()        → read+write request/response cookies    │
  │    next/server NextRequest       → URL parsing (req.nextUrl)             │
  │    next/server NextResponse.json → JSON response w/ status               │
  │                                                                          │
  │  Runtime escape hatches used:                                            │
  │    Response with ReadableStream body  → streaming NDJSON                 │
  │    export const maxDuration = 300     → per-route serverless budget      │
  │    process.env.NODE_ENV switching     → dev/prod/test backends           │
  │                                                                          │
  │  Features NOT used:                                                      │
  │    Server Components (user space)                                        │
  │    SSR / SSG / ISR / revalidate / cache tags                             │
  │    middleware                                                            │
  │    next/image · next/font · next/script                                  │
  │    Server Actions / form actions                                         │
  │    generateStaticParams · generateMetadata                               │
  │    edge runtime (functions run on the default node runtime)              │
  └────────────────────────────┬────────────────────────────────────────────┘
                               │
  ┌─ Vercel platform ─────────▼────────────────────────────────────────────┐
  │  Pro plan, default node runtime                                          │
  │  300s function budget (claimed via maxDuration)                          │
  │  ephemeral instances (shared module state only on warm hits)             │
  │  per-deploy hostnames via x-forwarded-host                               │
  │  encrypted env vars (ANTHROPIC_API_KEY, AUTH_SECRET, BLOOMREACH_MCP_URL)│
  └─────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why no Server Components in user space.** Server Components fetch on the server, then send serialized React to the browser. The data they fetch has to be available *at render time*. This app's data isn't — the LLM-driven scan takes 30-60 seconds and streams. A Server Component would have to wait for `agent.scan()` to complete before rendering, which defeats the streaming UX. Suspense boundaries with streaming would help only for *static* fragments around dynamic data; here the dynamic data is the entire page. The simpler shape is a client component that opens a `fetch` and renders as it reads — which is exactly what `app/page.tsx` does.

**Why no middleware.** Middleware runs on every request before the route handler. The two things middleware would buy here — auth and logging — are both better in the route handler: auth because it's a per-route concern (the demo path skips auth entirely), logging because the per-route `console.log` lines with phases and timings carry route-specific structure (`phase` names differ between briefing and agent). Middleware would just add a global indirection without removing per-route logic.

**Why `maxDuration = 300` is the right number.** Vercel Pro tops out at 300s. The monitoring scan with 10 categories at ~1.1s spacing per call, ~6 calls per category, plus the schema bootstrap (~2-5s) and tool listing (~1s), comes in well under 60s on most workspaces but can push past it on workspaces with slow EQL or deep history. 300s is "the most we're allowed"; the right number is "ceiling." If the budget became a real ceiling, the architectural move is to split the scan across requests (one category per call, UI orchestrates) — not to negotiate a longer budget.

**The "is this actually live?" question.** Because the UI is entirely client-side, "demo vs live" is fully a *runtime* decision based on `localStorage` (`bi:mode`). There's no SSR boundary that could leak a pre-rendered insight; there's no `revalidate` window that could serve a stale snapshot as if it were fresh. The demo path is unambiguously a deliberate replay (the URL even contains `?demo=cached`). → see `08-demo-replay-as-reliability.md`.

## Interview defense

**Q: This is a Next.js app — why don't you use Server Components or SSR?**

> Because the data isn't available at render time. The LLM-driven monitoring scan takes 30 to 60 seconds and streams its progress; an SSR pass would have to await the whole scan before sending HTML, which defeats the entire UX of "watch the agent work in real time." The right shape is what we have: a client-side fetch that reads an NDJSON response and renders progressively. SSR would also conflict with the auth model — the app is gated behind OAuth tokens that live in encrypted cookies, and the demo mode is gated behind a `localStorage` flag, neither of which makes sense to pre-render on the server. So Next.js is here for its *runtime* features — App Router file conventions, streaming responses via `ReadableStream`, cookie helpers in `next/headers`, the `maxDuration` budget — and the rendering features are unused on purpose.

```
  framework split — what we use, what we don't

  RUNTIME (used)              RENDERING (not used)
  ────────────────            ────────────────────
  App Router files            Server Components
  route.ts handlers           SSR / SSG / ISR
  ReadableStream body         revalidate / cache tags
  next/headers cookies()      middleware
  maxDuration export          next/image · next/font
  NODE_ENV switching          Server Actions
```

**Anchor:** the warning in `AGENTS.md` ("This is NOT the Next.js you know") and the absence of any `'use server'` directive or `revalidate` export in the codebase.

**Q: Walk me through `maxDuration = 300`. What does that buy you and what would break without it?**

> Vercel's default serverless function ceiling is around 60 seconds; Pro lets you raise it to 300. `export const maxDuration = 300` in `app/api/briefing/route.ts` and `app/api/agent/route.ts` claims that ceiling per route. Without it, the route would be killed mid-stream on any workspace where the monitoring scan exceeds 60s — which is most of them once you add up the schema bootstrap (a few seconds), the rate-limited MCP calls at 1.1s spacing each, and the LLM turns. The user would see the UI freeze at whatever event happened to be the last one before the kill, with no error message — the connection would just terminate. Streaming makes the partial progress visible, but the 300s budget is what gives the scan room to complete in the common case. If 300s ever became the actual ceiling for a real workspace, the architectural move would be to split the scan across multiple requests with the UI orchestrating — not to ask Vercel for a longer budget.

```
  the budget chain

  scan call 1 ┐
  scan call 2 │
  scan call 3 │  ──► all add up to a single route invocation
  …           │       which has a hard ceiling
  scan call N ┘

  default Vercel ceiling: ~60s
  Pro ceiling (claimed):  300s ← export const maxDuration = 300
```

**Anchor:** `app/api/briefing/route.ts:19`, `app/api/agent/route.ts:22`.

**Q: What's the most surprising piece of "Next.js as runtime" if I came from a typical Next.js app?**

> Three surprises, ranked. (1) The `await cookies()` API has a request-vs-response split — a read after a write in the same request returns the OLD value, which is why `withAuthCookies` uses `AsyncLocalStorage` to hold a per-request store and only writes the cookie once at the end. (2) `ReadableStream` as a `Response` body is the runtime feature that makes the live agent path possible; without it, the route would have to buffer the whole scan result before responding. (3) The complete absence of Server Components, SSR, middleware, `next/image`, and revalidation — features that justify Next.js in most apps simply don't appear here. The `AGENTS.md` warning is documenting that last one specifically.

```
  the three surprises, in order

  1. cookies() request/response split → ALS in withAuthCookies
  2. ReadableStream as Response body  → entire live agent UX
  3. zero Server Components / SSR / middleware / next/image
```

**Anchor:** `lib/mcp/auth.ts:86-104`, `app/api/briefing/route.ts:190-200`, the `AGENTS.md` warning in the repo root.

## See also

- `01-request-flow.md` — where the route handler shape is exercised end-to-end
- `02-auth-boundary.md` — the cookie helper's request/response split
- `06-streaming-ndjson.md` — the `ReadableStream` body in detail
- `08-demo-replay-as-reliability.md` — why client-side mode switching is honest about live vs replay
