# Frontend Engineering — Audit (Pass 1, 8 lenses)

One `##` section per lens. Each finding is grounded in `file:line`. Where a lens has a deep walk in a Pass 2 pattern file, the section cross-links rather than re-explaining.

## 1. rendering-and-reactivity

The rendering mode is a **client SPA inside a Next.js App Router shell**. Every routed page declares `'use client'` at line 1 (`app/page.tsx:1`, `app/investigate/[id]/page.tsx:1`, `app/investigate/[id]/recommend/page.tsx:1`, `app/debug/page.tsx:1`). The Server Components feature is not used; the only server work that runs on the route boundary is the layout (`app/layout.tsx`), which is a static shell with no data fetching.

The reconciliation model is React 19's virtual-DOM diffing. Scheduling is React's default (sync inside event handlers, batched setState). The `concurrent` features in React 19 (`useTransition`, `useDeferredValue`, Suspense for data) are **not yet exercised** — the streaming UI does its own progressive composition via direct `setState` from inside `readNdjson` event handlers, which gives finer-grained control than `useTransition` would.

When work actually happens: every page mounts → fires its `useEffect` → opens a `fetch` → drains an NDJSON stream → calls `setState` per event. The `bi-fade-up` keyframe (`app/globals.css:37-42`) provides per-item entrance animation; React reconciles, the browser paints, the next event arrives, repeat. There is no SSR pass, no hydration step (because nothing was server-rendered), and no commit-phase optimization (`memo`, `useMemo`, `useCallback` appear only in `useReconnectPolicy` and `useDemoCapture` to stabilize the callback identity for effect dependencies — not for render-perf).

`reactStrictMode` is on (Next default). Both stream-reading hooks defend against the dev-mode mount→cleanup→re-mount cycle:

- `useInvestigation` uses a `startedRef` latch (`lib/hooks/useInvestigation.ts:44, 48-49`) and explicitly does NOT cancel the fetch on cleanup — the comment at L33-37 explains why: cancelling-on-cleanup with the started-guard blocking the re-mount aborted the stream and left the logs empty
- `useBriefingStream` uses a `cancelledRef` latch reset on every effect run (`lib/hooks/useBriefingStream.ts:130, 152, 297-299`) — combined with `cancelOn` polling in `readNdjson` (`lib/streaming/ndjson.ts:33-36`), the previous run cancels cleanly while the new run starts fresh

→ For the deep walk on the streaming pattern, see `01-ndjson-stream-reader-hook.md`.

Cross-link: the runtime event loop and microtask scheduling underneath these effects belong to `study-runtime-systems`.

## 2. state-architecture

State lives in three concentric rings with one owner per ring — no Redux, no Zustand, no React Query, no Context.

**Local component / hook state (React `useState`).** The page-decomposition refactor extracted three hooks from what was a 817-LOC `app/page.tsx`:

- `useBriefingStream` — 9 `useState` slots (`lib/hooks/useBriefingStream.ts:108-120`): status, insights, workspace, errorMessage, demoSuffix, stepStatus, queryCount, traceItems, coverage
- `useInvestigation` — 5 `useState` slots (`lib/hooks/useInvestigation.ts:39-43`): items, diagnosis, recommendations, complete, error — plus a `startedRef` latch and **closure mirrors** (`cItems`, `cDiag`, `cRecs` at L66-68) that are written synchronously inside the event handler so the `done` event can stash a complete object even when the React setStates haven't flushed yet
- `useReconnectPolicy` — 1 `useState` slot (`lib/hooks/useReconnectPolicy.ts:69`): reconnecting, plus a sessionStorage-backed one-shot guard

`app/page.tsx` retains 3 `useState` slots (mode, ready, activeQuery) and composes the three hooks together (`app/page.tsx:46-118`).

**Cross-page state (`sessionStorage`).** Four keys, each with one writer:

| key | written by | read by | invalidation |
|-----|-----------|---------|--------------|
| `bi:insight:<id>` | `useBriefingStream.stashInsights` at L53-60 | `useInvestigation` L170 (for `?insight=`), `InvestigationSubject` L17 | overwritten next briefing |
| `bi:diag:<id>` | `useInvestigation` on `done` when step==='diagnose' at L139-141 | `useInvestigation` on mount when step==='recommend' at L73-85 | overwritten next diagnosis |
| `bi:inv:<step>:<id>` | `useInvestigation` on `done` at L134-137 | `useInvestigation` on mount at L52-65 | overwritten next run of same step |
| `bi:reconnecting` | `useReconnectPolicy.handle` L102-106 | `useReconnectPolicy.handle` L88-101 | cleared by `clearFlag` on `done` |

**Cross-session state (`localStorage`).** One key: `bi:mode` (`app/page.tsx:71-78, 87-92`) — `demo` | `live-bloomreach` | `live-synthetic`, default `demo`. Unrecognized legacy values fall through to the `live-bloomreach` branch on read.

Form state: minimal. `QueryBox` holds one `useState<string>` (`components/chat/QueryBox.tsx:13`). No form library. URL state: route params via `useParams<{ id: string }>()` (`app/investigate/[id]/page.tsx:34`). Server state: there is no client cache — each hook re-fetches on mount unless it finds a stash.

Cross-link: system-level state ownership (auth cookies, in-memory caches on the route side) → `study-system-design`.

## 3. component-architecture

Composition is **flat, prop-driven, and almost entirely presentational**. The pattern catalog:

- **Pages compose hooks + components.** Each routed page is a small composition root: read params, run the relevant hook, render a header + `ProcessStepper` + a 2/3-1/3 grid (col 1 content, col 2 `StatusLog`). The pages are mostly markup with a handful of derived-state lines (`monitoringState`, `monitoringSub` at `app/page.tsx:20-40`; `diagState`, `diagSub` at `app/investigate/[id]/page.tsx:46-50`).
- **Shared shell components carry the layout grammar.** `ProcessStepper` (`components/shared/ProcessStepper.tsx`) renders the three-stage status bar identically on every page; `StatusLog` (`components/shared/StatusLog.tsx`) wraps `ReasoningTrace` in a sticky sidebar. Both take props, hold no state.
- **Feed components are pure data → markup.** `InsightCard` (495 LOC, `components/feed/InsightCard.tsx`) takes one `Insight` prop and computes everything else: derived currency formatting, severity colors, funnel-leak detection, scope explanation. No state, no effects. `SeverityBadge` (`components/feed/SeverityBadge.tsx`, 29 LOC) is the minimum-viable component — one prop, one styled span.
- **Investigation components mirror the same shape.** `EvidencePanel`, `RecommendationCard`, `ReasoningTrace`, `ToolCallBlock` — each takes one shaped prop and renders. `ToolCallBlock` is the rare exception with a `useState` (`components/investigation/ToolCallBlock.tsx:25`) for an expand/collapse toggle.
- **Skeletons are shape-mirroring siblings.** `RecommendationCardSkeleton` (`components/investigation/RecommendationCardSkeleton.tsx`) is laid out as a deliberate shape-mirror of `RecommendationCard` — same boxes in the same grid so the layout doesn't shift when real data swaps in. See `02-progressive-skeleton-with-stepper.md`.

What's NOT exercised: **no compound components** (no `<Card.Header>` / `<Card.Body>` API), **no render props**, **no headless component pattern**, **no slots beyond React's implicit `children`**. Container-vs-presentational is collapsed: pages and hooks are the "containers"; everything in `components/` is presentational.

**Boundary placement note.** The biggest visible component is `InsightCard` at 495 LOC, almost entirely formatting helpers + JSX. The size is shape-driven (the card has many optional sections: severity row, headline, summary, metric tiles, sparkline, funnel chip, prior-now comparison, scope chips, why-it-matters callout, downstream-ready footer) — splitting it would create N small components that share the same prop and don't compose anywhere else. Acceptable.

Cross-link: module depth / interface earning its place (Ousterhout primitives applied to these hooks specifically — `useInvestigation` as a deep module) → `study-software-design`.

## 4. data-fetching-and-cache

Server state crosses into client state through **one shape, four places**: `fetch → readNdjson → switch(evt.type) → setState`. There is no fetch wrapper layer, no query library, no route loader (App Router has no client-side loader concept in this version), no `cache: 'no-store'` flag, no `revalidate` tag — the streams are explicitly uncached.

The four consumers:

1. `useBriefingStream` → `GET /api/briefing?demo=cached | ?mode=live-bloomreach | ?mode=live-synthetic` — 9-case event dispatcher (`lib/hooks/useBriefingStream.ts:204-286`), handles both the demo branch (plain JSON body, no NDJSON) and the live branch (NDJSON stream)
2. `useInvestigation` → `GET /api/agent?insightId=...&step=diagnose | recommend` — 6-case event dispatcher (`lib/hooks/useInvestigation.ts:98-152`)
3. `useDemoCapture.runInvestigation` → `GET /api/agent?insightId=...&insight=<encoded>` — 2-case event dispatcher (just watching for `done`/`error`, `lib/hooks/useDemoCapture.ts:84-87`)
4. `StreamingResponse` (chat) → `GET /api/agent?q=...` — 4-case event dispatcher (`components/chat/StreamingResponse.tsx:30-88`)

**Cache strategy.** There is no client cache. The closest thing is **sessionStorage stashes used as a per-tab cache**:

- `useInvestigation` mount checks `sessionStorage.getItem(stashKey(step, id))` BEFORE the fetch (`lib/hooks/useInvestigation.ts:52-65`) — a re-visit / back-nav hydrates instantly without re-running the agents
- `useBriefingStream` stashes the insights so `useInvestigation` can ship them to the agent as `?insight=<json>` (workaround for Vercel's stateless function instances — server-side in-memory lookup is unreliable across calls)

**Mutations.** Three POST endpoints exist (`/api/mcp/reset`, `/api/mcp/capture`, `/api/mcp/capture-demo`); they are fire-and-then-reload or fire-and-then-bundle. No optimistic UI, no rollback — the agents are too slow for optimistic updates to land before the real result.

**Error and retry behavior.** Per stream: on a 401, the route returns JSON with `{ needsAuth, authUrl }`; the hook redirects to `authUrl` (`lib/hooks/useInvestigation.ts:181-186`, `useBriefingStream.ts:163-167`). On any non-OK status, the hook surfaces the error message into state. On an in-stream `error` event with an auth-shaped message, `useReconnectPolicy` fires a one-shot `POST /api/mcp/reset` → `window.location.href = '/'` reload, guarded by `sessionStorage bi:reconnecting` so it can't loop (`lib/hooks/useReconnectPolicy.ts:84-110`).

Cross-link: wire semantics (chunked transfer, `EventSource` vs `fetch+ReadableStream`) → `study-networking`. Cache-as-architecture (the per-investigation cache on the route side) → `study-system-design`.

## 5. routing-and-navigation

Three routes, all file-based, all client. Route table:

| route | file | dynamic param | client component |
|-------|------|---------------|------------------|
| `/` | `app/page.tsx` | — | yes |
| `/investigate/[id]` | `app/investigate/[id]/page.tsx` | `id` | yes |
| `/investigate/[id]/recommend` | `app/investigate/[id]/recommend/page.tsx` | `id` | yes |
| `/debug` | `app/debug/page.tsx` | — | yes |

**Code-splitting at the route boundary.** Implicit, from Next's App Router behavior — each `page.tsx` is a separate chunk. Not measured here; that's `study-performance-engineering`'s job.

**Navigation lifecycle.** Standard `next/link` prefetch (`components/feed/InsightCard.tsx:1`, `components/feed/CoverageGrid.tsx:3`, `components/shared/ProcessStepper.tsx:2`). No `Suspense` boundaries — there's no `loading.tsx` / `error.tsx` at any route level. Navigation feels instant because the destination page hydrates from a `sessionStorage` stash (the insight) immediately and then opens its own stream.

**Guards / redirects.** Auth is per-fetch, not per-route: each stream-opening hook checks for a 401 response and, if it carries `{ needsAuth, authUrl }`, does `window.location.href = authUrl` (`lib/hooks/useInvestigation.ts:183-185`, `lib/hooks/useBriefingStream.ts:163-167`). No middleware-level guards in the route tree.

**Scroll restoration.** Default Next behavior — not customized.

**Deep-linking.** Two URL query params carry cross-step intent: `?insight=<json>` (the feed hands the anomaly to `/api/agent` via the URL, since per-instance server memory is unreliable on Vercel) and `?diagnosis=<json>` (step 3 hands the step-2 diagnosis to the recommendation agent the same way). See `useInvestigation.ts:167-174`.

**The stepper-as-router.** `ProcessStepper` (`components/shared/ProcessStepper.tsx:126-130`) accepts an optional `href` per step and renders that step as a `next/link` — turning the status bar itself into the cross-step navigation surface. The current step never gets `href`, so it stays inert while you're on it.

## 6. styling-and-design-system

**CSS architecture: hybrid token-first.** Tailwind v4 is the build / utility-class layer (`@import "tailwindcss"` at `app/globals.css:1`), but the bulk of styling is **CSS custom properties read via inline `style={{ color: 'var(--token)' }}`**. Tailwind utilities appear for layout primitives (`grid grid-cols-1 lg:grid-cols-3`, `text-3xl`, `lowercase`, `min-h-screen`, `mx-auto`, `max-w-5xl`) and rarely for color (because the tokens already encode the palette).

**Design tokens.** A single `:root` block in `app/globals.css:3-15` defines 12 tokens:

```
--bg-base, --bg-surface, --bg-elevated, --border
--text-primary, --text-secondary, --text-tertiary
--accent-teal, --accent-coral, --accent-amber, --accent-purple
```

The `@theme inline` block (`app/globals.css:17-23`) maps them to Tailwind v4's CSS-first theme. The token set is small and complete — no semantic-vs-primitive split, no scale numbers (no `--text-100`, `--bg-700`), no per-component overrides. Every component reads the same names.

**Theming.** **Dark mode only.** `<html lang="en" className="dark">` is hard-coded in `app/layout.tsx:20`. There is no light-mode palette, no theme toggle, no `prefers-color-scheme` listener. The token values are the dark palette directly — not a mapping. If a light theme were added later, every component would Just Work because they all read `var(--text-primary)` etc., but the actual token *values* would need to swap (today they're literals, not nested vars).

**Responsive strategy.** Mobile-first Tailwind breakpoints, used sparingly. The two-column layout flips at `lg:` (1024px+): `grid-cols-1 lg:grid-cols-3` then `lg:col-span-2` for col 1 (`app/page.tsx:270, 272`). The coverage grid uses CSS Grid `auto-fill, minmax(190px, 1fr)` (`components/feed/CoverageGrid.tsx:116`) — fluid, no breakpoint.

**Animation system.** Three custom keyframes in `app/globals.css:37-79`:

- `bi-fade-up` (0.4s ease) — every dynamic item that appears (cards, trace items, recommendations)
- `bi-progress` (indeterminate bar) — shown while an agent is working
- `bi-dots` (pulsing thinking dots) — shown in `StatusLog` when items haven't arrived yet

All three are gated on `@media (prefers-reduced-motion: reduce)` (L42, L78-80). Tailwind's `animate-pulse` is also used for skeletons (`components/shared/Skeleton.tsx:9`) and the active stepper badge (`components/shared/ProcessStepper.tsx:109`).

**How the design system scales.** With ~12 tokens and ~20 components, the system scales by **convention not enforcement** — there's no token-resolver function, no styled-system, no variant API. Every component inlines `style={{ ... var(--token) ... }}` directly. This is sustainable at current size; would not scale to 100+ components without extracting a tokens-to-component layer.

## 7. browser-platform-and-build

**Web APIs actually touched:**

- `fetch` + `ReadableStream` + `TextDecoder` — the streaming kernel (`lib/streaming/ndjson.ts:28-39`)
- `sessionStorage` — 4 keys (see lens 2)
- `localStorage` — 1 key (`bi:mode`)
- `crypto.randomUUID()` — for trace item IDs (`lib/hooks/useBriefingStream.ts:222`, `useInvestigation.ts:114`)
- `window.location.href = ...` — for the OAuth redirect and the reconnect reload (`useInvestigation.ts:185`, `useReconnectPolicy.ts:79`)
- `window.alert` — for the dev-only capture flow's completion message (`useDemoCapture.ts:128`)
- `Date.parse`, `Date.now`, `toLocaleTimeString` — timestamp formatting (`components/investigation/ReasoningTrace.tsx:42`, `InsightCard.tsx:26`)

**Not exercised:** Service Worker, IndexedDB, WebSocket, EventSource (the team chose `fetch+ReadableStream` over `EventSource` because the latter doesn't support custom headers, doesn't allow POST, and re-connects on its own — see project context), MediaRecorder, Notifications, Push, Web Workers, requestIdleCallback, Intersection Observer, View Transitions.

**Bundler.** Next.js 16's built-in bundler (Turbopack by default in Next 16, though the config doesn't specify either way — `next.config.ts` is empty scaffold at `next.config.ts:3-5`). PostCSS is configured via `postcss.config.mjs` + `@tailwindcss/postcss`.

**Deploy artifact.** Vercel (per project context: Pro plan, `maxDuration = 300` on the streaming routes). The route handlers run as Node serverless functions; the pages ship as a client bundle.

**Code splitting / tree shaking / polyfills / sourcemaps.** Default Next behavior; not customized in `next.config.ts`. Lucide icons are imported individually (`import { TrendingDown, ShoppingCart, ... } from 'lucide-react'` at `components/feed/CoverageGrid.tsx:6-17`), which is the tree-shake-friendly form.

Cross-link: bundle size as a NUMBER, FCP / LCP / TTI measurement, route-chunk weight → `study-performance-engineering`.

## 8. frontend-red-flags-audit

Ranked by user-visible consequence, each grounded in real evidence. The cleanups that already happened (page decomposition, NDJSON kernel extraction) have lifted the highest-leverage debt — what remains is real but lower-impact.

### Rank 1 — Streaming surfaces have NO `aria-live` regions (sighted-user-only experience)

**Evidence.** `grep "aria-live" components/ app/` returns zero hits. The only a11y attributes in dynamic regions are static labels: `role="group" aria-label="analysis pipeline"` on `ProcessStepper.tsx:74-75`, `role="img" aria-label` on `Sparkline.tsx:27-28` and `GapChart.tsx:49-50`, `aria-label={severity}` on `SeverityBadge.tsx:17`.

**User consequence.** `StatusLog`, `CoverageGrid` (tiles streaming in one at a time), `InsightCard` list, `ReasoningTrace` items — none of these announce changes to a screen reader. A blind user opening the feed hears "blooming insights, your workspace in bloom" and then silence for 30-90 seconds while the agents run. When the cards appear, no announcement; when the coverage tiles flip from "checking…" to "anomaly / clear", no announcement; when a tool call completes in the sidebar, no announcement.

**The minimum fix.** A polite `aria-live="polite" aria-atomic="false"` region wrapping the trace area in `StatusLog.tsx` plus an `aria-live="polite"` on the cards container in `app/page.tsx:349`. The coverage grid is trickier because 10 tiles updating individually would chatter — better to announce the summary line (`X anomalies firing, Y clear, Z no data`) when settling completes (`components/feed/CoverageGrid.tsx:97-101`).

**Why it ranks first.** The product narrative is "an analyst that shows its work" — the showing-the-work surface is invisible to a screen reader. This is the gap between "we built a streaming UI" and "we built an accessible streaming UI."

### Rank 2 — Two divergent auth-error regex variants (`useReconnectPolicy.ts:33-34`)

**Evidence.** `AUTH_ERROR_RE_AUTO` includes `invalid_token` and `reconnect`; `AUTH_ERROR_RE_BUTTON` does not. The hook itself documents this at L17-25 as a known latent bug deferred from the strict-preservation lift.

**User consequence.** A user who hits an error message that the auto-reconnect doesn't fire on (because the error came back as an explicit button render, not an in-stream `error` event) will see the "reconnect" button only if the message matches `unauthor|forbidden|401|session expired`. If the message says `invalid_token` plainly, the button doesn't render — the user is stuck.

**Why it ranks here.** Real bug, but rare in practice (the in-stream auto-reconnect fires first on most token-revocation paths). Resolution needs live Bloomreach verification, which is why the refactor deferred it.

### Rank 3 — The investigation hook (`useInvestigation`) deliberately does NOT cancel the fetch on unmount (`lib/hooks/useInvestigation.ts:33-37, 38`)

**Evidence.** The `useEffect` returns no cleanup; the comment block at L33-37 explains: cancelling-on-cleanup + the `startedRef` guard against StrictMode re-mount left the logs empty in dev. The team chose "let the in-flight run complete; setState-after-unmount is a safe no-op."

**User consequence.** When a user clicks an insight card, then immediately clicks the back link before the diagnosis arrives, the agent run continues in the background until the route finishes. On a Vercel serverless function this means real cost (model tokens, MCP calls). The user doesn't see it; the budget does.

**Why it ranks here.** A real cost, but bounded — the agent run is single-shot and finishes within `maxDuration = 300`s. Fix is non-trivial (it requires distinguishing StrictMode re-mount from real unmount, which React doesn't directly expose).

### Rank 4 — The insight card component (`InsightCard`) is 495 LOC of single-file derived state + JSX (`components/feed/InsightCard.tsx`)

**Evidence.** `wc -l components/feed/InsightCard.tsx` → 495. The file has 7 derived-state helpers (`fmtNum`, `fmtUsd`, `daysSince`, `fmtPct`, `humanizeBaseline`, `whyItMatters`, `scopeExplain`, `readEvidence`) and a 320-line JSX body with 9 optional render sections.

**User consequence.** None directly — the card renders the same. The cost is to **the next engineer who needs to touch this component**: a change to the funnel chip ripples through the same file as a change to the severity row.

**Why it ranks here.** A code-health concern, not a user-facing one. The card's size is shape-driven (the data model genuinely has many optional fields), so splitting it into N tiny components that only ever co-render here would trade locality for fragmentation. Acceptable as-is; flagging so it's deliberate, not accidental.

### Rank 5 — Inline `style={{ ... }}` objects everywhere — no theme-tier abstraction

**Evidence.** Every component reads tokens via `style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono), monospace', ... }}`. The pattern repeats across all 20 components. There is no `<Text>` / `<Button>` / `<Card>` primitive that bakes the token reads in.

**User consequence.** None directly. The cost is **divergence risk over time** — when a new token (`--accent-purple`) gets added, there's no central place to surface it, so adoption depends on the next person remembering to use it.

**Why it ranks last.** This is the "design system scaling" lens-6 concern made concrete. At 20 components and 12 tokens, convention scales fine. The fix (extract a `<Text variant="display" tone="primary">` primitive) is premature optimization at current scope. Worth re-evaluating if the component count doubles.

### Lenses with nothing to flag

- **Component re-render on every keystroke.** The only mutable input is `QueryBox` (`components/chat/QueryBox.tsx:13`) — one `useState<string>` local to the component, no parent state, no derived computation triggered by typing. Clean.
- **State stored where it can't be invalidated.** Every sessionStorage key has a documented writer and overwrite point (see lens 2 table). The one-shot reconnect flag has both a setter and a `clearFlag`. Clean.
- **Route boundaries blocking FCP.** All routes are client + dynamic; no SSR data fetches in the way. FCP is the layout shell. Clean (as a render-strategy choice — performance numbers belong to `study-performance-engineering`).
