# RFC-001: No database — the encrypted cookie IS the session store

**Status:** Accepted (implemented)
**Owner:** rein
**Decision:** blooming insights ships with zero database. The OAuth session — DCR client info, PKCE code verifier, access token, refresh token — lives in one AES-256-GCM-encrypted cookie (`bi_auth`) that the browser carries between requests. Insights and investigations live in per-instance `Map`s plus a dev-only JSON file plus a committed demo snapshot. There is no shared store.

---

## Context

blooming insights runs on Vercel serverless. Every request can land on a different warm Node process. The function filesystem is read-only outside `/tmp` (per-instance, ephemeral). Module-level `Map`s wipe on cold start. There is no platform-provided session affinity.

The OAuth flow against Bloomreach is multi-step and *requires state across requests*:

```
  Request 1 (GET /api/briefing, no auth)
    SDK calls clientInformation() → empty → triggers DCR
    SDK calls saveClientInformation(info)    ← must persist
    SDK calls state() and saveCodeVerifier(v) ← must persist
    SDK calls redirectToAuthorization(url)
    Route returns { needsAuth: true, authUrl }

  Request 2 (GET /api/mcp/callback?code=...)
    SDK calls codeVerifier()                  ← must read what R1 saved
    SDK exchanges code → tokens
    SDK calls saveTokens(tokens)              ← must persist

  Request 3+ (GET /api/agent?insightId=...)
    SDK calls tokens()                        ← must read what R2 saved
```

R1, R2, R3 are not guaranteed to be on the same warm instance. Any in-memory store loses the DCR client info or the PKCE verifier between R1 and R2 and the OAuth round-trip fails — the user sees a redirect loop. The choice was forced: pick a place for that state that *every instance can read*.

Implementation lives at `lib/mcp/auth.ts:34-104` (the three backends), `lib/mcp/auth.ts:62-79` (the AES-GCM crypto), `lib/mcp/auth.ts:86-104` (the `withAuthCookies` orchestration that decrypts once at request start and flushes once at end if dirty).

---

## Goals

- The OAuth flow completes on Vercel serverless across instance hops. No "you got logged out" failures caused by instance affinity.
- Zero infrastructure beyond Vercel itself. No Redis to provision, no Postgres to migrate, no KV namespace to scope.
- Tests run with no network and no real secrets. The auth flow must be testable without standing up a backing store.
- The dev experience matches production semantically — if it works locally, it works deployed.

## Non-goals

- A user account system. There are no users in the product sense (multi-tenant identity, password reset, account recovery). One Bloomreach OAuth identity per browser session.
- Cross-device session sync. The cookie is on this browser; another browser is another session.
- Audit logs of every authenticated request. If we ever need this, the cookie is wrong and we need a DB.
- Long-term insight history. The feed regenerates per request from the upstream warehouse; we never claim to "save" insights.
- Graceful `AUTH_SECRET` rotation. Rotating the secret invalidates every cookie. Named open question below.

---

## The decision

Three backends keyed off `NODE_ENV`, all driving the same `Store` shape:

```
  ┌─ Browser ────────────────────────────────────────────────────────┐
  │  bi_session   uuid, httpOnly, identifies the session              │
  │  bi_auth      AES-256-GCM ciphertext of the OAuth state           │
  │               (DCR + PKCE verifier + access + refresh tokens)     │
  └──────────────────────────┬───────────────────────────────────────┘
                             │  HTTPS + cookies
  ┌─ Route handler (Vercel serverless) ──────────────────────────────┐
  │                                                                  │
  │  withAuthCookies(fn):                                            │
  │    request start:  raw = cookies().get('bi_auth')                │
  │                    ctx = { store: decryptStore(raw), dirty: false}│
  │                    requestStore.run(ctx, fn)   ← ALS-scoped       │
  │                                                                  │
  │    handler body:   reads + writes hit ctx.store (in-memory)      │
  │                    mutating sets ctx.dirty = true                │
  │                                                                  │
  │    request end:    if ctx.dirty:                                 │
  │                       cookies().set('bi_auth', encryptStore(ctx))│
  │                                                                  │
  │  Backends:                                                       │
  │    NODE_ENV=production  → ALS-scoped, cookie-backed              │
  │    NODE_ENV=development → .auth-cache.json (gitignored)          │
  │    NODE_ENV=test        → in-memory Map (per-run isolation)      │
  └──────────────────────────┬───────────────────────────────────────┘
                             │  Authorization: Bearer <token>
  ┌─ Bloomreach IdP ─────────────────────────────────────────────────┐
  │  validates the OAuth token; we never authorize anything           │
  └──────────────────────────────────────────────────────────────────┘
```

Concretely:

- **The cookie value** is `base64url(iv || tag || ciphertext)`. The IV is 12 random bytes per encrypt. The auth tag is 16 bytes. The ciphertext is `JSON.stringify(store)` under AES-256-GCM. Wire format committed at `lib/mcp/auth.ts:62-79`.
- **The key** is `SHA-256(process.env.AUTH_SECRET)` — produces exactly 32 bytes regardless of operator input length. `lib/mcp/auth.ts:51-60`.
- **The orchestration** decrypts ONCE per request, holds the decrypted store in an `AsyncLocalStorage` context for the lifetime of the request, and flushes ONCE at the end if anything wrote. This avoids Next's request-vs-response cookie split (`cookies().get()` after `cookies().set()` in the same request returns the OLD value). `lib/mcp/auth.ts:86-104`.
- **Cookie flags** are `httpOnly` (JS can never read it — XSS exfil contained), `secure` (HTTPS-only), `sameSite: 'none'` (must survive the cross-site round-trip from the Bloomreach IdP back to `/api/mcp/callback`), 10-day `maxAge`.
- **Insights and investigations** live in `lib/state/insights.ts` (`Map<sessionId, SessionFeed>`, where each `SessionFeed` is its own `{ insights, investigations, anomalies }` sub-map) and `lib/state/investigations.ts` (`Map<id, AgentEvent[]>`). The outer map is session-keyed so a warm Vercel instance serving two concurrent users does NOT wipe one user's feed when the other's briefing finishes — `putInsights(sessionId, …)` clears only that session's sub-map (`lib/state/insights.ts:57-71`). The investigation flow hands diagnoses from step 2 to step 3 via the browser's `sessionStorage`, not the server — see `app/api/agent/route.ts:84-95` (the `parseDiagnosis(diagnosisParam)` path).

The pattern: **stateful client, stateless server.** Every byte of durable state lives on the browser. The server reconstructs the world from cookies + URL params + sessionStorage handoffs on every request. RFC-004 extends this same stance to the page-to-page boundary on the frontend — no global store, no provider, page hand-offs via `sessionStorage` + URL params.

---

## Alternatives considered

### Alternative A: Redis / Upstash KV

The default choice for "session store on serverless." Upstash gives you a Redis-compatible HTTP API, free tier, latency on the order of 50-100ms from a Vercel function.

**Why it lost:**

- One more service to provision, secret to rotate, dashboard to log into, and per-month cost line. For one engineer shipping a demo, that's friction with no payoff.
- Adds 50-100ms to every authenticated request (one read at request start, one write at end). Over a ~115s investigation flow this is negligible, but on a fast 200ms briefing it's a measurable drag.
- Introduces a *second* failure mode that didn't exist: Redis is down → the app is down. With cookies the only failure mode is "the user has no cookie" (= re-auth, which is recoverable).
- Cross-region replication semantics matter once you pick Redis. They don't if there's no Redis.

The honest version: Redis is the right answer the day we need any of cross-device sessions, multi-user accounts, server-initiated session revocation, or audit-grade session history. None of those are in scope.

### Alternative B: Postgres + a `sessions` table

The "real database" answer. A `sessions` table keyed by session UUID, columns for the OAuth state, indexed appropriately.

**Why it lost:**

- Everything Redis brings, doubled: a schema, migrations, a connection pool, an ORM (Drizzle / Prisma), a query language. For storing one row per session, that's pulling in a database to act as a slightly-more-durable KV.
- Vercel serverless connection pooling against Postgres is its own infrastructure problem (PgBouncer, Supabase pooler, Vercel Postgres pooler). Solvable, but yet more surface.
- The schema itself becomes a maintenance load. Every change to what the OAuth flow stores becomes a migration.
- The "use Postgres because someday we'll need it for other things" argument has not happened yet. When it does, this RFC gets a successor. Until then, we're paying maintenance for capability we don't use.

### Alternative C: Vercel KV (Edge Config-style)

Vercel's first-party KV product. Zero-config from inside a Vercel project, low latency, free tier.

**Why it lost:**

- Vendor lock. The day we leave Vercel — even just to test on another host — we have to reimplement the session backend. Cookies work the same on every host.
- The advantage over Upstash Redis is marginal (better integration, same shape). The disadvantage (deeper coupling) is real.
- Still requires the operator to enable the integration, provision the namespace, set the env vars. Not zero-config in practice.

### Alternative D: JWT signed with AUTH_SECRET (no encryption)

Use a signed JWT instead of an encrypted blob. Same cookie shape, same stateless property, fewer crypto operations per request.

**Why it lost:**

- **A JWT's claims are base64-decodable plaintext.** Anyone who steals the cookie reads the OAuth access token directly. For OAuth tokens specifically, that is the entire attack we need to prevent — the integrity of the token is meaningless if the token itself is visible.
- Signed JWTs solve "tamper detection" but not "secrecy." We need both. AES-GCM gives us both in one primitive.
- The "we can debug the claims in DevTools" argument is real but cuts the wrong way for OAuth tokens. The whole point is that they're not in DevTools.

### Alternative E: Plain `Map` in module scope, ignore the multi-instance problem

The "it works on my machine" non-decision. Module-level `Map<sessionId, Store>` that wipes on cold start.

**Why it lost:**

- It actively breaks the OAuth flow in production the first time R1 and R2 land on different instances, which happens within minutes on any Vercel deployment with traffic. Not theoretical — observed.
- Even on a single warm instance, cold-start eviction logs users out at random times. The user has no way to know why.
- This was tried briefly in early development. The "redirect loop after callback" bug it produces is hard to reproduce locally (dev runs one process) and easy to ship.

```
  Alternatives matrix

  option             cost      latency   vendor    secrecy   chosen?
  ─────────────────  ────      ───────   ───────   ───────   ───────
  encrypted cookie   $0        ~0ms      none      yes       ★
  Upstash Redis      $0-$10/mo +50-100ms light     n/a       no
  Postgres + table   $20+/mo   +20-50ms  medium    n/a       no
  Vercel KV          $0-$10/mo +20-50ms  heavy     n/a       no
  signed JWT         $0        ~0ms      none      NO        no
  module Map         $0        ~0ms      none      n/a       BROKEN
```

---

## Tradeoffs accepted

These costs are real and owned without flinching. We chose the cookie, accepting:

1. **Cookie size budget.** A `bi_auth` cookie carrying DCR + PKCE + tokens for one session sits around 1KB after encryption and base64url encoding. Comfortably under the 4KB per-cookie / 8KB per-domain browser limit. Each new field that lands in the `Store` shape eats into that budget. *We accept this — adding a 1KB field becomes a visible decision instead of a quiet `db.set()`.*

2. **No graceful `AUTH_SECRET` rotation.** Rotating the secret invalidates every existing cookie at once. Every active user re-auths. *We accept this for a single-user demo. RFC successor needed if we ever multi-tenant.*

3. **No server-side session revocation.** We can't "log out user X from the server side." The cookie is on their browser; until it expires (10 days) or the Bloomreach token expires, it works. *We accept this — the only mitigation is upstream token revocation at Bloomreach, which is available.*

4. **No cross-device session.** Sign in on desktop, sign in again on phone. *We accept this — there is no user account to bridge across devices.*

5. **No audit trail.** We have no record of "user X authenticated at time T." If a security incident demands one, we have nothing to give. *We accept this for the current scope.*

6. **The `Store` shape is the wire format.** Renaming a field in `Store` invalidates every cookie (the JSON doesn't parse to the new shape). Versioning is on the operator to do by hand. *We accept this — there is one operator and one app.*

---

## Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `AUTH_SECRET` is weak (`AUTH_SECRET=password`) | Medium | `.env.example` documents `openssl rand -base64 32`. **No code-level enforcement today** — see open question below. |
| `AUTH_SECRET` leaks (env var exposure, build artifact) | High | Cookies become decryptable offline. Mitigation: standard Vercel env-var hygiene; rotate the secret (invalidates all sessions, see tradeoff #2). |
| Cookie size grows past 4KB | Low today | Per-field review on every `Store` addition. `Store` is 4 fields total; doubling is fine. |
| `AsyncLocalStorage` context loss (e.g., escaping the `requestStore.run` boundary in a `setImmediate` callback) | Low | All cookie reads/writes are synchronous inside the handler. No callbacks escape the ALS scope today. |
| Cookie replay (attacker resends an old `bi_auth`) | Medium | The cookie carries an OAuth access token with its own Bloomreach-side expiry. Replayed cookies past the token's lifetime fail at the MCP call. Cookie `maxAge=10d` is the upper bound. **No nonce / version counter** — see open question. |
| `SameSite=None` requirement (for the OAuth round-trip) loosens cross-site cookie protection | Low | Required by the flow. CSRF is mitigated by the OAuth `state` parameter (`lib/mcp/auth.ts:183-187`) and by `SameSite=Lax` on `bi_session` for non-auth cookies. |

---

## Rollout / migration

No rollout question — this was the architecture from day one. The interesting migration scenario is *future*: the day we need a real database.

**If/when we add Postgres:**

1. Schema lives alongside the cookie, doesn't replace it. The cookie stays the source-of-truth for OAuth state (the round-trip requires SameSite=None and a browser-resident store, which the DB doesn't replace). The DB takes new state — saved searches, audit logs, per-user history — that *cannot* fit in a cookie.

2. `lib/state/insights.ts`'s `Map<sessionId, SessionFeed>` is the first thing that moves. The same-instance concurrent-user wipe bug is already resolved (session-keying — `lib/state/insights.ts:8-23, 57-71`); what's NOT resolved is the *cross-instance* case where R1 lands on instance A and R2 lands on instance B. Today the briefing fetch is short enough that the user almost always lands on the same warm instance for the duration of one session, but the day we ship to two concurrent users on a busy region, the cross-instance torn-state is the trigger.

3. Drizzle + Vercel Postgres (or Neon) is the obvious entry point. The pooling story is solved by those providers; we don't need to reinvent PgBouncer.

**If we never add Postgres:** the cookie pattern is genuinely complete for this product's scope. The 10-category briefing regenerates per request. There's nothing to save.

---

## Open questions

1. **`AUTH_SECRET` strength enforcement.** Today `aesKey()` silently accepts a 5-character secret. A two-line `if (secret.length < 32) throw …` closes the foot-gun. Worth doing; not yet done. Tracked in `.aipe/study-security/audit.md` finding C3.

2. **Graceful rotation.** Add a key-version byte prefix to the encrypted payload + an `AUTH_SECRET_OLD` env var, decrypt new-then-old. Rotation becomes a transition window instead of a one-way break. Not yet implemented. Tracked in audit finding C4.

3. **When does `lib/state/insights.ts` need to move to a real store?** RESOLVED in part: the *same-instance* concurrent-user wipe (one user's `putInsights` clearing another user's feed) is fixed via session-keying — `Map<sessionId, SessionFeed>` at `lib/state/insights.ts:8-23, 57-71`. Each user gets their own sub-map; the outer map is never cleared by a request. What remains open is the *cross-instance* case: if R1 lands on warm instance A and R2 lands on warm instance B for the same session, B's Map has no record of A's briefing. The day two concurrent users span instances enough to make this visible, the trigger fires and the RFC successor starts. Today the trigger hasn't fired.

4. **`AUTH_SECRET` rotation cadence.** No policy today. Suggested annual + on suspected compromise; not formally adopted.

5. **Browser support for cookies with `SameSite=None`.** Safari ITP and various privacy modes have eaten cookies on us before. The fallback today is "the user re-auths." A pop-up auth window (instead of full-page redirect) would survive some of these cases but adds UX surface. Deferred.

---

## What a reviewer will push on (and the framing that holds)

> "You're using cookies as a database. That's a smell."

It's not a database, it's a session store. The two things a database does — concurrent writes, queryable indexes — are exactly the two things we don't need for OAuth state on a serverless host. The cookie is the right shape for the job.

> "What happens when you need a second user?"

OAuth identity is already per-session (the `bi_session` cookie). Two browsers = two sessions = two cookies = two independent flows. The pattern scales to N independent sessions on N browsers. It does NOT scale to N users sharing state — that's the trigger for RFC-002 (a successor that adds Postgres for shared state, keeps the cookie for per-session auth).

> "Why not just JWT?"

Plaintext claims. JWT solves tampering; we need to solve secrecy too. AES-GCM solves both. The "JWT is easier to debug" line is true and irrelevant — debuggable OAuth tokens are exfiltrated OAuth tokens.

> "Won't `AUTH_SECRET` rotation lock everyone out?"

Yes, and we accept it for a single-user demo. The day we have many users, we add key-versioning (see open question #2). That's a 20-line change, not an architectural one.

---

## References

- `lib/mcp/auth.ts:34-79` — backend selection + AES-GCM crypto
- `lib/mcp/auth.ts:86-104` — `withAuthCookies` orchestration
- `lib/mcp/auth.ts:160-218` — `BloomreachAuthProvider` (the OAuth-SDK shape)
- `lib/state/insights.ts:8-23, 57-71` — the session-keyed `Map<sessionId, SessionFeed>` (the same-instance wipe bug fix; cross-instance is the open question)
- `app/api/agent/route.ts:84-95` — the sessionStorage handoff that compensates for the missing server-side investigation store
- `.aipe/rehearse-design-doc/05-datasource-seam-and-adapter-pattern.md` — the same "stateful client, stateless server" stance extended to the backend boundary (no DB on the data side either, even when the data is synthetic and in-process)
- `.aipe/study-security/01-encrypted-cookie-oauth-state.md` — deeper teaching guide on the crypto
- `.aipe/study-database-systems/00-overview.md` — the honest accounting of "what's where" when there's no database
- `.aipe/rehearse-design-doc/04-framework-runtime-without-data-primitives.md` — the same "stateful client, stateless server" stance extended to the page-to-page boundary (no global store, sessionStorage handoff between pages)
- NIST SP 800-38D — AES-GCM spec, IV uniqueness requirement
- iron-session (npm) — canonical reference implementation of this pattern
