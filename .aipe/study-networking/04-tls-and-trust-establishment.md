# 04 — TLS and trust establishment

## Subtitle

Encryption in transit and where it terminates (Language-agnostic — the certificate story for each of the three hops).

## Zoom out, then zoom in

TLS is unremarkable in this codebase in the good way — every hop is HTTPS, no custom certificate pinning, no `NODE_TLS_REJECT_UNAUTHORIZED=0` anywhere, no local TLS termination inside the app. The interesting part is **where each hop terminates**, because that determines who can read what. The inbound TLS terminates at Vercel's edge (not the function). The outbound TLS is originated by the function and terminates at the upstream. Three hops, three terminations, three different certificate stories.

```
  Zoom out — where TLS terminates on each hop

  ┌─ UI (browser) ─────────────────────────────────────────────┐
  │  fetch() over HTTPS                                        │
  │  browser validates cert against Vercel's edge              │
  └────────────────────────┬───────────────────────────────────┘
                           │ hop 1 · TLS 1.2/1.3
                           │ cert served: Vercel edge (LetsEncrypt/etc)
                           ▼
  ┌─ Edge (Vercel) ────────────────────────────────────────────┐
  │  ★ INBOUND TLS TERMINATES HERE ★                            │
  │  edge → function is plaintext HTTP within Vercel's network │
  │  inserts x-forwarded-proto: 'https'                        │
  └────────────────────────┬───────────────────────────────────┘
                           │ plaintext HTTP inside Vercel infra
                           ▼
  ┌─ Service (route function) ─────────────────────────────────┐
  │  originates two outbound TLS sessions                      │
  └──────────┬──────────────────────────────┬──────────────────┘
             │ hop 2 · TLS to MCP           │ hop 3 · TLS to Anthropic
             │ cert: bloomreach or override │ cert: Anthropic
             ▼                              ▼
  ┌─ MCP server ────────────────┐  ┌─ Anthropic API ────────┐
  │  MCP-side TLS termination   │  │  Anthropic termination │
  └─────────────────────────────┘  └────────────────────────┘
```

Zoom in — this file walks each termination point, names the certificate authority story (implicit, standard), and shows where the code observes the fact of TLS termination (mostly through `x-forwarded-proto`).

## Structure pass

**Layers:**
- Browser (validates server cert)
- Vercel edge (terminates inbound TLS)
- Route function (originates outbound TLS)
- Upstream (validates route's client cert — usually none — and terminates its inbound TLS)

**Axis — TRUST (who can read the bytes?):**

```
  "who can read the plaintext on this hop?" — traced

  hop 1 (browser → edge)   → browser + Vercel edge
                             (inbound TLS terminates at edge)
      seam #1: edge→function is plaintext HTTP INSIDE Vercel
  edge → function          → Vercel infrastructure
                             (route sees plaintext HTTP; trusts edge
                              to have validated the client)
      seam #2: outbound TLS originated at function
  hop 2 (function → MCP)   → function + MCP server
                             (mutual: no client cert; auth
                              via bearer token in header)
  hop 3 (function → Anth)  → function + Anthropic
                             (same: no client cert; API key in header)

  bytes are plaintext at exactly one boundary per hop —
  the boundary where trust flips from "on the network" to
  "on the server"
```

**Seams:**
- Seam #1 — the Vercel edge terminates inbound TLS. Everything past that point (edge → function → back) is Vercel's internal HTTP network.
- Seam #2 — the outbound sockets originate fresh TLS from the function. New cert validation, new session key.

## How it works

### Move 1 — the mental model

TLS is a lock on a courier's briefcase. Three couriers on this route (browser → edge, edge → function, function → upstream), but only two of the three legs use the lock — the middle leg is inside Vercel's trusted network. Same for the outbound leg to Bloomreach: browser doesn't lock its handoff to the edge on that leg because the browser isn't on that leg.

The picture: **TLS terminates every time trust changes hands.** Where trust doesn't change hands (edge → function, both Vercel), no TLS.

```
  TLS terminations across the wire

  browser  ──TLS──►  Vercel edge  ──plaintext (Vercel LAN)──►  function
     ▲                    ▲                                       │
     │                    │                                       │
     └── validates ──────┘                                        │
         edge cert                                                │
                                                                  │
                                    ┌─────────────────────────────┘
                                    │
                        function  ──TLS──►  MCP server
                                    │
                                    └──TLS──►  Anthropic API

  each ──TLS──► is a fresh handshake, fresh session key,
  fresh cert validation on the client side
```

### Move 2 — the walkthrough

#### Hop 1 (browser → edge) — inbound TLS terminates at Vercel

The browser opens an HTTPS connection to the deploy hostname (e.g. `blooming-insights.vercel.app`). Vercel's edge presents its certificate for that hostname; the browser validates against its trust store. Standard behavior for every Vercel deployment.

Where the code observes this: **through `x-forwarded-proto`.** The Vercel edge inserts that header when it hands the request off to the function. The function's redirect-URI derivation uses it in `lib/mcp/connect.ts:62`:

```ts
const proto = h.get('x-forwarded-proto') ?? 'https';
return `${proto}://${host}/api/mcp/callback`;
```

The route trusts `x-forwarded-proto` because the header can't be set by the client — Vercel's edge strips any inbound `x-forwarded-*` and inserts its own. This is what makes `x-forwarded-*` trustworthy on Vercel; on a bring-your-own reverse proxy, you'd need to configure it not to trust incoming forwarded headers.

The cookie flags in `lib/mcp/auth.ts:97-99` and `lib/mcp/session.ts:10-13` require `Secure`:

```ts
// lib/mcp/session.ts
return process.env.NODE_ENV === 'production'
  ? { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/' }
  : { httpOnly: true, sameSite: 'lax' as const, path: '/' };
```

`Secure` means the browser won't send this cookie over a non-HTTPS connection. Since inbound TLS terminates at the edge, the cookie IS transmitted over HTTPS end-to-end from the browser's perspective — even if edge-to-function is plaintext, that hop is inside Vercel's infrastructure and doesn't concern the browser's `Secure` semantics.

#### Hop 2 (route → MCP) — outbound TLS to Bloomreach or an arbitrary MCP server

The route's `StreamableHTTPClientTransport` opens an HTTPS connection to the resolved MCP URL. `undici` performs the TLS handshake using Node's default trust store (which includes the system CA bundle and Mozilla's baked-in roots). No cert pinning, no custom trust anchors — if Bloomreach rotates its cert, no code change needed as long as the new cert chains up to a public CA.

The MCP URL is HTTPS by construction of the precedence chain: the hardcoded default is `https://loomi-mcp-alpha.bloomreach.com/mcp/`, and the type of `override.url` is `string` (validated by `isMcpConfigOverride` in `lib/mcp/config.ts:50-60`). Nothing enforces "HTTPS only" — a user could set `MCP_URL=http://localhost:8080/mcp/` in a dev environment. That's intentional: local dev against an unencrypted MCP server should be possible. In production, the deployed hostnames all resolve to HTTPS.

Where the auth material rides this hop: **`Authorization: Bearer <token>`**, in the encrypted TLS session. The bearer token (either an OAuth access token from the `BloomreachAuthProvider` or a static token from `BearerAuthProvider`) is only ever transmitted over TLS. From `lib/mcp/auth-providers/bearer.ts:59-67`:

```ts
tokens(): OAuthTokens | undefined {
  // Return a minimal-shape OAuthTokens with just the access_token; the
  // SDK reads this and sends `Authorization: Bearer <access_token>`.
  return {
    access_token: this.token,
    token_type: 'Bearer',
  };
}
```

The SDK reads `tokens()`, formats an `Authorization: Bearer <token>` header, and includes it in every request. TLS guarantees that header doesn't leak in transit.

#### Hop 3 (route → Anthropic) — outbound TLS to `api.anthropic.com`

The Anthropic SDK opens HTTPS to `https://api.anthropic.com` (default; overridable via `ANTHROPIC_BASE_URL` env, unused here). Same story as hop 2 — public CA chain, no pinning, no custom trust. The auth material on this hop is `x-api-key: <ANTHROPIC_API_KEY>`, transmitted inside the TLS session.

The Anthropic SDK handles this internally (`lib/agents/aptkit-adapters.ts:92`):

```ts
const response = await this.anthropic.messages.create(
  params,
  request.signal ? { signal: request.signal } : undefined,
);
```

Nothing about the TLS configuration is customized in the SDK constructor:

```ts
// app/api/agent/route.ts:249
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

Defaults on everything — that's the point. TLS-in-transit for the API key is guaranteed by the SDK's HTTPS transport.

#### The OAuth callback — TLS across two organizations

The one hop that's worth naming separately: the browser's redirect to Bloomreach's IdP, and Bloomreach's redirect back to the app's `/api/mcp/callback`. Both legs are HTTPS. The auth code that Bloomreach sends back (in the query string) is TLS-protected on the browser → app leg. From `app/api/mcp/callback/route.ts:17-18`:

```ts
const code = params.get('code');
if (!code) return NextResponse.json({ error: 'missing code' }, { status: 400 });
```

The `code` param rides in the URL — TLS-protected only as long as the URL doesn't get logged anywhere unencrypted. This is a general OAuth concern; the code has a short lifetime (Bloomreach's server invalidates it once exchanged) so leaking a used code is harmless. Leaking a fresh one is a security issue, which is why URLs with auth codes shouldn't be logged.

#### Cookie encryption — a second layer inside TLS

The `bi_auth` cookie is AES-256-GCM encrypted at the app layer (not just TLS-protected in transit). From `lib/mcp/auth.ts:62-79`:

```ts
function encryptStore(store: Store): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}
```

Why encrypt if TLS is already protecting the transport? Because the cookie is stored **at rest** on the browser's disk. TLS protects the wire; app-layer encryption protects the stored blob. If a malicious browser extension read the cookie file, or a browser bug leaked it, the encrypted blob is useless without `AUTH_SECRET`. That's defense in depth — TLS for transit, AES-GCM for storage.

The key comes from `lib/mcp/auth.ts:51-60`:

```ts
function aesKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is required in production to encrypt the auth cookie. ' +
        'Set it in your Vercel project environment variables.',
    );
  }
  return createHash('sha256').update(secret).digest(); // 32 bytes → AES-256
}
```

SHA-256(env secret) → 32-byte key. Missing `AUTH_SECRET` in production throws hard (fail-loud, not silent). This isn't part of the TLS story per se, but it's the second lock on the same briefcase.

### Move 3 — the principle

**Terminate TLS where trust changes hands, not everywhere.** The Vercel edge → function hop is plaintext because both endpoints are inside Vercel's trust boundary; adding TLS there would be theater. The browser → edge and function → upstream hops cross trust boundaries, so both use TLS. Where the app stores something sensitive at rest (the `bi_auth` cookie), it adds an application-layer encryption on top — because at-rest and in-transit are different threat models with different mitigations.

## Primary diagram

```
  TLS map — where each session lives and terminates

  ┌─ Browser ──────────────────────────────────────────────────┐
  │  fetch('https://<deploy>.vercel.app/api/briefing', ...)    │
  │  cookies: bi_session + bi_auth (both Secure)               │
  └────────────────────────┬───────────────────────────────────┘
                           │
                     ▼══════════════▼   ← TLS session A
                     ║ TLS 1.2/1.3  ║     browser validates
                     ║ ALPN: h2/h1  ║     Vercel's cert
                     ▼══════════════▼
  ┌─ Vercel edge ──────────────────────────────────────────────┐
  │  TLS A TERMINATES                                          │
  │  → HTTP over Vercel LAN, x-forwarded-proto: https          │
  └────────────────────────┬───────────────────────────────────┘
                           │ plaintext (internal)
                           ▼
  ┌─ Route function ───────────────────────────────────────────┐
  │  // originate two independent TLS sessions                 │
  │                                                            │
  │  cookies decrypted server-side:                            │
  │    bi_auth → AES-256-GCM(key=SHA256(AUTH_SECRET))          │
  │             → { clientInformation, tokens, codeVerifier }  │
  │                                                            │
  │  reads Authorization: Bearer <token> from bi_auth's tokens │
  │  reads x-api-key from process.env.ANTHROPIC_API_KEY        │
  └──────────┬──────────────────────────────┬──────────────────┘
             │                              │
       ▼══════════════▼               ▼══════════════▼
       ║ TLS session B ║               ║ TLS session C║
       ║ SDK: undici   ║               ║ SDK: Anthropic║
       ║ cert: MCP host║               ║ cert: Anthropic║
       ▼══════════════▼               ▼══════════════▼
             │                              │
             ▼                              ▼
   ┌─ MCP server ──────────┐        ┌─ Anthropic API ───┐
   │  Authorization:       │        │  x-api-key:       │
   │    Bearer <token>     │        │    <key>          │
   │  (inside TLS B)       │        │  (inside TLS C)   │
   └───────────────────────┘        └───────────────────┘

  three TLS sessions, three different cert stories,
  all validated against public CA chains, no pinning
```

## Elaborate

**Why not pin certificates.** Cert pinning trades operational flexibility for a narrow security gain (defending against a compromised CA that mis-issues a cert for the pinned host). For an app talking to two SaaS APIs (Bloomreach + Anthropic) plus one that ships to production on Vercel, the ops cost of pinning — every cert rotation needs a code deploy — outweighs the benefit. Neither Anthropic nor Bloomreach's alpha server publishes a pinning policy; the code correctly doesn't try to invent one.

**The at-rest vs in-transit distinction.** TLS is a wire-level guarantee: no one on the network reads the bytes. AES-GCM on the `bi_auth` cookie is a storage-level guarantee: no one with the encrypted blob reads its contents. Different threat models, different mitigations. The code layers them because OAuth tokens (10-day lifetime) are worth protecting in both dimensions.

**`AUTH_SECRET` rotation.** Rotating the secret invalidates every existing `bi_auth` cookie (the decrypt fails, `decryptStore` catches and returns `{}`, which the app treats as "no auth" — user re-authenticates). That's the intended failure mode; graceful downgrade to a fresh OAuth flow.

**What's not exercised.** mTLS (client cert auth to upstreams — Bloomreach uses bearer tokens instead). TLS 1.0/1.1 (deprecated, not supported by any of the involved endpoints). Certificate transparency monitoring (would require ops tooling outside this repo). Post-quantum crypto (not in scope for any of the involved SDKs yet).

**`ANTHROPIC_BASE_URL` for on-prem.** The Anthropic SDK supports pointing at a custom base URL via the `ANTHROPIC_BASE_URL` env or the constructor's `baseURL` option. Unused here — the app talks to the real API. If it needed to talk to a corporate proxy that mediates Anthropic access, this is the knob; the TLS story would then depend on that proxy's cert.

## Interview defense

**Q: Where does TLS terminate in this app?**

Three terminations, one per hop:

```
  browser ─TLS A─► Vercel edge (TERMINATES)   ─plaintext─► function
  function ─TLS B─► MCP server (TERMINATES at server)
  function ─TLS C─► Anthropic (TERMINATES at server)
```

Inbound: at Vercel's edge. Everything past that point (edge → function) is Vercel's internal HTTP network — TLS would be theater there. The function trusts `x-forwarded-proto: https` to know the original leg was HTTPS.

Outbound: at each upstream. The route originates fresh TLS to Bloomreach and Anthropic independently. Each hop pays a handshake unless `undici` pooled a warm connection.

**Q: Why is the `bi_auth` cookie AES-encrypted if TLS already protects it in transit?**

Different threat model. TLS covers the wire — no one on the network reads it. AES-GCM covers the cookie at rest in the browser's storage — no one who can read the file (malicious extension, bug, backup) reads its contents. In-transit encryption doesn't protect at-rest storage; you need both.

The key is `SHA-256(process.env.AUTH_SECRET)` — 32 bytes for AES-256. If `AUTH_SECRET` is missing in production, the app throws hard rather than silently downgrading. Rotating the secret invalidates every existing cookie, which forces re-auth — that's the intended graceful downgrade path.

Anchor: `lib/mcp/auth.ts:51-79`.

**Q: What would break if you added HTTP-only (non-HTTPS) support for the MCP URL?**

Nothing enforced by the code — `mcpUrl()` accepts any URL string. Locally against a dev MCP server, `http://localhost:8080/mcp/` works fine. In production it would break the bearer token's transit security: the `Authorization: Bearer <token>` header would ride plaintext to the MCP origin, readable by anyone on the network path.

The right level to enforce HTTPS-only isn't the URL validator (dev use case is legitimate) — it's the deployment convention. Production `MCP_URL` values should be HTTPS; a lint/audit could check that, but the code correctly stays flexible.

Anchor: `lib/mcp/connect.ts:38-48` (URL not validated for scheme).

## See also

- `05-http-semantics-caching-and-cors.md` — the cookie flags (`Secure`, `SameSite`) that ride the TLS story
- `01-network-map.md` — where TLS terminations sit in the topology
- `study-security` — the same trust boundaries seen from "is this safe?" rather than "what's on the wire?"
