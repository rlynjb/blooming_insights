# State ownership and source of truth

**Industry name(s):** state topology · source of truth audit · ownership graph
**Type:** Industry standard · Language-agnostic

> blooming insights has **eleven distinct pieces of state, owned by seven different things, with one source of truth that lives outside the codebase entirely (Bloomreach)**. Everything in-process is *derived* — an insight is a transformed Bloomreach query result; a diagnosis is an agent's interpretation of EQL data; the workspace schema is a snapshot of four MCP calls. The load-bearing fact is that **no piece of state in this app is durable across a process restart except the encrypted `bi_auth` cookie (browser-owned) and the committed `demo-*.json` snapshots (git-owned)**. Everything else — insights, investigations, the schema cache, the rate-limit timer, the request-scoped auth store — lives in-process and dies with the Vercel instance. That's the design's most surprising choice and its most consequential one; this file audits where it works and where it bites.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** State ownership is the question that makes "where does the data live" precise. Three things to track per piece of state: *who owns it* (which process, which storage), *who can read or mutate it* (the contract), and *what survives across what* (request lifecycle? process restart? browser tab close?). This codebase has an unusually clean answer: most state is process-local, with three exceptions (cookie, sessionStorage, committed JSON) that survive specific boundaries. Naming each piece and its lifetime makes the architecture's deliberate-no-database choice visible.

```
  Zoom out — where state lives                  ← we are here (every band)

  ┌─ Browser ──────────────────────────────────────┐
  │  useState · useRef · sessionStorage · localStorage│  ★ multiple owners ★
  └─────────────────────┬──────────────────────────┘
                        │ network
  ┌─ Cookies (browser-owned, server-readable) ─────┐
  │  bi_session · bi_auth (encrypted)               │
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Server process (in-memory) ───────────────────┐
  │  insights Map · investigations Map · schema cache│
  │  McpClient cache · McpClient lastCallAt          │  ★ no durability ★
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Filesystem (dev only) ────────────────────────┐
  │  .auth-cache.json · .investigation-cache.json   │
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Git (committed) ──────────────────────────────┐
  │  demo-insights.json · demo-investigations.json  │
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Bloomreach ───────────────────────────────────┐
  │  ★ THE SOURCE OF TRUTH ★                        │
  └────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *for every piece of state in this app, who owns it, how long does it live, and what is the source of truth that the in-process copy is derived from?* The honest answer is structural: the app's source of truth is **Bloomreach**. Every insight, every diagnosis, every recommendation is downstream of Bloomreach data. The in-process copies are caches with no explicit invalidation strategy beyond "the next briefing replaces them." This file inventories every piece of state, names its lifetime, and grades whether the lifetime matches the intent.

---

## Structure pass

**Layers.** Same five bands (UI · Route · Agent · Provider · External). State lives at every band; ownership and lifetime change at every boundary crossing.

**Axis: lifetime.** Hold one question constant across the bands: *how long does this piece of state live, and what kills it?* Lifetime is the right axis for state ownership because the most consequential property of state in this app is the *gap between intended durability and actual durability*. Some state intends to be ephemeral (the McpClient's `lastCallAt` timer) and is — great. Some intends to be durable (a freshly-saved investigation) and *isn't* (the in-memory `Map` dies on instance recycle) — that's a finding.

**Seams.** Three lifetime flips matter.

- **L1: useState ↔ sessionStorage.** Lifetime flips from "this tab's lifetime" to "this tab's lifetime *across navigations within the tab*". The handoffs across `/investigate/[id]` routes (`bi:diag:`, `bi:insight:`, `bi:inv:*`) live in sessionStorage explicitly so they survive route changes without going to the server.
- **L2: in-memory Map ↔ encrypted cookie.** Lifetime flips from "this Vercel instance's lifetime" to "10 days, regardless of which instance you land on." This is the *only* state in the app that survives an instance recycle in production, and it carries exactly two things: the OAuth state and the OAuth tokens. Everything else has to be re-derived from Bloomreach or re-handed-over via sessionStorage. **★ Load-bearing.**
- **L3: agent-emitted JSON ↔ committed demo JSON.** Lifetime flips from "until the next briefing" to "until the next git commit." The committed `demo-*.json` files are the *only* representation of an insight/investigation that survives across deploys.

```
  Structure pass — lifetime across the bands

  ┌─ 1. LAYERS ────────────────────────────────────────────┐
  │  UI · Route · Agent loop · Provider · External           │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 2. AXIS ────────────────▼────────────────────────────┐
  │  lifetime: how long does this state live, what kills it?│
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 3. SEAMS ───────────────▼────────────────────────────┐
  │  L1: useState → sessionStorage   (tab → tab nav)        │
  │  L2: in-memory Map → cookie      (instance → 10 days)  ★│
  │  L3: emitted event → demo JSON   (briefing → commit)    │
  └────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You've shipped CRUD apps. The mental model there is: *state lives in the database; everything else is a copy*. The model here is the same shape but with a different anchor: *state lives in Bloomreach; everything else is a derived copy with a short lifetime*. The trick is that "derived" isn't "computed in one place" — it's spread across the route handlers, the agent loop, and the in-process `Map`s. Naming each copy and what derives it is what makes the topology visible.

```
  Mental model — derivation chain

  Bloomreach (source of truth)
       │
       │  bootstrapSchema()
       ▼
  WorkspaceSchema (module-cached, process-local)
       │
       │  coverageReport()
       ▼
  CoverageReport (transient, per request)
       │
       │  MonitoringAgent.scan() + EQL queries
       ▼
  Anomaly[] (transient, per request)
       │
       │  anomalyToInsight()
       ▼
  Insight[] (in-memory Map, replaced each briefing)
       │
       │  rendered
       ▼
  React state (per-mount lifetime)
```

Each arrow is a derivation; each box is a piece of state with a different lifetime. The arrow direction is always "from source toward derived" — no in-process state is ever written *back* to Bloomreach (the tool surface is read-only by construction; see `study-security/`).

### Move 2 — every piece of state, named

Each piece of state in this app, in lifetime order from shortest to longest.

#### S1 — React `useState` slots (per mount)

Lives in the browser, dies on tab close or route change. Owned by individual components.

```
  app/page.tsx                                  app/investigate/[id]/page.tsx
  ┌─────────────────────────────────────┐       ┌─────────────────────────────────┐
  │ status        'loading'|'loaded'|…  │       │ items[]    (TraceItem[])         │
  │ insights      Insight[]              │       │ diagnosis  Diagnosis|null        │
  │ workspace     {name,customers,events}│       │ recommendations Recommendation[] │
  │ coverage      CoverageReport         │       │ complete   boolean               │
  │ activeQuery   string|null            │       │ error      string|null           │
  │ stepStatus    string                  │       └─────────────────────────────────┘
  │ queryCount    number                  │
  │ traceItems    TraceItem[]             │
  │ reconnecting  boolean                 │       these live inside useInvestigation
  │ capturing     {active,msg}            │       — same lifetime semantics
  │ mode          'demo'|'live'           │
  │ ready         boolean                 │
  │ demoSuffix    string                  │
  │ errorMessage  string                  │
  └─────────────────────────────────────┘
  ★ ~14 slots in one client component — biggest cognitive load in the repo
    (see study-software-design/01-complexity-in-this-codebase.md)
```

#### S2 — `useRef` (per mount)

`startedRef` in `useInvestigation`. Lives one mount, never re-rendered with. Its only purpose is to prevent React StrictMode's double-mount from firing the fetch twice. Lifetime: same as `useState`.

#### S3 — `sessionStorage` (per tab, across route changes)

Three patterns of key, all keyed by insight id:

```
  bi:insight:{id}        the raw Insight JSON, stashed by the feed before
                         navigating to /investigate. The investigate page
                         can read this and pass it back as ?insight=…,
                         which is the ONLY state path that survives Vercel's
                         per-instance memory (the in-memory Map is on a
                         different instance than the briefing was).

  bi:diag:{id}           the Diagnosis produced by step 2. The recommend
                         page reads this and (in live mode) passes it back
                         as ?diagnosis=… so step 3 doesn't re-run step 2.

  bi:inv:{step}:{id}     the full per-step trace + result, stashed so a
                         back-nav or re-visit hydrates instantly without
                         re-running the agent or even re-fetching the
                         cached replay.

  bi:reconnecting        '1' if we just attempted an auth-reconnect; cleared
                         after the next briefing. Prevents an infinite
                         reconnect loop if auth keeps failing.

  bi:mode                'demo' | 'live' — actually lives in localStorage,
                         not sessionStorage; persists across tabs and tab
                         closes for the same browser.
```

#### S4 — `localStorage` (per browser, persistent)

One key: `bi:mode`. Controls whether the feed fetches `?demo=cached` or live. Persists across sessions, devices implicitly per-browser. This is the only state in the app that survives a browser restart.

#### S5 — Cookies (per browser, server-readable)

Two cookies, both `httpOnly`:

```
  bi_session    random UUID, set on first hit by getOrCreateSessionId.
                lifetime: session cookie (browser lifetime)
                purpose: identifies the browser to the server so the
                         auth provider keys its store correctly.
                NO USER IDENTITY — it's a connection id, not an account id.

  bi_auth       AES-256-GCM encrypted blob of the OAuth state:
                  { [sessionId]: { clientInformation, tokens, codeVerifier, state } }
                lifetime: 10 days (AUTH_COOKIE_MAX_AGE)
                purpose: holds OAuth state across requests AND across Vercel
                         instances. THE LOAD-BEARING DECISION — without this,
                         the connect-then-callback OAuth flow would lose state
                         between the two requests (different instance, different
                         in-memory Map). Encrypted because tokens are sensitive.
```

#### S6 — Server in-memory `Map` (per Vercel instance)

```
  lib/state/insights.ts           insights      Map<id, Insight>   ★ replaced each briefing
                                  anomalies     Map<id, Anomaly>   (raw, for step 2 to use)
                                  investigations Map<id, Investigation>  (unused atm)

  lib/state/investigations.ts     mem           Map<id, AgentEvent[]>
                                  (the cached investigation trace; the replay shortcut reads this)

  lib/mcp/auth.ts                 memStore      Map<sessionId, SessionAuthState>
                                  (test backend only — production uses the cookie, dev uses the file)
```

**Lifetime: instance.** A cold start has empty `Map`s. The first briefing populates `insights`; subsequent investigations populate `investigations`. An instance recycle (Vercel decides) drops all of it.

#### S7 — Module-cached schema (per Vercel instance, never invalidated)

```
  lib/mcp/schema.ts  (line 131)

  let cached: WorkspaceSchema | null = null;

  export async function bootstrapSchema(mcp): Promise<WorkspaceSchema> {
    if (cached) return cached;   ← single-cache, no TTL, never invalidated
    …
    cached = parseWorkspaceSchema({…});
    return cached;
  }
```

**Lifetime: instance.** First request on a fresh instance pays the ~5 second cost of 4 sequential MCP calls. Every subsequent request on that instance returns instantly. There is no TTL. Test cleanup exists (`_resetSchemaCache`) but no production invalidation. This is fine *for now* because workspace schemas change on the order of weeks, but the absence of a TTL is named in file 08.

#### S8 — McpClient instance state (per Vercel instance, per session)

```
  lib/mcp/client.ts  (line 80–82)

  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;
  …
```

The `cache` Map holds tool-result memoization keyed by `${name}:${argsJson}` with a 60-second TTL by default. The `lastCallAt` instance variable enforces ~1.1s spacing between live calls. **Lifetime: instance + session** — a new `McpClient` is created in each `connectMcp` call (so technically per-request), but in practice all calls within a request share the same instance. The cache doesn't survive across requests; the spacing timer doesn't either.

#### S9 — Filesystem (dev only)

Two gitignored files exist *only* in `NODE_ENV === 'development'`:

```
  .auth-cache.json             Map<sessionId, SessionAuthState> — auth tokens
                               EXISTS because Next's dev server re-evaluates
                               modules on hot reload, which would wipe an
                               in-memory Map mid-OAuth-flow.

  .investigation-cache.json    Map<insightId, AgentEvent[]> — captured investigations
                               EXISTS so a dev who runs a live investigation
                               once can replay it on subsequent loads without
                               re-running the agent.
```

**Lifetime: until manually deleted.** Production has no filesystem-writable mount (Vercel functions are read-only), so these files don't exist there.

#### S10 — Committed demo JSON (per deploy)

```
  lib/state/demo-insights.json           a captured /api/briefing snapshot
                                         (workspace + coverage + trace + insights)

  lib/state/demo-investigations.json     Map<insightId, AgentEvent[]> for the demo insights
                                         (the full investigation trace for each)
```

**Lifetime: until the next git commit changes them.** These are the *only* representation of insights/investigations that survives across deploys, and they're how `?demo=cached` works without credentials. They're regenerated by the dev-only `/api/mcp/capture` and `/api/mcp/capture-demo` routes.

#### S11 — AsyncLocalStorage request store (per request)

```
  lib/mcp/auth.ts  (lines 46–48, 86–104)

  interface RequestStore { store: Store; dirty: boolean }
  const requestStore = new AsyncLocalStorage<RequestStore>();
  …
  export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
    …
    const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
    const result = await requestStore.run(ctx, fn);
    if (ctx.dirty) {
      (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {…});
    }
    return result;
  }
```

**Lifetime: one request.** Every request gets its own ALS context. The OAuth provider's many synchronous read/write calls hit this in-memory copy; at request end, if the copy was modified, it's encrypted and written back to the cookie. This is the *load-bearing pattern* that makes the encrypted-cookie auth work — without ALS, the provider's repeated reads-after-writes would hit the broken Next request/response cookie split.

### Move 2.5 — what survives what

The whole audit boils down to one matrix. Read it as: "this piece of state survives that boundary."

```
  State                        request  process restart  Vercel instance  browser tab close  browser
                                end     /hot reload      recycle                              restart
  S1 useState                  ✓        ✓                ✓                ✗                  ✗
  S2 useRef                    ✓        ✓                ✓                ✗                  ✗
  S3 sessionStorage            ✓        ✓                ✓                ✗                  ✗
  S4 localStorage              ✓        ✓                ✓                ✓                  ✓
  S5a bi_session cookie        ✓        ✓                ✓                ✗                  ✗
  S5b bi_auth cookie           ✓        ✓                ✓                ✓ (10 days)        ✓ (10d)
  S6 insights/inv Map          ✓        ✗ (dev)          ✗                —                  —
  S7 schema cache              ✓        ✗ (dev)          ✗                —                  —
  S8 McpClient cache           ✗ (per req in practice)   ✗                —                  —
  S9 dev files                 ✓        ✓                — (dev only)     —                  —
  S10 committed demo JSON      ✓        ✓                ✓                —                  —
  S11 ALS store                ✗        ✗                ✗                —                  —
```

The interesting rows are S6 and S7. They survive a request end (they're shared across requests in the same process) but die on instance recycle. The cell that says "in-memory Map survives an instance recycle" is *false* in production. That's the load-bearing fact this file exists to make visible.

### Move 3 — the principle

**There is no source of truth inside this codebase.** Bloomreach is. Every piece of in-process state is a derived projection with a short lifetime, and the architecture is honest about that — when the in-memory `Map` dies (instance recycle), the answer is "re-run the briefing against Bloomreach," not "consult our database." This shapes everything: the briefing replaces (not appends to) the insights map; the investigation cache is best-effort with `sessionStorage` as the durable fallback; the schema cache has no TTL because workspace schemas barely change. The choice is *right for a thin agentic shell over a system-of-record we don't own*. It'd be the wrong choice for a B2B SaaS — but this isn't one.

---

## Primary diagram

The full state topology with every piece, every owner, every lifetime, every derivation arrow.

```
  State topology — every piece, every owner, every lifetime

  ┌─ Browser ──────────────────────────────────────────────────────────────────┐
  │                                                                             │
  │  useState (per mount)        useRef (per mount)                              │
  │   • status, insights,        • startedRef (StrictMode guard)                 │
  │     workspace, coverage,                                                     │
  │     mode, …                                                                  │
  │                                                                              │
  │  sessionStorage (per tab, across nav)    localStorage (per browser)          │
  │   • bi:insight:{id}                       • bi:mode = 'demo' | 'live'        │
  │   • bi:diag:{id}                                                             │
  │   • bi:inv:{step}:{id}                                                       │
  │   • bi:reconnecting                                                          │
  │                                                                              │
  │  cookies (server-readable, sent on each request)                             │
  │   • bi_session (httpOnly UUID, session)                                      │
  │   • bi_auth    (httpOnly AES-256-GCM, 10 days, SameSite=None/Secure)         │
  └─────────────────────────────────┬───────────────────────────────────────────┘
                                    │ HTTPS + cookies
                                    ▼
  ┌─ Vercel instance (Node process) — IN-MEMORY (dies on recycle) ─────────────┐
  │                                                                             │
  │  insights Map (lib/state/insights.ts)        ★ replaced each briefing       │
  │  anomalies Map (raw, for diagnostic step)                                    │
  │  investigations Map (lib/state/investigations.ts)  ★ saveInvestigation()    │
  │  McpClient cache (per request, in practice)                                  │
  │  McpClient lastCallAt (per request)                                          │
  │  schema cache (lib/mcp/schema.ts, module-level `cached`)                     │
  │                                                                              │
  │  AsyncLocalStorage requestStore (per request)                                │
  │   ▲ seeded from bi_auth cookie at request start                              │
  │   ▼ flushed back to bi_auth cookie at request end (if dirty)                 │
  └─────────────────────────────────┬───────────────────────────────────────────┘
                                    │
                       ┌────────────┼────────────┐
                       │            │            │
                       ▼            ▼            ▼
              ┌─ Dev FS ──┐  ┌─ Committed ─┐  ┌─ Bloomreach ★ SOURCE OF TRUTH ─┐
              │ .auth-cache│  │ demo-*.json │  │  events, customer properties,   │
              │ .inv-cache │  │ (per deploy)│  │  catalogs, EQL query results    │
              │ (dev only) │  │             │  │  per-user authz, rate-limited   │
              └────────────┘  └─────────────┘  └────────────────────────────────┘

  Derivation chain (top to bottom):
    Bloomreach data  →  WorkspaceSchema  →  CoverageReport  →  Anomaly[]
                          →  Insight[]  →  Diagnosis  →  Recommendation[]
                          (each step is a function; the in-process Map is a cache)
```

---

## Implementation in codebase

### Use cases

**Use case 1 — second visit to the feed on the same instance.** The browser sends `bi_session` and `bi_auth`. The route's `withAuthCookies` decrypts the auth cookie into the ALS store; `connectMcp` finds the OAuth tokens; `bootstrapSchema` returns the *module-cached* `WorkspaceSchema` from S7 (no MCP calls); the monitoring agent runs against `runnableCategories`; insights flow back. Cold start: ~30–60s. Warm: ~15–25s (because the schema cache hit saves 5s, but the agent still pays for tool calls).

**Use case 2 — first visit after a Vercel instance recycle.** The browser sends both cookies. The route lands on a fresh instance. `bi_auth` decrypts → OAuth tokens are there → no re-auth needed. But `bi_session` from the old instance is a UUID the new instance has never seen, so the auth provider keys its lookup under a session id with no entries — *except* the cookie wrote them, so the ALS-seeded store has them. The schema cache is empty → 5s schema bootstrap. The insights Map is empty → no stale data; the briefing runs fresh. The investigation Map is empty → any prior investigation now has to hit the demo JSON (S10) or re-run live.

**Use case 3 — the user clicks "investigate this insight" after the instance recycled mid-session.** The feed stashed `bi:insight:{id}` in sessionStorage. The investigation page calls `useInvestigation`, which (in live mode) puts the stashed insight in the URL as `?insight=`. The route's `resolveAnomaly` reads the param, falls back to `getAnomaly(id)` (empty Map on fresh instance), falls back to the demo JSON. If the insight was in this morning's live briefing — not in the demo snapshot — and the browser didn't stash it, the route returns 404. The `bi:insight:` stash is the *only* path that survives instance recycle for live-mode insights. **This is named in file 08 as a real risk.**

### State file index

| State | File · Owner | Lines | Lifetime |
|---|---|---|---|
| useState slots (feed) | `app/page.tsx` · `HomePage` | L96–L124 | per mount |
| useRef startedGuard | `lib/hooks/useInvestigation.ts` · `useInvestigation` | L43, L47–L48 | per mount |
| sessionStorage stash | `lib/hooks/useInvestigation.ts` | L18–L19, L132–L140 | per tab |
| sessionStorage insight handoff | `app/page.tsx` · `stashInsights` | L70–L75 | per tab |
| localStorage mode | `app/page.tsx` · mode effect | L129–L145 | per browser |
| bi_session cookie | `lib/mcp/session.ts` · `getOrCreateSessionId` | L10–L24 | session |
| bi_auth cookie | `lib/mcp/auth.ts` · `withAuthCookies` | L86–L104 | 10 days |
| AES key derivation | `lib/mcp/auth.ts` · `aesKey` | L51–L60 | per call (SHA-256 of AUTH_SECRET) |
| insights Map | `lib/state/insights.ts` | L4–L6, L30–L42 | instance |
| investigations Map | `lib/state/investigations.ts` | L11, L22–L41 | instance |
| schema cache | `lib/mcp/schema.ts` · `cached` | L131, L170–L196 | instance |
| McpClient cache | `lib/mcp/client.ts` · `cache` | L80, L100–L146 | per request (practically) |
| McpClient spacing | `lib/mcp/client.ts` · `lastCallAt` | L81, L148–L163 | per request (practically) |
| ALS request store | `lib/mcp/auth.ts` · `requestStore` | L46–L47, L86–L142 | per request |
| Dev file persistence | `lib/mcp/auth.ts`, `lib/state/investigations.ts` | various | dev only |
| Committed demo JSON | `lib/state/demo-*.json` | — | per deploy |

### Sample — the insights Map replacement (load-bearing for freshness)

```
  lib/state/insights.ts  (lines 30–42)  ← annotated

  export function putInsights(items: Insight[], rawAnomalies?: Anomaly[]): void {
    // Replace the previous briefing — each run IS the current feed, not an
    // addition. Without clearing, a warm serverless instance (or a long-running
    // dev server) accumulates stale insights from earlier runs, so the feed shows
    // yesterday's anomalies alongside today's. Investigations are keyed separately
    // and untouched here.
    insights.clear();
    anomalies.clear();
    items.forEach((i, idx) => {
      insights.set(i.id, i);
      if (rawAnomalies?.[idx]) anomalies.set(i.id, rawAnomalies[idx]);
    });
  }
       │
       └─ the .clear() calls are the WHOLE freshness story. The insights map
          has no TTL because it doesn't need one — every briefing replaces it
          atomically. Without the clear, the feed would show today's + yesterday's
          anomalies side-by-side, which is wrong for a "what changed since yesterday"
          UX. Investigations are NOT cleared because each one has a stable id
          and the cache-replay shortcut depends on prior runs surviving.
```

### Sample — the ALS pattern (the only way encrypted-cookie auth works)

```
  lib/mcp/auth.ts  (lines 86–104)  ← annotated

  export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
    if (process.env.NODE_ENV !== 'production') return fn();   ← dev/test passthrough
    const { cookies } = await import('next/headers');
    const raw = (await cookies()).get(AUTH_COOKIE)?.value;
    const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
    const result = await requestStore.run(ctx, fn);            ← all reads/writes hit ctx
    if (ctx.dirty) {
      (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
        httpOnly: true, secure: true, sameSite: 'none', path: '/',
        maxAge: AUTH_COOKIE_MAX_AGE,
      });
    }
    return result;
  }
       │
       └─ the AsyncLocalStorage seeding is the load-bearing part. Without it,
          the OAuth SDK's many synchronous saveTokens/saveClientInformation
          calls would each try to read-then-write the cookie via Next's
          headers() API — and Next's request/response cookie split means a
          read after a set in the same request returns the OLD value. The
          ALS holds an in-memory copy for the request, all the SDK's reads
          and writes hit that, and we flush ONCE at the end. This is what
          makes the encrypted-cookie pattern work despite Next's quirks.
```

---

## Elaborate

### Why no database

The system-of-record IS Bloomreach. Every fact a user reads (an anomaly, a customer count, a revenue number) originates from a Bloomreach EQL query. Adding our own database would mean choosing where to draw the "fresh enough" line: do we re-run the monitoring agent every page load? Every N hours? On a schedule? Each answer commits to a freshness policy. The current architecture punts the policy: *the briefing IS the current feed; re-run it to refresh.* That's defensible at hackathon scale where a manual refresh button is fine. It stops being defensible when two users want a shared feed (whose briefing wins?) or when someone wants yesterday's anomalies (which now have to be re-derived from a Bloomreach query that the data may no longer support).

### Why sessionStorage instead of querystring or in-memory

The cross-instance problem is real: in production, the briefing and the investigation can land on different Vercel instances, and the in-memory `Map` is per-instance. The route's `resolveAnomaly` has a three-tier waterfall (client param → in-memory Map → demo JSON) precisely because no single mechanism survives every boundary. sessionStorage is the most reliable client-side stash because it survives route changes within the same tab without going to the server — but it doesn't survive a tab close. The cookie *would* survive a tab close, but it's not the right shape for "this insight I just clicked on" because it's shared across all tabs of the browser. The waterfall is the right design; the cost is exactly the code in `resolveAnomaly` (26 lines).

### What's surprising about the schema cache

The schema cache has no TTL. It's never invalidated. The comment in the file even says "Sequential — the server allows ~1 req/s; McpClient already spaces calls" — focused on latency, not freshness. This is *correct for now* because:

1. Workspace schemas change on the order of weeks (new events added, new catalogs).
2. The cache lives for the instance lifetime, which Vercel recycles regularly anyway.
3. A live mode user who needs fresh schema can hit any non-cached route to retrigger... no wait, they can't, because the cache is module-level. The only way to invalidate is an instance recycle or a deploy.

This is named as a small finding in file 08 — a TTL or a "force fresh" parameter would make it cleaner. The current behavior is *probably* fine but it's brittle: if a customer adds a new event type today and the same Vercel instance keeps serving for two weeks, the coverage grid won't pick up the new category until that instance recycles.

### Cross-link to legacy patterns

- The `useInvestigation` started-guard + sessionStorage handoff is taught at mechanism depth in `.aipe/study-system-design-dsa/01-system-design/07-client-stream-handoff.md`.
- The encrypted-cookie auth pattern (and why ALS) is taught in `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md`.
- The McpClient TTL cache mechanics are taught in `.aipe/study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md` and `.aipe/study-system-design-dsa/02-dsa/01-ttl-cache.md`.

---

## Interview defense

**What they are really asking:** can you point at every piece of state in your app and say who owns it and how long it lives — and can you honestly name what survives an instance recycle?

---

**[mid] — Where does state live in blooming insights?**

Eleven pieces, in lifetime order. React useState in components — per mount. useRef in `useInvestigation` for the StrictMode guard — per mount. sessionStorage for per-step trace stash and the diagnosis handoff between steps — per tab. localStorage for the demo/live mode toggle — per browser. Two cookies: `bi_session` (httpOnly UUID, identifies the browser) and `bi_auth` (httpOnly, AES-256-GCM encrypted OAuth state, 10 days). On the server: two in-memory `Map`s (insights and investigations), a module-level schema cache, and McpClient's per-request cache + spacing timer. Plus an AsyncLocalStorage request-scoped store that decrypts the auth cookie at the start of each request and flushes it at the end. In dev there are two gitignored JSON files for persistence across hot-reloads. Committed in git: two demo JSON files that let the app run without credentials.

```
  per mount       useState · useRef
  per tab         sessionStorage (bi:insight, bi:diag, bi:inv)
  per browser     localStorage (bi:mode)
  per session     bi_session cookie
  10 days         bi_auth cookie (encrypted)
  per instance    insights Map · investigations Map · schema cache
  per request     ALS store · McpClient cache + lastCallAt
  per deploy      committed demo JSON
```

---

**[senior] — What's the source of truth?**

Bloomreach. There is no database in this codebase. Every insight is a transformed Bloomreach query result; every diagnosis is the agent's interpretation of EQL data; the workspace schema is a snapshot of four MCP tool calls. The in-process `Map`s are caches with no explicit invalidation strategy beyond "the next briefing replaces them" and "the process dies on instance recycle." This is right for a thin agentic shell over a system-of-record we don't own. It would be wrong for a B2B SaaS — but this isn't one.

```
  Bloomreach (source of truth)
        │
        │  derive
        ▼
  in-process Map  (transient, per instance)
        │
        │  emit
        ▼
  NDJSON event → React state  (per mount)
```

---

**[arch] — What breaks when a Vercel instance recycles?**

Three things, ranked by user impact. **First**, the in-memory `insights` Map is empty, so a stale browser holding an insight id from before the recycle gets a 404 if it tries to investigate — unless the client stashed the raw insight in `bi:insight:{id}` and re-passes it as `?insight=` (which the codebase does). **Second**, the `investigations` Map is empty, so a previously-cached investigation has to re-run live or fall back to the demo JSON (which only contains demo-snapshot investigations, not freshly-generated ones). **Third**, the `schema` cache is empty, so the first request on the new instance pays a 5s cost. The auth cookie survives the recycle (10-day lifetime, AES-256-GCM, instance-independent), so users don't have to re-auth. The `sessionStorage` survives because it's browser-side. The thing that breaks hardest is "I generated an insight 30 minutes ago, came back, the instance recycled, my insight isn't in the demo set, the browser stashed it but my tab was closed so sessionStorage is gone" — that's a 404. File 08 names this as a real risk with the move (move the investigations Map to KV).

---

**The dodge — "have you measured how often Vercel recycles?"**

No, not in instrumented production. I know from documentation that Vercel functions are ephemeral and that warm starts last a few minutes to hours depending on traffic. I know from running the app that the cookie-survives-recycle pattern works because OAuth state has to survive between two requests that demonstrably land on different instances (the connect request and the callback request). I don't have a real number for "what's the p50 lifetime of a warm instance under our traffic." For a real production deployment, instrumenting the cold-start indicator (the empty schema cache) would give that number quickly.

---

**One-line anchors:**
- 11 pieces of state, 7 owners, 1 source of truth (Bloomreach).
- Nothing in-process survives an instance recycle except the encrypted `bi_auth` cookie and the committed demo JSON.
- The `bi:insight:{id}` stash + `?insight=` param waterfall is what bridges the per-instance-Map gap for live-mode users.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, list the 11 pieces of state in lifetime order from shortest to longest. For each, name its owner and what kills it. Check against the "Move 2" inventory.

### Level 2 — Explain
Why does `putInsights` in `lib/state/insights.ts` call `insights.clear()` before populating? What would the UX failure look like if it didn't? Reference `lib/state/insights.ts` L30–L42.

### Level 3 — Apply
A teammate proposes adding a "history" view: see all insights from the last 7 days. Walk through which state would need to change, where the new storage would live, and whether the current architecture supports it. Reference the absence of a database + `lib/state/insights.ts`.

### Level 4 — Defend
Defend the choice to have no database. When is it right, when is it wrong, and what's the smallest add that would make a 2-user shared feed work?

### Quick check
- Which state is the system-of-record? → Bloomreach (external)
- Which state survives a Vercel instance recycle? → only `bi_auth` cookie (10 days) + committed demo JSON
- Which file owns the ALS request store? → `lib/mcp/auth.ts` L46–L47, L86–L104
- Which file owns the module-level schema cache? → `lib/mcp/schema.ts` L131

---

## See also

→ [01-system-map-and-boundaries.md](./01-system-map-and-boundaries.md) · [04-caching-and-invalidation.md](./04-caching-and-invalidation.md) · [05-storage-choice-and-durability-boundaries.md](./05-storage-choice-and-durability-boundaries.md) · [07-scale-bottlenecks-and-evolution.md](./07-scale-bottlenecks-and-evolution.md) · `.aipe/study-system-design-dsa/01-system-design/07-client-stream-handoff.md` (sessionStorage handoff mechanism) · `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md` (encrypted-cookie mechanism)
