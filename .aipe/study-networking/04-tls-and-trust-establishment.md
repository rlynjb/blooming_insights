# TLS and trust establishment

*Transport-Layer Security (Industry standard)* — encryption in transit,
certificates, trust roots, and where TLS is terminated. Plus the
encryption-at-rest layer wrapping the OAuth cookie, which is where
this repo actually *does* apply crypto directly.

## Zoom out — where this concept lives

TLS itself is delegated to the platform on all three hops — no custom
certs, no mTLS, no pinning. What *is* explicit is the AES-256-GCM
encryption of the OAuth token cookie, which sits *below* TLS in the
threat model: the cookie is already encrypted by the app before TLS
carries it, so a compromised TLS session doesn't leak the tokens plaintext.

```
  Zoom out — trust at each layer

  ┌─ Browser ──────────────────────────────────────────────────────┐
  │  browser's TLS stack + system CA roots                          │
  └───────────────────────┬───────────────────────────────────────┘
                          │  TLS 1.3 to Vercel edge
                          │  Cookie: bi_auth=<AES-256-GCM ciphertext>
                          ▼
  ┌─ Vercel edge (TLS terminated) ──────────────────────────────────┐
  │  Let's Encrypt / platform-managed cert                           │
  └───────────────────────┬───────────────────────────────────────┘
                          │  cleartext to Node runtime (Vercel network)
                          ▼
  ┌─ Node runtime ────────────────────────────────────────────────┐
  │  ★ APP CRYPTO LIVES HERE ★                                     │
  │  AES-256-GCM decrypt of bi_auth → OAuth tokens                 │
  │  Node's default TLS trust roots for outbound HTTPS             │
  └───┬───────────────────────────────────────────┬───────────────┘
      │  TLS 1.3 outbound                          │  TLS 1.3 outbound
      ▼                                            ▼
  ┌─ Bloomreach ────────┐                    ┌─ Anthropic ─────────┐
  │  server-managed CA  │                    │  server-managed CA  │
  └─────────────────────┘                    └─────────────────────┘
```

Three TLS terminations, no custom trust, one layer of app-owned
symmetric crypto around the OAuth cookie. That's the map.

## The structure pass

The load-bearing axis: **what does each layer promise about
confidentiality — is it TLS-only, or app-encrypted-on-top?**

```
  Axis: "who guarantees the payload's confidentiality?"

  ┌─────────────────────────────────────────┐
  │ browser ↔ Vercel edge                    │  → TLS 1.3 (platform)
  └─────────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ Vercel edge ↔ Node runtime          │  → cleartext (Vercel
      │  (inside Vercel's private network)  │    private network — trust
      │                                      │    the platform boundary)
      └──────────────────────────────────────┘
          ┌──────────────────────────────────┐
          │ bi_auth cookie content           │  → AES-256-GCM (app)
          │  (OAuth tokens)                  │    on top of everything
          └──────────────────────────────────┘
              ┌──────────────────────────────┐
              │ Node → Bloomreach / Anthropic│  → TLS 1.3 (platform)
              └──────────────────────────────┘
```

Two seams:

  - **edge-to-runtime cleartext** is a *trust boundary* — you're trusting
    Vercel's internal network. Standard tradeoff; documented in the
    Vercel security model.
  - **cookie encryption** is a defense-in-depth layer that survives even
    if some other request-log or backup captures the raw cookie value.
    Without it, `bi_auth` would be a bearer token for the user's
    Bloomreach session for anyone who saw it.

## How it works

### Move 1 — the mental model

You know TLS gives you confidentiality + integrity + authentication
between endpoints. When your server is *behind* a TLS-terminating edge
(Vercel, CloudFront, Cloudflare), the TLS ends at the edge and cleartext
travels the rest of the way inside the private network. When you have a
secret in a cookie and the cookie is going to be visible in logs, backups,
or intermediate caches, you encrypt the cookie *content* so TLS is not
your only line of defense.

```
  The pattern — TLS + app-level cookie encryption

  ┌─ browser cookie jar ─┐
  │ bi_auth = ABC123…    │  ← ciphertext, useless without AUTH_SECRET
  └──────────┬───────────┘
             │  TLS 1.3
             ▼
  ┌─ Vercel edge (TLS terminates) ─┐
  │ sees: Cookie: bi_auth=ABC123…  │  ← still ciphertext in Vercel logs
  └──────────┬─────────────────────┘
             │  private network (cleartext HTTP)
             ▼
  ┌─ Node runtime ─────────────────┐
  │ withAuthCookies(fn):           │
  │   decryptStore(ABC123…) → tokens│
  │   fn()                          │
  │   encryptStore(tokens) → cookie │  ← re-encrypt, set on response
  └────────────────────────────────┘
```

### Move 2 — walk each layer

#### TLS on hop 1 (browser ↔ Vercel)

Zero code. Vercel provisions certificates automatically (Let's Encrypt
or a purchased cert for the production alias). The app makes no
choices here — no HSTS header set explicitly, no cert pinning, no
custom trust roots.

The only TLS-adjacent policy the app sets is on the cookies themselves:
`Secure: true` in production (`lib/mcp/auth.ts:94`, `lib/mcp/session.ts:12`)
means the cookies only ride HTTPS, so a downgrade attack that flipped
the connection to HTTP would leave the browser unable to attach the
cookie.

#### TLS on hops 2 and 3 (Node ↔ Bloomreach / Anthropic)

Node's default TLS trust store is used. No `NODE_EXTRA_CA_CERTS`, no
`rejectUnauthorized: false`, no custom `https.Agent`. The SDKs
(`@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`) use the platform's
default `fetch`, which uses Undici, which uses Node's TLS with the
system CA bundle.

**What that means concretely**: if either upstream's certificate
expires, the calls fail. There's no cache of "yesterday's cert was
valid" — every TLS handshake re-verifies. This is correct default
behavior.

#### The AES-256-GCM cookie — where the app actually does crypto

The `bi_auth` cookie holds OAuth tokens, DCR client info, and the PKCE
verifier. Any of those in plaintext would be a bearer key for the
user's Bloomreach session. The app encrypts them.

Setup (`lib/mcp/auth.ts:51-60`):

```ts
  function aesKey(): Buffer {
    const secret = process.env.AUTH_SECRET;
    if (!secret) {
      throw new Error(
        'AUTH_SECRET is required in production to encrypt the auth cookie…',
      );
    }
    return createHash('sha256').update(secret).digest();  // 32 bytes → AES-256
  }
```

The key is derived by SHA-256 of `AUTH_SECRET`. This is *not* PBKDF2 —
there's no per-cookie salt, no iteration count. That's fine for this
use case because `AUTH_SECRET` is a high-entropy server-only value
(not a user-derived password), so the SHA-256 stretch is enough to
produce a valid 32-byte key.

Encrypt (`lib/mcp/auth.ts:62-67`):

```ts
  function encryptStore(store: Store): string {
    const iv = randomBytes(12);                                    // fresh IV per cookie set
    const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
  }
```

Layout of the base64url'd cookie value:
  - bytes 0-11: IV (12 bytes, fresh per encrypt)
  - bytes 12-27: GCM auth tag (16 bytes)
  - bytes 28+: ciphertext

GCM gives you authenticated encryption — tampering with any byte fails
the tag check on decrypt. The decrypt path swallows the failure and
returns `{}` (`auth.ts:76-78`):

```ts
  } catch {
    return {};  // tampered, rotated-secret, or corrupt cookie → treat as no auth
  }
```

Treating a bad cookie as "no auth" (instead of throwing) is a deliberate
UX choice — a rotated `AUTH_SECRET` or a tampered cookie just makes the
user re-authenticate, no error page.

Layers and hops for one cookie set:

```
  Setting bi_auth on a response — where each layer sits

  ┌─ Route (Node) ──────────────────────────────────────────────┐
  │  withAuthCookies(fn):                                         │
  │    ctx = { store: decryptStore(cookies.get(bi_auth)), dirty:  │
  │             false }                                           │
  │    await requestStore.run(ctx, fn)   ← AsyncLocalStorage      │
  │      ↓                                                        │
  │      OAuthClientProvider methods read/write ctx.store          │
  │      ↓                                                        │
  │    if (ctx.dirty) cookies.set(bi_auth, encryptStore(ctx.store),│
  │                                { httpOnly, secure, sameSite:  │
  │                                  'none', maxAge: 10d })       │
  └────────────┬─────────────────────────────────────────────────┘
               │  Set-Cookie header on response
               ▼
  ┌─ Vercel edge ─────────────────────────────────────────────┐
  │  passes Set-Cookie through unchanged                        │
  └────────────┬───────────────────────────────────────────────┘
               │  HTTPS to browser
               ▼
  ┌─ Browser cookie jar ──────────────────────────────────────┐
  │  bi_auth = <IV||tag||ciphertext>_base64url                 │
  │  attached to every same-origin request; carried across      │
  │  the OAuth IdP roundtrip via SameSite=None                  │
  └───────────────────────────────────────────────────────────┘
```

#### Why encrypt at all — the threat model

TLS 1.3 already secures the cookie in transit. So why encrypt on top?
Three reasons:
  1. **Vercel logs may capture request headers**, including `Cookie:`.
     The ciphertext is safe to log; plaintext tokens are not.
  2. **Vercel's cleartext hop** (edge → Node) is inside the platform
     but still crosses machines. The ciphertext protects against a
     hypothetical intra-Vercel observability leak.
  3. **Rotating `AUTH_SECRET` invalidates all cookies at once** —
     a useful revocation mechanism.

None of this changes if you'd trusted TLS alone; it's defense in
depth for a bearer-token pattern that is inherently sensitive.

### Move 2.5 — the seam that isn't TLS

There's one wire surface in this repo where confidentiality is *not*
TLS-guaranteed: the browser-to-route hop in local dev. Locally the app
runs on `http://localhost:3000` (`APP_ORIGIN` default in `connect.ts:56`).
The cookie is not `Secure`, and TLS isn't there.

The threat model tolerates this because dev cookies hold *dev tokens*
that only work against the alpha Bloomreach environment on the
developer's machine. The bigger surface is that in dev, the auth store
falls back to a *plaintext gitignored file* (`.auth-cache.json` — see
`lib/mcp/auth.ts:34-35, 113-142`). Documented at
`auth.ts:33-34`:

> SECURITY: the dev cache holds OAuth tokens in plaintext; it is
> local-only and gitignored.

If a dev environment ever got shared across machines (say, a
containerized dev image), this file would be the leak. Filed but not
addressed — it's the pragmatic call for a solo development flow.

### Move 3 — the principle

TLS handles wire confidentiality; app-level crypto handles storage and
log confidentiality. When a bearer token has to survive at rest
(cookie jar, log grep, backup) *and* in transit (TLS), you encrypt at
both layers. GCM gives you the auth tag for free, which lets you fail
closed on tampering with no extra machinery.

## Primary diagram

```
  Primary — TLS and encryption at each hop

  ┌─ Browser ────────────────────────────────────────────────┐
  │  bi_session (session id, plaintext, httpOnly Secure)     │
  │  bi_auth   (ciphertext, httpOnly Secure SameSite=None)   │
  └────────────┬─────────────────────────────────────────────┘
               │  TLS 1.3 (Vercel-managed cert)
               ▼
  ┌─ Vercel edge (TLS terminates) ────────────────────────────┐
  └────────────┬─────────────────────────────────────────────┘
               │  Vercel private network (cleartext)
               │  Cookie: bi_auth=<ciphertext>
               ▼
  ┌─ Node runtime ───────────────────────────────────────────┐
  │  withAuthCookies:                                         │
  │    IN:  decryptStore(bi_auth)   AES-256-GCM               │
  │    OUT: encryptStore(...) → Set-Cookie                    │
  │  Outbound TLS uses Node's default trust store             │
  └───┬──────────────────────────────────┬───────────────────┘
      │  TLS 1.3                          │  TLS 1.3
      │  Authorization: Bearer <token>    │  Authorization: Bearer <key>
      ▼                                   ▼
  ┌─ Bloomreach ────────┐         ┌─ Anthropic ─────────┐
  │ TLS terminates      │         │ TLS terminates      │
  └─────────────────────┘         └─────────────────────┘
```

## Elaborate

The `SameSite=None` decision is worth pausing on. Standard advice says
"use Lax by default; use None only when you need cross-site." This app
*needs* cross-site — the OAuth flow redirects to `bloomreach.com`
and the callback lands back on the app. `Lax` cookies drop on the
top-level redirect *from* the IdP in some browsers/flows, and the
callback would land with no session.

The tradeoff of `None`: a malicious site could trigger a CSRF-shaped
request that carries the cookie. The counter is `Secure` (attacker
can't downgrade) plus the fact that the OAuth `state` parameter (though
not app-validated — see the note at `callback/route.ts:22-26`) is
validated by the MCP SDK itself. The residual risk is an attacker
who can talk to the callback route with a stolen `code` value —
non-trivial to arrange.

What's *not* here:

  - **Certificate pinning** — the app trusts the system CA store,
    same as `curl`. Would matter if we needed to detect a MITM against
    a specific upstream.
  - **mTLS** — no client cert to prove identity to Bloomreach or
    Anthropic. Both use bearer tokens instead.
  - **HSTS header** — not explicitly set by the app. Vercel usually
    sets this at the edge.

## Interview defense

**Q: The cookie value is already carried over TLS. Why encrypt it too?**

  Direct: TLS protects the cookie *in transit* between browser and
  edge. It does nothing for the cookie *at rest* — Vercel logs may
  capture request headers, the cookie value can show up in error
  reports, and it crosses cleartext inside Vercel's private network
  between edge and Node. AES-256-GCM around the cookie value means
  the OAuth tokens never exist in plaintext outside the Node process's
  memory. That's defense in depth for a bearer token.

```
  answer sketch — where TLS ends, app crypto continues

  browser ──TLS──► edge  ── cleartext ──► Node
                     │                     │
                     │ log captures         │ decrypt in-memory
                     │ cookie header:        │ tokens live only
                     │ ciphertext (safe)     │ in ctx.store
                     ▼                     ▼
                   Vercel logs           process only
                   (safe to store)       (never persisted)
```

  Anchor: `lib/mcp/auth.ts:62-79` (encrypt/decrypt),
  `lib/mcp/auth.ts:86-103` (`withAuthCookies` seed/flush).

**Q: How does the app authenticate the upstream servers — how do we
know we're talking to real Bloomreach and not a MITM?**

  Direct: standard TLS with the system CA store. No pinning, no
  custom trust roots. If someone MITM'd `loomi-mcp-alpha.bloomreach.com`
  with a rogue cert that chained to a system-trusted CA, we wouldn't
  detect it. That's the tradeoff for platform-default TLS — enough
  for this app's threat model; not enough if we needed to defend
  against nation-state adversaries.

  Anchor: no code — Node's default `fetch`/Undici uses system TLS.

## See also

  - `02-dns-routing-and-addressing.md` — the origins TLS terminates against
  - `05-http-semantics-caching-and-cors.md` — Secure + SameSite semantics
  - `.aipe/study-security/` — trust boundaries as a security concern
