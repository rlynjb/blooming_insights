# audit — frontend-engineering layer of blooming insights

Pass 1 of two. Eight lenses walked in order against the framework-and-platform layer of the current repo. Findings are grounded in `file:line` evidence; when a lens has nothing this repo exercises yet, it's named `not yet exercised` without padding. Significant findings cross-link to the Pass 2 pattern files (`01-…`, `02-…`).

Setup the rest of this audit hangs on:

```
  the rendering boundary, named once

  ┌─ Next.js 16 App Router ──────────────────────────────────────┐
  │                                                              │
  │  app/layout.tsx          ← server (no 'use client')          │
  │  app/page.tsx            ← 'use client' (whole tree)         │
  │  app/investigate/[id]    ← 'use client'                      │
  │  app/investigate/.../recommend  ← 'use client'               │
  │                                                              │
  │  every interactive surface lives client-side; the server     │
  │  bands run only inside app/api/* (NDJSON producers)          │
  └──────────────────────────────────────────────────────────────┘
```

Versions, observed in `package.json:13-20`: `next 16.2.6`, `react 19.2.4`, `react-dom 19.2.4`, `@anthropic-ai/sdk 0.99`, `@modelcontextprotocol/sdk 1.29`, `lucide-react 1.17`. Tailwind v4 (`devDependencies` + `app/globals.css:1`). Tests: 221 passing via Vitest (`package.json:30`, test count from the codebase state).

---

## rendering-and-reactivity

**Rendering mode: a server-shell + client-everything App Router app.** `app/layout.tsx:14-28` is the only server component in the user-facing tree — it boots fonts (`next/font/google` for Syne / Inter / JetBrains Mono at `app/layout.tsx:5-7`), sets `<html lang="en" className="dark">`, and renders children. Every route page (`app/page.tsx:1`, `app/investigate/[id]/page.tsx:1`, `app/investigate/[id]/recommend/page.tsx:1`) opens with `'use client'`. So practically: this is an SPA wearing an App Router shell. No server components do data fetching; no RSC streaming hand-off; no `<Suspense>` boundaries; no route loaders. The agent-pipeline streaming the user sees is *not* React server-rendered streaming — it's `fetch` + `ReadableStream` + NDJSON parsed in the browser (see `01-ndjson-stream-reader-hook.md`).

**Reconciliation: vanilla React 19 virtual-DOM.** No `useTransition`, no `useDeferredValue`, no `startTransition`, no `<Suspense>`. Reactivity is the default `useState` / `useEffect` model. Streaming updates land via `setState` calls inside the NDJSON event handler — one `setItems((p) => [...p, item])` per arriving line (`lib/hooks/useInvestigation.ts:109-117`, `lib/hooks/useBriefingStream.ts:220-241`).

**Scheduling: synchronous, with `'use client'` boundaries containing render cost.** `reactStrictMode` is on (Next default, confirmed in the project context). `useInvestigation.ts:48-49` uses a `startedRef` guard to make the effect idempotent under StrictMode's dev double-mount — and explicitly does NOT cancel the in-flight fetch on cleanup (`lib/hooks/useInvestigation.ts:33-37`), because cancelling on the first cleanup with the started-guard blocking the re-mount aborted the stream and left the logs empty in dev. `useBriefingStream.ts:130-152` takes the opposite call: a `cancelledRef` latch IS flipped on cleanup, polled by `readNdjson` between reads, so a mode-toggle mid-stream cancels cleanly.

**When work actually happens.**
- mount → effect → fetch → first NDJSON line → `setState` in the dispatcher → React re-renders the list owner (`ReasoningTrace`)
- there's no memoization. `ReasoningTrace` re-renders the full `items.map(...)` on every appended line. Each row is a `bi-fade-up` div; the per-line render cost is small (the keyed list short-circuits, the rows are simple). Not yet a problem at the observed trace lengths (tens of lines), but it's the place a longer log would start to show its lack of `React.memo`.

**Hydration.** Trivial. The server shell renders empty client-component containers; client mount fetches data. There's no SSR'd payload to hydrate against, so there's no hydration-mismatch surface.

→ cross-link: event-loop / scheduling mechanics belong to `study-runtime-systems`. The `ReadableStream` reader loop is a runtime topic; this lens only records that it lives inside a `useEffect`.

---

## state-architecture

**The state graph is small and almost entirely local to a component or its hook.** No Redux, no Zustand, no Jotai, no React Context. Server state crosses into client state through the NDJSON stream consumed by three hooks (`useBriefingStream`, `useInvestigation`, `useDemoCapture`) and one component (`StreamingResponse`). URL state is read with `useParams` from `next/navigation` at `app/investigate/[id]/page.tsx:34` and the recommend page; no `useSearchParams` write-back. No form library — `QueryBox` is a single uncontrolled input (`components/chat/QueryBox.tsx`).

**State owners, by store:**

```
  state slot         owner                                    where it lives
  ─────────────────  ───────────────────────────────────────  ────────────────────
  feed status        useBriefingStream                        useState in hook
  insights           useBriefingStream                        useState in hook
  workspace          useBriefingStream                        useState in hook
  coverage           useBriefingStream                        useState in hook
  trace items        useBriefingStream / useInvestigation     useState in hook
  reconnect flag     useReconnectPolicy + sessionStorage      sessionStorage
  bi:mode            app/page.tsx + localStorage              localStorage
  insight stash      stashInsights() + sessionStorage         sessionStorage
  investigation      useInvestigation + sessionStorage        sessionStorage
  diagnosis handoff  useInvestigation + sessionStorage        sessionStorage
```

**The most opinionated state move: sessionStorage as the cross-page handoff.** When the feed loads, `stashInsights` writes every insight to `sessionStorage` (`lib/hooks/useBriefingStream.ts:53-60`) keyed by `bi:insight:<id>`. When the investigate page opens, `useInvestigation` reads it back and forwards it as a query-string param to `/api/agent` (`lib/hooks/useInvestigation.ts:170-171`). The route comment explains the load-bearing reason: *"On Vercel the feed and the investigation request can hit different instances, so server-side in-memory lookup is unreliable; the browser carries the data across instead."* (`lib/hooks/useBriefingStream.ts:49-52`). The diagnosis handoff from step 2 to step 3 uses the same pattern at `useInvestigation.ts:138-141` (write `bi:diag:<id>`) → `useInvestigation.ts:73-85` (read `bi:diag:<id>`). This is a deliberate trade: the browser is the only state plane both pages can guarantee they share.

**Source-of-truth discipline.** The hooks own the state and the page consumes their return values — `app/page.tsx:100-114` destructures nine fields from `useBriefingStream`, hands callbacks to compose with `useReconnectPolicy`, and never sets that state from outside the hook. That's the load-bearing convention: the hook is the seam.

**Derived state.** Almost none. `monitoringState(status)` and `monitoringSub(...)` in `app/page.tsx:20-40` derive stepper inputs from the briefing status — pure functions, no memo, recomputed on every render. `byCat = new Map(coverage.map(...))` in `components/feed/CoverageGrid.tsx:65-73` rebuilds the same Map on every render — fine at 10 entries.

**The latent state risk.** `setState` calls inside a stream handler that runs after `unmount` are safe no-ops in React, but `useInvestigation` *deliberately* doesn't cancel the fetch on cleanup (`useInvestigation.ts:33-37`). Under a sustained back-and-forth between investigate pages, this could pile up zombie streams. Today it's bounded by `startedRef` and the natural lifetime of an investigation; under a redesign that re-runs investigations on demand, it'd need to be revisited.

→ cross-link: system-level state ownership (where the durable record lives, how it's invalidated) belongs to `study-system-design`. This lens owns only the in-browser graph.

---

## component-architecture

**Composition pattern: container-page + leaf components, with shared sidebars and a shared stepper.** No render props. No headless components. No compound components. No slot pattern beyond React's default `children`. The "abstraction" is the file boundary itself: page tsx owns layout + state-wiring, components/* render UI fragments.

**Boundaries the repo earned by refactoring (3 + 1):**

- `useBriefingStream` (`lib/hooks/useBriefingStream.ts`, 313 LOC) — lifted out of `app/page.tsx` to own fetch + parse + 9-case event dispatcher.
- `useDemoCapture` (`lib/hooks/useDemoCapture.ts`, 146 LOC) — lifted to own the dev-only three-phase capture loop.
- `useReconnectPolicy` (`lib/hooks/useReconnectPolicy.ts`, 123 LOC) — lifted to own the revoked-token reset-and-reload dance.
- `useInvestigation` (`lib/hooks/useInvestigation.ts`, 202 LOC) — owns one investigation step (`diagnose` | `recommend`) for both investigate pages.

After the lift, `app/page.tsx` is 461 LOC; the hooks compose via callbacks (`app/page.tsx:110-113` passes `reconnectPolicy.handle` as `onAuthError` and `reconnectPolicy.clearFlag` as `onStreamComplete` into `useBriefingStream`). That callback seam is the composition story — there's no global event bus and no provider tree; the page glues the hooks together by passing functions.

**`StatusLog` is the cleanest reusable component** (`components/shared/StatusLog.tsx`, 86 LOC). One presentational widget that takes `items / title / countLabel / scanning / emptyMessage` and renders identically on the feed and both investigate pages. The feed still inlines its own copy of the same shape (`app/page.tsx:386-452`) — a known duplication, called out in the `audit-refactor` notebook on page decomposition.

**`ProcessStepper`** (`components/shared/ProcessStepper.tsx`, 138 LOC) is the most domain-specific component: the three-stage pipeline (monitoring → diagnostic → recommendation) named identically across all three routes, with per-step `{ state, sub, href }` driven by the parent. State is `'pending' | 'active' | 'complete' | 'error'` (`ProcessStepper.tsx:4`); the visual contract is "the badge shape and color encode the state, the label stays constant, the sub-line is the live status."

**`CoverageGrid`** (`components/feed/CoverageGrid.tsx`, 319 LOC) is the biggest visual component and the one with the most internal branching: pending / planned / live / firing tiles, each with its own visual treatment. It's a single function with inline conditional renders rather than four sub-components — see `02-progressive-skeleton-with-stepper.md` for why this single-file shape works for the staged-reveal pattern.

**The `'use client'` placement is conservative.** Every interactive component opts in (`'use client'` on 11 files). The unflagged components (`InsightCard`, `SeverityBadge`, `Sparkline`, `Skeleton`, `AgentBadge`, `RecommendationCardSkeleton`, `ReasoningTrace`, `TraceContent`, `AgentPipeline`, `GapChart`) are rendered inside client trees, so the absence of `'use client'` is meaningless — they're client components by transitive inclusion. There is no actual server/client split being defended here.

→ cross-link: module / interface depth belongs to `study-software-design`. This lens names the boundaries; the design audit at `.aipe/audits/refactors/design-frontend-extract-usereconnectpolicy.md` is where the lift-rationale lives.

---

## data-fetching-and-cache

**No client query library.** No React Query, no SWR, no Apollo, no RTK Query. Every fetch is a bare `fetch(...)` inside a `useEffect`, with a hand-rolled NDJSON parser. The pattern is the same in all four streaming surfaces — see `01-ndjson-stream-reader-hook.md` for the kernel that abstracts it.

**The four streaming surfaces, all sharing `readNdjson`:**

```
  consumer                          where                                       what arrives
  ────────────────────────────────  ──────────────────────────────────────────  ────────────────────────
  useBriefingStream                 /api/briefing                                BriefingEvent (9 cases)
  useInvestigation                  /api/agent?step=diagnose|recommend           AgentEvent
  useDemoCapture (drain)            /api/agent (per insight)                     {type?, message?}
  StreamingResponse (chat)          /api/agent?q=...                             AgentEvent
```

The kernel is `lib/streaming/ndjson.ts` (64 LOC): `fetch → reader → TextDecoder → buffer → split('\n') → JSON.parse → onEvent`. It supports a `cancelOn` poll (used by `useBriefingStream` for clean mode-toggle aborts) and a silent default for malformed lines. The header comment names the contract: "the canonical implementation."

**Cache strategy is sessionStorage-shaped, not memory-shaped.** No request memoization at the client. The "cache" is:
- `sessionStorage[bi:insight:<id>]` — the insight stashed for cross-page handoff (`lib/hooks/useBriefingStream.ts:53-60`).
- `sessionStorage[bi:inv:<step>:<id>]` — the completed investigation, re-hydrated on revisit (`lib/hooks/useInvestigation.ts:51-64, 134-137`).
- `sessionStorage[bi:diag:<id>]` — the diagnosis handed from step 2 to step 3 (`useInvestigation.ts:139-141, 73-85`).
- `sessionStorage[bi:reconnecting]` — the one-shot guard so auto-reconnect doesn't loop (`lib/hooks/useReconnectPolicy.ts:35, 88-107`).
- `localStorage[bi:mode]` — the persisted demo/live toggle (`app/page.tsx:71-83`).

**Invalidation is by-mount.** A new mount = a new fetch, unless the sessionStorage hydration short-circuits it. There is no time-based invalidation, no background refetch, no stale-while-revalidate.

**Error and retry behavior is hand-rolled per surface.**
- HTTP 401 → check `body.needsAuth + body.authUrl` → redirect (`useBriefingStream.ts:162-171`, `useInvestigation.ts:181-187`).
- Non-OK → read body defensively (text-first via `readBody` at `useBriefingStream.ts:64-72`), surface as the error message, no retry.
- NDJSON `case 'error'` → the auth-shaped error path delegates to `useReconnectPolicy.handle`; everything else sets the error message.
- The user-visible retry path is the "reconnect" button (`app/page.tsx:315-332`) which calls `useReconnectPolicy.reconnect`.

**Optimistic updates: none.** This app is read-only — the only mutation surface is `POST /api/mcp/capture-demo` (dev-only). So the absence of optimism is correct, not a gap.

→ cross-link: wire semantics (HTTP, content-type negotiation, the `ReadableStream` contract on the wire) belong to `study-networking`. The cache-as-architecture question (is sessionStorage the right substrate?) belongs to `study-system-design`.

---

## routing-and-navigation

**File-based App Router routes, three pages:**

- `app/page.tsx` — the feed.
- `app/investigate/[id]/page.tsx` — step 2 (diagnose).
- `app/investigate/[id]/recommend/page.tsx` — step 3 (recommend).
- `app/debug/page.tsx` — dev utility.
- `app/api/*` — server routes (NDJSON producers + MCP plumbing).

**Navigation lifecycle: vanilla `next/link`.** `Link` is used at `InsightCard.tsx:174` (feed → investigate), `CoverageGrid.tsx:278` (firing tile → investigate), `ProcessStepper.tsx:127` (jump between stages), and the back-links in the investigate pages. Default prefetch behavior of `next/link` (prefetch on viewport) applies; no explicit prefetch tuning.

**Code splitting at the route boundary.** The App Router gives each page its own bundle by default. No additional `dynamic(() => import(...))` is reached for anywhere in the repo — the components are small enough that the page-level split is the only granularity used.

**Guards / redirects / loaders: none at the route level.** Auth lives one layer down — the `/api/briefing` and `/api/agent` routes return 401 + `authUrl`, and the client redirects (`useBriefingStream.ts:164-167`, `useInvestigation.ts:182-186`). No middleware. No `app/layout.tsx` auth gate. The page mounts, the fetch fires, the 401 redirects.

**Scroll restoration: the Next.js default.** Nothing explicit.

**Deep-linking: yes, by route shape.** `/investigate/<id>` is shareable; `useParams` reads the `id`. But the cross-page handoff depends on sessionStorage (`bi:insight:<id>`), so a cold deep-link without the prior feed visit falls back to the server-side cache or the live fetch (`useInvestigation.ts:170-178`). The route works, but state-of-the-art handoff requires a same-session warm path.

---

## styling-and-design-system

**CSS architecture: Tailwind v4 with a CSS-first config, plus design tokens, plus heavy inline `style={{ ... }}`.** `app/globals.css:1` is `@import "tailwindcss"`. `app/globals.css:3-15` defines the design tokens as CSS custom properties on `:root`: backgrounds (`--bg-base / surface / elevated`), borders, text shades (primary / secondary / tertiary), and four accent colors (teal / coral / amber / purple). `app/globals.css:17-23` exposes them to Tailwind v4 via `@theme inline`.

**The inline-style tax is real.** Across `app/page.tsx` and the major components, hundreds of `style={{ color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono), monospace', fontSize: '0.7rem', ... }}` blocks repeat the same combinations. Tailwind utilities are used too (`text-3xl lowercase`, `min-h-screen px-6 py-10`, `lg:col-span-2`, `grid grid-cols-1 lg:grid-cols-3`, `animate-pulse`), but the typography + color combinations are typed out as object literals. There's no `clsx` / `cva` / Tailwind component layer extraction. This is a deliberate Phase A — Tailwind owns layout primitives, `style={{}}` reaches into the design tokens.

**Design tokens scale by being CSS variables, not Tailwind classes.** When `app/page.tsx:181` writes `background: mode === m.value ? 'var(--accent-teal)' : 'transparent'`, the token wins because conditional class composition would lose Tailwind's purge if the class names were dynamic. The token-as-variable strategy compiles to one CSS var lookup at runtime — no purge concern, no dynamic class string.

**Theming.** Dark mode only. `app/layout.tsx:20` hard-codes `className="dark"` on the `<html>`. No theme switcher. No light-mode tokens.

**Fonts.** Three `next/font/google` families (`app/layout.tsx:5-7`): Syne (display, used at `app/page.tsx:130`), Inter (body), JetBrains Mono (mono, used pervasively for the agent-trace tone). They're injected as `--font-display / --font-body / --font-mono` CSS variables, then reached for inline via `fontFamily: 'var(--font-mono), monospace'`. The lowercase styling pattern (`className="lowercase"`) is repeated as the brand voice.

**Responsive strategy.** Two breakpoints reached for in the repo: `lg:` (the desktop column split — `app/page.tsx:270`, `app/investigate/[id]/page.tsx:145`). One CSS Grid `repeat(auto-fill, minmax(190px, 1fr))` in `CoverageGrid.tsx:116` for the tile grid. No container queries. No fluid type. The mobile layout collapses to a single column; the sticky sidebar still uses `position: sticky` (mobile UA dependent).

**Animation system.** Three custom keyframes in `app/globals.css:37-79`:
- `bi-fade-up` — every streamed-in card / line gets `.bi-fade-up` for a 400ms entrance.
- `bi-indeterminate` (`.bi-progress`) — the indeterminate progress bar shown while the agent is running.
- `bi-dot` (`.bi-dots > span`) — the pulsing-dots "thinking" loader.

All three respect `prefers-reduced-motion: reduce` (`globals.css:42, 78-80`). Plus Tailwind's `animate-pulse` reached for as the generic loading shimmer (`Skeleton.tsx:9`, `CoverageGrid.tsx:128`, `ProcessStepper.tsx:109`).

→ cross-link: bundle-size measurement (Tailwind purge effectiveness, CSS-var runtime cost) belongs to `study-performance-engineering`.

---

## browser-platform-and-build

**Web APIs the repo actually touches:**

- `fetch` — every stream surface (4×) + `useDemoCapture.postCapture` (`useDemoCapture.ts:59`) + `useReconnectPolicy.fireReset` (`useReconnectPolicy.ts:73`).
- `ReadableStream` — consumed in the browser via `res.body.getReader()` at `lib/streaming/ndjson.ts:28`.
- `TextDecoder` — `lib/streaming/ndjson.ts:29` decodes the byte chunks to text.
- `sessionStorage` — 4 distinct keys (insight stash, investigation stash, diagnosis handoff, reconnect flag). See state-architecture above.
- `localStorage` — 1 key (`bi:mode`).
- `crypto.randomUUID()` — for trace-item IDs (`useBriefingStream.ts:222`, `useInvestigation.ts:114`, `StreamingResponse.tsx:54`).
- `window.location.href` — for OAuth redirect (`useBriefingStream.ts:166`) and post-reconnect hard reload (`useReconnectPolicy.ts:80`).
- `window.alert` — dev capture progress (`useDemoCapture.ts:99, 134, 136`).
- `prefers-reduced-motion` — respected in CSS (`globals.css:42, 78-80`).
- `aria-label` / `aria-hidden` / `aria-live` — `aria-label="analysis pipeline"` on `ProcessStepper` (`ProcessStepper.tsx:75`); `aria-hidden` sprinkled on decorative icons / animated dots. No `aria-live` regions for the streaming trace — `not yet exercised`.

**Web APIs `not yet exercised`:** `EventSource` (Server-Sent Events — the project context calls this out explicitly: "NDJSON over `ReadableStream`, consumed in the browser via `fetch` + a stream reader (not `EventSource`)"), `WebSocket`, `IndexedDB`, `Worker`, `ServiceWorker`, `MediaRecorder`, `BroadcastChannel`, the View Transitions API, `<dialog>`, `popover`.

**Bundler: Turbopack via `next 16.2.6`.** No `next.config.ts` customization (`next.config.ts` exports an empty config). The deploy artifact is whatever Next's `next build` produces — the Vercel platform shape.

**Code splitting: per-route by default.** No `dynamic(() => import(...))` reached for.

**Tree shaking + polyfills: Next defaults.** `lucide-react` icons are imported by name (`CoverageGrid.tsx:6-17`), which the bundler tree-shakes.

**Sourcemaps + dev tooling: Next defaults.** `reactStrictMode` is on (project context). The StrictMode double-mount discipline shows up in two distinct adaptations:
- `useInvestigation` uses a `startedRef` guard (`useInvestigation.ts:48-49`) and deliberately does NOT cancel the fetch on cleanup, with a comment explaining the bug that produced this rule (`useInvestigation.ts:33-37`).
- `useBriefingStream` uses a `cancelledRef` latch (`useBriefingStream.ts:130-152`) that IS flipped on cleanup, polled by `readNdjson` via `cancelOn`.

The split is correct: investigations should run once and complete; the briefing should re-run when the mode toggles. The two hooks face different lifecycle pressures.

→ cross-link: bundle size as measurement belongs to `study-performance-engineering`.

---

## frontend-red-flags-audit

Ranked by user-visible consequence. Each row names the evidence.

**1. The streaming trace has no `aria-live` region.** A blind screen-reader user opening the feed in live mode gets the visual stream of "scanning…" → "query 1 · execute_analytics_eql" → "query 2 · …" with no auditory equivalent. The trace lives at `app/page.tsx:419-451` and `components/shared/StatusLog.tsx:68-83`; both render new `ReasoningTrace` items as they arrive without announcing the change. Consequence: an entire surface that's load-bearing for the "shows its work" pitch is invisible to assistive tech. Fix shape: `role="log"` + `aria-live="polite"` + `aria-atomic="false"` on the trace container. (Out of scope for this audit; named here as the frontend-engineering red flag.)

**2. The feed's sidebar duplicates `StatusLog`.** `app/page.tsx:386-452` inlines the same sidebar shape that lives in `components/shared/StatusLog.tsx`. Two places to keep in sync; the investigate pages already use the component. Consequence: a style change to the sidebar lands on one half of the app. Fix shape: swap the inline copy for `<StatusLog title="how this briefing was gathered" countLabel={...} scanning={status === 'loading'} ... />`. Referenced in `.aipe/audits/refactors/design-frontend-extract-usereconnectpolicy.md` and the page-decomposition notebook.

**3. The dual auth-error regex is documented-but-divergent.** `lib/hooks/useReconnectPolicy.ts:33-34` keeps two predicates (`AUTH_ERROR_RE_AUTO` and `AUTH_ERROR_RE_BUTTON`). The "button" regex is missing `invalid_token` and `reconnect`. The header comment names this as a latent bug deferred for live-server verification (`useReconnectPolicy.ts:16-30`). Consequence: a user who sees an `invalid_token` error and gets past the auto-reconnect (because the one-shot guard fired) won't see the explicit reconnect button to recover. The note is honest about the deferral.

**4. `ReasoningTrace` re-renders all items on every appended line.** `components/investigation/ReasoningTrace.tsx:52-107` is unmemoized; `useInvestigation` and `useBriefingStream` push one item per NDJSON event. At today's trace lengths (tens of items) the re-render cost is invisible. At a hundred+ items per investigation, this is the first place that'd show up in a profiler. Fix shape: `React.memo` on the row component, or virtualization. Not yet a problem; named because the rendering-and-reactivity lens recorded the absence of memoization.

**5. The `lg:` breakpoint is the only one; mobile is a 1-column collapse.** `app/page.tsx:270` and the investigate pages use `grid-cols-1 lg:grid-cols-3`. Below `lg` the sticky sidebar `position: sticky` stacks under the main column. The status log on mobile is therefore far below the agent's output — workable for a desktop-first demo, awkward on a phone. Named because the responsive strategy is documented at one breakpoint.

**6. The `'use client'` on `app/page.tsx:1` covers a 461-LOC tree that doesn't need to be fully client-side.** The header (title, subtitle, project name) is presentational. The CoverageGrid is interactive. The trade was made for simplicity (one boundary, not many), and it's defensible — but the rendering-and-reactivity lens recorded that no part of the user-facing tree runs server-side, and this is where that decision compounds.

---

## summary

Two patterns earn dedicated Pass 2 files:

- `01-ndjson-stream-reader-hook.md` — the `readNdjson` kernel + the `useBriefingStream` / `useInvestigation` shape that consumes it. The load-bearing test: strip this pattern out and the agent's "shows its work" surface (the live trace, the streamed insights, the progressive coverage tiles) vanishes. The pattern is named four times in the codebase; the kernel was extracted to dedupe them.
- `02-progressive-skeleton-with-stepper.md` — the four-tier composition (`Skeleton` + `ProcessStepper` + `CoverageGrid` pending tiles + `StatusLog` indeterminate progress + `bi-fade-up` on every appended item) that turns a 30-60s monitoring scan into a UI that reads as "the system is working" the entire time. Strip it out and the user stares at a spinner; the pattern is the perceived-performance story.

Everything else either lives in the audit (lens-level findings) or belongs to a neighbor (`study-performance-engineering` for bundle / render-cost measurement; `study-networking` for the wire format and HTTP semantics; `study-system-design` for the cache-as-architecture question; `study-runtime-systems` for the event loop inside the reader).
