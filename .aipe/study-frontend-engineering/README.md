# study — frontend engineering (blooming insights)

Per-repo guide to the framework-and-platform layer of this Next.js 16 + React 19 codebase: how the client is rendered, where state lives, how the UI reads NDJSON off a `fetch()` body, how the streaming trace and coverage grid compose, and what platform APIs the app touches. The mechanics behind the box — request pool semantics, the event loop, FCP/LCP measurement, XSS/CSP, agent orchestration — live in their own guides (cross-linked below).

## Reading order

```
  START HERE
     │
     ▼
  ┌─────────────────────┐
  │ 00-overview.md      │   one page — the rendering mode,
  │                     │   the state graph, the three
  │                     │   load-bearing patterns
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │ audit.md            │   Pass 1 — 8 lens sections against
  │                     │   file:line evidence, one lens
  │                     │   ranks the red flags
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │ 01-ndjson-stream-   │   Pass 2 — the load-bearing kernel:
  │ reader-hook.md      │   fetch → getReader → decode → split
  │                     │   → JSON.parse → dispatch, in ONE
  │                     │   function reused four surfaces deep
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │ 02-progressive-     │   Pass 2 — the perceived-instant
  │ skeleton-with-      │   composition: 4 tiers of feedback
  │ stepper.md          │   (skeleton · stepper · coverage
  │                     │   grid · status log) shipped from
  │                     │   the same NDJSON stream
  └─────────────────────┘
```

## Cross-links — neighboring guides that own adjacent mechanisms

- **`study-runtime-systems`** — the event loop and microtask queue behind the async NDJSON reader; ReadableStream backpressure and how `await reader.read()` yields.
- **`study-networking`** — the wire semantics for the NDJSON contract, keep-alive, response streaming vs `EventSource`, and why this repo does NOT use SSE.
- **`study-performance-engineering`** — measurement (FCP / LCP / TTI / bundle size) of the progressive-composition pattern this guide describes as *what* renders when.
- **`study-security`** — XSS surface (the trace content is user-controlled agent output), CSP posture, and how `sessionStorage` / `localStorage` handle client-carried state.
- **`study-software-design`** — module depth: `readNdjson` (64 LOC, one exported function) is the textbook deep module this guide names as a pattern.
- **`study-system-design`** — system-level state ownership: which store owns each piece of state (in-memory, sessionStorage, dev-file, demo snapshot), why the browser carries the insight across Vercel instances.
- **`study-testing`** — the test seams around `readNdjson`, the briefing NDJSON contract integration tests, and the hook-testing gap.

## What this guide does NOT cover

- The agent loop, tool dispatch, or Anthropic API integration — that's `study-agent-architecture` and `study-ai-engineering`.
- Bloomreach MCP OAuth, PKCE, or the encrypted-cookie auth store — that's `study-security` / `study-system-design`.
- Anomaly detection logic, EQL, or period-over-period math — that's the data layer, not the frontend.
