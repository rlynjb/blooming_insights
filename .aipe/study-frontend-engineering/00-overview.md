# 00 — overview

The frontend-engineering layer of `blooming_insights` in one page. Read this first; open `audit.md` for the 8-lens walk; open the `01-…` / `02-…` files for the two patterns that earn their own walkthrough.

## What this repo is, in one sentence

**Next.js 16 App Router app with a server shell and a fully client-side interactive tree, streaming agent events from serverless routes via NDJSON over `fetch` + `ReadableStream`, with progressive loading composed across four reveal surfaces.**

## Rendering mode, in one sentence

An SPA wearing an App Router shell: `app/layout.tsx` is the only server component in the user-facing tree (it boots `next/font/google` and renders children); every route page opens with `'use client'`; no `<Suspense>`, no RSC streaming, no route loaders. Streaming UX is hand-rolled in the browser, not delivered by React server rendering.

## State architecture, in one diagram

```
  State graph — one slot per owner, no global store

  ┌─ Local hook state (useState in custom hooks) ─────────────────────────┐
  │  useBriefingStream      9 slots — status, insights, workspace,         │
  │                                  coverage, traceItems, errorMessage,   │
  │                                  stepStatus, queryCount, demoSuffix    │
  │  useInvestigation       5 slots — items, diagnosis, recommendations,   │
  │                                  complete, error                       │
  │  useReconnectPolicy     1 slot  — reconnecting                         │
  │  useDemoCapture         1 slot  — capturing                            │
  │  app/page.tsx           2 slots — activeQuery, mode, ready             │
  └────────────────────────────────┬──────────────────────────────────────┘
                                   │ composes via callbacks
                                   │  (no Context, no Redux, no Zustand)
                                   ▼
  ┌─ Browser-side persistence (the cross-page handoff layer) ─────────────┐
  │  sessionStorage         bi:insight:<id>    feed → investigate          │
  │                         bi:inv:<step>:<id> stash per step              │
  │                         bi:diag:<id>       diagnosis → recommend       │
  │                         bi:reconnecting    one-shot auto-reconnect    │
  │  localStorage           bi:mode            persisted demo/live toggle  │
  └───────────────────────────────────────────────────────────────────────┘

  no React Context. no Redux. the hooks own the state; the page consumes
  their return values; sessionStorage carries state across pages because
  on Vercel different requests can hit different instances.
```

## Network seam, in one diagram

```
  Network seam — fetch + NDJSON, four consumers, one kernel

  ┌─ Client / components & hooks ──────────────────────────────────────────┐
  │                                                                        │
  │  useBriefingStream     useInvestigation     useDemoCapture (drain)     │
  │  StreamingResponse                                                     │
  │       │                       │                       │                │
  │       └────────────┬──────────┴───────────┬───────────┘                │
  │                    │                      │                            │
  │                    ▼                      ▼                            │
  │                ┌──────────────────────────────┐                        │
  │                │  readNdjson(body, onEvent,   │  ← lib/streaming/      │
  │                │             { cancelOn? })   │    ndjson.ts (64 LOC)  │
  │                └──────────────┬───────────────┘                        │
  └───────────────────────────────┼────────────────────────────────────────┘
                                  │  HTTP, application/x-ndjson, chunked
                                  ▼
  ┌─ Server / Next.js route handlers ──────────────────────────────────────┐
  │                                                                        │
  │  /api/briefing       /api/agent                                        │
  │   (monitoring)        (diagnose | recommend | combined | q=…)          │
  │                                                                        │
  │   new ReadableStream({ start(controller) {                             │
  │     for await (const evt of agent) {                                   │
  │       controller.enqueue(encoder.encode(encodeEvent(evt)))             │
  │     }                                                                  │
  │   }})                                                                  │
  │                                                                        │
  └────────────────────────────────────────────────────────────────────────┘

  the wire contract is the BriefingEvent / AgentEvent union — "what must
  not change" per the project context.
```

## Three highest-leverage frontend patterns

The whole guide ranks the frontend patterns the repo *actually* exercises. Three carry the most weight; the first two earn their own pattern files in this folder.

**1. NDJSON stream reader hook → `01-ndjson-stream-reader-hook.md`.** The browser-side consumer for streaming agent events. One kernel (`lib/streaming/ndjson.ts`, 64 LOC), four consumers (`lib/hooks/useBriefingStream.ts:288`, `lib/hooks/useInvestigation.ts:194`, `lib/hooks/useDemoCapture.ts:84`, `components/chat/StreamingResponse.tsx:108`). The whole "the agent is working" UX surface depends on this — strip it out and the trace, the streamed insights, and the progressive coverage tiles all vanish. The pattern earns extra weight from the two distinct StrictMode adaptations: `useBriefingStream` cancels on cleanup (mode toggles re-fire); `useInvestigation` deliberately does NOT cancel (a started-guard makes the effect idempotent against the dev double-mount).

**2. Progressive skeleton with stepper → `02-progressive-skeleton-with-stepper.md`.** The four-tier composition that fills the 30-60 second monitoring runtime with information instead of a spinner. Stepper says where in the pipeline (`components/shared/ProcessStepper.tsx`); coverage grid says which category just checked in (`components/feed/CoverageGrid.tsx`); skeletons reserve the card shapes (`components/shared/Skeleton.tsx`); status log streams the agent's tool calls in real time (`components/shared/StatusLog.tsx`). Three custom keyframes (`bi-fade-up`, `bi-progress`, `bi-dots`) own the polish, and all three respect `prefers-reduced-motion`. The pattern is the perceived-performance story — without it the page reads as broken at t=5s.

**3. Custom-hook decomposition with callback composition.** Not a Pass 2 file because it's an organizational pattern more than an architectural one — but it's the third-most-load-bearing move. `app/page.tsx` was 1000+ LOC before the lift; three hooks (`useBriefingStream` 313 LOC, `useDemoCapture` 146 LOC, `useReconnectPolicy` 123 LOC) plus the cross-page `useInvestigation` (202 LOC) extract the streaming, the capture loop, and the auth-reconnect dance into ownership-clear units. The page composes them via callbacks (`app/page.tsx:110-113`) — `useBriefingStream` is handed `reconnectPolicy.handle` as `onAuthError` and `reconnectPolicy.clearFlag` as `onStreamComplete`. No global event bus, no provider tree; the page glues the hooks together by passing functions. See `audit.md` → `component-architecture` for the boundary placement, and `.aipe/audits/refactors/design-frontend-extract-usereconnectpolicy.md` for the lift rationale.

## What's NOT in this layer (and where it lives)

- The `runtime` semantics of the `ReadableStream` reader loop (event loop, async scheduling) → `study-runtime-systems`.
- The wire format and HTTP/1.1 chunked-encoding mechanics → `study-networking`.
- FCP / LCP / CLS / bundle-size measurement → `study-performance-engineering`.
- XSS / CSP / token-storage trust boundaries → `study-security`.
- The `AgentEvent` / `BriefingEvent` contract as a system seam; the multi-agent orchestration upstream of the stream → `study-system-design`.
- Module / interface depth, the "deep modules" lens on `readNdjson` and the hooks → `study-software-design`.
- Test design + the AI-eval seam → `study-testing` (221 passing tests across the repo).

## Reading order

```
  00-overview.md (this file)
    ↓
  audit.md                                  ← 8 lenses, full inventory
    ↓
  01-ndjson-stream-reader-hook.md           ← the streaming substrate
    ↓
  02-progressive-skeleton-with-stepper.md   ← the perceived-performance pattern
```
