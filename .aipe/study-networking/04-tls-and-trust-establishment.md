# 04 · TLS and trust establishment

## Subtitle

Encryption in transit, certificates, and the OAuth handshake that rides on top — Industry standard.

## Zoom out, then zoom in

Every byte the app sends or receives over the network is TLS-protected, terminated at four points (the browser, Vercel's edge, Bloomreach's edge, Anthropic's edge). The interesting trust mechanism in this codebase isn't TLS itself — that's "off-the-shelf via the runtime" — it's the OAuth handshake that proves *who you are* on top of an already-encrypted connection. Three pieces working together: OAuth 2.1, PKCE, and Dynamic Client Registration.

```
  Zoom out — trust establishment, three layers

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  browser ◄─── TLS 1.2/1.3 ───► Vercel edge                  │
  │  trusts: WebPKI / Mozilla CA bundle                         │
  └─────────────────────────┬────────────────────────────────────┘
                            │ (terminated at edge)
                            ▼
  ┌─ Service layer ─────────────────────────────────────────────┐
  │  Node runtime                                                │
  │   ── TLS ──► loomi-mcp-alpha.bloomreach.com                  │
  │   ── TLS ──► api.anthropic.com                               │
  │  trusts: Node's bundled CA list (Mozilla-derived)            │
  │                                                              │
  │  ★ OAuth 2.1 + PKCE + DCR ★  ← the trust mechanism this      │
  │    runs ON TOP of the Bloomreach TLS connection;                guide is actually
  │    proves the route is allowed to call the user's data         about
  └──────────────────────────────────────────────────────────────┘
```

TLS gets glossed over here on purpose: it's not the interesting part. Everyone uses HTTPS, certs come from public CAs, the runtime handles the handshake. What's worth your time is the layer *above* TLS — how the route gets a Bearer token to put in its outbound headers, and how the cookie carrying that token survives a cross-site IdP redirect.

## Structure pass

  - **Layers** — transport encryption (TLS), application identity (OAuth Bearer), client identity (DCR registration), proof-of-possession on the code exchange (PKCE).
  - **Axis traced — "who's establishing trust with whom?"** Flips at each layer:
      - TLS: browser/Node trusts the server's certificate via the CA bundle.
      - OAuth Bearer: server trusts the client because it has a valid token.
      - DCR: server trusts the client *enough to issue tokens to it* because it registered correctly.
      - PKCE: server trusts the client's code-exchange because it can prove possession of the verifier matching the challenge.
  - **Seams** — the load-bearing one is the **OAuth callback boundary** at `app/api/mcp/callback/route.ts`. That's where the IdP redirect lands, the code exchange happens, and the token gets persisted. The other load-bearing seam is the **encrypted cookie** (`bi_auth`) — it's the only place client info + PKCE verifier survive between the connect request and the callback request on Vercel's ephemeral functions.

## How it works

### Move 1 — the mental model

OAuth 2.1's authorization-code-with-PKCE flow is just "send the user to the IdP with a hashed secret, get them back with a code, prove you know the unhashed secret to swap the code for tokens." DCR adds a step at the front: "before you can do any of that, register yourself as a client and get a client_id." All three pieces live on top of TLS — they don't replace it, they ride it.

```
  Pattern — OAuth 2.1 + PKCE + DCR, the kernel

  ┌──────────────────────────────────────────────────────────┐
  │ ONCE PER HOST (Dynamic Client Registration)              │
  │   client posts {redirect_uris, grant_types, ...}         │
  │   IdP returns {client_id}                                │
  │   client persists this                                   │
  └──────────────────────────────────────────────────────────┘
                              │
  ┌──────────────────────────▼───────────────────────────────┐
  │ PER USER (Authorization Code + PKCE)                     │
  │   1. client generates code_verifier (random 43-128 chars)│
  │      challenge = SHA-256(verifier).base64url             │
  │   2. redirect user to IdP with                           │
  │      client_id, redirect_uri, code_challenge=challenge,  │
  │      code_challenge_method=S256, state                   │
  │   3. user authenticates at IdP                           │
  │   4. IdP redirects back to redirect_uri?code=…&state=…   │
  │   5. client POSTs to /token with                         │
  │      code, code_verifier, client_id, redirect_uri        │
  │      ───── IdP verifies SHA-256(verifier) == challenge   │
  │   6. IdP returns {access_token, refresh_token, …}        │
  │   7. client persists, then attaches Bearer to all calls  │
  └──────────────────────────────────────────────────────────┘
```

The PKCE part is the load-bearing piece. Without it, anyone who can intercept the code (which travels through the user's browser via redirect) can swap it for tokens. PKCE proves the code-exchanger is the same party that started the flow.

### Move 2 — the moving parts

#### TLS — what the app DOESN'T do

  - No `tls` module import anywhere in app code.
  - No custom CA bundle, no `NODE_EXTRA_CA_CERTS`.
  - No certificate pinning.
  - No `rejectUnauthorized: false` (which would disable cert validation).
  - No TLS version pinning.

Everything is delegated to the runtime. Vercel terminates inbound TLS at the edge and re-encrypts to Node (or speaks HTTP in trusted infra). Node's outbound `fetch` uses the bundled CA list and negotiates TLS 1.3 with both Bloomreach and Anthropic by default.

The single TLS-shaped piece in app code is `secure: true` on cookies — see below.

#### DCR — registering as a public client

The MCP SDK does this on the first `client.connect(transport)` call when no `clientInformation` is in the auth store. The metadata it submits is what the provider exposes:

```ts
// lib/mcp/auth.ts:172-181
get clientMetadata(): OAuthClientMetadata {
  return {
    client_name: 'blooming insights',
    redirect_uris: [this.redirectUri],                  // ← derived per-request
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'openid profile email',
    token_endpoint_auth_method: 'none',                 // ← PUBLIC client
  };
}
```

`token_endpoint_auth_method: 'none'` says "this is a public client" — no `client_secret`, just PKCE for proof. That's the right shape because the app runs server-side but on Vercel's ephemeral runtime; storing a secret across deploys would require an env var that's awkward to rotate. PKCE replaces the secret with a per-flow proof.

Each unique `redirect_uri` triggers a *separate* DCR registration with Bloomreach. Preview deploys all get their own.

#### The encrypted cookie — surviving the IdP round-trip

This is the most interesting piece in the file. On Vercel, the request that *starts* OAuth (`/api/briefing` → `/api/mcp/call` → `connectMcp`) and the request that *finishes* it (`/api/mcp/callback`) are different ephemeral function invocations. They cannot share memory. The PKCE verifier saved during connect MUST be readable during callback.

The solution: persist everything OAuth-state-shaped into the `bi_auth` cookie, AES-256-GCM-encrypted under `AUTH_SECRET`.

```ts
// lib/mcp/auth.ts:62-67
function encryptStore(store: Store): string {
  const iv = randomBytes(12);                              // ← fresh IV per write
  const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
  //                    ▲ 12 bytes  ▲ 16 bytes (GCM tag)  ▲ ciphertext
}
```

Three pieces ride in one base64url blob: a 12-byte IV (so each cookie write produces different ciphertext for the same plaintext), the 16-byte GCM authentication tag (so a tampered cookie fails to decrypt rather than silently returning garbage), and the ciphertext itself.

The cookie attributes are equally load-bearing:

```ts
// lib/mcp/auth.ts:93-101
(await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
  httpOnly: true,                                          // ← no JS access
  secure: true,                                            // ← HTTPS only
  // SameSite=None so the PKCE verifier + client info survive the cross-site
  // OAuth return from the IdP to /api/mcp/callback (matches bi_session).
  sameSite: 'none',
  path: '/',
  maxAge: AUTH_COOKIE_MAX_AGE,                             // ← 10 days
});
```

`SameSite=None` is what makes the cross-site return from the IdP work. SameSite=Lax (the modern default) drops the cookie on a return navigation from an external origin in some browsers/flows, which would leave the callback request with no cookie, no PKCE verifier, no way to finish the code exchange. `Secure: true` is the price of SameSite=None — browsers require Secure when SameSite=None.

The `withAuthCookies` wrapper threads this through Next's cookie API:

```
  Layers-and-hops — the cookie's life across one OAuth flow

  ┌─ Browser ─────────────┐                        ┌─ Vercel function A ──────┐
  │  GET /api/briefing    │  cookie: bi_session    │  withAuthCookies(fn):    │
  │                       │ ─────────────────────► │   read bi_auth (empty)   │
  └───────────────────────┘                        │   run fn → connectMcp    │
                                                   │   → DCR + PKCE generate  │
                                                   │   ctx.store = { clientInfo,│
                                                   │     codeVerifier, ... }  │
                                                   │   ctx.dirty = true       │
                                                   │   flush: set-cookie      │
                                                   │     bi_auth = <encrypted>│
                                                   └─────────────┬────────────┘
                                                                 │
                                                  301 + Set-Cookie│
                                                                 ▼
  ┌─ Browser ─────────────┐                        ┌─ Bloomreach IdP ─────────┐
  │  follows redirect to  │  query: ?code_challenge│  user authenticates       │
  │  the IdP authorize URL│ ─────────────────────► │  redirects back with     │
  │                       │                        │  ?code=…&state=…         │
  └───────────────────────┘                        └─────────────┬────────────┘
                                                                 │ (cross-site)
                                                                 ▼
  ┌─ Browser ─────────────┐                        ┌─ Vercel function B ──────┐
  │  GET /api/mcp/callback│  cookie: bi_session +  │  withAuthCookies(fn):    │
  │  ?code=…&state=…      │  bi_auth (rides       │   read bi_auth (decrypts) │
  │                       │  cross-site because    │   ctx.store = { clientInfo,│
  │                       │  SameSite=None)        │     codeVerifier, ... }  │
  └───────────────────────┘ ────────────────────►  │   completeAuth(code):    │
                                                   │   → POST /token with     │
                                                   │     code_verifier        │
                                                   │   ← {access_token, …}    │
                                                   │   ctx.store.tokens = …   │
                                                   │   ctx.dirty = true       │
                                                   │   flush: set-cookie      │
                                                   │     bi_auth = <encrypted>│
                                                   └──────────────────────────┘
```

Two ALS-clever things:

  - The auth provider's `clientInformation()`, `codeVerifier()`, `tokens()` etc. (`lib/mcp/auth.ts:189-217`) read from a per-request `AsyncLocalStorage`-scoped store, not directly from the cookie. The cookie is loaded ONCE at the top of `withAuthCookies` and flushed ONCE at the bottom. Otherwise, Next's request-vs-response cookie split (a read *after* a set in the same request returns the OLD value) would break the provider's many synchronous read/write calls.
  - The same ALS-scoped store means concurrent requests on one Node instance get isolated state — function B's `bi_auth` read doesn't poison function A's in-flight write.

#### PKCE proof during the code exchange

```
  Layers-and-hops — PKCE on the token endpoint

  ┌─ Vercel function B ─────────────────────────┐    ┌─ Bloomreach token ep ───┐
  │  completeAuth(code):                         │    │                          │
  │   verifier = ctx.store.codeVerifier          │    │                          │
  │     ↑ persisted from function A              │    │                          │
  │     ↑ via the encrypted cookie               │    │                          │
  │                                              │    │                          │
  │  transport.finishAuth(code) →                │    │                          │
  │    POST /token  Content-Type: x-www-...     │    │                          │
  │     code=<code>                              │ ──►│  recompute               │
  │     code_verifier=<verifier>                 │    │  SHA-256(verifier)       │
  │     grant_type=authorization_code            │    │  compare to stored       │
  │     client_id=<from DCR>                     │    │  code_challenge          │
  │     redirect_uri=<derived host>              │    │  → match? issue tokens.  │
  │                                              │ ◄──│  → no match? 400.        │
  │  ← {access_token, refresh_token, expires_in} │    │                          │
  └──────────────────────────────────────────────┘    └──────────────────────────┘
```

The IdP can verify the code-exchanger is the same party that started the flow because only that party knew the verifier — the challenge it sent earlier is `SHA-256(verifier)`, and the verifier is unguessable from the challenge.

#### The Bearer token, in flight

Once tokens are persisted, every outbound MCP call rides them as an `Authorization: Bearer <token>` header that the SDK injects automatically. The custom fetch wrapper has to be careful here:

```ts
// lib/mcp/transport.ts:55-61
const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,           // ← bearer in any captured error body
  /"access_token"\s*:\s*"[^"]+"/g,            // ← token in an OAuth response body
  /"refresh_token"\s*:\s*"[^"]+"/g,
  /"id_token"\s*:\s*"[^"]+"/g,
  /"code_verifier"\s*:\s*"[^"]+"/g,
];
```

`redactSecrets` (line 66) runs on every error body before it's stored or logged. Without this, a 401 response that happened to echo the request envelope would put a Bearer token into Vercel's log stream.

#### Session state validation — the deliberate non-fix

OAuth's `state` parameter exists to prevent CSRF on the callback. This repo has a `consumeState` helper (`lib/mcp/auth.ts:230`) that is NOT wired into the callback today:

```ts
// app/api/mcp/callback/route.ts:22-26
// NOTE: we do NOT re-validate the OAuth `state` here. The MCP SDK invokes the
// provider's state() more than once during a single auth() flow, so our naive
// "store-last, compare-on-callback" check rejected legitimate callbacks
// ("state mismatch"). The SDK performs its own state handling; re-validating
// at this layer is redundant. (Verified live 2026-05-27.)
```

Worth knowing: this is a *deliberate* non-fix, not an oversight. The MCP SDK validates state internally; the helper is kept (and tested) for a future shared-store implementation that can track issued states across calls.

### Move 3 — the principle

Trust establishment in modern apps is a stack: TLS proves the server is who DNS said it would be; OAuth proves the client is who the IdP said they would be; PKCE proves the code-exchanger is the same client that started the flow; the encrypted cookie proves the request continuing the flow is from the same browser. Each layer protects against a different attacker. The mistake to avoid is conflating them — TLS alone doesn't authenticate the user; OAuth alone doesn't survive a cross-site redirect without a cookie that knows how to ride along.

## Primary diagram

```
  Full trust stack across one OAuth flow

  ┌─ TLS ─ trust the server's certificate (CA bundle) ──────────────┐
  │                                                                  │
  │  ┌─ DCR ─ register as a public client per host ───────────────┐  │
  │  │                                                            │  │
  │  │  ┌─ AuthCode + PKCE ─ prove possession of the verifier ─┐  │  │
  │  │  │                                                       │  │  │
  │  │  │  ┌─ encrypted cookie ─ carry state across requests ┐  │  │  │
  │  │  │  │  bi_auth: AES-256-GCM, SameSite=None, Secure    │  │  │  │
  │  │  │  │  ALS-scoped read/write inside withAuthCookies   │  │  │  │
  │  │  │  │  • clientInformation (from DCR)                 │  │  │  │
  │  │  │  │  • codeVerifier (for PKCE proof on callback)    │  │  │  │
  │  │  │  │  • tokens (issued by IdP)                       │  │  │  │
  │  │  │  └─────────────────────────────────────────────────┘  │  │  │
  │  │  │                                                       │  │  │
  │  │  └─ outbound: Authorization: Bearer <access_token> ─────┘  │  │
  │  │                                                            │  │
  │  └────────────────────────────────────────────────────────────┘  │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The piece of this story that's easy to under-appreciate: the encrypted cookie isn't just secret-storage — it's a *session-affinity workaround*. On a stateful runtime (one Node process across requests), you'd just use an in-memory Map. On Vercel, you can't — different requests hit different ephemeral functions. The cookie is the only shared state both can see *that the user already carries*. Redis would also work, would be faster (no round-trip through the user's browser, no per-request encrypt/decrypt cost), and would scale across more flow types — but for OAuth state, cookies are the no-infrastructure option.

The downside of cookies: size. Browsers cap one cookie at 4KB. The encrypted blob has to fit. Right now the blob holds `clientInformation` (small) + `codeVerifier` (~128 chars) + `tokens` (~1-2KB including refresh + id token). Comfortable margin. If a future expansion adds more state per session, that headroom shrinks.

The CA bundle question is worth a line, too: Node uses Mozilla's CA list bundled with the runtime. Vercel may add a Vercel-issued root for internal traffic; the app doesn't see that. If Bloomreach ever issued a cert from a non-WebPKI root (a private CA), the app would need `NODE_EXTRA_CA_CERTS` set in env. Not the case today.

## Interview defense

**Q: Walk me through the OAuth flow end-to-end.**

```
  user clicks 'live'
      ↓
  function A: connect → SDK does DCR (once per host) + generates
              code_verifier, redirects to IdP
              persist {clientInfo, codeVerifier} into bi_auth cookie
              (AES-256-GCM, SameSite=None+Secure)
      ↓
  browser follows 302 to Bloomreach IdP
      ↓
  user authenticates at IdP
      ↓
  IdP 302s back to redirect_uri?code=…
      ↓
  function B: GET /api/mcp/callback
              decrypts bi_auth → reads codeVerifier
              transport.finishAuth(code) → POST /token with verifier
              receives {access_token, refresh_token}
              persists into bi_auth cookie
              302 to /
      ↓
  later request: bi_auth → tokens → SDK attaches Bearer to MCP calls
```

**Anchor:** the cookie is the *only* state that survives between function A and function B on Vercel.

**Q: Why SameSite=None?**

Because the callback is a cross-site return from the IdP. SameSite=Lax (and certainly Strict) would drop the cookie on that navigation in some browsers, and then function B couldn't read the PKCE verifier, and the code exchange would fail. SameSite=None requires Secure (HTTPS only), which is fine because production is always HTTPS.

**Q: What's the load-bearing piece of the trust story?**

Two pieces, equally weight-bearing: PKCE (the IdP's proof that the code-exchanger is the original requester) and the encrypted cookie (the proof that the same browser is continuing the flow across two ephemeral function invocations). Drop either and the architecture breaks.

**Q: Why is `state` validation NOT wired in?**

The MCP SDK calls the provider's `state()` more than once per flow (observed live), so naive "store-last, compare-on-callback" rejected legitimate callbacks. The SDK validates internally. The helper is kept for a future shared-store implementation that tracks issued states properly. It's a deliberate non-fix, not an oversight.

## See also

  - `05-http-semantics-caching-and-cors.md` — for the cookie attributes (SameSite, Secure, httpOnly, Path) in HTTP terms.
  - `02-dns-routing-and-addressing.md` — for the per-host DCR consequence (each preview deploy registers separately).
  - `.aipe/study-security/` — for the threat model: what an attacker who controls the network, the cookie, or the redirect URI could do.
