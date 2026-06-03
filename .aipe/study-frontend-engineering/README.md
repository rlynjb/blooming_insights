# Study — frontend engineering

This guide takes the **current blooming insights repo** and walks its frontend layer in two passes:

- **Pass 1 — `audit.md`.** One section per lens in the 8-lens inventory (rendering-and-reactivity, state-architecture, component-architecture, data-fetching-and-cache, routing-and-navigation, styling-and-design-system, browser-platform-and-build, frontend-red-flags-audit). Verdict-first, every claim grounded in a `file:line` reference. Cross-links to each pattern file when a finding warrants the deeper walk.
- **Pass 2 — 2 discovered-pattern files.** Named after the frontend-specific patterns this codebase actually exercises. Each uses the full per-concept template — Zoom out → Structure pass → How it works → Primary diagram → Implementation in codebase → Elaborate → Interview defense → Validate → See also.

Two patterns, not five. The other findings that earn pattern-file treatment in this repo (the 817-LOC `app/page.tsx`, the `sessionStorage` cross-step handoff) already live in neighboring audits — they're called out in `audit.md` with a cross-link rather than re-derived through the frontend lens.

## Reading order

1. **[audit.md](./audit.md)** — the lens-by-lens audit (Pass 1). Skim this first; it tells you which pattern files to open next.
2. **Pattern files (Pass 2).** Open the ones whose names match what you're trying to understand:
   - [01-ndjson-stream-reader-hook.md](./01-ndjson-stream-reader-hook.md) — `useInvestigation` as the load-bearing data-fetch primitive: a `fetch` + `ReadableStream` reader loop driving five `useState` slots, line-buffered NDJSON dispatched to event handlers.
   - [02-progressive-skeleton-with-stepper.md](./02-progressive-skeleton-with-stepper.md) — the skeleton + stepper + coverage-grid composition that turns a 30-60s agent run into a UI that animates from the first 100ms.

## Cross-links to neighboring guides

Frontend engineering owns the framework-and-platform layer. The other axes live elsewhere:

- **Module depth in the page component** (the 817-LOC `app/page.tsx`) → `study-software-design/02-shallow-module-page-component.md`. The shallow-module diagnosis IS the headline frontend red flag, but the pattern lens belongs to APOSD.
- **The `sessionStorage` cross-step handoff + StrictMode started-guard** → `study-system-design/07-client-stream-handoff.md`. The hook in this guide is the *data-fetch primitive*; the cross-step state ownership is the *system-level seam*.
- **NDJSON wire format + cache-replay producer side** → `study-system-design/05-streaming-ndjson.md`. The producer lives in the route layer; the consumer lives here.
- **Accessibility surface** → `.aipe/audits/a11y-2026-06-02.md`. The semantic-HTML / ARIA / focus posture is described there in detail; the styling-and-design-system lens here references the headline gaps without restating them.
- **Performance measurement** (FCP / LCP / TTI / bundle size as numbers) → `study-performance-engineering`. This guide names the *patterns* that drive perceived performance; the *numbers* belong there.
- **XSS / CSP / token storage / output sanitization** → `study-security`. The QueryBox + StreamingResponse path is described here as a UI flow; the trust-boundary analysis lives there.
- **Event loop, async tasks, AbortController, ALS** → `study-runtime-systems`.
- **HTTP / fetch / NDJSON on the wire** → `study-networking`.

## The verdict, in one paragraph

The frontend layer is small, deliberately framework-light, and shaped by one constraint that doesn't fit React's defaults: a 30-60s NDJSON stream that IS the product. The codebase reaches for Next.js 16 App Router + React 19 + Tailwind 4 and uses almost none of what each one offers — no Server Components in the routed surface (every page is `'use client'`), no Suspense boundaries, no `loading.tsx` / `error.tsx`, no React Query / SWR, no global store, no design-token layer beyond the CSS variables on `:root`. State is plain `useState` (and a lot of it — 14 slots in the feed page), data-fetching is hand-written `fetch` + `ReadableStream` reader loops in two places (`app/page.tsx` and `lib/hooks/useInvestigation.ts`), and styling is Tailwind-on-the-page-shell + inline `style={{}}` with CSS variables on every leaf. Two patterns earn pattern-file treatment because they're load-bearing for what users see: the **NDJSON reader hook** (`useInvestigation`) that drives the live agent trace, and the **progressive skeleton + stepper composition** that turns a 30-60s wait into a UI that animates from the first event. Everything else either inherits a known smell (the 817-LOC page, the inline-vs-Tailwind drift) named in neighboring guides, or is a stretch of Next.js / React 19 surface area the repo simply hasn't exercised yet.

---

Generated: 2026-06-03 — initial generation as v1.62.0 audit-style frontend-engineering guide.
