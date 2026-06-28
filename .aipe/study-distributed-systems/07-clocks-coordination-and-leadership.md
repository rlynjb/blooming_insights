# Clocks, coordination, and leadership

**Industry name:** ephemeral compute coordination via signed cookies, AsyncLocalStorage request-scoped state, server timestamps · **Type:** Industry standard for "stateless-by-default" platforms — leader election / distributed clocks are Case B

## Zoom out, then zoom in

Verdict first: this codebase has **one real coordination problem** — Vercel's serverless instances are ephemeral and share nothing, so the OAuth `connect` request and the OAuth `callback` request may land on different instances. The fix is an AES-256-GCM encrypted cookie + AsyncLocalStorage. That's the entire "coordination" chapter that's actually exercised. Everything else (leader election, distributed locks, vector clocks, hybrid logical clocks) is **Case B — not exercised**.

```
  Zoom out — where coordination lives (and doesn't)

  ┌─ Browser ────────────────────────────────────────────────┐
  │  one tab → one session cookie → one (or more) request    │
  └────────────────────────┬─────────────────────────────────┘
                           │ cookies ride every request
  ┌─ Vercel cohort ────────▼─────────────────────────────────┐
  │  N independent instances. The ONLY thing they coordinate │
  │  on is what the user's cookie says:                      │
  │                                                           │
  │  ★ bi_auth     — encrypted DCR client info + PKCE        │ ← we are here
  │                  verifier + OAuth tokens                  │
  │  ★ bi_session  — sessionId for in-memory map lookups     │
  │                                                           │
  │  ✗ no leader election                                    │
  │  ✗ no distributed locks                                  │
  │  ✗ no consensus group                                    │
  │  ✗ no clock-skew problem (no ordering across instances)  │
  └──────────────────────────────────────────────────────────┘
```

This file is two halves: a deep walk of the cookie-as-shared-state pattern (the real one), then short Case-B notes on leadership/clocks (the absent ones).

## Structure pass

### Axis: where does state live, and who can see it?

```
  Trace "who can see this state" across the stack

  Browser            — sees: localStorage 'bi:mode', sessionStorage stashes,
                              cookies (bi_session, bi_auth, the value),
                              the JSON in ?insight= URL params

  bi_auth cookie     — sees: ONLY the request handler that decrypts it
                       (per-request, ALS-scoped) — instance A and B both can,
                       given the same cookie

  bi_session cookie  — sees: every request handler (plaintext UUID)

  Per-instance Maps  — sees: this instance's handlers only
                       (insights, investigations, schema cache)

  Bloomreach upstream — sees: the Bearer token (revealed every request)
```

The axis-answer flips dramatically across layers. The cookie is the **only** state that survives across instances. Per-instance Maps die at the boundary. That's not a bug — that's the platform.

### Seams (load-bearing boundaries)

- `withAuthCookies` (`lib/mcp/auth.ts:86`) ↔ everything inside the request. Reads the cookie ONCE at request start, flushes ONCE at end via `AsyncLocalStorage`. Drop this wrapping and the SDK's many synchronous `provider.tokens()` / `provider.saveCodeVerifier(v)` calls would each re-read the cookie and hit Next's "request-vs-response cookie split" (a read after a set in the same request returns the OLD value).
- The PKCE verifier ↔ the OAuth round-trip. Saved during `connect` on instance A, read during `callback` on instance B. The cookie is the only thing that bridges them.
- The clock readings on `lastCallAt` (`lib/data-source/bloomreach-data-source.ts:191`) ↔ rate-limit logic. These are per-instance — two instances have independent `lastCallAt`. That's why proactive spacing doesn't fully prevent rate-limit hits at scale.

### Layered decomposition: what is "consistent enough" at this layer?

```
  "Is state consistent across instances?" — held constant

  ┌─ bi_auth cookie ─────────────────────────────────────────┐
  │  YES — encrypted, signed, authoritative                   │   → coordinated
  │  any instance can decrypt and trust it                    │
  └────────────────────────┬─────────────────────────────────┘
       ┌──────────────────────────────────────────────────────┐
       │ bi_session cookie                                    │   → coordinated
       │ UUID, plaintext; the routing key for in-memory state │
       └────────────────────────┬─────────────────────────────┘
            ┌─────────────────────────────────────────────────┐
            │ per-instance Maps (insights, investigations)    │   → NOT coordinated
            │ instance A populates, instance B doesn't see it │      (the gap is real)
            └────────────────────────┬────────────────────────┘
                 ┌────────────────────────────────────────────┐
                 │ per-instance schema cache                  │   → NOT coordinated
                 │ instance B may bootstrap independently     │
                 └────────────────────────┬───────────────────┘
                      ┌───────────────────────────────────────┐
                      │ per-instance lastCallAt (rate-limit)  │   → NOT coordinated
                      │ two instances can race the rate limit │     (red flag)
                      └───────────────────────────────────────┘
```

The contrast: only the cookie is coordinated. Everything else is per-instance, which is fine when the operation is idempotent (cache, schema bootstrap) and problematic when it isn't (the rate limit — two instances could each be at ~1.1s since their last call, doubling the actual upstream rate).

## How it works

### Move 1 — the mental model

You know how a JWT carries claims so the server doesn't need to look anything up — every request is self-contained? Same idea: the `bi_auth` cookie carries the OAuth state (DCR client info + PKCE verifier + tokens) so every Vercel instance can serve any request without needing a shared database. The browser is the "shared store" because it's the only thing that's actually constant across the request span.

The twist is the **inside-a-single-request reads/writes**: the MCP SDK calls `provider.tokens()` and `provider.saveCodeVerifier(v)` synchronously, many times, during a single OAuth flow. Next.js's `cookies()` API gives you the *request* cookie on read; if you `set` during the request, the read still returns the OLD value (a `set` only affects the response). So we can't naively re-read the cookie on every method call. Solution: read once at the start, hold in an `AsyncLocalStorage`-scoped object, flush at the end.

```
  Cookie-as-shared-state kernel — the picture

       request enters
            │
            ▼
   withAuthCookies(fn) {
     raw = cookies().get('bi_auth').value
     ctx = { store: decrypt(raw) || {}, dirty: false }
            │
            ▼  ─ AsyncLocalStorage scope ─
     await requestStore.run(ctx, fn)
        │
        ▼
     provider.codeVerifier() → readState(sid).codeVerifier
                              → readAll() reads ctx.store
     provider.saveTokens(t) → patchState(sid, {tokens:t})
                            → writes ctx.store, ctx.dirty = true
        │
        ▼  ─ scope ends ─
     if (ctx.dirty) cookies().set('bi_auth', encrypt(ctx.store), {…})
   }
```

That kernel is the pattern. Everything else (the AES-256-GCM crypto, the `SameSite=None` cookie flag, the dev/test fallbacks) is hardening on top.

### Move 2 — walk the parts

#### Part: the three backends (dev / test / production)

```ts
// lib/mcp/auth.ts:34
const PERSIST = process.env.NODE_ENV === 'development';
const CACHE_FILE = join(process.cwd(), '.auth-cache.json');
const memStore = new Map<string, SessionAuthState>();
```

Three backends because three environments have different needs:

- **Dev**: gitignored file (`.auth-cache.json`). Next's dev server hot-reloads, which would wipe an in-memory Map mid-flow. Persistence to disk is what lets the DCR client info + PKCE verifier survive a hot-reload between `connect` and `callback`.
- **Test**: in-memory Map, isolated per run, with `_clearAuthStore()` for setup.
- **Production**: encrypted cookie, ALS-scoped per request.

This is the pattern: **the storage backend follows the failure mode of the runtime**. Dev needs persistence across module reloads; test needs isolation; prod needs cross-instance shared state.

#### Part: AES-256-GCM with key derived from `AUTH_SECRET`

```ts
// lib/mcp/auth.ts:51
function aesKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET is required in production to encrypt the auth cookie. ' +
      'Set it in your Vercel project environment variables.');
  }
  return createHash('sha256').update(secret).digest(); // 32 bytes → AES-256
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
    return {}; // tampered, rotated-secret, or corrupt cookie → treat as no auth
  }
}
```

The cookie layout is `iv (12) | authTag (16) | ciphertext`. AES-GCM gives both confidentiality and authenticity — a tampered cookie fails `decipher.final()` and we return `{}`, which translates to "no auth, run OAuth again." Rotating `AUTH_SECRET` has the same effect: all existing cookies decrypt to `{}`, all users re-auth.

Three details on the cookie itself:

- **`httpOnly: true`** — not readable from JS, so XSS can't exfiltrate.
- **`secure: true`** — only over HTTPS.
- **`sameSite: 'none'`** — required so the cookie survives the cross-site OAuth return from Bloomreach's IdP to `/api/mcp/callback`.

#### Part: AsyncLocalStorage — the request-scoped lens

```ts
// lib/mcp/auth.ts:46
interface RequestStore { store: Store; dirty: boolean }
const requestStore = new AsyncLocalStorage<RequestStore>();
```

ALS lets you carry context through async chains without explicit threading. In our case, it carries `{store, dirty}` so any code running inside `withAuthCookies(fn)` can read/write the same in-memory object, and a single flush at the end persists changes. Per-request isolation: two concurrent requests on the same instance each get their own ALS context, no shared state between them.

```ts
// lib/mcp/auth.ts:114
function readAll(): Store {
  const ctx = requestStore.getStore();
  if (ctx) return ctx.store; // production: ALS-scoped, cookie-backed
  if (!PERSIST) return Object.fromEntries(memStore); // test
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Store;
  } catch { /* … */ }
  return {};
}

function writeAll(store: Store): void {
  const ctx = requestStore.getStore();
  if (ctx) {
    ctx.store = store;
    ctx.dirty = true;
    return;
  }
  // … dev/test branches
}
```

`readAll` and `writeAll` are the only two functions that touch storage; they switch on backend by checking `requestStore.getStore()` first. The `dirty` flag is the optimization that avoids re-encrypting and writing a cookie when nothing changed (a pure-read request leaves `dirty: false`, so no `Set-Cookie` goes out).

```
  Execution trace — one OAuth flow across two instances

  request                                instance A          instance B
  ──────                                 ──────────          ──────────
  GET /api/briefing                      withAuthCookies:
                                          raw = cookies().get → undefined
                                          ctx = {store:{}, dirty:false}
                                          connectMcpInner(sid):
                                            provider.clientMetadata
                                            client.connect (DCR + PKCE)
                                            provider.saveClientInformation(info)
                                              → ctx.store[sid].clientInformation
                                              → ctx.dirty = true
                                            provider.saveCodeVerifier(v)
                                              → ctx.store[sid].codeVerifier
                                              → ctx.dirty = true
                                            provider.redirectToAuthorization(url)
                                              → lastAuthorizeUrl captured
                                            throws UnauthorizedError
                                          catch returns {authUrl}
                                          flush: cookies().set('bi_auth', encrypt(ctx.store))
                                                                                  ← cookie returned
   browser navigates to Bloomreach IdP                       (cookie now in jar)

  GET /api/mcp/callback?code=…           [different instance!]
                                                              withAuthCookies:
                                                               raw = cookies().get → present
                                                               ctx = {store: decrypt(raw),
                                                                       dirty: false}
                                                               completeAuth(sid, code):
                                                                 transport.finishAuth(code):
                                                                   provider.clientInformation()
                                                                     → ctx.store[sid].clientInfo
                                                                       ← survived!
                                                                   provider.codeVerifier()
                                                                     → ctx.store[sid].codeVerifier
                                                                       ← also survived!
                                                                   exchange code for tokens
                                                                   provider.saveTokens(t)
                                                                     → ctx.dirty = true
                                                               flush: cookies().set('bi_auth', encrypt)
                                                                                    ← updated cookie
```

The trace shows the load-bearing move: **state created on instance A is recovered verbatim on instance B**, with no shared database, no Redis, no Vercel KV. The cookie is the only thing both instances can see.

#### Part: server timestamps — the only "clocks" in this repo

There's no distributed clock concern because there's no ordering decision that crosses an instance. The only timestamps that matter:

- **`Insight.timestamp`** (`lib/state/insights.ts:32`) — `new Date().toISOString()` at the time the briefing ran. Server-local clock. The UI shows it as the snapshot disclosure.
- **`lastCallAt`** (`lib/data-source/bloomreach-data-source.ts:191`) — `Date.now()` for proactive rate-limit spacing. Per-instance. Used for relative timing only (`elapsed = now - lastCallAt`).
- **`expiresAt`** in the cache — `Date.now() + ttl`. Same — relative timing on the local clock.

No clock-skew problem because every comparison is local to one process. No vector clocks because there's no causality to track across processes. No hybrid logical clocks because there's no need to order events across instances.

If we ever shared the cache across instances (Redis), the TTL math would still be safe (each instance's clock is close enough for 60s windows). If we ever tried to *order* events across instances — say, "investigation 1 came before investigation 2" globally — *then* we'd need vector clocks or HLCs.

### Move 2.5 — Case B: leadership, distributed locks, consensus

These are real distributed-systems concepts. **They are not in this repo.** Documented here so you know what they'd add.

#### Leader election

Pattern: N replicas run the same code; one is elected leader (Raft, Bully algorithm, Zookeeper ephemeral nodes); only the leader writes; followers read. Adds complexity: split-brain detection, leader failover, fencing tokens.

**When this repo would need it:** If a background job (refresh schema every hour, refresh demo snapshot nightly) had to run *exactly once* across the Vercel cohort. Today there's no such job — everything is request-driven.

```
  Phase A (today)           vs       Phase B (if a background job existed)
  ───────────────────              ───────────────────────────────────────
  every request runs                a single "leader" instance runs the job
  the schema bootstrap              on schedule; others skip it
  independently (idempotent,        coordination cost: Raft / locks /
  duplicate work tolerated)         leader-election infra
```

#### Distributed locks

Pattern: a shared lock (Redis SETNX with TTL, etcd lease, Zookeeper) that only one process can hold. Used for serializing access to a critical section across processes.

**When this repo would need it:** If the schema bootstrap had to run *only once across all instances* (today it can run on each cold instance independently, and the duplicate work is wasted bandwidth not corrupted state). Or if we ever did atomic increment-style writes against shared state.

#### Consensus (Raft / Paxos)

Pattern: a group of N nodes agree on an ordered log of operations, surviving up to f failures (where N = 2f+1). Used for replicated state machines (etcd, Consul, distributed databases).

**When this repo would need it:** Never, at this shape. Consensus is for distributed *databases*; we don't have one.

#### Vector clocks / HLCs / Lamport timestamps

Pattern: each process tags its events with a logical clock that captures causal precedence. Used to determine "happened-before" across processes without a global clock.

**When this repo would need it:** If two users edited the same investigation concurrently, vector clocks would let us detect the conflict ("user A's edit and user B's edit are concurrent — show a merge UI"). Today, investigations are write-once per session.

### Move 3 — the principle

**Coordination is expensive. Don't add it unless the failure mode forces you.** The cookie-as-shared-state pattern is the cheapest possible "distributed" state — the browser is doing the carrying, and the encryption + AsyncLocalStorage wrapping is the entire price. No Redis, no Raft, no locks. The pattern works because we picked the corner of the design space where state changes infrequently (per OAuth flow, not per request) and the state is small (< 8KB cookie limit).

The day we need real coordination — a background job, a shared lock, multi-region cohorts that need to agree on something — the cost goes up dramatically. Knowing where that line is, and staying on this side of it, is most of the design judgment in this pattern.

## Primary diagram

```
  Full picture — the only coordination pattern in this codebase

  ┌─ Browser ─────────────────────────────────────────────────────────┐
  │  cookies: bi_session=<uuid>; bi_auth=<encrypted blob>              │
  │  every request carries them                                        │
  └────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS, every request
  ┌─ Vercel instance (any of N) ──────────────────────────────────────┐
  │                                                                    │
  │  withAuthCookies(fn) {                                             │
  │    raw = cookies().get('bi_auth').value                            │
  │    ctx = { store: decrypt(raw) || {}, dirty: false }                │
  │    await requestStore.run(ctx, fn)   ─ AsyncLocalStorage scope ─    │
  │       ↓                                                             │
  │       BloomreachAuthProvider methods (readState/patchState)          │
  │         → readAll() reads ctx.store                                 │
  │         → writeAll() updates ctx.store, sets ctx.dirty             │
  │       ↑                                                             │
  │    if (ctx.dirty) cookies().set('bi_auth', encrypt(ctx.store), {…}) │
  │  }                                                                  │
  │                                                                    │
  │  per-instance, NOT coordinated:                                    │
  │    • insights/investigations Maps (per-session sub-maps)           │
  │    • lib/mcp/schema.ts `cached` (process-lifetime)                 │
  │    • BloomreachDataSource cache + lastCallAt                       │
  │    • timestamps (Insight.timestamp, Date.now())                    │
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘

  Case B (not exercised here):
    • leader election (would need: background scheduled jobs)
    • distributed locks (would need: shared mutable state)
    • consensus (would need: replicated state machine)
    • vector clocks (would need: concurrent updates to shared resources)
```

## Elaborate

The cookie-as-shared-state pattern has a name in industry: **stateless session management with signed cookies**, used by every JWT-based system. The novel-to-us part is using it for the OAuth flow's transient state (PKCE verifier, DCR client info) rather than just for the user identity. The risk that pushed us here is the same risk that pushed everyone there: ephemeral compute (Vercel, Lambda) doesn't have a shared memory layer by default, and adding one (Redis, Vercel KV) is an extra service to operate and pay for.

AsyncLocalStorage is the Node analog of Java's `ThreadLocal` or Go's context.Context — a way to thread per-request state through async chains without polluting function signatures. The Next.js cookie API problem (request-vs-response split, can't read your own writes within a request) is well-known; ALS is the standard workaround.

What to read next: Marc Brooker's "Caches, modes, and unprincipled gradients" for the cookie-as-cache shape; the Vercel KV docs for the next step up; the Raft paper if you want to know what leader election actually costs.

## Interview defense

**Q: "How do you handle state across your serverless instances?"**

> "The honest answer: I don't have shared state across instances except for what's in the user's cookies. The only real coordination problem is the OAuth flow — the `connect` request and the `callback` may land on different Vercel instances. So the DCR client info, PKCE verifier, and tokens all live in an AES-256-GCM encrypted cookie called `bi_auth`. The pattern: read the cookie once at request start, decrypt into an AsyncLocalStorage-scoped object, let the OAuth SDK do its many synchronous reads/writes against that object, flush back to the cookie at request end. Cross-instance state without Redis."

Diagram:

```
  instance A: connect → save verifier to ctx → encrypt → Set-Cookie
                                                        │
  browser:    Cookie: bi_auth=...                       │
                                                        ▼
  instance B: callback → decrypt cookie → read verifier → exchange code → save tokens → re-encrypt → Set-Cookie
```

**Q: "Why AsyncLocalStorage?"**

> "Next.js's `cookies()` API is request-scoped — `cookies().set(...)` only affects the response. A read after a set in the same request returns the OLD value. The OAuth SDK calls `provider.saveCodeVerifier(v)` and `provider.codeVerifier()` many times during a single flow, often interleaved with `tokens()` and `saveTokens()`. Re-reading the cookie on every call would lose the most recent writes. ALS lets me read the cookie ONCE at request entry, hold the decrypted store in a per-request object, let the SDK hammer it synchronously, and flush ONCE at exit. The `dirty` flag is the optimization — pure-read requests don't trigger a re-encrypt or a Set-Cookie."

**Q: "What if `AUTH_SECRET` rotates?"**

> "Every existing cookie decrypts to `{}` (the try/catch in `decryptStore` swallows the GCM authentication failure). All users re-auth. That's the deliberate behavior — rotating the secret is a force-logout. Same effect for tampered cookies."

**Q: "What's NOT here that I should be aware of?"**

> "No leader election, no distributed locks, no consensus, no vector clocks. The per-instance state (insights Map, schema cache, BloomreachDataSource cache) is uncoordinated — instance A's cache is invisible to instance B. That's fine for idempotent reads but the `lastCallAt` rate-limit spacing is per-instance too, so two warm instances can technically race the upstream's rate limit. Listed in the red-flags audit. The day a background job needs to run exactly once across the cohort, leader election earns its place."

**Q: "What's the load-bearing detail?"**

> "AsyncLocalStorage scoping. Without it, the OAuth SDK's mid-request `saveCodeVerifier` would write a cookie that the next `codeVerifier()` call inside the same request couldn't read. The whole flow would silently fail with 'no PKCE code_verifier stored for this session.' The scoping is what makes the in-request reads consistent."

## See also

- `01-distributed-system-map.md` — the picture this file is the deep walk of.
- `04-consistency-models-and-staleness.md` — the per-instance staleness the cookie pattern fixes for auth (and the `?insight=` URL hack fixes for everything else).
- `09-distributed-systems-red-flags-audit.md` — the per-instance `lastCallAt` rate-limit gap is listed there.
- `../study-security/` — the cookie crypto, the secret rotation, the redaction at `lib/mcp/transport.ts:66`.
