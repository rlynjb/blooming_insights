# Design refactor — remove the `'expired'` session-mode placeholder at the route layer

> Source: `.aipe/audits/design-2026-06-15.md` Lens 4 (layers — `'expired'` is a route-layer concept the route never inspects; the actual revoked-token recovery happens entirely on the CLIENT via `useReconnectPolicy`).
> Source: discovered while writing `test/api/_helpers.ts:365-375` — `makeMockSession('expired')` exists for symmetry but the routes never read a `revoked` flag, so the mode is dead at the layer where it's emitted.
> Cross-ref: `test/api/_helpers.ts:340-378` — the `'expired'` mode and its documented "this is a placeholder for future reconnect-policy hook tests" comment.
> Cross-ref: `test/api/agent.integration.test.ts:9-15` — reality-pinning note #3: *"The route never inspects a `revoked` flag on the session — `unauthed` and `expired` both surface as `conn.ok === false`."*

---

## What to refactor

The `'expired'` branch in `makeMockSession` at `test/api/_helpers.ts:365-376` is documented placeholder code:

```ts
if (mode === 'expired') {
  // Not exercised by the /api/briefing tests in Phase 2 — the briefing route's
  // catch only branches on `conn.ok`, it does not look for a `revoked` flag.
  // The reconnect-on-revoked path lives in the client-side `useReconnectPolicy`
  // hook (Phase 3 territory). Provided as a placeholder so the agent route
  // tests can use it without re-editing this file.
  return { ... };
}
```

It exists for symmetry — the `MockSessionMode` type is `'authed' | 'unauthed' | 'expired'`, and the helper returns a session descriptor for all three. But the routes don't read any concept of "expired" — they read `conn.ok` (from `lib/mcp/connect.ts`'s `connectMcp` return) and branch on it. `connectMcp` does not distinguish "never authed" from "authed but token revoked"; both come back as `{ ok: false, authUrl }`.

**That's the dead code.** Pick one of three resolutions (the executor decides which fits the team's preference; the audit's recommendation is option A):

**Option A (recommended) — remove the placeholder.** Drop `'expired'` from `MockSessionMode`, remove the branch in `makeMockSession`, replace the one use of `'expired'` at the call sites (today: just the test/_helpers comment references; the actual integration test files use `'unauthed'`). One-shot delete; reduces dead surface.

**Option B — surface the distinction at the connect layer.** Extend `connectMcp` to return `{ ok: false, authUrl, reason: 'never-authed' | 'token-revoked' }`. The routes branch on `reason` and emit different error events; the `useReconnectPolicy` hook (Hook C — see `design-frontend-extract-usereconnectpolicy.md`) keys on the error event's payload instead of regex-matching the message. This is **feature work, not refactor work** — exits this spec's scope.

**Option C — document the dead code in place.** Leave the helper alone, add a TODO at `connectMcp`'s caller sites explaining why `expired` isn't distinguishable today, and revisit in 6 months.

The audit's call is option A. Reasons in the Why section.

---

## Why

Three reasons, in order of leverage:

1. **The route layer is the wrong place for this distinction.** The revoked-token recovery is entirely client-side: the alpha Bloomreach server returns a generic 401 / "invalid_token" error message via the streaming NDJSON `error` event; the browser's `useReconnectPolicy` (currently inline in `app/page.tsx:381-416`; soon a hook) regex-matches that message and triggers the reset+reload cycle. **The server side never needs to know which kind of 401 it was**, because the recovery action — `POST /api/mcp/reset` followed by page reload — is the same regardless. Carrying an `'expired'` enum value at the test-helper layer pretends the routes differentiate something they don't.

2. **The dead code obscures the actual contract.** A reader of `test/api/_helpers.ts` sees three modes and might reasonably infer the routes handle three cases. They don't — they handle two (authed / not-authed), and the third is a placeholder. The 6-line documentation comment is a smell: when a piece of code needs a paragraph explaining "this exists for a future feature that doesn't exist yet," the code itself is debt. Either build the feature or drop the placeholder.

3. **The trigger for surfacing this finding was the integration-test scaffold itself.** Reality-pinning at `test/api/agent.integration.test.ts:9-15` already documents: *"The route never inspects a `revoked` flag on the session — `unauthed` and `expired` both surface as `conn.ok === false`."* That comment is the right framing — it just stops short of removing the placeholder. This stub closes the loop.

---

## Refactor type

**Remove Dead Parameter** (the closest composition match — `'expired'` is a code path with no caller that needs it) + **Inline Module** (a minor case: the branch is part of a discriminated-union helper; removing one variant collapses the union).

Not Move Function. Not Extract. Not a structural refactor — it's a dead-code prune at one layer of one test helper.

---

## Current structure

```
  test/api/_helpers.ts (the placeholder)
  ┌──────────────────────────────────────────────────────────┐
  │ export type MockSessionMode =                             │
  │   'authed' | 'unauthed' | 'expired';                      │
  │                                                           │
  │ export function makeMockSession(                          │
  │   mode: MockSessionMode                                   │
  │ ): MockSession {                                          │
  │   if (mode === 'authed') {                                │
  │     return { sessionId: 'test-session-001', authed: true};│
  │   }                                                       │
  │   if (mode === 'unauthed') { ... }                        │
  │   if (mode === 'expired') {                               │
  │     /* 6 lines of comment explaining why this isn't       │
  │        exercised + a return value that's nearly           │
  │        identical to 'unauthed' */                         │
  │     return {                                              │
  │       sessionId: 'test-session-expired-003',              │
  │       authed: false,                                      │
  │       authUrl: 'http://localhost:3000/api/mcp/start?...'  │
  │     };                                                    │
  │   }                                                       │
  │   throw new Error(...);                                   │
  │ }                                                         │
  └──────────────────────────────────────────────────────────┘

  Callers today:
    test/api/briefing.integration.test.ts  uses 'authed' + 'unauthed'
    test/api/agent.integration.test.ts     uses 'authed' + 'unauthed'
    grep -n "expired" test/api/             only comments reference it
```

The `'expired'` variant has no live caller. It's a future-feature placeholder.

---

## Target structure

```
  test/api/_helpers.ts (after option A)
  ┌──────────────────────────────────────────────────────────┐
  │ export type MockSessionMode = 'authed' | 'unauthed';      │
  │                                                           │
  │ export function makeMockSession(                          │
  │   mode: MockSessionMode                                   │
  │ ): MockSession {                                          │
  │   if (mode === 'authed') { ... }                          │
  │   if (mode === 'unauthed') {                              │
  │     /* the existing comment explaining the unauthed path  │
  │        gains ONE sentence:                                │
  │                                                           │
  │        Note: the routes do not distinguish never-authed   │
  │        from authed-but-revoked. Both surface as           │
  │        conn.ok === false. The revoked-token recovery      │
  │        is client-side (useReconnectPolicy in              │
  │        app/page.tsx; see design-frontend-extract-         │
  │        usereconnectpolicy.md). */                         │
  │     return { sessionId: 'test-session-unauthed-002',      │
  │              authed: false,                               │
  │              authUrl: '...' };                            │
  │   }                                                       │
  │   throw new Error(`makeMockSession: unknown mode '${mode}'`);│
  │ }                                                         │
  └──────────────────────────────────────────────────────────┘
```

Reality-pinning comment at `test/api/agent.integration.test.ts:9-15` simplifies — the bullet point about `'expired'` collapses (one fewer "watch out for this" item).

---

## Must not change

- **The route handlers in `app/api/briefing/route.ts` and `app/api/agent/route.ts` do not change.** This refactor is test-side only.
- **The `'authed'` and `'unauthed'` branches of `makeMockSession` behave identically.** Same return shapes, same sessionId strings, same authUrl strings.
- **All existing integration tests pass without modification.** They use `'authed'` and `'unauthed'` only; the `'expired'` removal doesn't affect them.
- **The 199+ unit tests pass without modification.**
- Do not touch `lib/mcp/session.ts`, `lib/mcp/connect.ts`, or any route handler. The "expired" concept never reached those files.
- Do not change the production behaviour of revoked-token handling. That recovery is client-side and lives in the `useReconnectPolicy` hook (this stub's sibling); it stays exactly as it is.

---

## Must not introduce

- No new dependencies.
- No new abstractions. Do not introduce a `SessionDescriptor` class or split `MockSession` into multiple subtypes — the union has two members and the helper is short.
- No additional refactors discovered along the way. If the executor notices that `test/api/_helpers.ts` is 427 LOC and could be split into per-concern files (Anthropic mock / MCP mock / session stub / NDJSON collector), that's a separate cleanup — not this one.
- No conversion to option B (the feature-work path). If you decide option B is the right call, file it as a feature spec under `app/api/auth/` or `lib/mcp/connect/` and CLOSE this refactor stub. Don't smuggle the feature in under a refactor.
- No new console warnings or TypeScript errors. `tsc --noEmit` should pass cleanly after the union member is removed.

---

## Done when

- `test/api/_helpers.ts:340` — `MockSessionMode` is `'authed' | 'unauthed'` (no `'expired'`).
- `test/api/_helpers.ts` — the `if (mode === 'expired') { ... }` branch is deleted along with its documentation comment.
- `test/api/agent.integration.test.ts:9-15` — reality-pinning note #3 simplifies (the `expired` clause drops, the `unauthed`-only line stays).
- `grep -nE "['\"]expired['\"]" test/api/` returns nothing.
- All existing Vitest tests pass: 214 + 1 skipped = 215 in `npm test`.
- `tsc --noEmit` passes (the union narrowing makes the helper's third `throw` reachable only on type-cast misuse, which is the right behaviour — a TypeScript user can't pass `'expired'` anymore).

---

## Note on the deeper question

The audit considered emitting a parallel spec for option B (the connect-layer distinction) and decided not to. The reasoning:

- The current shape works for production users (the regex-on-error-message path is tested by the smoke test and will be tested by the future `useReconnectPolicy` hook-level test once `design-frontend-extract-usereconnectpolicy.md` ships).
- Distinguishing "never authed" from "revoked" requires plumbing through `lib/mcp/auth.ts` and reading the underlying error from the Bloomreach OAuth response — which is a different shape than what `connectMcp` returns today.
- The benefit of distinguishing the two cases (better error messaging, different recovery actions) is real but small at this scale.

**If the team decides to do option B later, file it as a feature spec.** This refactor's deletion does not preclude that work — adding a third variant back is reversible. The audit's call is to remove the placeholder NOW because it's debt today, and add it back deliberately LATER if the team decides the distinction earns its keep.
