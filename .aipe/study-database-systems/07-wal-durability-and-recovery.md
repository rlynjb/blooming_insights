# WAL, durability, and recovery — the auth cookie story

*Industry standard / Project-specific* — there's no write-ahead log and no recovery for user data. The only state the repo durably protects is the OAuth session, stored as an AES-256-GCM-encrypted cookie. That cookie is the closest thing the repo has to a WAL, with an explicit dirty bit and a single flush per request.

## Zoom out, then zoom in

A WAL exists to make this promise: *"if you said COMMIT, the change survives a crash."* This repo makes that promise for exactly one thing — the user's Bloomreach OAuth session. Everything else (the briefing, the investigations, the cache, the workspace schema) is treated as cheap to recompute. Lose your auth and you have to redo the OAuth dance. Lose your briefing and you click "refresh."

```
  Zoom out — where this concept lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  feed renders; "session expired" panel on 401             │
  └────────────────────────────┬─────────────────────────────┘
                               │  HTTP (with cookies)
  ┌─ Service layer ────────────▼─────────────────────────────┐
  │  withAuthCookies(() => connectMcp(sid))                  │
  │     ┌──────────────────────────────────────┐             │
  │     │  read bi_auth cookie                  │             │
  │     │  AsyncLocalStorage-scoped Store       │             │
  │     │  ★ provider does many reads/writes ★   │ ← we are here
  │     │  flush encrypted cookie if dirty      │             │
  │     └──────────────────────────────────────┘             │
  └────────────────────────────┬─────────────────────────────┘
                               │  Set-Cookie: bi_auth=<ciphertext>
  ┌─ Storage layer ────────────▼─────────────────────────────┐
  │  browser cookie store (httpOnly, secure, SameSite=None)  │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the cookie is the only state in this repo that survives a Vercel cold start, an instance recycle, a deploy, a process OOM. Everything else dies and is recomputed. The mechanism that makes this work is `withAuthCookies` in `lib/mcp/auth.ts`, which uses AES-256-GCM, an AsyncLocalStorage-scoped store, and an explicit `dirty` bit.

## Structure pass

**Layers:**

```
  L1  HTTP request boundary       cookie comes in, cookie goes out
  L2  withAuthCookies wrapper     ALS-scoped store, dirty bit
  L3  BloomreachAuthProvider      MCP SDK interface, many read/write calls
  L4  encryptStore / decryptStore AES-256-GCM, SHA-256(AUTH_SECRET) key
```

**Axis traced: durability — what survives what?**

```
  Trace one axis: what survives each failure mode?

  ┌─ session state Map ─────────────────────┐
  │  in-process only                         │   → dies on instance recycle
  └──────────────────────────────────────────┘
                  (it flips)
  ┌─ response cache ────────────────────────┐
  │  in-process, 60s TTL                     │   → dies on recycle OR TTL
  └──────────────────────────────────────────┘
                  (it flips)
  ┌─ bi_auth cookie ────────────────────────┐
  │  client-side, AES-encrypted, 10 days      │   → survives recycle, deploy,
  │                                          │     OOM, browser restart
  └──────────────────────────────────────────┘

  the seam between in-process and cookie is where the durability story flips
```

**Seams** — one matters:

- The `withAuthCookies` boundary is where in-memory state becomes durable. Inside the wrapper everything looks like a normal `Map`; outside it the state is ciphertext in a cookie. The single flush at the end of the wrapper is the "commit" point.

## How it works

### Move 1 — the mental model

A WAL says "write your intent before you write the state, so if you crash mid-state-write you can recover from the intent log." The cookie here doesn't do *that* exactly — it's not a log, it's the state itself, encrypted. But it has the WAL's load-bearing property: **one flush per transaction, atomic from the reader's perspective.** Either the new cookie is set or it isn't; there's no half-written cookie.

```
  Cookie-as-WAL — read once, mutate in memory, flush once

       request in (with bi_auth cookie)
              │
              ▼
       ┌──────────────────────────────────┐
       │ decrypt cookie → Store (the state) │
       │ run handler                        │
       │   provider.tokens()  → reads Store │
       │   provider.saveTokens(t)           │
       │     → mutates Store, dirty = true  │
       │   provider.codeVerifier() → reads  │
       │   ... (many more reads/writes)     │
       │ if dirty:                          │
       │   encrypt Store → Set-Cookie       │   ◄── the "commit"
       └──────────────────────────────────┘
              │
              ▼
       response out (with new bi_auth)
```

That's the kernel: ONE read at the start, many in-memory mutations, ONE write at the end. The cookie is never written mid-handler; if the handler throws, nothing flushes.

### Move 2 — the durability mechanism, one part at a time

#### The wrapper — `withAuthCookies`

```typescript
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
      sameSite: 'none',
      path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE,
    });
  }
  return result;
}
```

Four moves:

1. Read cookie once (`(await cookies()).get(AUTH_COOKIE)?.value`).
2. Decrypt → an in-memory `Store`. Wrap it in a `RequestStore` with `dirty: false`.
3. Run the handler under `requestStore.run(ctx, fn)` — the `AsyncLocalStorage` makes `ctx` visible to every nested function call without threading it through args.
4. If anything inside `fn` set `dirty = true`, re-encrypt and write the cookie. Otherwise leave it untouched.

The dev/test branches (`PERSIST` flag at `lib/mcp/auth.ts:34`) use a file (`.auth-cache.json`) or in-memory Map respectively — same interface, simpler backends.

#### The dirty bit — why it matters

```typescript
// lib/mcp/auth.ts:125-131 (writeAll, abbreviated)
function writeAll(store: Store): void {
  const ctx = requestStore.getStore();
  if (ctx) {
    ctx.store = store;
    ctx.dirty = true;     // ← every write sets the bit
    return;
  }
  // ... dev/test branches
}
```

Every mutation routes through `writeAll`, which sets `dirty = true`. Reads via `readAll()` don't touch the bit. So the cookie only gets re-encrypted when the handler actually changed something — saving the CPU cost of AES-256-GCM + the bandwidth of a Set-Cookie header on read-only requests.

#### Why ALS, not request-arg threading

The Next.js cookie API has a known gotcha: `cookies().get(...)` after a `cookies().set(...)` in the same request returns the OLD value, not the just-set one. If the auth provider's many `tokens()` / `saveTokens()` calls each touched the cookie API directly, that bug would land repeatedly.

The fix is to never touch the cookie API except at the request boundaries. AsyncLocalStorage lets `BloomreachAuthProvider`'s methods (`tokens()`, `saveTokens()`, `clientInformation()`, `saveClientInformation()`, `codeVerifier()`, `saveCodeVerifier()`) all hit the ALS-scoped Map without knowing a cookie exists. The comment at `lib/mcp/auth.ts:38-45` documents this explicitly.

```
  Why ALS — avoiding Next's get-after-set bug

  WITHOUT ALS (naive):
    provider.tokens()        → cookies().get(...) → reads old
    provider.saveTokens(t)   → cookies().set(...) → updates response
    provider.tokens()        → cookies().get(...) → reads OLD again ← bug

  WITH ALS:
    provider.tokens()        → ctx.store.tokens
    provider.saveTokens(t)   → ctx.store.tokens = t; ctx.dirty = true
    provider.tokens()        → ctx.store.tokens ← sees the update
    ← flush at the boundary writes the new cookie once
```

#### The crypto — AES-256-GCM under `AUTH_SECRET`

```typescript
// lib/mcp/auth.ts:51-79 (key derivation + encrypt + decrypt)
function aesKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is required in production...');
  return createHash('sha256').update(secret).digest();  // 32 bytes → AES-256
}

function encryptStore(store: Store): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

function decryptStore(token: string): Store {
  try {
    const buf = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', aesKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as Store;
  } catch {
    return {};  // tampered, rotated-secret, or corrupt cookie → treat as no auth
  }
}
```

Three details worth pulling out:

- **Random 12-byte IV per encryption** — prevents two identical stores from producing the same ciphertext. Critical for GCM.
- **Auth tag stored inline** — the `setAuthTag(buf.subarray(12, 28))` on decrypt validates that the cookie wasn't tampered with. A modified cookie throws and the catch returns `{}`, which the rest of the code treats as "no auth" → kick the user to re-OAuth.
- **Key rotation just works** — change `AUTH_SECRET` and every existing cookie decrypts to `{}` because the auth tag fails. Users re-OAuth; no migration script needed. This is the closest thing to "graceful recovery" in the whole repo.

#### What's NOT durable — the explicit decisions

- **Session feed (`sessionState`)** — dies on instance recycle. Why: a briefing is cheap to re-run (≤30s), the alpha server rate-limits per user globally so persisting and replaying might cost more than just re-querying.
- **Response cache** — dies on recycle or 60s TTL. Why: it's an optimization, not a source of truth.
- **Workspace schema (`bootstrapSchema`'s cached value)** — dies on recycle. Why: 4 sequential MCP calls to rebuild; bounded cost.
- **Investigations** — die on recycle in production; dev has a gitignored file cache (`.investigation-cache.json` at `lib/state/investigations.ts:8`). Why: same as briefing — cheap to re-run.

#### Recovery — none for user data, automatic for auth

The repo has one recovery path: the auto-reconnect on `invalid_token` error (`app/page.tsx` resets auth and reloads once, guarded — described in `.aipe/project/context.md` under "Auto-reconnect"). That's the recovery from "the alpha server revoked your token after minutes." It re-runs the OAuth dance, writes a new bi_auth cookie, and the user's feed is back.

For everything else: clicking "refresh" re-runs the briefing. There's no recovery because there's no log to recover from.

### Move 3 — the principle

A durability story is not a yes/no — it's a per-piece-of-state decision. The repo's choice for each piece is honest: "if losing this costs the user a 30-second re-run, don't pay for durability." The one piece that *would* cost the user a multi-minute OAuth dance got the full treatment (AES-GCM, atomic flush, dirty bit, key rotation that gracefully degrades). The discipline isn't "durability everywhere" or "durability nowhere"; it's "durability matched to recovery cost."

## Primary diagram

```
  Durability + recovery — what survives what, and how

  ┌─ in-process (dies on recycle) ──────────────────────────┐
  │  sessionState Map           ← recovery: click refresh    │
  │  response cache             ← recovery: rebuild on demand│
  │  workspace schema cache     ← recovery: re-bootstrap     │
  │  investigation cache (dev)  ← recovery: re-run agent     │
  └──────────────────────────────────────────────────────────┘

  ┌─ filesystem (dies on deploy) ───────────────────────────┐
  │  lib/state/demo-*.json      ← recovery: re-capture       │
  └──────────────────────────────────────────────────────────┘

  ┌─ bi_auth cookie (THE durability story) ─────────────────┐
  │                                                           │
  │  request in ──► decrypt(cookie) ──► Store                 │
  │                       │                                   │
  │                       ▼                                   │
  │                ALS-scoped Map                             │
  │                       │                                   │
  │                  many provider                            │
  │                  reads/writes                             │
  │                       │                                   │
  │                       ▼                                   │
  │                if dirty:                                  │
  │                  encrypt(Store) ──► Set-Cookie            │
  │                       │                                   │
  │                       ▼                                   │
  │                response out                               │
  │                                                           │
  │  guarantees:                                              │
  │    AES-256-GCM (confidentiality + integrity)              │
  │    random IV per write                                    │
  │    auth tag validation                                    │
  │    one flush per request (atomic from reader)             │
  │    key rotation degrades to re-OAuth (no migration)       │
  │    httpOnly + secure + SameSite=None (cross-site OAuth)   │
  │    10-day MaxAge                                          │
  └──────────────────────────────────────────────────────────┘

  recovery model:
    auth → auto-reconnect on invalid_token (single guarded retry)
    data → re-run the agent
```

## Elaborate

The reason this design works is the **stateless-by-default Vercel function model**. Vercel doesn't promise instance affinity, doesn't promise warm starts, doesn't promise local disk persistence beyond the build. Any state you want to survive across requests has to either go in the database (none here), in the cookie (auth tokens here), or in an external store (none here). The cookie path is the cheapest of those — no extra infrastructure, no extra cost, scales horizontally for free.

Compare to Postgres's WAL: there the log records every change before applying it; on crash recovery the engine replays the log forward to bring the data files up to date. This cookie design has no replay because there's no "data file" separate from the log — the cookie IS the data, fully self-contained. That works because the data is tiny (a few hundred bytes of encrypted JSON) and self-sufficient (everything needed to reconstruct the session is in it).

If the repo ever needs to durably store user data (insights, investigations), the natural extension is: keep the cookie for auth, add a real KV store for data. Splitting auth from data lets you swap the data store without re-encrypting cookies. Today there's no need.

## Interview defense

**Q: What's the durability story for this app?**

One piece of state is durable: the `bi_auth` cookie. Everything else dies on Vercel cold start and gets recomputed. The cookie holds the OAuth session (client info, tokens, PKCE verifier, CSRF state) under AES-256-GCM, keyed off `AUTH_SECRET`. The wrapper at `lib/mcp/auth.ts:86` reads it once at the request start, runs the handler under AsyncLocalStorage so the auth provider can do many reads/writes against an in-memory store, then re-encrypts and writes back ONCE at the end — only if a dirty bit got set.

**Q: Why a dirty bit?**

To skip the encrypt + Set-Cookie on read-only requests. Most agent flows touch `tokens()` but never call `saveTokens()` — so the cookie stays untouched. Without the dirty bit, every request would burn AES-GCM cycles and a Set-Cookie header on responses that didn't need them.

**Q: What's the recovery model?**

Two paths. For auth, the auto-reconnect: when a tool call returns `invalid_token` (the alpha server revokes tokens after minutes), the UI resets auth and reloads once. The fresh OAuth dance writes a new cookie. For everything else, the recovery is "click refresh and re-run the briefing." There's no log to replay because there's nothing valuable enough to log. That's a deliberate choice — a briefing costs ≤30s to redo, and the alpha server's rate limits make persistence-and-replay more expensive than just re-querying.

**Q: What happens if you rotate `AUTH_SECRET`?**

Every existing cookie's auth-tag validation fails on the next decrypt, the catch at `lib/mcp/auth.ts:76` returns `{}`, the handler sees "no auth," and the user is sent through the OAuth dance to re-authenticate. There's no migration script, no downtime, no data loss. That's the closest the repo gets to "graceful recovery on schema change" — and it works precisely because the cookie is self-contained.

## See also

- `01-database-systems-map.md` — where this cookie sits among the four storage analogs (L4)
- `02-records-pages-and-storage-layout.md` — the session-state that does NOT have this durability story
- `08-replication-and-read-consistency.md` — the demo snapshot as the other "survives a deploy" thing
- `09-database-systems-red-flags-audit.md` — the risk if `AUTH_SECRET` is ever missing in prod
