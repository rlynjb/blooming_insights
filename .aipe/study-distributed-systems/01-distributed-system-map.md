# 01 — the distributed system map

**Industry name(s):** coordination map · trust + failure topology · ownership boundaries
**Type:** Industry standard · Language-agnostic

> **Verdict-first:** blooming insights has *three* real distributed boundaries and *one* coordination gap pretending not to exist. All three boundaries are over the internet (Bloomreach MCP, Anthropic, Bloomreach IdP). The gap is the assumption that one Vercel instance's in-memory `Map` is the same `Map` the next request will hit — it isn't, and the app has no mechanism that would notice when it isn't. `makeDataSource(mode, sid)` picks one of two adapters — `BloomreachDataSource` (the one distributed adapter, HTTP+SSE) or `SyntheticDataSource` (in-process fake; does NOT cross a hop). The earlier stdio subprocess adapter (`OlistDataSource`) that briefly added a fourth boundary was removed in PR #8 (2026-06-18). Every other distributed-systems concept in this guide attaches to one of those four spots (three boundaries + the gap).

---

## Zoom out, then zoom in

The map is the orientation. Every other file in this guide picks one of the boxes below and walks one axis through it.

```
  Zoom out — the whole distributed surface

  ┌─ UI layer (browser) ─────────────────────────────────┐
  │  React state + sessionStorage                         │
  │  ★ THIS CONCEPT — the system map ★                    │ ← we are here
  └─────────────────────────┬────────────────────────────┘
                            │  HTTPS (cookies)
  ┌─ Service layer ─────────▼────────────────────────────┐
  │  Vercel instance(s) · in-memory Maps                  │
  │  makeDataSource(mode, sid) → BloomreachDataSource     │
  │                            OR SyntheticDataSource     │
  │                              (in-process fake)        │
  └────────────┬─────────────────────────────────────────┘
               │ HTTPS (3 partners)
  ┌─ Provider layer ───────▼──────────┐
  │  Bloomreach MCP                    │
  │  Anthropic API                     │
  │  Bloomreach IdP                    │
  └────────────────────────────────────┘
```

**Zoom in.** The map answers: *what coordinates with what, who owns what, and where can the answer go wrong?* This file names the boxes and arrows. The other files in the guide pick one boundary or one ownership flip and walk the mechanism.

---

## Structure pass

**Layers.** Three. Client · Service (your Vercel instance) · Providers (Bloomreach MCP, Anthropic, Bloomreach IdP). Multi-instance is implicit at the service layer — Vercel scales horizontally, but the code treats each instance as if it were the only one.

**Axis: ownership.** Hold one question across every layer: *who owns this piece of state, and how long does it survive?* This is the right axis because the most consequential bug-shapes in this codebase come from ownership confusion — the server thinks it owns the diagnosis between steps 2 and 3 (it doesn't; the client does), and any new feature that assumes the in-memory `Map` is durable is wrong.

**Seams.** Four boundaries; the ownership answer flips at three of them.

- **Seam A — browser ↔ Vercel instance.** Ownership flips from "client React state + tab-local sessionStorage" to "request-scoped variables + (sometimes) process-local `Map`." Cookies cross both directions.
- **Seam B — instance ↔ instance.** Implicit and uncrossed. There IS no mechanism that crosses this seam. Two concurrent requests on two instances each see their own `Map`. This is the gap.
- **Seam C — instance ↔ Bloomreach MCP.** Ownership flips from "ours (cache, lastCallAt counter, spacing budget)" to "theirs (rate-limit window, workspace data, the truth)." Transport: HTTPS+SSE.
- **Seam D — instance ↔ Anthropic.** Ownership flips from "ours (the prompt + tool schemas we built)" to "theirs (the model's output, their rate limits)." Transport: HTTPS.
- **Seam E — instance ↔ Bloomreach IdP.** Ownership flips from "ours (the PKCE verifier, the redirect_uri we registered)" to "theirs (the auth code, the access + refresh tokens)." Transport: HTTPS (OAuth).

Seams C, D, E are the three real distributed boundaries. Seam B is the gap. Seam A is the workaround for Seam B (the client carries state precisely because the server can't be trusted to remember it). The previous Seam F (instance ↔ mcp-server-olist subprocess, stdio transport) was removed when the Olist adapter was deleted in PR #8 (2026-06-18); the `SyntheticDataSource` adapter that replaced it lives entirely inside the Vercel instance and never crosses a seam.

```
  Structure pass — ownership flips at three boundaries, one gap

  ┌─ client ────────────────────────────────────────────┐
  │  owns: React state, sessionStorage (per tab)         │
  └─────────────────┬──────── A ────────────────────────┘
                    │  (cookies cross + back)
  ┌─ Vercel inst1 ──▼───────┐  ┌─ Vercel inst2 ───────┐
  │  owns: req-scoped vars,  │  │  owns: req-scoped     │
  │        in-memory Map(s)  │  │        vars, OWN Map  │
  └────────┬─────────────────┘  └───────────────────────┘
           │  no seam B — these never coordinate
           │
   ┌───────┼──────────┬──────────┐
   │   C   │      D   │      E   │
   ▼       ▼          ▼          ▼
  MCP   Anthropic   IdP            (each owns its own truth)
  HTTPS HTTPS       HTTPS          (Seam C carries MCP/JSON-RPC 2.0
                                    over HTTPS+SSE)
```

---

## How it works

### Move 1 — the mental model

A distributed-systems map is the picture you draw when someone asks *"what happens if this part is slow / dead / lying?"* You point at each box and answer for that box. The shape is just: nodes + arrows + ownership labels + a marker on each arrow that says what guarantee crosses it.

```
  The pattern of a distributed-systems map

  ┌─ node A ─┐  guarantee crosses here  ┌─ node B ─┐
  │ owns: X  │ ────────────────────────► │ owns: Y  │
  └──────────┘  (can be late / partial /  └──────────┘
                lost / duplicated / lied
                about — the question is
                which of those, and how
                does node A respond when
                it happens)
```

The map isn't decoration. It's the artifact you use to predict failure. If you can't draw the map, you can't predict what breaks first.

### Move 2 — the boxes and arrows

#### The client box

You already know `useState`. The client owns React state for the current page and `sessionStorage` for the current tab. `sessionStorage` is its own ownership domain — survives reloads, dies with the tab, never crosses tabs. It carries three keys for this app: `bi:diag:<id>` (the diagnosis handed to step 3), `bi:insight:<id>` (the insight handed to the agent route when in live mode), `bi:inv:<step>:<id>` (the trace stash for instant rehydrate on back-nav).

```
  Client ownership — what survives what

  this render        ───  React state
  this tab           ───  sessionStorage
  this browser       ───  localStorage (mode toggle)
  this site, signed  ───  cookies (bi_session + bi_auth)
                          (sent on every request)

  bridges what otherwise dies: bi:diag:<id> is how
  step 2's diagnosis reaches step 3 across two
  independent server requests
```

The bridge is the load-bearing detail. Without `sessionStorage`, you'd need a server-side store keyed by `insightId` that both step 2 and step 3 can read — and that store would need to be cross-instance-readable, which is exactly the problem you're avoiding.

#### The Vercel instance box

You already know a Node process. Each Vercel invocation is a Node process. Whether two requests land on the same process is a coin flip controlled by Vercel — and even if they do, the process can be recycled between them. The code holds three pieces of state at this layer: the `insights` and `investigations` `Map`s in `lib/state/`, the module-level `cached` schema variable, and the AsyncLocalStorage-scoped auth store that wraps the cookie. **None of those survive across two different instances.**

```
  Vercel instance — what survives what (in-process)

  this request    ───  request-scoped vars + ALS context
  this process    ───  module-level Map / cached schema
  across instances ──  NOTHING in this app
                      (cookies cross via the client; nothing
                       on the server reaches sideways)
```

The boundary condition is silent. When the `Map` is empty because the request landed on a cold instance, no error fires; the lookup just returns `null` and the caller falls through to whatever fallback exists. The `resolveAnomaly` function in `app/api/agent/route.ts:37` is exactly that fallback — try in-memory, then try the demo snapshot, then 404. The fact that the in-memory path *silently misses* on a recycled instance is the load-bearing risk.

#### The Bloomreach MCP box

You already know an HTTP API with rate limits and a Bearer token. MCP is one of those, dressed up with a JSON-RPC envelope. The server enforces a **global** ~1 req/s/user limit — meaning "global per user, not per connection," so two parallel investigations for the same user share the same budget. The 429 response carries the window in the error text ("Retry after ~10 seconds" or "rate limit reached (1 per 10 second)"), which `BloomreachDataSource` parses (`lib/data-source/bloomreach-data-source.ts:64-77`).

```
  MCP boundary — what crosses, what fails

  ┌─ McpClient ──────┐  POST + Bearer + JSON-RPC  ┌─ Bloomreach MCP ─┐
  │ owns: cache,     │ ──────────────────────────► │ owns: workspace   │
  │ lastCallAt,      │ ◄────────────────────────── │ data, rate limit  │
  │ retry budget     │  200 (with isError?) or 429 │ window            │
  └──────────────────┘  with retry hint in text     └──────────────────┘

  failure modes:
   • 429 (rate-limited)        → parsed window, retry, bounded
   • isError: true in 200 body → surfaced to caller, NOT retried
   • transport error (e.g. 401) → thrown as McpToolError, NOT retried
   • timeout (network hang)    → NO explicit timeout; route's 300s
                                 is the only ceiling
```

The third bullet is a real distributed-systems gap — no per-call timeout means a hung MCP connection consumes the route's whole 300s budget. File 02 walks this.

#### The Anthropic box

Same shape as the MCP box: HTTPS, Bearer token, can rate-limit, can latency-spike. The code calls it inside `runAgentLoop` (`lib/agents/base.ts:102`) with no retry, no per-call timeout, no fallback model. The boundary is real but the failure handling is minimal: any error from `anthropic.messages.create()` bubbles up as the agent loop throwing, which the route catches and surfaces as `{ type: 'error' }` in the NDJSON stream. **Inferred:** Anthropic's SDK may do its own retry internally; the codebase does not configure or override it.

#### The Bloomreach IdP box

OAuth + PKCE + Dynamic Client Registration. The interesting part is that the *connect* request and the *callback* request are two separate HTTP requests, possibly landing on two different Vercel instances. The PKCE code verifier is generated during connect and must be readable during callback. The encrypted `bi_auth` cookie (`lib/mcp/auth.ts:86-104`) is what bridges Seam D — without it, callback fails with "no PKCE code_verifier stored for this session" because the instance that ran connect already recycled or never ran callback.

#### The SyntheticDataSource (in-process; NOT a distributed box)

Worth naming what's NOT a distributed boundary. The `SyntheticDataSource` adapter (`lib/data-source/synthetic-data-source.ts:314-331`) implements the same `DataSource` interface as `BloomreachDataSource` and is picked by `makeDataSource('live-synthetic', sid)`. But it lives entirely inside the Vercel JS process — no IPC, no subprocess, no network. `callTool` is a synchronous dispatch over a giant `switch` returning deterministic fixture data. There is no Seam F here; the synthetic adapter is hidden behind Seam B (the cosmetic in-process boundary). It's listed here so future readers don't draw it as an external box.

---

### Move 3 — the principle

A distributed-systems map isn't a diagram; it's a *prediction tool*. Every box on it is a thing that can be slow, dead, or lying. Every arrow is a guarantee that can fail. The work of distributed-systems engineering is making each arrow's failure mode survivable for the boxes on either side. blooming insights does this well for Seam C (`BloomreachDataSource`'s parsed-retry), well for Seam E (the encrypted cookie), badly for Seam B (no mechanism at all), and not yet for Anthropic-the-box (no retry, no timeout, no fallback). The earlier Phase-2 expansion to two distributed transports was reverted in PR #8 (2026-06-18); the `DataSource` interface still demonstrates the adapter pattern, but only Bloomreach actually crosses a process boundary now.

---

## Primary diagram

```
  blooming insights — the distributed map, every arrow labelled

  ┌─ Client (browser) ──────────────────────────────────────────────────┐
  │   React state (this render)                                           │
  │   sessionStorage:  bi:diag:<id>   bi:insight:<id>   bi:inv:<step>:<id>│
  │   localStorage:    bi:mode  (demo / live-synthetic / live-bloomreach) │
  │   cookies:         bi_session  bi_auth (encrypted)                    │
  └──────────────────┬────────────────────────────┬──────────────────────┘
                     │  HTTPS + cookies            │  HTTPS + cookies
                     ▼                             ▼
  ┌─ Vercel instance N ───────────┐   ┌─ Vercel instance M ────────────┐
  │   request-scoped variables     │   │   request-scoped variables      │
  │   ALS context (auth store)     │   │   ALS context (auth store)      │
  │   Map<id, Insight>             │   │   Map<id, Insight>  ← DIFFERENT │
  │   Map<id, AgentEvent[]>        │   │   Map<id, AgentEvent[]>         │
  │   cached: WorkspaceSchema      │   │   cached: WorkspaceSchema       │
  │   makeDataSource(mode, sid)    │   │   makeDataSource(mode, sid)     │
  │   (live-synthetic stays in-    │   │                                 │
  │    process; not drawn)         │   │                                 │
  └─────┬───────┬───────┬──────────┘   └────── (no link between them) ───┘
        │       │       │
        │ MCP   │ Anthr.│ IdP
        ▼       ▼       ▼
  ┌─ Bloomreach ─┐  ┌─ Anthropic ─┐  ┌─ IdP ──┐
  │  MCP server   │  │  API         │  │ OAuth   │
  │  1 req/s/user │  │  rate-       │  │ +DCR    │
  │  GLOBAL       │  │  limited     │  │ +PKCE   │
  │  429 carries  │  │  + variable  │  │         │
  │  retry hint   │  │  latency     │  │         │
  │  HTTP+SSE     │  │              │  │         │
  │  JSON-RPC 2.0 │  │              │  │         │
  └───────────────┘  └──────────────┘  └─────────┘

  guarantees that cross:
    Seam A (client↔inst):  cookies (auth, session), JSON request body
    Seam B (inst↔inst):    NOTHING — no shared store
    Seam C (inst↔MCP):     Bearer token, project_id, tool args
                           (transport: HTTPS+SSE)
    Seam D (inst↔Anthr):   API key, prompt + tool schemas
    Seam E (inst↔IdP):     PKCE verifier (saved in cookie at connect,
                           read from cookie at callback)
```

---

## Implementation in codebase

**Use cases.** This map is the artifact you reach for when:
- you find that an investigation works locally but fails on a cold-started Vercel deployment ("the insight isn't in the `Map`") — Seam B is the culprit
- you add a new external service (a new model provider, a feature-flag service, an analytics sink) and need to predict its failure mode — you add a new box and ask "what does the response carry that lets me retry intelligently?"
- you debug an OAuth callback that succeeds in dev but fails in production with "no PKCE code_verifier stored" — Seam E with the wrong backend chosen

**Code side by side.**

```
  lib/state/insights.ts  (lines 4-6, 30-42)

  const insights = new Map<string, Insight>();             ← process-local;
  const investigations = new Map<string, Investigation>();    no cross-instance
  const anomalies = new Map<string, Anomaly>();              link exists

  export function putInsights(items, rawAnomalies?) {
    insights.clear();                  ← each briefing replaces the feed;
    anomalies.clear();                    deliberate, but doubles down on
    items.forEach((i, idx) => {           the "one process, one truth" model
      insights.set(i.id, i);
      if (rawAnomalies?.[idx]) anomalies.set(i.id, rawAnomalies[idx]);
    });
  }
       │
       └─ this Map IS the gap. Two concurrent users on two Vercel
          instances each get a different Map. Neither knows the other
          exists. There's no error — the lookup just returns null.
```

```
  lib/mcp/auth.ts  (lines 86-104)

  export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
    if (process.env.NODE_ENV !== 'production') return fn();   ← dev passes through
    const { cookies } = await import('next/headers');
    const raw = (await cookies()).get(AUTH_COOKIE)?.value;
    const ctx: RequestStore = {                               ← seed ONCE from cookie
      store: raw ? decryptStore(raw) : {},
      dirty: false,
    };
    const result = await requestStore.run(ctx, fn);           ← all reads/writes hit ALS
    if (ctx.dirty) {
      (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {
        httpOnly: true, secure: true, sameSite: 'none',       ← cross-site so the
        path: '/', maxAge: AUTH_COOKIE_MAX_AGE,                 IdP return preserves it
      });
    }
    return result;
  }
       │
       └─ this IS the mechanism that crosses Seam E (instance↔instance) —
          the cookie is the carrier; the server is stateless across
          instances by design. Without this, callback would fail because
          the PKCE verifier lives on whichever instance ran connect.
```

```
  lib/hooks/useInvestigation.ts  (lines 18-19, 137-140)

  const stashKey = (step, id) => `bi:inv:${step}:${id}`;
  const diagHandoffKey = (id) => `bi:diag:${id}`;
                                                              ← these two keys ARE
                                                                the cross-request
                                                                state carriers
  // on 'done' event for the diagnose step:
  if (step === 'diagnose' && cDiag) {
    sessionStorage.setItem(
      diagHandoffKey(id),
      JSON.stringify({ diagnosis: cDiag }),
    );  ← step 3 will read this — the SERVER does not remember it
  }
       │
       └─ this is the stateless-server / stateful-client pattern, made
          load-bearing: the diagnosis hops client→server→client→server
          across two route invocations. file 04 walks the consistency.
```

---

## Elaborate

The map's value isn't completeness; it's the questions it makes obvious. "What if Bloomreach is down for 5 minutes?" → look at Seam C, find that `McpClient` retries 3 times at ~10s each, then bubbles the error up; the agent loop will throw; the route will emit `{ type: 'error' }`; the UI will show it. "What if Anthropic is slow today?" → Seam D, no retry, no timeout; the route's 300s budget is the only ceiling; if Anthropic takes 60s per turn, an 8-turn agent loop hits the wall. "What if Vercel recycles the instance mid-investigation?" → Seam B; the in-memory `Map` is gone; the next request lands on a different instance and `getCachedInvestigation` returns null; the demo snapshot is the fallback for replays, nothing exists for live runs.

The strongest signal a map is correct: each box names what it owns, each arrow names what crosses, and you can predict the failure mode without re-reading the code.

---

## Interview defense

**Q: What's distributed about this app?**
The boundaries, not the topology. Inside one Vercel invocation it's a single Node process. But every meaningful piece of state crosses a network into a partner I don't control — Bloomreach MCP for data, Anthropic for reasoning, the Bloomreach IdP for tokens. Each of those is a hop that can be slow, rate-limited, or unreachable. The distributed-systems lens is about *how the in-process code behaves when one of those hops fails*.

```
  the 3 real boundaries

  in-process code ──► Bloomreach MCP   (rate-limited, parsed-retry)
                  ──► Anthropic API    (no retry, no timeout)
                  ──► Bloomreach IdP   (PKCE verifier via cookie)
```

**Q: What's the gap in the map?**
Cross-instance coordination. The `Map` in `lib/state/insights.ts` is per-process. Vercel scales horizontally, so two requests can land on two different processes, and the app has no mechanism — no Redis, no KV, no broadcast — to reconcile them. It works at hackathon scale because the briefing runs maybe once per session per user, but the moment two users want a shared feed or one user wants persistence across deploys, the gap shows up.

```
  inst1 Map  ✕  inst2 Map     ← no link; the gap
              │
              └─ workaround: client carries state via sessionStorage
                 (bi:diag:<id>) — works for one-user single-session
                 flows; doesn't generalize
```

---

---

## See also

- `02-partial-failure-timeouts-and-retries.md` — Seam C in depth: how `BloomreachDataSource` handles the 429
- `04-consistency-models-and-staleness.md` — Seam A: what the client carries that the server can't remember
- `05-replication-partitioning-and-quorums.md` — Seam B (the gap): why NOT YET EXERCISED is honest
- `09-distributed-systems-red-flags-audit.md` — ranked risks across all four seams
- `10-transport-agnostic-protocol-design.md` — RETIRED; preserved as a record of the Phase-2 two-transport design (Olist subprocess) that was reverted in PR #8
- `.aipe/study-system-design/00-overview.md` — the architectural map (shape + storage); this file is its distributed-systems sibling

---
Updated: 2026-06-16 — Added Seam F (subprocess pipe to mcp-server-olist); refactored zoom-out and structure pass to cover heterogeneous backends; new subprocess box walked in How it works; line refs migrated from `lib/mcp/client.ts` to `lib/data-source/bloomreach-data-source.ts`.

---
Updated: 2026-06-19 — Seam F (stdio subprocess to mcp-server-olist) REMOVED after PR #8 deleted the Olist adapter. Boundaries revert to three (MCP, Anthropic, IdP) + one gap (cross-instance). Zoom-out diagram, structure pass, primary diagram revised; subprocess-box section replaced with a "what's NOT distributed" note covering the in-process `SyntheticDataSource`. `bi:mode` enum updated from `live-sql` → `live-synthetic`.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
