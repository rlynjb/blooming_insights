# overview — frontend engineering (blooming insights)

## Rendering mode, in one sentence

**Client-side single-page shell over the Next.js 16 App Router.** Every rendered surface is a `'use client'` component; nothing meaningful runs as an RSC. The App Router carries the routing and the API layer; the UI is a React 19 SPA that streams NDJSON off `/api/briefing` and `/api/agent`.

```
  Zoom out — where the UI sits in the system

  ┌─ Browser ───────────────────────────────────────────────┐
  │  React 19 client (all pages: 'use client')              │
  │   ├─ app/page.tsx                (the feed)             │
  │   ├─ app/investigate/[id]/       (diagnose)             │
  │   └─ app/investigate/[id]/       (recommend)            │
  │      /recommend/                                        │
  │                                                         │
  │  streams NDJSON via fetch() + ReadableStream reader     │
  │  state: useState + sessionStorage + localStorage        │
  └────────────────────────┬────────────────────────────────┘
                           │  HTTP (keep-alive)
  ┌─ Next.js API routes ───▼────────────────────────────────┐
  │  /api/briefing         monitoring agent, NDJSON out     │
  │  /api/agent            investigate + free-form Q&A      │
  │  /api/mcp/*            capture, reset, callback, call   │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Anthropic + Bloomreach MCP ───────────────────────────┐
  │  claude-sonnet-4-6 · loomi connect MCP over OAuth      │
  └────────────────────────────────────────────────────────┘
```

Not SSR, not SSG, not RSC. `app/page.tsx` opens `'use client';` on line 1. The `dark` class on `<html>` in `app/layout.tsx:22` is the only server-rendered thing on the page — everything under it hydrates and becomes client-side from `HomePage()` onward.

## State graph, in one diagram

```
  State ownership — where each piece lives

                      ┌───────────────────────────────────┐
                      │  demo snapshot (committed JSON)   │  ← server
                      │  lib/state/demo-*.json            │
                      └────────────────┬──────────────────┘
                                       │ replayed at /api/briefing?demo=cached
                                       ▼
  ┌─ localStorage ──────────┐   ┌─ useState (page.tsx) ─────────────┐
  │  bi:mode                │──►│  mode | ready | activeQuery       │
  │  (demo / live-*)        │   └─────────────────┬─────────────────┘
  └─────────────────────────┘                     │
                                                  │ triggers
                                                  ▼
                                     ┌─ useBriefingStream ────────────┐
                                     │  status · insights · workspace │
                                     │  coverage · traceItems · error │
                                     │  stepStatus · queryCount       │
                                     │  demoSuffix                    │
                                     └─────────────────┬──────────────┘
                                                       │ on each insight
                                                       ▼
                                     ┌─ sessionStorage ───────────────┐
                                     │  bi:insight:<id> (each)        │
                                     │  bi:inv:<step>:<id> (result)   │
                                     │  bi:diag:<id>     (handoff)    │
                                     │  bi:reconnecting  (one-shot)   │
                                     └─────────────────┬──────────────┘
                                                       │ read by
                                                       ▼
                                     ┌─ useInvestigation (step page) ─┐
                                     │  items · diagnosis             │
                                     │  recommendations · complete    │
                                     │  error                         │
                                     └────────────────────────────────┘
```

**No global store.** No Redux, no Zustand, no Context Provider tree. Each hook owns its slice; the browser's `sessionStorage` is the cross-page carrier (feed stashes each insight so the investigation page can send it to `/api/agent` — Vercel serverless can't rely on in-memory server state because the feed and the investigation may hit different instances, `useBriefingStream.ts:53-60`).

`bi:mode` in `localStorage` is the one persistent UI setting (demo / live-bloomreach / live-synthetic). `useBriefingStream` re-runs when it changes. Legacy values (`live`, `live-sql`) migrate to `live-bloomreach` on read at `app/page.tsx:75-77`.

## The three load-bearing frontend patterns

Ranked by user-visible consequence. Strip any of these and you lose a specific capability the pitch depends on.

### 1. NDJSON stream reader hook — the entire "shows its work" pitch

File: `lib/streaming/ndjson.ts:1-64` (the 64-line kernel), consumed by four surfaces:

- `lib/hooks/useBriefingStream.ts:288` — the feed
- `lib/hooks/useInvestigation.ts:194` — step 2 & 3
- `components/chat/StreamingResponse.tsx:108` — free-form Q&A
- `lib/hooks/useDemoCapture.ts:84` — dev-only capture

Strip it and the app becomes a request/response spinner. The agent's reasoning trace, tool calls, and coverage tiles all arrive as separate NDJSON events; the UI paints each as it arrives. That's the product.

→ **See `01-ndjson-stream-reader-hook.md`**.

### 2. Progressive skeleton with stepper — perceived-instant while the agent runs

Four tiers of feedback, all wired to the same NDJSON event stream:

- `components/shared/Skeleton.tsx` — coarse rectangles for card placeholders
- `components/shared/ProcessStepper.tsx` — the three-stage pipeline (monitoring → diagnosing → recommending), each with `pending | active | complete | error` states
- `components/feed/CoverageGrid.tsx` — 10 anomaly-category tiles that fill in as each `coverage_item` event lands
- `components/shared/StatusLog.tsx` (wrapping `ReasoningTrace.tsx`) — the sticky sidebar streaming agent thoughts + tool calls

Strip the stepper alone and the user has no idea which phase is running. Strip the coverage grid and the "clear · limited · anomaly" completeness signal collapses to "here are some cards." The composition is the load-bearing piece — not any one tier.

→ **See `02-progressive-skeleton-with-stepper.md`**.

### 3. Auto-reconnect on revoked token — the live path only survives because of this

`lib/hooks/useReconnectPolicy.ts` (123 LOC): the alpha Bloomreach MCP server revokes OAuth tokens after minutes. A wire-format `switch` deep in `useBriefingStream.ts` sees an `invalid_token` error, hands it to the policy, which fires `POST /api/mcp/reset` and reloads with a `sessionStorage` one-shot guard so it can't loop.

This one hasn't earned its own pattern file — it's a policy composed onto the briefing stream, not a distinct architectural shape. It shows up in the audit under state-architecture and network semantics. If it grows to include exponential backoff, retry budgets, or per-route customization, it earns a file. Right now it's honest to say `readNdjson` + progressive-composition are the two patterns worth walking, and everything else is application logic layered on them.

## The one gap the audit surfaces first

The reasoning trace has no `aria-live` region. The entire "shows its work" pitch — the streaming agent output on the feed and both investigate pages — is invisible to a screen reader. The UI updates; the assistive-tech user hears nothing. The fix is small (add `role="log"` + `aria-live="polite"` to the `StatusLog` header wrapper), the impact is large. **See `audit.md` → `frontend-red-flags-audit`.**
