# audit — frontend engineering (blooming insights)

Pass 1. Walks the 8-lens frontend inventory against the current codebase, one `##` per lens, `file:line` grounded. `not yet exercised` is honest.

## rendering-and-reactivity

**Client-side SPA over the App Router. No SSR, no SSG, no RSC on any UI page.** Every page opens `'use client';` on line 1:

- `app/page.tsx:1`
- `app/investigate/[id]/page.tsx:1`
- `app/investigate/[id]/recommend/page.tsx:1`

The only server-rendered thing is `app/layout.tsx` — the `<html lang="en" className="dark">` shell with `next/font/google` variables (`Syne`, `Inter`, `JetBrains_Mono`). Once `HomePage()` mounts, everything is React 19 concurrent reconciliation over `useState` — no `useReducer`, no `useTransition`, no `useDeferredValue`, no `useSyncExternalStore`, no Suspense boundary anywhere in the app tree.

Reconciliation model: React 19 virtual-DOM diffing, sync mode. `next.config.ts:1-6` is empty (`{}`) — no `experimental.reactCompiler`, so React Compiler is off. `reactStrictMode` defaults on (documented in the project context), and the code is written to survive it: `useInvestigation.ts:44` and `StreamingResponse.tsx:20` each use a `startedRef` guard to avoid double-fetching under the dev-only mount → cleanup → re-mount cycle.

**Where work actually happens:** the four `useEffect`s in the app root (`page.tsx:68` — persisted mode; `useBriefingStream.ts:132` — briefing fetch; `useInvestigation.ts:46` — investigation fetch; `useDemoCapture.ts:91` — dev capture) each fire after mount. All server data arrives via `fetch()` inside the effect body. No route loaders, no `getServerSideProps` (Pages Router only), no App Router `Suspense boundary + streaming server component` pattern.

Cross-link: the async NDJSON reader's yielding behavior and how `await reader.read()` interacts with the microtask queue → `study-runtime-systems`. React 19's concurrent-scheduling primitives (`useTransition`, priority lanes) are `not yet exercised` here.

## state-architecture

**No global store. Six state seams**, in order of scope:

1. **local component state** (`useState`) — the common case. `HomePage`'s `mode`, `ready`, `activeQuery` (`page.tsx:47,62,63`); the streaming hooks' entire result shape (`useBriefingStream.ts:108-120`, `useInvestigation.ts:39-44`); the reconnect policy's `reconnecting` flag (`useReconnectPolicy.ts:69`).

2. **`localStorage`** — one key: `bi:mode`, persisted at `page.tsx:89`, read at `page.tsx:73`. Legacy migration inline (`live`, `live-sql` → `live-bloomreach`). No JSON schema, one string value.

3. **`sessionStorage`** — five keys, each single-writer:
   - `bi:insight:<id>` — the feed stashes each anomaly (`useBriefingStream.ts:53-60`) so the investigation page can hand it to `/api/agent`. Load-bearing because on Vercel serverless the feed request and the investigation request can hit different instances (server-side in-memory lookup is unreliable).
   - `bi:inv:diagnose:<id>` / `bi:inv:recommend:<id>` — each step's completed result, stashed at `useInvestigation.ts:134` on the `done` event. Re-visits and back-nav hydrate instantly from these.
   - `bi:diag:<id>` — the diagnosis handed from step 2 to step 3 (`useInvestigation.ts:139`).
   - `bi:reconnecting` — one-shot guard preventing the auto-reconnect from looping (`useReconnectPolicy.ts:35`).

4. **URL / route state** — `useParams<{ id: string }>()` at `investigate/[id]/page.tsx:34`. The insight ID is the source of truth for which anomaly is being investigated. Query parameters (`?q=`, `?demo=cached`, `?mode=`) drive the API routes.

5. **derived state** — the stepper's `state` values are derived from the fetch status inside `page.tsx:20-24` and `investigate/[id]/page.tsx:46-47`. `CoverageGrid`'s counts (`checked | monitored | firing | skipped`) are derived from the coverage array (`CoverageGrid.tsx:70-73`). No memoization — recomputed each render, cheap because the arrays are small.

6. **server-carried state** — the demo snapshot at `lib/state/demo-*.json` is committed. `/api/briefing?demo=cached` serves it as plain JSON; `useBriefingStream.ts:187-198` branches on `content-type` and takes the non-streaming path when the response is a snapshot.

**Not yet exercised:** no `useReducer`, no Context Provider tree, no form-state library, no `URLSearchParams`-driven router state (the query params are read on the server side only). Cross-link: system-level state ownership → `study-system-design`.

## component-architecture

**~20 components, mostly presentational, one custom-hook layer under `lib/hooks/`.** Composition is straightforward — `children` prop is used implicitly (`layout.tsx`, `page.tsx` wrappers), but there are no slot patterns, no render-prop components, no headless UI, no compound components, no factory components.

Component sizes tell the story (LOC counts):

| Component | LOC | Notes |
|---|---:|---|
| `InsightCard.tsx` | 495 | Largest. Presentational with derived-content helpers (`whyItMatters`, `scopeExplain`, `fmtUsd`, `fmtPct`) inline. Renders `SeverityBadge` and `Sparkline` children. |
| `CoverageGrid.tsx` | 319 | Three tile variants (pending / ghost / live) inline. Icons via `lucide-react` in a `Record<CategoryId, LucideIcon>` map. |
| `EvidencePanel.tsx` | 290 | Skeleton + real branches; embeds `<details>` disclosure for hypotheses. |
| `StreamingResponse.tsx` | 253 | Client component, owns its own NDJSON fetch. |
| `RecommendationCard.tsx` | 241 | Presentational. |
| `ProcessStepper.tsx` | 138 | Layout-heavy, `role="group"` (line 74), state-derived styling. |
| `ToolCallBlock.tsx` | 129 | Expandable JSON viewer for tool results. |
| `TraceContent.tsx` | 122 | Markdown-lite renderer for agent step content. |
| `ReasoningTrace.tsx` | 108 | Loops over `TraceItem[]`, dispatches to `AgentBadge` / `ToolCallBlock`. |
| `GapChart.tsx` | 103 | Inline SVG chart, `role="img"` at line 49. |
| `QueryBox.tsx` | 92 | Currently hidden behind `SHOW_QUERY_BOX = false` (`page.tsx:16`). |
| `AgentPipeline.tsx` | 93 | |
| `InvestigationSubject.tsx` | 89 | Banner above `EvidencePanel`. |
| `StatusLog.tsx` | 86 | Sticky sidebar wrapper around `ReasoningTrace`. |

**Container-vs-presentational boundary:** the three page components (`app/page.tsx`, `investigate/[id]/page.tsx`, `investigate/[id]/recommend/page.tsx`) are the containers — they call hooks and pass results to presentational components. The extracted hooks (`useBriefingStream`, `useInvestigation`, `useDemoCapture`, `useReconnectPolicy`) *are* the container logic pulled out of `page.tsx` — hence `page.tsx` shrunk from a larger monolith to 461 LOC by moving the effect bodies into named hooks.

**Where composition earns its keep:** `StatusLog` wrapping `ReasoningTrace` is the reuse — the same "how this was gathered / figured out" sidebar renders on all three pages with different `title` / `countLabel` / `emptyMessage` props (`StatusLog.tsx:28-34`). Same trace items shape (`TraceItem[]`, defined at `ReasoningTrace.tsx:6-24`), three different framings.

**Where it doesn't:** `InsightCard.tsx` at 495 LOC is doing three jobs (severity + headline, comparison bars, why-it-matters copy) as one deep component. It reads well because the derived-content helpers are named — but a `deriveInsightCopy(insight)` module extraction would earn its place if a second surface ever needed the same "why this metric matters" text (that's speculative; today it's called once).

Cross-link: module depth → `study-software-design` (the `readNdjson` function is the textbook deep-module example — one shallow interface, all the parsing complexity contained).

## data-fetching-and-cache

**No fetch library.** No react-query, no SWR, no route loader. Every data fetch is a bare `fetch()` inside a `useEffect`, four times:

- `useBriefingStream.ts:158` — `GET /api/briefing?demo=cached | ?mode=live-bloomreach | ?mode=live-synthetic`
- `useInvestigation.ts:180` — `GET /api/agent?insightId=...&step=diagnose|recommend`
- `StreamingResponse.tsx:92` — `GET /api/agent?q=<query>`
- `useDemoCapture.ts:59` — `POST /api/mcp/capture-demo`

**Cache strategy: none client-side, sessionStorage-as-memo on the investigation results.** The hook hydrates from `sessionStorage.getItem(stashKey(step, id))` at `useInvestigation.ts:53` before firing the fetch — the back button and step-3 → step-2 nav feel instant because the completed trace is stashed at `useInvestigation.ts:134` on the `done` event.

The demo path is the other cache: `?demo=cached` serves the committed snapshot as plain JSON. `useBriefingStream.ts:187-198` branches on `content-type: application/x-ndjson`; if it's plain JSON it drains synchronously.

**Server-side cache** lives in `McpClient` (`~1 req/s rate limit + result cache with `{result, durationMs, fromCache}` shape) — that's outside the frontend seam; see `study-system-design`.

**Optimistic mutations:** `not yet exercised`. There are no client-initiated mutations. Everything is read-only from the frontend's perspective; the "capture demo" button is dev-only and a full re-fetch after each POST.

**Error and retry:** per-call. `useBriefingStream.ts:172-183` reads the response body defensively (`readBody` at line 63-72 handles empty / HTML / 500 without throwing on `.json()`). Retry is not implemented in the hook — the auto-reconnect policy handles the auth-shaped error case only (`useReconnectPolicy.ts:33`). Any other transient failure surfaces the error to the UI and stays there until the user reloads.

Cross-link: wire semantics (keep-alive, HTTP/2 stream multiplexing, why not SSE) → `study-networking`. Cache-as-architecture (server-side rate-limit cache) → `study-system-design`.

## routing-and-navigation

**File-based, App Router, three UI routes plus API routes.** Route tree:

```
  app/
   ├─ page.tsx                         → /
   ├─ layout.tsx                       → root shell
   ├─ investigate/
   │   └─ [id]/
   │       ├─ page.tsx                 → /investigate/:id
   │       └─ recommend/
   │           └─ page.tsx             → /investigate/:id/recommend
   ├─ debug/
   │   └─ page.tsx                     → /debug
   └─ api/                             → server routes (not UI)
```

**Navigation:** `next/link` throughout (`Link` from `next/link` in `ProcessStepper.tsx:2`, `InsightCard.tsx`, `CoverageGrid.tsx:3`, `investigate/[id]/page.tsx:3`). No programmatic `router.push` in the UI layer — every navigation is a `<Link>` in the JSX.

**Dynamic segments:** `useParams<{ id: string }>()` at `investigate/[id]/page.tsx:34` reads the anomaly ID. Passed to `useInvestigation(id, 'diagnose')` which uses it as both the `sessionStorage` cache key and the `/api/agent?insightId=<id>` parameter.

**Code-splitting at the route boundary:** implicit via Next.js — each route is a separate bundle. No explicit `dynamic()` imports for lazy loading, no route-level `loading.tsx` or `error.tsx` files (checked: no matches).

**Prefetch:** Next.js `<Link>` default behavior (prefetch on viewport). Not customized.

**Guards / redirects / loaders:** `not yet exercised` for UI routes. The API routes handle auth (401 with `needsAuth: true, authUrl`), and the hooks redirect via `window.location.href = body.authUrl` on that response (`useBriefingStream.ts:164-166`, `useInvestigation.ts:181-186`, `StreamingResponse.tsx:94-99`). That's the closest thing to a route guard — client-side, per-fetch.

**Scroll restoration:** default Next.js behavior; not customized.

**Deep-linking:** every route is deep-linkable. The insight ID in the URL is the source of truth — `useInvestigation` reads it, hydrates from sessionStorage if present, else fires the fetch. A user landing directly on `/investigate/anom-123/recommend` with no stashed diagnosis will get an empty handoff (`useInvestigation.ts:73-84`) — the recommendation agent runs against the insight ID alone, without the step-2 diagnosis. Not a bug (the API supports it) but a subtle degradation the deep-link path exercises.

## styling-and-design-system

**Tailwind v4 (CSS-first) + CSS custom-property design tokens + inline `style` for everything specific.** No CSS-in-JS library, no CSS Modules, no styled-components.

**Design tokens** at `app/globals.css:3-15` — 12 tokens, one theme (dark only):

```
  --bg-base       #0f1923       --accent-teal    #00d9a3
  --bg-surface    #1a2332       --accent-coral   #fb7185
  --bg-elevated   #243040       --accent-amber   #fbbf24
  --border        #2d3a4d       --accent-purple  #a78bfa
  --text-primary    #e8edf2
  --text-secondary  #8b9bb0
  --text-tertiary   #5a6878
```

Consumed via `var(--token)` in inline `style` throughout — e.g. `page.tsx:130`, `StatusLog.tsx:41-46`, `ProcessStepper.tsx:60-63`. The `@theme inline { --color-background: var(--bg-base); ... }` block at `globals.css:17-23` bridges Tailwind's color system to the same tokens.

**Fonts** loaded server-side via `next/font/google` in `app/layout.tsx:2-7` — three families (`Syne` display, `Inter` body, `JetBrains_Mono`) exposed as CSS variables. Consumed the same way: `fontFamily: 'var(--font-mono), monospace'` on nearly every mono style block.

**Theming:** `not yet exercised` — the `dark` class on `<html>` (`layout.tsx:22`) is fixed. No light mode, no user preference toggle. The project context explicitly says "dark mode only."

**Responsive strategy:** Tailwind breakpoint utilities on the layout containers — `grid grid-cols-1 lg:grid-cols-3` and `lg:col-span-2` on the two-column split (`page.tsx:270-272`, `investigate/[id]/page.tsx:145-147`). No container queries, no fluid type, no per-component breakpoint logic. Width is capped at `max-w-5xl` on every page (project context).

**Animation:** three keyframes in `globals.css`:
- `bi-fade-up` (line 32) — item entry animation, honored by `prefers-reduced-motion` at line 42
- `bi-indeterminate` (line 46) — the progress bar under `StatusLog` when scanning
- `bi-dot` (line 69) — three-dot loading indicator

`prefers-reduced-motion` is honored for `bi-progress` and `bi-dots` at `globals.css:77-79`. Good hygiene.

**Design system scaling:** the token set holds up for the current 20-ish components because most surfaces are grayscale (`--text-*`, `--bg-*`) with accents (`--accent-*`) reserved for severity signals. The system does NOT scale to a second theme without pulling the color tokens out of `:root` and behind a theme selector. That's a foreseeable refactor when light mode arrives, not a red flag today.

Cross-link: FCP / LCP measurement, bundle-size numbers → `study-performance-engineering`. Design-system depth (what makes tokens "compose") → `study-software-design`.

## browser-platform-and-build

**Web APIs actually used:**

| API | Where | Purpose |
|---|---|---|
| `fetch` | four hooks + `StreamingResponse` | primary data seam |
| `ReadableStream` + `getReader` + `TextDecoder` | `lib/streaming/ndjson.ts:31-33` | NDJSON parse loop |
| `localStorage` | `page.tsx:73,89` | `bi:mode` persistence |
| `sessionStorage` | 5 keys across `useBriefingStream`, `useInvestigation`, `useReconnectPolicy` | cross-page state carry |
| `crypto.randomUUID()` | `useBriefingStream.ts:222`, `useInvestigation.ts:114`, `StreamingResponse.tsx:54` | trace item IDs |
| `window.location.href` | reconnect + auth-redirect paths | full-page navigation |
| `window.alert` | `useDemoCapture.ts:99,134,136` | dev-only capture status |
| `Blob` + `URL.createObjectURL` | markdown export (`lib/export/investigationMarkdown.ts`, per project context) | file download |

**Not touched:** `WebSocket`, `EventSource`, `IndexedDB`, `Cache API`, `ServiceWorker`, `MediaRecorder`, `Notification`, `WebWorker`, `WebRTC`, `File System Access`, `WebAuthn`, `MessageChannel`. The frontend is HTTP-request-and-stream shaped — no persistent connection, no offline story, no background sync.

**Bundler:** Next.js 16's default (Turbopack in dev, Webpack for production build). `next.config.ts` is empty — no `experimental` flags, no custom webpack config, no `transpilePackages` list.

**Code-splitting:** implicit route splitting via Next.js. No explicit dynamic imports.

**Tree shaking:** relies on Next.js defaults. `lucide-react` icons imported by name (`CoverageGrid.tsx:6-16`) — tree-shakes to only the icons used (10 of them, matching the 10 coverage categories).

**Sourcemaps / polyfills:** Next.js defaults; not customized.

**Font loading:** `display: 'swap'` set at `layout.tsx:5-7` — text renders immediately in fallback fonts, no invisible-text FOIT.

Cross-link: bundle-size measurement (numbers) → `study-performance-engineering`. Why NDJSON over `EventSource` / WebSocket → `study-networking`.

## frontend-red-flags-audit

Ranked by user-visible consequence. Each anchored to `file:line`.

### 1 — the streaming trace is invisible to assistive tech

**No `aria-live` region on any surface that streams new content.** The reasoning trace, tool calls, status log, and the streaming Q&A response all mount new DOM nodes as NDJSON events arrive. A screen-reader user gets nothing — no announcement, no polite update.

Evidence: `StatusLog.tsx:36-84` (sticky aside, no `aria-live`), `ReasoningTrace.tsx:52-108` (the trace list, no `role="log"`), `StreamingResponse.tsx:121-252` (the free-form Q&A response, no live region). `grep -rc "aria-live\|role=\"log\"" components/ app/` returns zero.

`ProcessStepper` has `role="group"` (line 74) and `Sparkline` / `GapChart` have `role="img"` (lines 27 / 49) — that's the extent of ARIA. Nothing that announces changes.

Consequence: the "shows its work" pitch — the entire selling point — is silently invisible to a category of user. This is a user-facing correctness bug, not a nice-to-have.

Fix: `role="log" aria-live="polite" aria-relevant="additions"` on the `StatusLog` inner container (the `<div>` at `StatusLog.tsx:68`). Same on `StreamingResponse`'s answer wrapper. Test with VoiceOver: each new line should announce.

### 2 — every child component re-renders on every NDJSON event

`useBriefingStream` accumulates state via multiple `setState` calls per event (e.g. `case 'tool_call_start'` at `useBriefingStream.ts:218-224` calls `setQueryCount` then `setTraceItems`). Each `setState` triggers a re-render of `HomePage`, which cascades to `CoverageGrid`, `InsightCard`s, and `StatusLog` on every event.

Evidence: no `React.memo` on any component (`grep "React.memo" components/` returns nothing). No `useMemo` for the arrays passed as props (`coverage`, `insights`, `traceItems`). Under React 19's default reconciliation each re-render is a full diff of the entire tree.

Consequence: at 20–40 events per live briefing, the feed re-renders 20–40 times. Today's payload is small enough that the human eye doesn't see jank (the animations mask it), but the moment the trace hits ~200 items — a longer investigation, or a chattier agent — the `ReasoningTrace` map over all trace items on every event becomes a measurable cost.

Fix (when it becomes measurable, not now): `React.memo` on `InsightCard`, `CoverageGrid` tile children, and `TraceItem` rows keyed by `id`. Prefer `useMemo` on the derived counts in `CoverageGrid.tsx:70-73`. Real measurement belongs in `study-performance-engineering`.

### 3 — pre-existing lint errors in hook effects (known follow-up)

Five known lint violations documented in the project context. `next lint` flags them; the code works because React 19 tolerates the pattern, but each is a real hazard:

- `app/page.tsx:70` — `setState` inside `useEffect` synchronously (the `setMode('demo')` when `forcedDemo` is true)
- `components/investigation/InvestigationSubject.tsx:18` — same shape
- `lib/hooks/useBriefingStream.ts:125` — mutating a ref during render (`callbacksRef.current = callbacks`)
- `lib/hooks/useBriefingStream.ts:139` — `setState` in effect (part of the reset block)
- `lib/hooks/useInvestigation.ts:56` — `setState` in effect (the hydrate branch)
- `lib/hooks/useDemoCapture.ts:143` — `useCallback` missing a dep

These pre-existed the Week 3-4 hardening; documented as a follow-up. Not runtime bugs today; every one of them is a code-smell that will bite the next person who edits the hook.

### 4 — `bi:mode` legacy migration is silently write-once

`page.tsx:75-77` migrates legacy `live` / `live-sql` values to `live-bloomreach` on read — but doesn't write the migrated value back. Every mount pays the migration cost and every mount re-reads the same legacy value. Cheap, but a code smell.

Fix: after the migration branch, call `localStorage.setItem('bi:mode', 'live-bloomreach')`. Two lines.

### 5 — inline `style={{...}}` everywhere is going to bite at scale

Every component uses inline `style` for tokens (`page.tsx:127-134`, `CoverageGrid.tsx:126-140`, etc.). React re-creates the style object on every render, defeating browser-level style caching. Tailwind + CSS custom properties could carry more of the weight — `bg-[var(--bg-elevated)]` and Tailwind arbitrary values would let the JIT hoist the styles.

Not a bug today, but the trend (`components/` totals 2,746 LOC with a ton of inline-style boilerplate) is real. A single utility like `<Card>` / `<MonoLabel>` with the token application inlined once would remove ~200 LOC of style-prop repetition. Small win; deferrable.

### Not-red-flags I checked and left alone

- **`<html lang="en">`** — present at `layout.tsx:22`. Good.
- **Font-loading FOUT/FOIT** — `display: 'swap'` at `layout.tsx:5-7`. Good.
- **Reduced motion** — respected at `globals.css:42,77-79`. Good.
- **Focus visible** — Tailwind's Preflight ships a `:focus-visible` outline reset; the app doesn't override it. Acceptable.
- **Keyboard trap in `<details>`** — used at `EvidencePanel.tsx:215`, native disclosure element, keyboard-accessible by default. Good.

Cross-link: XSS surface on the agent-produced `TraceContent` / `answer` fields → `study-security`. Contrast ratio on `--text-tertiary` (#5a6878) on `--bg-base` (#0f1923) → `study-frontend-a11y` (dedicated a11y audit runs there, not here).
