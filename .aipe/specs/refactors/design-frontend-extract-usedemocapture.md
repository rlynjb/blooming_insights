# Frontend refactor — extract `useDemoCapture(insights, workspace, traceItems)`

> Source: `.aipe/audits/design-2026-06-15.md` Lens 2 finding 2.1 (shallow module, eight concerns at one altitude) + Lens 5 (dev-only orchestration tangled with production state at the page layer).
> Cross-ref: `.aipe/audits/design-2026-06-14.md` Lens 2.1 (documented-without-stub; both preconditions now satisfied).
> Cross-ref: `.aipe/audit-refactor-page-decomposition/00-overview.md` (Hook D in the 5-seam sequence; the dev-only one).
> Cross-ref: `.aipe/audit-refactor-page-decomposition/02-structural.md` (the chapter notes the underlying primitive may belong in `lib/dev/capture.ts` — see "Future work" below).
> Verification harness: `test/api/agent.integration.test.ts` (9 tests pin `/api/agent`'s NDJSON event contract that `runInvestigation` consumes) + `test/api/briefing.integration.test.ts` (the snapshot the capture writes is what the demo branch reads back).

---

## What to refactor

The dev-only single-click demo-snapshot capture flow inside `app/page.tsx` — three functions and one piece of UI state that together orchestrate "capture the live briefing → run each investigation → bundle the result." Today it lives mid-component:

- `app/page.tsx:113-117` — the `capturing` state slot: `useState<{ active: boolean; msg: string }>({ active: false, msg: '' })`.
- `app/page.tsx:157-165` — `postCapture()`: POSTs the current `insights, workspace, traceItems` to `/api/mcp/capture-demo`, reads the response body defensively.
- `app/page.tsx:170-188` — `runInvestigation(insight)`: fetches `/api/agent?insightId=...&insight=...`, drains the NDJSON stream via `readNdjson`, resolves on `done` or `error`.
- `app/page.tsx:190-240` — `captureAll()`: the orchestration — POST capture → iterate insights, running each through `runInvestigation` → re-POST capture to bundle → window.alert the result. Includes the in-loop bailout when `AUTH_RE` matches (`:192`, `:213-216`).
- `app/page.tsx:668-695` — the dev-only `<button>` that fires `captureAll()`. Gated on `process.env.NODE_ENV !== 'production' && !isDemo && status === 'loaded'`.

Lift the three functions plus the state into `lib/hooks/useDemoCapture.ts` as a custom hook that takes `(insights, workspace, traceItems)` and returns:

```ts
{
  capturing: { active: boolean; msg: string };
  captureAll: () => Promise<void>;
}
```

The page reads `capturing` for the button's `disabled` + label, and binds `onClick={captureAll}`. The page is no longer the home of the orchestration; it just renders the button.

This is **Hook D** in the page-decomposition notebook's 5-seam sequence. Mid-sized (~80 LOC absorbed), dev-only (won't affect production users), and the ONLY one of the three deferred hooks whose verification harness has direct route-side coverage from PR #4: `test/api/agent.integration.test.ts` exercises the exact `/api/agent?insightId=...` flow `runInvestigation` consumes.

---

## Why

Three reasons, in order of leverage:

1. **The eight-concerns-at-one-altitude problem includes dev-only orchestration.** Look at `app/page.tsx:96` — `export default function HomePage()`. Inside that one function: feed status, briefing fetch, mode persistence, reconnect policy, demo capture, query box, the JSX itself. The dev-only concern is the most-clearly-out-of-place: every production user reads through 84 LOC of capture orchestration code that is dead at runtime in their browser (the dev button is gated, but the function definitions and the `capturing` state slot are evaluated on every render in every environment). Moving it to a hook means production users still pay the import cost (small) but the page's apparent surface area drops by 84 LOC. The depth ratio (functionality ÷ interface size) for the page improves.

2. **The orchestration has TWO live failure modes that the inline structure hides.** First, the AUTH_RE bailout at `:213-216` is duplicate policy with Hook C's territory — same regex, different site (this is named in Hook C's spec; this hook's lift swaps the literal regex for `policy.isAuthError(r.error)` once Hook C lands, OR if Hook C hasn't landed yet, leaves the literal in place and Hook C cleans it up in its pass). Second, the sequential MCP loop at `:206-218` is a 1-req/s spend pattern that touches the same rate-limit budget the briefing already used; if the briefing exhausted the budget, the loop will fail mid-iteration with rate-limit errors. The hook's encapsulation is what makes both failure modes easier to reason about: the orchestration is named, the contract is its return type, and the next person to read it sees ONE function (`captureAll`) instead of three (`postCapture` + `runInvestigation` + `captureAll`) tangled with page state.

3. **`/api/agent` integration tests landed in PR #4 — they're the verification harness for `runInvestigation`.** `test/api/agent.integration.test.ts:127-166` (Test 1) exercises the diagnose step happy path; `:173-204` (Test 2) exercises the recommend step; `:301-327` (Test 5) exercises the FALLBACK diagnosis path. The `runInvestigation` function inside this hook drains the NDJSON stream from the same `/api/agent` endpoint these tests pin. Behaviour preservation in this refactor is verifiable: if `/api/agent`'s NDJSON event shape doesn't change, `runInvestigation` doesn't change. The route tests are the upstream contract test.

---

## Refactor type

**Extract Reusable Logic** (Custom Hook) — same primitive as Hooks B and C.

Composes with **Move Function** at three sub-sites: `postCapture`, `runInvestigation`, and `captureAll` all migrate from page-level closures to hook-internal closures. They keep their signatures (`postCapture` returns `{ ok, body }`; `runInvestigation` returns `{ ok, error? }`; `captureAll` returns `Promise<void>`).

Not Split Container/Presentation (the page already renders the button; the hook owns the data + the action; the split is already there structurally). Not State Machine (the `capturing` field is a small product of `active: boolean` + `msg: string`; not worth a state-machine type at this size). Not Strategy (no interchangeable algorithms).

---

## Framework context

Next.js 16 App Router, React 19. The hook is dev-only by USAGE — the page gates the button on `process.env.NODE_ENV !== 'production'`. The hook itself can run anywhere; it's the CALLER that's gated. **Do not gate the hook itself** — that would couple `lib/hooks/` to environment, which is wrong layering. The hook is a normal React hook; the page decides whether to call its return value's `captureAll` based on env.

If the executor wants belt-and-suspenders, optionally short-circuit `captureAll()` to a no-op alert in production via an env check INSIDE `captureAll` — but this is gold-plating. The audit's call: gate at the call site (the button), per the existing pattern.

`runInvestigation` calls `readNdjson` from `lib/streaming/ndjson` directly. That's fine — it's the same primitive `useInvestigation.ts` uses; the hook owns its NDJSON consumption. Do not introduce an abstraction over `readNdjson` for this one site.

`window.alert(...)` calls survive the move — same UX (a dev-only modal that summarizes the result). Same `try/catch` boundary around `captureAll`'s top-level body. Same `try { ... } finally { setCapturing({ active: false, msg: '' }); }` pattern.

---

## Current structure

```
  app/page.tsx (the three functions + the state + the button)
  ┌──────────────────────────────────────────────────────────┐
  │ HomePage() {                                              │
  │   const [insights, ...] = useState ...                    │
  │   const [workspace, ...] = useState ...                   │
  │   const [traceItems, ...] = useState ...                  │
  │                                                           │
  │ :113-117                                                  │
  │   const [capturing, setCapturing] = useState<{            │
  │     active: boolean; msg: string;                         │
  │   }>({ active: false, msg: '' });                         │
  │                                                           │
  │ :157-165                                                  │
  │   async function postCapture(): Promise<{ ok; body }> {   │
  │     const res = await fetch('/api/mcp/capture-demo', {    │
  │       method: 'POST',                                     │
  │       headers: { 'content-type': 'application/json' },    │
  │       body: JSON.stringify({                              │
  │         insights, workspace, trace: traceItems            │
  │       }),                                                 │
  │     });                                                   │
  │     const body = await res.json().catch(() => ({}));      │
  │     return { ok: res.ok, body };                          │
  │   }                                                       │
  │                                                           │
  │ :170-188                                                  │
  │   async function runInvestigation(insight): Promise<...> {│
  │     const url = '/api/agent?insightId=' + ...             │
  │              + '&insight=' + ...;                         │
  │     const res = await fetch(url);                         │
  │     if (!res.ok || !res.body) { ... handle JSON err ... } │
  │     let result = { ok: false,                             │
  │                    error: 'stream ended without done' };  │
  │     await readNdjson<{ type?; message? }>(res.body, (e)=> │
  │       if (e.type === 'done') result = { ok: true };       │
  │       else if (e.type === 'error') result = {             │
  │         ok: false, error: String(e.message ?? 'error')    │
  │       };                                                  │
  │     );                                                    │
  │     return result;                                        │
  │   }                                                       │
  │                                                           │
  │ :190-240                                                  │
  │   async function captureAll() {                           │
  │     if (capturing.active) return;                         │
  │     const AUTH_RE =                                       │
  │       /invalid_token|unauthor|forbidden|401|              │
  │        session expired|reconnect/i;                       │
  │     try {                                                 │
  │       setCapturing({ active: true,                        │
  │         msg: 'capturing the briefing…' });                │
  │       const first = await postCapture();                  │
  │       if (!first.ok) { alert(...); return; }              │
  │       let stoppedFor = '';                                │
  │       for (let n = 0; n < insights.length; n++) {         │
  │         const ins = insights[n];                          │
  │         setCapturing({ active: true,                      │
  │           msg: `investigating ${n+1}/${total}…` });       │
  │         const r = await runInvestigation(ins);            │
  │         if (!r.ok && r.error && AUTH_RE.test(r.error)) {  │
  │           stoppedFor = r.error;                           │
  │           break;                                          │
  │         }                                                 │
  │       }                                                   │
  │       setCapturing({ active: true,                        │
  │         msg: 'bundling investigations…' });               │
  │       const final = await postCapture();                  │
  │       const b = final.body;                               │
  │       const lines = [ ...summary lines... ];              │
  │       window.alert(lines.join('\n'));                     │
  │     } catch (e) {                                         │
  │       window.alert(`capture failed: ${String(e)}`);       │
  │     } finally {                                           │
  │       setCapturing({ active: false, msg: '' });           │
  │     }                                                     │
  │   }                                                       │
  │                                                           │
  │ :668-695                                                  │
  │   {process.env.NODE_ENV !== 'production' &&               │
  │    !isDemo && status === 'loaded' && (                    │
  │     <button onClick={captureAll}                          │
  │             disabled={capturing.active}>                  │
  │       {capturing.active ? `⏳ ${capturing.msg}` :         │
  │         'ⓘ dev · capture this as the demo snapshot'}     │
  │     </button>                                             │
  │   )}                                                      │
  │ }                                                         │
  └──────────────────────────────────────────────────────────┘
```

84 LOC of orchestration + 5 LOC of state declaration + 28 LOC of button JSX. The orchestration is dev-only by usage but takes up surface area in the page's mental model regardless of environment.

---

## Target structure

```
  lib/hooks/useDemoCapture.ts (NEW, ~110 LOC)
  ┌──────────────────────────────────────────────────────────┐
  │ import { useCallback, useState } from 'react';            │
  │ import { readNdjson } from '@/lib/streaming/ndjson';      │
  │ import type { Insight } from '@/lib/mcp/types';           │
  │ import type { TraceItem } from '...ReasoningTrace';       │
  │                                                           │
  │ /** Dev-only single-click demo-snapshot capture.          │
  │  *  Three phases:                                         │
  │  *    1. POST current briefing to /api/mcp/capture-demo  │
  │  *    2. Run each insight's investigation to /api/agent   │
  │  *       (sequential — MCP is ~1 req/s; cached ones fast) │
  │  *    3. Re-POST to bundle the now-cached investigations  │
  │  *  Verification harness:                                 │
  │  *    test/api/agent.integration.test.ts (the /api/agent  │
  │  *    NDJSON event contract runInvestigation drains).     │
  │  *    test/api/briefing.integration.test.ts (the snapshot │
  │  *    written here is replayed by the demo=cached path). │
  │  */                                                       │
  │                                                           │
  │ const AUTH_ERROR_RE = /.../;  // OR import from           │
  │                               // useReconnectPolicy once   │
  │                               // Hook C lands              │
  │                                                           │
  │ interface CaptureBody {                                   │
  │   ok: boolean;                                            │
  │   body: Record<string, unknown>;                          │
  │ }                                                         │
  │                                                           │
  │ interface InvestigationResult {                           │
  │   ok: boolean;                                            │
  │   error?: string;                                         │
  │ }                                                         │
  │                                                           │
  │ export interface UseDemoCaptureResult {                   │
  │   capturing: { active: boolean; msg: string };            │
  │   captureAll: () => Promise<void>;                        │
  │ }                                                         │
  │                                                           │
  │ export function useDemoCapture(                           │
  │   insights: Insight[],                                    │
  │   workspace: BriefingResponse['workspace'] | undefined,   │
  │   traceItems: TraceItem[],                                │
  │ ): UseDemoCaptureResult {                                 │
  │   const [capturing, setCapturing] = useState<{            │
  │     active: boolean; msg: string;                         │
  │   }>({ active: false, msg: '' });                         │
  │                                                           │
  │   /* postCapture, runInvestigation, captureAll all        │
  │     defined as inner closures or top-level helpers — your │
  │     call. The hook's RETURN is just { capturing, capture- │
  │     All }. */                                             │
  │                                                           │
  │   return { capturing, captureAll };                       │
  │ }                                                         │
  └──────────────────────────────────────────────────────────┘
                              │  consumed by:
                              ▼
  app/page.tsx (~84 LOC removed)
  ┌──────────────────────────────────────────────────────────┐
  │ const { capturing, captureAll } = useDemoCapture(         │
  │   insights, workspace, traceItems,                        │
  │ );                                                        │
  │                                                           │
  │ // The button JSX at :668-695 stays unchanged in shape;   │
  │ // only the bindings switch.                              │
  │ {process.env.NODE_ENV !== 'production' &&                 │
  │  !isDemo && status === 'loaded' && (                      │
  │   <button onClick={captureAll}                            │
  │           disabled={capturing.active}>                    │
  │     {capturing.active ? `⏳ ${capturing.msg}` :           │
  │       'ⓘ dev · capture this as the demo snapshot'}       │
  │   </button>                                               │
  │ )}                                                        │
  └──────────────────────────────────────────────────────────┘
```

End state: the page renders the dev button; the hook owns the orchestration; the route tests (PR #4) pin the upstream NDJSON contract; production users see no change.

---

## Must not change

- **Visible UI behaviour.** The dev button appears under the same conditions, shows the same label/spinner, fires `captureAll` on click, alerts the same multi-line summary on completion or failure. The disabled-while-capturing state matches today's behaviour.
- **Event semantics.** The `captureAll` flow runs the same three phases in the same order: (1) initial `POST /api/mcp/capture-demo`, (2) sequential `GET /api/agent?insightId=X` per insight (with NDJSON drain on each), (3) final `POST /api/mcp/capture-demo` to bundle. The mid-loop auth-error bailout still fires when `AUTH_RE.test(r.error)` is true. The `setCapturing` message updates fire at the same five sub-phases (capturing the briefing, investigating N/M, bundling, then back to idle).
- **Network behaviour.** Same two `POST /api/mcp/capture-demo` requests (one before the loop, one after). Same N `GET /api/agent?insightId=...&insight=...` requests, one per insight, sequential — NOT parallel. Same NDJSON consumption via `readNdjson` of each `/api/agent` response. Same JSON body shape on each `POST /api/mcp/capture-demo`: `{ insights, workspace, trace: traceItems }`.
- **Storage behaviour.** None — the hook owns no storage. (The snapshot it produces is written by the SERVER to `lib/state/demo-insights.json` + `lib/state/demo-investigations.json`; that's owned by `/api/mcp/capture-demo` and is out of scope.)
- **Window mutations.** `window.alert(...)` fires the same three places: capture-failed, top-level catch, final-bundle summary. Same content per branch.
- **Accessibility.** No DOM access; the button's a11y is owned by the JSX in `app/page.tsx`.
- **The 9 integration tests at `test/api/agent.integration.test.ts` MUST stay green without modification** — they pin the `/api/agent` NDJSON contract that `runInvestigation` consumes. If your refactor changes the route's emission, the route's tests catch it. The hook's CONSUMPTION of those events is what's moving.
- Do not touch `app/api/mcp/capture-demo/route.ts`, `app/api/agent/route.ts`, `lib/streaming/ndjson.ts`, `lib/state/insights.ts`.
- Do not change the snapshot file format on the server. The hook is a producer of the API call; the server owns the persisted shape.

---

## Must not introduce

- No new dependencies.
- No new abstractions beyond the hook and its return type. Do NOT introduce a generic `useOrchestration` hook, a `Pipeline` class, or a "step recorder" abstraction. The orchestration is one function (`captureAll`) with three phases; it does not need a framework.
- No additional refactors discovered along the way. If the executor notices that `runInvestigation` looks similar to `useInvestigation` — they are NOT the same thing (this one is for capture; that one is for the investigate page's display). Do not unify them. If the executor notices that `lib/dev/capture.ts` would be a better home than `lib/hooks/useDemoCapture.ts`, see "Future work" below — that's a sibling refactor, not this one.
- No promotion to a non-dev feature. The button stays gated on `NODE_ENV !== 'production' && !isDemo`. The hook itself is environment-agnostic but the call site is gated.
- No parallelism in the investigation loop. The current loop is SEQUENTIAL because MCP's rate limit is ~1 req/s and parallelism would exhaust it faster. Preserve the sequential `for` loop.
- No retry logic on the inner `runInvestigation` failures (non-auth). Today the loop skips and continues; preserve that.
- No new console warnings or errors during the smoke test.

---

## Done when

- `lib/hooks/useDemoCapture.ts` exists and exports `useDemoCapture(insights, workspace, traceItems)` returning the 2-field shape `{ capturing, captureAll }`.
- `app/page.tsx` no longer contains the `postCapture`, `runInvestigation`, or `captureAll` function declarations. `grep -nE "function (postCapture|runInvestigation|captureAll)" app/page.tsx` returns nothing.
- `app/page.tsx` no longer contains the `capturing` state slot. `grep -n "setCapturing\|capturing.active\|capturing.msg" app/page.tsx` returns ONLY the references inside the button's JSX (which now read from the destructured hook return).
- The dev button JSX at `app/page.tsx:668-695` stays intact in shape; only the bindings switch from local closures to the hook's return values.
- All existing Vitest tests pass: 214 + 1 skipped = 215 in `npm test`.
- **The 9 tests in `test/api/agent.integration.test.ts` MUST stay green without modification** — they're the route contract `runInvestigation` consumes.
- `npm run dev` smoke test:
  1. Load `/` in dev mode, switch to live, wait for the briefing to finish (`status === 'loaded'`).
  2. Click "ⓘ dev · capture this as the demo snapshot." Observe: button label changes to "⏳ capturing the briefing…", then through each "investigating N/M · ${metric}…" phase, then "bundling investigations…", then the result alert shows up with insight count + investigation count.
  3. Confirm: `lib/state/demo-insights.json` and `lib/state/demo-investigations.json` are updated on disk (same as before the refactor).
  4. Switch to demo mode and reload `/`. Observe: the demo replay paints the captured snapshot — proving the snapshot the hook just wrote is consumable by `app/api/briefing/route.ts`'s demo branch (which is itself covered by Test 2 in `briefing.integration.test.ts:144-167`).
- No console warnings, no double-fetch, no leftover "active: true" state after completion.

---

## Future work (out of scope for this stub)

The page-decomposition notebook's Chapter 02 makes a sharper structural argument: the orchestration primitive — "walk a list of items, run an agent step per item, post the trace" — belongs in `lib/dev/capture.ts` as a plain async function, not in a React hook. The hook (in that framing) is a thin React wrapper around the lib function: it owns the `capturing` state and surfaces the lib's progress callbacks.

**That's a future refactor, not this one.** The audit's call: this stub does the React-side lift (state out of the page, function bodies into the hook). A second stub, if and when it's warranted, splits the hook into "lib orchestration function" + "thin React state wrapper." Reasons to NOT do it in one pass: (a) the hook-only lift is verifiable against the existing route tests; the lib-extraction lift adds a new module boundary that needs its own test; (b) the dev-only orchestration is touched rarely — the cost of leaving it in a hook is low; (c) one refactor per session is the discipline. If the executor disagrees, do the hook lift first and the lib lift in a follow-up session.
