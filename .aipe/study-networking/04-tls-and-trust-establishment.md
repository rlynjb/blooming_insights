# TLS and trust establishment

**Industry name(s):** TLS 1.2/1.3, transport encryption, certificate validation, system trust store
**Type:** Industry standard · Language-agnostic

> Every hop in this repo runs over TLS; termination happens at the platform edge for inbound and at the provider for outbound; the only crypto we *write* is the AES-256-GCM that encrypts the `bi_auth` cookie at rest. Cert pinning, custom CAs, and mTLS are `not yet exercised`.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** TLS shows up in two distinct ways in this app: as the encryption-in-transit on every network hop (which we delegate entirely to the platform and the system trust store), and as a *property the auth cookie depends on* (the `bi_auth` cookie is `Secure`, meaning it only rides on HTTPS connections, and that's the entire reason it's safe to put encrypted OAuth tokens in it).

```
Zoom out — where TLS shows up

┌─ Browser ──────────────────────────────────────────────────────────┐
│  https://<app>.vercel.app                                          │
│  TLS terminated AT Vercel's edge                                   │
└────────────────┬───────────────────────────────────────────────────┘
                 │ ★ TLS 1.2 / 1.3 ★
                 │ cookies: bi_session, bi_auth (httpOnly+Secure)
                 │ ★ Secure flag means: only ride on TLS ★
                 ▼
┌─ Vercel edge → function ───────────────────────────────────────────┐
│  TLS terminated at edge; function-to-edge link is internal         │
│  but treated as encrypted (platform-managed)                       │
└────────┬───────────────────────────────────────────────┬───────────┘
         │                                                │
   HTTPS POST /mcp/                              HTTPS POST /v1/messages
   public CA chain                                public CA chain
   no pinning, no custom CAs                      no pinning
         │                                                │
         ▼                                                ▼
┌─────────────────────────────┐                ┌──────────────────────────┐
│  Bloomreach Loomi MCP       │                │  Anthropic API           │
│  (TLS terminator: theirs)   │                │  (TLS terminator: theirs)│
└─────────────────────────────┘                └──────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: where does encryption start and end, who validates the certificate, what crypto do we actually write ourselves, and which security guarantees rely on TLS being present? The honest answer is "all network crypto is delegated; the one place we *write* crypto is the cookie-at-rest encryption in `lib/mcp/auth.ts`, and that's a deliberately small surface."

---

## Structure pass

**Layers.** Two layers of trust. **Transport-layer trust** (TLS): the system trust store decides whether to believe Bloomreach's cert chain and Anthropic's cert chain, and the platform decides whether to believe the browser's connection. **Application-layer trust**: we trust the contents of the `bi_auth` cookie because we encrypted it (AES-256-GCM) and the receiver (us) is the only holder of `AUTH_SECRET`. Two completely different mechanisms, both called "trust"; they don't substitute for each other.

**Axis: trust.** Trace "who can read or tamper with these bytes?" across the layers. On the wire: nobody except endpoints (TLS encrypts; cert chain proves the endpoint). In the cookie: the browser can read the base64url blob but cannot decrypt it (AES-256-GCM under a secret it doesn't have); the server can decrypt and re-encrypt; if `AUTH_SECRET` is leaked, the blob is plaintext. In the function's memory: anyone with code-execution in the function sees `ANTHROPIC_API_KEY`, `AUTH_SECRET`, and the decrypted OAuth tokens. Trust is layered, not flat.

**Seams.** Three seams matter.

  → **Seam 1: cleartext app code → TLS-wrapped bytes.** Failure flips from "anyone on the wire can read it" to "only endpoints can." We delegate this. There is no place in the code where we touch the TLS handshake or the cert chain.
  → **Seam 2 (load-bearing): plaintext token in memory → AES-encrypted blob in cookie.** Failure flips from "token gone if process dies" to "token survives any number of cold starts inside a 10-day window." This is the one crypto seam we own.
  → **Seam 3: presence of TLS → `Secure` cookie flag.** Failure flips from "cookie sent over both HTTP and HTTPS" to "cookie ONLY sent over HTTPS." This is what makes putting tokens in a cookie safe in the first place.

```
Three trust seams — what flips, what we own

  seam                              flip                        owned?
  ────                              ────                        ──────
  cleartext → TLS bytes             public → endpoint-only      no
  in-memory → cookie blob           ephemeral → 10-day persist  yes
  TLS present → Secure cookie       any link → HTTPS only       yes (the flag)
```

The skeleton is mapped — the rest walks each mechanism.

---

## How it works

### Mental model

TLS handles the wire. Cookie encryption handles persistence across stateless function invocations. The two layers compose: the cookie can only contain OAuth tokens *because* TLS guarantees the cookie itself only travels on encrypted hops, and the cookie can survive process death *because* it's encrypted at rest with a server-only key.

```
The shape — two crypto domains, no overlap

  on the wire:                              at rest:
  ─────────────                              ────────
  TLS 1.2/1.3                                AES-256-GCM
  endpoint-authenticated                     server-key-authenticated
  ephemeral (per connection)                 persistent (10-day cookie)
  delegated to platform                      written in lib/mcp/auth.ts
       │                                          ▲
       └─── enables ──── Secure cookie flag ──────┘
            (cookie only crosses TLS hops)
```

### Move 2 walkthrough

**TLS on every hop.** All three production hops are HTTPS. The browser → edge link uses TLS terminated at Vercel; the cert is whatever Vercel provisions for `*.vercel.app` (or your custom domain via Let's Encrypt). The function → Bloomreach link uses TLS terminated by Bloomreach; their cert chain is validated by Node's bundled trust store. Same for the function → Anthropic link. We do not pin certs; we do not load a custom CA; we do not disable validation.

```
TLS handshake — what we don't touch

  client                                  server
  ──────                                  ──────
  ClientHello (supported ciphers)  ──►    
                                          ServerHello + cert chain
                                   ◄──    
  validate cert against trust store       
  (Node's bundled or browser's)           
  key exchange                     ─►◄─   
  encrypted application data       ─►◄─   
```

Nothing in this repo touches that handshake. We do not set `tls.rejectUnauthorized = false`. We do not pass a `ca` option. We do not write `https.request` with a custom agent. If a cert verification fails (e.g. Bloomreach rotates and we cache a stale resolver), undici throws and our `liveCall` wraps it in `McpToolError`.

**The `Secure` cookie flag — TLS as a precondition for cookie safety.** When `setSessionCookie` or `withAuthCookies` sets a cookie in production, it passes `secure: true`. The browser then refuses to send that cookie on any HTTP (non-TLS) request. This is what makes putting encrypted OAuth tokens in the cookie acceptable — the cookie blob never crosses a cleartext hop, so the only thing on the wire is the AES-encrypted ciphertext over TLS-encrypted bytes (double-wrapped).

```
Pseudocode — Secure flag enforces TLS

  in production:
    cookies.set('bi_auth', encryptedBlob, {
      httpOnly: true,         // JS in the page cannot read it
      secure: true,           // ← browser refuses to send over HTTP
      sameSite: 'none',       // allows the cross-site OAuth callback
      path: '/',
      maxAge: 60*60*24*10,    // 10 days
    })
  
  in development (localhost, no TLS):
    cookies.set('bi_auth', encryptedBlob, {
      httpOnly: true,
      // ★ no secure: true ★ — localhost is http://, the browser
      // would refuse to send a Secure cookie at all, breaking dev
      sameSite: 'lax',
      path: '/',
    })
```

The boundary that catches people: in development on `localhost`, `Secure` cookies don't ride at all (the browser drops them), so `session.ts` and `auth.ts` both omit `secure: true` when `NODE_ENV !== 'production'`. Forgetting that pattern would make dev OAuth silently fail with no cookies.

**The cookie encryption — AES-256-GCM under `AUTH_SECRET`.** This is the only crypto code we write. We take the `AUTH_SECRET` env var, SHA-256 it into a 32-byte key, generate a fresh random 12-byte IV per encryption, encrypt the JSON-stringified store, append the GCM auth tag, base64url the whole thing, and put it in the cookie. To decrypt: extract IV (first 12 bytes), auth tag (next 16), ciphertext (rest), `createDecipheriv`, `setAuthTag`, decrypt. A tampered ciphertext or rotated `AUTH_SECRET` triggers the GCM auth-tag check to fail, decrypt throws, and `decryptStore` returns `{}` — treated as "no auth."

```
Pseudocode — AES-256-GCM round trip

  function encryptStore(store):
    key = sha256(env.AUTH_SECRET)         // 32 bytes → AES-256
    iv = random_bytes(12)                  // GCM: 96-bit IV is standard
    cipher = createCipheriv('aes-256-gcm', key, iv)
    ciphertext = cipher.update(json(store)) ++ cipher.final()
    tag = cipher.getAuthTag()              // 16 bytes
    return base64url(iv ++ tag ++ ciphertext)
  
  function decryptStore(token):
    try:
      buf = base64url_decode(token)
      iv = buf[0..12]
      tag = buf[12..28]
      ciphertext = buf[28..]
      decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)              // ← GCM authenticated decrypt:
                                            //   any bit-flip in ciphertext OR
                                            //   tag fails the auth check
      plaintext = decipher.update(ciphertext) ++ decipher.final()
      return json_parse(plaintext)
    catch:
      return {}                              // tampered or rotated secret →
                                              // treat as no auth, force re-OAuth
```

The choice of GCM (authenticated encryption) is load-bearing. With CBC + HMAC you'd have two keys and a chance to make order-of-operations mistakes (encrypt-then-MAC vs MAC-then-encrypt). GCM bundles confidentiality + integrity into one primitive with one key, and decrypt fails closed on any tampering. The 12-byte IV is the GCM standard; a fresh IV per encryption is mandatory (reusing one with the same key catastrophically breaks confidentiality).

**What's NOT here.** No cert pinning. No custom CA loading. No mTLS (we authenticate to Bloomreach with an OAuth Bearer, not a client cert). No proxy configuration. No `tls.connect` direct calls. No HSTS header we set ourselves (Vercel may set one). No CSP header we set. These are all `not yet exercised`.

### Principle

Delegate transport crypto, write only the application crypto you cannot avoid. The TLS handshake is solved by the platform and the system trust store; touching it (custom CAs, pinning) adds maintenance burden without adding security at this scale. The cookie encryption is the *only* crypto we cannot delegate, because we need OAuth tokens to survive a stateless function's death, and we don't run a shared key-value store. Picking AES-256-GCM (authenticated encryption, single key, fail-closed) over CBC+HMAC is the right call because the failure modes are simpler.

---

## Primary diagram

The recap — every place TLS or app-crypto lives.

```
TLS + app-crypto — full recap

UI band ────────────────────────────────────────────────────────────
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                          │
│  https://<app>.vercel.app  → TLS validated against browser store  │
│  cookies: bi_session, bi_auth                                     │
│     • httpOnly:true → JS cannot read                              │
│     • secure:true (prod) → only sent on HTTPS                     │
│     • sameSite:'none' (prod) → survives cross-site OAuth bounce   │
└─────────────────┬────────────────────────────────────────────────┘
                  │ TLS 1.2/1.3 to Vercel edge
                  ▼
Edge band ─────────────────────────────────────────────────────────
┌──────────────────────────────────────────────────────────────────┐
│  Vercel edge                                                      │
│  • terminates TLS for *.vercel.app (or custom-domain cert)       │
│  • internal hop to function: platform-managed                    │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
Service band ──────────────────────▼───────────────────────────────
┌──────────────────────────────────────────────────────────────────┐
│  Serverless function                                              │
│  ★ READS cookies, decrypts bi_auth via AES-256-GCM ★              │
│  • AUTH_SECRET (env, server-only)                                 │
│    → sha256 → 32-byte key                                         │
│    → decipher(buf[0..12]=iv, buf[12..28]=tag, buf[28..]=ct)       │
│    → JSON → {sessionId: {tokens, clientInformation, codeVerifier}}│
│  • re-encrypts on dirty write before flushing the cookie back     │
│  • on tamper/rotate: decrypt fails closed → treated as no auth    │
└────┬─────────────────────────────────────────────┬───────────────┘
     │                                              │
     │ TLS via Node trust store                     │ TLS via Node trust store
     │ public CA chain                              │ public CA chain
     │ no pinning, no custom CA                     │ no pinning
     ▼                                              ▼
┌─────────────────────────────┐                ┌──────────────────────────┐
│  Bloomreach (their TLS)     │                │  Anthropic (their TLS)   │
└─────────────────────────────┘                └──────────────────────────┘
```

---

## Implementation in codebase

### Use cases

  → **First user load in production.** Browser hits `https://<app>.vercel.app`; TLS terminates at edge; function reads cookies; if `bi_auth` present, decrypts it; if not, returns `{needsAuth, authUrl}` and the browser navigates to Bloomreach's IdP over TLS.
  → **OAuth callback.** The IdP 302s back to `/api/mcp/callback?code=…` over TLS; the function decrypts `bi_auth` to recover the PKCE verifier saved during `connect`, exchanges the code over TLS to Bloomreach, persists new tokens in the re-encrypted cookie.
  → **Cold start after instance death.** Function comes up with no memory of prior state; the cookie's encrypted blob is the only state that survived; decrypts, reads tokens, proceeds.

### `bi_auth` cookie write (the only place we write app crypto)

```
lib/mcp/auth.ts  (lines 62-79, the encrypt/decrypt round trip)

function encryptStore(store: Store): string {
  const iv = randomBytes(12);
                       │
                       └─ fresh per encryption; reusing an IV with the
                          same key catastrophically breaks GCM. Node's
                          randomBytes is cryptographically secure.
  const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
                       │
                       └─ aesKey() = sha256(AUTH_SECRET) → 32 bytes.
                          AES-256-GCM = authenticated encryption with
                          associated data; one primitive does confi-
                          dentiality + integrity. We pass no AAD because
                          there's nothing to bind it to.
  const enc = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
                                                              │
                                                              └─ base64url
                                                                 because the
                                                                 cookie value
                                                                 cannot contain
                                                                 +, /, or =.
}

function decryptStore(token: string): Store {
  try {
    const buf = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', aesKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
                       │
                       └─ MUST be called BEFORE update/final in GCM.
                          Wrong order or missing tag → throws on final.
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as Store;
  } catch {
    return {};
                       │
                       └─ tampered ciphertext, rotated AUTH_SECRET, or
                          corrupt cookie all land here. We FAIL CLOSED:
                          empty store = "no auth", forcing a fresh OAuth.
                          Crucially we do not throw — the request can
                          still serve the auth-required path.
  }
}
```

### `Secure` cookie flag — the TLS-only contract

```
lib/mcp/auth.ts  (lines 86-103, withAuthCookies' flush)

(await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
  httpOnly: true,
       │
       └─ JS in the page can't read it; XSS can't exfiltrate the cookie
          even if it can hit your API.
  secure: true,
       │
       └─ load-bearing in prod: browser refuses to send this over HTTP.
          Combined with the public app being HTTPS-only on Vercel, the
          encrypted blob never crosses cleartext.
  sameSite: 'none',
       │
       └─ required for the cross-site OAuth callback: SameSite=Lax would
          drop the cookie on the IdP→callback bounce in some browsers,
          and we'd lose the PKCE verifier.
  path: '/',
  maxAge: AUTH_COOKIE_MAX_AGE,   // 10 days, matches token lifetime
});
```

### `lib/mcp/session.ts` — the matching session cookie

```
lib/mcp/session.ts  (lines 10-14, dev/prod cookie split)

function sessionCookieOpts() {
  return process.env.NODE_ENV === 'production'
    ? { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/' }
    : { httpOnly: true, sameSite: 'lax' as const, path: '/' };
                       │
                       └─ no secure:true in dev, because localhost is
                          http://. A Secure cookie on a non-TLS hop
                          would simply not be sent — the dev OAuth
                          flow would silently break.
}
```

### What's absent (and the verdict)

A grep for `pinning`, `ca:`, `rejectUnauthorized`, `tls.connect`, `https.Agent` across `lib/` and `app/` returns no app hits. The verdict: `not yet exercised`. If we later needed to talk to an internal service with a private CA, or wanted to pin Bloomreach's cert against MITM at the platform layer, the insertion point would be `lib/mcp/transport.ts`'s `makeCapturingFetch` — passing a custom `dispatcher` with a TLS-aware connector.

---

## Elaborate

The choice between symmetric authenticated encryption (AES-GCM, ChaCha20-Poly1305) and "encrypt-then-MAC" (CBC + HMAC) is mostly settled now: AEAD primitives are simpler, faster on modern CPUs, and harder to misuse. GCM specifically requires a unique IV per encryption with the same key, which Node's `randomBytes(12)` handles correctly (the 96-bit IV space is large enough that birthday collisions are not a concern for the volume here).

The 10-day cookie lifetime is *much* longer than typical OAuth refresh-token cycles; that's because we want the user to not re-OAuth across sessions, and the cookie *is* the persistence layer (we have no DB to keep tokens in). The cost: a stolen cookie is valid for 10 days. Defense-in-depth: `httpOnly` blocks JS theft; `Secure` blocks cleartext transit; rotating `AUTH_SECRET` instantly invalidates all cookies. We have no cookie-revocation mechanism short of secret rotation.

What we deliberately don't do: store tokens in `localStorage` (readable by any script in the page) or `sessionStorage` (same), or expose them via an authenticated `/api/me` endpoint (would let a stolen session-id holder pull tokens). The encrypted-cookie pattern keeps tokens server-side-only while surviving cold starts.

---

## Interview defense

**Q1: Walk me through the TLS story end to end.**

Three TLS hops, all delegated. Browser → Vercel edge: cert from Let's Encrypt / Vercel's wildcard, validated by the browser. Function → Bloomreach: cert validated by Node's bundled trust store. Function → Anthropic: same. We don't pin certs, don't load custom CAs, don't touch the handshake. The one place crypto leaks into application code is the `bi_auth` cookie: we AES-256-GCM encrypt the OAuth tokens under `AUTH_SECRET` because the function is stateless and the cookie is the only state that survives cold starts.

```
Diagram-while-you-speak

  TLS (platform)              cookie crypto (us)
  ──────────────              ──────────────────
  3 hops, all HTTPS           AES-256-GCM
  system trust store          AUTH_SECRET → sha256 → 32-byte key
  no pinning                  random 12-byte IV per encrypt
  delegated                   GCM auth tag → fail closed on tamper
```

Anchor: "transport crypto delegated; application crypto narrow and authenticated."

**Q2: Why AES-GCM and not CBC + HMAC?**

GCM is authenticated encryption — one primitive does confidentiality and integrity, one key, fail-closed on tampering. CBC + HMAC needs two keys, an order-of-operations decision (encrypt-then-MAC is correct; MAC-then-encrypt has known attacks), and more code surface to get wrong. The GCM IV requirement (unique per encryption) is satisfied by `randomBytes(12)`.

**Q3: What's the threat model for the `bi_auth` cookie?**

The blob carries OAuth tokens with a 10-day lifetime. Risks ranked: (1) `AUTH_SECRET` leak — the entire 10-day cookie population becomes decryptable, mitigated by rotating the secret (which invalidates all cookies); (2) cookie theft via XSS — blocked by `httpOnly`; (3) MITM on the wire — blocked by `Secure` + TLS; (4) replay after logout — we have no server-side revocation, so a stolen valid cookie is valid until expiry. The defense-in-depth is real but the revocation gap is honest.

---

---

## See also

  → `01-network-map.md` — every hop named, every TLS boundary visible.
  → `02-dns-routing-and-addressing.md` — how the cert's hostname matches resolution.
  → `05-http-semantics-caching-and-cors.md` — the cookies' other flags and what they bind to.
  → `../study-security/` — for the application-level trust audit; this file covers the mechanism, that one covers whether it's enough.
