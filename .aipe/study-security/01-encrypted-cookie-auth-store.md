# Encrypted-cookie auth store

## Subtitle

Encrypted-cookie session (AES-256-GCM with request-scoped store) · Industry standard (encrypted-cookie pattern), Project-specific implementation (`bi_auth` + `withAuthCookies`)

---

## Zoom out — where this concept lives

You need somewhere to keep the OAuth tokens and PKCE verifier between the `connect` and `callback` requests. In a Node process with a real database you'd write them to a table. On Vercel's ephemeral serverless runtime, the `connect` request and the `callback` request may run on different instances that share no memory — the only thing they both see is the browser's cookie jar.

So the auth store *is* a cookie. Encrypted, because it holds live tokens.

```
  Zoom out — where the auth store sits

  ┌─ Browser layer ─────────────────────────────────┐
  │  cookie jar   →  bi_session (UUID, plain)        │
  │                  bi_auth    (AES-256-GCM cipher) │ ← ★ THIS CONCEPT ★
  └─────────────────────────┬────────────────────────┘
                            │  HTTP request
                            │  (both cookies ride along)
  ┌─ Service layer ─────────▼────────────────────────┐
  │  next/headers cookies() → withAuthCookies() →     │
  │  ALS-scoped RequestStore → BloomreachAuthProvider │
  │  provider.tokens() / saveTokens() etc.            │
  └─────────────────────────┬────────────────────────┘
                            │
                            ▼
                     OAuth flow to Bloomreach
```

Every request the trusted core handles decrypts the cookie once at entry, hands the resulting `Store` object to the OAuth provider for the duration of the request, and re-encrypts it once at exit if anything changed. Nothing in between touches the cookie directly.

---

## Structure pass — layers, axis, seams

**Layers.** Browser cookie → Next `cookies()` API → `withAuthCookies` ALS scope → `BloomreachAuthProvider` OAuth methods → the MCP SDK.

**Axis: state ownership.** Who owns the tokens at each layer?

- Browser: owns the ciphertext, doesn't know the key.
- Next.js `cookies()`: reads and writes the ciphertext string.
- `withAuthCookies`: owns the *decrypted* store for the request duration. This is the seam where trust flips.
- `BloomreachAuthProvider`: reads and writes fields on the store like it's a regular object.

**Seams.** Two matter:

1. **Cookie ↔ ALS store** — encrypt/decrypt boundary. Ciphertext outside, plaintext inside. The GCM auth tag catches tampering.
2. **ALS store ↔ provider methods** — the provider makes many synchronous `readState` / `patchState` calls per request; each one hits the ALS-scoped store, not the cookie API. This exists to sidestep Next's request-vs-response cookie split — writing then reading in the same request would return the old value.

Hand off to How it works.

---

## How it works

### Move 1 — the mental model

You know how a JWT is "a signed thing the client holds and the server validates on every request"? This is the same idea, but instead of a signature that lets the server *verify* the content, it's an encryption that lets the server *hold state* in the client's cookie jar. The server owns the key; the client owns the ciphertext.

The pattern's shape:

```
  Encrypted-cookie session — the pattern

  request enters
       │
       ▼
  ┌─────────────────────────┐
  │ read bi_auth cookie      │
  │ decrypt → Store object   │  ← plaintext, request-scoped
  └────────────┬─────────────┘
               │  ALS.run(ctx, fn)
               ▼
  ┌─────────────────────────┐
  │ fn() runs, provider does │
  │ many read/write calls    │  ← all hit ctx.store
  │ ctx.dirty = true if any  │
  │ write happened           │
  └────────────┬─────────────┘
               │  after fn() returns
               ▼
  ┌─────────────────────────┐
  │ if ctx.dirty:            │
  │   encrypt ctx.store      │
  │   set bi_auth cookie     │
  └─────────────────────────┘
               │
               ▼
  response leaves
```

### Move 2 — walkthrough

**The key.** `aesKey()` derives a 32-byte AES-256 key from `AUTH_SECRET` via a single SHA-256 hash. This is *not* a KDF (no salt, no iterations) — it's a hash-based normalization that turns whatever ceremony people used to set `AUTH_SECRET` into exactly 32 bytes. What breaks if you skip it: a `AUTH_SECRET` of the wrong byte length throws inside `createCipheriv`. What breaks if `AUTH_SECRET` is unset: the function throws with a real message pointing at Vercel env vars — this is a "fail loud in prod" gate.

**File:** `lib/mcp/auth.ts`
**Function:** `aesKey`
**Line range:** 51-60

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

The trust assumption: `AUTH_SECRET` has enough entropy to resist offline attack on a leaked cookie. If it's `password123` you lose every cookie. The fix if that assumption ever wobbles: rotate `AUTH_SECRET`, all existing cookies decrypt to `{}` (`decryptStore`'s catch branch, line 76-78) which surfaces as "no auth" and forces re-login. The comment on line 77 names this exact behavior.

**The wrapper (encrypt).** GCM needs three things: a fresh 12-byte IV per encryption, the key, and to expose its auth tag after `final()`. The pattern here is: layout `iv | tag | ciphertext` and base64url-encode the whole thing.

```
  Layout of the bi_auth cookie value

  ┌─ 12 bytes ─┬─ 16 bytes ─┬─ N bytes ─┐
  │    IV      │  auth tag  │ ciphertext │  → base64url encode → cookie
  └────────────┴────────────┴────────────┘
                     ▲
                     └── GCM's tamper detector
```

**File:** `lib/mcp/auth.ts`
**Function:** `encryptStore` / `decryptStore`
**Line range:** 62-79

Reading the decrypt path top-down: pull the 12-byte IV off the front, the 16-byte tag next, hand both to `createDecipheriv` + `setAuthTag`, then `update` + `final` the remaining ciphertext. If the tag doesn't match (tampering, wrong key), `final()` throws — the outer `try` catches it and returns `{}`. The reader sees "no auth" and re-authenticates. Silent-fail here is the right call because any louder response would let an attacker probe for the tampering error to distinguish cases.

**The ALS scope.** The load-bearing part. Next's cookie API has a quirk: within one request, a `.set()` followed by a `.get()` returns the OLD value. The MCP SDK's OAuth provider makes many `.tokens()` / `.saveTokens()` calls per flow. If each mapped to a cookie read/write, half of them would see stale state.

**File:** `lib/mcp/auth.ts`
**Function:** `withAuthCookies`
**Line range:** 86-104

```
  ALS request scope — the seam that fixes the request/response split

  ┌─ withAuthCookies ─────────────────────────────────────┐
  │                                                        │
  │  1. cookies().get('bi_auth')            once per req   │
  │     → decrypt → ctx.store                              │
  │                                                        │
  │  2. requestStore.run(ctx, fn)                          │
  │     ┌───────────────────────────────────────────────┐  │
  │     │  fn() calls provider.tokens()  → ctx.store    │  │
  │     │  provider.saveTokens(t)         → ctx.store   │  │
  │     │  provider.saveCodeVerifier(v)   → ctx.store   │  │
  │     │  ctx.dirty = true                              │  │
  │     └───────────────────────────────────────────────┘  │
  │                                                        │
  │  3. if ctx.dirty: cookies().set('bi_auth', encrypt())  │
  │     once per req                                       │
  └────────────────────────────────────────────────────────┘
```

Each request gets its own `RequestStore` — an object literal — that `AsyncLocalStorage` pins to the async context. `readAll` / `writeAll` (`auth.ts:113-142`) check `requestStore.getStore()` first: if there's a context, use it; otherwise fall back to dev-file or in-memory. This is how the same `BloomreachAuthProvider` code path runs unchanged in dev (file backend) and prod (cookie backend).

What breaks if you skip the `dirty` flag: every request rewrites the cookie even on pure reads, which (a) burns bytes on the response and (b) resets the cookie expiry to `now + 10 days`, which is either what you want or not depending on your session policy. Here it's deliberately not what you want — the cookie's max-age is fixed at issue time (`AUTH_COOKIE_MAX_AGE`, line 49).

**Cookie attributes.**

**File:** `lib/mcp/auth.ts`
**Line range:** 93-101

- `httpOnly: true` — the browser JS can't read it. Rules out XSS-based token theft.
- `secure: true` — HTTPS only.
- `sameSite: 'none'` — the OAuth return from Bloomreach lands on `/api/mcp/callback` as a cross-site navigation; SameSite=Lax would sometimes drop the cookie on that return. The tradeoff: SameSite=None accepts a cookie on ANY cross-site request to your origin — CSRF surface widens. The mitigation here is that no POST endpoint on this app performs a state-mutating action against Bloomreach; `/api/mcp/reset` is idempotent state-clear (`app/api/mcp/reset/route.ts`), `/api/mcp/call` is read-only tools only (`03-read-only-tool-allowlist.md`).

**Trust assumption named:** the analyst is not being targeted by a same-origin phishing page that gets them to visit `evil.com` which POSTs to their `blooming-insights` origin. Given the deployment is currently a demo/personal app, this trades correctly. If it ever becomes multi-tenant with real customer risk, add a same-origin CSRF check.

### Move 3 — the principle

Encrypted-cookie sessions are the pattern when you want server-side state without a server-side state store. The cookie is your database row; the key is your access control. Serverless makes this the natural choice because the "server" is many ephemeral instances that agree on nothing except the browser's cookie jar. Rotate the key and every session dies; that's the design working.

---

## Primary diagram — the full pattern

The whole `withAuthCookies` request lifecycle in one frame.

```
  bi_auth over one request — end to end

  ┌─ Browser ────────────────────────────────────────────────┐
  │  Request: GET /api/mcp/callback?code=abc                  │
  │  Cookie:  bi_auth=<iv|tag|ciphertext (base64url)>         │
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ Next.js route ────────▼─────────────────────────────────┐
  │  export async function GET(req) {                         │
  │    const sid = await readSessionId();  // bi_session       │
  │    await completeAuth(sid, code);                          │
  │  }                                                         │
  │                                                            │
  │  completeAuth ──► withAuthCookies(async () => {            │
  │                                                            │
  │    ┌─ enter ─────────────────────────────────────────┐    │
  │    │ raw = cookies().get('bi_auth').value             │    │
  │    │ ctx = { store: decrypt(raw), dirty: false }      │    │
  │    │ requestStore.run(ctx, fn)                        │    │
  │    └────────────────────┬─────────────────────────────┘    │
  │                          │                                 │
  │    ┌─ during ────────────▼─────────────────────────────┐  │
  │    │ provider.codeVerifier() → ctx.store[sid].verifier │  │
  │    │ provider.saveTokens(t)  → ctx.store[sid].tokens   │  │
  │    │                            ctx.dirty = true       │  │
  │    │ SDK does its OAuth handshake                      │  │
  │    └────────────────────┬─────────────────────────────┘   │
  │                          │                                 │
  │    ┌─ exit ──────────────▼──────────────────────────────┐ │
  │    │ if (ctx.dirty)                                       │ │
  │    │   cookies().set('bi_auth', encrypt(ctx.store), {    │ │
  │    │     httpOnly, secure, sameSite:'none', maxAge:10d   │ │
  │    │   })                                                 │ │
  │    └───────────────────────────────────────────────────┘  │
  │  })                                                        │
  └────────────────────────┬──────────────────────────────────┘
                           │
  ┌─ Response ─────────────▼──────────────────────────────────┐
  │  302 → /                                                    │
  │  Set-Cookie: bi_auth=<new iv|tag|ciphertext>                │
  └────────────────────────────────────────────────────────────┘
```

---

## Elaborate

**Why not a JWT?** JWT is signed, not encrypted. It lets the client prove authenticity but see the contents. Here you want the opposite — the client *shouldn't* see the tokens. An encrypted cookie (sometimes called an "encrypted session cookie" or Rails' `signed + encrypted` cookies pattern) is the pattern.

**Why AES-256-GCM specifically?** GCM is an AEAD mode — you get confidentiality *and* authenticity in one primitive. No separate MAC step. `crypto.createCipheriv('aes-256-gcm', ...)` exposes `getAuthTag()` after `final()`; store it alongside the IV and ciphertext. The alternative — AES-CBC + HMAC — is fine but takes two primitives and one more chance to get the order wrong (encrypt-then-MAC is safe; MAC-then-encrypt has failure modes).

**Where the pattern originated.** Cookie-based session stores go back to CGI days, but the *encrypted* variant became load-bearing when serverless made stateless the default. Rails 4 built it in (`config.cookies.encrypted`); Next.js has no built-in equivalent, so you write it — this file is that write.

**Adjacent concept: `bi_session`.** `lib/mcp/session.ts` — a plain UUID cookie that keys the ALS store's `Store` object (`Record<string, SessionAuthState>`). The two cookies are complementary: `bi_session` names *which* session is speaking; `bi_auth` carries what that session's OAuth state is. `bi_session` doesn't need encryption because it's just an opaque identifier.

**What to read next in this repo:** `02-oauth-pkce-with-dcr.md` — how the OAuth flow uses this store; `06-log-secret-redaction.md` — the other half of the token-defense story (tokens can't leak into logs even when errors carry them).

---

## Interview defense

### Q: "Why not just use a database for the session store?"

**Answer:** Because the runtime is ephemeral. Vercel's `connect` request and `callback` request may run on different instances that share nothing except the browser. A database is fine — Upstash Redis, Vercel KV — but adds another point of failure and another secret to manage. The encrypted cookie is a single-file crypto-only solution: no infra, one secret, atomic rotation. The tradeoff is size — every request carries the whole store; if the store grows to megabytes, move to a DB. Right now it's the DCR client_info + tokens + PKCE verifier for one Bloomreach identity — well under 4KB.

**Anchor:** `lib/mcp/auth.ts:34-45` names all three backends and why each fits its environment.

### Q: "What's the load-bearing part of GCM here, and what breaks if you drop it?"

**Answer:** The auth tag. Encryption alone (say, AES-CTR) gives you confidentiality — an attacker can't read the tokens. But they can *flip bits* in the ciphertext; without a tag, the server decrypts something that looks structurally similar to the original and doesn't know it's been tampered with. GCM's `getAuthTag()` + `setAuthTag()` catches that: `decipher.final()` throws if the tag doesn't verify. Skip storing the tag alongside the IV and you have confidentiality without integrity — a broken cookie the server treats as valid.

**Diagram to sketch:**

```
  ┌─ 12 bytes ─┬─ 16 bytes ─┬─ N bytes ─┐
  │    IV      │  auth tag  │ ciphertext │
  └────────────┴────────────┴────────────┘
                     ▲
                 without this, tampering is silent
```

**Anchor:** `lib/mcp/auth.ts:62-79` — the tag is the middle slice of the base64url-encoded value.

### Q: "Why the ALS scope? Isn't that overkill?"

**Answer:** Because Next's `cookies().set(...)` followed by `.get(...)` in the same request returns the OLD value — the response cookie and the request cookie are separate stores. The MCP SDK's OAuth provider does *many* reads-after-writes per flow: save verifier, then read it back on the same call chain. Without ALS, half those reads return stale state and the flow breaks. The ALS store is the read-your-writes cache — one decrypt at entry, one encrypt at exit, all the reads-and-writes in between hit an object literal.

**Anchor:** `lib/mcp/auth.ts:38-45` (the comment) and `lib/mcp/auth.ts:86-104` (the implementation).

---

## See also

- `02-oauth-pkce-with-dcr.md` — the OAuth flow that populates this store
- `06-log-secret-redaction.md` — the log-side defense for the same tokens
- `audit.md` § 2 (authentication and authorization) — the lens finding for this control
- `audit.md` § 4 (secrets and configuration) — where `AUTH_SECRET` fits in the config picture
