# OAuth 2.1 with PKCE and Dynamic Client Registration

## Subtitle

Authorization Code + PKCE for a public client with Dynamic Client Registration (RFC 7591) · Industry standard

---

## Zoom out — where this concept lives

The Bloomreach loomi connect MCP server is a third-party API. To call it on behalf of the analyst, the app needs an access token. The analyst has to grant that — via a browser redirect they can see and cancel — and the app has to hold the resulting tokens without ever storing them in the client bundle.

That's OAuth 2.1 Authorization Code with PKCE. The wrinkle here is that the app is not pre-registered with Bloomreach; it registers itself on the fly via DCR (RFC 7591) and receives a `client_id` at runtime.

```
  Zoom out — where OAuth sits

  ┌─ Browser layer ─────────────────────────────────┐
  │  React redirect to authorize URL                 │
  │  bounces back to /api/mcp/callback?code=...      │
  └────────────────┬─────────────────────────────────┘
                   │
  ┌─ Service layer ▼─────────────────────────────────┐
  │  connectMcp()           ★ THIS CONCEPT ★          │  ← we are here
  │  BloomreachAuthProvider (implements MCP SDK's    │
  │  OAuthClientProvider)                            │
  │  completeAuth() ─ exchanges code for tokens      │
  └────────────────┬─────────────────────────────────┘
                   │
  ┌─ Provider layer ▼────────────────────────────────┐
  │  Bloomreach IdP (Authorization Server)            │
  │  loomi-mcp-alpha.bloomreach.com/mcp                │
  └───────────────────────────────────────────────────┘
```

---

## Structure pass — layers, axis, seams

**Layers.** Browser → Next route → BloomreachAuthProvider → MCP SDK's OAuth machinery → Bloomreach IdP.

**Axis: control flow.** Who's driving the OAuth state machine at each layer?

- Browser: the user is in control (they either approve or cancel in Bloomreach's UI).
- Next route: the app decides *when* to start the flow (401 from a tool call) and *how* to finish it (`/api/mcp/callback`).
- `BloomreachAuthProvider`: passive — it exposes read/write methods the SDK calls in whatever order the SDK wants.
- MCP SDK: drives the state machine (calls `state()` multiple times, calls `saveCodeVerifier`, calls `redirectToAuthorization`, throws `UnauthorizedError` for the caller to handle).
- Bloomreach IdP: owns the actual OAuth 2.1 protocol.

**Seams.**

1. **App ↔ SDK** — `BloomreachAuthProvider` implements `OAuthClientProvider`. The SDK doesn't know about your cookie store; the provider translates SDK calls into `patchState` / `readState` against the ALS-scoped store from file `01-encrypted-cookie-auth-store.md`.
2. **App ↔ IdP** — the redirect boundary. On the way out you carry `state`, `code_challenge`, `client_id`, `redirect_uri` in the URL. On the way back you get `code` + `state`. This is where CSRF/mixup attacks live in classical OAuth; PKCE + one-shot `state` are the defenses.

Hand off.

---

## How it works

### Move 1 — the mental model

You know how OAuth's classic problem is "how does an app that has no secret prove it's the one that started the flow?" (You can't ship a client secret in a public app — anyone can extract it.) PKCE is the answer: the app generates a random `code_verifier`, hashes it into a `code_challenge`, sends the *hash* to the IdP at start, and later reveals the *verifier* when exchanging the code for tokens. Only the app that held the verifier can complete the exchange.

DCR handles the other side: instead of the app owner registering with Bloomreach out of band and receiving a `client_id` to ship, the app POSTs its metadata (`client_name`, `redirect_uris`, `grant_types`) to the IdP's registration endpoint at first-run and gets a `client_id` back that it stores in the auth cookie.

The pattern's shape:

```
  OAuth 2.1 + PKCE + DCR — the pattern

  first tool call fails ──► 401
       │
       ▼
  ┌─────────────────────────────────┐
  │ generate code_verifier (random)  │
  │ code_challenge = SHA256(verifier)│
  │ state = randomUUID()             │
  │ POST /register → client_id       │  ← DCR happens on first ever run
  │ save (verifier, state, client)   │
  │ redirect user to authorize URL   │
  │ with client_id + challenge       │
  └────────────┬────────────────────┘
               │  user approves at Bloomreach
               ▼
  ┌─────────────────────────────────┐
  │ callback?code=X&state=Y          │
  │ POST /token with (code, verifier)│  ← verifier proves it's the same app
  │ receive access_token +           │
  │         refresh_token            │
  │ save tokens                      │
  └────────────┬────────────────────┘
               │
               ▼
        tool calls succeed
```

### Move 2 — walkthrough

**The provider skeleton.** `BloomreachAuthProvider` is a class of read/write methods with no logic of its own. The SDK calls them; each one is a patch against the ALS-scoped auth store keyed by `sessionId`.

**File:** `lib/mcp/auth.ts`
**Class:** `BloomreachAuthProvider`
**Line range:** 160-218

```ts
export class BloomreachAuthProvider implements OAuthClientProvider {
  constructor(private sessionId: string, private redirectUri: string) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'blooming insights',
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid profile email',
      token_endpoint_auth_method: 'none',  // ← public client
    };
  }

  state(): string { ... }              // one-shot CSRF token
  clientInformation() { ... }          // DCR-issued client_id
  saveClientInformation(info) { ... }  // persists it after DCR
  tokens() { ... }                     // reads current access/refresh
  saveTokens(t) { ... }                // persists new tokens
  saveCodeVerifier(v) { ... }          // PKCE
  codeVerifier() { ... }               // PKCE
  redirectToAuthorization(url) {       // capture, don't open browser
    this.lastAuthorizeUrl = url;
  }
}
```

Two trust-relevant details in the metadata:

- `token_endpoint_auth_method: 'none'` names this as a public client. There's no client secret; PKCE is the only proof.
- `redirect_uris: [this.redirectUri]` — the DCR request registers exactly one redirect URI. On preview deploys (different hostnames), `connectMcp` re-registers with the current host's URI (`connect.ts:36-57`) — DCR is called per-host on the fly.

**The redirect capture.** The SDK expects `redirectToAuthorization(url)` to actually open the browser. Server-side, you can't. So the provider records the URL and lets the SDK's `client.connect(transport)` throw `UnauthorizedError`. The caller (`connectMcp`) sees the throw, checks `provider.lastAuthorizeUrl`, and returns it to the route so the client can `window.location = authUrl`.

**File:** `lib/mcp/connect.ts`
**Function:** `connectMcpInner`
**Line range:** 71-112

```ts
try {
  await client.connect(transport);
  return { ok: true, mcp: new BloomreachDataSource(...) };
} catch (err) {
  if (provider.lastAuthorizeUrl) {
    return { ok: false, authUrl: provider.lastAuthorizeUrl.toString() };
  }
  throw err;
}
```

What breaks if you skip the `lastAuthorizeUrl` capture: the SDK throws opaquely and the client sees "Unauthorized" with no way to start the flow. What breaks if you catch broadly: real errors (network, DCR failure) get papered over as "please authorize" — the check `if (provider.lastAuthorizeUrl)` narrows the branch.

**The callback route.**

**File:** `app/api/mcp/callback/route.ts`
**Function:** `GET`
**Line range:** 4-34

```ts
export async function GET(req: NextRequest) {
  const oauthError = params.get('error');
  if (oauthError) return NextResponse.json({ error: oauthError, ... }, { status: 401 });

  const code = params.get('code');
  if (!code) return NextResponse.json({ error: 'missing code' }, { status: 400 });
  const sid = await readSessionId();
  if (!sid) return NextResponse.json({ error: 'no session' }, { status: 400 });

  // NOTE: we do NOT re-validate the OAuth `state` here. The MCP SDK invokes the
  // provider's state() more than once during a single auth() flow, so our naive
  // "store-last, compare-on-callback" check rejected legitimate callbacks
  // ("state mismatch"). The SDK performs its own state handling; re-validating
  // at this layer is redundant. (Verified live 2026-05-27.)

  try {
    await completeAuth(sid, code);
    return NextResponse.redirect(new URL('/', req.url));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 401 });
  }
}
```

The load-bearing decisions here:

1. **`state` is not re-validated at this layer.** The comment cites live-verification: the SDK calls `state()` multiple times, so a naive "store-last, compare-on-callback" fails legitimate flows. `consumeState` in `lib/mcp/auth.ts:230-235` exists and is tested but not wired — kept for a shared-store implementation later. The security question: does relying on the SDK's internal state handling leave a CSRF window? The answer depends on the SDK's implementation; the comment date (2026-05-27) is the receipt that this was verified against the live server behavior, not left as "we assumed the SDK does it."
2. **The `?error=` branch handles user-cancels + IdP failures cleanly.** IdPs return `error=access_denied` when the user says no; without this branch, the flow tries to exchange a missing `code` and returns a less-useful error.
3. **The session cookie is a hard prerequisite.** No `bi_session` = 400. The session is what keys the auth store; a callback with no session can't be attributed to anyone.

**Session cookie under cross-site return.**

**File:** `lib/mcp/session.ts`
**Line range:** 10-14

```ts
function sessionCookieOpts() {
  return process.env.NODE_ENV === 'production'
    ? { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/' }
    : { httpOnly: true, sameSite: 'lax' as const, path: '/' };
}
```

The trust assumption: `SameSite=None` is accepted because the OAuth return is a cross-site navigation (Bloomreach → your origin) and Lax would drop the cookie on some browsers. The cost is a widened CSRF surface. Mitigation: the POST endpoints on this app are read-only tool calls (`03-read-only-tool-allowlist.md`) or state-clear (`/api/mcp/reset`) — no state mutation Bloomreach-side.

**The token exchange.**

**File:** `lib/mcp/connect.ts`
**Function:** `completeAuth`
**Line range:** 119-127

```ts
export async function completeAuth(sessionId: string, code: string): Promise<void> {
  await withAuthCookies(async () => {
    const provider = new BloomreachAuthProvider(sessionId, await redirectUri());
    const transport = new StreamableHTTPClientTransport(mcpUrl(), { authProvider: provider });
    await transport.finishAuth(code);
  });
}
```

`transport.finishAuth(code)` is where the SDK POSTs to Bloomreach's `/token` endpoint with `grant_type=authorization_code`, `code`, `code_verifier` (read from the provider's `codeVerifier()`), and `client_id` (read from `clientInformation()`). The verifier and client_id are the pieces the ALS-scoped auth store held across the redirect. If either is missing at this moment, the exchange fails.

**Layers-and-hops for the full flow:**

```
  OAuth flow across three parties

  ┌─ Browser ──────────┐  hop 1: GET /api/briefing         ┌─ Next server ─────────┐
  │  React feed        │ ─────────────────────────────────► │  connectMcp(sid)      │
  │                    │  (bi_session + bi_auth cookies)   │  provider captures    │
  │                    │  hop 6: 401 { needsAuth, authUrl }│  authUrl (via SDK     │
  │                    │ ◄──────────────────────────────── │  UnauthorizedError)   │
  └──────────┬─────────┘                                    └───────────┬───────────┘
             │                                                          │
             │ hop 2: window.location = authUrl                        │
             ▼                                                          │
  ┌─ Bloomreach IdP ───┐  hop 3: user approves           ┌─ Bloomreach ▼──────────┐
  │  loomi-mcp-alpha   │ ◄──────────────────────────────►│  DCR: POST /register    │
  │                    │  hop 4: redirect back with code │  → client_id            │
  │                    │ ────────────────────────────────►│  (happens 1st time)    │
  └────────────────────┘                                   └────────────────────────┘
             │
             ▼
  ┌─ Next server ──────────────────────────────────────────────────────┐
  │  /api/mcp/callback?code=X                                            │
  │  completeAuth(sid, code)                                             │
  │  → transport.finishAuth(code)                                        │
  │    → POST /token { grant_type, code, code_verifier, client_id }      │
  │  → provider.saveTokens(t) → bi_auth cookie updated                   │
  │  hop 5: 302 → /                                                       │
  └────────────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

OAuth 2.1 + PKCE is the pattern any public client should use for third-party API access. The verifier is the proof-of-possession that replaces the client secret you can't ship. DCR is a nice-to-have that turns "the client_id ceremony" into a runtime detail — first-run POST for the registration, then it's just there. Combine the two and you can ship a public app that talks to any DCR-supporting IdP without a build-time secret.

What generalizes beyond this codebase: whenever you have a redirect-based OAuth flow that has to survive a cross-site navigation, the two things you need are (a) storage that survives the redirect and (b) proof-of-possession on the return. In blooming_insights, (a) is the encrypted cookie and (b) is the PKCE verifier saved to that cookie.

---

## Primary diagram — the full pattern

```
  OAuth 2.1 + PKCE + DCR — one full round-trip

  Step 0 — first-ever tool call, no tokens
  ────────────────────────────────────────
    Browser ──GET /api/briefing──► Server
                                    │
                                    │ connectMcp(sid)
                                    │ provider = new BloomreachAuthProvider
                                    │ transport.connect() throws UnauthorizedError
                                    │ provider.lastAuthorizeUrl captured
                                    │  (contains code_challenge, state, client_id)
                                    ▼
    Browser ◄──401 {needsAuth, authUrl}── Server

  Step 1 — user approves at IdP
  ─────────────────────────────
    Browser ──GET authUrl──► Bloomreach
                              │  user approves
                              ▼
    Browser ◄─302 /api/mcp/callback?code=X&state=Y── Bloomreach

  Step 2 — code exchange
  ──────────────────────
    Browser ──GET /callback?code=X── Server
                                       │
                                       │ withAuthCookies(async () => {
                                       │   provider = new BloomreachAuthProvider
                                       │   transport.finishAuth(X)
                                       │   → POST /token to Bloomreach:
                                       │     grant_type=authorization_code
                                       │     code=X
                                       │     code_verifier=(from cookie store)
                                       │     client_id=(from cookie store, DCR-issued)
                                       │ })
                                       │ ◄──access + refresh token── Bloomreach
                                       │ provider.saveTokens(t)
                                       │ ctx.dirty → bi_auth cookie updated
                                       ▼
    Browser ◄──302 /── Server

  Step 3 — subsequent tool calls
  ──────────────────────────────
    Browser ──GET /api/briefing── Server
                                   │
                                   │ connectMcp(sid)
                                   │ provider.tokens() ← from cookie
                                   │ transport calls Bloomreach with Bearer
                                   │ (server rate-limits + rotates tokens
                                   │  after minutes — see connect.ts:86-93)
                                   ▼
                              200 stream
```

---

## Elaborate

**Why "2.1"?** OAuth 2.1 is the draft that consolidates the "must-do" guidance from years of OAuth 2.0 errata: mandatory PKCE for public clients, no implicit flow, no resource-owner password credentials grant. If you're writing an OAuth client today, 2.1's rules are the ones to follow.

**Why DCR (RFC 7591)?** For a workshop-shaped tool where every user is running their own instance, requiring the developer to pre-register in a portal is friction. DCR lets the app self-register at runtime. The IdP has to support it (Bloomreach's loomi does); when it doesn't, you fall back to a pre-shared `client_id`.

**Token rotation notice.** `lib/mcp/connect.ts:86-93` comments that Bloomreach's alpha server "revokes tokens after minutes." The app's response is auto-reconnect on the UI side (`app/page.tsx`, per the context.md) — when a call returns `invalid_token`, the feed resets auth and reloads once. That's an availability defense, not a security one; the security assumption remains that a rotated token can no longer read the user's data.

**The `state` parameter, revisited.** Classical OAuth CSRF: an attacker starts a flow on their own device, gets the IdP to issue a `code`, then tricks the victim into completing it — the victim's session ends up linked to the attacker's tokens. `state` binds the request to a session-scoped one-shot value. Here, the SDK handles it internally. If you were writing this from scratch, you'd verify `state` at `/callback` and reject on mismatch; you'd also generate the verifier + state atomically. The commented-out `consumeState` (`auth.ts:230-235`) shows the intended shape.

**What to read next in this repo:** `01-encrypted-cookie-auth-store.md` — where the verifier + client_info + tokens actually live; `06-log-secret-redaction.md` — the log-side defense against leaking any of the tokens this flow acquires.

---

## Interview defense

### Q: "Walk me through what PKCE protects against, specifically."

**Answer:** The authorization code interception attack against a public client. Classic OAuth 2.0 flow: your app opens a browser, the user authenticates, the IdP redirects back with `?code=X`. If an attacker intercepts that redirect — malicious app registered for the same URL scheme on mobile, malicious browser extension, MITM on a non-TLS network — they now have `code=X`. Without PKCE they can exchange it for tokens using the app's `client_id`, which is public.

PKCE fixes it: the app generates `code_verifier` (128 bits, random), hashes it to `code_challenge`, sends the *challenge* on the way out and the *verifier* on the way back. The IdP won't issue tokens without a verifier that hashes to the recorded challenge. The attacker with only the `code` can't complete the exchange.

**Diagram:**

```
  Without PKCE                     With PKCE
  ──────────                       ─────────
  authorize?client_id=X            authorize?client_id=X
                                              &code_challenge=SHA256(v)
  → code                           → code
  token(code, client_id) → tokens  token(code, client_id, verifier=v) → tokens
                                        └─ IdP checks SHA256(v) matches
                                           the recorded challenge
```

**Anchor:** `lib/mcp/auth.ts:209-217` — the provider methods that save + read the verifier across the redirect.

### Q: "Why does the callback not re-validate `state`?"

**Answer:** Because the MCP SDK calls `state()` more than once per flow (see `lib/mcp/auth.ts:229` comment) — the naive "store the last one, compare on callback" pattern rejects legitimate returns. The comment names this and dates the verification: 2026-05-27. So the SDK's own state handling is trusted at this layer. `consumeState` is written and tested (`auth.ts:230-235`) for a future shared-store implementation that can track all issued states.

The honest interview answer: this is a delegation, not a "we skipped state." The right follow-up: "and if you were building this without the SDK, you'd own state yourself." Yes.

**Anchor:** `app/api/mcp/callback/route.ts:22-27` — the comment naming the SDK's multi-call behavior.

### Q: "What's the load-bearing part of DCR here?"

**Answer:** The `redirect_uris: [this.redirectUri]` in `clientMetadata`. That's the value the IdP records against your `client_id`; a code exchange with any other `redirect_uri` fails. Without DCR you'd have to pre-register every hostname (production, preview, per-branch deploy) with Bloomreach out of band. With DCR you register per-host at connect-time (`lib/mcp/connect.ts:36-57`), which is why preview deployments work without ceremony.

**Anchor:** `lib/mcp/auth.ts:172-181` (the metadata) + `lib/mcp/connect.ts:36-57` (per-host redirect URI derivation).

---

## See also

- `01-encrypted-cookie-auth-store.md` — where the tokens, verifier, and client info actually live
- `03-read-only-tool-allowlist.md` — the tool-scope gate that runs after auth succeeds
- `06-log-secret-redaction.md` — the defense against these tokens leaking into logs
- `audit.md` § 2 (authentication and authorization) — the lens finding
