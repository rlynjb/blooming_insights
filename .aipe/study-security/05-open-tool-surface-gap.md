# 05 · open-tool-surface-gap

**Confused-deputy at the proxy layer** · Industry standard
(over-broad allowlist on a session-auth-gated endpoint) — **the finding
to fix first**

## Zoom out — where this lives

The agents route (`/api/agent`) hands tool selection to Claude inside
the per-agent allowlist (`04-read-only-tool-whitelist.md`). The
*proxy* route (`POST /api/mcp/call`) does something different: it lets
the *browser* name a tool and forwards it to Bloomreach with the
session's OAuth token. It's the dev-debug surface that survived into
the deployed app — useful for the `/debug` page, sized like an admin
console.

```
  Zoom out — the proxy seam, where it sits

  ┌─ UI ─────────────────────────────────────────────────────────┐
  │ /debug page — call any tool, see the raw response             │
  │ feed/investigate pages — DON'T call /api/mcp/call directly    │
  └────────────────────────┬─────────────────────────────────────┘
                           │  fetch('POST /api/mcp/call',
                           │   { name, args })
                           ▼
  ┌─ Service ─── ★ /api/mcp/call ★ ──────────────────────────────┐ ← we are here
  │  • requires bi_session cookie (session-auth)                  │
  │  • requires bi_auth cookie with valid tokens                  │
  │  • gates name against ALL_KNOWN (union allowlist)             │
  │  • DOES NOT scope by agent role                               │
  │  • DOES NOT validate args                                     │
  └────────────────────────┬─────────────────────────────────────┘
                           │  Bearer <access_token>
                           ▼
  ┌─ Provider ───────────────────────────────────────────────────┐
  │ Bloomreach MCP — runs the named tool                          │
  └──────────────────────────────────────────────────────────────┘
```

The pattern is what makes it work and what makes it dangerous:
**a session-auth'd browser can ask the server to call any tool the
union of all agent allowlists covers.** Today that's read-only, so
the blast radius is bounded — but the boundary is wider than the UI
actually needs.

## Structure pass

  → **Layers.** Three: the *client* (any logged-in user's browser);
    the *proxy route* (the gate); the *Bloomreach server* (the
    tenant-scoped backend).

  → **Axis to hold constant: "who decides which tool gets called?"**

    ```
      altitude            decider
      ─────────────       ───────────────────────────────────────
      /api/agent          Claude (within the per-agent allowlist)
      /api/mcp/call       the client (within ALL_KNOWN)
      Bloomreach          the OAuth token (within the tenant scope)
    ```

    The axis answer flips at every altitude. On `/api/agent` Claude
    decides; on `/api/mcp/call` *the browser does*. That's the load-
    bearing distinction.

  → **Seams.** Two:
    - **client ↔ route** — the gate is "is this a logged-in session?
      and is the name in ALL_KNOWN?" That's the seam this file is
      about.
    - **route ↔ Bloomreach** — the token vouches for the tenant. The
      server enforces "you can only read your own tenant's data," not
      "you can only read what this UI shows."

## How it works — and where the gap sits

### Move 1 — the mental model

The classic "confused deputy" problem. The route is the deputy: it
holds an authority (the tenant's OAuth token) that the client
*shouldn't* be able to fully wield. When the client asks "please call
tool X with args Y," the deputy has to decide whether the *client*
should be allowed to wield that authority — not just whether the
deputy itself has it.

```
  the pattern — confused-deputy variant on the proxy

  client                      proxy route                    Bloomreach
  ──────                      ───────────                    ──────────
  POST /api/mcp/call
  { name, args }    ─────────►
                              ┌─ session cookie? ──────┐
                              │ yes → continue          │
                              │ no  → 401               │
                              └─────────────────────────┘
                              ┌─ name in ALL_KNOWN? ───┐
                              │ yes → continue          │
                              │ no  → 403               │
                              └─────────────────────────┘
                                       │
                              ┌─ args validated? ─────┐
                              │  ★ NO — args passed   │
                              │    through verbatim ★ │
                              └─────────────────────────┘
                                       │
                                       │ callTool(name, args)
                                       │ with Bearer <token>
                                       ▼
                                                              ┌─ tenant scope ─┐
                                                              │ enforced here  │
                                                              └────────────────┘
```

The deputy DOES check authentication and tool-name membership. It does
*not* check (a) whether the named tool belongs to the role this
client is acting as, or (b) whether the args are within the
expected shape.

### Move 2 — the step-by-step walkthrough

#### a · the gate today — the union allowlist (`ALL_KNOWN`)

Real code (`app/api/mcp/call/route.ts:14-33`):

```ts
const ALL_KNOWN = new Set<string>([
  ...monitoringTools,       // 13 tools
  ...diagnosticTools,       // 16 tools
  ...recommendationTools,   //  7 tools
  ...bootstrapTools,        //  6 tools
]);
// ── after de-dup, ~30-ish unique tool names ──

export async function POST(req: NextRequest) {
  try {
    const { name, args } = await req.json();
    if (typeof name !== 'string' || !ALL_KNOWN.has(name)) {
      return NextResponse.json({ error: 'tool not allowed' }, { status: 403 });
    }
    const sid = await getOrCreateSessionId();
    const conn = await connectMcp(sid);
    if (!conn.ok) {
      return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });
    }
    const r = await conn.mcp.callTool(name, args ?? {}, { skipCache: true });
    return NextResponse.json({ result: r.result, durationMs: r.durationMs });
  } catch (e) {
    console.error('[mcp-call] error:', redactSecrets(formatError(e)));
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
```

What works:
  → `ALL_KNOWN.has(name)` blocks an attacker from naming
    `delete_customer` or `trigger_scenario`. The previous version of
    this route (before the allowlist landed) accepted any string. The
    fix closed the worst leak.
  → The session-auth gate (`connectMcp(sid)` returning `!ok` ⇒ 401)
    means an unauthenticated request can't even reach the call.
  → The OAuth token's tenant scope means even an allowed call can
    only reach the requesting user's own Bloomreach workspace.

What's missing:
  → **Per-agent scope.** A user clicking around the UI never invokes
    `list_cloud_organizations` directly — that's bootstrap-only. But
    the proxy allows it. The blast radius is bounded by Bloomreach's
    tenant scope, but the *attack surface inside that scope* is wider
    than the UI ever uses.
  → **Args validation.** The route forwards `args ?? {}` to
    Bloomreach verbatim. For `execute_analytics_eql`, that means a
    session-auth'd caller can send arbitrary EQL — they're bounded
    to read queries against their tenant, but they can issue any read
    they like (any cohort breakdown, any property access).

#### b · the actual exposure — sized honestly

Let's measure it. **The attacker model is "a user with a valid
`bi_session` + `bi_auth` cookie pair."** That's:
  → the legitimate user (no concern — they can already see this data
    via the UI),
  → an attacker who has stolen the cookie pair (XSS-resistant via
    `httpOnly`; cross-site possible because `SameSite=None` is
    required for the OAuth return path — but mitigations exist, see
    below).

The attacker can issue any tool call in `ALL_KNOWN` with any args.
Concretely:

```
  what a cookie-stealing attacker can DO via /api/mcp/call today

  ┌─ category ───────────┬─ already accessible via UI? ─────────┐
  │ list_dashboards      │ yes (briefing page calls this)        │
  │ get_event_schema     │ yes (bootstrap auto-runs)             │
  │ execute_analytics_eql│ yes (the agent runs these)            │
  │ list_customers       │ yes (diagnostic agent uses this)      │
  │ list_voucher_pools   │ no  (recommendation agent — but the   │
  │                      │      user can navigate there)         │
  │ list_cloud_organizat.│ no  (bootstrap-only — never user-     │
  │                      │      reachable from the UI)           │
  └──────────────────────┴───────────────────────────────────────┘

  even the "no" rows are tenant-scoped to the victim's own workspace
  → information leak, not data destruction
  → severity: medium (info disclosure, no integrity loss)
```

The takeaway: this is **information disclosure** of data the victim
themselves has access to. It's not a privilege escalation, it's not
data destruction, it's not cross-tenant. But it IS a wider surface
than the UI needs, and a wider surface than the principle of least
authority would draw.

#### c · the three fixes, ranked

```
  the fix ladder — best to worst

  ┌─ option A: delete /api/mcp/call ──────────────────────────────┐
  │ the /debug page is the only consumer. dev-only. gate it       │
  │ behind NODE_ENV !== 'production' (mirroring /api/mcp/capture, │
  │ /api/mcp/capture-demo).                                       │
  │ pro: full attack-surface removal in prod                      │
  │ con: lose the prod debugging affordance                       │
  └───────────────────────────────────────────────────────────────┘

  ┌─ option B: scope by agent role ───────────────────────────────┐
  │ accept { name, args, role } in the body; intersect the        │
  │ allowlist with the role's tool list. role comes from the       │
  │ session's last-known-agent (set by the agent route).           │
  │ pro: per-call POLA, prod still has the call surface            │
  │ con: more code, role state to track                            │
  └───────────────────────────────────────────────────────────────┘

  ┌─ option C: tighten ALL_KNOWN ─────────────────────────────────┐
  │ keep only the small set the prod UI actually invokes through  │
  │ this route. today the UI never calls /api/mcp/call from the   │
  │ feed/investigate pages — so the "needed" set may literally    │
  │ be empty.                                                     │
  │ pro: minimal code change                                      │
  │ con: still wider than zero; need to recheck on each UI change │
  └───────────────────────────────────────────────────────────────┘
```

The right answer for this app is probably **option A** (dev-only
gate). The prod UI doesn't call this route — the agents do all the
heavy work via `/api/agent` and `/api/briefing`, which use the
per-agent allowlists. The only consumer is `/debug`, which is a
developer convenience.

#### d · adjacent hardening — what would close the rest

Even after fixing the proxy, two cookie-theft mitigations would
shrink the wider attack surface:

  → **`Origin`/`Referer` check on POSTs.** `SameSite=None` is needed
    for the OAuth return path, but every other POST route could
    require the `Origin` header to match the app's host. That blocks
    cross-site `fetch()` POSTs from an attacker page. The OAuth
    callback (GET, not POST) is unaffected.

  → **Shorter `bi_auth` max-age.** Currently 10 days
    (`lib/mcp/auth.ts:49`). For an admin-shape app, 1-4 hours with a
    silent refresh on activity would shrink the cookie-theft window
    significantly. Trade-off: more interactive re-auths.

Both of these are in the audit's red-flag table (#11 and the wider
cookie-lifetime discussion); they're worth doing *with* the proxy fix,
not instead of it.

### Move 3 — the principle

**The deputy must check who's asking, not just whether the asker is
authenticated.** A session cookie says "this is the user." It does
*not* say "the user is allowed to wield every authority the server
holds on their behalf." Confused-deputy bugs are the gap between
those two facts. The fix is always the same shape: give the deputy a
per-call notion of "what's this request *trying* to do" and reject
when it doesn't match the asker's role.

## Primary diagram

```
  the full picture — what's gated, what isn't, what to add

  ┌─ client ──────────────────────────────────────────────────┐
  │ POST /api/mcp/call { name, args }                         │
  │ cookies: bi_session, bi_auth                              │
  └────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
  ┌─ /api/mcp/call route ─────────────────────────────────────┐
  │                                                            │
  │  ✅ gate 1: bi_session present  →  connectMcp(sid)          │
  │  ✅ gate 2: ALL_KNOWN.has(name) →  403 if not              │
  │  ⚠️ gate 3: args validated      →  NO (passed through)     │
  │  ⚠️ gate 4: name in *this role's* allowlist → NO          │
  │  ⚠️ gate 5: Origin header check → NO                       │
  │                                                            │
  │  conn.mcp.callTool(name, args ?? {})                       │
  │       │                                                    │
  └───────┼────────────────────────────────────────────────────┘
          │  Bearer <access_token>
          ▼
  ┌─ Bloomreach MCP ──────────────────────────────────────────┐
  │  ✅ tenant scope enforced by token (the floor that holds) │
  └───────────────────────────────────────────────────────────┘

  the closure plan:
  ┌────────────────────────────────────────────────────────────┐
  │ 1. dev-only gate (option A) — prod doesn't need the route  │
  │ 2. Origin/Referer check on every POST                       │
  │ 3. cookie max-age trim                                      │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Confused-deputy is one of the older bug classes in security; the term
comes from a 1988 paper by Norm Hardy about a compiler with write
authority being tricked into clobbering the wrong file. Web shape:
CSRF is a confused-deputy bug (the browser is the deputy, with the
victim's cookies). API proxy shape: this file. The defense pattern
across all variants: every operation needs a check that ties the
*authority* to the *intent*, not just the *identity*.

For LLM-backed apps the shape mutates: `/api/agent` keeps Claude
inside a per-agent allowlist, so the *model* can't pick a tool out of
scope. But the *proxy* sidesteps Claude entirely — the browser names
the tool. That's a different threat model, and it needs a different
gate.

Adjacent reading:
  → OWASP A01:2021 — Broken Access Control. The category name covers
    this exact shape.
  → "Capability-based security" (Mark Miller et al.) — the formal
    model behind POLA. The proxy violates it because the client gets
    to use the route's full capability (= tenant token authority)
    instead of a narrow capability scoped to "the tool this UI flow
    needs."

## Interview defense

### Q1. "Is this exploitable today? How big a deal is it?"

```
  the threat model — what actually breaks

  attacker model       what they achieve
  ───────────────       ───────────────────────────────────────
  unauthenticated       NOTHING — session-auth gate blocks
  authenticated user    same as the UI — they could already do this
  stolen cookie pair    READ any of ~30 tools in ALL_KNOWN
                        (tenant-scoped to victim's workspace)
                         ── information disclosure
                         ── no integrity loss
                         ── no cross-tenant reach
```

Severity: medium. It's a real finding (named in `00-overview.md` as
the headline) but not a code-red. The previous version of the route
(before the `ALL_KNOWN` gate landed) would have been high — that
version accepted any tool name, including writes. The current state
is "wider than necessary," not "open to the world."

**One-line anchor:** "Medium. Information disclosure of tenant-scoped
data — no writes, no cross-tenant. Previous-version-with-no-allowlist
was high; the current gate dropped it to medium."

### Q2. "Why not fix it right now if it's the top finding?"

Honest answer: it's near-trivial to fix — option A (dev-only gate) is
~3 lines of code. The reason it's still on the list:

  → The `/debug` page in prod is occasionally useful (the alpha MCP
    server has flaky moments and being able to verify a specific
    tool call from a prod cookie is genuinely helpful).
  → No exploitation observed; the cookie theft prerequisite is
    non-trivial.
  → The team is small (one); fixing it requires deciding whether
    `/debug` survives in prod.

That's not a defense — it's a backlog explanation. The audit's
top finding is "fix it," not "live with it."

**One-line anchor:** "Fix is 3 lines. Open because the prod /debug
page is occasionally useful and no exploitation has been seen — but
the fix wins on POLA."

### Q3. "What would you actually ship as the fix?"

The minimum viable fix, in commit order:

  1. Gate the route on `NODE_ENV !== 'production'` (same pattern as
     `/api/mcp/capture`, `/api/mcp/capture-demo`). Return 403 in
     prod.
  2. Add an `Origin` header check on every POST in `app/api/**` (one
     middleware, four routes) — closes the CSRF half of the
     wider-cookie-attack surface.
  3. Drop `bi_auth` max-age to 4 hours with refresh-on-activity from
     the agent routes. Shrinks the cookie-theft window.

The audit's red-flag table item #2 (the top finding) is closed by
step 1. Steps 2 and 3 are defense-in-depth that the audit also calls
out (table item #11 and the cookie lifetime in the wider lens-2
discussion).

```
  the close-out plan — three small PRs, ranked by leverage

  PR 1: dev-only gate on /api/mcp/call    ← closes the top finding
        + redirect the /debug page to a   ← prod UX restored without
          local dev workflow                the proxy

  PR 2: Origin check middleware            ← stops cross-site POSTs
        on every API POST route             (CSRF defense)

  PR 3: shorter bi_auth max-age            ← shrinks cookie-theft
        + refresh on agent activity         window
```

**One-line anchor:** "Three small PRs — dev-only gate (the fix),
Origin check on POSTs, shorter cookie max-age. PR 1 closes the
finding; PRs 2 and 3 are the defense-in-depth around it."

## See also

  → `04-read-only-tool-whitelist.md` — the per-agent allowlists this
    proxy bypasses.
  → `01-encrypted-cookie-oauth-state.md` — the cookie pair an
    attacker would need to steal to weaponize this gap.
  → `audit.md` § lens 2 (authz) and § lens 8 (red-flag #2, the top
    finding).
