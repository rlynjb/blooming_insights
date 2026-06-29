# TLS and trust establishment

**Encryption in transit, certificates, and where TLS terminates** · Industry standard

## Zoom out — where this concept lives

TLS sits between TCP (the byte stream) and HTTP (the protocol semantics). Every wire in this app is HTTPS, which means TLS wraps every byte that leaves the Service band — and every byte that enters it from the browser.

```
  Zoom out — TLS wraps each wire end-to-end

  ┌─ UI band ──────────────────────────────┐
  │  Browser                                │
  └────────────────┬───────────────────────┘
                   │
                   │  TLS termination #1: Vercel edge
                   │  (we don't see plaintext on this hop)
                   ▼
  ┌─ Edge ─────────────────────────────────┐
  │  Vercel proxy (re-encrypts to function) │
  └────────────────┬───────────────────────┘
                   │
                   │  TLS to the function (internal)
                   ▼
  ┌─ Service band ─────────────────────────┐ ← we are here
  │  Next.js route handler                  │
  └──┬──────────────────────────────┬──────┘
     │                              │
     │  TLS to Bloomreach           │  TLS to Anthropic
     │  (cert chain verified        │  (cert chain verified
     │   by Node's bundle)          │   by Node's bundle)
     ▼                              ▼
  ┌─ Provider ─────────┐  ┌─ Provider ─────────┐
  │ loomi-mcp-alpha    │  │ api.anthropic.com  │
  └────────────────────┘  └────────────────────┘
```

## Zoom in — the concept

Three TLS sessions to reason about. We terminate the user-facing one at Vercel's edge (we don't own the cert; Vercel does). We *originate* two outbound TLS sessions to providers and let Node validate their certs against the system CA bundle. No certificate pinning, no mTLS, no custom trust store anywhere.

## Structure pass

### Layers

- **Browser ↔ Vercel edge** — TLS 1.2/1.3 with Vercel's wildcard cert (`*.vercel.app`) or a configured custom domain cert (Let's Encrypt / Vercel-managed).
- **Vercel edge ↔ function** — internal hop, encrypted by Vercel's infrastructure. We don't see it.
- **Function ↔ provider** — TLS 1.2/1.3 originating from Node, validating the provider's cert against Node's bundled CA.

### One axis held constant — `who validates the certificate?`

```
  axis = "who decides this connection is trusted?"

  ┌─ Browser ↔ Vercel ────────┐  the BROWSER validates the edge cert
  │                            │  → cert chain rooted in a public CA
  │                            │    (Let's Encrypt, etc.)
  └────────────────────────────┘

  ┌─ Vercel edge ↔ function ──┐  VERCEL validates — internal infra
  │                            │  → opaque to us
  └────────────────────────────┘

  ┌─ Function ↔ Bloomreach ───┐  NODE validates against /etc/ssl
  │                            │  → trust roots ship with the runtime;
  │                            │    no custom CAs added in our code
  └────────────────────────────┘

  ┌─ Function ↔ Anthropic ────┐  same as Bloomreach
  │                            │
  └────────────────────────────┘
```

### Seams

- **Browser ↔ edge** — public PKI. Cert mismatch = browser blocks the request before our code runs.
- **Edge ↔ function** — Vercel's internal mTLS. We can't observe failures; we'd see them as 502s.
- **Function ↔ provider** — Node-managed. Cert failure throws inside `fetch`, surfaces as a network error to our route, which logs it and returns 500.

## How it works

### Move 1 — the mental model

TLS does three things at once: (1) proves the server is who the URL says it is (cert chain), (2) negotiates a shared key (key exchange), (3) encrypts every byte after that (record layer). The first part is the only one we have any code dealing with — and even then, only indirectly through Node's defaults.

```
  the handshake — the part that costs RTTs

  Client                                   Server
     │   ClientHello                          │  ┐
     │   • TLS versions supported              │  │  TLS 1.3:
     │   • cipher suites                       │  │  1 round-trip
     │   • SNI: "loomi-mcp-alpha.bloomreach.com"│  │  (Client sends keyshare
     │ ────────────────────────────────────►   │  │   in ClientHello,
     │                                          │  │   server responds with
     │   ServerHello + cert chain + Finished    │  │   cert + Finished)
     │ ◄────────────────────────────────────   │  │
     │                                          │  │  TLS 1.2:
     │   ClientFinished                         │  │  2 round-trips
     │ ────────────────────────────────────►   │  │  (additional exchange
     │                                          │  │   for keyshare)
     │   === application data starts ===        │  ┘
     │ ◄═══════════════════════════════════►   │
```

The SNI line is worth keeping in mind: TLS sends the target hostname in the clear, so the server can pick the right cert. That's `loomi-mcp-alpha.bloomreach.com` on wire #2, `api.anthropic.com` on wire #3. SNI is how virtual hosting works under TLS.

### Move 2 — walk each TLS session

#### Session 1 — Browser to `<app-host>` (Vercel-terminated)

We don't own any code on this session. Vercel terminates TLS at its edge. The cert is:

- `*.vercel.app` for preview deploys and the default production URL.
- A Let's Encrypt cert for any custom domain configured in the Vercel dashboard.

The browser validates the chain. If validation fails, the request never reaches our function — the browser shows its scary cert-error page. Our code's only TLS interaction here is implicit: we set the session cookie `Secure: true` in production (`lib/mcp/session.ts:12`), which is a contract — *don't send this cookie over plain HTTP*. Without HTTPS, the cookie wouldn't ride; without the cookie, we have no session.

```ts
// lib/mcp/session.ts:10-14
function sessionCookieOpts() {
  return process.env.NODE_ENV === 'production'
    ? { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/' }
    : { httpOnly: true, sameSite: 'lax' as const, path: '/' };
}
```

`Secure: true` is one of the few places our application code directly *depends on* TLS being present.

#### Session 2 — Function to `loomi-mcp-alpha.bloomreach.com`

We originate this. The SDK does:

```ts
// lib/mcp/connect.ts:76-79
const transport = new StreamableHTTPClientTransport(mcpUrl(), {
  authProvider: provider,
  fetch: makeCapturingFetch(httpErrors),
});
```

The `mcpUrl()` returns an `https://` URL. The `fetch` we pass through is the global `fetch` (wrapped). Node's `fetch` uses undici, which uses the system CA bundle plus the bundled Mozilla CA list to validate the server cert.

```
  Layers-and-hops — TLS validation on Wire #2

  ┌─ Function ─────────────────┐                   ┌─ Bloomreach ──┐
  │ makeCapturingFetch         │  ClientHello      │                │
  │   ↳ global undici fetch    │ ────────────────► │                │
  │                            │                   │                │
  │                            │  ServerHello +    │                │
  │                            │  cert chain       │                │
  │ Node validates:            │ ◄──────────────── │                │
  │   • hostname matches SAN   │                   │                │
  │   • each cert in chain     │                   │                │
  │     signed by next         │                   │                │
  │   • root is in CA bundle   │                   │                │
  │   • not expired            │                   │                │
  │                            │                   │                │
  │ if any check fails:        │                   │                │
  │   fetch throws             │                   │                │
  │   → captured as            │                   │                │
  │     McpToolError           │                   │                │
  └────────────────────────────┘                   └────────────────┘
```

What we DON'T do: pin the cert, pin the issuer, install a custom CA, use mTLS. If Bloomreach rotates their cert (within the public PKI), we follow them silently. If their cert expires or fails validation, every tool call throws and the briefing returns an error. There's no half-state.

#### Session 3 — Function to `api.anthropic.com`

Same story. The Anthropic SDK constructs `https://api.anthropic.com/v1/messages` and uses the standard Node fetch. Same CA bundle, same validation, same failure mode.

#### Authorization vs. encryption — keep them separate

TLS proves the *server is who the URL says*. It does NOT prove *we have permission to use the API*. That's a separate layer:

- Wire #1: cookies (`bi_session`, `bi_auth`) — proves the request belongs to a session.
- Wire #2: OAuth 2.1 Bearer token in the `Authorization` header — proves we have a current valid grant from Bloomreach.
- Wire #3: `x-api-key: sk-ant-…` in the header — proves we own the Anthropic account.

```
  TLS proves "who"; Authorization proves "what you can do"

  ┌──── TLS ────┐   ┌──── HTTP ───────┐
  │  server     │   │  Bearer eyJ…    │
  │  identity   │ + │  Authorization  │ = authenticated request
  │  (cert)     │   │  header         │
  └─────────────┘   └─────────────────┘
```

Both fail closed. A wrong cert: TLS handshake fails, no request goes through. A wrong/expired token: TLS handshake succeeds, 401 comes back, the route surfaces it.

### Move 2.5 — token leakage and TLS

Two failure modes the codebase guards against, both related to the fact that **TLS encrypts the wire, but it doesn't help once the bytes are inside our process**.

First: if a TLS-encrypted response body contains an OAuth token (which happens with the `token` endpoint response and with some error envelopes), and we `console.error` the response body, the token lands in Vercel logs in plaintext. The redaction layer in `lib/mcp/transport.ts:55-76` exists for exactly this:

```ts
// lib/mcp/transport.ts:55-61
const TOKEN_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/g,
  /"access_token"\s*:\s*"[^"]+"/g,
  /"refresh_token"\s*:\s*"[^"]+"/g,
  /"id_token"\s*:\s*"[^"]+"/g,
  /"code_verifier"\s*:\s*"[^"]+"/g,
];
```

Every captured body is run through the secret redactor (`redactSecrets`) before being stored or logged (`transport.ts:110`). TLS gets the bytes there safely; this code keeps them from leaking after arrival.

Second: the encrypted token cookie (`bi_auth`) that holds tokens at rest in the browser is AES-256-GCM encrypted in production (`lib/mcp/auth.ts:62-67`). TLS encrypts the cookie *in flight*; the encryption-at-rest is so a cookie dumped from a logged-out tab, browser extension, or memory snapshot doesn't expose tokens. Defense in depth — TLS isn't enough on its own when the secret has to be stored.

### Move 3 — the principle

**TLS validates server identity and encrypts the channel; it doesn't authorize the request.** Confusing the two leads to security thinking that's miscalibrated in both directions — "we have HTTPS, so we're secure" (no — anyone with the URL can hit the unauthenticated endpoints) and "we don't trust this connection, let's add mTLS" (probably not — the threat model is token theft, not impersonation of `api.anthropic.com`). Knowing what TLS does and doesn't do is the foundation for layering Authorization correctly on top.

## Primary diagram

```
  the recap — TLS terminations and trust chains

  ┌─ Browser ──────────────────────────────────────────────┐
  │  validates Vercel cert against public CA              │
  └─────────────────────┬──────────────────────────────────┘
                        │ TLS 1.2/1.3
                        ▼
  ┌─ Vercel edge ──────────────────────────────────────────┐
  │  terminates TLS · re-encrypts on internal hop          │
  └─────────────────────┬──────────────────────────────────┘
                        │ Vercel internal mTLS
                        ▼
  ┌─ Function (Node) ──────────────────────────────────────┐
  │  originates two outbound TLS sessions                   │
  │  ┌──────────────────────────┐  ┌──────────────────────┐│
  │  │ undici → Bloomreach      │  │ Anthropic SDK → API  ││
  │  │ validates cert against   │  │ validates cert       ││
  │  │ Node CA bundle           │  │ same bundle          ││
  │  │ Auth: Bearer (OAuth 2.1) │  │ Auth: x-api-key      ││
  │  └──────────────────────────┘  └──────────────────────┘│
  └────────────────────────────────────────────────────────┘

  + TOKEN HYGIENE inside the process:
      redactSecrets strips Bearer/access_token/refresh_token
      from captured bodies before logging
      → lib/mcp/transport.ts:55-76, applied at transport.ts:110

  + COOKIE AT REST:
      bi_auth = AES-256-GCM encrypted store of tokens + PKCE verifier
      → lib/mcp/auth.ts:62-79
```

## Elaborate

What's `not yet exercised`:

- **No cert pinning.** A common hardening for mobile/native apps; rarely worth it for serverless web apps because rotating roots breaks pinned clients.
- **No mTLS upstream.** Bloomreach and Anthropic don't require it; we don't offer it.
- **No HSTS preload registration.** Vercel sets HSTS headers; whether we're on the preload list depends on the domain config.
- **No custom CA store.** Everything trusts the standard system roots.

Where TLS hardening *would* matter: if we move to a private Bloomreach deployment with a private CA, the connect step would need `NODE_EXTRA_CA_CERTS` set. Not exercised today.

A note on TLS-1.2 vs 1.3: we don't pin a version. Node negotiates the highest both sides support. For our providers, that's TLS 1.3 in practice (one round-trip, faster connection). The cold-start handshake cost is half what it would be on TLS 1.2.

## Interview defense

**Q: Where does TLS terminate for browser requests?**

> At the Vercel edge. The browser validates Vercel's cert against the public CA roots. The internal hop from edge to function is also encrypted, but that's Vercel's infrastructure — we don't see it. Our application code's only direct TLS dependency on this wire is `Secure: true` on the session cookies, which is the contract "don't send these over plain HTTP."

```
  on the whiteboard:

  Browser ──TLS(public CA)──► Vercel edge ──TLS(internal)──► function
                                                              ▲
                                          our code starts here │
```

Anchor: we don't own the user-facing cert; Vercel does.

**Q: How does the function validate Bloomreach's cert?**

> Node's `fetch` (undici) uses the bundled Mozilla CA list to validate the chain. We pass an `https://` URL to `StreamableHTTPClientTransport`, the SDK calls our wrapped `fetch`, undici does the handshake, validates SNI matches the cert SAN, walks the chain to a trusted root. No pinning, no custom CA. If validation fails, `fetch` throws, the transport surfaces it as an `McpToolError`, the route surfaces it as a 500 with the real message.

```
  on the whiteboard:

  https://loomi-mcp-alpha.bloomreach.com/mcp
         │
         ▼
  undici handshake
         │
         ▼
  Mozilla CA list (bundled with Node) → chain validates → done
```

Anchor: standard public PKI, no custom trust.

**Q: TLS encrypts the wire. What about the tokens once they arrive?**

> Two protections. First, the secret redactor (`redactSecrets`) in `lib/mcp/transport.ts:55-76` runs over every captured error body before it goes to `console.error` — Bearer tokens, access tokens, refresh tokens, PKCE verifiers all get replaced with `[redacted]`. That keeps Vercel logs clean. Second, the encrypted token cookie (`bi_auth`) that holds tokens at rest in the browser is AES-256-GCM encrypted under `AUTH_SECRET` in production (`lib/mcp/auth.ts:62`). TLS protects transit; this protects what lands.

```
  on the whiteboard:

  TLS wire ═══════════ in-process ═══════════ at-rest
      ↑                  ↑                       ↑
  encrypts            redactSecrets          AES-256-GCM
  the bytes           strips tokens          (bi_auth cookie)
                      before logs
```

Anchor: TLS is one layer of three.

## See also

- `01-network-map.md` — where each TLS session sits
- `05-http-semantics-caching-and-cors.md` — the Authorization layer that rides on top of TLS
- `study-security/audit.md` — the full trust story per wire
