# audit — frontend engineering, 8 lenses

Pass 1. Walk the codebase against the 8-lens inventory. Every applied claim grounded in a `file:line`. Cross-links to Pass 2 pattern files where a lens finding has a dedicated deep walk.

Reader posture: senior frontend engineer. No definitions of `useState` or "what a hook is." Straight to what THIS repo does.

## 1. rendering-and-reactivity

**Rendering mode.** Next.js 16 App Router (`next: 16.2.6`, `react: 19.2.4` per `package.json:22-24`). The app is single-page-app-shaped despite the router — `app/page.tsx:1` opens with `'use client'`, `app/investigate/[id]/page.tsx:1` opens the same, and no `page.tsx` in the tree renders anything server-side beyond `layout.tsx` (which is presentational font wiring — `app/layout.tsx:14-27`). No `<Suspense>` at the route level, no `loading.tsx` files, no server components consuming the stream data. Route handlers under `app/api/*/route.ts` stream NDJSON; the client tree consumes the streams via `fetch()`.

**Reconciliation model.** React 19 virtual-DOM, no compiler pragmas, no `use client`-only optimizations flipped on in `next.config.ts:1-7` (config is empty). Reconciliation runs on every setState from the stream dispatcher — each NDJSON event that mutates state (`setInsights`, `setCoverage`, `setTraceItems` at `lib/hooks/useBriefingStream.ts:220-273`) triggers a render pass. Not batched via `flushSync` or `startTransition`; the default React 19 automatic batching handles concurrent setState calls in the same microtask.

**Scheduling.** No `useTransition`, no `useDeferredValue`, no `useOptimistic` anywhere in the repo (grep returns zero hits across `app`, `components`, `lib`). Streaming updates hit the reconciler as they arrive; on a fast stream this can be dozens of `setState` calls per second (each NDJSON event → one setState) — deliberately un-throttled so the "shows its work" trace stays live.

**When work actually happens.** Client hydration on page mount; every subsequent update is a client-side setState. No `useEffect` runs work at commit that could be moved to render or vice versa — the streaming effect starts on mount and cleans up on `mode` / `ready` change (`lib/hooks/useBriefingStream.ts:137-311`).

**Cross-link.** The event loop and how React schedules work belongs to `study-runtime-systems`. This lens names what the repo does; not why the loop is shaped that way.

## 2. state-architecture

Every piece of state has one owner. The rule the repo enforces without stating: no global store, no `useContext` provider tree, no Redux / Zustand / Jotai. Grep finds zero `createContext` calls. Not "we thought about it and rejected it" — the shape is small enough that a store would be premature.

**Owners, from longest-lived to shortest.**

  - **Browser storage — survives reload.**
    - `localStorage['bi:mode']` (`app/page.tsx:79-82`) — the demo/live-synthetic/live-mcp toggle. Legacy values `'live'`, `'live-sql'`, `'live-bloomreach'` rewrite in-place to `'live-mcp'` on read (`app/page.tsx:83-96`).
    - `localStorage['bi:mcp_config']` (`lib/mcp/config.ts:34`, key exported so the modal at `components/settings/McpConfigModal.tsx:5-9` reads/writes through helper functions, not the raw key). The MCP override object — url, authType, optional bearer.
    - `sessionStorage['bi:insight:<id>']` (`lib/hooks/useBriefingStream.ts:54-61`) — feed writes each insight so the investigate page can hydrate on cross-page navigation without a server round-trip.
    - `sessionStorage['bi:inv:<step>:<id>']` (`lib/hooks/useInvestigation.ts:20`) — investigation results, so back-nav and StrictMode double-mount hydrate instantly.
    - `sessionStorage['bi:diag:<id>']` (`lib/hooks/useInvestigation.ts:21`) — diagnosis handed from step 2 to step 3.

  - **useState in the streaming hook — dies with the effect.**
    - `useBriefingStream` (`lib/hooks/useBriefingStream.ts:113-125`) owns 9 pieces: `status`, `insights`, `workspace`, `errorMessage`, `demoSuffix`, `stepStatus`, `queryCount`, `traceItems`, `coverage`.
    - `useInvestigation` (`lib/hooks/useInvestigation.ts:40-45`) owns 5: `items`, `diagnosis`, `recommendations`, `complete`, `error`.

  - **useState in the page — UI-only, no cross-effect sharing.**
    - `activeQuery`, `settingsOpen`, `mode`, `ready` (`app/page.tsx:48-69`). `mode` mirrors localStorage but ISN'T authoritative — the LS write happens on toggle (`app/page.tsx:107-109`), state follows.

**Derived state.** Computed in-render, not stashed: `isDemo` (`app/page.tsx:70`), `forcedDemo` (`:67`), coverage counts (`components/feed/CoverageGrid.tsx:70-73`). No `useMemo` for these — cheap enough to recompute per render.

**Form state.** The MCP config modal at `components/settings/McpConfigModal.tsx:35-38` uses four `useState` fields (url, authType, bearerToken, initialized) — plain controlled inputs, no form library. Validation is one-line: `save-disabled` when `authType === 'bearer' && !bearerToken.trim()` (`:277`, `:59`).

**Server state → client state.** The seam is `readNdjson` (`lib/streaming/ndjson.ts:17`). The hook that owns the fetch owns the derived client state — there's no `react-query` / `swr` / route loader involved. See `01-ndjson-stream-reader-hook.md`.

**Cross-link.** Where state "should" live at the system level (server vs client, cache vs source of truth) → `study-system-design`. This lens names where the state currently lives.

## 3. component-architecture

**Composition patterns exercised.**

  - **Presentation-only visual atoms.** `components/shared/Skeleton.tsx` (18 LOC), `components/shared/AgentBadge.tsx`, `components/feed/SeverityBadge.tsx`. Named for what they render, no state, take props, return JSX. Textbook presentational components.

  - **Compound-ish stepper.** `components/shared/ProcessStepper.tsx` (139 LOC) takes three named props (`monitoring`, `diagnostic`, `recommendation`), each a `StepInput` (`state | sub? | href?`). The page hands three sibling inputs; the stepper renders three sibling steps with a shared badge/label/sub layout. Not a headless "compound component" API with children slots — it's a prop-driven fixed-three-slot pattern. Simpler than it looks and correct for a fixed pipeline.

  - **Fixed-slot container-with-inputs.** `components/feed/CoverageGrid.tsx` (319 LOC) takes `coverage`, `insights`, `loading`, walks a fixed `CATEGORIES` list from `lib/agents/categories`, and renders one tile per category — even the "not yet reported" ones as pending skeletons (`:74`, `settling`). Container-with-inputs, not container-with-children.

  - **Presentational trace.** `components/investigation/ReasoningTrace.tsx` (108 LOC) takes `items: TraceItem[]`, dispatches on `item.kind === 'step' | 'tool'`, renders each accordingly. Sub-parts (`AgentBadge`, `TraceContent`, `ToolCallBlock`) split by concern.

  - **New modal, imperative-open pattern.** `components/settings/McpConfigModal.tsx:34` takes `{ open, onClose, onSaved? }`. The parent owns `settingsOpen` (`app/page.tsx:49`); the modal returns `null` when `!open` (`:50`). Not a `<Dialog>` from a headless-UI library — a hand-rolled `role="dialog" aria-modal="true"` container. See `03-settings-modal-with-localstorage-persistence.md`.

**Boundary placement discipline.** Business logic sits in `lib/hooks/*` (313 LOC `useBriefingStream`, 213 LOC `useInvestigation`, 146 LOC `useDemoCapture`, 123 LOC `useReconnectPolicy`). Components stay lean and consume the hook output. The page (`app/page.tsx`, ~517 LOC) is the composition root — it wires hooks to components. This is textbook and worth naming: **the page is a wiring file, not a logic file.**

**Abstraction earning its place.** `readNdjson` (64 LOC) is the strongest earn — it removed ~250 LOC of drift across four consumers. See `01-ndjson-stream-reader-hook.md`. `useReconnectPolicy` extracted the revoked-token dance the alpha Bloomreach server forces. `useBriefingStream` is close to load-bearing size (325 LOC) but it does exactly one job — this is the streaming-consumer bloat, not an accidental god-hook.

**Container-vs-presentational.** Not enforced as a rule; observed in practice. Hooks contain, components present. No mixed component that both fetches and renders decorative markup.

**Cross-link.** Deep-modules-vs-shallow, information hiding, complexity → `study-software-design`. This lens names the composition patterns; the deep-vs-shallow judgment lives there.

## 4. data-fetching-and-cache

**How server state crosses into client state.** Every fetch happens inside a hook `useEffect` — no route loaders (Next.js 16 App Router doesn't have `loader` files anyway), no `Server Components fetching for the client tree`, no `use()` on promises. The pattern is uniform:

  1. `useEffect` on mount / dep-change → run the fetch.
  2. `fetch('/api/…', { headers: mcpHeader ? { [BI_MCP_CONFIG_HEADER]: mcpHeader } : undefined })` (`lib/hooks/useBriefingStream.ts:167-169`, `lib/hooks/useInvestigation.ts:189-191`).
  3. Check status → auth-redirect on 401 + `body.needsAuth` + `body.authUrl` (`useBriefingStream.ts:173-181`, mirrored in `useInvestigation.ts:192-198`).
  4. `readNdjson(res.body, handle, { cancelOn })` — one kernel, four consumers.
  5. `handle(event)` dispatches on `event.type` → `setState`. See `01-ndjson-stream-reader-hook.md`.

**Query library.** None. No react-query, swr, tanstack-query, or Apollo. Zero dependencies of that shape in `package.json:22-30`.

**Route loaders.** Not applicable — Next.js 16 App Router doesn't use route loaders the way Remix does; data lives in server components or in client hook effects. This repo picks client hook effects.

**Streaming pattern.** NDJSON (application/x-ndjson) over `fetch()`, not SSE (`EventSource`) and not WebSocket. Frame-per-line, JSON.parse per frame, dispatch per event. See `01-ndjson-stream-reader-hook.md` for the kernel; wire-format semantics belong to `study-networking`.

**Mutations + optimistic updates.** Only mutation is the MCP-config write from the modal (`components/settings/McpConfigModal.tsx:52-63`, calls `writePersistedConfig` from `lib/mcp/config.ts:121-138`). It's client-only (`localStorage`) — no server mutation, no rollback needed. The modal calls `window.location.reload()` after save (`app/page.tsx:263-264`) to make the new header take effect on the next fetch. Simplest state model; costs one page refresh; buys correctness without a state-invalidation graph.

**Cache invalidation strategy.** Not a cache-heavy app. `sessionStorage` hydrates instant-visible state on re-mount (`useInvestigation.ts:52-64`) — the reload is the invalidation trigger for MCP config, and the `bi:mode` toggle rebuilds the fetch URL (`useBriefingStream.ts:143`) which re-triggers the effect.

**Error and retry behavior.**
  - HTTP 401 → check `body.needsAuth + body.authUrl` → redirect. No retry.
  - HTTP not-ok → surface `body.error || body.__raw || http <status>` (`useBriefingStream.ts:184-193`). No retry.
  - NDJSON `type: 'error'` event → callback `onAuthError` gets first shot; if it returns true (auth-shaped, reconnect fired), bail; otherwise `setStatus('error')` (`useBriefingStream.ts:285-295`).
  - Revoked-token reconnect belongs to `useReconnectPolicy` — one-shot guard + reset + reload (see the hook at `lib/hooks/useReconnectPolicy.ts`).
  - Malformed NDJSON line → `readNdjson`'s `onMalformed` callback (default: silent skip, `lib/streaming/ndjson.ts:24-25`, `:47-49`).

**Cross-link.** Wire semantics, HTTP framing, streaming transport rules → `study-networking`. Cache-as-architecture, source-of-truth boundaries → `study-system-design`. This lens is the client-side data-plumbing layer only.

## 5. routing-and-navigation

**Route structure.** File-based via App Router:

```
  app/
    layout.tsx                          root layout, fonts + dark class
    page.tsx                            home / feed  ('use client')
    globals.css                         design tokens
    api/
      briefing/route.ts                 GET → NDJSON briefing stream
      agent/route.ts                    GET → NDJSON agent stream
      mcp/*                             REST for MCP auth/config
    investigate/[id]/
      page.tsx                          diagnose step  ('use client')
      recommend/…                       recommend step
    debug/                              dev-only pages
```

**Code-splitting at the route boundary.** Whatever Next.js gives for free — nothing configured. No dynamic `import()` used deliberately in the app tree (`grep -r "dynamic(" app components lib` returns nothing frontend-side).

**Navigation lifecycle.** `next/link` used in `components/shared/ProcessStepper.tsx:2, 127` to jump between the three pipeline steps when `href` is set. No `router.push` calls that I can see used for the main flow. No `<Suspense>` boundaries defined at route entry — a hard fetch fires on mount, the loading skeleton renders in the same tree.

**Prefetch / transitions.** `next/link` default prefetch is in use (not opted out). No `useTransition` around navigation — the loading state is streamed data, not a transition.

**Guards / redirects / loaders.** Guarding lives at the API layer, not the route: `app/api/briefing/route.ts` and `app/api/agent/route.ts` return `401 + needsAuth + authUrl` on missing auth; the client hooks translate that to `window.location.href = authUrl` (`lib/hooks/useBriefingStream.ts:175-178`, `lib/hooks/useInvestigation.ts:193-197`). No client-side auth guard.

**Scroll restoration.** Default browser + Next.js behavior. Not configured.

**Deep-linking.** `?demo=cached` URL param reaches the demo path even with the mode toggle hiding demo (`app/page.tsx:187-192` and `lib/hooks/useBriefingStream.ts:143`). Dynamic segment `investigate/[id]` carries the insight id.

Small routing surface, deliberately simple.

## 6. styling-and-design-system

**CSS architecture.** Two systems, deliberately layered:

  1. **CSS custom properties (design tokens) — `app/globals.css:3-14`**. Named accents, background band, text tiers, borders. Every component reads these via inline `style={{ color: 'var(--text-primary)' }}` — this is the load-bearing move for theming. Grep finds ~200+ references to `var(--…)` across components.
  2. **Tailwind v4 utility classes** — `@import "tailwindcss"` at `app/globals.css:1`, `@theme inline` block at `:17-23` binding tokens to Tailwind's color scale. Used sparingly for layout primitives: `className="min-h-screen px-6 py-10 mx-auto w-full max-w-5xl"` (`app/page.tsx:141`).

**Not CSS Modules; not CSS-in-JS.** No `.module.css`, no styled-components, no emotion. Inline `style={{}}` for everything a token drives; Tailwind for layout scaffolding. This is the specific mix worth naming: **tokens through inline style, spacing through Tailwind**. It's not conventional and it works because the token set is small (14 variables) and the app is small.

**Design tokens.**
  - Background band: `--bg-base` `--bg-surface` `--bg-elevated` `--border`.
  - Text tiers: `--text-primary` `--text-secondary` `--text-tertiary`.
  - Accents: `--accent-teal` (success/action), `--accent-coral` (error/critical), `--accent-amber` (warning/hypothesis), `--accent-purple`.
  - Type: `--font-display` (Syne), `--font-body` (Inter), `--font-mono` (JetBrains Mono) wired at `app/layout.tsx:2-7`.

Semantic naming (`--accent-teal` is used everywhere "action" is meant) — one color, one meaning. Themes could be added by swapping the `:root` block; not yet exercised — the app is dark-only via `<html lang="en" className="dark">` at `app/layout.tsx:20`.

**Theming (dark mode, brand).** Dark-only. `not yet exercised` for light-mode or theme switching.

**Responsive strategy.** Tailwind breakpoints. `className="grid grid-cols-1 lg:grid-cols-3"` (`app/page.tsx:326`) is the load-bearing responsive rule — feed becomes single-column below `lg`, two-column feed + sidebar trace above. Grep for `lg:`/`md:`/`sm:` shows a handful of usages, no container queries. No fluid type; type sizes are fixed rem values via inline style.

**Animation system.** Two CSS keyframes (`bi-fade-up` referenced at `components/feed/CoverageGrid.tsx:77`, `components/investigation/ReasoningTrace.tsx:66, 94`) plus Tailwind's `animate-pulse` on active state badges (`components/shared/ProcessStepper.tsx:109`, `components/feed/CoverageGrid.tsx:98`). No motion library.

**How the design system scales.** As-is — inline `style` per component reads tokens. Scales linearly with usage sites, no worse. If the app grew to 100+ components a token-resolver hook or a class-name mapping would earn its place; at current scale, direct token reads are fine.

## 7. browser-platform-and-build

**Web APIs the repo actually touches.**
  - **`localStorage`** — `bi:mode` (`app/page.tsx:79-92, :108`), `bi:mcp_config` via `lib/mcp/config.ts:106-138`. Try/catch around every read/write for private-browsing / blocked storage.
  - **`sessionStorage`** — `bi:insight:<id>` (`lib/hooks/useBriefingStream.ts:54-61`), `bi:inv:*` and `bi:diag:*` (`lib/hooks/useInvestigation.ts:20-21, 53-64, 135-142`).
  - **`fetch` + `ReadableStream` + `getReader` + `TextDecoder`** — the whole NDJSON pipeline, canonical implementation at `lib/streaming/ndjson.ts:28-64`.
  - **`crypto.randomUUID()`** — used for on-the-fly trace item ids in the streaming dispatchers (`lib/hooks/useBriefingStream.ts:233, 245`, `lib/hooks/useInvestigation.ts:115`). Web-Crypto, standard modern-browser API.
  - **`window.location.href`** for the OAuth redirect and reload after config save (`useBriefingStream.ts:177`, `app/page.tsx:264`).
  - **`btoa` / `atob`** for base64-encoding the MCP config header (`lib/mcp/config.ts:80-93`). Runtime-detected — falls back to Buffer for Node.

**Not touched.** `not yet exercised` for `EventSource`, `WebSocket`, `IndexedDB`, `MediaRecorder`, `Web Workers`, `Service Workers`, `Cache` API, `File System Access`, `Notifications`, `Permissions`, `Web Share`, `Web Speech`, `Intersection Observer`, `Resize Observer`. This is a streaming-fetch app; the wire format is NDJSON over HTTP and everything else stays out of the way.

**Bundler.** Next.js 16 default — Turbopack for dev, Webpack for prod build (unless a flag says otherwise; `next.config.ts` is empty at `:1-7`). Not configured — reader takes Next.js defaults on trust.

**Code splitting, tree shaking, polyfills, sourcemaps.** All Next.js defaults. Not configured or overridden.

**Cross-link.** Bundle-size and FCP / LCP *measurement* → `study-performance-engineering`. This lens names *which* APIs are reached for; the measurement layer names how big / how fast.

## 8. frontend-red-flags-audit

Ranked by user-visible consequence. Each grounded in evidence.

### R1 (top) — streaming trace has no `aria-live`; assistive tech gets nothing during a briefing

**Evidence.** `components/investigation/ReasoningTrace.tsx:52-63` — the container is a plain `<div>` with `flex-direction: column`. Grep for `aria-live` across `app`, `components`, `lib` returns zero hits. The sticky sidebar at `app/page.tsx:443-508` mounts this component and streams up to dozens of new `TraceItem`s during a live briefing.

**User-visible consequence.** A screen-reader user gets no announcement that new tool calls or reasoning steps appeared. The entire "shows its work" pitch — the whole reason for the streaming sidebar — is silent to them. The visible UI updates every ~200ms during a live run; the accessibility tree gets one snapshot at mount.

**Fix, one line each.** On `ReasoningTrace`'s outer container: `role="log"` + `aria-live="polite"` + `aria-relevant="additions"`. Optionally `aria-atomic="false"` (default anyway). Polite so it doesn't preempt other announcements.

### R2 — MCP bearer token in `localStorage` is under-protected relative to the OAuth cookie

**Evidence.** `components/settings/McpConfigModal.tsx:171-205` — the bearer token is stored via `writePersistedConfig` → plain `localStorage.setItem('bi:mcp_config', JSON.stringify(...))` (`lib/mcp/config.ts:134`). The modal itself surfaces the warning in the UI (`:192-203`), but the *default* still stores plaintext.

**User-visible consequence.** Any XSS on the origin exfiltrates the bearer. The comparison bar is the existing `bi_auth` cookie — AES-256-GCM encrypted, HttpOnly, SameSite=None — which XSS can't read. The modal is honest about the gap; the gap remains.

**Cross-link.** Full trust-boundary discussion → `study-security`. This lens flags it as a frontend risk because the UI is what stores the token; the deeper analysis belongs there.

### R3 — the streaming hooks re-run every setState down the whole tree

**Evidence.** `lib/hooks/useBriefingStream.ts:220-273` — every NDJSON event triggers one of `setInsights` / `setCoverage` / `setTraceItems` / `setStepStatus` / `setStatus`. On a fast live briefing that's 30-50 setState calls per second. The hook returns 9 pieces, all in one object (`:313-323`), so `app/page.tsx:120-132` destructures them and every value change re-renders the page tree — which then re-renders CoverageGrid, ProcessStepper, and ReasoningTrace even if their specific inputs didn't change.

**User-visible consequence.** Currently: none visible — the app is small enough that reconciler cost is trivial. Latent: if the trace grew to hundreds of items or CoverageGrid grew to N=100+ categories, jank would appear during streaming. No `React.memo`, no `useMemo` on the returned object, no split hooks.

**Fix worth naming.** Split `useBriefingStream` into a stream-consumer + a state-selector split, or `React.memo` the leaf components with stable-prop discipline. Not urgent — currently well within budget.

### R4 — StrictMode double-mount was hit, worked around by a `startedRef` guard

**Evidence.** `lib/hooks/useInvestigation.ts:38, 44-50` — a `startedRef` prevents a second run. The comment at `:36-38` explains why: cancelling the fetch on the first cleanup left the logs empty in dev. The chosen tradeoff is *"the in-flight run simply completes; setState after unmount is a safe no-op"*.

**User-visible consequence.** None in production. In dev, previous versions showed empty trace on remount; the guard fixed it. Latent risk: if React ever tightens the "setState after unmount" warning into a hard error, this needs revisiting.

**Fix.** Live with it; the note in-repo (`:32-38`) is the load-bearing artifact.

### R5 — the mode toggle relies on `bi:mode` reads across two places that must agree

**Evidence.** `app/page.tsx:78-100` reads `localStorage.getItem('bi:mode')` and migrates legacy values in one place. `lib/hooks/useInvestigation.ts:158-171` reads the same key and does the same legacy migration — separately. Two sites, one contract, no shared reader.

**User-visible consequence.** If one migration rule drifts from the other, the feed's mode and the investigation's mode can disagree. The tests catch the current shape; a new legacy value added to only one site would slip.

**Fix.** Extract a `readBriefingMode()` helper into `lib/state/mode.ts` (or reuse the existing state layer) and have both call sites use it. Small refactor, one file.

### R6 — inline `style` everywhere; CSS custom properties do the theming work

**Evidence.** Every component reads tokens via inline `style={{ color: 'var(--…)'}}`. Grep across `components/` finds hundreds of usages. `app/globals.css` defines the tokens; there is no Tailwind theme extension that binds them to utility class names beyond the `@theme inline` block at `:17-23`.

**User-visible consequence.** None today. As the app grows, replacing every inline `style` with a themed class name would be a mechanical refactor (~200+ sites). Named as a **latent scaling cost**, not a current defect.

**Fix.** Delay until a second theme (light mode, brand skin) actually earns its place. Until then, the inline-style pattern reads clearly and is fine.

### R7 — routes are all `'use client'` at the leaf; no server components in the tree

**Evidence.** `app/page.tsx:1`, `app/investigate/[id]/page.tsx:1` both open with `'use client'`. `app/layout.tsx:14-27` is a plain wrapper with fonts and the `dark` class — the only server component in the tree, and it renders no data.

**User-visible consequence.** No SSR HTML with data — the initial paint is the client shell + loading skeleton, and the streaming fetch happens after hydration. For a portfolio piece this is fine; for a real product the first-view content would come after the first fetch round-trip, not with the initial HTML.

**Fix.** Not urgent. When SEO or FCP actually matter, hoist the workspace-header data into a server-fetched page shell, keep the streaming below the fold client-side.

### R8 — the trace scrolls but there's no scroll-to-latest as items arrive

**Evidence.** `app/page.tsx:443-508` — the aside is `overflowY: 'auto'` with a fixed `maxHeight`. `components/investigation/ReasoningTrace.tsx:52-63` renders items in mount order. No `useEffect` that scrolls the container to the last item on new arrivals; no `scrollIntoView`; no `ref` on the last item.

**User-visible consequence.** As the trace grows past the viewport, new items appear below the fold silently. The user has to scroll manually to see the agent's latest work. Contradicts the "shows its work" pitch.

**Fix.** One effect: on `traceItems.length` change, `scrollRef.current?.scrollTo({ top: scrollHeight, behavior: 'smooth' })` — guarded by a "user scrolled up manually? then don't auto-scroll" check.

---

**Cross-links.** Security-owned findings (R2 in detail) → `study-security`. Performance-measurement findings → `study-performance-engineering`. This audit names the frontend risks; the deeper "why" for security and performance sits with those generators.
