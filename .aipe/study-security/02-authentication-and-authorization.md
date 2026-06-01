# Authentication and authorization

**Industry name(s):** authn vs authz, OAuth 2.0 Authorization Code + PKCE, Dynamic Client Registration, session management, the confused-deputy problem
**Type:** Industry standard · Language-agnostic

> blooming insights does **authentication well and authorization minimally** — the OAuth 2.0 + PKCE + DCR flow against Bloomreach is correct (covered in depth in `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md`), but the app-layer "what can you do" check is *just* "do you have a valid session." There are no application-level roles, no per-resource permissions, and no second factor. That's the right call for a single-tenant agentic shell where Bloomreach owns the real authz — but it makes "session cookie theft = full impersonation" the load-bearing risk, and it makes the missing CSRF token on `POST /api/mcp/reset` a real, if low-severity, finding.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Authentication answers *who are you*; authorization answers *what can you do*. In blooming insights, "who are you" is answered three times: by the `bi_session` UUID (which proves "same browser as before"), by the OAuth tokens in `bi_auth` (which prove "you logged into Bloomreach"), and by the Bearer token on every MCP call (which Bloomreach itself validates). The "what can you do" answer is much simpler: if you have an active session, you can do everything the app exposes — there's no app-layer role system because there's no app-layer concept of differing users.

```
  Zoom out — authn and authz across the layers

  ┌─ UI ───────────────────────────────────────────────────┐
  │  the browser holds bi_session + bi_auth                │
  └────────────────────────────┬───────────────────────────┘
                               │
  ┌─ Route handler ────────────▼───────────────────────────┐
  │  ★ AUTHN gate ★                                         │  ← we are here
  │  getOrCreateSessionId → bi_session                     │
  │  connectMcp → { ok: true, mcp } OR { ok: false, auth   │
  │                URL for redirect }                       │
  │  ★ AUTHZ gate ★ = "do you have a session at all?"      │
  └────────────────────────────┬───────────────────────────┘
                               │ Bearer token
  ┌─ Bloomreach (real authz) ──▼───────────────────────────┐
  │  per-user OAuth token, BR enforces what user can read  │
  └────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: where does identity get established (authentication), and where does each request get gated against an allowed action (authorization)? Authentication is well-handled — the OAuth flow is correct, the cookies are httpOnly, the tokens are encrypted at rest. Authorization at the app layer is *coarse* — every route either accepts your session or 401s; there's no per-route role check. The cross-reference for the authn mechanics is the existing OAuth boundary file; this file focuses on the trust-boundary framing and on the authz side that file doesn't cover.

---

## Structure pass

**Layers.** Three layers carry an authn/authz decision. The **browser** layer holds the credentials (cookies). The **route handler** layer enforces "do you have a session" (the only app-layer authz check). The **Bloomreach** layer enforces the real per-user authorization (what data your token can read).

**Axis: trust.** Hold one question constant: *what is each layer trusted to decide?* The browser is trusted with nothing (it just carries cryptographically-protected state). The route handler is trusted to decide "session present yes/no" — and nothing more granular. Bloomreach is trusted to enforce per-user permissions on every tool call.

**Seams.** Two load-bearing seams. **Seam 1 (browser → route)** enforces *identity* — the cryptographic gate that turns a cookie into a session. **Seam 2 (route → Bloomreach)** enforces *authorization* — Bloomreach reads the Bearer token and decides what you can see. The seam that's *missing* is the would-be one between routes (some routes need higher privilege than others) — every route's check is the same "got a session?" with no privilege differentiation. That's not necessarily wrong; it's a deliberate simplification given the app's shape.

```
  Structure pass — authn / authz

  ┌─ 1. LAYERS ───────────────────────────────────────┐
  │  browser (carries cookies)                         │
  │  route handler (session presence check)            │
  │  Bloomreach (real per-user authz)                  │
  └────────────────────────┬──────────────────────────┘
                           │  hold the trust question
  ┌─ 2. AXIS ─────────────▼───────────────────────────┐
  │  trust: what is each layer trusted to decide?      │
  └────────────────────────┬──────────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼───────────────────────────┐
  │  browser → route        IDENTITY GATE              │
  │      crypto + httpOnly cookie pair                  │
  │  route → Bloomreach     AUTHZ GATE (upstream)       │
  │      per-user Bearer; BR enforces what's allowed    │
  │  route → route (missing) NO PRIVILEGE GRANULARITY   │
  │      every authenticated session sees everything    │
  └────────────────────────┬──────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped. Next we walk each gate.

---

## How it works

### Move 1 — the mental model

Authn and authz are two different questions and they usually need two different mechanisms. Authn proves *identity*; authz checks *permission for an action against a resource*. In a classic app: authn produces a `User` object; authz reads `user.role` against `resource.owner_id`. In this app: authn produces a `sessionId` (and indirectly, OAuth tokens); there's no `User` object and no role check — every authn'd session has the same permissions, which are whatever the user's Bloomreach token grants.

```
  authn vs authz — the two questions

  AUTHN — "who are you?"
   request arrives        identity established
   ┌──────────┐  cookie    ┌──────────────────┐
   │ browser  │ ─────────▶ │ sessionId = uuid │
   └──────────┘            │ tokens = present │
                           └──────────────────┘

  AUTHZ — "can you do this thing?"
   ┌──────────────────┐  decide   ┌──────────────────┐
   │ subject (user)   │ ────────▶ │ allow / deny     │
   │ action (read X)  │           │                  │
   │ resource (X)     │           │                  │
   └──────────────────┘           └──────────────────┘

  In blooming insights:
   subject  = sessionId
   action   = "use the app"   (no finer-grained action exists)
   resource = "MCP tools the user's Bearer can reach"
              (Bloomreach decides per call, not us)
   decision = "session present" (yes/no, no roles)
```

### Move 2 — walk each gate

#### Gate A — `bi_session` identity cookie

The simplest gate. On every request, the route calls `getOrCreateSessionId`, which reads `bi_session` from the cookie jar or creates a new UUID and sets it. The cookie has `httpOnly`, `sameSite=None; Secure` in prod and `sameSite=Lax; httpOnly` in dev.

```
  bi_session — what it is

  cookie value: 36-char UUID (crypto.randomUUID())
                ────────────
  no payload, no signature, no expiration metadata
  → it's an opaque connection id
  → it does NOT prove user identity by itself
  → its value: keys the encrypted bi_auth store
```

Pseudocode for the gate (it's a five-liner):

```
  getOrCreateSessionId():
    jar = await cookies()
    id  = jar.get('bi_session').value
    if not id:
      id = crypto.randomUUID()
      jar.set('bi_session', id, { httpOnly, sameSite, secure if prod })
    return id
```

**What this gate does:** establishes a stable opaque session ID. Two requests from the same browser will read the same UUID.

**What this gate does NOT do:** prove user identity. The UUID is random; nothing about it ties to a Bloomreach user account. The real identity comes from the OAuth tokens inside `bi_auth`, which are keyed by this UUID.

**Risk:** session fixation is bounded — `getOrCreateSessionId` only creates a UUID; it doesn't accept one from the browser. So an attacker can't pre-set `bi_session=known-value` and steal the session post-login. But cookie *theft* (post-login, via shared computer or some XSS surface elsewhere) gives the attacker the session for its 10-day lifetime. Httponly is the structural defense; there's no second factor.

#### Gate B — `bi_auth` encrypted OAuth state

The OAuth tokens, the PKCE verifier, and the DCR client info live in an AES-256-GCM-encrypted cookie. The full mechanics live in `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md`. The trust-boundary framing:

```
  bi_auth — what it carries, what it enforces

  contents: encryptStore({
    [sessionId]: {
      clientInformation?, codeVerifier?, tokens?, state?
    }
  })
                │
                │ AES-256-GCM, key = SHA-256(AUTH_SECRET), 12-byte IV, 16-byte tag
                ▼
  cookie value: base64url(IV || tag || ciphertext)
                │
                ▼
  enforcement:
    ─ httpOnly  → JS cannot read
    ─ Secure    → never sent on HTTP
    ─ SameSite=None → survives the OAuth round-trip
    ─ GCM tag   → tamper invalidates → decryptStore returns {}
    ─ 10-day maxAge → eventually expires
```

**What this gate does:** durably stores OAuth state across the connect → callback handoff in a way that survives Vercel's per-instance memory loss. Tamper-resistant, replay-safe within its lifetime, and only decryptable with `AUTH_SECRET`.

**What this gate does NOT do:** rotate. The token isn't refreshed within our code (the SDK's refresh path is untested per the comment in `lib/mcp/connect.ts` L1–L14). The cookie isn't bound to an IP address or device fingerprint. If both cookies are stolen, the session is the attacker's for as long as the token is valid upstream.

**Risk:** `AUTH_SECRET` rotation invalidates every existing session (all `bi_auth` cookies decrypt to `{}`), which forces every user to reauth. That's a *feature* for emergency revocation but a *cost* for routine secret rotation — there's no graceful rotation path. The code at `lib/mcp/auth.ts` L51–L79 makes this explicit; the residual risk is operational, not cryptographic.

#### Gate C — the Bearer token to Bloomreach

Every MCP call goes through `StreamableHTTPClientTransport` with the `OAuthClientProvider` attached. The provider's `tokens()` getter returns the `access_token`; the SDK attaches it as `Authorization: Bearer <token>` on every HTTP request to the MCP server.

```
  Per-MCP-call authz — Bloomreach side

  our code                                Bloomreach MCP server
   │                                       │
   │ POST /tools/execute_analytics_eql     │
   │ Authorization: Bearer <user-token>    │
   │ { project_id, eql }                   │
   ├──────────────────────────────────────▶│
   │                                       │
   │                                       │ ─ validate token (not expired,
   │                                       │   not revoked, scope ok)
   │                                       │ ─ resolve user
   │                                       │ ─ enforce per-resource authz:
   │                                       │   "can user read project_id?"
   │                                       │
   │ ◀───────── 200 OK / 401 / 403 ────────│
   │                                       │
```

**What this gate does:** every tool call is authorized upstream against the user that completed OAuth. We can't read data the user can't see, and we can't write what we don't have a write tool for.

**What this gate does NOT do:** scope-down. Our DCR registration requests `scope: 'openid profile email'` (see `lib/mcp/auth.ts` L178). That's identity scopes, not the MCP-specific scopes. Whatever scopes the MCP server grants on top of OIDC, the token gets — we don't ask for fewer. Bloomreach's authz is what it is.

**Risk:** if Bloomreach's per-user authz has a bug, we'd see it as "the agent could see something it shouldn't." There's no second layer in our code that would catch it. We trust upstream completely on this seam — appropriately, because we're a client, not an authorizer.

#### Gate D — the *missing* per-route authz check

Every route's authz check is `do you have a session that can produce a valid Bearer token?` The check is:

```
  per-route authz check — pseudocode

  routeHandler(req):
    sid  = await getOrCreateSessionId()       ← always succeeds (creates if needed)
    conn = await connectMcp(sid)              ← needs tokens; returns authUrl if missing
    if not conn.ok:
      return 401, { needsAuth: true, authUrl }
    // ... handle the request, using conn.mcp
```

That's the check. Every authn'd route is identical. There is no:
- role check (`if not isAdmin(user) return 403`)
- per-resource check (`if insight.owner !== user.id return 403`)
- CSRF token check (`if csrfToken !== session.csrfToken return 403`)
- origin check (`if Origin not in allowedOrigins return 403`)

```
  routes that share the same check

  GET  /api/briefing          ← session check only
  GET  /api/agent             ← session check only
  POST /api/mcp/call          ← session check only
  GET  /api/mcp/tools         ← session check only
  GET  /api/mcp/tools/check   ← session check only
  POST /api/mcp/reset         ← session check only (no CSRF token!)
  POST /api/mcp/capture       ← session check + dev-only 403
  POST /api/mcp/capture-demo  ← session check + dev-only 403
  GET  /api/mcp/callback      ← exchanges code for tokens
```

**What this gate does:** keeps unauth'd traffic out.

**What this gate does NOT do:** distinguish "send a briefing request" from "reset the session." A CSRF attack against `POST /api/mcp/reset` would log the user out of their session. A CSRF attack against `GET /api/agent?insightId=X` would *spend Anthropic tokens on the victim's behalf* (the route is a GET with side effects). These are real findings, even if the severity is moderate.

**Risk (concrete):** an attacker hosts a page with `<form action="https://blooming-insights.app/api/mcp/reset" method="POST"><input/></form>` and tricks the user into submitting it (or auto-submits with JS). The user's `bi_session` cookie is sent, the session is cleared, the user is logged out. Recovery: re-auth. Severity: low (no data loss). Same kind of attack against `GET /api/agent?insightId=...&q=...` via `<img src="...">` would be blocked by the browser (images can't make NDJSON streams render), but a `<script src="...">` or a hidden iframe would let the route run server-side. Anthropic tokens spent for nothing.

### Move 3 — the principle

**Authentication is solved at the protocol layer; authorization needs explicit application-level decisions, even if the decision is "everyone authn'd can do everything."** This codebase made that decision deliberately (single-tenant agentic shell, Bloomreach owns the real authz). The audit's job is to make sure the decision is *named* — not unconsciously inherited. The places where it leaks (no CSRF, no origin check on GET-with-side-effects routes) are the audit's findings.

---

## Primary diagram

The full authn/authz flow with all four gates labelled.

```
  Authentication and authorization — full flow

  ┌─ Browser ────────────────────────────────────────────────────────┐
  │                                                                    │
  │  cookies: bi_session (UUID)                                       │
  │           bi_auth    (AES-256-GCM-encrypted store)                │
  │                                                                    │
  └───────────────────────────┬───────────────────────────────────────┘
                              │  HTTPS + cookies
                              │  GATE A: bi_session establishes connection-id
                              │  GATE B: bi_auth crypto-validated, OAuth state read
                              ▼
  ┌─ Route handler ──────────────────────────────────────────────────┐
  │                                                                    │
  │  getOrCreateSessionId()      ← Gate A enforcement                 │
  │  withAuthCookies(fn) → fn()                                       │
  │     ↓ inside fn: connectMcp(sid)                                  │
  │       ↓ provider.tokens()    ← Gate B enforcement                 │
  │       ↓ if tokens: ok                                             │
  │       ↓ else:      return { authUrl } for browser redirect        │
  │                                                                    │
  │  ★ NO PER-RESOURCE AUTHZ CHECK ★                                  │
  │  ★ NO CSRF TOKEN ★                                                │
  │  ★ NO ORIGIN ALLOWLIST ★                                          │
  │  → every authn'd session can hit every route the same way         │
  │                                                                    │
  └───────────────────────────┬───────────────────────────────────────┘
                              │ Authorization: Bearer <access_token>
                              │  GATE C: Bloomreach validates token + per-call authz
                              ▼
  ┌─ Bloomreach MCP server ──────────────────────────────────────────┐
  │                                                                    │
  │  validates Bearer (signature, expiry, revocation)                 │
  │  enforces per-user authz: "can this user read project_id X?"      │
  │  returns tool result or 401 / 403                                 │
  │                                                                    │
  └──────────────────────────────────────────────────────────────────┘
```

The diagram makes the missing gate visible: between "session check passes" and "MCP call goes out," there's no application-layer policy. Every authn'd request is treated identically.

---

## Implementation in codebase

The authn mechanics (PKCE + DCR + token exchange) are exhaustively covered in `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md`. Here we cite the trust-boundary-relevant code only.

| Gate | File · Function | Lines | Role |
|---|---|---|---|
| A: identity cookie | `lib/mcp/session.ts` `getOrCreateSessionId` | L16–L24 | Reads or creates `bi_session` UUID |
| A: cookie hardening | `lib/mcp/session.ts` `sessionCookieOpts` | L10–L14 | `httpOnly` + `SameSite=None; Secure` (prod) / `Lax` (dev) |
| B: encrypted state | `lib/mcp/auth.ts` `aesKey` | L51–L60 | SHA-256(`AUTH_SECRET`) → 32-byte AES key; throws if unset |
| B: encrypted state | `lib/mcp/auth.ts` `encryptStore` / `decryptStore` | L62–L79 | AES-256-GCM with 12-byte IV, 16-byte tag |
| B: encrypted state | `lib/mcp/auth.ts` `withAuthCookies` | L86–L104 | ALS-scoped decrypt-once / flush-once per request |
| B: cookie hardening | `lib/mcp/auth.ts` `withAuthCookies` cookie set | L93–L101 | `httpOnly: true, secure: true, sameSite: 'none', maxAge: 10d` |
| B: provider | `lib/mcp/auth.ts` `BloomreachAuthProvider` | L160–L218 | OAuth client provider; drives PKCE + DCR; redirect-capture pattern |
| B: CSRF state | `lib/mcp/auth.ts` `consumeState` | L230–L235 | Implemented but NOT wired into callback (see route note) |
| B: callback | `app/api/mcp/callback/route.ts` `GET` | L5–L35 | Reads code, calls `completeAuth`; deliberately skips `state` re-check (L22–L26) |
| C: per-call Bearer | (SDK) `StreamableHTTPClientTransport` | n/a | The MCP SDK attaches the Bearer; we just provide the token via `provider.tokens()` |
| C: read-only tools | `lib/mcp/tools.ts` | L5–L40 | Per-agent tool whitelists are all read-only by name pattern |
| D: per-route check | every API route | various | All routes use the same `getOrCreateSessionId` + `connectMcp` shape |
| D (missing): CSRF | (no file) | — | No CSRF token on any POST route |
| D (missing): origin | (no file) | — | No origin allowlist on GET-with-side-effects routes |

**Use case 1 — first hit, no cookies.** `GET /api/briefing`. `getOrCreateSessionId` sets `bi_session`. `connectMcp` finds no tokens, captures the authorize URL, returns `{ ok: false, authUrl }`. Route returns 401 + `{ needsAuth: true, authUrl }`. Browser redirects to Bloomreach. After consent + callback, `bi_auth` is set. Next request: `connectMcp` returns `{ ok: true, mcp }` and the briefing runs.

**Use case 2 — CSRF on `/api/mcp/reset`.** An attacker page contains `<form action="https://blooming-insights.app/api/mcp/reset" method="POST"><input type="submit"></form>` styled to entice a click. The user clicks. The browser POSTs with the `bi_session` and `bi_auth` cookies (cross-origin POST with cookies works on `sameSite=None`). The route accepts, clears the auth. User is logged out. Severity: low. Mitigation: a CSRF token in a non-cookie place (e.g., a meta tag the form must echo), or an Origin/Referer check, or a sameSite=Lax cookie on the form-submit path.

**Use case 3 — Bloomreach 401s mid-session.** The user's MCP token was revoked upstream. Next tool call fails with HTTP 401, surfaced as an `McpToolError` with the captured response body. The route returns 500 with the error message. The user clicks "reset" (calling `POST /api/mcp/reset` → `deleteAuthCookie` + `clearAuth`) and re-auths. Note: there's no auto-reauth — the user has to do it manually.

---

## Elaborate

### Where this comes from

OAuth 2.0 (RFC 6749, 2012) was the response to "every API needs delegated auth and password sharing has to stop." PKCE (RFC 7636, 2015) closed the public-client gap (mobile apps, SPAs, server-side apps without a stable client secret). DCR (RFC 7591, 2015) closed the bootstrap gap (apps that need to register themselves rather than be pre-enrolled).

The split of authn from authz is older than the web — Bell-LaPadula (1973) and Lampson's classic access-control matrix predate OAuth by decades. The discipline of treating them as two questions with two different mechanisms is what the audit is checking.

### The deeper principle

**The confused-deputy problem** (Norm Hardy, 1988) is the canonical authz failure mode. The deputy is an authn'd actor that holds someone else's permissions and gets tricked into using them for the wrong purpose. CSRF is a confused-deputy attack: the user's browser is the deputy, holding the user's authz, and gets tricked into making a request the user didn't intend. Every CSRF defense is some way of telling the deputy "only act on requests the user actually initiated."

```
  Confused deputy — what CSRF is

  attacker                            user
   │                                   │
   │ "click this link"                 │
   ├──────────────────────────────────▶│
   │                                   │ click
   │                                   │
   │                                   ▼
   │                          ┌──────────────────┐
   │                          │ browser (DEPUTY) │  holds bi_session
   │                          └────────┬─────────┘  + bi_auth
   │                                   │
   │                                   │ POST /api/mcp/reset
   │                                   │ + cookies (attached automatically)
   │                                   ▼
   │                          ┌──────────────────┐
   │                          │ route handler    │  authz: "session present?"
   │                          │                  │  yes → execute reset
   │                          └──────────────────┘
```

The defense is to make the deputy able to *distinguish* between user-initiated and attacker-initiated requests. CSRF tokens (a value in a non-cookie place the attacker can't read), SameSite=Strict cookies, and Origin/Referer header checks are the three structural options.

### Where it breaks down in this codebase

1. **CSRF on `/api/mcp/reset`.** Logging the user out is low-stakes but trivially exploitable. Sev: low. Fix: SameSite=Strict cookie on a CSRF nonce, checked on POST; or an Origin allowlist.

2. **GET routes with side effects.** `GET /api/agent?insightId=…` spends Anthropic tokens. An attacker can trigger it cross-origin via `<img>`, `<iframe>`, or a hidden form. The browser sends the cookies. Token-spend amplification attack: cheap for the attacker, expensive for the app. Sev: medium (cost, not data). Fix: turn it into POST + CSRF, or check `Origin` matches APP_ORIGIN.

3. **`POST /api/mcp/call` accepting any tool name.** Authz-equivalent to "the session can run any tool the user can run on MCP." That's fine *today* because all tools are read-only by upstream construction, but it's a brittle assumption. Sev: low today, would be critical if Bloomreach added write tools. Fix: one-line tool-name allowlist.

4. **No second factor on the long-lived session.** 10-day cookie lifetime; stolen cookies = full session impersonation. Mitigated by httpOnly (no XSS exfiltration if the app's render layer stays clean) and by Bloomreach's own token-revocation if the user notices. Sev: medium in a sensitive deployment, accepted-risk in a demo. No structural fix exists without adding a real account system.

5. **No `consumeState` wiring** for CSRF on the OAuth callback. The provider implements `consumeState` and the test suite exercises it (`test/mcp/auth.test.ts`), but `app/api/mcp/callback/route.ts` L22–L26 explicitly doesn't call it — the SDK calls `state()` multiple times in one flow, so a naive "store-last, compare-once" approach rejects legitimate callbacks. The MCP SDK does its own state handling internally (per the comment "verified live 2026-05-27"); this is accepted risk in our code on the assumption that the SDK is correct.

### What to read next

- `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md` — the canonical OAuth + PKCE + DCR + encrypted-cookie deep dive. Don't re-derive it here; read that.
- File [04-secrets-and-configuration.md](./04-secrets-and-configuration.md) — what protects `AUTH_SECRET` itself.
- File [08-security-red-flags-audit.md](./08-security-red-flags-audit.md) — every authz gap consolidated.

---

## Interview defense

**What they are really asking:** can you explain the *difference* between authentication and authorization in your own app, and can you name the places where your authorization is just "vibes"?

---

**[mid] — What's authentication in this app, and what's authorization?**

Authentication is two-tiered. The local tier is a random UUID in `bi_session` and an AES-256-GCM-encrypted `bi_auth` cookie carrying the OAuth state. The real tier is the Bloomreach OAuth flow — PKCE + DCR + Authorization Code — that produces an access token for that user. The access token is the proof of identity Bloomreach checks on every MCP call.

Authorization at the app layer is coarse: every route checks "do you have a session that produces a valid Bearer token" and that's it. There are no roles, no per-resource checks, no CSRF tokens. The real authorization is at Bloomreach — the Bearer token is scoped to one user and Bloomreach decides what data that user can read. We're a client of their authz, not an enforcer of our own.

That's a deliberate simplification. The app is a single-browser-single-user agentic shell. A B2B SaaS would need a different model.

```
  authn  ─ bi_session + bi_auth + OAuth tokens + Bloomreach token validation
  authz  ─ "session present?"  (us)  +  "can user X read resource Y?"  (Bloomreach)
```

---

**[senior] — Where would a CSRF attack succeed in this app?**

`POST /api/mcp/reset` would succeed. There's no CSRF token, no Origin check, and the cookies are `sameSite=None` (because they have to survive the cross-site OAuth round-trip). An attacker page with `<form action="…/api/mcp/reset" method="POST">` and an auto-submit script logs the user out when the user visits. Recovery is just re-authing, so the severity is low — annoying, not destructive.

The slightly worse case is `GET /api/agent?insightId=…`. It's a GET with side effects: it spends Anthropic tokens. An `<img src="…">` won't trigger it (the response isn't an image), but a `<script src="…">` or a hidden iframe would. The attacker can't read the streaming response cross-origin (CORS blocks that), but they can *cause* it to run. The damage is wasted Anthropic spend, not data loss.

Structural fixes: a CSRF nonce in a non-cookie place (set on first request, returned in a meta tag, echoed in POST headers); or an Origin allowlist on state-changing routes; or convert the GET-with-side-effects routes to POST and require a CSRF nonce.

---

**[arch] — Why doesn't this app have user accounts? When is that the wrong call?**

The app is single-tenant per browser. The user authenticates *to Bloomreach*, and Bloomreach is where the user's data lives. The app is an agentic UI that drives Bloomreach on the user's behalf. There's no app-side concept of a user because there's no app-side data tied to a user — all the state is either in the cookie (for that session) or in Bloomreach (the source of truth).

When is that wrong? Three cases. (1) **Multi-tenancy on one Bloomreach token**: if multiple people share one Bloomreach login but should see different parts of it. We don't have that. (2) **App-owned data**: if we started storing things like "user X bookmarked these insights" or "user Y has these alert rules," we'd need accounts. We don't store anything per-user — every `briefing` is fresh, every `agent` run is unbacked by user state. (3) **Audit requirements**: if a regulator needed to know "who in your company opened this insight," we'd need accounts. We don't.

The migration path if it's ever wrong: add an `accounts` table, generate a session-bound user ID at signup, swap `getOrCreateSessionId` for a logged-in account lookup, then add per-route role gates. The OAuth-to-Bloomreach flow stays — it's now a *linked account* rather than the source of identity.

---

**The dodge — "is OAuth alone secure enough?"**

OAuth alone isn't a security property; it's an authentication protocol. It tells you *who* logged in, not *whether the request you're processing is one the user actually sent.* You need session protection (cookie crypto + httpOnly + SameSite) for the local tier, CSRF defenses for state-changing endpoints, and origin checks for routes with cost amplification. We have the first; we're partial on the second and third.

The honest "we're shipping anyway" framing: the app is a demo / portfolio piece, the multi-tenant attack surface is small, and the worst CSRF outcome is "log the user out." If this graduated to a B2B SaaS with real customer data, the CSRF and second-factor gaps would block ship.

---

**One-line anchors:**
- The app has good authn (OAuth + PKCE + DCR + encrypted cookie) and minimal authz (session-present check).
- The real authz is at Bloomreach; we faithfully carry the Bearer token, never escalate, never write.
- CSRF on `POST /api/mcp/reset` is the standout app-layer authz gap. Fix is one-line (Origin check).
- The 10-day cookie lifetime with no second factor is the standout authn gap. Acceptable in a demo, would block ship in a sensitive deployment.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, draw the four gates (A: session cookie, B: encrypted OAuth store, C: Bearer to Bloomreach, D: per-route authz). For each, name what it enforces and what file owns it. Then check against the **Implementation in codebase** table.

### Level 2 — Explain
Why does `withAuthCookies` decrypt the cookie once, run the function, and flush once — instead of decrypting and re-encrypting on every read/write? Check `lib/mcp/auth.ts` L39–L48 and the comment block.

### Level 3 — Apply
A new requirement lands: only some users should see the recommendation cards (others see monitoring + diagnostics only). Walk through what would have to change: where do you store the role, where do you check it, what's the new failure mode if a session ends up without a role assigned?

### Level 4 — Defend
A teammate proposes adding a CSRF token to every POST route. The token is set as a non-httpOnly cookie on first request and the client must echo it in a header. Defend or refute. (Hint: the double-submit cookie pattern. What does it cost, what does it protect against, what does it fail to protect against?)

### Quick check
- What's the prod auth cookie name? → `bi_auth` (`lib/mcp/auth.ts` L48)
- What's the session cookie name? → `bi_session` (`lib/mcp/session.ts` L3)
- Which file owns the OAuth client provider? → `lib/mcp/auth.ts`, class `BloomreachAuthProvider` L160–L218
- Which routes are missing CSRF protection? → all POST routes (no CSRF token check anywhere)
- What happens to existing sessions if `AUTH_SECRET` rotates? → every `bi_auth` decrypts to `{}`; users are forced to reauth

---

## See also

→ [00-overview.md](./00-overview.md) · [01-trust-boundaries-and-attack-surface.md](./01-trust-boundaries-and-attack-surface.md) · [04-secrets-and-configuration.md](./04-secrets-and-configuration.md) · [08-security-red-flags-audit.md](./08-security-red-flags-audit.md)

Cross-reference (do not duplicate): `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md` — the canonical PKCE + DCR + encrypted-cookie mechanics.
