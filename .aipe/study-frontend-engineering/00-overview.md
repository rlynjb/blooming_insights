# Frontend Engineering — Overview

One-page orientation. The reader who skims only this file knows what the frontend of this repo is.

## What this repo is, at the frontend layer

A Next.js 16 App Router app that puts **a long-running multi-agent process on the screen as a first-class surface**. The product isn't "show the answer when the answer arrives" — it's "show the work happening, line by line, while the agents run." Every routed page is `'use client'`; the entire interactive surface ships as one client bundle. The framework's server-rendering and streaming primitives (RSC, Suspense, `loading.tsx`, `error.tsx`) are deliberately not used — those serve request-response, and this product is a stream.

The rendering mode in one sentence: **a client SPA inside Next.js, hand-feeding itself NDJSON from Route Handlers.**

## State architecture in one diagram

State doesn't live in a global store. It lives in three concentric rings, each owned by exactly one place — and almost everything that crosses pages is carried by the browser, not the server.

```
  State ownership — three concentric rings, one owner per ring

  ┌─ Page-local (React state) ─────────────────────────────────┐
  │  useBriefingStream → 9 useState slots (insights, coverage, │
  │                       trace, status, errorMessage, …)      │
  │  useInvestigation  → 5 useState slots (items, diagnosis,   │
  │                       recommendations, complete, error)    │
  │  app/page.tsx      → 3 (mode, ready, activeQuery)          │
  └──────────────────────────────┬─────────────────────────────┘
                                 │ result stashed on `done`
                                 ▼
  ┌─ Cross-page (sessionStorage, per-tab) ─────────────────────┐
  │  bi:insight:<id>     feed → investigate (the subject)      │
  │  bi:diag:<id>        step 2 → step 3 (the diagnosis)       │
  │  bi:inv:<step>:<id>  re-visit / back-nav (instant hydrate) │
  │  bi:reconnecting     one-shot guard against reload loops   │
  └──────────────────────────────┬─────────────────────────────┘
                                 │
                                 ▼
  ┌─ Cross-session (localStorage) ─────────────────────────────┐
  │  bi:mode             demo · live-bloomreach · live-synth   │
  └────────────────────────────────────────────────────────────┘

  No Redux. No Zustand. No React Query. No Context. No global store.
  Each ring has exactly one writer and a documented invalidation rule.
```

The thing to notice: there is **no client-side data layer**. The hook IS the data layer. Each streaming surface (briefing, investigation, free-form query, capture) owns its own `fetch + readNdjson + dispatch + setState + stash` pipeline.

## Network seam in one diagram

The wire format isn't JSON. It isn't SSE either. It's newline-delimited JSON over a plain `fetch` `ReadableStream`, with a 64-LOC kernel that every consumer reuses.

```
  Network seam — one kernel, four consumers

  ┌─ UI layer (browser) ───────────────────────────────────────┐
  │  useBriefingStream    useInvestigation                     │
  │  useDemoCapture       StreamingResponse                    │
  │       │       │       │       │                            │
  │       └───────┴───┬───┴───────┘                            │
  │                   ▼                                        │
  │  lib/streaming/ndjson.ts — readNdjson<E>(body, onEvent)    │
  │    fetch → reader → TextDecoder → split('\n') →            │
  │    JSON.parse → onEvent → poll cancelOn between reads      │
  └───────────────────────────┬────────────────────────────────┘
                              │  HTTP/1.1 chunked, ndjson body
  ┌─ Service layer (Next Route Handlers) ──────────────────────┐
  │  GET /api/briefing  GET /api/agent  POST /api/mcp/*        │
  │  → ReadableStream that writes `JSON.stringify(evt) + '\n'` │
  └────────────────────────────────────────────────────────────┘
```

Producer always terminates events with `\n`; consumer always flushes a trailing partial buffer; malformed lines are silently skipped. The kernel is the canonical place this lives — see `01-ndjson-stream-reader-hook.md`.

## The three highest-leverage frontend patterns

If you only learn three things about this frontend, learn these:

1. **NDJSON stream-reader hook** — `lib/streaming/ndjson.ts` (64 LOC) consumed by 4 hooks/components. Pinned in `01-ndjson-stream-reader-hook.md`. This is the load-bearing primitive — it is what makes the product "an analyst that shows its work" technically tractable.

2. **Progressive composition (4 tiers)** — `Skeleton` + `ProcessStepper` + `CoverageGrid` + `StatusLog`. Turns a 30-90s agent run from "blank screen until done" into a UI that animates from the first 100ms. Pinned in `02-progressive-skeleton-with-stepper.md`.

3. **sessionStorage cross-step handoff** — the feed stashes each `Insight` under `bi:insight:<id>`; step 2 stashes the `Diagnosis` under `bi:diag:<id>`; step 3 reads it and passes it to the agent via URL param. The browser carries the data across, because on Vercel the feed and the investigation request can hit different serverless instances and server-side in-memory lookup is unreliable.

## What this frontend deliberately does NOT do

Calling these out is the lesson — each absence is a deliberate tradeoff, not an oversight.

- **No Server Components.** Every page is `'use client'`. The interactivity surface is the whole page; SSR-vs-CSR boundaries would split work that wants to stay together.
- **No Suspense / `loading.tsx` / `error.tsx`.** Those are request-response primitives. A stream needs progressive composition, not a single fallback state.
- **No React Query / SWR.** No cache key, no stale-while-revalidate, no retry policy. The data is a stream, not a request — query libraries don't model the shape.
- **No Context, no global store.** State sits inside hooks; cross-page handoff is sessionStorage. The result is that you can read any page top-to-bottom without chasing a provider chain.
- **No `next/image`.** The UI is text, chips, sparklines, and inline SVG (`Sparkline`, `GapChart`). Lucide icons are tree-shaken React components, not raster images.

## Stack at the frontend layer

- Next.js 16.2.6 (App Router) + React 19.2.4 + TypeScript 5
- Tailwind v4 (CSS-first, via `@import "tailwindcss"` in `app/globals.css`), dark mode only (`<html class="dark">` in `app/layout.tsx:20`)
- Custom CSS keyframes for streaming UI: `bi-fade-up`, `bi-progress` (indeterminate bar), `bi-dots` (pulsing thinking dots) — all gated on `prefers-reduced-motion`
- Design tokens as CSS custom properties on `:root` (`--bg-base`, `--text-primary`, `--accent-teal`, etc.) — every component reads from `var(--token)` inline; Tailwind utilities are used sparingly for layout
- Fonts: Syne (display) + Inter (body) + JetBrains Mono via `next/font/google` in `app/layout.tsx`
- Icons: `lucide-react` (tree-shaken), inline SVG for charts
- Routing: file-based App Router, three routes total (`/`, `/investigate/[id]`, `/investigate/[id]/recommend`) + a `/debug` page

## Where to read next

- `audit.md` — the 8-lens frontend audit with `file:line` grounding for every claim
- `01-ndjson-stream-reader-hook.md` — the deep walk on `useInvestigation` + the shared `readNdjson` kernel
- `02-progressive-skeleton-with-stepper.md` — the deep walk on the 4-tier progressive composition

Cross-links to neighboring guides:

- Wire semantics / chunked transport / `EventSource` vs `fetch+ReadableStream` → `study-networking`
- The event loop, scheduling, async cancellation under the hood → `study-runtime-systems`
- FCP / LCP / TTI / bundle size as numbers → `study-performance-engineering`
- XSS / CSP / token storage trust boundaries → `study-security`
- Module depth / interface design (Ousterhout primitives applied to these hooks) → `study-software-design`
- System-level state ownership / multi-agent orchestration → `study-system-design`
