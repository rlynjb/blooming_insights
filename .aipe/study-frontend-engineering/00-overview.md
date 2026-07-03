# overview — the frontend layer in one page

The whole shape in one file. Read this and you know what the repo is.

## The rendering mode in one sentence

Next.js 16 App Router with React 19 running a **single client component page** (`app/page.tsx` opens with `'use client'`) that consumes NDJSON streams from route handlers under `app/api/*`. No RSC data flow; no server components rendering with the streamed data; no SSR handoff. The server side is a plain streaming endpoint, and the client owns everything downstream of `fetch()`.

That's the seam to hold in your head:

```
  Rendering mode — one client tree, streaming NDJSON server routes

  ┌─ Server (Next.js 16 Route Handlers) ────────────────────────┐
  │  app/api/briefing/route.ts   → NDJSON stream                 │
  │  app/api/agent/route.ts      → NDJSON stream                 │
  │  app/api/mcp/*               → REST for auth / config        │
  └─────────────────────────────┬────────────────────────────────┘
                                │ HTTP + Content-Type: application/x-ndjson
                                │ headers: x-bi-mcp-config (optional)
                                ▼
  ┌─ Client (one React tree) ───────────────────────────────────┐
  │  'use client' at the page root                               │
  │  useBriefingStream / useInvestigation                        │
  │    → fetch → readNdjson kernel → dispatch → setState         │
  │  ProcessStepper + CoverageGrid + InsightCard + ReasoningTrace│
  └──────────────────────────────────────────────────────────────┘
```

The router is file-based (`app/page.tsx`, `app/investigate/[id]/…`, `app/api/*/route.ts`) and dynamic segments carry ids. No route loaders, no `<Suspense>` boundaries defined at the route level, no route-level code splitting used deliberately — it's a small app.

## The state graph in one diagram

Every piece of state has a single owner. The rule the repo enforces without saying so out loud: server state that arrives via stream lives in the hook that owns the fetch; UI state that outlives one stream lives in `localStorage` or `sessionStorage`; nothing lives in a global store or React context.

```
  State ownership — one owner per box, no store, no context

  ┌─ owned by the streaming hook (dies with the effect) ────────┐
  │  useBriefingStream   →  insights, coverage, traceItems,     │
  │  (app/page.tsx:129)     workspace, errorMessage, status     │
  │                                                              │
  │  useInvestigation    →  items, diagnosis,                    │
  │  (per investigate/[id])   recommendations, complete, error  │
  └──────────────────────────────────────────────────────────────┘
                          ▲
                          │  hooks read on mount
                          │
  ┌─ owned by browser storage (survives reload) ────────────────┐
  │  localStorage['bi:mode']            → BriefingMode toggle    │
  │  localStorage['bi:mcp_config']      → McpConfigOverride      │
  │  sessionStorage['bi:insight:<id>']  → cross-page insight     │
  │  sessionStorage['bi:inv:*:<id>']    → investigation hydrate  │
  │  sessionStorage['bi:diag:<id>']     → diagnosis handoff      │
  └──────────────────────────────────────────────────────────────┘
                          ▲
                          │  set by the modal / hook
                          │
  ┌─ owned by useState in the page ─────────────────────────────┐
  │  activeQuery, settingsOpen, mode (mirrored from LS), ready  │
  │  (app/page.tsx:48-50, 68-69)                                 │
  └──────────────────────────────────────────────────────────────┘
```

No Redux / Zustand / Jotai / `useContext` provider tree. When a piece of data has to survive a reload (mode, MCP config) it hits Web Storage directly; when it has to cross an SPA-nav (feed → investigate) it uses `sessionStorage` with an `bi:` prefix. The rest lives in the effect that fetched it.

## The network seam in one diagram

Every streaming surface goes through **one kernel** — `readNdjson` at `lib/streaming/ndjson.ts:17-64`. Four consumers share it: `useBriefingStream`, `useInvestigation`, `useDemoCapture`, and `StreamingResponse`. This is the highest-leverage seam in the frontend.

```
  Network seam — one kernel, four consumers

  ┌─ Consumer hooks / components ───────────────────────────────┐
  │  useBriefingStream    useInvestigation                       │
  │  useDemoCapture       StreamingResponse                      │
  └──────────────────────┬───────────────────────────────────────┘
                         │  each calls fetch(), then:
                         ▼
              ┌──────────────────────────┐
              │  readNdjson<E>(          │  lib/streaming/ndjson.ts
              │    body, onEvent, opts) │        64 LOC total
              │                          │
              │  reader.read()           │  ← get chunk
              │  decoder.decode(stream)  │  ← utf-8, streaming
              │  buf.split('\n')         │  ← NDJSON framing
              │  JSON.parse(line)        │  ← one event per line
              │  onEvent(event)          │  ← consumer dispatch
              │  cancelOn?() → cancel    │  ← unmount escape hatch
              └──────────────────────────┘
                         │
                         ▼  strongly-typed events
              ┌──────────────────────────┐
              │  BriefingEvent / AgentEvent  9-case discriminated union
              │  consumer's switch(e.type)   drives setState in the hook
              └──────────────────────────┘
```

Consumers own the event shape and the setState dispatch; the kernel owns the byte-level plumbing. Stripping the kernel and reimplementing per hook was ~250 LOC of drift before the extraction; keeping it single-sourced is the load-bearing frontend refactor.

## The three highest-leverage patterns

Named with file paths so a reader can open each one.

  1. **NDJSON stream reader hook** — `lib/streaming/ndjson.ts` (kernel) + `lib/hooks/useBriefingStream.ts:299` + `lib/hooks/useInvestigation.ts:205`. The seam that lets streaming Just Work identically across 4 surfaces. If you strip it, you lose the "shows its work" progressive-render pitch and rebuild 4 near-copies of the loop. See `01-ndjson-stream-reader-hook.md`.

  2. **Progressive skeleton with stepper** — `app/page.tsx:269-341` (ProcessStepper + CoverageGrid + Skeleton stack + StatusLog). Four independent visual tiers each swap their placeholder for real data as the stream reports the matching level of detail. If you strip it, you lose the "watching the agent work" experience — the whole point of the streaming stack becomes invisible. See `02-progressive-skeleton-with-stepper.md`.

  3. **Settings modal with localStorage persistence** — `components/settings/McpConfigModal.tsx` + `lib/mcp/config.ts` + fetch header pickup in the two streaming hooks. A visitor can swap the MCP target and auth without touching env, and the state survives a reload. If you strip it, the "bring your own MCP" portfolio pitch has no UI. See `03-settings-modal-with-localstorage-persistence.md`.

## The known frontend gap (top finding)

**The streaming trace has no `aria-live` region.** `ReasoningTrace` at `components/investigation/ReasoningTrace.tsx` renders inside a plain `<div>`. When the agent's tool calls and thoughts stream in, a screen reader gets nothing. The whole "shows its work" pitch — the sticky sidebar at `app/page.tsx:443-508` — is invisible to assistive tech. Fix is one prop: `aria-live="polite"` on the container `<ol>` inside `ReasoningTrace`, `role="log"` on the wrapper.

Full ranked risk list in `audit.md` → the `frontend-red-flags-audit` lens.
