# Encrypted cookie OAuth state

**Industry name(s):** authenticated-encryption cookie, AES-256-GCM session cookie, encrypted client-side state, stateless server session
**Type:** Industry standard · Language-agnostic (the AES-GCM-under-a-derived-key pattern); Project-specific (the `bi_auth` cookie carrying the full OAuth + DCR + PKCE state)

> The single piece of durable production state in this app is one cookie. blooming insights runs on Vercel serverless: every request can hit a different instance, in-memory `Map`s wipe between requests, the filesystem is read-only. The OAuth flow needs state to survive *across* requests — DCR client info from `connect`, PKCE `code_verifier` from authorize, `access_token` from callback. The `bi_auth` cookie is that state: AES-256-GCM ciphertext under a key derived from `AUTH_SECRET`, httpOnly + Secure + `SameSite=None`, 10-day maxAge. Strip this pattern out and the OAuth flow can't complete on serverless at all.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three layers carry session state. The browser holds two cookies. The route handler reads them at the start of the request and writes them at the end. There's no database, no Redis, no server-side session table. Production has no on-disk persistence (Vercel's FS is read-only outside `/tmp` which is per-instance). The cookie *is* the session.

```
  Zoom out — where session state lives

  ┌─ Browser ──────────────────────────────────────┐
  │  bi_session  (UUID, httpOnly)                   │
  │  ★ bi_auth   (AES-256-GCM ciphertext)           │ ← we are here
  └─────────────────────┬───────────────────────────┘
                        │  HTTPS + cookies
  ┌─ Route handler (Vercel serverless) ────────────┐
  │  withAuthCookies(fn) → decrypt-once / flush-once│
  │  BloomreachAuthProvider reads/writes ALS store  │
  │  no on-disk persistence, no in-memory cache     │
  │  that survives across requests                  │
  └─────────────────────┬───────────────────────────┘
                        │  Authorization: Bearer
  ┌─ Bloomreach (real authz authority) ────────────┐
  │  validates OAuth token; we never authorize      │
  └─────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The pattern is *authenticated encryption of session state into a cookie value*. AES-256-GCM gives you both confidentiality (the attacker can't read the OAuth tokens) and integrity (the GCM auth tag rejects any tampering). The key isn't `AUTH_SECRET` directly — it's `SHA-256(AUTH_SECRET)` so any string length the operator supplies produces a 32-byte key. The cookie value is `base64url(iv || tag || ciphertext)`. The whole pattern is about ten lines of crypto plus a wrapper that orchestrates when to decrypt and when to encrypt within one request.

---

## Structure pass

**Layers.** Three altitudes. The **crypto primitive** (`aesKey` + `encryptStore` + `decryptStore` — the AES-GCM operations on a `Store` JSON blob). The **request-scoped runtime** (`withAuthCookies` — decrypt once at request start, run the handler, flush once at request end if dirty). The **provider interface** (`BloomreachAuthProvider` — the MCP SDK's `OAuthClientProvider` shape, reading and writing through the runtime).

**Axis: state ownership.** Hold one question constant across the layers: *who owns this state, and on what does its existence depend?* At the crypto layer, state is bytes — owned by nobody, just transformed. At the runtime layer, state is owned by the `RequestStore` for the lifetime of one request and by the browser cookie between requests. At the provider layer, state is "what the SDK thinks is true about the session" — read-through, write-back to the runtime.

**Seams.** Two load-bearing seams. **Seam 1 (cookie ↔ AES-GCM)** is where untrusted bytes (the base64url cookie value) become typed state (`Store`) or fall to `{}` on tamper. **Seam 2 (RequestStore ↔ cookie)** is where the ALS-scoped in-memory store gets reconciled back to the wire format. Skipping either seam breaks the model — skip seam 1 and you trust the browser to send unmodified state; skip seam 2 and the cookie never updates.

```
  Structure pass — the three layers

  ┌─ 1. LAYERS ───────────────────────────────────────┐
  │  crypto      aesKey · encryptStore · decryptStore  │
  │  runtime     withAuthCookies (decrypt-once /       │
  │              flush-once)                            │
  │  provider    BloomreachAuthProvider (SDK shape)    │
  └────────────────────────┬──────────────────────────┘
                           │  hold the state-ownership question
  ┌─ 2. AXIS ─────────────▼───────────────────────────┐
  │  who owns this state, what does it depend on?      │
  └────────────────────────┬──────────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼───────────────────────────┐
  │  cookie ↔ AES-GCM       UNTRUSTED → TYPED          │
  │      tamper → decrypt returns {}                   │
  │  RequestStore ↔ cookie  IN-MEM → WIRE              │
  │      dirty flag drives the write-back              │
  └────────────────────────┬──────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped. Next we walk the mechanics.

---

## How it works

### Move 1 — the mental model

You know how JWT sessions work — the server signs a payload, the browser stores the JWT, every request the server verifies the signature and reads the claims? AES-GCM cookies are the sibling pattern that also *encrypts* the payload, not just signs it. So instead of "the browser can read the claims but can't tamper" (JWT), it's "the browser can neither read nor tamper" (encrypted cookie). The state is *opaque ciphertext* to the browser; only the server can decrypt with its key.

```
  Authenticated-encryption cookie — the shape

   server-side
   ┌──────────────────────────┐
   │  state object (JSON)     │  e.g. { sessionId: { tokens, codeVerifier, ... } }
   └────────────┬─────────────┘
                │ encrypt(state, key)
                │   ┌─ key = SHA-256(AUTH_SECRET)      32 bytes
                │   ├─ iv  = randomBytes(12)           12 bytes
                │   ├─ ciphertext = AES-256-GCM(state)
                │   └─ tag = GCM auth tag              16 bytes
                ▼
   ┌──────────────────────────┐
   │  cookie value =          │  iv || tag || ciphertext, base64url-encoded
   │  base64url(iv,tag,ct)    │  → ~140 bytes for a small state
   └────────────┬─────────────┘
                │ Set-Cookie: bi_auth=...; HttpOnly; Secure; SameSite=None
                ▼
   browser cookie jar  (opaque to JS, never visible to user)
```

The auth tag is what makes this *authenticated* encryption — modifying any byte of `iv`, `tag`, or `ciphertext` causes the decrypt step to throw, which the code catches and returns `{}` (treat as no auth). You get confidentiality and integrity in one primitive.

### Move 2 — the step-by-step walkthrough

#### Skeleton parts — what breaks if missing

The irreducible kernel has four parts. Pull any one and the pattern collapses.

```
  Skeleton — encrypted state cookie

  ┌──────────────────────────────────────────────────┐
  │  1. KEY DERIVATION                               │
  │     SHA-256(AUTH_SECRET) → 32 bytes              │
  │     missing? AES-256 needs exactly 32 bytes;     │
  │       any length string in / fixed-length out    │
  ├──────────────────────────────────────────────────┤
  │  2. RANDOM IV PER ENCRYPT                        │
  │     randomBytes(12) on every encrypt             │
  │     missing? IV reuse → GCM is BROKEN — XORing   │
  │       two ciphertexts under the same key+IV      │
  │       leaks the plaintext XOR. Catastrophic.     │
  ├──────────────────────────────────────────────────┤
  │  3. AUTH TAG VERIFY ON DECRYPT                   │
  │     setAuthTag(tag) before decipher.final()      │
  │     missing? Encryption-without-authentication   │
  │       lets the attacker flip ciphertext bits to  │
  │       corrupt the plaintext shape. The tag is    │
  │       what makes this BAD-input safe.            │
  ├──────────────────────────────────────────────────┤
  │  4. WIRE FORMAT (iv || tag || ciphertext)        │
  │     base64url single string, single cookie       │
  │     missing? Storing iv/tag separately means     │
  │       any mismatch on subsequent reads silently  │
  │       fails decrypt. One blob is simpler and     │
  │       atomic.                                    │
  └──────────────────────────────────────────────────┘
```

Below each part is real, and below each you can name what specifically breaks. That's the test for whether it belongs in the skeleton.

#### Step 1 — derive the key from `AUTH_SECRET`

The operator sets `AUTH_SECRET` to some string. The crypto needs exactly 32 bytes. `SHA-256(secret)` gives you 32 bytes regardless of the input length. That's it — there's no PBKDF2, no scrypt, no Argon2. The assumption is `AUTH_SECRET` is already high-entropy (the `.env.example` says `openssl rand -base64 32` which gives 256 bits of entropy).

```
  Key derivation — the one-liner

   AUTH_SECRET = "some_random_32_or_more_bytes"
         │
         │  createHash('sha256').update(secret).digest()
         ▼
   key = <32 bytes>                ← passed to AES-256-GCM
```

What breaks if `AUTH_SECRET` is weak: the key is still 32 bytes, encryption still "works," but an attacker who steals a cookie value and knows the secret can decrypt offline. The `aesKey` function doesn't enforce length — `AUTH_SECRET=password` is silently accepted. That's the medium-severity finding C3 from the audit.

#### Step 2 — encrypt with a fresh random IV

GCM is a *stream-cipher mode* — IV reuse under the same key is **catastrophic**. So every encrypt generates a new IV with `randomBytes(12)`. 12 bytes is the AES-GCM standard (96 bits — enough collision resistance for billions of encrypts under one key).

```
  encryptStore — pseudocode

  encryptStore(store):
    iv     = randomBytes(12)
    cipher = createCipheriv('aes-256-gcm', key, iv)
    enc    = update(JSON.stringify(store), 'utf8')
            + cipher.final()
    tag    = cipher.getAuthTag()                ← 16 bytes
    return base64url(iv || tag || enc)
```

Each cookie is encrypted independently. There's no key rotation that could lead to IV-collision risk because every encrypt picks a fresh random IV anyway.

#### Step 3 — decrypt with auth-tag verification

The decrypt path unpacks the three parts from the blob, re-creates the AES-GCM context, sets the auth tag (this is what tells the cipher "verify this MAC during decrypt"), and finalizes. **`decipher.final()` throws if the auth tag doesn't verify** — and the code catches and returns `{}`.

```
  decryptStore — pseudocode

  decryptStore(token):
    try:
      buf      = base64url.decode(token)
      iv       = buf[0..12]
      tag      = buf[12..28]
      enc      = buf[28..]
      decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)                ← BEFORE .final()
      plain    = update(enc) + final()        ← THROWS on bad tag
      return JSON.parse(plain)
    catch:
      return {}                                ← tamper, rotated key, corrupt → no auth
```

What breaks if you skip the auth tag: an attacker can flip bits in the ciphertext to alter the decrypted JSON. Without authentication, AES-CTR-mode (what GCM is built on) lets you XOR your delta in directly. With GCM the tag catches it; without GCM you'd need a separate HMAC step. GCM combines both in one primitive.

#### Step 4 — orchestrate per-request via `withAuthCookies`

Here's the load-bearing trick that makes this work on Next.js. Next has a request-vs-response cookie split — `cookies().get(name)` reads the *request* cookie; `cookies().set(name, value)` writes to the *response* cookie; a `.get` after a `.set` in the same request returns the OLD value. The MCP SDK's `OAuthClientProvider` calls things like `state()`, `saveCodeVerifier()`, `clientInformation()`, `saveTokens()` multiple times across one OAuth round-trip. If every one of those reads/writes hit the cookie directly, the second `state()` call would see stale data.

`withAuthCookies` solves this by **decrypting once at request start, holding the state in an AsyncLocalStorage-scoped store for the body of the request, and flushing once at the end if anything changed.** The provider's many synchronous read/write calls hit the ALS store; the cookie is touched twice total per request.

```
  withAuthCookies — request lifecycle

   request start
        │
        │ raw = cookies().get('bi_auth')
        │ ctx = { store: decryptStore(raw), dirty: false }
        ▼
   requestStore.run(ctx, async () => {
        ▼
        ┌─ handler / provider code ──────────────────┐
        │  reads → ctx.store[sessionId]              │
        │  writes → ctx.store[sessionId] = ...;      │
        │           ctx.dirty = true                  │
        └─────────────────────────────────────────────┘
        ▲
   })   │
        │
        │ if ctx.dirty:
        │   cookies().set('bi_auth', encryptStore(ctx.store), opts)
        ▼
   request end
```

The `dirty` flag is the optimization that matters: if a request didn't touch auth state, the cookie isn't re-set (saves the `Set-Cookie` header and the encrypt CPU). The full pattern is two cookie touches per request maximum: one read, one optional write.

The pattern uses `AsyncLocalStorage` (Node 16+) — concurrent requests on one serverless instance get separate ALS contexts, so they never share state. This is the synchronization primitive that holds the whole thing together. See `02-als-scoped-request-store.md` for the depth there.

#### Step 5 — provider as the SDK shape

The MCP SDK expects an `OAuthClientProvider` with methods like `tokens()`, `saveTokens()`, `codeVerifier()`, `clientInformation()`. The `BloomreachAuthProvider` implements that shape by routing every method through `readState` and `patchState` helpers that operate on the runtime store (cookie in prod, file in dev, `Map` in test). The SDK doesn't know or care about cookies — it just calls the provider methods.

```
  Provider shape — per-method behaviour

  SDK calls                 our code does
  ─────                     ─────
  state()                    randomUUID + patchState({state})
  saveCodeVerifier(v)        patchState({codeVerifier: v})
  codeVerifier()             readState().codeVerifier
  clientInformation()        readState().clientInformation
  saveClientInformation(i)   patchState({clientInformation: i})
  tokens()                   readState().tokens
  saveTokens(t)              patchState({tokens: t})
  redirectToAuthorization(u) lastAuthorizeUrl = u   ← captured, NOT opened
```

The `redirectToAuthorization` deviation from the SDK's default (open a browser) is critical: we capture the URL so the route handler can return it to the client for a full-page redirect — there's no `window.open` available on the server.

#### Code in this codebase

The two load-bearing functions live side-by-side in `lib/mcp/auth.ts`. The crypto primitives (lines 51–79) and the per-request orchestrator (lines 86–104). Read them with the annotation, then read the three use-cases below to see how they compose end-to-end.

```
  lib/mcp/auth.ts  (lines 51–79)

  function aesKey(): Buffer {
    const secret = process.env.AUTH_SECRET;          ← env-only; never client
    if (!secret) {
      throw new Error('AUTH_SECRET is required in production...');
    }
    return createHash('sha256').update(secret).digest();  ← 32 bytes for AES-256
  }
       │
       └─ no length check — that's the C3 finding;
          a one-line `if (secret.length < 32) throw ...` closes it

  function encryptStore(store: Store): string {
    const iv = randomBytes(12);                       ← FRESH IV every encrypt
    const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
    const enc = Buffer.concat([
      cipher.update(JSON.stringify(store), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
  }                                                    ↑
                                                       │
                              wire format: iv(12) | tag(16) | ciphertext

  function decryptStore(token: string): Store {
    try {
      const buf = Buffer.from(token, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', aesKey(), buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));      ← MUST set BEFORE final()
      const plain = Buffer.concat([
        decipher.update(buf.subarray(28)),
        decipher.final(),                              ← THROWS on bad tag
      ]).toString('utf8');
      return JSON.parse(plain) as Store;
    } catch {
      return {};                                       ← tamper / rotated / corrupt
    }                                                   ↑
  }                                                    │
                                                       └─ this catch is what makes
                                                          tampering "fail safely" —
                                                          you never get auth without
                                                          a valid tag
```

```
  lib/mcp/auth.ts  (lines 86–104)

  export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
    if (process.env.NODE_ENV !== 'production') return fn();    ← dev uses file
    const { cookies } = await import('next/headers');
    const raw = (await cookies()).get(AUTH_COOKIE)?.value;
    const ctx: RequestStore = {
      store: raw ? decryptStore(raw) : {},               ← decrypt ONCE
      dirty: false,
    };
    const result = await requestStore.run(ctx, fn);      ← ALS-scoped run
    if (ctx.dirty) {                                     ← flush only if changed
      (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
        httpOnly: true,         ← JS can never read; XSS exfil contained
        secure: true,           ← never sent over HTTP
        sameSite: 'none',       ← survives the cross-site OAuth round-trip
        path: '/',
        maxAge: AUTH_COOKIE_MAX_AGE,   ← 10 days
      });
    }
    return result;
  }
       │
       └─ this is the ENTIRE "session persistence" mechanism on Vercel.
          no Redis, no DB, no server-side cache. one cookie, one ALS context.
```

**Use case 1 — fresh browser hits `GET /api/briefing`.** No `bi_auth` cookie. `withAuthCookies` reads empty, `ctx.store = {}`. The route calls `connectMcp(sid)` which constructs `BloomreachAuthProvider(sid, redirectUri)` and asks the SDK to connect. The SDK calls `clientInformation()` → empty → triggers DCR. DCR returns client info, SDK calls `saveClientInformation(info)` → `patchState({clientInformation: info})` → `ctx.dirty = true`. The SDK then calls `state()` and `saveCodeVerifier()`. Eventually it calls `redirectToAuthorization(url)` — we capture the URL, throw `UnauthorizedError` to escape the SDK flow, and the route returns `{ needsAuth: true, authUrl }`. On the way out, `withAuthCookies` encrypts the now-populated store and sets `bi_auth`.

**Use case 2 — `GET /api/mcp/callback?code=...`.** Browser has `bi_auth` from step 1. `withAuthCookies` decrypts → `ctx.store[sessionId]` has DCR + verifier + state. Route calls `completeAuth` which feeds the code back through the SDK. The SDK calls `codeVerifier()` → reads from store → exchanges the code for tokens → calls `saveTokens(tokens)`. On the way out, the cookie is re-encrypted with the new tokens. Future requests will find `tokens()` populated.

**Use case 3 — `AUTH_SECRET` rotated to a new value.** Operator changes the env var in Vercel. New deploy goes live. Every browser's existing `bi_auth` cookie was encrypted with the OLD key. The next request hits `withAuthCookies` → `decryptStore(raw)` → the new key fails the auth tag → catch block returns `{}`. The user appears unauthenticated, the route returns `needsAuth: true`, the user re-authenticates. This is the no-graceful-rotation gap from audit finding C4.

### Move 3 — the principle

**State that has to survive across requests on a stateless host has to live somewhere the host doesn't own.** The browser cookie is that somewhere. Encryption + authentication is what makes the cookie safe to be in untrusted hands. The pattern works because the entire flow can be reconstructed from the cookie alone — no server-side index, no Redis lookup, no database row to join. Stateless servers + stateful clients = encrypted cookies.

---

## Primary diagram

The full encrypted-cookie pattern in one frame, from operator-set `AUTH_SECRET` to per-request runtime.

```
  Encrypted cookie OAuth state — full topology

  ┌─ Operator (deploy time) ───────────────────────────────────────┐
  │  Vercel project env var                                         │
  │    AUTH_SECRET = "openssl rand -base64 32"  (256 bits entropy)  │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ process.env.AUTH_SECRET
                                 ▼
  ┌─ Crypto layer  (lib/mcp/auth.ts L51–L79) ──────────────────────┐
  │                                                                  │
  │  aesKey()        SHA-256(secret) → 32 bytes                     │
  │  encryptStore(s) iv=rand(12) | tag=GCM-mac | enc=AES-256-GCM    │
  │  decryptStore(t) verify tag → JSON.parse(plain) OR return {}    │
  │                                                                  │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ used only by ↓
                                 ▼
  ┌─ Runtime layer  (lib/mcp/auth.ts L86–L104) ────────────────────┐
  │                                                                  │
  │  withAuthCookies(fn):                                            │
  │    request start: ctx = { store: decryptStore(cookie), dirty }   │
  │    requestStore.run(ctx, fn)         ← ALS-scoped                │
  │    request end:   if ctx.dirty: cookies.set(encryptStore(...))   │
  │                                                                  │
  │  cookie flags: httpOnly · Secure · SameSite=None · maxAge=10d   │
  │                                                                  │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ inside fn, called many times
                                 ▼
  ┌─ Provider layer  (lib/mcp/auth.ts L160–L218) ──────────────────┐
  │                                                                  │
  │  BloomreachAuthProvider implements OAuthClientProvider           │
  │    state() / saveTokens() / codeVerifier() / clientInformation() │
  │    each → readState/patchState against the ALS store             │
  │    redirectToAuthorization(url) → capture, don't open            │
  │                                                                  │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ MCP SDK drives PKCE + DCR
                                 ▼
  ┌─ Bloomreach IdP ───────────────────────────────────────────────┐
  │  validates authorize / token / refresh requests                  │
  └─────────────────────────────────────────────────────────────────┘
```

After the response goes out, the cookie holds the full updated state — DCR client info, PKCE code_verifier, OAuth tokens — all encrypted, all on the browser. The next request reconstructs the in-memory store from scratch.

---

## Elaborate

### Where this pattern comes from

**Encrypted cookies as session storage** have been around since the early signed-cookie days, but the modern shape — AES-GCM with a derived key, single base64url blob, per-request decrypt-and-flush — became prevalent with serverless. The canonical reference is the **iron-session** library (and the older Ruby `Rack::Session::Cookie`). The discipline is identical: cookies become the canonical session store for hosts that have no place to put server-side session data.

**NIST SP 800-38D (2007)** specifies AES-GCM. The key sizes (128 / 192 / 256), the IV length (12 bytes recommended), the tag length (96-128 bits) are all there. The critical warning from the spec, restated many times in the literature: *never reuse an IV under the same key*. The reason `randomBytes(12)` is non-negotiable.

**AsyncLocalStorage** (Node 13.10+, stable in 16) is the JS equivalent of Java's `ThreadLocal` for the async-await world. It's what lets us hold the per-request `RequestStore` without passing it through every function call. Without ALS, the cookie-orchestration pattern would either need to be passed explicitly (ugly) or use a global (broken under concurrency).

### The deeper principle

**Confidentiality + integrity in one primitive beats two primitives joined by hand.** A naive design would be `encrypt(data) || hmac(encrypt(data))` — separate AES-CTR and HMAC steps. That works *if* you remember to verify the HMAC *before* decrypting (the "encrypt-then-MAC" rule), use independent keys for each, and use a constant-time compare on the MAC. GCM does all of that internally. Picking AES-GCM is picking "one correct primitive" over "two primitives with three correct-usage rules."

```
  Why GCM beats hand-rolled AES + HMAC

   hand-rolled                              GCM
   ─────                                   ─────
   pick AES mode (CTR)                     "aes-256-gcm"
   pick HMAC algorithm (HMAC-SHA-256)
   derive two independent keys              one key, internal
   encrypt-then-MAC (not MAC-then-encrypt)  internal
   constant-time HMAC compare               internal
   verify MAC before decrypt                internal
   ────────────────────────────────────    ─────
   5 correct-usage rules                    1 correct-usage rule
                                            (don't reuse IV)
```

### Where it could improve in this codebase

1. **No `AUTH_SECRET` strength enforcement** — the C3 finding. Two-line fix: `if (secret.length < 32) throw new Error('AUTH_SECRET must be at least 32 chars')` in `aesKey`. Defends against `AUTH_SECRET=password`.

2. **No graceful rotation** — the C4 finding. Add a key-version byte prefix to the encrypted payload, a `AUTH_SECRET_OLD` env var, and a decrypt path that tries new-then-old. Rotation becomes a transition window instead of a one-way break.

3. **No nonce-misuse-resistant variant** — AES-GCM-SIV (RFC 8452) is the modern replacement that survives IV reuse. Not needed here because `randomBytes(12)` is genuinely random, but worth knowing exists.

4. **No key separation per cookie purpose** — if a future feature added a second encrypted cookie (say, for encrypted user preferences), it would share `AUTH_SECRET`. A proper key-derivation step (`hkdf(AUTH_SECRET, "bi_auth_v1")`) would domain-separate them. Today there's only one encrypted cookie so this is hypothetical.

### Connection to adjacent patterns

The encrypted cookie *requires* an orchestration layer to be usable from Next handlers — that's `withAuthCookies`, which in turn requires AsyncLocalStorage to safely hold per-request state. See `02-als-scoped-request-store.md` for that piece. The cookie content is consumed by `BloomreachAuthProvider`, which is the OAuth-client-provider shape; the broader OAuth + PKCE + DCR flow lives in `.aipe/study-system-design/02-oauth-boundary.md`.

---

## Interview defense

**What they are really asking:** can you explain why the cookie *is* the session, what authenticated encryption gives you over signed cookies, and what specifically happens when something tampers with the cookie value?

---

**[mid] — How does the auth session survive on Vercel serverless?**

It survives in one cookie. `bi_auth` is an AES-256-GCM-encrypted JSON blob holding the per-session OAuth state — DCR client info, PKCE code_verifier, access token, refresh token. The key is derived `SHA-256(AUTH_SECRET)`. Every encrypt uses a fresh 12-byte random IV. The wire format is `base64url(iv || tag || ciphertext)`. The cookie is httpOnly + Secure + `SameSite=None`, maxAge 10 days.

The orchestration is `withAuthCookies` in `lib/mcp/auth.ts`. It reads the cookie once at request start, decrypts into an AsyncLocalStorage-scoped store, runs the handler, and if anything wrote to the store, re-encrypts and sets the cookie on the way out. The MCP SDK's OAuthClientProvider hits the ALS store through `readState`/`patchState` — never touches the cookie directly. That's what avoids Next's request-vs-response cookie split.

```
  one cookie · one decrypt-once · one optional flush

  cookies.get('bi_auth')          ↓
   → decryptStore                 ↓
   → requestStore.run(ctx, fn)    ↓
   → fn does its work             ↓
   → if dirty: encryptStore + cookies.set
```

---

**[senior] — Walk me through what happens when an attacker flips a byte in the bi_auth cookie value.**

They send the request. The route enters `withAuthCookies`. It reads the cookie, base64url-decodes into a buffer, splits into `iv` (12 bytes), `tag` (16 bytes), and `ciphertext`. Creates the AES-256-GCM decipher with `aesKey()`. Calls `setAuthTag(tag)` — this tells the cipher what MAC to verify against. Calls `update(ciphertext)` and `final()`. **The `final()` call throws an `Error: Unsupported state or unable to authenticate data`** because GCM's auth-tag verification failed — even one bit flipped in the ciphertext changes the computed MAC, and the comparison fails.

The catch block returns `{}`. From the route's point of view, the user is now unauthenticated. `connectMcp` finds no tokens, returns `needsAuth: true` with a fresh OAuth URL. The attack didn't break anything — it just logged the attacker out of whatever session they were trying to forge into. The integrity guarantee is structural: there's no path where tampered ciphertext decrypts to attacker-controlled JSON, because the cipher won't emit plaintext at all without a valid tag.

```
  tampered cookie → catch block → no auth → re-OAuth

   incoming:    iv | tag | ciphertext  (one bit flipped somewhere)
   step 1:      decipher.setAuthTag(tag)
   step 2:      decipher.update(ciphertext)
   step 3:      decipher.final()    ★ THROWS — tag mismatch
   catch:       return {}             "treat as no auth"
   route:       return { needsAuth: true, authUrl }
```

---

**[arch] — Why AES-GCM and not JWT or HMAC-signed cookies?**

Three reasons. **Confidentiality.** A JWT is base64-decodable — the claims are plaintext to anyone who steals the cookie. For OAuth tokens, that's catastrophic; the attacker reads the tokens directly. AES-GCM ciphertext is opaque to the browser and to anyone who intercepts the cookie (even with the connection compromised — though TLS handles that layer).

**Single primitive for integrity.** GCM's auth tag does the same job as the JWT signature: tampering breaks decryption (vs. tampering breaks signature verification on JWT). But GCM combines it with the encryption pass — one round of cipher work, one MAC. Hand-rolling AES-CTR + HMAC means picking two algorithms, deriving two keys, ordering them correctly (encrypt-then-MAC), and constant-time comparing the MAC. GCM bakes all of that in.

**Right shape for the data.** JWT is designed for cross-domain identity claims with a public-key option. We have neither — the issuer and verifier are the same process, the audience is the same process, the algorithm is symmetric. A symmetric-key authenticated encryption blob is the right tool for "encrypted blob the server reads back."

```
  JWT                          encrypted cookie (AES-GCM)
  ─────                        ─────
  base64(header).body.sig      base64url(iv||tag||ciphertext)
  body PLAINTEXT to holder     body OPAQUE to holder
  sig is HMAC or asymmetric    tag is GCM MAC (one primitive)
  tampering → bad sig          tampering → decrypt throws
  designed for federated id    designed for server-to-server
                               via cookie
```

The trade-off: JWT is debuggable from the browser DevTools (claims visible); AES-GCM cookies are not. For our use case — OAuth tokens — opacity is a feature.

---

**The dodge — "what about replay attacks? Could the attacker just resend an old cookie?"**

Yes, they could. The cookie carries no nonce or timestamp inside the encrypted payload that the server checks against a replay-tracking store. The defenses are upstream and around: the access token inside has its own Bloomreach-side expiry (so a cookie that's been replayed past the token's lifetime fails at the MCP call); the cookie's own `maxAge` is 10 days so the browser stops sending it after that; and revoking the OAuth token at Bloomreach renders the cookie useless even if it's still being replayed.

What we don't have is true rotation — no token-rotation-on-use that invalidates older copies. For a single-user demo, this is accepted risk. For a multi-tenant production system, a server-side token-version table that the cookie carries would be the next-mile move.

---

**One-line anchors:**
- AES-256-GCM gives confidentiality and integrity in one primitive — the auth tag is what makes tampering fail safely.
- `withAuthCookies` decrypts once at request start, holds state in ALS, flushes once at end if dirty — Next's cookie split never bites.
- Stateless server + encrypted cookie = the canonical serverless session pattern.
- The `decryptStore` catch returning `{}` is the structural defense against tampered cookies — bad ciphertext can't produce attacker-controlled JSON.

---

---

## See also

→ [audit.md](./audit.md) · [02-als-scoped-request-store.md](./02-als-scoped-request-store.md) · [03-type-guard-trust-boundary.md](./03-type-guard-trust-boundary.md)

Cross-reference: `.aipe/study-system-design/02-oauth-boundary.md` — the OAuth + PKCE + DCR flow that produces the state stored in this cookie.
