# Auth-secret flake postmortem

**Industry name(s):** environment-coupling bug / config-drift incident; the fix is the *catch-setup-and-surface-the-real-message* pattern (sometimes called *fail loudly, not silently*). **Type:** Project-specific incident, industry-standard fix pattern.

## Zoom out — where this concept lives

A real production-only incident. The dev environment worked fine; production returned 500 with no body. Root cause: a missing env var (`AUTH_SECRET`) tripped a throw inside the cookie-encryption codepath *before* the route could send a JSON response. The fix is the smallest possible try/catch at the setup boundary — surface the real message instead of letting it bubble into Vercel's bare 500 handler.

```
  Zoom out — the fix lives at the request-entry of the service layer

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  feed sees 500 with no body → "something went wrong"        │
  │  (no diagnosis, no reconnect, no recovery)                  │
  └────────────────────▲────────────────────────────────────────┘
                       │ HTTP 500 (Vercel default error page)
  ┌─ Service layer ────┼─────────────────────────────────────────┐
  │  GET /api/briefing                                            │
  │  ┌──────────────── BEFORE FIX ────────────────────────┐       │
  │  │  await getOrCreateSessionId()    ──► reads cookies │       │
  │  │  await makeDataSource(mode, sid) ──► aesKey() throws│ ←── BARE 500
  │  │                                       (no try/catch) │      │
  │  └─────────────────────────────────────────────────────┘       │
  │                                                                │
  │  ┌──────────────── AFTER FIX (briefing/route.ts:170-179) ──┐  │
  │  │  try {                                                   │  │
  │  │    sid = await getOrCreateSessionId();                  │  │
  │  │    dsResult = await makeDataSource(mode, sid);          │  │
  │  │  } catch (e) {                                          │  │
  │  │    console.error('[briefing] setup error:',             │  │
  │  │       redactSecrets(formatError(e)));                   │  │
  │  │    return NextResponse.json(                            │  │
  │  │       { error: `/api/briefing setup · ${e.message}` },  │  │
  │  │       { status: 500 });                                 │  │
  │  │  }                                                      │  │
  │  └─────────────────────────────────────────────────────────┘  │
  │                                                                │
  └────────────────────┬───────────────────────────────────────────┘
                       │
  ┌─ Storage layer ────▼───────────────────────────────────────────┐
  │  lib/mcp/auth.ts:51-60                                          │
  │  aesKey() — throws when AUTH_SECRET is unset                    │
  │                                                                 │
  │  this throw is the *real* failure source; the route's catch     │
  │  surfaces it instead of letting it become a bare 500            │
  └─────────────────────────────────────────────────────────────────┘
```

**Zoom in.** The bug was an env-coupling — code that *only* runs in production (the cookie-encryption path at `lib/mcp/auth.ts:62-104`) depended on an env var that wasn't set. The dev environment used the file-cache path that doesn't need `AUTH_SECRET`, so tests passed. The fix is structural: every route's setup phase is now wrapped in try/catch that returns the real message as JSON, so future env-shaped failures degrade with a readable error.

The question this postmortem answers: *"how do we make the next env-coupling bug visible in 30 seconds instead of an hour?"*

## Structure pass

**Layers.** Three: the env (where `AUTH_SECRET` lives or doesn't); the auth-store layer (where the throw originates); the route layer (where the throw should be caught and surfaced).

**Axis: failure containment.** Hold *"who handles a setup error?"* constant.

```
  Trace "who handles a setup throw?" across before/after

  layer                  before fix                      after fix
  ─────                  ──────────                      ─────────
  env (process.env)      missing AUTH_SECRET             missing AUTH_SECRET
  auth-store (aesKey)    throws unguarded                throws unguarded
                                                          ── (unchanged; throw is correct)
  setup (sid + dataSrc)  throws propagate up             throws propagate up
                                                          ── (unchanged; let it throw)
  route entry            ╳ throw escapes the route ╳     ✓ try/catch returns JSON
                         → Vercel's default 500           → 500 with { error: real msg }
  client (feed)          opaque "something went wrong"   readable message in error panel
```

The failure-containment axis flips at one seam — the route entry. Before the fix, the route had no boundary; the throw walked past it into Vercel's default handler. After the fix, the boundary is explicit: "anything that throws in setup gets caught and surfaced as JSON with `status: 500`."

**Seams.**

1. **env ↔ aesKey.** Contract: `AUTH_SECRET` is non-empty. Broken in prod. The throw at `lib/mcp/auth.ts:53-58` is the *right* behavior — fail closed when crypto can't run. Don't fix it here.
2. **aesKey ↔ withAuthCookies.** The cookie codepath calls aesKey synchronously inside the ALS scope; the throw propagates through the await boundary cleanly.
3. **withAuthCookies ↔ route entry.** This is where the fix lives. The throw arrives at the route's `await makeDataSource(mode, sid)` line, and BEFORE the fix there was no catch. AFTER the fix, the catch surfaces the real message.

The seam that needed hardening was the *route entry*, not the auth layer or the env layer. Identifying the right seam to harden is most of incident response.

Skeleton mapped.

## How it works

### Move 1 — the mental model

You've shipped code where a missing env var crashed the deploy with a stack trace that didn't say which env var. The fix is always the same shape: detect the missing config *at the failing site* and throw a message that names the var. This is that, plus a route-level wrapper that turns the throw into a JSON response instead of a bare 500.

The deeper pattern: **a throw that escapes a request boundary becomes a 500.** It doesn't matter how clean the throw message is — if it escapes the route, the user gets the platform's default error page (Vercel's case: blank with status 500). The throw has to be *contained inside* the request boundary to land as a useful response.

```
  The pattern — catch setup throws, surface the real message

  BEFORE:                            AFTER:

  GET /api/route                     GET /api/route
    │                                  │
    setup()    ── throws ──┐           try { setup() }
    │                       │          catch (e) {
    │                       │            console.error(redact(format(e)));
    │                       ▼            return NextResponse.json(
    handler()             escape           { error: `route setup · ${e.message}` },
                                            { status: 500 }
                                          );
                          ▼              }
                       Vercel
                       bare 500          handler() runs only if setup succeeded
                       no body
                                          response is JSON with the real message,
                                          client sees it in the error panel
```

### Move 2.1 — the auth throw (the originating site)

The throw lives in `aesKey()` at **`lib/mcp/auth.ts:51-60`**:

```typescript
function aesKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is required in production to encrypt the auth cookie. ' +
        'Set it in your Vercel project environment variables.',
    );                                                              // ← message tells you the var name AND where to set it
  }
  return createHash('sha256').update(secret).digest();              // ← 32 bytes → AES-256
}
```

**This is the right place for the throw.** Fail closed when crypto can't run — encrypting a cookie with a zero key is worse than refusing. The message names the var AND tells the operator where to set it. This part of the system is doing its job.

**Why it only fires in production.** `withAuthCookies` at `lib/mcp/auth.ts:86-104` is gated by `process.env.NODE_ENV === 'production'`:

```typescript
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();          // ← dev/test: skip cookie codepath entirely
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };  // ← decryptStore calls aesKey()
  // ...
}
```

In dev/test, `withAuthCookies` is a pass-through — `aesKey` is never called, so the throw never fires. The dev environment is *systematically incapable of reproducing* this bug. Local tests, dev server, every Vitest run — all fine. The bug appeared the moment the code hit Vercel prod, and only then.

### Move 2.2 — the fix (the catch at the route entry)

The fix at **`app/api/briefing/route.ts:168-179`**:

```typescript
// Construct the DataSource via the factory BEFORE committing to a stream so
// a Bloomreach auth-gate can return 401 JSON the feed redirects on. Wrapped
// so a setup throw (e.g. missing AUTH_SECRET breaking cookie encryption in
// production) returns the real message instead of a bare 500.
let sid: string;
let dsResult: Awaited<ReturnType<typeof makeDataSource>>;
try {
  sid = await getOrCreateSessionId();
  dsResult = await makeDataSource(mode, sid);
} catch (e) {
  console.error('[briefing] setup error:', redactSecrets(formatError(e)));
  return NextResponse.json(
    { error: `/api/briefing setup · ${e instanceof Error ? e.message : String(e)}` },
    { status: 500 },
  );
}
```

**Line-by-line read.**

- The try block contains ONLY the setup phase — session ID creation and data-source construction. Both of these are pre-stream (the route hasn't committed to a `ReadableStream` yet), so returning a JSON 500 here is still safe.
- `console.error('[briefing] setup error:', …)` — the route name is the prefix so a Vercel log filter can grep `[briefing] setup error` and see exactly these incidents.
- `redactSecrets(formatError(e))` — `formatError` walks the cause chain up to 5 levels (`lib/mcp/transport.ts:82-97`), `redactSecrets` scrubs any bearer/access_token shapes (`lib/mcp/transport.ts:55-76`). Comment at `formatError` line 79-81: "we assemble the chain ourselves before redacting, otherwise a token nested inside `e.cause.cause` would survive the redaction."
- `return NextResponse.json({ error: … }, { status: 500 })` — JSON body with the real message. The client's `readBody` helper at `lib/hooks/useBriefingStream.ts:63-72` will parse this and display it in the error panel.
- The route-name prefix in the error message (`/api/briefing setup · …`) tells the operator which route failed — important when both briefing and agent routes can hit the same setup throw.

**Identical pattern at `app/api/agent/route.ts:165-174`** for the agent route. Two routes, one fix shape, deliberate sibling.

### Move 2.3 — the comment is the postmortem

The comment at `briefing/route.ts:167-168` (and the matching `agent/route.ts:162-164`) is preserved as the *in-code postmortem*:

```
"Wrapped so a setup throw (e.g. missing AUTH_SECRET breaking cookie
 encryption in production) returns the real message instead of a bare 500."
```

This is the smallest possible incident artifact. No `runbooks/` directory, no Notion page, no postmortem doc — just the comment next to the guard. **The next developer who reads this code learns the lesson by reading the line above the try.** That's the lowest-friction documentation that survives — no link to follow, no separate file to discover.

The pattern is named explicitly in the code: *setup throw → real message → JSON 500*. Three concepts, one comment. Any future env-coupling bug in either route inherits the same shape because the pattern is already in the file.

### Move 2.4 — load-bearing skeleton

This is a four-part pattern. Drop any one and a specific named capability disappears.

**1. Isolate the kernel.**

```
  catch-setup-and-surface (pseudocode)

  route(req):
    try:
      partial_state_1 := await setup_call_1()      // anything that could throw on bad config
      partial_state_2 := await setup_call_2()
    catch e:
      log_with_route_prefix_and_redacted_cause(e)
      return JSON({error: routeName + ' setup · ' + e.message}, status=500)
    // setup succeeded — commit to the response shape (stream, JSON, etc.)
    return handler(partial_state_1, partial_state_2, req)
```

**2. Name each part by what BREAKS when it is missing.**

| Part | What breaks if removed |
| --- | --- |
| try/catch around setup | unhandled throw escapes → Vercel default 500 with no body → user sees opaque error |
| `redactSecrets(formatError(e))` in the log | token nested in `e.cause.cause` reaches Vercel logs → credential leak |
| route-name prefix in `console.error('[briefing] setup error:', …)` | log filter can't distinguish briefing-setup errors from agent-setup errors |
| route-name prefix in the JSON error message | client sees error but can't tell which route failed when both might fire on a single page load |
| `e instanceof Error ? e.message : String(e)` | a thrown string or object (non-Error) crashes the `.message` access → second throw inside the catch → bare 500 again |
| return BEFORE committing to a stream | catching after `new ReadableStream(...)` has been returned to the caller means you can't change the status code — too late, response headers already sent |

**3. Separate skeleton from optional hardening.**

The kernel is "try around setup → catch → log + return JSON." Optional hardening: `redactSecrets` (security), `formatError` (cause-chain walking), the route prefix (operational), the `e instanceof Error` guard (resilience to weird throws). All present, all earn their place by closing a specific failure path.

### Move 2.5 — Phase A / Phase B (current state vs incident state)

This concept is in *current-state-as-fix* shape. Phase A is the broken state (the incident); Phase B is the current state (the fix). The comparison teaches what changed.

```
  Comparison — before fix vs after fix

  before (the incident)                          after (current state)
  ─────────────────────                          ─────────────────────
  // app/api/briefing/route.ts                   // app/api/briefing/route.ts:168-179
                                                 
  const sid = await getOrCreateSessionId();      let sid: string;
  const dsResult = await makeDataSource(mode,    let dsResult: ...;
                                          sid);  try {
                                                   sid = await getOrCreateSessionId();
  //                                               dsResult = await makeDataSource(mode, sid);
  // aesKey() throws on missing AUTH_SECRET      } catch (e) {
  //  → throw escapes route                         console.error('[briefing] setup error:',
  //  → Vercel default 500 with no body              redactSecrets(formatError(e)));
                                                   return NextResponse.json(
  // client sees:                                    { error: `/api/briefing setup · ${...e.message}` },
  //   status: 500, body: <blank>                    { status: 500 },
  //   "something went wrong"                      );
                                                 }
                                                 
  // (continues with stream construction)        // (continues with stream construction
                                                 //  ONLY if setup succeeded)
                                                 
                                                 // client sees:
                                                 //   status: 500, body: { error: real message }
                                                 //   error panel: "AUTH_SECRET is required in production..."
```

The change is small (10 added lines, no removed lines) and structural (a new boundary, not a new behavior). The route's success path is unchanged. The only difference is that failure now lands as JSON instead of as a Vercel default page.

### Move 3 — the principle

The general principle: **a throw that escapes the request boundary is a debugging cost paid by the user.** Setup phases (env-shaped, config-shaped, init-shaped) are the most common place for unguarded throws because they happen once per request, feel like "framework code," and are easy to leave bare. Wrap them. The cost of the wrap is 10 lines and a try keyword. The benefit is that the next env-coupling bug is diagnosed in the time it takes to read the error message.

The corollary: **fail loudly at the source, contain at the boundary.** `aesKey()` throws with a message that names the var. The boundary catches that throw and turns it into a transport-appropriate response (JSON for an API route, an error page for an SSR route, etc.). The two responsibilities are different: the source knows *what* failed; the boundary knows *how to report a failure for this transport*.

The third lesson: **environment parity is partial; expect the env-only path to bite.** The dev path used the file cache; the prod path used the encrypted cookie. The throw lived in code only the prod path runs. Tests passed because tests took the dev path. The fix here isn't "add a test for prod" (no env to run it against locally without mocking AUTH_SECRET); the fix is to make the failure mode *legible when it happens*. The next env-coupling bug has the same shape and the same wrapper catches it.

## Primary diagram

The full picture — the incident, the cause, the fix, the lesson.

```
  Auth-secret postmortem — the incident and its fix

  ┌─ env (the trigger) ────────────────────────────────────────────────┐
  │  AUTH_SECRET not set in Vercel project env vars                     │
  │  (worked locally because dev uses a different codepath)             │
  └─────────────────────────┬───────────────────────────────────────────┘
                            │ in production only
  ┌─ storage layer (the source) ───▼───────────────────────────────────┐
  │  lib/mcp/auth.ts                                                    │
  │    aesKey() at line 51-60                                           │
  │      throw new Error('AUTH_SECRET is required ...')                 │
  │                                                                     │
  │    called from withAuthCookies (line 86-104), prod-only             │
  │      decryptStore(raw) at line 90 → aesKey() throws                 │
  └─────────────────────────┬───────────────────────────────────────────┘
                            │ throw propagates up the awaits
                            ▼
  ┌─ service layer (where it landed) ──────────────────────────────────┐
  │  app/api/briefing/route.ts  app/api/agent/route.ts                  │
  │                                                                     │
  │  BEFORE: no boundary; throw escapes to Vercel; bare 500             │
  │                                                                     │
  │  AFTER (briefing/route.ts:168-179, agent/route.ts:165-174):         │
  │    try { setup() }                                                  │
  │    catch (e) {                                                      │
  │      console.error('[route] setup error:',                          │
  │        redactSecrets(formatError(e)));    ← Vercel logs, redacted   │
  │      return NextResponse.json({ error: routeName + ' setup · ' +    │
  │        e.message }, { status: 500 });    ← client sees real message │
  │    }                                                                │
  │                                                                     │
  │  THE COMMENT (briefing/route.ts:167-168) IS THE POSTMORTEM:         │
  │    "Wrapped so a setup throw (e.g. missing AUTH_SECRET breaking     │
  │     cookie encryption in production) returns the real message       │
  │     instead of a bare 500."                                         │
  └─────────────────────────┬───────────────────────────────────────────┘
                            │ JSON 500 with real message
                            ▼
  ┌─ UI layer (the recovery) ──────────────────────────────────────────┐
  │  useBriefingStream.ts:63-72 readBody helper                         │
  │    parses JSON or falls back to __raw text                          │
  │  useBriefingStream.ts:172-183                                       │
  │    setErrorMessage(body.error) → error panel renders the real text  │
  │  user sees: "AUTH_SECRET is required in production..."              │
  └─────────────────────────────────────────────────────────────────────┘

  THE PATTERN INSTALLED (applies to all future env-shaped failures):

    catch-setup-and-surface
      ────────────────────────
      try { all-the-can-throw-on-bad-config }
      catch (e) {
        log_with_route_prefix(redactSecrets(formatError(e)));
        return JSON({error: routePrefix + ' setup · ' + (e?.message ?? String(e))},
                    { status: 500 });
      }
```

## Elaborate

The "production-only because of env-coupling" failure mode is one of the most common 12-factor app gotchas. The Twelve-Factor App's third factor ("Store config in the environment") sets the expectation; the *failure* it doesn't prepare you for is that env-shaped failures happen at request time, in production, and your local dev path may not exercise the code that touches the env. Every team that ships to a serverless platform learns this lesson at least once.

The deeper principle is **boundary-shaped error handling**. Each request boundary in a system needs a "catch and surface" at its edge — a "what's the right shape of error for *this* transport?" handler. For an HTTP API route, JSON with a status code. For an SSR page, a `<NoBoundary error={…}/>` element. For a background worker, a dead-letter queue entry. The transport differs; the *boundary discipline* is the same: don't let a throw escape the request scope unhandled.

The codebase has at least three other examples of the same discipline applied in the same files:

- `DOMException` `AbortError` is *intentionally* not surfaced (`app/api/briefing/route.ts:294-296`, `app/api/agent/route.ts:308-310`) — the client cancelled, there's no consumer to read the error, so the boundary swallows the throw and the `finally` records the phase log anyway. This is the *same pattern, opposite policy*: catch and decide on a per-shape basis.
- `disposeDataSource` errors are caught and logged but not surfaced (`briefing/route.ts:308-312`, `agent/route.ts:322-326`) — a teardown error must NOT swallow the route-level error above. The order matters: teardown's catch sits inside `finally`, *after* the main response is already committed.
- The retry ladder + ceiling in `BloomreachDataSource.callTool` — a hung MCP connection would burn the 300s budget; the per-call `TOOL_TIMEOUT_MS = 30_000` at `lib/mcp/transport.ts:38` catches it and throws fast. Comment: "a retry would just risk another 30s wait inside the same route budget."

All three are the same pattern in different costumes: identify the boundary, decide the right shape of error for *this* boundary, install the catch.

**Adjacent concepts:**
- **The 12-factor app** — config in environment, named here as the system that creates the conditions.
- **Sentry / Rollbar / Datadog error tracking** — what you'd install to NOTICE this kind of bug if you didn't already have a JSON error body that shows up in the UI.
- **Health checks / readiness probes** — what you'd install to FAIL FAST on a missing env at startup time instead of first-request time. Vercel doesn't run these the way Kubernetes does, so this codebase relies on the first request to discover the failure.
- **Defensive try/catch** — the antipattern this *isn't* (which catches too much, hides bugs, and ends up logging-and-continuing instead of failing properly).
- **Boundary error handling in Erlang/Elixir** — let it crash inside, supervisor catches at the boundary. Same shape, language-level.

**Read next:**
- `01-ndjson-agent-event-discriminated-union.md` — the *successful* path; this postmortem is the failure-mode complement.
- `03-three-rung-mem-file-seed-store.md` — the auth store is one instance of the same three-rung pattern; the production rung is where AUTH_SECRET lives.
- `audit.md` § 7 (incident-analysis-and-prevention).

## Interview defense

**Q: Walk me through the bug.**
A: Production hit returned a bare 500 with no body. Dev was fine, tests were fine, no errors in CI. The 500 had no Vercel function logs because the throw escaped before any `console.log` ran. Tracking it down: hit the route locally with `NODE_ENV=production npm run start` (simulating the prod codepath), reproduced. The throw was `aesKey()` at `lib/mcp/auth.ts:51-60` — `AUTH_SECRET` env var wasn't set in the Vercel project. Set it; bug went away. The fix: wrap the setup phase of both routes (briefing and agent) in try/catch that returns JSON with the real message. Now any future env-coupling bug surfaces immediately in the UI instead of as a blank 500.

> *Sketch:* the before/after comparison from Move 2.5.

**Anchor:** "Env-only codepath, dev never ran it, the boundary catch makes it legible."

**Q: Why catch at the route entry instead of fixing `aesKey()` to not throw?**
A: `aesKey()` *should* throw — encrypting a cookie with a zero key is worse than refusing. The bug isn't that `aesKey` threw; the bug is that the throw had nowhere to land before becoming a 500. Fixing `aesKey` to "return a default key on missing env" would silently degrade prod security. The right move is to let the source throw with a useful message, and catch at the request boundary where the appropriate response shape is JSON. **Fail loudly at the source, contain at the boundary.**

> *Sketch:* the two seams diagram — source (aesKey throw, unchanged) and boundary (route catch, added).

**Anchor:** "Source fails loudly; boundary decides the response shape."

**Q: Why didn't tests catch this?**
A: Tests run with `NODE_ENV` ≠ `production`, so `withAuthCookies` at `lib/mcp/auth.ts:86-87` short-circuits and `aesKey` is never called. Dev runs the file-cache path; tests run the memory-cache path; prod runs the cookie path. Three rungs, three code paths, only one calls `aesKey`. There's no env to test the cookie path against locally without mocking `AUTH_SECRET` — possible, but every test that touches auth would need to fork (with-secret / without-secret). The chosen tradeoff: don't test the prod-only code path; make the failure mode *legible* when it happens. That's the catch at the route entry — first-request diagnosis instead of a stack trace search.

> *Sketch:* the dev/test/prod codepath split from `lib/mcp/auth.ts:86-104`.

**Anchor:** "Three codepaths, tests run two; prod-only path is legible by design."

**Q: How does redaction work in the catch?**
A: `redactSecrets(formatError(e))`. `formatError` at `lib/mcp/transport.ts:82-97` walks the cause chain up to 5 levels (`e.cause`, `e.cause.cause`, …) and concatenates them into one string. This is necessary because `String(e)` doesn't follow `cause` — so a token tucked inside `e.cause.cause` would survive `String(e)` and reach the logs. After the chain is built, `redactSecrets` runs 5 regex patterns (`Bearer …`, `access_token`, `refresh_token`, `id_token`, `code_verifier`) over the string and replaces matches with `[redacted]`. The order matters: walk first, redact second — otherwise the redaction misses tokens that get pulled in from nested causes during the walk.

> *Sketch:* the chain of `e → e.cause → e.cause.cause`, then the redaction step.

**Anchor:** "Walk the cause chain, then redact."

**Q: What's the next env-coupling bug this catches?**
A: Any prod-only env var. `ANTHROPIC_API_KEY` is already check earlier in the route (line 155, returns 401-style JSON, separate guard). But a future `MCP_CLIENT_ID` or `OAUTH_REDIRECT_URI` or rotated AES key would all throw inside `makeDataSource` and land in the same try/catch — JSON with the real message, route-name prefix, redacted cause chain. The pattern installed is *generic*; this incident's specific var name is incidental. The skeleton at Move 2.4 — try setup, catch, log with prefix, return JSON 500 — handles the whole class.

> *Sketch:* the catch kernel from Move 2.4 with arrows showing it catches "any setup throw."

**Anchor:** "Pattern is general; AUTH_SECRET was the first instance."

**Q: What's missing that would prevent it instead of catching it?**
A: A startup-time env check. Something like Zod-parsing `process.env` at module load — `MCP_CLIENT_ID: z.string().min(1)`, etc. — so the *deploy* fails when an env var is missing, not the first request. Vercel doesn't run readiness probes (the way Kubernetes does), so the deploy-time check would have to be a build-time or import-time assertion. This codebase doesn't have one. Adding it is one possible follow-up; in the meantime, the catch at the boundary is the safety net.

> *Sketch:* a "startup env check" box upstream of the route, currently empty.

**Anchor:** "Startup parsing would prevent; boundary catch is what we have."

## See also

- `01-ndjson-agent-event-discriminated-union.md` — the success-path the catch protects.
- `03-three-rung-mem-file-seed-store.md` — the auth-store instance of the three-rung pattern that the cookie rung depends on.
- `audit.md` § 7 (incident-analysis-and-prevention) — the lens this postmortem fulfills.
