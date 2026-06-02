# Open tool surface gap

**Industry name(s):** missing allowlist, capability bypass, confused-deputy via untrusted RPC, debug-route-in-production
**Type:** Project-specific (the unvalidated `POST /api/mcp/call` body and tool-name surface); Industry standard (allowlist-on-RPC pattern as the fix)

> The single high-severity finding in this codebase: `POST /api/mcp/call` reads `{name, args}` from the request body and forwards both directly to `conn.mcp.callTool(name, args ?? {}, { skipCache: true })`. No body schema. No tool-name allowlist. No `if (NODE_ENV === 'production') return 403` gate. Gated only by session authentication. The blast radius today is bounded by two upstream facts: Bloomreach owns per-user authz on the OAuth token, and every tool Bloomreach exposes today is read-only. Both bounds are *not in our code*. The moment Bloomreach adds a write tool, this route exposes it to every authenticated session — including CSRF victims, because there's no CSRF token either. This file walks the gap, names every defense that's missing, and shows the one-line structural fix that closes it.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Per-agent tool whitelists (`04-read-only-tool-whitelist.md`) bound the tool surface at the agent boundary — the model only sees the tools its agent role permits. `POST /api/mcp/call` is a *different* path that completely bypasses that boundary: the client sends the tool name in the request body, and the route forwards it. It's a debug-introspection endpoint that exposes the *raw* MCP surface to anyone who can authenticate to the app.

```
  Zoom out — two paths to the MCP transport

  ┌─ Browser ──────────────────────────────────────────┐
  │                                                     │
  │  PATH A: agent flow                                 │
  │    → /api/agent or /api/briefing                    │
  │    → constructs agent (whitelisted tools)           │
  │    → model emits tool_use within whitelist          │
  │                                                     │
  │  PATH B: direct MCP call         ★ THIS FILE ★      │
  │    → /api/mcp/call               ← we are here      │
  │    → body { name, args }                            │
  │    → forwarded as-is                                │
  │                                                     │
  └───────────────────────────┬─────────────────────────┘
                              │
  ┌─ MCP transport ───────────▼─────────────────────────┐
  │  StreamableHTTPClientTransport                      │
  │  callTool(name, args, { skipCache: true })          │
  │  ★ both paths land here ★                           │
  │  ★ path A goes through filterToolSchemas first ★    │
  │  ★ path B does NOT ★                                │
  └─────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The pattern is *an authenticated RPC endpoint that exposes upstream tools by name with no per-call allowlist*. Common in debug/admin tooling that grew into production routes. The defense is structural — add an allowlist of permitted names at the route entry — and the cost is one line. The reason it persists in the codebase is `/debug` uses this route to introspect arbitrary tools, and adding the allowlist might constrain debug use cases the developer hasn't enumerated.

---

## Structure pass

**Layers.** Three altitudes that compound this finding. The **route** (`app/api/mcp/call/route.ts` — 22 lines; reads body, calls tool, returns result). The **transport** (the MCP SDK's `StreamableHTTPClientTransport` — does whatever the route asked). The **upstream** (Bloomreach MCP server — final enforcer of "does this tool exist" and "is this user authorized for the underlying resource").

**Axis: trust.** Hold one question constant: *who decides which tools can be called via this route?* The route: nobody (no allowlist). The transport: nobody (forwards whatever it's given). The upstream: yes — Bloomreach decides tool existence + per-user authz. So today the *only* enforcer is upstream. There's no in-app gate.

**Seams.** Two missing seams. **Seam 1 (body → tool name)** has no schema enforcement — the body could be `{name: anything, args: anything}`. **Seam 2 (route → callTool)** has no allowlist check — the name flows through. Both should exist; neither does. The route is a transparent pipe from `{name, args}` to MCP.

```
  Structure pass — the gap

  ┌─ 1. LAYERS ───────────────────────────────────────┐
  │  route (no schema, no allowlist)                   │
  │  transport (forwarder)                             │
  │  upstream (the only real gate)                     │
  └────────────────────────┬──────────────────────────┘
                           │  hold the trust question
  ┌─ 2. AXIS ─────────────▼───────────────────────────┐
  │  trust: who decides what tools can be called?      │
  └────────────────────────┬──────────────────────────┘
                           │  trace, find the missing gates
  ┌─ 3. SEAMS ────────────▼───────────────────────────┐
  │  body → tool name      ★ MISSING: schema           │
  │  route → callTool      ★ MISSING: allowlist        │
  │  upstream → MCP        present (Bloomreach authz)  │
  └────────────────────────┬──────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped. Next we walk the mechanics — both the exposure and the fix.

---

## How it works

### Move 1 — the mental model

You know how SQL injection happens when you concatenate user input into a query without parameterization? `POST /api/mcp/call` is the structural sibling: the tool name comes from the request body and gets used as the *name parameter* of an RPC call without any constraint check. The model that prevents SQL injection — parameterize the query, validate input against an allowlist — is the same model that should be applied here. Today there's no allowlist; the tool name is whatever the body says.

```
  Open RPC surface — the pattern's shape

   request body                       upstream RPC
   ┌──────────────────────┐           ┌──────────────────────┐
   │  { name: <STRING>,   │  ──▶      │  callTool(<STRING>,  │
   │    args: <ANY> }     │  forward  │    <ANY>)            │
   └──────────────────────┘  as-is    └──────────────────────┘

   what's between them?       NOTHING in our code
   ↓
   no schema check on body
   no allowlist on name
   no shape check on args
   no rate limit
   no CSRF token
   no production gate
```

The only check is "do you have a valid session?" That's authentication, not authorization. Anyone authenticated can call any tool the upstream exposes.

### Move 2 — the step-by-step walkthrough

#### Skeleton parts — what's missing (the kernel of the finding)

```
  Skeleton — what a hardened RPC endpoint needs

  ┌──────────────────────────────────────────────────┐
  │  1. AUTHN GATE                                    │
  │     "do you have a session?"                       │
  │     present? YES (connectMcp check exists)         │
  ├──────────────────────────────────────────────────┤
  │  2. BODY SCHEMA                                    │
  │     "are name and args the expected shape?"        │
  │     present? NO — body is `await req.json()` raw   │
  ├──────────────────────────────────────────────────┤
  │  3. TOOL-NAME ALLOWLIST                            │
  │     "is name in the set of permitted tools?"       │
  │     present? NO — name forwarded as-is             │
  ├──────────────────────────────────────────────────┤
  │  4. PRODUCTION-USAGE GATE                          │
  │     "is this a dev-only route?"                    │
  │     present? NO — runs in prod just like dev       │
  ├──────────────────────────────────────────────────┤
  │  5. CSRF DEFENSE                                   │
  │     "did the user intend this request?"            │
  │     present? NO (no CSRF token anywhere in app)    │
  └──────────────────────────────────────────────────┘
```

Parts 1 is present. 2-5 are all missing. The audit's high-severity finding is the combination of (3) + (4) — anyone authenticated, in production, can call any tool by name.

#### Step 1 — what the route actually does

```
  POST /api/mcp/call — the entire route (paraphrased)

  POST(req):
    try:
      { name, args } = await req.json()              ← body is whatever client sent
      sid  = await getOrCreateSessionId()
      conn = await connectMcp(sid)                   ← AUTHN GATE: requires session
      if not conn.ok:
        return 401 { needsAuth: true, authUrl }
      r = await conn.mcp.callTool(                   ← UNFILTERED forward
        name,
        args ?? {},
        { skipCache: true }                          ← also bypasses any caching
      )
      return { result: r.result, durationMs }
    catch (e):
      return 500 { error: e.message + '\n' + e.stack }  ← C6: leaks stack
```

Twenty-two lines. The only check between the request body and `conn.mcp.callTool` is the session check via `connectMcp`. Whatever `name` the client sent gets called.

#### Step 2 — what the route *was* for and why it persists

The route is the introspection endpoint for `/debug`. The debug page lets a developer pick a tool from the discovered list and call it with arbitrary args — useful for verifying tool behavior, testing args shapes, capturing fixtures. The dev use case justifies the *flexibility* — any tool, any args. The problem is the dev use case doesn't justify *the route running in production with no production-only gate*.

The route's siblings get this right:
- `app/api/mcp/capture/route.ts` L22–L24 returns 403 if `NODE_ENV === 'production'`
- `app/api/mcp/capture-demo/route.ts` L13–L16 returns 403 if `NODE_ENV === 'production'`

Both are dev-only. Both check `NODE_ENV` at the top of the handler. `app/api/mcp/call/route.ts` doesn't.

#### Step 3 — the realistic attack scenarios

```
  Attack scenarios — what could happen today

  Scenario A: Bloomreach has no dangerous tools
   attacker (authenticated)
        │
        │ POST /api/mcp/call { name: 'delete_segment', args: {...} }
        ▼
   route forwards to MCP
        │
        │ Bloomreach: "delete_segment? unknown tool"
        ▼
   500 returned, no damage
   → BOUNDED today by upstream not having the tool

  Scenario B: Bloomreach adds a write tool (hypothetical)
   attacker (authenticated)
        │
        │ POST /api/mcp/call { name: 'create_scenario', args: {...} }
        ▼
   route forwards to MCP
        │
        │ Bloomreach: validates Bearer (user IS the user); executes
        ▼
   200 returned, scenario CREATED at Bloomreach on user's behalf
   → NOT BOUNDED — upstream's authz says "this user can create scenarios"

  Scenario C: CSRF + dangerous tool
   victim visits attacker.example
        │
        │ <form action="https://blooming-insights.app/api/mcp/call"
        │   method="POST"> + auto-submit script
        │
        │ POST /api/mcp/call { name: '<write_tool>', args: {...} }
        ▼
   victim's bi_session + bi_auth cookies attached (SameSite=None)
        │
        ▼
   same as Scenario B but the victim didn't intend it
   → NOT BOUNDED — no CSRF token, no Origin check
```

Scenarios A and C demonstrate the gap. Scenario A is today's reality (no damage). Scenario C is the deployment shape where the gap matters: any *future* write tool, any *future* CSRF vector, escalates to "attacker mutates the user's Bloomreach workspace from a malicious page."

#### Step 4 — the one-line structural fix

```
  The allowlist — pseudocode

  // at module load, build the union of all known-permitted tools
  const ALL_KNOWN = new Set([
    ...monitoringTools,
    ...diagnosticTools,
    ...recommendationTools,
    ...bootstrapTools,
  ])

  POST(req):
    { name, args } = await req.json()
    if not ALL_KNOWN.has(name):                     ← THE FIX
      return 403 { error: 'tool not permitted' }
    // ... rest of route unchanged
```

That's it. One Set construction at module load, one membership check per request. The Set is built from the same arrays that gate the agent surface — so adding a new tool to an agent's whitelist automatically permits it here too.

Cost of the fix: **zero behavior change for legitimate use**, because `/debug` only calls tools in the whitelisted set anyway (it discovers the list of permitted tools from `GET /api/mcp/tools` which already filters to known-good tools). Cost of *not* shipping the fix: the route remains the single highest-severity exposure in the codebase, bounded only by upstream and only as long as upstream doesn't add a write tool.

#### Step 5 — additional hardening (the next-mile moves)

The allowlist closes the high-severity gap. There's more to harden if the deployment shape warrants:

```
  Additional hardening — per defense layer

  defense                    closes                        cost
  ─────                      ─────                         ─────
  body schema (zod)          malformed body, type confusion 2-3 lines
  args allowlist per tool    arg-level injection           per-tool work
  rate limit                 cost amplification            framework dep
  CSRF token check           confused-deputy via browser   small infra
  Origin allowlist            cross-origin POST attacks     1-2 lines
  NODE_ENV production gate    "is this debug-only?"         1 line
  audit log                   forensics                     small infra
```

The structural fix is the allowlist. The other hardenings depend on the deployment context (single-user demo vs multi-tenant SaaS). The allowlist is *unconditional* — it's correct in every deployment shape and costs nothing.

### Move 2.5 — current state vs future state

This finding has a real Phase A → Phase B comparison worth drawing because the *severity* of the finding depends on what Bloomreach does upstream.

```
  Phase A — TODAY                       Phase B — HYPOTHETICAL
  ─────                                 ─────
  Bloomreach has no write tools         Bloomreach adds a write tool
  attacker calls /api/mcp/call          attacker calls /api/mcp/call
    with arbitrary name                   with the write tool's name
  upstream: "unknown tool"               upstream: "valid; executing"
  500 returned, no damage                200 returned, MUTATION done
                                                      │
                                                      │ on the
                                                      │ user's
                                                      │ workspace
                                                      ▼
                                          ★ Critical-severity exploit ★

  audit severity rating:                audit severity rating:
   HIGH (today, "could become critical") CRITICAL (the moment Bloomreach changes)

  what changes:                         what changes:
   no code change needed                 still no code change needed
   bound is upstream + read-only-tools   bound is GONE
```

The fix takes the same shape in both phases: add the allowlist. The difference is *when the missing fix becomes catastrophic* — today it's a posture problem; the moment Bloomreach ships a write tool, it's an active exploit.

### Move 3 — the principle

**Defenses that rely on an upstream's posture are conditional defenses.** They're correct as long as the upstream doesn't change. They become wrong silently the moment the upstream changes — because the change happens outside your codebase, outside your review, outside your CI. Structural defenses in your own code don't have that property: an allowlist in your route stays correct regardless of what Bloomreach ships. Prefer in-app structural defenses over "upstream won't expose anything dangerous" assumptions.

---

## Primary diagram

The full picture of the gap and the fix, side by side.

```
  POST /api/mcp/call — current vs hardened

  ┌─ TODAY ────────────────────────────────────────────────────────┐
  │                                                                  │
  │  POST(req):                                                      │
  │    body = await req.json()           ← any shape                 │
  │    sid  = await getOrCreateSessionId()                           │
  │    conn = await connectMcp(sid)                                  │
  │    if not conn.ok: return 401                                    │
  │    r = await conn.mcp.callTool(                                  │
  │           body.name,                  ← ★ ANY name forwards ★    │
  │           body.args ?? {},                                       │
  │           { skipCache: true }                                    │
  │         )                                                        │
  │    return { result: r.result }                                   │
  │                                                                  │
  │  enforcement points:                                             │
  │   ★ authn (session)        ✓                                     │
  │     body schema            ✗                                     │
  │     tool-name allowlist    ✗ ← this is the audit's H1 finding    │
  │     production gate        ✗                                     │
  │     CSRF token             ✗                                     │
  │                                                                  │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ HARDENED (one-line fix) ──────────────────────────────────────┐
  │                                                                  │
  │  const ALL_KNOWN = new Set([                                     │
  │    ...monitoringTools, ...diagnosticTools,                       │
  │    ...recommendationTools, ...bootstrapTools,                    │
  │  ])                                                              │
  │                                                                  │
  │  POST(req):                                                      │
  │    body = await req.json()                                       │
  │    if (!ALL_KNOWN.has(body.name)) {           ← ★ ALLOWLIST ★    │
  │      return NextResponse.json(                                   │
  │        { error: 'tool not permitted' },                          │
  │        { status: 403 }                                           │
  │      )                                                           │
  │    }                                                             │
  │    sid  = await getOrCreateSessionId()                           │
  │    // ... rest unchanged ...                                     │
  │                                                                  │
  │  enforcement points:                                             │
  │   ★ authn (session)        ✓                                     │
  │     tool-name allowlist    ✓ ← H1 closed                         │
  │     body schema            (optional next-mile)                  │
  │     production gate        (optional, would also work)           │
  │     CSRF token             (separate B4 fix)                     │
  │                                                                  │
  └─────────────────────────────────────────────────────────────────┘
```

The structural property worth memorizing: **the fix is the same code shape that protects the agent flow — an allowlist on the tool name — just applied at a different entry point.**

---

## Implementation in codebase

**Use case 1 — legitimate /debug introspection (today).** Developer opens `/debug`. The page calls `GET /api/mcp/tools` to discover available tools. Developer picks `list_funnels` from the dropdown, clicks Run. Browser POSTs to `/api/mcp/call` with `{name: 'list_funnels', args: {}}`. Route forwards to MCP. Result comes back. Page renders the JSON. Works fine — no allowlist needed because the tool was a legitimate read.

**Use case 2 — hostile authenticated user (today).** Logged-in user (or an attacker who has compromised someone's session) opens DevTools, fires `fetch('/api/mcp/call', {method: 'POST', body: JSON.stringify({name: 'create_scenario', args: {...}})})`. Route forwards. Bloomreach returns "unknown tool" (assuming `create_scenario` doesn't exist today). 500 with the upstream error. No damage. But the round trip happened; an attacker is enumerating Bloomreach's tool surface for free.

**Use case 3 — CSRF + future write tool (hypothetical).** Bloomreach has shipped `create_scenario`. Victim with active session visits `attacker.example`. Attacker page contains `<form action="https://blooming-insights.app/api/mcp/call" method="POST">` with hidden inputs and an auto-submit script. Browser POSTs cross-origin with victim's cookies (`SameSite=None`). Route forwards. Bloomreach creates a scenario on the victim's workspace. Victim's Bloomreach is now mutated. The victim never intended the request.

**Use case 4 — what the hardened route does in scenarios 2-3.** Route reads body. `ALL_KNOWN.has('create_scenario')` → false (it's not in any agent whitelist). Returns 403 immediately. No call to MCP. No round trip. No upstream load. Both scenarios end at the route.

```
  app/api/mcp/call/route.ts  (current, lines 1–22)

  import { NextRequest, NextResponse } from 'next/server';
  import { getOrCreateSessionId } from '@/lib/mcp/session';
  import { connectMcp } from '@/lib/mcp/connect';

  export async function POST(req: NextRequest) {
    try {
      const { name, args } = await req.json();         ← body is whatever
      const sid = await getOrCreateSessionId();        ← bi_session cookie
      const conn = await connectMcp(sid);
      if (!conn.ok) {
        return NextResponse.json(
          { needsAuth: true, authUrl: conn.authUrl },
          { status: 401 },
        );
      }
      const r = await conn.mcp.callTool(               ← ★ unfiltered forward ★
        name,
        args ?? {},
        { skipCache: true },
      );
      return NextResponse.json({ result: r.result, durationMs: r.durationMs });
    } catch (e) {
      return NextResponse.json(                        ← C6: leaks e.stack
        { error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) },
        { status: 500 },
      );
    }
  }
       │
       └─ note the two findings in 22 lines:
          - H1 (no tool-name allowlist) at line 13
          - C6 (e.stack in error response)  at line 18
```

```
  The hardened version — adds 6 lines, removes 1, fixes H1 (and C6)

  import { NextRequest, NextResponse } from 'next/server';
  import { getOrCreateSessionId } from '@/lib/mcp/session';
  import { connectMcp } from '@/lib/mcp/connect';
  import {                                              ← NEW import
    monitoringTools, diagnosticTools,
    recommendationTools, bootstrapTools,
  } from '@/lib/mcp/tools';

  const ALL_KNOWN = new Set<string>([                  ← NEW: build allowlist once
    ...monitoringTools, ...diagnosticTools,
    ...recommendationTools, ...bootstrapTools,
  ]);

  export async function POST(req: NextRequest) {
    try {
      const { name, args } = await req.json();
      if (typeof name !== 'string' || !ALL_KNOWN.has(name)) {   ← THE FIX
        return NextResponse.json(
          { error: 'tool not permitted' },
          { status: 403 },
        );
      }
      const sid = await getOrCreateSessionId();
      const conn = await connectMcp(sid);
      if (!conn.ok) {
        return NextResponse.json(
          { needsAuth: true, authUrl: conn.authUrl },
          { status: 401 },
        );
      }
      const r = await conn.mcp.callTool(name, args ?? {}, { skipCache: true });
      return NextResponse.json({ result: r.result, durationMs: r.durationMs });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },  ← C6 fix: drop stack
        { status: 500 },
      );
    }
  }
       │
       └─ both H1 and C6 closed in the same diff.
          behavior unchanged for /debug's actual usage
          (it only calls tools in the whitelisted set).
```

---

## Elaborate

### Where this pattern comes from

**The "debug endpoint in production"** anti-pattern dates to early CGI scripts — a route designed for development that quietly stayed enabled in production deployment. The classic example is `/admin` paths with default credentials, but the modern incarnation is "diagnostic RPC accepts arbitrary commands." Splunk, Elasticsearch, Redis (early versions) all had variants of this.

**Allowlists over denylists** is OWASP catechism (Cheatsheet Series 2002+). The structural argument: denylists are inherently incomplete (you can't enumerate every bad string), allowlists are inherently complete (you enumerate the small set of good ones). For tool names, the allowlist is tiny (~40 tools across all agent whitelists), so the allowlist approach is essentially free.

**Capability-based RPC bounds** are the agent-era reframing. The MCP protocol itself was designed assuming "the client constrains what tools the model sees." `POST /api/mcp/call` is the case where the client deliberately exposes the *full* MCP surface without the constraint. Putting the constraint back in at the route entry restores the model.

### The deeper principle

**Every entry point that crosses the trust boundary needs its own enforcement.** You can't rely on enforcement at one entry point (`/api/agent` via `filterToolSchemas`) to protect another (`/api/mcp/call` via... nothing). Each route is independent; each needs to apply the same discipline. The audit's job is to find the entry points that *don't* — and this is the one.

```
  Two paths to the same dangerous capability

   /api/agent          /api/mcp/call
   ─────               ─────
   filterToolSchemas → bypassed entirely
   model bounded       client sends name
   structural          ★ no structural defense ★
   defense in place    ★ this is the gap ★
                            │
                            │ both reach
                            ▼
                  conn.mcp.callTool(name, args)
                            │
                            ▼
                       Bloomreach MCP
                       (final upstream gate)
```

The pattern at `/api/agent` is "filter the tools the model sees so it can't even ask for the wrong ones." The pattern at `/api/mcp/call` should be "filter the tools the client can name so the client can't even ask for the wrong ones." Same shape, different entry point.

### Where this fits in the audit

This is the **H1 finding** — the single highest-severity item in `audit.md`. It's also tagged as **A7** (input validation lens) and **B6** (authz lens) because it's both:
- An input-validation gap: the request body's `name` field isn't validated against an allowlist.
- An authz gap: there's no per-tool authorization beyond "you have a session."

Either lens points at the same code. The fix is the same one line.

The audit also notes this finding pairs with several mediums that *would* compound under a deployment-shape change:
- B4 (CSRF on `POST /api/mcp/reset`) — same CSRF vector applies here.
- E4 (no CI audit gate) — if Bloomreach ships a write tool and a downstream dependency update brings new tools into our surface, no automation catches it.
- F9 (recommendation latent write surface) — separate path to the same "write capability lands" concern.

### Connection to adjacent patterns

This file is the *missing* counterpart to `04-read-only-tool-whitelist.md`. The whitelist file documents how capability minimization is *correctly applied* at the agent boundary; this file documents where it's *not applied* at a non-agent entry point. Reading both gives the full picture: the pattern is the same; the gap is the one place the pattern isn't reached for.

The fix uses the same arrays declared in `lib/mcp/tools.ts` — same `monitoringTools` / `diagnosticTools` / `recommendationTools` / `bootstrapTools`. Single source of truth for "what tools are this app permitted to use, anywhere."

---

## Interview defense

**What they are really asking:** can you name the highest-severity finding in the codebase, defend why it's high-severity given that no exploit is possible today, and explain the one-line fix?

---

**[mid] — Walk me through the highest-severity finding in your audit.**

`POST /api/mcp/call` in `app/api/mcp/call/route.ts`. The route reads `{name, args}` from the request body and passes them straight to `conn.mcp.callTool(name, args ?? {}, { skipCache: true })`. No schema check on the body, no allowlist on the tool name, no production-only gate, no CSRF token. Only gated by session authentication.

Today it's bounded because every tool Bloomreach's MCP server exposes is read-only — there's no write tool the route can call even if an attacker triggers it. So no exploit is currently possible. But that bound is *upstream's posture*, not in our code. The moment Bloomreach ships a write tool, this route exposes it to every authenticated session, including CSRF victims. That makes it high-severity-with-could-become-critical.

The fix is one line at the top of the route: build a Set of all known tool names from the four agent whitelists in `lib/mcp/tools.ts`, reject any name not in the set with 403. No behavior change for `/debug` (the only legitimate consumer) because `/debug` only ever calls whitelisted tools.

```
  one-line fix

  if (!ALL_KNOWN.has(name)) return 403
                  │
                  └─ ALL_KNOWN = new Set([...monitoringTools, ...diagnosticTools,
                                          ...recommendationTools, ...bootstrapTools])
```

---

**[senior] — Why is this high-severity if no exploit is possible today?**

Three reasons. **The bound is outside our code.** The defense rests on "Bloomreach won't ship a write tool" — that's a posture assumption, not an enforcement. A Bloomreach release notes update tomorrow could invalidate it without any change in our repo. Our CI won't catch it; our review won't catch it.

**The fix is essentially free.** One line, no behavior change for legitimate use, no operational cost. When a fix is this cheap and the failure mode is this severe, "we know about it" isn't enough — defer is only justified when fixing costs something. This costs nothing.

**It compounds with other accepted-risk items.** No CSRF token, no Origin check, no production-only gate. Each is individually accepted-risk for a single-user demo. Stacked, they mean a single Bloomreach API change converts this into a CSRF-able mutation endpoint. The high-severity rating reflects the *velocity* of the threat surface, not just its current state.

```
  why HIGH and not MEDIUM

  bound is upstream         conditional defense
  fix is free               low cost, big payoff
  compounds with CSRF+no-Origin  attack chain shape
  ────────────────────────  ──────────────────────
  → HIGH                     → MEDIUM would be
                              if any of these flipped
```

---

**[arch] — Defend leaving this route open as it is. When is it the right call?**

It's the right call exactly never if you ship the one-line fix, because the fix doesn't change `/debug`'s behavior. Concretely: `/debug` enumerates available tools by calling `GET /api/mcp/tools` (which already returns the per-agent-whitelisted set) and only calls tools from that set. The allowlist on `/api/mcp/call` would be the union of all agent whitelists — strictly broader than what `/debug` uses. So `/debug` is unaffected.

The only argument for leaving it open is "we might want to call a non-whitelisted tool from `/debug` someday for testing." That's a real use case but it's one developers do *from their local machine, in dev mode*, not in production. The right design for that case is the production gate: `if (NODE_ENV === 'production') return 403`. That preserves the unconstrained surface in dev (for testing) and closes it in prod (for safety). Either the allowlist or the production gate closes the finding; both together would be belt-and-suspenders.

The honest "ship anyway" framing: this app is a portfolio piece. The current threat model is "one developer using it from one browser." No CSRF victim, no concurrent users. Severity ratings encode "how would this scale with deployment shape" — for the current deployment, the finding is real but the *exploit* requires deployment-shape change. For a hackathon submission, the audit ledger plus a one-line PR captures the situation honestly.

---

**The dodge — "isn't this CSRF protection's job, not the route's?"**

Partially. A working CSRF token on every POST would defang scenario C (the cross-origin attack). But scenario B (authenticated user, perhaps an insider, perhaps an XSS-compromised session) is unaffected by CSRF defense — the user IS authenticated. The allowlist closes both scenarios because it's a capability bound, not an intent check.

CSRF and the allowlist are layered defenses. CSRF asks "did the user intend this?" The allowlist asks "is this an action the route permits?" Both are real defenses; both are missing on this route. The allowlist is the cheaper fix and protects more scenarios (including the future-write-tool scenarios that CSRF wouldn't fully address — an authenticated insider with a `create_scenario` call doesn't need CSRF to do damage).

---

**One-line anchors:**
- Highest-severity finding in the codebase: `POST /api/mcp/call` accepts any tool name with no allowlist; gated only by session auth.
- Bounded today by Bloomreach having no write tools, not by anything in our code; the bound is conditional.
- Fix is one line: `if (!ALL_KNOWN.has(name)) return 403` where `ALL_KNOWN` is the union of agent whitelists.
- Compounds with CSRF gaps and no production-only check; current threat model is small but the gap scales with deployment shape.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, name the five enforcement points a hardened version of this route would have, and say which are present today. Then check against the **Primary diagram**.

### Level 2 — Explain
Why doesn't the audit consider the upstream MCP server's authz (which DOES validate "is this user authorized for this resource") as sufficient defense? What does the route-side allowlist add that the upstream doesn't? Reference `app/api/mcp/call/route.ts` L13 and `lib/mcp/tools.ts`.

### Level 3 — Apply
Bloomreach announces `create_segment` will land next quarter. Walk through what specifically you'd do in this codebase: would you add the tool to any agent's whitelist? What additional defenses (CSRF, human-in-loop confirmation, audit log) would you add to the agent flow before shipping support for it? Reference the patterns in `04-read-only-tool-whitelist.md`.

### Level 4 — Defend
A teammate proposes adding the allowlist as a *denylist* instead: `if (DANGEROUS.has(name)) return 403`. Defend or refute. (Hint: trace what happens when Bloomreach adds `delete_user` next quarter and you haven't updated the denylist.)

### Quick check
- What's the file and line range of the route? → `app/api/mcp/call/route.ts` L5–L22.
- What's the only check present today? → Session authentication via `connectMcp`.
- What's the one-line fix? → `if (!ALL_KNOWN.has(name)) return NextResponse.json({error: 'tool not permitted'}, {status: 403})` where `ALL_KNOWN` is the union of agent whitelists from `lib/mcp/tools.ts`.
- Why is this high-severity if no exploit is possible today? → Bound is upstream (Bloomreach not having write tools), not in our code; one Bloomreach release could turn it critical.

---

## See also

→ [audit.md](./audit.md) · [04-read-only-tool-whitelist.md](./04-read-only-tool-whitelist.md) · [03-type-guard-trust-boundary.md](./03-type-guard-trust-boundary.md)
