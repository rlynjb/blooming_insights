# Encrypted auth cookie

**Authenticated Encryption (AEAD) over an httpOnly cookie** (Industry-standard primitive, project-specific binding).

## Zoom out — where this concept lives

This is the production OAuth-token store. On Vercel, the `connect` and `callback` requests run on different ephemeral instances; a browser cookie is the only state both can see. The cookie carries the per-session auth state — PKCE verifier, DCR client info, and OAuth tokens.

```
  Zoom out — where the encrypted cookie sits

  ┌─ Browser ────────────────────────────────────────────┐
  │  bi_session (UUID, httpOnly)                          │
  │  bi_auth    (AES-256-GCM ciphertext, httpOnly)        │ ← we are here
  └──────────────┬────────────────────────────────────────┘
                 │   hop 1: Cookie: bi_session=...; bi_auth=...
                 ▼
  ┌─ Next.js routes ──────────────────────────────────────┐
  │  withAuthCookies(() => …)                              │
  │   ├─ decrypt cookie once → ALS RequestStore             │
  │   ├─ all provider methods read/write the ALS store       │
  │   └─ encrypt + set cookie once if dirty                 │
  └───────────────────────────────────────────────────────┘
```

## Structure pass

**Axes:** trust (the cookie is server-issued ciphertext; the browser can't read or forge it), state (the server is otherwise stateless across instances), failure (a tampered cookie decrypts to "no auth").

**Layers (outer → inner):**
- HTTP cookie layer — httpOnly + Secure + SameSite=None.
- Cryptographic layer — AES-256-GCM, 12-byte random IV per encryption, GCM auth tag.
- Per-request layer — `AsyncLocalStorage` (`RequestStore`) so many provider-method calls don't multiplex the cookie.

**Seam:** the `withAuthCookies` wrapper is the seam — it converts "cookie I/O across many synchronous calls" into "decrypt once → ALS context → encrypt once if dirty." The OAuthClientProvider's many `tokens() / saveTokens() / state() / saveCodeVerifier()` calls run inside that ALS context and never touch `cookies()` themselves.

**Axis flip at the seam:** outside `withAuthCookies`, state lives in the cookie (per-instance, no shared state). Inside, it lives in the ALS context (per-request, shared between provider-method calls). This is why a naive "set cookie on every save" wouldn't work — Next's request-vs-response cookie split would return the stale value on a read-after-set within the same request.

## How it works

### Move 1 — the mental model

Think of the cookie as a serialized session — encrypted server-side, ferried by the browser, decrypted only at the start of each request. The mental shape: **one decrypt at request entry; one encrypt at request exit; everything in between is local-process state.**

```
  Pattern — encrypted-cookie session shape

  request in ─┐
              ├─► decrypt cookie ─► ALS store ─► many R/W ─► encrypt → set-cookie ─┐
                  (once per req)      (in-mem        (the                              │
                                       per req)       provider)                        ▼
                                                                          response out
```

If you've ever used a signed session cookie (Express `cookie-session`, NextAuth's JWT session), it's that — with AEAD encryption added so the cookie body is opaque, not just tamper-evident.

### Move 2 — the step-by-step walkthrough

#### Key derivation (`aesKey`)

The AES-256 key is the SHA-256 of `AUTH_SECRET`:

```ts
// lib/mcp/auth.ts:51-60
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

**Why a hash instead of a KDF (PBKDF2 / Argon2 / scrypt)?** Because `AUTH_SECRET` is a server-issued random secret, not a user password — `openssl rand -base64 32` (per `.env.example`). The slow-KDF stretching exists to make low-entropy passwords expensive to brute-force; high-entropy random secrets don't benefit from stretching. SHA-256 is a deterministic transform to the right byte length.

**What breaks if `AUTH_SECRET` rotates:** all existing cookies fail to decrypt → `decryptStore` catches and returns `{}` → users re-auth. Graceful, not catastrophic.

#### AEAD encryption (`encryptStore`)

GCM mode (Galois Counter Mode) is the AEAD here — it provides both *confidentiality* (the store JSON is opaque) and *authenticity* (the auth tag detects tampering).

```ts
// lib/mcp/auth.ts:62-67
function encryptStore(store: Store): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}
```

**Cookie payload layout (base64url-encoded):**

```
  bytes:  0 .... 11 | 12 ............... 27 | 28 ...........
  field:  IV (12)   | GCM auth tag (16)     | ciphertext
```

The 12-byte IV is the GCM standard (96 bits). It's freshly random per encryption — load-bearing for GCM's security; reusing an IV with the same key is catastrophic (it leaks the keystream). The auth tag is 16 bytes (the default).

**What breaks if the IV is static:** GCM degenerates — XOR of two ciphertexts equals XOR of plaintexts. An attacker who sees two cookie values can recover both plaintexts modulo their XOR.

**What breaks if the auth tag is omitted:** the cookie is malleable — an attacker can flip ciphertext bits and the decrypt won't notice. With the tag, a single flipped bit fails verification.

#### Decryption (`decryptStore`)

Symmetric reverse of the above; the `catch` returns `{}` so a tampered/rotated-secret cookie behaves like "no auth":

```ts
// lib/mcp/auth.ts:69-79
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

**Why catch broadly:** anything in here that throws (truncated cookie, wrong-length IV, GCM tag mismatch, JSON parse error after a successful decrypt that happens to look like garbage) is "the cookie isn't trustworthy." The right behavior is the same as "no cookie" — the next OAuth flow re-seeds the store.

#### Per-request store (`AsyncLocalStorage`)

The OAuth SDK calls `provider.tokens()`, `saveTokens()`, `state()`, `saveCodeVerifier()`, and `codeVerifier()` multiple times per flow. Touching the cookie on each call would hit Next's *request-vs-response cookie split* (a read after a set returns the OLD value within the same request).

```ts
// lib/mcp/auth.ts:46-47
interface RequestStore { store: Store; dirty: boolean }
const requestStore = new AsyncLocalStorage<RequestStore>();
```

`withAuthCookies` decrypts once at entry, stages a `RequestStore`, runs the inner work under `requestStore.run(ctx, fn)`, and encrypts back at exit if the work mutated the store:

```ts
// lib/mcp/auth.ts:86-104
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
      httpOnly: true,
      secure: true,
      sameSite: 'none',         // survives the IdP return; pairs with bi_session
      path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

**Concurrency note:** ALS is per-async-context. Two concurrent requests on one warm Node process each get their own `RequestStore` and never share state. The outer `state.Map` in `lib/state/insights.ts` is the only cross-request store, and it's keyed by session ID.

**What breaks if `withAuthCookies` is skipped:** the provider's reads return `{}` and the OAuth handshake fails halfway — `connect` would save the PKCE verifier, but `callback` (running on a different instance, no cookie context) wouldn't find it. The dev-file backend masks this locally because the file is shared across processes.

#### Cookie attributes — `bi_auth`

```ts
// lib/mcp/auth.ts:93-101
{
  httpOnly: true,          // JS can't read it (defense against XSS exfil)
  secure: true,            // HTTPS-only
  sameSite: 'none',        // sent on cross-site (the IdP return is cross-site)
  path: '/',
  maxAge: 60 * 60 * 24 * 10,   // 10 days, matches token lifetime
}
```

**Why SameSite=None and not Lax?** The OAuth round-trip from the Bloomreach IdP to `/api/mcp/callback` is cross-site. SameSite=Lax can drop the cookie on that return in some browsers; SameSite=None + Secure keeps it. The cost: any cross-origin request with credentials carries the cookie, so CSRF mitigations move from "rely on SameSite" to "check `Sec-Fetch-Site` / use a CSRF token" — which is the open hole flagged in `audit.md` § 8 row 9.

### Move 3 — the principle

**Make the cookie the session.** When you can't keep state in process memory (ephemeral functions) and you don't want to add Redis/KV for one cookie's worth of data, encrypt the session into the cookie itself. The browser ferries it; AEAD makes it both opaque and tamper-evident; ALS keeps the in-request mutations cheap. The constraint that forces this design — "different requests run on different machines" — also makes the choice obvious once you stop trying to use server memory as if it were sticky.

## Primary diagram

```
  Encrypted-cookie session — one round trip

  ┌─ Browser ───────────────────────────────────────────────┐
  │                                                          │
  │  Cookie: bi_session=<uuid>; bi_auth=<base64url>          │
  │                                                          │
  └────────────────────┬─────────────────────────────────────┘
                       │ hop 1: HTTPS
                       ▼
  ┌─ Vercel function instance (any) ────────────────────────┐
  │  withAuthCookies(() => ...)                              │
  │                                                          │
  │   1. read bi_auth                                        │
  │   2. base64url-decode → [IV | tag | ciphertext]          │
  │   3. decryptStore → Store (or {} on failure)             │
  │   4. requestStore.run({store, dirty:false}, fn)          │
  │           │                                              │
  │           ▼                                              │
  │       OAuthClientProvider                                │
  │           ├─ tokens() / saveTokens()                     │
  │           ├─ state() / saveCodeVerifier()                │
  │           └─ clientInformation()                         │
  │           ▲                                              │
  │           │ all R/W hit the ALS store, not the cookie    │
  │           ▼                                              │
  │   5. if ctx.dirty → encryptStore + cookies().set()       │
  │                                                          │
  └──────────────────────┬───────────────────────────────────┘
                         │ hop 1 (response): Set-Cookie
                         ▼
                  browser updates bi_auth
```

## Elaborate

The pattern is **encrypted session cookies** — common in stateless web architectures. NextAuth, iron-session, and Rack::Session::Cookie all implement variants of it. The choice between encrypted (AEAD) and signed (HMAC) comes down to whether the payload needs confidentiality. Here it does: the payload contains OAuth access/refresh tokens. A signed-only cookie would let the browser see the tokens (XSS exfil even with httpOnly, via service workers, browser extensions, or a misconfigured proxy).

The ALS-scoped store is a runtime-systems primitive — Node's `AsyncLocalStorage` is the same shape as Java's `ThreadLocal` for async contexts. It gives you per-request scope without threading the context through every function signature.

The historical drift this codebase fought through: an earlier version persisted to an in-memory Map. That works in dev (one process) and breaks in production (the `connect` and `callback` land on different instances). The dev/test/prod three-backend split in `lib/mcp/auth.ts:34-47` is the residue of that fight — keep the dev path simple (file), keep the test path isolated (Map), spend the complexity on the production path that has to work across instances.

## Interview defense

**Q: Why AES-256-GCM specifically?**
**A:** GCM is an AEAD mode — confidentiality and authenticity in one primitive. The alternative is encrypt-then-MAC (AES-CBC + HMAC), which works but is two primitives to compose correctly. AEAD removes the "did I do MAC-then-encrypt or encrypt-then-MAC?" footgun. AES-256 specifically because the key derives from `AUTH_SECRET` via SHA-256 → 32 bytes, which is exactly the AES-256 key length, no truncation needed.

```
  AEAD = confidentiality + authenticity, one primitive
  encrypt-then-MAC: two primitives, must compose correctly
```

**Q: Why a random IV per encryption?**
**A:** GCM's security model assumes IVs are unique per key. Reusing an IV under the same key is the canonical GCM footgun — it leaks the XOR of the two plaintexts and degrades the auth tag. 12 random bytes per encryption (the GCM-standard length) gives 2^96 IVs before birthday-bound collisions become a real concern. We rotate cookies on every write anyway.

**Q: What about the cookie size limit?**
**A:** Browsers cap cookies around 4KB. The store contains: DCR client info (~500B), OAuth tokens (~2KB combined for access + refresh + id), PKCE verifier (~50B). Comfortably under the cap. If the store grew (e.g., per-user analytics state), we'd push it to a session backend (KV/Redis) and keep the cookie as a session ID — the current design is the right one for the data it carries.

**Q: What happens if `AUTH_SECRET` is rotated?**
**A:** Every existing cookie fails to decrypt → `decryptStore` returns `{}` → users see the OAuth flow as if they'd never logged in. Graceful degradation, but no live-session preservation across the rotation. For zero-downtime rotation you'd run two secrets (current + previous) and try both on decrypt, then only encrypt with the current. Not implemented; not needed for this app's deployment cadence.

## See also

- `02-oauth-pkce-dcr-boundary.md` — what the cookie *contains* and how it gets populated.
- `06-session-isolation.md` — how the cookie's identity (`bi_session`) keys per-session state.
- `05-secret-redaction.md` — the sibling control that keeps the tokens out of logs even when they're in memory.
- `audit.md` § 4 (Secrets and configuration), § 2 (Authentication).
- `lib/mcp/auth.ts:48-104` — the canonical implementation.
- `test/mcp/auth.test.ts:112-` — the `_authCookieCrypto` round-trip test.
