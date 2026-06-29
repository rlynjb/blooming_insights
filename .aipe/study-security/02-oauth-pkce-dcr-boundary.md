# OAuth 2.1 + PKCE + DCR boundary

**Authorization Code with Proof Key for Code Exchange + Dynamic Client Registration** (Industry standard).

## Zoom out — where this concept lives

This is the only authentication the app does. There's no username/password, no app-side user model — the Bloomreach IdP is the authority. PKCE binds the auth code to this session; DCR registers the client per-deployment without manual operator setup.

```
  Zoom out — auth boundary in the request path

  ┌─ Browser ────────────────────────────────────────────┐
  │  React UI                                             │
  └──────────────┬────────────────────────────────────────┘
                 │ hop 1: GET /api/briefing
                 ▼
  ┌─ Next.js routes ─────────────────────────────────────┐
  │  connectMcp(sid) ──► no token? authorize URL ──┐      │
  │                                                ▼      │ ← we are here
  │                            { needsAuth, authUrl }     │
  └──────────────┬────────────────────────────────────────┘
                 │ HTTP 401 → client redirect
                 ▼
  ┌─ Bloomreach IdP (loomi connect) ─────────────────────┐
  │  user approves; redirect back with code               │
  └──────────────┬────────────────────────────────────────┘
                 │ GET /api/mcp/callback?code=...
                 ▼
  ┌─ Next.js routes ─────────────────────────────────────┐
  │  completeAuth(sid, code) → exchanges for tokens       │
  │                          → saves into bi_auth cookie  │
  └───────────────────────────────────────────────────────┘
```

## Structure pass

**Axes:** trust (the IdP is the authority, the app holds delegated bearer tokens), control (the SDK drives the protocol; the app implements `OAuthClientProvider`), failure (the SDK throws after `redirectToAuthorization` is called; the route turns that throw into a redirect URL).

**Layers (outer → inner):**
- Browser layer — the redirect happens here.
- Route layer — `connectMcp` / `completeAuth` orchestrate.
- Provider layer — `BloomreachAuthProvider` implements the SDK's contract.
- Storage layer — the encrypted cookie / dev file persists per-session OAuth state.

**Seam:** the `OAuthClientProvider` interface from `@modelcontextprotocol/sdk` is the load-bearing seam. The SDK owns the protocol (issues `state`, computes PKCE, exchanges the code); the provider owns persistence (where do `tokens`, `code_verifier`, `client_information` live?). The split keeps protocol bugs out of storage code and storage bugs out of protocol code.

## How it works

### Move 1 — the mental model

OAuth Authorization Code with PKCE is **"prove you're the same client that started the flow"** — the client commits to a high-entropy secret (`code_verifier`) at request time, sends only its hash (`code_challenge`) to the IdP, and reveals the verifier when exchanging the code for tokens. The IdP confirms the hash matches. An attacker who intercepts the redirect (and the `code`) can't exchange it without the verifier.

```
  Pattern — PKCE bind

  client:                            IdP:
  ────────                           ────
  pick code_verifier (random)
  code_challenge = SHA256(verifier)
  ─── /authorize?challenge=H ──────► remember H against this auth request
                                     issue code
  ◄─── redirect_uri?code=... ──────
  ─── /token?code=...&verifier=v ──► check SHA256(v) == H ?
                                     if yes, issue tokens
  ◄─── access_token, refresh_token ─
```

DCR is the prequel: rather than the operator pre-registering a client_id with the IdP, the client *registers itself* on first contact. RFC 7591 — the IdP exposes a registration endpoint, the client POSTs metadata, gets back a client_id (and optionally client_secret; we're public-client so the auth method is `none`).

### Move 2 — the step-by-step walkthrough

#### Bootstrap allowlist (`BOOTSTRAP_TOOLS`) — protocol-side analogue

Before any OAuth flow runs, the user hits a route. The route calls `getOrCreateSessionId` to mint a `bi_session` cookie, then `connectMcp(sid)`, which constructs a fresh `BloomreachAuthProvider` bound to that session:

```ts
// lib/mcp/connect.ts:71-80
async function connectMcpInner(sessionId: string): Promise<ConnectResult> {
  const provider = new BloomreachAuthProvider(sessionId, await redirectUri());
  const httpErrors: HttpErrorHolder = { last: null };
  const transport = new StreamableHTTPClientTransport(mcpUrl(), {
    authProvider: provider,
    fetch: makeCapturingFetch(httpErrors),
  });
  const client = new Client(
    { name: 'blooming-insights', version: '0.1.0' },
    { capabilities: {} },
  );
  ...
}
```

The provider's `clientMetadata` is what DCR POSTs to the IdP if there's no `clientInformation` stored yet:

```ts
// lib/mcp/auth.ts:172-181
get clientMetadata(): OAuthClientMetadata {
  return {
    client_name: 'blooming insights',
    redirect_uris: [this.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'openid profile email',
    token_endpoint_auth_method: 'none',  // public client; PKCE is the proof
  };
}
```

`token_endpoint_auth_method: 'none'` is the public-client declaration. There's no client secret. The PKCE verifier is the only thing the client knows that the IdP needs to see at token-exchange time.

#### Per-host redirect URI (`redirectUri`)

The redirect URI is derived from the actual request host so each Vercel preview deployment works without re-registering:

```ts
// lib/mcp/connect.ts:36-57
async function redirectUri(): Promise<string> {
  if (process.env.NODE_ENV === 'production') {
    try {
      const { headers } = await import('next/headers');
      const h = await headers();
      const host = h.get('x-forwarded-host') ?? h.get('host');
      if (host) {
        const proto = h.get('x-forwarded-proto') ?? 'https';
        return `${proto}://${host}/api/mcp/callback`;
      }
    } catch {
      /* not in a request scope — fall through to APP_ORIGIN */
    }
  }
  return `${process.env.APP_ORIGIN ?? 'http://localhost:3000'}/api/mcp/callback`;
}
```

DCR registers each host's redirect URI on the fly — without this, opening a per-deploy URL while the callback went to `APP_ORIGIN` would drop the session cookie ("no session"). The trust assumption: `x-forwarded-host` comes from a trusted reverse proxy (Vercel's edge). If an attacker can spoof it (e.g. via a misconfigured proxy), they redirect the auth code to an attacker-controlled host. **Verify this header is set only by Vercel's edge** — relying on it untrustingly is the classic "Host header injection" footgun.

#### PKCE — `saveCodeVerifier` / `codeVerifier`

The SDK generates the verifier; the provider just stores it:

```ts
// lib/mcp/auth.ts:209-217
saveCodeVerifier(v: string): void {
  patchState(this.sessionId, { codeVerifier: v });
}

codeVerifier(): string {
  const v = readState(this.sessionId).codeVerifier;
  if (!v) throw new Error('no PKCE code_verifier stored for this session');
  return v;
}
```

The verifier crosses the connect-to-callback gap by riding in the encrypted cookie store (production) or the dev file (development). The session ID indexes which entry to read.

**What breaks if the verifier doesn't survive connect-to-callback:** the SDK's token exchange POSTs the code without a valid verifier, the IdP rejects with `invalid_grant`, and `completeAuth` throws. The user sees a re-auth loop until the cookie path is fixed. This was a real bug pre-cookie design — when the store was in-memory and `connect` / `callback` landed on different Vercel instances. The cookie store is the fix.

#### CSRF — `state` (designed but not wired)

The SDK calls `state()` to mint the OAuth `state` parameter. The provider stores it:

```ts
// lib/mcp/auth.ts:183-187
state(): string {
  const v = crypto.randomUUID();
  patchState(this.sessionId, { state: v });
  return v;
}
```

A consumer is exported and tested:

```ts
// lib/mcp/auth.ts:225-235
export function consumeState(sessionId: string, state: string | null): boolean {
  const stored = readState(sessionId).state;
  if (stored !== undefined) patchState(sessionId, { state: undefined });
  if (!stored) return true;
  return stored === state;
}
```

**But it isn't wired into the callback:**

```ts
// app/api/mcp/callback/route.ts:22-26
// NOTE: we do NOT re-validate the OAuth `state` here. The MCP SDK invokes the
// provider's state() more than once during a single auth() flow, so our naive
// "store-last, compare-on-callback" check rejected legitimate callbacks
// ("state mismatch"). The SDK performs its own state handling; re-validating
// at this layer is redundant. (Verified live 2026-05-27.)
```

The honest tension: "store-last, compare-on-callback" did fail because `state()` gets called more than once and the second call overwrites the first. The fix is to make `state()` *idempotent within a flow* — generate once, return the same value on subsequent calls within the same auth() flow, then consume-and-clear on callback. That's not what's currently implemented; the current implementation overwrites on every call. The result: the recheck couldn't work, was removed, and the wired-in CSRF defence at this layer was lost. The SDK does send a state param on `/authorize` and verifies it on its side, but the application-layer recheck is gone. **Net: CSRF login fixation is the live exposure.**

See `audit.md` § 8 row 10 and `00-overview.md` finding #3.

#### Token exchange (`completeAuth`)

```ts
// lib/mcp/connect.ts:119-127
export async function completeAuth(sessionId: string, code: string): Promise<void> {
  await withAuthCookies(async () => {
    const provider = new BloomreachAuthProvider(sessionId, await redirectUri());
    const transport = new StreamableHTTPClientTransport(mcpUrl(), {
      authProvider: provider,
    });
    await transport.finishAuth(code);
  });
}
```

`finishAuth(code)` is the SDK's name for the token-exchange step. It reads the verifier via `provider.codeVerifier()`, POSTs `{code, code_verifier}` to the IdP's token endpoint, and on success calls `provider.saveTokens(tokens)`. The whole exchange runs inside `withAuthCookies`, so the saved tokens land in the per-request ALS store and flush to the encrypted cookie on response.

#### Capture-and-surface — `redirectToAuthorization`

The SDK normally opens a browser for the authorize URL. Server-side that's no good — instead, the provider captures it:

```ts
// lib/mcp/auth.ts:205-207
redirectToAuthorization(url: URL): void {
  this.lastAuthorizeUrl = url;
}
```

And `connectMcp` reads it after the SDK throws:

```ts
// lib/mcp/connect.ts:103-111
} catch (err) {
  // The SDK throws (UnauthorizedError) after calling redirectToAuthorization when
  // no valid token exists. If we captured an authorize URL, surface it for the
  // browser instead of bubbling the error.
  if (provider.lastAuthorizeUrl) {
    return { ok: false, authUrl: provider.lastAuthorizeUrl.toString() };
  }
  throw err;
}
```

That URL becomes the `{ needsAuth: true, authUrl }` JSON the routes return on 401; the client navigates the browser to it.

### Move 3 — the principle

**Bind the auth code to the client that started the flow.** PKCE is the answer to "what if someone intercepts the redirect?" — without the verifier, the intercepted code is unusable. DCR is the answer to "what if I want every preview deployment to work without manual IdP setup?" — register on first contact. The deeper principle: when the protocol can do the work, let the protocol do the work. The SDK owns PKCE/DCR mechanics; the provider only owns persistence. Putting protocol logic in the provider is the path to bugs that look like security holes.

## Primary diagram

```
  Full OAuth round trip — connect → IdP → callback → token exchange

  ┌─ Browser ──────────────────────────────────────────────────┐
  │                                                             │
  │  bi_session=<uuid>                                          │
  └─────┬────────────────────────────────────┬──────────────────┘
        │ (1) GET /api/briefing             │ (4) GET /api/mcp/callback?code=...
        ▼                                    ▼
  ┌─ Next routes (per-host redirect URI) ──────────────────────┐
  │  connectMcp(sid)                  completeAuth(sid, code)   │
  │     │                                  │                    │
  │     ▼                                  ▼                    │
  │  Provider (sessionId)             Provider (sessionId)     │
  │     │                                  │                    │
  │     ▼ SDK.connect throws after         ▼ SDK.finishAuth     │
  │       redirectToAuthorization            posts to /token    │
  │     │                                  │                    │
  │     ▼ return {needsAuth, authUrl}     ▼ saveTokens()        │
  │                                        ▼ redirect /         │
  └─────┬──────────────────────────────────┬───────────────────┘
        │ (2) HTTP 302 to IdP             │ (5) HTTP 302 to /
        ▼                                    ▼
  ┌─ Bloomreach IdP ───────────────────────────────────────────┐
  │  (3) user approves                                          │
  │      redirect Cookie: bi_session — back to /api/mcp/callback│
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern is **OAuth 2.1 Authorization Code with PKCE** (RFC 6749 + 7636), with **Dynamic Client Registration** (RFC 7591) added on top. OAuth 2.1 is the consolidated profile that requires PKCE for all clients (public and confidential) and prohibits the implicit / resource-owner-password grants — the IETF's "use these flows, drop those" cleanup. The MCP spec (Model Context Protocol from Anthropic) builds on it as the auth model for connecting agents to servers.

The historical bug this design fights: pre-cookie, the auth store was in-memory. Vercel ephemeral functions meant the verifier saved during `connect` was gone by the time `callback` ran on a different instance. The cookie store solves that without taking on KV/Redis. The deeper architectural choice: the cookie itself IS the session — no centralized store, no replication, no stickiness needed.

**Related industry concepts:**
- RFC 7636 (PKCE) — the verifier/challenge spec.
- RFC 7591 (Dynamic Client Registration) — the metadata POST.
- OAuth 2.1 draft — the consolidated profile.
- OpenID Connect — the `openid profile email` scope rides on top.

**Related files in this guide:**
- `01-encrypted-auth-cookie.md` — where the persisted state actually lives.
- `06-session-isolation.md` — how `bi_session` keys the per-session store.

## Interview defense

**Q: Why PKCE if you also have a session cookie?**
**A:** Different threats. The session cookie protects the *application session*; PKCE protects the *OAuth code* from being used by anyone other than the client that initiated the flow. Without PKCE, an attacker who intercepted the redirect (or a malicious browser extension that read the `?code=` URL) could exchange it for tokens. With PKCE, the code is useless without the verifier — which is in the encrypted cookie, which is httpOnly. The two cooperate; they don't substitute.

```
  cookie: protects app session
  PKCE:   protects the auth code itself
```

**Q: What's the load-bearing part of PKCE people forget?**
**A:** That the verifier MUST stay secret on the client side until token exchange. In a SPA that means localStorage / sessionStorage are wrong — they're reachable from JS. In a server-side flow like this one, the encrypted httpOnly cookie is the right place — the browser can't read it, the server can. The challenge (the hash) is fine to send on the wire; the verifier is the secret that proves "I'm the one who sent the challenge."

**Q: Why Dynamic Client Registration instead of pre-registering?**
**A:** Vercel previews. Every PR gets a new URL; pre-registering would mean either (a) registering every preview URL manually or (b) running every preview against the production client_id and accepting the redirect_uri mismatch. DCR lets each deployment register its own redirect URI on first contact. Cost: one extra round-trip on first auth per deployment. Benefit: zero manual setup per environment.

**Q: What's wrong with the `state` check today?**
**A:** It's not wired. The helper `consumeState` exists; the callback doesn't call it. The original wiring failed because the SDK calls `provider.state()` more than once per flow and the naive "store-last" overwrite broke equality. The right fix is to make `state()` idempotent within a flow (return the same value on second call inside the same auth attempt), then consume-and-clear at the callback. Today, the application-layer CSRF check on the OAuth return is missing — the SDK does its own state handling on its side, but the app layer is gone. CSRF login fixation is the live consequence.

## See also

- `01-encrypted-auth-cookie.md` — the cookie that stores the verifier, the tokens, the DCR client info.
- `06-session-isolation.md` — `bi_session` as the per-user index into the auth store.
- `audit.md` § 2 (Authentication and authorization).
- `lib/mcp/auth.ts:160-218` — the provider implementation.
- `lib/mcp/connect.ts:64-127` — the connect / completeAuth orchestration.
- `app/api/mcp/callback/route.ts` — the callback handler.
