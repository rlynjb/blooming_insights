# Frontend refactor — extract `useReconnectPolicy()`

> Source: `.aipe/audits/design-2026-06-15.md` Lens 2 finding 2.1 (shallow module) + Lens 5 (Separation of Concerns straining inside the NDJSON error case).
> Cross-ref: `.aipe/audits/design-2026-06-14.md` Lens 2.1 (documented-without-stub; both preconditions now satisfied).
> Cross-ref: `.aipe/audit-refactor-page-decomposition/00-overview.md` (Hook C in the 5-seam sequence; the principal-of-least-surprise hot spot).
> Cross-ref: `.aipe/audit-refactor-page-decomposition/05-principles.md` (the reconnect arm is the Separation-of-Concerns finding's anchor).
> Verification harness: `test/api/briefing.integration.test.ts` (reconnect-on-revoked-token NOT covered directly today — see "Verification gap" below) + the route-side gap follow-up `design-honor-abortsignal-in-briefing-route.md` (sibling stub).

---

## What to refactor

The reconnect-on-revoked-token branch buried inside the NDJSON `error` event handler at `app/page.tsx:381-416` — ~36 LOC of session-state machinery wedged inside a wire-format parser. Plus the duplicate inline error handler at `app/page.tsx:606-645` (the explicit "reconnect" button in the error UI). Same policy, two sites; the alpha Bloomreach server revokes tokens after a few minutes and the page handles it in two distinct places that have to stay aligned.

Lift the policy into `lib/hooks/useReconnectPolicy.ts` as a custom hook that owns:

1. The "have we already tried to reconnect this session" flag, today read from `sessionStorage.getItem('bi:reconnecting') === '1'` at `app/page.tsx:389-395`.
2. The "set the flag, hit `/api/mcp/reset`, reload" action, today inlined at `:396-405`.
3. The pattern-match for auth-shaped errors: `/invalid_token|unauthor|forbidden|401|session expired|reconnect/i` (currently duplicated at `:388` AND `:606`).

The hook returns a small shape — likely two fields:

```ts
{
  reconnecting: boolean;
  handle: (errorMessage: string) => boolean;  // returns true if it took over the error
}
```

The page's briefing effect (or, after Hook B lands, `useBriefingStream`'s `onAuthError` callback) calls `handle(msg)` from the NDJSON `case 'error':` arm. The explicit reconnect button in the error UI calls into the same hook's exposed action. The duplicate regex collapses to one source.

This is **Hook C** in the page-decomposition notebook's 5-seam sequence. The smallest of the three deferred hooks (~36 LOC absorbed, plus the explicit-button site cross-link); the most surgically focused (one decision, one action). Per the notebook (`05-principles.md`), it's the **Separation of Concerns finding's anchor** — a wire-format `switch` should not be mutating session storage and reloading the window. Lifting the policy is what restores the separation.

---

## Why

Three reasons, in order of leverage:

1. **The reconnect branch is the worst Principle-of-Least-Surprise violation in the file.** A reader scanning the NDJSON event handler at `app/page.tsx:306-419` sees nine `case` arms that look like data dispatch: `case 'workspace': setWorkspace(evt.workspace)`. Then `case 'error'` opens at `:381` and a parser arm calls `sessionStorage.setItem`, fires a `fetch('/api/mcp/reset', { method: 'POST' })`, and reloads the window. That's not data dispatch; that's a control-flow side-effect cascade triggered by a string match on the error message. The page-decomposition notebook names this as **the principle violation most likely to bite the next maintainer**. The hook moves the policy out of the parser and into a named unit whose name says what it does.

2. **The regex is duplicated and divergence-prone.** `app/page.tsx:192` defines `AUTH_RE` for the capture flow (Hook D's territory). `app/page.tsx:388` inlines an equivalent literal `/invalid_token|unauthor|forbidden|401|session expired|reconnect/i` inside the NDJSON error case. `app/page.tsx:606` inlines a SHORTER variant `/unauthor|forbidden|401|session expired/i` for the error UI's "reconnect" button. **Three regexes, three slightly-different shapes, one policy.** A real auth error matching the long variant at `:388` but missing the short variant at `:606` would auto-reconnect once, fail, then show the long error with no reconnect button. That's a latent bug today; the hook consolidates the policy and forces one match function.

3. **The path is the load-bearing surface from precondition B's perspective.** The integration test scaffold landed in PR #4 covers the route side of `/api/briefing` and `/api/agent` — but the reconnect path lives on the **client** side. The page-decomposition notebook's `00-overview.md` calls this out explicitly: *"the integration test that proves it survives doesn't exist yet."* This refactor is the move that prepares for that test (a hook-level test against `useReconnectPolicy` is much cheaper than a full page-render test). See "Verification gap" below for the honest call on what test infrastructure ships with this refactor vs gets deferred.

---

## Refactor type

**Extract Reusable Logic** (Custom Hook) — the React idiom for "this state + this effectful action + this predicate is one unit."

Also touches **DRY (with care)** — the three regex sites today are duplicated. The hook's `handle(msg)` exposes the canonical match function so all three sites consume one source.

Not Strategy (the policy is one path with one decision, not interchangeable algorithms). Not State Machine (the state is boolean, the transition is one-way "tried-yet → tried"). Not Move Effect to Event Handler (the effect IS in an event handler today; the move is laterally to a named hook).

---

## Framework context

Next.js 16 App Router, React 19. The hook reads from `sessionStorage` (browser-only) and mutates `window.location.href`. Both are SSR-unsafe; guard with `typeof window !== 'undefined'` checks, matching the existing pattern at `app/page.tsx:72` (`stashInsights`).

The page is `'use client'` so the hook runs only in the browser at runtime — but the SSR guard is still good hygiene and matches the codebase's existing convention. `fetch('/api/mcp/reset', { method: 'POST' })` works in the browser; no Next-specific server-action plumbing needed.

`useInvestigation.ts` is the sibling pattern (216 LOC, identical-style custom hook with `startedRef` latch + small return shape). Match its file-header comment style: name what the hook owns, name what it doesn't, name what fires it.

---

## Current structure

```
  app/page.tsx (the policy in three places)
  ┌──────────────────────────────────────────────────────────┐
  │ // SITE 1: captureAll() — Hook D's regex                  │
  │ :192      const AUTH_RE =                                 │
  │             /invalid_token|unauthor|forbidden|401|       │
  │              session expired|reconnect/i;                 │
  │ :213      if (!r.ok && r.error && AUTH_RE.test(r.error)){│
  │             stoppedFor = r.error;                         │
  │             break;                                        │
  │           }                                               │
  │                                                           │
  │ // SITE 2: the NDJSON error case — THE BIG ONE            │
  │ :381      case 'error': {                                 │
  │ :382        const msg = evt.message ?? '...';             │
  │ :388        if (/invalid_token|unauthor|forbidden|401|   │
  │                   session expired|reconnect/i.test(msg)){ │
  │ :389-394      let alreadyTried = false;                   │
  │               try {                                       │
  │                 alreadyTried =                            │
  │                   sessionStorage.getItem(                 │
  │                     'bi:reconnecting') === '1';           │
  │               } catch { /* ignore */ }                    │
  │ :395-405      if (!alreadyTried) {                        │
  │                 try { sessionStorage.setItem(             │
  │                   'bi:reconnecting', '1'); }              │
  │                 catch { /* ignore */ }                    │
  │                 setReconnecting(true);                    │
  │                 fetch('/api/mcp/reset',                   │
  │                   { method: 'POST' })                     │
  │                   .finally(() => {                        │
  │                     window.location.href = '/';           │
  │                   });                                     │
  │                 return;                                   │
  │               }                                           │
  │ :407-411     try { sessionStorage.removeItem(             │
  │                'bi:reconnecting'); }                      │
  │              catch { /* ignore */ }                       │
  │            }                                              │
  │ :413-414   setErrorMessage(msg);                          │
  │            setStatus('error');                            │
  │ :415      }                                               │
  │                                                           │
  │ // SITE 3: the explicit "reconnect" button (error UI)     │
  │ :606      {/unauthor|forbidden|401|                       │
  │             session expired/i.test(errorMessage) && (    │
  │             <>                                            │
  │ :619-642     <button onClick={async () => {              │
  │                try { await fetch('/api/mcp/reset',        │
  │                  { method: 'POST' }); }                   │
  │                catch { /* ignore */ }                     │
  │                window.location.href = '/';                │
  │              }}>reconnect</button>                        │
  │             </>                                           │
  │           )}                                              │
  └──────────────────────────────────────────────────────────┘
```

Three regex literals, two slightly-different shapes (the SHORT one at `:606` is missing `invalid_token` and `reconnect`). Three calls to `fetch('/api/mcp/reset', { method: 'POST' })` followed by `window.location.href`. Two reads of `sessionStorage.getItem('bi:reconnecting')`. One state slot `reconnecting` lives on the page.

---

## Target structure

```
  lib/hooks/useReconnectPolicy.ts (NEW, ~70 LOC)
  ┌──────────────────────────────────────────────────────────┐
  │ import { useCallback, useState } from 'react';            │
  │                                                           │
  │ /** The alpha Bloomreach server revokes its OAuth token   │
  │  *  after a few minutes; its error messages match this    │
  │  *  pattern. Single source — used by both the NDJSON       │
  │  *  error handler and the manual reconnect button. */     │
  │ const AUTH_ERROR_RE =                                     │
  │   /invalid_token|unauthor|forbidden|401|                  │
  │    session expired|reconnect/i;                           │
  │                                                           │
  │ const FLAG_KEY = 'bi:reconnecting';                       │
  │                                                           │
  │ export interface UseReconnectPolicyResult {               │
  │   reconnecting: boolean;                                  │
  │                                                           │
  │   /** Inspect an error message. If it's auth-shaped AND   │
  │    *  we haven't already tried this session, fire the     │
  │    *  reset+reload and return true (caller should bail).  │
  │    *  Otherwise return false — caller handles the error   │
  │    *  the normal way. */                                  │
  │   handle: (errorMessage: string) => boolean;              │
  │                                                           │
  │   /** Fire the reset+reload unconditionally — used by the │
  │    *  manual reconnect button in the error UI. */         │
  │   reconnect: () => void;                                  │
  │                                                           │
  │   /** Predicate exposed for the UI to decide whether to   │
  │    *  show the explicit reconnect button. */              │
  │   isAuthError: (msg: string) => boolean;                  │
  │                                                           │
  │   /** Caller flushes the flag on the success path (e.g.   │
  │    *  the NDJSON `case 'done'` arm) so the next session-  │
  │    *  expiry can fire a fresh auto-reconnect. */          │
  │   clearFlag: () => void;                                  │
  │ }                                                         │
  │                                                           │
  │ export function useReconnectPolicy(): UseReconnectPolicyResult {│
  │   const [reconnecting, setReconnecting] = useState(false);│
  │                                                           │
  │   const isAuthError = useCallback(                        │
  │     (msg: string) => AUTH_ERROR_RE.test(msg), []);        │
  │                                                           │
  │   const fireReset = useCallback(() => {                   │
  │     setReconnecting(true);                                │
  │     fetch('/api/mcp/reset', { method: 'POST' })           │
  │       .finally(() => {                                    │
  │         if (typeof window !== 'undefined')                │
  │           window.location.href = '/';                     │
  │       });                                                 │
  │   }, []);                                                 │
  │                                                           │
  │   const handle = useCallback((msg: string): boolean => {  │
  │     if (!isAuthError(msg)) return false;                  │
  │     if (typeof window === 'undefined') return false;      │
  │     let alreadyTried = false;                             │
  │     try { alreadyTried =                                  │
  │       sessionStorage.getItem(FLAG_KEY) === '1'; }         │
  │     catch { /* ignore */ }                                │
  │     if (alreadyTried) {                                   │
  │       try { sessionStorage.removeItem(FLAG_KEY); }        │
  │       catch { /* ignore */ }                              │
  │       return false;                                       │
  │     }                                                     │
  │     try { sessionStorage.setItem(FLAG_KEY, '1'); }        │
  │     catch { /* ignore */ }                                │
  │     fireReset();                                          │
  │     return true;                                          │
  │   }, [isAuthError, fireReset]);                           │
  │                                                           │
  │   const clearFlag = useCallback(() => {                   │
  │     if (typeof window === 'undefined') return;            │
  │     try { sessionStorage.removeItem(FLAG_KEY); }          │
  │     catch { /* ignore */ }                                │
  │   }, []);                                                 │
  │                                                           │
  │   return { reconnecting, handle, reconnect: fireReset,    │
  │            isAuthError, clearFlag };                      │
  │ }                                                         │
  └──────────────────────────────────────────────────────────┘
                              │  consumed by:
                              ▼
  app/page.tsx (~36 LOC removed, plus the regex dedup)
  ┌──────────────────────────────────────────────────────────┐
  │ const policy = useReconnectPolicy();                      │
  │                                                           │
  │ // NDJSON error case — was :381-416, now:                 │
  │ case 'error': {                                           │
  │   const msg = evt.message ?? 'something went wrong';      │
  │   if (policy.handle(msg)) return;                         │
  │   setErrorMessage(msg);                                   │
  │   setStatus('error');                                     │
  │   break;                                                  │
  │ }                                                         │
  │                                                           │
  │ // NDJSON done case (just the flag clear, was inline):    │
  │ case 'done': policy.clearFlag(); ...                       │
  │                                                           │
  │ // captureAll's AUTH_RE — uses policy.isAuthError:        │
  │ if (!r.ok && r.error && policy.isAuthError(r.error)) {... │
  │                                                           │
  │ // explicit reconnect button:                             │
  │ {policy.isAuthError(errorMessage) && (                    │
  │   <button onClick={policy.reconnect}>reconnect</button>   │
  │ )}                                                        │
  │                                                           │
  │ // reconnecting banner — read from policy:                │
  │ {policy.reconnecting && <p>session expired...</p>}        │
  └──────────────────────────────────────────────────────────┘
```

End state: one regex literal in the codebase (in `useReconnectPolicy.ts`); one `fetch('/api/mcp/reset', ...) + reload` block; one `sessionStorage` flag manager. The page reads from the policy; the briefing hook (Hook B) optionally takes the policy's `handle` as its `onAuthError` callback when the two are composed.

---

## Must not change

- **Visible UI behaviour.** The "session expired — reconnecting to bloomreach…" banner still appears for the same window of time during the reconnect flow. The explicit reconnect button still appears under the same conditions (when `isAuthError(errorMessage)` is true). Status transitions (`'error'` rendering, loading skeletons under `reconnecting`, etc.) all fire the same way.
- **Event semantics.** The NDJSON `case 'error':` arm STILL returns early when the reconnect fires, preventing the error message from being displayed. The `case 'done':` arm still clears the flag. The capture flow's break-on-auth-error STILL bails the loop with `stoppedFor = r.error`.
- **Network behaviour.** Same single `POST /api/mcp/reset` per reconnect. Same `window.location.href = '/'` after the reset. Same one-shot guard: after one auto-reconnect attempt per session, the next auth error falls through to the error UI instead of looping.
- **Storage behaviour.** Same `sessionStorage` key (`'bi:reconnecting'`), same value (`'1'`), same set-on-attempt, same remove-on-success-or-second-failure semantics. Three `try/catch` blocks around `sessionStorage` calls (browsers can block it) all survive.
- **Regex match shape.** The CURRENT NDJSON error case matches on the LONG regex (`/invalid_token|unauthor|forbidden|401|session expired|reconnect/i`). The CURRENT explicit-button site matches on the SHORT regex (`/unauthor|forbidden|401|session expired/i`). **In the target structure, both call into `isAuthError(msg)` which uses the LONG pattern.** This is technically a small behaviour expansion at the explicit-button site (the button will now show for `invalid_token` and `reconnect` error messages where it previously didn't). **This is the one ride-along expansion this refactor accepts** — it's the bug the page-decomposition notebook flagged ("a real auth error matching the long variant at :388 but missing the short variant at :606 would auto-reconnect once, fail, then show the long error with no reconnect button"). If the executor wants strict behaviour preservation, they must instead expose two predicates (`isAuthErrorAuto` vs `isAuthErrorButton`) and route each site to the right one. **The audit's call: accept the expansion at the button site as a deliberate alignment**; document it in the hook's header comment. If your reviewer disagrees, split into two predicates — that's also fine.
- **Accessibility.** No DOM access changes; the reconnect button stays a `<button>` with the same text and styling.
- Do not touch `app/api/mcp/reset/route.ts`, `lib/streaming/ndjson.ts`, `lib/hooks/useInvestigation.ts`, `lib/mcp/session.ts`.
- Do not change the storage key string `'bi:reconnecting'`. Anything keyed on that string in deployed user sessions stays compatible.

---

## Must not introduce

- No new dependencies.
- No new abstractions beyond the hook and its return type. Do not introduce a `ReconnectPolicy` class, a `RetryStrategy` interface, an exponential-backoff schedule, or a "policy registry." This is one decision (auth-shaped error → reset + reload), one flag, one regex.
- No additional refactors. If the executor notices that `app/api/mcp/reset/route.ts` could be improved, or that the alpha-server-revokes-tokens behaviour itself should be moved server-side, those are separate specs (or feature work, depending on shape).
- No new state machine. The `reconnecting` field is a single boolean, just like today. Do not generalize to "states: idle / detecting / resetting / reloaded."
- No automatic retry beyond the existing one-shot guard. Today the page tries reconnect exactly once per session; this stays.
- No new console warnings or errors during the smoke test.

---

## Done when

- `lib/hooks/useReconnectPolicy.ts` exists and exports `useReconnectPolicy()` returning the 5-field shape (or 2-field if you collapse the convenience predicates — `handle` and `reconnect` are the only load-bearing exports; the others are read-only views over the same policy).
- `app/page.tsx` no longer contains a literal `/invalid_token|unauthor|forbidden|401|session expired|reconnect/i` or the shorter `/unauthor|forbidden|401|session expired/i` regex. `grep -nE "invalid_token|session expired" app/page.tsx` returns nothing.
- `app/page.tsx` no longer contains the inline `sessionStorage.getItem('bi:reconnecting')` / `setItem('bi:reconnecting', '1')` / `removeItem('bi:reconnecting')` reads/writes. `grep -n "bi:reconnecting" app/page.tsx` returns nothing.
- `app/page.tsx` no longer contains the inline `fetch('/api/mcp/reset', { method: 'POST' }).finally(...)` block at `:402-405` or the equivalent at `:622-627`. `grep -n "/api/mcp/reset" app/page.tsx` returns nothing.
- The page imports the hook and calls into `policy.handle(msg)` / `policy.reconnect()` / `policy.isAuthError(msg)` / `policy.clearFlag()` at the four old sites.
- All existing Vitest tests pass: 214 + 1 skipped = 215 in `npm test`.
- **The 7 tests in `test/api/briefing.integration.test.ts` and the 9 tests in `test/api/agent.integration.test.ts` MUST stay green without modification.** They are the route-side contract; this hook is a client-side consumer, so they're not the direct verification harness — but if either route's NDJSON error event shape changes, this refactor caught it. (The reconnect-on-revoked path itself is not covered by these route tests today; see "Verification gap" below.)
- `npm run dev` smoke test:
  1. Load `/?` in live mode. Wait for the alpha server to revoke (or force it via dev). Observe: status changes to error → "session expired — reconnecting to bloomreach…" banner appears → page reloads → fresh briefing fires.
  2. Force a second revocation in the same session. Observe: no auto-reconnect this time; error UI shows the explicit reconnect button; clicking it triggers the same reset+reload.
  3. From the captureAll() dev button (live mode, `NODE_ENV !== 'production'`), induce an auth error mid-loop. Observe: the loop bails with the same `stoppedFor` alert text.
- No console warnings, no double-reload, no stale `bi:reconnecting=1` flag (the success path's `policy.clearFlag()` runs on `case 'done'`).

---

## Verification gap (honest)

The 7+9 integration tests landed in PR #4 pin the ROUTE-SIDE contract. They do NOT cover the client-side reconnect flow. Specifically:

- `test/api/briefing.integration.test.ts:202-237` — verifies the route emits an `error` event when listTools throws. It does NOT verify the page reacts by reconnecting; that's a frontend behaviour not exercised by route tests.
- `test/api/agent.integration.test.ts:336-358` — verifies the route returns 401 with `authUrl` when `connectMcp` reports unauthed. Same gap: route side.

**The right test for THIS hook is a hook-level test at `test/hooks/useReconnectPolicy.test.tsx`** using `@testing-library/react` + a `sessionStorage` mock + a `fetch` spy + a `window.location.href` setter spy. Cases:
1. `handle('invalid_token')` returns true, calls `/api/mcp/reset`, mutates `location.href`.
2. `handle('something normal')` returns false, does NOT call fetch.
3. Second `handle` in the same session (when the flag is already set) returns false, removes the flag, does NOT call fetch.
4. `clearFlag()` after a successful `done` removes the flag so the next `handle` call can fire again.
5. `isAuthError` matches the documented patterns and rejects unrelated strings.

**Whether this hook-level test ships WITH the refactor or as a follow-up is the executor's call.** The audit's recommendation: write it WITH the refactor (it's ~50 LOC, mostly setup), because without it the reconnect path has no direct coverage and "behaviour-preserving" is asserted against a smoke test only. Either way, name the gap in the spec's verification section and don't claim integration coverage you don't have.
