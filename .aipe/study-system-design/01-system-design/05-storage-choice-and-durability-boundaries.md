# Storage choice and durability boundaries

**Industry name(s):** storage selection · durability tier audit · "where does this survive" map
**Type:** Industry standard · Language-agnostic

> blooming insights has **no database, by design**. Storage is **five tiers** with very different durability guarantees: process memory (`Map`), per-request memory (`AsyncLocalStorage`), browser-side storage (`sessionStorage` + `localStorage` + cookies), filesystem (dev only), and git (the committed demo JSON). The load-bearing storage decision is the **encrypted `bi_auth` cookie** — it's the only thing in production that survives an instance recycle AND carries actual application state (OAuth tokens). The most surprising choice is that the *system-of-record* (Bloomreach) is treated as external storage we don't own — every insight is a derived projection, and the architecture commits to "re-derive on the next briefing" instead of persisting anywhere. The choice is **right for hackathon scale and a thin agentic shell**; it stops being right the moment two users want a shared feed or anyone wants yesterday's anomalies. This file audits each tier, its durability guarantees, and where the boundaries between tiers fail.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Storage choice is *the* architectural decision. Pick wrong and every later choice fights you: a wrong-database means months of migrations, a missing-database means features you can't build. Pick right and the rest of the system flows. The interesting audit is not "should we use Postgres or MySQL" — it's "do we even need a database, what would it own, and what costs are we accepting by not having one?" For this codebase, the answer is genuinely "we don't need one *yet*," and the costs are named.

```
  Zoom out — where storage lives                  ← we are here (every band, plus external)

  ┌─ Browser ──────────────────────────────────────┐
  │  sessionStorage · localStorage · cookies        │  ← five distinct durability windows
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Server process (in-memory) ───────────────────┐
  │  Map<id, Insight> · Map<id, AgentEvent[]>       │  ← dies on recycle
  │  ALS request store · module-cached schema       │
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Filesystem (dev only) ────────────────────────┐
  │  .auth-cache.json · .investigation-cache.json   │  ← dev-only
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Git (committed) ──────────────────────────────┐
  │  demo-insights.json · demo-investigations.json  │  ← per-deploy durability
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ External (Bloomreach) ────────────────────────┐
  │  THE SOURCE OF TRUTH                            │  ← actually-durable storage
  └────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *for every piece of data this app handles, which storage tier owns it, what's its durability guarantee, and what happens at the boundaries where data moves between tiers?* The previous files (state ownership, caching) named the data; this file picks the *durability* axis and walks down. The pattern that emerges: each tier exists to solve a specific durability requirement, and the cost of not having a database is paid in a *waterfall of fallbacks* every time data has to cross a boundary.

---

## Structure pass

**Layers.** Five storage tiers, each with a different durability guarantee. Browser-side (3 sub-tiers) · process memory · per-request memory · filesystem (dev) · git.

**Axis: durability — what survives what.** Hold one question constant across the tiers: *given a specific failure (instance recycle, tab close, browser restart, deploy, AUTH_SECRET rotation), which data survives and which is gone?* Durability is the right axis for storage because the *defining* property of a storage choice is "what does this guarantee to outlive." Cost (operational and dev-time) would also work but is downstream — once you know the durability requirements, cost is just "which tier is cheapest that meets the requirement."

**Seams.** Three load-bearing.

- **D1: client ↔ server.** Durability flips from "per browser/tab" to "per Vercel instance." This boundary is where the `bi_auth` cookie + `?insight=` query param waterfall live — these are the *only* mechanisms that pass data across this boundary durably.
- **D2: process memory ↔ encrypted cookie.** Durability flips from "instance lifetime" to "10 days, instance-independent." The cookie is the only production-side storage that survives recycle. **★ Load-bearing — without this, OAuth couldn't work across Vercel's ephemeral instances.**
- **D3: in-process state ↔ Bloomreach.** Durability flips from "ephemeral, must be re-derived" to "the source of truth, owns its own durability." Everything we hold is a projection of this.

```
  Structure pass — durability flips

  ┌─ 1. LAYERS ────────────────────────────────────────────┐
  │  Browser-side · Process · Per-request · FS (dev) · Git │
  │  + External (Bloomreach)                                │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 2. AXIS ────────────────▼────────────────────────────┐
  │  durability: what survives what failure?                │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 3. SEAMS ───────────────▼────────────────────────────┐
  │  D1: client → server      (per-tab → per-instance)      │
  │  D2: in-mem → cookie      (per-instance → 10 days)    ★ │
  │  D3: in-process → BR      (ephemeral → durable, upstream)│
  └────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You've shipped Postgres-backed apps and SQLite-backed apps (AdvntrCue, buffr). The mental model is "if I write it, it survives; the database guarantees that." Here, that's *inverted*: if I write it to the in-memory `Map`, it survives until the instance dies. The default is ephemeral; the exceptions (cookie, git) are explicit and named. The shape that lands is "a tier-by-tier walk of durability guarantees with each tier's purpose stated."

```
  Mental model — durability tiers, ranked by what they outlive

  TIER 1 — In-memory Map        instance lifetime           "ephemeral by default"
  TIER 2 — ALS request store    request lifetime            "even shorter — per request"
  TIER 3 — sessionStorage       tab lifetime                "explicit handoff window"
  TIER 4 — localStorage         browser lifetime            "user-preference only"
  TIER 5 — Cookies (httpOnly)   browser lifetime + maxAge   "server-readable; the only durable production state"
  TIER 6 — Filesystem (dev)     until manually deleted      "dev-only; serverless FS is read-only in prod"
  TIER 7 — Committed JSON       until next git commit       "the demo's stable backstop"
  TIER 8 — Bloomreach           upstream-managed            "the actual durable storage"
```

Each tier has a different purpose. The audit names the purpose, the durability, and the cost of using the wrong tier.

### Move 2 — each tier, with the choice it represents

#### Tier 1 — In-memory `Map` (the default)

```
  WHO USES IT      lib/state/insights.ts        Map<id, Insight>
                   lib/state/investigations.ts  Map<id, AgentEvent[]>
                   lib/mcp/client.ts            cache (per McpClient instance)
                   lib/mcp/schema.ts            cached singleton

  DURABILITY       instance lifetime
                   survives: requests on the same instance
                   dies: instance recycle (Vercel decides), process restart, deploy

  COST             $0 — it's just memory
                   $0 ops — no infrastructure

  WHEN IT'S RIGHT  the data is cheap to re-derive AND the user can tolerate
                   re-derivation. Insights pass (cheap-ish: 30s briefing; user
                   triggers refresh anyway). Investigations pass with caveats
                   (the session-storage stash + demo JSON cover the recycle gap).

  WHEN IT'S WRONG  the data is expensive to re-derive OR the user expects
                   persistence. Yesterday's insights would fail here — they're
                   gone after the next briefing replaces them, and the demo
                   JSON only holds the captured snapshot, not yesterday's run.
```

This is the *default choice* for state in this app. The decision "no database" cascades into "in-memory Map for everything that doesn't need to survive recycle." Files 03 (state ownership) and 04 (caching) walk what's in each Map; this file is about *why a Map and not a DB row*.

#### Tier 2 — AsyncLocalStorage request store

```
  WHO USES IT      lib/mcp/auth.ts  requestStore  (RequestStore inside ALS)

  DURABILITY       single request lifetime
                   survives: every read/write inside the same await chain
                   dies: response sent, request ends

  COST             $0; built-in Node primitive

  WHEN IT'S RIGHT  per-request scratch space that must be flushed back to
                   durable storage at request end. The OAuth provider's
                   many synchronous saveTokens/saveClientInformation calls
                   all hit the ALS store; one cookie-write at request end
                   flushes it.

  WHEN IT'S WRONG  anything that needs to survive the response. The ALS
                   context is gone the instant the request completes.
```

This is the *only* request-scoped storage in the system. Its existence is forced by Next.js's request/response cookie split (a cookie read after a set in the same request returns the old value), and the ALS pattern is the canonical fix.

#### Tier 3 — sessionStorage (per tab)

```
  WHO USES IT      app/page.tsx                   bi:insight:{id}, bi:reconnecting
                   lib/hooks/useInvestigation.ts  bi:inv:{step}:{id}, bi:diag:{id}

  DURABILITY       tab lifetime
                   survives: route changes within the same tab, tab refreshes
                   dies: tab close, browser restart

  COST             $0; browser-native

  WHEN IT'S RIGHT  cross-route state that's specific to one tab and doesn't
                   need to be shared across the user's other tabs. The
                   diagnosis handoff between investigation steps 2 and 3
                   is the canonical use — within one tab, the diagnosis
                   produced by step 2 must reach step 3 without going
                   back to the server.

  WHEN IT'S WRONG  state that should persist across browser restarts (use
                   localStorage or cookie) or state that's needed on the
                   server (cookies or query params).
```

The `bi:insight:{id}` pattern is structurally interesting — the client stashes a full `Insight` JSON specifically because the per-instance `Map` on the server can't be trusted to still have it when the user navigates to the investigation page (the request might land on a different Vercel instance). The browser stash is the *only reliable* cross-instance carrier of the insight payload in live mode.

#### Tier 4 — localStorage (per browser)

```
  WHO USES IT      app/page.tsx  bi:mode = 'demo' | 'live'

  DURABILITY       browser lifetime; persistent across tabs and restarts
                   dies: user clears storage, or browser does its own cleanup

  COST             $0; browser-native

  WHEN IT'S RIGHT  user preferences that should persist across visits but
                   don't need to be on the server. The demo/live toggle
                   is the only thing here — it's a user preference that
                   has no server-side meaning.

  WHEN IT'S WRONG  anything sensitive (it's not encrypted, it's readable by
                   JS on the same origin) or anything the server needs to
                   know (the server can't read localStorage).
```

One key only. This is the *least* used tier — and that's deliberate. Most apps over-use localStorage for things that should be either ephemeral (sessionStorage) or secure (cookies).

#### Tier 5 — Cookies (the load-bearing tier)

```
  WHO USES IT      lib/mcp/session.ts  bi_session (random UUID)
                   lib/mcp/auth.ts     bi_auth    (AES-256-GCM encrypted store)

  DURABILITY       per-cookie maxAge
                   bi_session: session cookie (browser lifetime; no explicit maxAge)
                   bi_auth:    10 days (AUTH_COOKIE_MAX_AGE)
                   survives: instance recycle, deploy, tab close (for bi_auth)
                   dies: user clears cookies, AUTH_SECRET rotation (decrypt fails)

  COST             $0 infra; modest crypto cost on every request that touches it
                   (~few hundred microseconds for AES-256-GCM encrypt/decrypt)

  WHEN IT'S RIGHT  small server-readable state that must outlive instance
                   recycles AND must travel automatically with the request.
                   The OAuth tokens are the canonical use — they must
                   survive between the connect request and the callback
                   request, which Vercel routes to potentially different
                   instances.

  WHEN IT'S WRONG  anything larger than a few KB (cookies are sent on every
                   request, blowing up request size). Anything that needs
                   to be queryable (cookies are opaque to the server unless
                   decrypted and read in full).
```

**This is the load-bearing storage tier in production.** Without `bi_auth`, OAuth couldn't work across Vercel's ephemeral instances — the connect request would save tokens to its in-memory Map, the callback request would land on a different instance with an empty Map, and authentication would silently fail. The ALS pattern (Tier 2) exists specifically to make this cookie work despite Next's cookie quirks.

#### Tier 6 — Filesystem (dev only)

```
  WHO USES IT      lib/mcp/auth.ts             .auth-cache.json
                   lib/state/investigations.ts .investigation-cache.json

  DURABILITY       until manually deleted (or PERSIST is false)
                   survives: dev server hot-reloads, process restarts (dev)
                   does not exist: production (PERSIST = NODE_ENV === 'development' only)

  COST             $0 in dev; impossible in prod (Vercel functions are read-only FS)

  WHEN IT'S RIGHT  dev-only persistence to survive Next's hot-reload module
                   re-evaluation that would wipe an in-memory Map mid-flow.
                   Critical for the OAuth flow specifically — the PKCE
                   verifier saved during connect MUST survive the hot-reload
                   that happens when you visit /api/mcp/callback in dev.

  WHEN IT'S WRONG  always in production. The Vercel function filesystem is
                   read-only; writeFileSync would throw. The PERSIST flag
                   gates this correctly.
```

The dev-only constraint is gated by `const PERSIST = process.env.NODE_ENV === 'development';` in both files. In production this code path is skipped entirely.

#### Tier 7 — Committed JSON (per deploy)

```
  WHO USES IT      lib/state/demo-insights.json         a captured /api/briefing snapshot
                   lib/state/demo-investigations.json   captured investigation traces

  DURABILITY       until the next git commit changes them
                   survives: instance recycles, deploys (it's in the bundle),
                            user actions
                   dies: git commit replacing it; regeneration via the dev-only
                         /api/mcp/capture or /api/mcp/capture-demo routes

  COST             ~80KB+ bundled into the function deploy

  WHEN IT'S RIGHT  the demo case. Lets the app run end-to-end without
                   Bloomreach credentials. Read by the route on ?demo=cached
                   and by getCachedInvestigation as the final waterfall tier.

  WHEN IT'S WRONG  live data. The snapshot is a point-in-time capture; it
                   doesn't reflect current Bloomreach state.
```

Treating git as a storage tier feels weird until you realize that's *exactly* what the demo JSON is — it's data that needs to be deployed alongside the code, and version-controlled as part of the deploy. The right tier for "data that's part of the product" is the deploy artifact, which is git.

#### Tier 8 — Bloomreach (the actual durable storage)

```
  WHO USES IT      every agent (via McpClient.callTool)
                   every schema bootstrap (via lib/mcp/schema.ts)

  DURABILITY       upstream-managed
                   survives: everything on our side
                   dies: Bloomreach outages (we'd surface them as errors)

  COST             ~1 req/s/user rate limit + their pricing model
                   on our side: McpClient TTL cache absorbs repeats

  WHEN IT'S RIGHT  any data that has a source-of-truth meaning. Events,
                   customer properties, catalogs, EQL query results.
                   Anything that's a derivation of these (Insight, Diagnosis,
                   Recommendation) starts here.

  WHEN IT'S WRONG  derived artifacts the agent produced. An Insight is OUR
                   interpretation of Bloomreach data; it doesn't belong
                   *in* Bloomreach. The architecture correctly never writes
                   to Bloomreach — the tool surface is read-only by
                   construction (lib/mcp/tools.ts).
```

This is the only tier with true durability guarantees. Everything else in our system is "until our process dies" or "until our browser closes" or "until our git commit changes."

### Move 3 — the principle

**Pick the durability tier that matches the data's actual durability requirement, not the highest-durability tier you can afford.** Most "no database" arguments fail because someone needed cross-user persistence and had to bolt one on later. This codebase's "no database" works because it deliberately chose data shapes where re-derivation is cheap (insights from Bloomreach), where browser-side stash is sufficient (the diagnosis handoff), or where deploy-bundled JSON is the right fit (the demo). The architecture is **honest about what it doesn't persist** — and that honesty is what lets it work without a database at this scale. The lesson generalizes: catalog every piece of state, name its actual durability requirement, then match a tier to it. You'll often find you need less storage than you thought, and the storage you DO need is more focused.

---

## Primary diagram

The full storage topology with every tier, every owner, every durability boundary.

```
  Storage topology — every tier, what survives what

  ┌─ Browser ────────────────────────────────────────────────────────────────────┐
  │                                                                               │
  │  TIER 3  sessionStorage    bi:insight:{id}, bi:diag:{id},                     │
  │                            bi:inv:{step}:{id}, bi:reconnecting                │
  │                            durability: per tab                                 │
  │                                                                               │
  │  TIER 4  localStorage      bi:mode                                            │
  │                            durability: per browser                            │
  │                                                                               │
  │  TIER 5  Cookies           bi_session  (session cookie, httpOnly UUID)        │
  │                            bi_auth     (10 days, httpOnly AES-256-GCM)        │
  │                            durability: 10 days (the only PRODUCTION durable)  │
  └───────────────────────────────────┬───────────────────────────────────────────┘
                                      │ HTTPS + cookies sent automatically
                                      ▼
  ┌─ Vercel instance (Node process) ─────────────────────────────────────────────┐
  │                                                                               │
  │  TIER 1  In-memory Map     insights, anomalies, investigations,               │
  │                            McpClient.cache, schema.cached                     │
  │                            durability: instance lifetime                       │
  │                                                                               │
  │  TIER 2  ALS request store requestStore (seeded from bi_auth, flushed at end) │
  │                            durability: one request                            │
  │                                                                               │
  │  TIER 6  Filesystem        .auth-cache.json, .investigation-cache.json        │
  │                            durability: until deleted (DEV ONLY; PERSIST gate) │
  └───────────────────────────────────┬───────────────────────────────────────────┘
                                      │
                       ┌──────────────┼──────────────┐
                       ▼              ▼              ▼
                ┌─ Git ──────┐  ┌─ Bloomreach ─────────────────────┐
                │            │  │                                   │
                │  TIER 7    │  │  TIER 8                            │
                │  demo-     │  │  events, customer properties,      │
                │  *.json    │  │  catalogs, EQL results             │
                │  per deploy│  │  upstream-managed                  │
                │            │  │  ★ THE ACTUAL DURABLE STORAGE ★    │
                └────────────┘  └────────────────────────────────────┘

  Survives what:
    user clears storage     T3, T4, T5 die.  T1, T6, T7, T8 live.
    tab close                T3 dies.  T4 lives. T5 partial (bi_auth lives 10d).
    browser restart          T3, T5/bi_session die.  T4, T5/bi_auth live.
    request end              T2 dies.  All others persist by their own rules.
    instance recycle         T1, T6 die.  T3, T4, T5, T7, T8 all live.
    deploy                   T1, T6 die.  T7 lives (it's in the deploy).
    AUTH_SECRET rotation     T5/bi_auth decrypt fails → effectively dies.
```

---

## Implementation in codebase

### Use cases

**Use case 1 — OAuth flow across two requests on different instances.** User clicks "connect" → `/api/briefing` runs on instance A → no tokens → SDK calls `saveCodeVerifier` and `saveClientInformation` → the ALS store catches them → at request end, `withAuthCookies` flushes the encrypted store to `bi_auth` → response sets cookie. User is redirected to Bloomreach IdP → returns to `/api/mcp/callback?code=…` → request lands on instance B → `withAuthCookies` decrypts `bi_auth` into instance B's ALS store → the SDK's `finishAuth(code)` reads the PKCE verifier from the ALS store → succeeds → calls `saveTokens` → ALS store updated → cookie flushed at end. **This use case is the entire reason `bi_auth` exists.**

**Use case 2 — instance recycle mid-session.** User has used the app for 10 minutes, has a feed loaded, has stashed `bi:insight:{id}` for several insights. Vercel recycles their instance. User clicks an insight to investigate. The browser sends both cookies; new instance reads `bi_auth` → tokens are there → no re-auth. The browser passes the stashed insight as `?insight=…` → `resolveAnomaly` parses it. The investigation runs live (the in-memory Map is empty on the new instance). The user never sees the recycle.

**Use case 3 — `?demo=cached` from a fresh browser, no credentials.** No cookies. `/api/briefing?demo=cached` → route checks `demo === true && file exists` → reads `demo-insights.json` (Tier 7) → replays at 140ms/event → done. No Bloomreach, no Anthropic, no auth required. This is the *only* path that works without credentials and is how the public demo is shown.

### Storage tier file index

| Tier | File · Owner | Lines | Durability |
|---|---|---|---|
| T1 in-memory Map (insights) | `lib/state/insights.ts` | L4 | instance |
| T1 in-memory Map (investigations) | `lib/state/investigations.ts` | L11 | instance |
| T1 in-memory Map (McpClient cache) | `lib/mcp/client.ts` · `cache` | L80 | instance (per-request McpClient in practice) |
| T1 schema singleton | `lib/mcp/schema.ts` · `cached` | L131 | instance |
| T2 ALS request store | `lib/mcp/auth.ts` · `requestStore` | L46–L47 | request |
| T2 ALS pattern | `lib/mcp/auth.ts` · `withAuthCookies` | L86–L104 | request lifecycle |
| T3 sessionStorage stash | `lib/hooks/useInvestigation.ts` | L18–L19, L132–L140 | tab |
| T3 sessionStorage insight handoff | `app/page.tsx` · `stashInsights` | L70–L75 | tab |
| T4 localStorage mode | `app/page.tsx` · mode effect | L129–L145 | browser |
| T5 bi_session cookie | `lib/mcp/session.ts` · `sessionCookieOpts` | L10–L24 | session |
| T5 bi_auth cookie | `lib/mcp/auth.ts` · `encryptStore` / `decryptStore` | L51–L79 | 10 days |
| T6 dev FS (auth) | `lib/mcp/auth.ts` · `PERSIST`, `readAll`, `writeAll` | L34, L113–L142 | dev only |
| T6 dev FS (investigations) | `lib/state/investigations.ts` · `PERSIST` | L7, L32–L40 | dev only |
| T7 committed demo JSON | `lib/state/demo-*.json` | — | per deploy |
| T8 Bloomreach (external) | called via `lib/mcp/client.ts` | — | upstream |

### Sample — the PERSIST gate that keeps prod from writing the FS

```
  lib/mcp/auth.ts  (line 34) + lib/state/investigations.ts (line 7)  ← annotated

  const PERSIST = process.env.NODE_ENV === 'development';
       │
       └─ this one-line constant IS the gate that makes T6 (filesystem)
          dev-only. In production, every read/write code path branches on
          PERSIST and falls through to the in-memory store. Vercel functions
          have a read-only filesystem; without this gate, writeFileSync
          would throw on every request that tried to persist auth state.

  // in writeAll(store: Store):
  if (!PERSIST) {
    memStore.clear();
    for (const [k, v] of Object.entries(store)) memStore.set(k, v);
    return;
  }
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(store));     ← only reached in dev
  } catch {
    /* best-effort; if the FS is read-only we simply lose persistence */
  }
       │
       └─ even with the gate, the try/catch is defensive — if Next ever
          changes its FS semantics, the failure mode is "lose persistence"
          not "crash the request." Honest defense.
```

### Sample — the encrypted cookie crypto

```
  lib/mcp/auth.ts  (lines 51–79)  ← annotated

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
       │
       └─ AES-256-GCM is the right choice: authenticated encryption means a
          tampered cookie fails decryption (the auth tag mismatch throws),
          so we can return {} and treat it as "no auth." The IV is random
          per encrypt — same plaintext encrypts differently each time,
          which prevents a passive observer from learning that the cookie
          hasn't changed. The base64url encoding is cookie-safe.

          The catch-and-return-empty is load-bearing: AUTH_SECRET rotation
          should not break user sessions catastrophically; it should make
          them re-auth. The audit in study-security/02 names this as the
          correct fail-open-to-re-auth pattern.
```

---

## Elaborate

### Why no database — the honest answer

Five reasons, ranked by weight.

1. **The system-of-record is upstream.** Adding a database would mean choosing which Bloomreach facts to cache and at what freshness — which is exactly the question this architecture punts on. Without a database, "fresh" means "from the next briefing"; with one, "fresh" means "depends on which TTL we picked." The punt is honest at this scale.
2. **No multi-user durability requirement.** There's no shared feed, no team workspaces, no "what did Alice see yesterday." Every browser is its own session; every session's state lives in cookies + the browser. Adding a database would buy capabilities that *aren't in the product*.
3. **Vercel-shaped ergonomics.** Ephemeral functions plus no managed Postgres in the stack means a database adds a service to operate (Neon, PlanetScale, Supabase). For a one-person hackathon-grade app, that's overhead that doesn't pay back.
4. **The demo case is shipped via git.** The committed `demo-*.json` files cover the "no credentials, no setup" demo flow — which is the primary user-facing path today. A database wouldn't help here; the committed snapshot is *easier* to demo than a hosted DB.
5. **Cost.** $0 today vs $20+/month for a hosted DB. Trivially small but real at this scale.

### What a database WOULD enable

Three things that don't exist today and would require persistent storage:

- **Shared feeds.** If multiple users in an org wanted to see the same briefing, the insights would have to live somewhere accessible to all their sessions. Today, each session generates its own briefing.
- **Historical investigation.** "Show me anomalies from last Tuesday." Today, anomalies only exist as long as the in-memory Map holds them (until the next briefing); the demo JSON only holds the captured snapshot.
- **Audit trails.** "Who saw what insight and when." Today, no record exists outside Vercel's request logs.

Each of these is a real product capability, and each requires storage. The current architecture doesn't have them because the product doesn't have them — which is the right alignment.

### What the smallest viable add looks like

If we needed to ship "shared feed" tomorrow, the smallest move is **a KV store (Vercel KV or Upstash Redis) keyed by `orgId`**, storing the last briefing's insights as a JSON blob with a 24h TTL. Add a "share this feed" button that writes the blob; add a route that reads it. No schema, no migrations, no relational thinking — just a key and a value. The cost is one external service to manage and ~$5/month. The architecture would move from "no durable storage" to "one durable cache" without becoming a database app. Most "we need a database" requests can actually be solved by KV — the audit's recommendation if this came up.

### Cross-link to legacy mechanism teaching

- The encrypted-cookie auth pattern (PKCE + DCR + the ALS-scoped store) → `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md` (the full OAuth boundary walkthrough)
- The in-memory state pattern + why `Map<id, …>` for both insights and investigations → `.aipe/study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md` (the state section)

---

## Interview defense

**What they are really asking:** can you defend an architecture decision that pushes against the default ("but where's the database?"), and can you say what costs you're accepting?

---

**[mid] — Why no database?**

The system-of-record is Bloomreach. Every fact a user sees originates from a Bloomreach EQL query — events, customer properties, catalogs. Insights and investigations are derived artifacts: the output of running an agent against that data. Adding a database would mean choosing how stale a cached insight can be before we re-run the agent, which is exactly the question this architecture punts on with "the briefing IS the current feed; re-run to refresh." That's defensible at hackathon scale where one user runs one briefing at a time. The cookie carries auth across instance recycles; sessionStorage carries the diagnosis handoff between investigation steps; committed JSON ships the demo without credentials. No database needed for what the product does today.

```
  the storage tiers — each does ONE thing

  in-memory Map      transient per instance
  ALS request store  per-request scratch + cookie flush
  sessionStorage     per-tab handoff
  localStorage       user preference
  cookies            instance-independent (THE durable production tier)
  committed JSON     the demo backstop
  Bloomreach         the actual source of truth
```

---

**[senior] — What's the *most* important storage choice?**

The encrypted `bi_auth` cookie. It's the only thing in production that survives instance recycles AND carries application state. Without it, OAuth couldn't work — the connect request saves the PKCE verifier on instance A, the callback request lands on instance B with a different in-memory Map, and the flow silently breaks. The cookie + the `withAuthCookies` ALS pattern is what makes Vercel-style ephemeral instances behave like a single coherent server from the OAuth flow's perspective. It's AES-256-GCM encrypted because tokens are sensitive; httpOnly + SameSite=None + Secure for the OAuth round-trip semantics; 10-day maxAge to match the token lifetime. Every other in-process storage tier is allowed to die on recycle *because* this one doesn't.

---

**[arch] — What's the smallest add that would let two users share a feed?**

Vercel KV (or Upstash Redis), keyed by `orgId`, storing the last briefing's insights as a JSON blob with a 24h TTL. Add a "share this feed" button that writes the blob; add a route that reads it. No schema, no migrations, no relational thinking — just a key and a value. ~$5/month, one external service to manage. The architecture moves from "no durable storage" to "one durable cache" without becoming a database app. Most "we need a database" requests can actually be solved by KV. If the product later needed history or audit trails, *then* we'd move to Postgres — but until then, KV is the right step up.

---

**The dodge — "what about Vercel Postgres?"**

It's available and Vercel's marketing pushes it. But for our needs today, it's the wrong shape — we don't have relational data, we don't need joins, we don't need transactions. A KV is the right primitive for "store this blob, look it up by key." Postgres would be cargo-culting database infrastructure for a need that doesn't exist. The day we need joins (users × insights × shares), then we'd add Postgres — and I'd push back hard on doing it before then.

---

**One-line anchors:**
- 8 storage tiers; only 3 (cookies, committed JSON, Bloomreach) are durable beyond instance lifetime in production.
- The `bi_auth` cookie is THE load-bearing production storage — without it, OAuth couldn't work across Vercel instances.
- The right step up from "no database" is KV, not Postgres — keyed lookups solve "shared feed" without becoming a database app.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, list the 8 storage tiers. For each, name what it stores and its durability boundary. Check against the "Move 2" inventory.

### Level 2 — Explain
Why is the `bi_auth` cookie AES-256-GCM encrypted rather than just signed? What's the difference, and what would a signed-but-not-encrypted version expose? Reference `lib/mcp/auth.ts` L51–L79.

### Level 3 — Apply
A teammate proposes adding a "history" view: see all insights from the last 7 days, scoped to the current user. Walk through which existing tier would need to change, what new tier you'd add, and what migration path you'd take. Reference the "smallest viable add" in Elaborate.

### Level 4 — Defend
Defend the choice to use sessionStorage for the diagnosis handoff (`bi:diag:`) rather than a server-side store. What would change if the user opened step 3 in a new tab? What about a new browser?

### Quick check
- Which tier is the only durable production storage? → cookies (T5), especially `bi_auth`
- Which tier doesn't exist in production at all? → filesystem (T6, dev only)
- Which file owns the encryption? → `lib/mcp/auth.ts` L51–L79
- Which `PERSIST` constant gates the dev filesystem? → `lib/mcp/auth.ts` L34, `lib/state/investigations.ts` L7

---

## See also

→ [01-system-map-and-boundaries.md](./01-system-map-and-boundaries.md) · [03-state-ownership-and-source-of-truth.md](./03-state-ownership-and-source-of-truth.md) · [04-caching-and-invalidation.md](./04-caching-and-invalidation.md) · [07-scale-bottlenecks-and-evolution.md](./07-scale-bottlenecks-and-evolution.md) · `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md` (the encrypted-cookie mechanism in depth) · `study-database-systems` (mostly N/A — this codebase has no DB engine internals to teach)
