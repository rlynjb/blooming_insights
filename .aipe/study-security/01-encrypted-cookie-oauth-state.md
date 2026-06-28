# 01 · encrypted-cookie-oauth-state

**Encrypted client-side session** · Industry standard
(authenticated-encryption cookie store, AES-256-GCM)

## Zoom out — where this lives

The OAuth tokens have to live *somewhere* the route can read. On Vercel
there's no shared store — no Redis, no SQL, no sticky sessions. Two
requests in a row may land on two ephemeral instances. The browser is
the only thing that sees both.

```
  Zoom out — the token store, by environment

  ┌─ UI ─────────────────────────────────────────────────┐
  │ React feed                                            │
  └────────────────────────┬──────────────────────────────┘
                           │  bi_session + bi_auth cookies (HTTPS)
  ┌─ Service ──────────────▼──────────────────────────────┐
  │ Next.js route handlers (ephemeral, no shared memory)  │
  │                                                       │
  │     ┌─────────────────────────────────────────────┐   │
  │     │  ★ AES-256-GCM cookie store (production) ★  │   │ ← we are here
  │     │  • file (dev) · in-memory Map (test)         │   │
  │     └─────────────────────────────────────────────┘   │
  └────────────────────────┬──────────────────────────────┘
                           │  Bearer <access_token> (decrypted)
  ┌─ Provider ─────────────▼──────────────────────────────┐
  │ Bloomreach loomi-mcp-alpha                            │
  └───────────────────────────────────────────────────────┘
```

The pattern: **the cookie *is* the store.** Encrypted on the way out,
decrypted on the way in, no server-side state to lose between
requests.

## Structure pass — what this is made of, where its joints are

  → **Layers.** Three nested abstractions: the browser holds the
    opaque ciphertext; the route handler holds the decrypted
    `Store` (JSON map of `{sessionId → tokens|clientInformation|…}`)
    for the lifetime of one request; the SDK's `OAuthClientProvider`
    interface holds named getters/setters (`tokens()`,
    `saveTokens()`, …) on top of that store.

  → **Axis to hold constant: "where does the secret live, and who can
    read it?"**

    ```
      altitude              who can read?
      ──────────────────    ─────────────────────────────
      browser (cookie)      cookie value is opaque (GCM
                            ciphertext + 12-byte IV +
                            16-byte tag, base64url)
      route handler         the AES key (sha256 of
                            AUTH_SECRET) + the request's
                            own cookie → plaintext Store
      SDK provider          getters/setters on a Store
                            scoped to one sessionId
    ```

    The answer flips at each altitude: opaque → plaintext-but-scoped
    → field-by-field.

  → **Seams.** Two load-bearing joints:
    - **cookie ↔ Store** (`encryptStore` / `decryptStore`,
      `lib/mcp/auth.ts:62-79`). Tampering corrupts the auth tag;
      `decryptStore` swallows the throw and returns `{}` — the user
      is *de-authed*, not impersonated.
    - **Store ↔ OAuthClientProvider** (`BloomreachAuthProvider` class,
      `lib/mcp/auth.ts:160-218`). The SDK doesn't know about cookies;
      it calls `provider.tokens()` and `provider.saveTokens(t)`. The
      provider reads/writes `Store[sessionId]`.

## How it works

### Move 1 — the mental model

Think of it like `localStorage`, but the browser can't read it and a
server tamper-check rejects any change. JSON object →
JSON.stringify → AES-256-GCM encrypt → base64url → cookie value. Reverse
on the way in.

```
  the pattern — authenticated-encryption cookie

  ┌─ plaintext Store ──────────────────────────────┐
  │ { "<sid>": {                                    │
  │     clientInformation: { client_id, … },        │
  │     tokens: { access_token, refresh_token, … }, │
  │     codeVerifier: "…", state: "…"               │
  │   } }                                           │
  └────────────┬────────────────────────────────────┘
               │
               │  JSON.stringify
               ▼
  ┌─ AES-256-GCM ─────────────────────────────────┐
  │  IV (12B random) · tag (16B) · ciphertext      │
  └────────────┬───────────────────────────────────┘
               │  Buffer.concat → base64url
               ▼
  ┌─ Set-Cookie: bi_auth=… ───────────────────────┐
  │  httpOnly · secure · SameSite=None · maxAge=10d│
  └────────────────────────────────────────────────┘
```

The encryption isn't there to hide the *existence* of OAuth tokens —
it's so the cookie can't be tampered with. GCM gives you confidentiality
AND integrity in one primitive; a single bit-flip in the ciphertext or
the auth tag is detected, the decrypt throws, the user re-auths.

### Move 2 — the step-by-step walkthrough

#### a · the AES key derivation

`AUTH_SECRET` is whatever the operator sets in Vercel. It might be a
long random string, it might be 12 ASCII chars. AES-256 needs exactly
32 bytes. `aesKey()` runs sha256 over the secret to land on 32 bytes
no matter what was set.

```
  derive — sha256 as a key-derivation shim

  AUTH_SECRET (any length)
        │
        │  sha256
        ▼
  32-byte digest  ← used as the AES-256 key
```

Real code (`lib/mcp/auth.ts:51-60`):

```ts
function aesKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {                                        // ← fail closed in prod
    throw new Error(
      'AUTH_SECRET is required in production to encrypt the auth cookie. ' +
        'Set it in your Vercel project environment variables.',
    );
  }
  return createHash('sha256').update(secret).digest();  // ← 32 bytes → AES-256
}
```

What breaks if removed: drop the throw and the route encrypts under a
deterministic key (e.g. the zero key if you `??` to empty string), and
every user's cookie is decryptable by anyone who can guess the
fallback. Drop the sha256 wrap and an operator who sets a 12-char
secret gets a crash (`Invalid key length`) on first request — UX bug,
not a security bug, but a deploy-time failure either way.

(Note: sha256-as-KDF is fine for a server-set high-entropy secret
because `AUTH_SECRET` *is* the master key. If you ever derived it from
a low-entropy source — a password — swap to scrypt/PBKDF2. Not a
concern for this app's deploy model.)

#### b · encrypt — IV + ciphertext + tag, packed flat

GCM is an AEAD cipher: it produces ciphertext PLUS a 16-byte auth tag.
The IV (96-bit random per call) is *not* secret but MUST be unique per
encrypt — repeating an IV under the same key catastrophically breaks
GCM. `randomBytes(12)` per call gives birthday-bound uniqueness across
any realistic number of writes.

```
  the encrypt layout — one cookie value, three pieces

  ┌─ 12 bytes ─┬─ 16 bytes ──┬─ N bytes ─────────────────┐
  │  IV        │  auth tag   │  ciphertext (JSON.stringify│
  │  (random)  │  (GCM)      │  of the Store)             │
  └────────────┴─────────────┴────────────────────────────┘
                │
                │  base64url (URL-safe, no padding)
                ▼
       Set-Cookie: bi_auth=<base64url>
```

Real code (`lib/mcp/auth.ts:62-67`):

```ts
function encryptStore(store: Store): string {
  const iv = randomBytes(12);                                                  // ← fresh per call
  const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');  // ← IV + tag + ct
}
```

What breaks if removed: drop the random IV and reuse a fixed one →
GCM nonce reuse, two cookies under the same key leak their XOR.
Drop the tag → no integrity check, an attacker can flip ciphertext
bytes and the route happily reads garbage tokens. Drop the
`base64url` and the cookie value contains characters the browser
truncates or refuses.

#### c · decrypt — fail closed on tamper

```
  decrypt — split, verify, parse, OR catch → empty

  ┌─ cookie value ──┐
  │ base64url string│
  └────────┬────────┘
           │
           ▼
  ┌─ unpack ────────────┐
  │ IV  = buf[0..12]    │
  │ tag = buf[12..28]   │     mismatch?
  │ ct  = buf[28..end]  │ ──────► throw ──► catch ──► return {}
  └────────┬────────────┘                    (treat as no auth)
           ▼
  ┌─ AES-256-GCM ───────┐
  │ setAuthTag(tag)     │
  │ update(ct).final()  │ ──► plaintext JSON ──► JSON.parse ──► Store
  └─────────────────────┘
```

Real code (`lib/mcp/auth.ts:69-79`):

```ts
function decryptStore(token: string): Store {
  try {
    const buf = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', aesKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as Store;
  } catch {
    return {}; // tampered, rotated-secret, or corrupt cookie → treat as no auth
  }
}
```

What breaks if removed: drop the `try/catch` → any tamper or
`AUTH_SECRET` rotation throws a 500 instead of degrading to "log in
again." The `{}` return is the load-bearing part — it's how the
system handles every failure mode (rotated key, corrupt bytes, old
cookie format, attacker bit-flips) uniformly: send the user back
through OAuth.

#### d · cookie attributes — why SameSite=None

```
  cookie set — every flag matters

  Set-Cookie: bi_auth=<ciphertext>;
              httpOnly;     ← JS can't read (XSS doesn't steal tokens)
              secure;       ← HTTPS only
              SameSite=None;← survives the Bloomreach → callback round-trip
              path=/;
              max-age=864000 ← 10 days, matches refresh-token lifetime
```

Real code (`lib/mcp/auth.ts:93-101`):

```ts
(await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
  httpOnly: true,
  secure: true,
  // SameSite=None so the PKCE verifier + client info survive the cross-site
  // OAuth return from the IdP to /api/mcp/callback (matches bi_session).
  sameSite: 'none',
  path: '/',
  maxAge: AUTH_COOKIE_MAX_AGE,
});
```

What breaks if removed: drop `SameSite=None` and the Bloomreach
callback navigation (`bloomreach.com → /api/mcp/callback`) drops the
cookie in current browsers — the PKCE verifier saved during `/connect`
isn't there when `/callback` tries to exchange the code. The flow
appears to work in dev (same origin) and silently breaks in prod.

#### e · the environment split — why three backends

```
  cookie vs file vs Map — the backend selector

  process.env.NODE_ENV         backend                     reason
  ──────────────────────       ────────────────────────    ─────────────────────
  'production'   (Vercel)      AES-256-GCM cookie store    no shared memory
                                                            across instances
  'development'  (local)       .auth-cache.json file       Next dev re-evaluates
                                                            modules; a Map would
                                                            wipe mid-OAuth-flow
  'test'         (vitest)      in-memory Map               isolated per run
```

Real code (`lib/mcp/auth.ts:34-36`):

```ts
const PERSIST = process.env.NODE_ENV === 'development';
const CACHE_FILE = join(process.cwd(), '.auth-cache.json');
const memStore = new Map<string, SessionAuthState>();
```

What breaks if removed: collapse dev to in-memory Map → the OAuth
round-trip fails because Next.js re-evaluates `lib/mcp/auth.ts` on
file save (which any hot-reload triggers), wiping the saved PKCE
verifier between `/connect` and `/callback`. The file backend
exists *specifically* for dev because of that.

### Move 3 — the principle

When you don't control the runtime's persistence (Vercel functions,
edge workers, any "stateless" platform), the **browser cookie is your
shared store.** Authenticated encryption turns it into a tamper-proof
client-side session: confidentiality + integrity in one primitive
(GCM), the user as your delivery mechanism, fail-closed on any decrypt
error. Same shape as JWE (encrypted JWT), same shape as Django's
signed-cookie sessions, same shape as Rails encrypted cookies — the
primitive transfers.

## Primary diagram

```
  the full flow — connect → encrypt → cookie → request → decrypt → use

  ┌─ /api/mcp/connect ──────────────────┐
  │ withAuthCookies(() => connectMcp()) │
  │   1. read bi_auth from request      │
  │   2. decrypt → Store                │
  │   3. ALS.run(ctx, fn)                │
  │   4. provider.state/saveTokens/…    │
  │      all write to ctx.store         │
  │   5. if ctx.dirty: encrypt + set    │
  └─────────────────┬───────────────────┘
                    │ Set-Cookie: bi_auth=<ciphertext>
                    ▼
  ┌─ browser ───────────────────────────┐
  │ holds opaque base64url string       │
  └─────────────────┬───────────────────┘
                    │ Cookie: bi_auth=<ciphertext>
                    ▼
  ┌─ /api/agent (next request) ─────────┐
  │ withAuthCookies(...)                │
  │   1. decrypt → Store with tokens    │
  │   2. provider.tokens() → access_tok │
  │   3. MCP SDK adds Bearer header     │
  │   4. call Bloomreach                │
  └─────────────────────────────────────┘
```

## Elaborate

The pattern is old. RFC 5077 (TLS session tickets) is the same shape:
the server can't keep session state, so it hands the client an
encrypted-and-MAC'd blob the client returns next time. JWE
(RFC 7516) generalizes it. Django and Rails ship it as the default
session backend. The MCP SDK in this repo uses a different shape (a
`OAuthClientProvider` interface that calls back into your storage), so
the cookie store has to live on the *outside* of the SDK — wrapped by
`withAuthCookies`, exposed to the SDK as a synchronous in-memory
`Store`. The ALS context is how that wrapping holds together for a
single request — see `02-als-scoped-request-store.md`.

The trade you accept: cookie size. A full `Store` for one session
runs ~2KB; under five concurrent OAuth flows you'd still be under
8KB (the browser limit). If you ever store more (per-session
preferences, a draft, an inbox) → move to a server-side store,
because the cookie *is* the message you're sending on every
request.

## Interview defense

### Q1. "Why not just use a JWT?"

```
  JWT vs encrypted cookie — what the AEAD step changes

  JWT (JWS)           encrypted cookie (this app)
  ─────────────       ───────────────────────
  signed              encrypted AND authenticated
  payload visible     payload opaque
  good for handing    good when even the existence
  things to other     of fields shouldn't leak
  services            (refresh tokens, code_verifier)
```

A signed JWT proves the server issued it; anyone with the cookie can
read the claims. We're storing the actual OAuth tokens — refresh
token, access token, PKCE verifier. Those are sensitive. AEAD
(GCM) gives us tamper-detection AND confidentiality with one
primitive. The same JWT-shape trick with JWE would work too; the cost
is the spec surface (which we didn't need — we own both ends).

**One-line anchor:** "AEAD gives us tamper-detection AND
confidentiality in one primitive; signing alone would expose the
refresh token to anyone with the cookie."

### Q2. "What happens if you rotate AUTH_SECRET?"

```
  rotation — every old cookie decrypts to {} → 401 → re-auth

  ┌─ old AUTH_SECRET ──┐                  ┌─ new AUTH_SECRET ─┐
  │ key = sha256(old)  │                  │ key = sha256(new) │
  └─────────┬──────────┘                  └─────────┬─────────┘
            │                                       │
   old cookie encrypted ──────► next request ──────►│
   with old key                                     │
                                              decrypt throws
                                              → catch → return {}
                                              → no tokens → 401
                                              → /api/mcp/connect
                                              → re-OAuth
                                              → new cookie under new key
```

Every user is logged out, and the next request triggers re-OAuth.
That's by design — `decryptStore` swallows the throw and returns `{}`,
which is identical to "this user never logged in." Operationally:
rotate in a low-traffic window, accept one round of re-auths.

**One-line anchor:** "Decrypt failure returns `{}`, same code path as
'never logged in' — rotation costs one re-auth per active user."

### Q3. "What stops me from copying the cookie and impersonating someone?"

Nothing — this is a session cookie, and any session cookie can be
replayed by someone who has it. The protections are operational:

  → `httpOnly` so XSS can't read it from JavaScript.
  → `Secure` so it only rides HTTPS.
  → `SameSite=None` is the weak point — required for the OAuth
    cross-site return, but it does mean the cookie rides on every
    cross-origin request to our domain. Paired with the session id
    being a UUIDv4 (`crypto.randomUUID()` in `lib/mcp/session.ts:19`)
    and a 10-day max-age, the practical threat is cookie theft on the
    user's own machine — same threat model as any web app.

**One-line anchor:** "Same as any session cookie — httpOnly + Secure
+ random UUID session id, accept SameSite=None as the cost of the
OAuth return path."

## See also

  → `02-als-scoped-request-store.md` — how the SDK's many sync
    `state()` / `saveTokens()` calls inside one request all see the
    same decrypted Store, with a single encrypt+flush at the end.
  → `audit.md` § lens 2 (authentication-and-authorization) and § lens
    4 (secrets-and-configuration) for the wider context.
  → `study-system-design/` — the same boundary, viewed under control
    + state axes instead of trust.
