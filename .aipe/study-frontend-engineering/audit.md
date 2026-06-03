# Frontend engineering — audit

> **Verdict-first.** This is a Next.js 16 + React 19 + Tailwind 4 codebase that uses **almost none of what each one offers.** Every routed page is `'use client'`; there are no Server Components in the routed surface, no Suspense boundaries, no `loading.tsx` / `error.tsx`, no React Query / SWR, no global store, no design-token layer beyond CSS variables on `:root`. The framework is, in effect, "Next as a static shell + React 19 as the runtime." That's a deliberate fit for the actual product — a 30-60s NDJSON stream IS the experience — and an honest mis-fit with React 19's marquee features.
>
> **The two patterns that earn pattern-file treatment** are the load-bearing ones: the **NDJSON reader hook** (`useInvestigation` — strip it and the live agent trace dies) and the **progressive skeleton + stepper composition** (strip it and a 30-60s blank screen replaces a UI that animates from event #1). Everything else is either a known smell already named in a neighboring guide (the 817-LOC `app/page.tsx` → `study-software-design/02-shallow-module-page-component.md`; the cross-step `sessionStorage` handoff → `study-system-design/07-client-stream-handoff.md`) or a stretch of Next.js / React 19 surface area the repo hasn't exercised yet.
>
> **The single highest-priority frontend finding** is the same one every other audit names: extract three hooks (`useBriefingStream`, `useReconnectPolicy`, `useDemoCapture`) from `app/page.tsx`. It retires the 14-`useState`-slot cognitive-load hotspot *and* removes the NDJSON-parser duplication between the page and `useInvestigation`. The shape is documented; the safety net is the gap (no NDJSON tests — `cleanup-2026-06-02.md` #15).

---

## rendering-and-reactivity

**Verdict.** SPA-shaped — every routed page declares `'use client'`. No SSR data fetching, no Server Components in the routed surface, no streaming SSR handoff, no Suspense boundaries, no concurrent-rendering primitives in use.

**What the repo actually does.**

- All four route entries are client components:
  - `app/page.tsx:1` `'use client';`
  - `app/investigate/[id]/page.tsx:1` `'use client';`
  - `app/investigate/[id]/recommend/page.tsx:1` `'use client';`
  - `app/debug/page.tsx:1` `'use client';`
- `app/layout.tsx:9` declares the only server-side metadata (`metadata` export). The body shell loads three Google fonts (`Syne`, `Inter`, `JetBrains_Mono`) via `next/font/google` (`app/layout.tsx:5-7`) and renders `{children}` (line 24). The root has no shell beyond the body + font-variable classes.
- `app/globals.css:1` `@import "tailwindcss";` and a custom `@theme inline` block (lines 17-23) that maps CSS variables to Tailwind's design tokens. All twelve color tokens declared as CSS custom properties on `:root` (lines 3-15).
- `app/layout.tsx:20` hard-locks dark mode at the document root (`<html lang="en" className="dark">`). No theme toggle.
- `next.config.ts:3` is empty (`const nextConfig: NextConfig = {};`). No experimental flags, no `images`, no `output: 'standalone'`. The build uses defaults.
- `package.json:16-18` Next 16.2.6, React 19.2.4, React-DOM 19.2.4. React 19's `use(promise)`, server actions, `useFormStatus`, `useOptimistic`, `useTransition` — **none appear in any source file** (grep: zero hits in `app/`, `components/`, `lib/`).
- React StrictMode behavior IS exercised, but only as a *failure mode handled by guards*: `lib/hooks/useInvestigation.ts:43, 47-48` (`startedRef` latch); `components/chat/StreamingResponse.tsx:19, 24-25` (same pattern). The fix is the absence of an `AbortController` — see `study-system-design/07-client-stream-handoff.md`.

**Reconciliation model.** React 19's virtual-DOM diffing + concurrent rendering primitives — but the codebase only uses the diffing half. State updates fire from inside `fetch`-stream reader loops (the `handle()` switch in `app/page.tsx:328-437`), so every event triggers a state update and a re-render. No `useMemo`, no `useCallback`, no `React.memo` in any component (grep: zero hits across `components/`).

**Where work actually happens.**
- Mount: every page mounts, runs its `useEffect` (`app/page.tsx:258, 129`; `lib/hooks/useInvestigation.ts:45`), opens a `fetch` stream, and starts reading.
- Update: every NDJSON event arrival triggers one or more `setState` calls. The feed page accumulates `coverage` (`app/page.tsx:333-338`), `traceItems` (`app/page.tsx:344-348, 369-385`), `insights` (collected in a closure array, flushed on `done` at line 391), `stepStatus` (line 353), and `queryCount` (line 343) — each in a separate `setState`. React 19 should batch within the same microtask but the reader loop's `await` between chunks creates explicit yields where batching ends.
- Commit / hydration: hydration runs once per route per mount; nothing else interesting.

**Not yet exercised.** SSR data fetching, Server Components in the routed surface (`'use client'` covers everything), Suspense boundaries, `<Suspense>` fallbacks, `use(promise)`, server actions, `useFormStatus`, `useOptimistic`, `useTransition`, streaming SSR handoff, partial pre-rendering, route segments with `loading.tsx` or `error.tsx`. No `error.tsx`, no `loading.tsx`, no `not-found.tsx` anywhere in `app/` (grep returned nothing).

→ see `01-ndjson-stream-reader-hook.md` for the data-fetch primitive that drives every re-render.

---

## state-architecture

**Verdict.** All state is local `useState` (no Redux / Zustand / Jotai / Context). The state graph's shape is "fourteen `useState` slots in one component" on the feed page and "five `useState` slots + one `useRef` latch" inside one hook for both investigation pages. URL state is paths only (no search params other than the demo flag); form state has one input (the QueryBox text input — hidden behind a flag at `app/page.tsx:14`).

**The state graph.**

| Tier | Carrier | Lifetime | Example |
|---|---|---|---|
| Live UI | `useState` | per mount | `setInsights`, `setItems`, `setCoverage` |
| Run-once latch | `useRef` | per mount | `startedRef` in `useInvestigation.ts:43` and `StreamingResponse.tsx:19` |
| Per-tab durable | `sessionStorage` | per tab | `bi:insight:<id>`, `bi:diag:<id>`, `bi:inv:<step>:<id>`, `bi:reconnecting` |
| Per-browser durable | `localStorage` | per browser | `bi:mode` (`app/page.tsx:132, 144`) |

**Who owns each transition.**

- `app/page.tsx` (the feed page) owns 14 `useState` slots — enumerated in `study-software-design/02-shallow-module-page-component.md` lines 234-247. Every NDJSON event handler in the inline `handle()` function (`app/page.tsx:328-437`) writes to one or more of them.
- `lib/hooks/useInvestigation.ts:38-43` owns five `useState` slots (`items`, `diagnosis`, `recommendations`, `complete`, `error`) plus the `startedRef` latch. Both investigation pages (`app/investigate/[id]/page.tsx:38` and `app/investigate/[id]/recommend/page.tsx:37`) destructure the hook's return.
- `components/chat/StreamingResponse.tsx:13-18` owns five `useState` slots (`items`, `answer`, `complete`, `error`, `showReasoning`) for the `?q=` flow.
- `components/investigation/ToolCallBlock.tsx:25` owns one `useState` (`expanded`) — the disclosure toggle.

**Source-of-truth enforcement (or its absence).**

- For collected stream output, the codebase keeps a **parallel plain-array closure copy** alongside the React state: `useInvestigation.ts:65-67` declares `cItems`, `cDiag`, `cRecs`; every handler mutates both (lines 108-109, 114-115, 119-120, 123-124, 127-128) so the `done` handler can stash the freshest values synchronously (line 135). React's `setState` is async; closing over the latest state inside an event handler would lose pending updates. The mirror IS the source of truth at stash time.
- For the feed: the same shape, less disciplined — `collected` array at `app/page.tsx:325` accumulates insights, flushed on `done` (line 391). The other slots (coverage, trace) live only in React state.
- For cross-mount state, `sessionStorage` is treated as the source of truth on hydrate (`useInvestigation.ts:50-63`).

**The `useState`-stuffing red flag.** The feed page's 14 slots are independent — see `study-software-design/02-shallow-module-page-component.md`. The fix (extract three hooks) is documented; this guide names it again only because the symptom IS a frontend-state-architecture finding, not just a module-depth one.

**Not yet exercised.** Global stores (Redux / Zustand / Jotai), Context providers other than `next/font` injection, derived-state libraries, URL state libraries (no `useSearchParams` reads, no nuqs / use-query-state), form state libraries (no react-hook-form / Formik / Conform), `useReducer` (grep: zero hits across `components/`, `app/`, `lib/`), `useImperativeHandle`, `useSyncExternalStore`.

→ see `study-software-design/02-shallow-module-page-component.md` for the 14-slot cognitive-load walk.
→ see `study-system-design/07-client-stream-handoff.md` for the per-tab durable tier (`sessionStorage` keys + the StrictMode latch).

---

## component-architecture

**Verdict.** Plain function components, no composition patterns beyond `children`. Boundary placement is sensible at the leaf level (`InsightCard`, `EvidencePanel`, `ToolCallBlock`, `RecommendationCard`, `StatusLog`, `Skeleton`, `Sparkline`, `ProcessStepper`) and missing at the page level — the feed page IS the boundary problem.

**Composition patterns the repo uses.**

- **Children prop only.** `app/layout.tsx:24` renders `{children}`. No slots, no render props, no compound components.
- **Discriminated-union props** for `ProcessStepper` (`components/shared/ProcessStepper.tsx:6-12`): each of the three step inputs is a `StepInput` with `state: 'pending'|'active'|'complete'|'error'`, optional `sub`, optional `href`. Same shape for `ToolCallBlock`'s `status` (`components/investigation/ToolCallBlock.tsx:5-11`).
- **Hook-as-boundary** on the two investigation pages: `useInvestigation(id, step)` is the *whole* data-fetch boundary. The page is layout + composition; the hook owns fetch + state + stash. This is the canonical good shape in the repo — see `app/investigate/[id]/page.tsx:38` and `app/investigate/[id]/recommend/page.tsx:37`.

**Boundary placement, ranked.**

- **Good.** The leaf components (`InsightCard`, `EvidencePanel`, `RecommendationCard`, `ToolCallBlock`, `Skeleton`, `Sparkline`, `ProcessStepper`, `StatusLog`) each own one concern and take a typed prop. `ReasoningTrace` is the one shared display component used by all three streaming surfaces (`app/page.tsx:777`, `components/shared/StatusLog.tsx:70`, `components/chat/StreamingResponse.tsx:268`).
- **Reused well.** `StatusLog` (`components/shared/StatusLog.tsx`) is rendered three times (feed sticky aside at `app/page.tsx:743-808` — manually inlined; both investigation pages via `StatusLog` import at `app/investigate/[id]/page.tsx:214` and `recommend/page.tsx:186`). The feed version is hand-rolled and slightly drifts from the shared component — see the red-flags lens.
- **Missing.** No `<FeedHeader />`, no `<ModeToggle />`, no `<DemoCaptureButton />` extracted from the feed page. The feed page renders all three inline at `app/page.tsx:484-558` (header), `526-544` (mode toggle), `716-739` (capture button).

**Container-vs-presentational discipline.** Inconsistent. `app/investigate/[id]/page.tsx` is a clean container (data via hook, layout + composition only). `app/page.tsx` is the opposite — fetching, parsing, accumulating, capturing, and rendering all in one file scope.

**Component count by directory.**

```
components/feed/           3   InsightCard (495), CoverageGrid (319), SeverityBadge
components/investigation/  8   EvidencePanel (290), RecommendationCard (241),
                               RecommendationCardSkeleton, ReasoningTrace, GapChart,
                               InvestigationSubject, ToolCallBlock, TraceContent
components/chat/           2   StreamingResponse, QueryBox
components/shared/         6   ProcessStepper, StatusLog, Skeleton, Sparkline,
                               AgentBadge, AgentPipeline
```

19 components total. Median LOC is small; the InsightCard / CoverageGrid / EvidencePanel / RecommendationCard cluster carries most of the inline-style mass (see styling lens).

**Not yet exercised.** Headless components, compound components (`<Tabs><Tab/></Tabs>`), slot-based composition, render-prop components, polymorphic `as` props, `forwardRef`, error boundaries (no `componentDidCatch`, no error boundary library, no `error.tsx` files), portals (no `createPortal`), strict-mode-aware effects that *actually* cancel on cleanup, custom hooks beyond `useInvestigation` (only one custom hook in `lib/hooks/`).

→ see `01-ndjson-stream-reader-hook.md` for the hook-as-boundary pattern that works in this repo.

---

## data-fetching-and-cache

**Verdict.** All client-side. Two hand-written `fetch` + `ReadableStream` reader loops do the heavy lifting — one in `app/page.tsx:258-476` (the feed briefing), one in `lib/hooks/useInvestigation.ts:45-213` (both investigation steps). One simpler `fetch` in `components/chat/StreamingResponse.tsx:89-136` (the `?q=` flow). No React Query, no SWR, no Next.js route loaders, no `cache()` calls. Client-side cache lives in `sessionStorage` per-step (`useInvestigation.ts:51-63, 132-144`).

**The two reader-loop shapes.**

Both follow the same kernel (line-buffered UTF-8 NDJSON consumer dispatched to a `handle(event)` switch). The kernel duplication is the architectural finding — same code, two files:

```
fetch(url)
 → res.body.getReader()
 → loop:
     read()
     decode(buffer)
     split('\n') → trim → JSON.parse → handle(event)
 → flush trailing line on close
```

- `app/page.tsx:323-464` — feed briefing. 9 `case` arms in the switch (`workspace`, `coverage_item`, `coverage`, `tool_call_start`, `reasoning_step`, `tool_call_end`, `insight`, `done`, `error`).
- `lib/hooks/useInvestigation.ts:184-208` — investigation steps. 6 `case` arms (`reasoning_step`, `tool_call_start`, `tool_call_end`, `diagnosis`, `recommendation`, `done`, `error`).
- `components/chat/StreamingResponse.tsx:107-132` — query response. 4 `case` arms.

**Cache semantics.**

- **Per-step result memoization (sessionStorage).** Each investigation step stashes its full result on `done` (`useInvestigation.ts:133-144`); on next mount the hook hydrates from the stash and *never opens a fetch* (lines 50-63). Hit semantics: per tab, per step, per insight id.
- **Cross-step state handoff (sessionStorage).** Step 2's diagnosis is written to `bi:diag:<id>` (line 139), read by step 3's mount (lines 73-83), and (in live mode) appended to step 3's request URL (lines 162-164). The full mechanics live in `study-system-design/07-client-stream-handoff.md`.
- **Cross-instance state handoff (sessionStorage → query string).** The feed stashes every insight under `bi:insight:<id>` (`app/page.tsx:72-77`); the investigation hook reads it and appends `&insight=<encoded>` in live mode (`useInvestigation.ts:160-161`). This is the only way investigation can find the anomaly when Vercel serves the click on a different instance than the feed.

**Mutations + optimistic updates.** Not exercised. The product is read-only end-to-end (no Bloomreach write tools; recommendations are suggestions, not actions). The only "mutation" is the dev-only demo-capture POST (`app/page.tsx:156-164`) which is fire-and-forget with no optimistic update.

**Error and retry behavior (client side).**

- **Auth-revoked auto-reconnect.** The feed's error handler (`app/page.tsx:400-435`) matches `/invalid_token|unauthor|forbidden|401|session expired|reconnect/i`, sets a `sessionStorage` guard against infinite loops (line 410), POSTs `/api/mcp/reset`, then `window.location.href = '/'` (lines 421-423).
- **Manual reconnect.** Same regex in the JSX error branch (line 650) renders a `reconnect` button (lines 663-687) that does the same `reset` + reload.
- **Generic errors.** Server error text is rendered verbatim in a coral `<p>` (feed: `app/page.tsx:638-648`; investigate: `app/investigate/[id]/page.tsx:121-143`; recommend: `app/investigate/[id]/recommend/page.tsx:118-140`). No `aria-live` (see the a11y audit).
- **No retry.** No exponential backoff on the client side. Retry lives in `lib/mcp/client.ts` on the server.

**Not yet exercised.** React Query / SWR / TanStack Query, Next.js route loaders, RSC streaming, Server Actions, `cache()`, mutations with optimistic updates, query invalidation, background refetch, stale-while-revalidate, polling.

→ see `01-ndjson-stream-reader-hook.md` for the `useInvestigation` hook deep walk.
→ see `study-system-design/07-client-stream-handoff.md` for the `sessionStorage` four-key state-handoff mechanics.
→ see `study-system-design/05-streaming-ndjson.md` for the wire-format / producer side.

---

## routing-and-navigation

**Verdict.** File-based App Router. Four routes, no nested layouts beyond the root `app/layout.tsx`. Navigation is exclusively `next/link` `<Link>` — no programmatic `router.push` calls. Code-splitting is whatever Next.js defaults to per route segment; nothing custom. Loader / prefetch / transition primitives are not used.

**Routes.**

```
app/page.tsx                                  /                       feed (817 LOC)
app/investigate/[id]/page.tsx                 /investigate/[id]       diagnose (225 LOC)
app/investigate/[id]/recommend/page.tsx       /investigate/[id]/r…    recommend (197 LOC)
app/debug/page.tsx                            /debug                  MCP tool tester (279 LOC)
```

Plus the API routes in `app/api/` (out of scope for this guide — owned by `study-system-design`).

**Navigation lifecycle.**

- `next/link` `<Link>` imports in five files: the two investigation pages, `ProcessStepper`, `InsightCard`, `CoverageGrid`. Each navigates to a known route segment.
- `useParams<{ id: string }>()` from `next/navigation` extracts the route param on both investigation pages (`app/investigate/[id]/page.tsx:34`, `recommend/page.tsx:34`).
- `useRouter`, `usePathname`, `useSearchParams` — **not imported anywhere** (grep: zero hits).
- Programmatic navigation is one place only: `window.location.href = '/'` after the auto-reconnect (`app/page.tsx:422`), a full-page reload (not a SPA nav).
- The "reconnect" button (`app/page.tsx:672`) and the OAuth redirect (`app/page.tsx:286`) also use `window.location.href` — full navigations chosen specifically because the goal is to reset client state.

**Code-splitting at the route boundary.** Next.js App Router splits per route segment by default; no manual `next/dynamic`, no `import()` calls, no chunk-name hints (grep: zero `next/dynamic` imports across `app/`, `components/`).

**Prefetch / suspense / transitions.** `next/link` defaults to viewport-based prefetch. No `<Link prefetch={false}>` overrides found. No `Suspense` boundaries (already noted in the rendering lens). No `useTransition` calls.

**Guards / redirects / loaders.** No `middleware.ts` (file does not exist). No `redirect()` calls from `next/navigation`. No route loaders. Auth is checked inside each API route (server) and surfaced as a client-side `needsAuth` flag (`app/page.tsx:283-291`) that triggers `window.location.href = body.authUrl` (line 286).

**Scroll restoration.** Browser default. No `useEffect` calls `window.scrollTo` (grep: zero hits across `app/`, `components/`).

**Deep-linking.** `/investigate/:id` and `/investigate/:id/recommend` are direct-linkable but degrade gracefully only if the `sessionStorage` insight stash exists for that id. A bookmarked deep-link with no prior feed visit shows the diagnostic running (the agent runs from server lookup), but `InvestigationSubject` (`components/investigation/InvestigationSubject.tsx`) renders `null` because the `bi:insight:<id>` key is missing — see `study-system-design/07-client-stream-handoff.md` for the gotcha.

**Not yet exercised.** Nested layouts beyond root, parallel routes, intercepting routes, `loading.tsx`, `error.tsx`, `not-found.tsx`, `template.tsx`, route groups, `middleware.ts`, `generateStaticParams`, `generateMetadata` (only static `metadata` at `app/layout.tsx:9`), dynamic `metadata`, route handlers with `revalidate`, `next/dynamic`, prefetch overrides, scroll restoration, view transitions, navigation guards.

---

## styling-and-design-system

**Verdict.** Tailwind v4 utility classes for layout + inline `style={{}}` with CSS-variable values for everything else. Twelve color tokens declared on `:root`; the variables are the design system, full stop. Dark mode is hard-locked at the root (`<html className="dark">`); no theme toggle. No animation library. The "design system" is whatever convention each component reaches for, and the convention drifts.

**The token layer.** `app/globals.css:3-15` declares twelve CSS custom properties on `:root`:

```
--bg-base, --bg-surface, --bg-elevated, --border
--text-primary, --text-secondary, --text-tertiary
--accent-teal, --accent-coral, --accent-amber, --accent-purple
```

These are referenced from inline styles in nearly every component file. Grep `color: 'var(--text-` returns hits across feed, investigation, chat, shared. The `@theme inline` block (lines 17-23) maps a subset (`background`, `foreground`, font variables) to Tailwind tokens; the color palette itself is *not* mapped, so Tailwind utility classes like `bg-surface` or `text-coral` don't exist — every color usage is `style={{ color: 'var(--text-…)' }}`.

**The CSS architecture, in two layers.**

- **Tailwind utility classes** for layout/spacing/typography skeleton: `min-h-screen px-6 py-10 mx-auto w-full max-w-5xl` (the page-shell pattern at `app/page.tsx:480`, both investigation pages, `app/debug/page.tsx:133`). `text-3xl`, `text-sm`, `text-xs` for size; `lowercase` for the brand's all-lowercase voice; `lg:grid-cols-3`, `lg:col-span-2` for the two-column feed layout (`app/page.tsx:618-619`); `animate-pulse` for skeleton + status indicators (15 hits across `CoverageGrid`, `ToolCallBlock`, `Skeleton`, `StreamingResponse`, `ProcessStepper`, `AgentPipeline`).
- **Inline `style={{}}` with CSS variables** for color / border / padding / radius / font-family / sizes-below-text-xs. Every leaf component (`InsightCard`, `CoverageGrid`, `EvidencePanel`, `RecommendationCard`, `ProcessStepper`, `StatusLog`, `ToolCallBlock`, `StreamingResponse`, `QueryBox`, `ReasoningTrace`, `Skeleton`) is dense inline-style.

**The drift.** `components/feed/InsightCard.tsx` (495 LOC) holds ~150 inline style objects. `components/investigation/EvidencePanel.tsx:13-46` *does* extract repeated style objects into named `CSSProperties` constants (`cardStyle`, `tileStyle`, `tileLabel`, `confColor`, `sectionLabel`) — that's the pattern that should exist everywhere but doesn't. `cleanup-2026-06-02.md` #17 documents the verdict: accept the drift; the Tailwind v4 / inline-style / CSS-variable choice landed mid-build and a top-down style-system decision is out of scope for cleanup.

**Custom CSS animations.** `app/globals.css:37-80` declares three keyframe animations and two `prefers-reduced-motion` overrides:

- `bi-fade-up` (lines 37-41) — used on streaming insight cards and trace items (`components/feed/CoverageGrid.tsx:77`, `components/investigation/ReasoningTrace.tsx:66, 94`).
- `bi-progress` (lines 45-65) — indeterminate progress bar used in `StatusLog.tsx:66`.
- `bi-dot` / `.bi-dots` (lines 68-76) — pulsing "thinking" dots used in `StatusLog.tsx:75-79`.
- The `animate-pulse` Tailwind utility is used in 15+ places; the a11y audit notes that Tailwind v4's default `animate-pulse` keyframe is *not* gated by `prefers-reduced-motion` in `globals.css`. The custom `bi-*` animations are.

**Theming.** Dark only. `app/layout.tsx:20` hard-codes `<html lang="en" className="dark">`. No `<ThemeProvider>`, no `prefers-color-scheme` media query, no toggle.

**Responsive strategy.** Tailwind breakpoints (`lg:`), three places: `app/page.tsx:618-620`, `app/investigate/[id]/page.tsx:145, 147`, `app/investigate/[id]/recommend/page.tsx:142, 144` — all the same shape (`grid-cols-1 lg:grid-cols-3` + `lg:col-span-2`). The `CoverageGrid` tile grid uses container-style sizing (`grid-template-columns: repeat(auto-fill, minmax(190px, 1fr))` at `components/feed/CoverageGrid.tsx:116`). No container queries (grep: zero `@container` rules). No fluid type. No custom breakpoints.

**Icon library.** `lucide-react` is installed (`package.json:15`). One file uses it: `components/feed/CoverageGrid.tsx:6-32` imports 10 category icons. The dependency is otherwise unused (`cleanup-2026-06-02.md` #22 marks it possibly-dead; `study-security/audit.md:61` flagged it; the `CoverageGrid` import is the only hit grep finds).

**a11y of styling.** The `.aipe/audits/a11y-2026-06-02.md` audit (Lens 5, Visual) describes the contrast pairings: `--text-tertiary` (`#5a6878`) on `--bg-elevated` (`#243040`) at sizes ≤ `0.7rem` appears frequently across `CoverageGrid`, `RecommendationCard`, `EvidencePanel`, `ProcessStepper`, `StatusLog`. One explicit `outline: 'none'` on the QueryBox input (`components/chat/QueryBox.tsx:66`) without a replacement focus indicator. No `:focus-visible` styles authored anywhere.

**Not yet exercised.** Design tokens beyond the 12 CSS variables, theme switching, `next-themes` or similar, CSS Modules, CSS-in-JS runtime (styled-components / emotion / vanilla-extract / linaria), Stitches / Panda CSS, container queries, fluid type, breakpoint customization beyond Tailwind defaults, animation library (Framer Motion / Motion One / GSAP), CSS resets beyond the Tailwind preflight, custom focus indicators.

→ see the red-flags lens for the inline-vs-Tailwind drift verdict.

---

## browser-platform-and-build

**Verdict.** A small surface: `sessionStorage`, `localStorage`, `crypto.randomUUID`, `TextDecoder`, `fetch` + `ReadableStream`, `URL`, `window.alert`, `window.location.href`. The bundler is Turbopack (Next.js 16's default). No service worker, no Web Worker, no IndexedDB, no MediaRecorder, no WebSocket / EventSource, no Web Share, no Notifications, no File System Access.

**Web APIs the repo actually touches.**

| API | Where | Purpose |
|---|---|---|
| `sessionStorage` | `app/page.tsx:73, 394, 410, 416, 427`; `lib/hooks/useInvestigation.ts:52, 74, 133, 139, 160`; `components/investigation/InvestigationSubject.tsx:17` | Cross-step state handoff + cross-instance carrier |
| `localStorage` | `app/page.tsx:132, 144`; `lib/hooks/useInvestigation.ts:157` | The `bi:mode` toggle (demo vs live) |
| `crypto.randomUUID` | `app/page.tsx:346, 358`; `lib/hooks/useInvestigation.ts:113`; `components/chat/StreamingResponse.tsx:53` | Trace-item ids |
| `TextDecoder` | `app/page.tsx:182, 324`; `lib/hooks/useInvestigation.ts:185`; `components/chat/StreamingResponse.tsx:108` | UTF-8 decode of NDJSON chunks |
| `fetch` + `ReadableStream` | Same files as `TextDecoder` | The data-fetch primitive (see `01-ndjson-stream-reader-hook.md`) |
| `URL` constructor | none in app surface; `encodeURIComponent` used at `app/page.tsx:171-172`; `useInvestigation.ts:161-164` | URL parameter encoding for handoff |
| `window.alert` | `app/page.tsx:215, 250, 252` | Dev-only demo-capture completion + error messages |
| `window.location.href` | `app/page.tsx:286, 422, 672`; `lib/hooks/useInvestigation.ts:174`; `components/chat/StreamingResponse.tsx:96` | OAuth redirect + manual reconnect (full-page navigation by design) |
| `URLSearchParams` | not used | (paths-only routing, no query state libs) |

**The bundler.** Next.js 16 ships Turbopack as default for `next dev` and `next build`. `next.config.ts:3` is empty; no `experimental` flags. No custom webpack config. No `bundleAnalyzer`. No `output: 'standalone'`.

**Code splitting.** Whatever Next.js does per route segment. `next/dynamic` is not used. `import()` is not used (grep: zero hits in `app/`, `components/`).

**Tree shaking + polyfills.** Default Next.js behavior. The only icon import is selective: `components/feed/CoverageGrid.tsx:6-17` imports 10 named icons from `lucide-react` (not the whole library). Browser target is whatever Next 16's `browserslist` resolves to.

**Sourcemaps.** Defaults — `next dev` produces inline sourcemaps; production build produces sourcemaps that are uploaded as part of the build but not exposed publicly.

**Deploy target.** Vercel Pro (the 300s `maxDuration` on `/api/agent` and `/api/briefing` requires Pro). Documented at `app/api/agent/route.ts:18-20`. The frontend bundle ships to the same CDN.

**Not yet exercised.** Service Workers (no `serviceWorker.register` call, no `public/sw.js`), Web Workers (no `new Worker`), IndexedDB, WebSocket / EventSource, Notifications, Push, MediaRecorder, getUserMedia, Web Share, File System Access, BroadcastChannel, MessageChannel, ResizeObserver, IntersectionObserver, MutationObserver, Web Animations API (the `animate-pulse` + `bi-*` animations are CSS keyframes, not WAAPI), `requestIdleCallback`, `requestAnimationFrame`, `next/dynamic`, manual `import()`, bundle analyzer, `next/image` (no `<img>` tags or `next/image` usage in scanned surface — confirmed by `.aipe/audits/a11y-2026-06-02.md` Lens 4).

---

## frontend-red-flags-audit

Ranked by user-visible consequence with file:line evidence. The first finding is the same one every other audit names; it earns the #1 slot here because the user-facing symptom (the brittle, unboxed feed UX) IS a frontend-architecture problem first, a module-depth problem second.

### #1 — The feed page is 817 LOC with 14 useState slots; every NDJSON event triggers a fresh re-render across all of them

**Where:** `app/page.tsx:95-150` (state), `app/page.tsx:258-476` (the 218-LOC `useEffect`).

**The user-visible consequence:** every event the live briefing emits — coverage tile, tool call start/end, reasoning step, insight — fires through one giant inline `handle()` switch (`app/page.tsx:328-437`) that writes one or more of the 14 state slots. React 19's batching covers the same microtask, but the reader loop's `await reader.read()` (line 440) creates explicit yields. Every accumulator update re-renders the whole feed tree (no `React.memo`, no `useMemo` on the derived data). On a typical 30-60s briefing that emits 20-50 events, the feed re-renders 20-50 times, each touching `CoverageGrid`, the insight list, the trace `<aside>`, and the `ProcessStepper`. Not fatal — the tree is small — but it's the *easiest* frontend optimization the codebase has not yet made (extract a hook, memoize the slow children).

**The fix is documented.** Three hooks: `useBriefingStream(mode)`, `useReconnectPolicy()`, `useDemoCapture(...)`. Page collapses to ~120 LOC of layout + composition. Each hook becomes a deep module hiding ~30-150 LOC behind a small return shape. **Blocked by the test gap** — `cleanup-2026-06-02.md` #15 names the absence of an NDJSON test harness as the reason this L-effort refactor is fix-later, not fix-now.

→ see `study-software-design/02-shallow-module-page-component.md` for the full module-depth walk.

### #2 — The NDJSON reader-loop kernel is duplicated across the feed page and the investigation hook

**Where:** `app/page.tsx:323-464` (feed) and `lib/hooks/useInvestigation.ts:184-208` (investigation). Same shape — `getReader()` + `TextDecoder` + `buf.split('\n')` + trim + `JSON.parse` + dispatch + flush trailing line — implemented twice. `components/chat/StreamingResponse.tsx:107-132` carries a third smaller copy.

**The user-visible consequence today:** none directly — both copies work. The consequence *tomorrow:* the day a malformed-line edge case bites in production (e.g. an event with an unescaped `\n` inside a string), the fix has to land in three places. The day someone adds a new `AgentEvent` variant, the consumer switch has to be updated in three places (and a server-side `filterByStep` — see `study-software-design/audit.md`'s change-amplification finding).

**The fix is the same as #1.** Extracting `useBriefingStream` from `app/page.tsx` retires the feed copy. Lifting the line-buffering kernel into a shared utility (`lib/hooks/useNdjsonReader.ts`?) would retire all three. The latter is *not yet documented* in any cleanup audit because the architectural call (do we have one shared reader, or do hooks each own their own?) hasn't been made.

→ see `01-ndjson-stream-reader-hook.md` for the kernel pattern.

### #3 — No Suspense, no error boundary, no `error.tsx` / `loading.tsx` — every route hand-rolls its own loading + error UI

**Where:** Every page implements its own loading state (`status === 'loading'` branch in `app/page.tsx:626-633`; `streaming` + `loading` in `EvidencePanel.tsx:48-99`), its own error state (`status === 'error'` branch at `app/page.tsx:636-691`; per-page error rendering in both investigation pages), and its own empty state. The shapes drift: the feed's error rendering carries an auto-reconnect button; the investigate pages carry a back-link; the recommend page carries a back-link to the diagnosis. No `error.tsx`, no `loading.tsx` anywhere in `app/`.

**The user-visible consequence:** error and loading semantics behave differently route-by-route. A future contributor adding a new route has to re-implement the auth-revoked detection regex (already duplicated between `app/page.tsx:407` inside the stream handler and `app/page.tsx:650` in the JSX). The streaming UI's `useEffect`-based loading state cannot use the React 19 `<Suspense>` machinery the framework offers for free.

**The fix is non-trivial.** `<Suspense>` works with promises (`use()`) or React Query / SWR. Adopting it here means picking a data-fetching library OR migrating to `use(promise)` — both are bigger calls than this cleanup pass should make. The smaller win: a shared `<RouteError>` component that owns the auth-revoked detection + reconnect button.

### #4 — Inline-style vs Tailwind drift across the styling layer

**Where:** Every leaf component. ~150 inline `style={{}}` objects in `components/feed/InsightCard.tsx` (495 LOC); ~70 in `components/feed/CoverageGrid.tsx` (319 LOC); ~80 in `components/investigation/RecommendationCard.tsx` (241 LOC); ~90 in `components/investigation/EvidencePanel.tsx` (290 LOC, the *one* file that consolidates repeated styles into named `CSSProperties` constants — `EvidencePanel.tsx:13-46`).

**The user-visible consequence:** none — the styling works. The contributor-visible consequence: editing any leaf component means reading inline-styled JSX where colors, padding, borders, and font sizes all sit next to layout, accessibility attributes, and content. Diffs are big and noisy when one design token changes.

**The fix is documented and *accepted as-is*.** `cleanup-2026-06-02.md` #17 marks this `accept`: the Tailwind v4 / inline-style / CSS-variable choice landed mid-build, a top-down style-system decision is out of scope for cleanup, and one-component-at-a-time migration is the pragmatic move when each component is touched for other reasons. The `EvidencePanel`-style `CSSProperties` constants extraction is the pattern to follow when you do touch a component.

### #5 — The `<aside>` "how this briefing was gathered" sidebar is hand-rolled on the feed, but the shared `StatusLog` component exists

**Where:** `app/page.tsx:743-808` renders an `<aside>` with sticky header + `ReasoningTrace`. `components/shared/StatusLog.tsx` does the same thing, parameterized — and is used on both investigation pages (`app/investigate/[id]/page.tsx:214`, `recommend/page.tsx:186`).

**The user-visible consequence:** the three places drift over time. The feed version has a slightly different `connecting to the agent…` empty message and a longer placeholder copy (`app/page.tsx:792-805`); the shared component uses `—` (`components/shared/StatusLog.tsx:33`). Today they're close enough to read as one design; tomorrow they won't be.

**The fix is small.** Replace the inline `<aside>` block with `<StatusLog items={traceItems} title="how this briefing was gathered" countLabel={…} scanning={status === 'loading'} emptyMessage="connecting to the agent…" />`. Already named under the feed page's hooks-extraction refactor as a fold-along win.

### #6 — Streaming surfaces emit zero `aria-live` / `role="status"` / `role="log"` regions

**Where:** Documented in detail in `.aipe/audits/a11y-2026-06-02.md` Lens 6 (Dynamic content). Every place where text changes in place — the `ProcessStepper` sub-line on the feed (`app/page.tsx:50-64`), the "checking N/10…" string in `CoverageGrid:97-101`, the `StatusLog` running header, the `EvidencePanel` skeleton-to-content swap, the `StreamingResponse` "thinking…" → answer transition — is invisible to assistive technologies because no region is wrapped in a live container.

**The user-visible consequence:** for sighted users, the live agent trace IS the product (and works well). For screen-reader users, the agent's progress is silent — they hear the initial "blooming insights" heading, then nothing until the page is "done" and they retabbing into the changed content. The QueryBox input has no label (only a `placeholder`); the heading hierarchy on the investigate page skips `<h2>` (h1 → h3 via `EvidencePanel`).

**The fix is non-trivial.** Wrapping `StatusLog` in `<div role="log" aria-live="polite">` is the first move; the harder question is whether to announce every reasoning step (chatty, possibly annoying) or only milestones (diagnosis ready, recommendation count). The full a11y audit doesn't propose fixes; this lens names the consequence.

→ see `.aipe/audits/a11y-2026-06-02.md` for the full descriptive snapshot (six lenses).

---

End of audit.
