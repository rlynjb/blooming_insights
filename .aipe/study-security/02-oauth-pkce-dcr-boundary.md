# 02 — oauth-pkce-dcr-boundary

**Industry name(s):** OAuth 2.1 Authorization Code Flow with PKCE (Proof Key
for Code Exchange, RFC 7636) + Dynamic Client Registration (RFC 7591).
Type: Industry standard.

## Zoom out — where this concept lives

Between blooming insights and the Bloomreach loomi MCP server is an OAuth
2.1 identity hop. The MCP server won't answer a tool call without a bearer
`access_token`; the app has to prove it's acting on behalf of a specific
Bloomreach user to get one.

```
  The OAuth boundary — one hop between three parties

  ┌─ UI (browser) ─────────────────────────────────────────┐
  │  visitor clicks "connect"                              │
  └────────────────────────┬───────────────────────────────┘
                           │  redirect to authorize_url
  ┌─ Provider (Bloomreach IdP) ▼──────────────────────────┐
  │  user logs in · consents                              │
  │  ★ THIS BOUNDARY ★  ← we are here                      │
  └────────────────────────┬───────────────────────────────┘
                           │  redirect back with ?code=…
  ┌─ Service (Next routes) ▼──────────────────────────────┐
  │  /api/mcp/callback  → exchange code for tokens         │
  │  (uses PKCE verifier + DCR client info from cookie)    │
  └────────────────────────┬───────────────────────────────┘
                           │  Authorization: Bearer <token>
  ┌─ Provider (MCP server) ▼──────────────────────────────┐
  │  loomi alpha · issues data                             │
  └───────────────────────────────────────────────────────┘
```

The point of this pattern: never let the `authorization_code` be replayable,
and never require the app to pre-register a client_id with the IdP.

## Structure pass

**Layers.** browser (redirects) → Next route (`connect` + `callback`) →
`BloomreachAuthProvider` (state + verifier + tokens) → MCP SDK
(`StreamableHTTPClientTransport` drives the flow).

**Axis: trust — who holds which secret at which step.**

```
  One axis — trust — traced across the auth code flow

  step 1 (connect):   app generates verifier + challenge
                      → verifier: server-only (in encrypted cookie)
                      → challenge: sent to IdP in authorize_url

  step 2 (IdP):       IdP holds the code briefly
                      → tied to challenge; can only be used with verifier

  step 3 (callback):  browser hands app back the code
                      → app pairs it with the stored verifier
                      → IdP verifies challenge == hash(verifier)

  step 4 (token):     app holds access_token + refresh_token
                      → in the encrypted cookie (never client-visible)
```

**Seam that matters.** The persistence seam between `connect` and `callback`.
The two run on different Vercel instances; the PKCE verifier + DCR client
info must survive the round-trip. That's the encrypted cookie's job
(walked in `01-encrypted-auth-cookie.md`).

## How it works

Two things stack here: PKCE prevents code interception, DCR removes the need
to pre-register with the IdP.

### Move 1 — the mental model

You've done password reset flows: "hash your new password, send us the hash,
prove it later." PKCE is the same shape, but for the OAuth code exchange.

```
  The PKCE kernel — proof by preimage

  step 1: app generates a random `code_verifier` (~43-128 chars)
  step 2: app sends `code_challenge = SHA256(code_verifier)` to IdP
  step 3: IdP hands back a `code` bound to that challenge
  step 4: app sends `{ code, code_verifier }` to exchange
  step 5: IdP checks SHA256(code_verifier) == the stored challenge
          → matches: hand out the tokens
          → doesn't: reject
```

Even if someone intercepts the `code` (browser history, network log, malicious
extension), they can't exchange it without the verifier — which stayed
server-side the whole time.

Dynamic Client Registration adds one preamble: the app registers itself with
the IdP on first use, gets a `client_id` back, and stores that alongside the
tokens. No manual "go create a client_id in the developer portal" step.

### Move 2 — the step-by-step walkthrough

**The provider — a shim over the SDK's OAuth surface.** The MCP SDK expects an
object matching `OAuthClientProvider`. The repo's implementation
(`lib/mcp/auth.ts:160-218`, re-exported from
`lib/mcp/auth-providers/bloomreach.ts`) exposes:

```
  OAuthClientProvider surface — what the SDK calls into

  redirectUrl              → where the IdP sends the browser back
  clientMetadata           → DCR registration payload
  state()                  → CSRF nonce
  saveClientInformation    ← DCR result (client_id)
  clientInformation()      → the stored DCR result
  saveCodeVerifier         ← the PKCE verifier (during connect)
  codeVerifier()           → the stored verifier (during callback)
  saveTokens               ← post-exchange tokens
  tokens()                 → the stored tokens (per request)
  redirectToAuthorization  ← the SDK signals "user needs to consent"
```

Every save/read runs through `patchState` / `readState`, which read from
the ALS-scoped store. In prod, that store is the encrypted cookie.

**Connect — start the flow.** `connectMcp` at `lib/mcp/connect.ts:82-90`
runs inside `withAuthCookies`. It builds the transport with a
`BloomreachAuthProvider`, calls `client.connect(transport)`, and reacts to
one of two outcomes:

```ts
// lib/mcp/connect.ts:108-140
try {
  await client.connect(transport);
  return { ok: true, mcp: new BloomreachDataSource(…) };
} catch (err) {
  if (
    provider instanceof BloomreachAuthProvider &&
    provider.lastAuthorizeUrl
  ) {
    return { ok: false, authUrl: provider.lastAuthorizeUrl.toString() };
  }
  throw err;
}
```

  → If the session already has tokens (`tokens()` returns them), the SDK
    goes straight to the tool call.
  → If not, the SDK calls `redirectToAuthorization(url)` on the provider.
    The repo's implementation captures the URL instead of triggering a
    browser redirect (`lib/mcp/auth.ts:205-207`) — the route can then
    return that URL to the client, which does the full-page redirect
    itself.

By that point, `saveCodeVerifier` has already fired inside `withAuthCookies`,
so the cookie flushes with the verifier persisted.

**Callback — finish the exchange.** `completeAuth` at
`lib/mcp/connect.ts:178-192` reconstructs a provider for the same session,
which reads back the DCR client info + PKCE verifier from the cookie, and
calls `transport.finishAuth(code)`. The SDK:

```
  finishAuth(code) — server-side steps

  1. reads codeVerifier() from the provider
  2. reads clientInformation() from the provider
  3. POSTs the token endpoint:
     grant_type=authorization_code
     code=<code>
     code_verifier=<verifier>
     client_id=<client_id_from_DCR>
     redirect_uri=<same one from connect>
  4. IdP returns { access_token, refresh_token, expires_in }
  5. calls saveTokens(t) on the provider
```

`saveTokens` flips `dirty = true`; `withAuthCookies` flushes the new tokens
into the cookie on the response. Next request → `tokens()` returns them →
tool call gets the bearer header → data flows.

**The redirect URI — matches the current host, not a fixed env var.**
`redirectUri()` at `lib/mcp/connect.ts:50-71` derives from
`x-forwarded-host` / `host` at request time. This matters on Vercel: preview
deployments (`app-git-branch-name.vercel.app`) and the production alias
(`app.vercel.app`) each want their own callback. Hardcoding `APP_ORIGIN`
would drop the session cookie whenever the two hosts differ. DCR registers
the URI on the fly for whichever host was used.

**The state parameter — defined, not enforced.** `consumeState` exists at
`lib/mcp/auth.ts:230-235` but isn't wired into the callback. The comment at
callback (`app/api/mcp/callback/route.ts:22-26`) explains: the SDK calls
`state()` multiple times per flow, so naive "store-last, compare-once" broke
legitimate callbacks. The SDK does its own state handling internally;
re-validating at this layer was redundant.

This is where a defensive read of "what does this codebase not do?" earns its
place. The pattern is documented in code, honest about the tradeoff, and the
skeleton is ready for a shared-store implementation that could track issued
states properly.

### Move 2 variant — the load-bearing skeleton

The kernel: **verifier → challenge → code → verifier again**. Two round-trips
that both need the verifier, which has to survive between them.

  → Drop the verifier persistence and the callback can't exchange the code —
    IdP rejects with `invalid_grant`.
  → Drop the DCR step and you need a pre-registered `client_id` per
    deployment. Every preview URL is a separate registration.
  → Drop the challenge hash (send verifier as challenge directly) and PKCE
    collapses to bearer-code — anyone who intercepts the code can exchange it.

Hardening on top: `state` (CSRF nonce — SDK handles), refresh token rotation
(SDK handles when the IdP supports it), `expires_in` respect (SDK handles),
the encrypted cookie discipline (this repo, walked in file 01).

### Move 3 — the principle

**Bind every secret to a proof only the requester can produce.** PKCE binds
the code to a verifier the interceptor never saw. TLS certificates bind
identity to a private key. Signed URLs bind an operation to a stored HMAC.
Same principle three times — the request carries the proof, not the secret.

## Primary diagram

```
  Full OAuth 2.1 + PKCE + DCR flow — every party, every hop

  ┌─ Browser ────────┐   ┌─ Next route ────┐   ┌─ Bloomreach IdP ─┐
  │                  │   │                 │   │                  │
  │  1. GET /        │   │                 │   │                  │
  │      ────────────┼──►│  connectMcp     │   │                  │
  │                  │   │  ├─ generate    │   │                  │
  │                  │   │  │  verifier    │   │                  │
  │                  │   │  ├─ challenge = │   │                  │
  │                  │   │  │  SHA256(v)   │   │                  │
  │                  │   │  ├─ DCR POST ───┼──►│                  │
  │                  │   │  │  ─────────── │◄──┤  { client_id }   │
  │                  │   │  ├─ save DCR    │   │                  │
  │                  │   │  │  + verifier  │   │                  │
  │                  │   │  │  into cookie │   │                  │
  │                  │   │  └─ return      │   │                  │
  │  2. redirect ────┼◄──┤    authUrl      │   │                  │
  │     authUrl      │   │                 │   │                  │
  │      ────────────┼───┼─────────────────┼──►│  3. login,       │
  │                  │   │                 │   │     consent      │
  │  4. redirect     │   │                 │   │                  │
  │     back w/ code │   │                 │   │                  │
  │      ◄───────────┼───┼─────────────────┼◄──┤                  │
  │                  │   │                 │   │                  │
  │  5. GET          │   │                 │   │                  │
  │     /callback?   │   │                 │   │                  │
  │     code=…       │   │                 │   │                  │
  │      ────────────┼──►│  completeAuth   │   │                  │
  │                  │   │  ├─ read v,     │   │                  │
  │                  │   │  │  client_id   │   │                  │
  │                  │   │  │  from cookie │   │                  │
  │                  │   │  ├─ POST token ─┼──►│                  │
  │                  │   │  │  { code, v } │   │                  │
  │                  │   │  │  ─────────── │◄──┤ verify SHA256(v) │
  │                  │   │  │              │   │ == challenge     │
  │                  │   │  │  ─────────── │◄──┤ { access_token,  │
  │                  │   │  │              │   │   refresh_token }│
  │                  │   │  ├─ saveTokens  │   │                  │
  │                  │   │  │  → cookie    │   │                  │
  │  6. redirect to /│◄──┤  └─ redirect    │   │                  │
  └──────────────────┘   └─────────────────┘   └──────────────────┘
```

## Elaborate

Where the pattern comes from: PKCE (RFC 7636, 2015) was born from the mobile
OAuth failure mode — public clients (mobile apps, SPAs) can't keep a
`client_secret` secret, so `authorization_code` interception via URL scheme
hijacking was a real attack. PKCE replaces the `client_secret` in the token
exchange with proof-of-verifier.

OAuth 2.1 (the not-yet-final RFC that consolidates 2.0 + best practices)
makes PKCE mandatory for all clients, including confidential ones.

DCR (RFC 7591) matters here because loomi is a multi-tenant MCP server: every
app that connects has its own `client_id`, and the alpha environment expects
apps to register themselves at connect time.

Related patterns:

  → SAML — older SSO, XML-heavy, different threat model. Same "IdP hands
    back a proof" shape.
  → OpenID Connect — OAuth 2.0 + ID tokens for authentication. Same flow;
    the `id_token` gives you claims about the user.
  → mTLS — mutual TLS as a client credential. Different tradeoff; needs
    cert distribution.

## Interview defense

**Q: What does PKCE actually prevent?**

A: Interception of the `authorization_code` between the IdP and the app's
callback. In OAuth 2.0 without PKCE, any process that saw the code could
exchange it for tokens (browser history, network logs, malicious extensions,
URL scheme hijacking on mobile). PKCE binds the code to a `code_verifier`
that never leaves the app's server side — only the challenge (the hash) went
to the IdP. Even with the code in hand, an interceptor can't exchange it.

```
  Without PKCE: [ code ]              → token
  With PKCE:    [ code + verifier ]   → token
                        └── never crossed the browser
```

Anchor: `lib/mcp/auth.ts:209-217` — `saveCodeVerifier` / `codeVerifier`.

**Q: Why Dynamic Client Registration instead of a fixed `client_id`?**

A: Vercel preview deployments each get a fresh host (`app-git-branch.vercel.app`).
The IdP validates `redirect_uri` against a registered list; a fixed
`client_id` would only work for whichever hosts were pre-registered. DCR
registers `{ client_name, redirect_uris: [this-host] }` on first use and
stashes the returned `client_id` in the encrypted cookie. Every host,
including previews, gets its own registration on the fly.

Anchor: `lib/mcp/auth.ts:172-181` (clientMetadata) and
`lib/mcp/connect.ts:50-71` (redirectUri).

**Q: The `state` parameter is defined but the callback doesn't validate it.
Why?**

A: The MCP SDK calls the provider's `state()` more than once per auth flow.
A naive "store last state, compare on callback" got the first stored value
overwritten by later calls — legitimate callbacks failed with "state
mismatch." The SDK does state validation internally (verified live 2026-05-27
per the callback comment). The provider's `consumeState` is kept and tested
for a future shared-store implementation that can track ISSUED (not just
last-stored) states.

Anchor: `app/api/mcp/callback/route.ts:22-26` (the comment explaining the
decision) and `lib/mcp/auth.ts:224-235`.

## See also

- `01-encrypted-auth-cookie.md` — the store that carries verifier + tokens
- `03-user-chosen-mcp-url-boundary.md` — why bearer tokens are NOT in this cookie
- `04-server-side-config-validation.md` — how the auth-type override is gated
