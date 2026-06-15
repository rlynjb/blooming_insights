# Frontend refactor — extract `useBriefingStream(mode)`

> Source: `.aipe/audits/design-2026-06-15.md` Lens 2 finding 2.1 (shallow module, red-flag #1 — the headline finding of this audit).
> Cross-ref: `.aipe/audits/design-2026-06-14.md` Lens 2.1 (documented-without-stub; both preconditions now satisfied).
> Cross-ref: `.aipe/audit-refactor-page-decomposition/00-overview.md` (the 5-seam reframing; this is Hook B in the sequence).
> Cross-ref: `.aipe/study-software-design/02-shallow-module-page-component.md` (12-day comprehension walk).
> Cross-ref: `.aipe/audits/cleanup-2026-06-14T19-50-14.md` fix-later #4.
> Verification harness: `test/api/briefing.integration.test.ts` (7 tests, the contract this hook can't break).

---

## What to refactor

The main briefing effect inside `app/page.tsx` — ~218 LOC of fetch + parse + dispatch buried in a single `useEffect` that owns eight independent concerns:

- `app/page.tsx:242-432` — the whole second `useEffect`. Specifically:
  - `:242-256` — feed-reset block (clears 7 state slots when `mode` flips)
  - `:258-260` — URL composition (demo vs live) + `demoSuffix` write
  - `:261-289` — fetch + auth-401 redirect + non-OK JSON error path
  - `:290-304` — content-type sniff + snapshot/plain-JSON fallback (`readBody`)
  - `:306-419` — the live NDJSON `switch(evt.type)` over 9 event variants (`workspace`, `coverage_item`, `coverage`, `tool_call_start`, `reasoning_step`, `tool_call_end`, `insight`, `done`, `error`)
  - `:420` — the actual `readNdjson` call wiring `cancelled` as the cancel poll
  - `:421-431` — top-level catch + cleanup return

Lift this whole block into `lib/hooks/useBriefingStream.ts` as a custom hook that takes `(mode: 'demo' | 'live', ready: boolean)` and returns a stable shape of nine fields the page reads:

```ts
{
  status: FeedStatus;
  insights: Insight[];
  workspace: BriefingResponse['workspace'];
  coverage: CoverageReport;
  traceItems: TraceItem[];
  errorMessage: string;
  stepStatus: string;
  queryCount: number;
  demoSuffix: string;
}
```

The page collapses from 773 LOC to ~560 LOC. Nine `useState` slots move into the hook (status, insights, workspace, errorMessage, stepStatus, queryCount, traceItems, coverage, demoSuffix). The page keeps state that doesn't belong to the briefing stream (activeQuery, reconnecting, capturing, mode, ready) — those are owned by other concerns (Hook C, Hook D, the mode toggle).

This is **Hook B** in the page-decomposition notebook's 5-seam sequence. Precondition A (NDJSON kernel extraction) shipped as commit `0f06eff` — the hook composes the already-tested `readNdjson<E>` kernel rather than re-implementing the loop. Precondition B (route-level integration tests for `/api/briefing`) shipped as commit `276c5bd` — 7 tests pin the route's NDJSON event contract, which is the surface this hook can't change.

---

## Why

Three reasons, in order of leverage:

1. **AOSD red flag #1 (shallow module) fires here at the worst severity in the codebase.** `app/page.tsx` runs eight independent concerns at one altitude (mode persistence, briefing stream, reconnect-on-revoked, demo capture, query box, status stepper, error surfacing, the JSX itself). The 12-day study named this; the morning cleanup audit named it; the 2026-06-14 design audit named it but deferred the stub because precondition B (integration tests) didn't exist. **Precondition B shipped in PR #4.** The deferral reason is retired; the stub emits. Lifting the briefing stream is the single largest depth gain — ~150 LOC of mechanism (fetch + parse + 9-case dispatcher) absorbs behind a 9-field interface. Functionality ÷ interface size moves the right direction.

2. **The integration test seam now exists — refactoring without it would have been a flying-blind move.** Look at `test/api/briefing.integration.test.ts:88-131` (happy path, asserts NDJSON event types end-to-end), `:144-167` (demo replay bypasses MCP), `:202-237` (error event when listTools throws — partial flush case), `:247-272` (Anthropic SDK throws mid-scan), `:300-353` (phase-timing log). These 7 tests pin the NDJSON event contract the hook consumes. Any extraction that breaks them is broken; any extraction that keeps them green is behaviour-preserving by definition. The hook is the consumer of the contract these tests assert.

3. **The existing `useInvestigation` is the exemplar.** `lib/hooks/useInvestigation.ts` is 216 LOC of identical shape (fetch + NDJSON loop + 9-case event handler + cleanup), shipped, tested, exposed via a small return shape. The page-decomposition notebook (`00-overview.md`) names it as the proof-of-concept: "the exact shape every extracted hook should aim for — small return shape, fat hidden body." This refactor is the sibling extraction. The pattern is mechanical at this point; the only delta is the event variants (`useInvestigation` handles 5; this hook handles 9).

---

## Refactor type

**Extract Reusable Logic** (the React-specific name: Custom Hook). The stateful + effectful body of the briefing stream becomes its own hook.

Not Lift State (the state isn't moving up — it's the same place in the tree). Not Lower State (not moving down either). Not Split Container/Presentation (the page has no rendering concern that this hook owns; it owns DATA + EFFECTS, and the page reads them as props). This is the React idiom for "this useEffect plus its useState slots IS a unit." Same primitive as `useInvestigation`.

---

## Framework context

Next.js 16 (App Router, `'use client'`), React 19, vitest 4 for tests. Component is a Server Component shell that flips to client at the page level (`app/page.tsx:1` — `'use client'`). The hook lives at `lib/hooks/useBriefingStream.ts` next to `useInvestigation.ts`, imports `readNdjson` from `lib/streaming/ndjson`, and depends on the shared types in `lib/mcp/types.ts` and the local `BriefingResponse` + `BriefingEvent` types that currently live inline at `app/page.tsx:17-39`. Move those types into the hook file or into a small `lib/streaming/briefing-events.ts` — both work; pick the one that keeps the hook file readable as a single unit.

`useInvestigation` uses a `startedRef` latch to guard against StrictMode double-mount; replicate that pattern here. The current `app/page.tsx:259` uses a `let cancelled = false` closure variable instead — works the same way at runtime but `useRef` is the idiomatic Hooks form and matches the sibling hook.

---

## Current structure

```
  app/page.tsx (773 LOC)
  ┌──────────────────────────────────────────────────────────┐
  │ HomePage()                                                │
  │   useState × 15  ← 9 of these belong to the briefing      │
  │   useEffect × 2                                           │
  │                                                           │
  │   useEffect(#1, :130-140)  ← mode persistence (Hook A)    │
  │                                                           │
  │   postCapture() :157-165   ← capture flow (Hook D)        │
  │   runInvestigation() :170-188                             │
  │   captureAll() :190-240                                   │
  │                                                           │
  │   useEffect(#2, :242-432)  ← THE briefing effect ★★★      │
  │     :242-256   feed-reset block                           │
  │     :258-260   URL + demoSuffix                           │
  │     :261-289   fetch + 401 + error JSON                   │
  │     :290-304   demo/plain-JSON fallback                   │
  │     :306-419   9-case event dispatcher                    │
  │                  case 'workspace' :311-313                │
  │                  case 'coverage_item' :314-319            │
  │                  case 'coverage' :320-322                 │
  │                  case 'tool_call_start' :323-329          │
  │                  case 'reasoning_step' :330-348           │
  │                  case 'tool_call_end' :349-367            │
  │                  case 'insight' :368-370                  │
  │                  case 'done' :371-380                     │
  │                  case 'error' :381-416  ← Hook C lives    │
  │                                            inside here    │
  │     :420       readNdjson(...) call                       │
  │     :421-431   top-level catch + cleanup                  │
  │                                                           │
  │   return <main>...</main>                                 │
  └──────────────────────────────────────────────────────────┘
```

The `case 'error'` arm at `:381-416` contains the reconnect-on-revoked-token branch — that's Hook C (`useReconnectPolicy`). This hook (Hook B) extracts FIRST and the error case calls into the policy; Hook C lifts the policy out of the error case in a second pass. See `design-frontend-extract-usereconnectpolicy.md` for the sibling spec.

The capture flow at `:157-240` (Hook D) is independent — `postCapture` + `runInvestigation` + `captureAll`. It reads `insights, workspace, traceItems` from the briefing state — that read becomes "consume the hook's return value" once this hook lands. See `design-frontend-extract-usedemocapture.md` for the sibling spec.

---

## Target structure

```
  lib/hooks/useBriefingStream.ts (NEW, ~260 LOC)
  ┌──────────────────────────────────────────────────────────┐
  │ import { useEffect, useRef, useState } from 'react';      │
  │ import { readNdjson } from '@/lib/streaming/ndjson';      │
  │ import type { Insight, CoverageReport, CoverageItem }     │
  │   from '@/lib/mcp/types';                                 │
  │ import type { TraceItem } from '...ReasoningTrace';       │
  │                                                           │
  │ type FeedStatus = 'loading'|'error'|'empty'|'loaded';     │
  │ interface BriefingResponse { ... }  ← moved from page     │
  │ type BriefingEvent = ...            ← moved from page     │
  │                                                           │
  │ export interface UseBriefingStreamResult {                │
  │   status: FeedStatus;                                     │
  │   insights: Insight[];                                    │
  │   workspace: BriefingResponse['workspace'];               │
  │   coverage: CoverageReport;                               │
  │   traceItems: TraceItem[];                                │
  │   errorMessage: string;                                   │
  │   stepStatus: string;                                     │
  │   queryCount: number;                                     │
  │   demoSuffix: string;                                     │
  │ }                                                         │
  │                                                           │
  │ export function useBriefingStream(                        │
  │   mode: 'demo' | 'live',                                  │
  │   ready: boolean,                                         │
  │   onAuthError?: (message: string) => boolean,             │
  │ ): UseBriefingStreamResult {                              │
  │   const [status, setStatus] = useState<FeedStatus>('...');│
  │   ... 8 more useState slots ...                           │
  │                                                           │
  │   useEffect(() => {                                       │
  │     if (!ready) return;                                   │
  │     /* fetch + parse + dispatch + cleanup */              │
  │   }, [mode, ready]);                                      │
  │                                                           │
  │   return { status, insights, workspace, ... };            │
  │ }                                                         │
  └──────────────────────────────────────────────────────────┘
                              │  consumed by:
                              ▼
  app/page.tsx (~560 LOC)
  ┌──────────────────────────────────────────────────────────┐
  │ const {                                                   │
  │   status, insights, workspace, coverage, traceItems,      │
  │   errorMessage, stepStatus, queryCount, demoSuffix,       │
  │ } = useBriefingStream(mode, ready);                       │
  │                                                           │
  │ // remaining useState: activeQuery, reconnecting,         │
  │ // capturing, mode, ready                                 │
  │                                                           │
  │ // remaining useEffect: #1 (mode persistence)             │
  │ // (capture flow + reconnect policy land in later passes) │
  │                                                           │
  │ return <main>... uses the destructured values ...</main>  │
  └──────────────────────────────────────────────────────────┘
```

The `onAuthError` callback is optional and is the seam for Hook C (`useReconnectPolicy`). When the error case at `app/page.tsx:381-416` runs the reconnect branch, today it mutates `sessionStorage` + calls `/api/mcp/reset` + reloads. After Hook C lands, that responsibility migrates out. For this stub, keep the branch inline in the hook (it moves with the effect) — Hook C's spec walks the lift. If your executor wants to land both hooks in the same session, they can compose by passing `onAuthError={useReconnectPolicy().handle}` — but per the "one technique per spec" discipline, do them as separate sessions.

End state: the briefing stream is one hook with one purpose. The page reads its return value. Behaviour preserved.

---

## Must not change

- **Visible UI behaviour.** Status transitions (loading → loaded / empty / error) fire in the same order. Insight cards render in the same sequence. The coverage grid fills in the same per-category cadence. The status panel's `traceItems` stream in with the same shape (tool entries on `tool_call_start`, status updates on `tool_call_end`, step entries on `reasoning_step`). The error message displays the same text.
- **Event semantics.** The 9 NDJSON event variants are handled in the same way. `case 'workspace'` sets workspace. `case 'coverage_item'` dedups on category and appends. `case 'tool_call_start'` increments `queryCount` and appends a `tool` trace item. `case 'reasoning_step'` updates `stepStatus` and appends a `step` trace item. `case 'tool_call_end'` mutates the running tool entry in-place via reverse-linear-search. `case 'insight'` appends to `collected`. `case 'done'` calls `setInsights(collected)` and `stashInsights(collected)` and clears `bi:reconnecting`. `case 'error'` does the reconnect-or-display dance. Order and side-effect set unchanged.
- **Network behaviour.** Same single `GET /api/briefing` per (mode, ready) change. Same `?demo=cached` query string when `mode === 'demo'`. Same 401 → redirect to `body.authUrl`. Same non-OK → error message readout via `readBody`. Same content-type sniff for the demo/plain-JSON fallback.
- **Storage behaviour.** `stashInsights` still writes to `sessionStorage` on `case 'done'` and on the plain-JSON fallback path. `sessionStorage.removeItem('bi:reconnecting')` still fires on `case 'done'`. `localStorage` reads/writes for `bi:mode` are NOT part of this hook (those stay in Hook A / the page).
- **Accessibility.** The hook has no DOM access; a11y is owned by the JSX in `app/page.tsx`. Confirm via the same `npm run dev` smoke test that the loading skeletons, error region, and coverage grid render identically.
- **Cancellation behaviour.** The cleanup return still cancels the in-flight stream when `mode` flips or the component unmounts. Today this is `let cancelled = false; ... cancelOn: () => cancelled; ... return () => { cancelled = true; }`. Translate to `const cancelledRef = useRef(false); ... cancelOn: () => cancelledRef.current; ... cleanup: () => { cancelledRef.current = true; }` — same wire semantics, idiomatic ref form.
- **The 7 integration tests at `test/api/briefing.integration.test.ts` must stay green without modification.** This is the contract test. If the hook breaks the route's event-emission shape, the tests fail; if the tests stay green, the route's emission is unchanged. The hook's CONSUMPTION of those events is what's moving. The integration tests verify the PRODUCER side; this refactor moves the CONSUMER side; the two are decoupled by the NDJSON event variants which neither side may change in this refactor.
- Do not touch `app/api/briefing/route.ts`, `lib/streaming/ndjson.ts`, `lib/state/insights.ts`, `lib/hooks/useInvestigation.ts`, `lib/mcp/types.ts`.
- Do not touch the `BriefingEvent` type definitions — moving them between files is fine; changing fields is not.

---

## Must not introduce

- No new dependencies.
- No new abstractions beyond the hook and its return type. Do not introduce a `BriefingStreamReducer`, a `BriefingEventHandler` interface, or a generalized `useNdjsonStream<E>` hook. The two existing NDJSON consumers (`useInvestigation` and this hook) are not similar enough to share an abstraction — they handle different event variants and own different state shapes. Generalization is a separate spec at best, more likely a YAGNI.
- No additional refactors discovered along the way. If the executor notices that `stashInsights`, `readBody`, or `formatCustomerCount` (`app/page.tsx:71-94`) belong in `lib/`, that's a separate spec (the page-decomposition notebook Chapter 01 names them). Do not fold them in. If the executor notices that `monitoringState` / `monitoringSub` (`app/page.tsx:45-65`) belong next to `ProcessStepper`, same answer — separate spec. The discipline is one technique per session.
- No state-management library (Zustand, Jotai, Redux). The page's state is already in `useState`; moving it into a hook keeps it in `useState`. Anything else is feature work.
- No new console warnings or errors during the smoke test. StrictMode double-mount must still produce the same behaviour as it does today (one network request, not two — guarded by the `cancelled` / `cancelledRef` latch).

---

## Done when

- `lib/hooks/useBriefingStream.ts` exists and exports `useBriefingStream(mode, ready, onAuthError?)` returning the 9-field shape.
- `app/page.tsx` is reduced by ~210 LOC (one `useEffect` block + 9 `useState` lines + the inline `BriefingResponse`/`BriefingEvent` types). The remaining useState count drops from 15 to 6 (activeQuery, reconnecting, capturing, mode, ready, demoSuffix only if it stays for the QueryBox suffix — confirm during execution).
- `app/page.tsx` imports the hook and destructures its return value.
- All existing Vitest tests pass: 214 + 1 skipped = 215 in `npm test`. **The 7 tests in `test/api/briefing.integration.test.ts` MUST stay green without modification** — they pin the contract this refactor consumes.
- `npm run dev` smoke test: load `/`, watch the demo replay paint the coverage grid + insight cards + the reasoning trace panel; toggle to `live` and watch the live stream paint the same way. Then back to demo. No console warnings, no double-fetch, no hung loading state.
- The reconnect branch at the old `app/page.tsx:381-416` (now inside the hook) still triggers on a revoked-token error event: `sessionStorage.setItem('bi:reconnecting', '1')`, `fetch('/api/mcp/reset', { method: 'POST' })`, `window.location.href = '/'`. This is the unchanged-for-now branch; Hook C lifts it out next.
- `grep -n "readNdjson<BriefingEvent>" app/page.tsx` returns nothing (the call moved into the hook). The page still imports `readNdjson` ONLY if `runInvestigation` (Hook D's territory) still lives in it; once Hook D ships the page imports nothing from `lib/streaming/`.
- A note added to the hook file's header comment: "Verification harness: `test/api/briefing.integration.test.ts` (7 tests pin the NDJSON event contract this hook consumes)."
