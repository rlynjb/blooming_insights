# 00 · overview

The whole system in one frame, with the trust axis traced across it.

## Zoom out — three boundaries, one map

```
  blooming insights — trust map

  ┌─ UI ─────────────────────────────────────────────────────────────┐
  │ React 19 (app/page.tsx, components/*)                            │
  │   • renders agent answer via {expression} (auto-escape)          │
  │   • no dangerouslySetInnerHTML in the answer path                │
  └─────────────────────────────┬────────────────────────────────────┘
                                │
                                │ hop 1 — fetch('/api/agent?q=…')
                                │ cookies: bi_session, bi_auth
                                ▼
  ╔═══ trust boundary 1 ═══════════════════════════════════════════╗
  ║ browser → API route                                              ║
  ║   • query params (q, insightId, insight, diagnosis, step)        ║
  ║   • POST bodies (capture-demo, mcp/call)                         ║
  ║   • session cookie identifies but does NOT authorize per-resource║
  ╚═══════════════════════════════════════════════════════════════════╝
                                │
  ┌─ Service ────────────────── ▼ ───────────────────────────────────┐
  │ Next.js 16 route handlers (app/api/**)                            │
  │   • per-session in-memory map (lib/state/insights.ts) — session-  │
  │     scoped so concurrent users can't read each other's anomalies  │
  │   • console.error logs full stack; JSON response carries .message │
  │     only (no .stack on the wire); secrets redacted before logging │
  └─────────────────────────────┬────────────────────────────────────┘
                                │
                                │ hop 2 — MCP over HTTPS
                                │ Bearer <access_token> (OAuth 2.1)
                                ▼
  ╔═══ trust boundary 2 ═══════════════════════════════════════════╗
  ║ route → Bloomreach MCP                                           ║
  ║   • OAuth 2.1 + PKCE + Dynamic Client Registration               ║
  ║   • token store: AES-256-GCM in httpOnly bi_auth cookie (prod)   ║
  ║   • per-call: ~1 req/s, 30s timeout, retry on 429                ║
  ╚═══════════════════════════════════════════════════════════════════╝
                                │
  ┌─ Provider ───────────────── ▼ ───────────────────────────────────┐
  │ loomi-mcp-alpha.bloomreach.com — black box                        │
  └─────────────────────────────┬────────────────────────────────────┘
                                │
                                │ hop 3 — tool result (JSON)
                                │ + Claude reads/decides
                                ▼
  ╔═══ trust boundary 3 ═══════════════════════════════════════════╗
  ║ model output → typed value                                       ║
  ║   • parseAgentJson tolerates fences / wrapper prose              ║
  ║   • per-shape type guards (isAnomalyArray, isDiagnosis, …)       ║
  ║   • FALLBACK constants when the model returns garbage            ║
  ╚═══════════════════════════════════════════════════════════════════╝
                                │
                                ▼
                        back to UI (auto-escaped)
```

Three boundaries. Read the trust axis across them and the same question
gets three different answers:

```
  axis = "what can each side see or tamper with?"

  ┌─ browser ─┐         ┌─ route ─┐         ┌─ Bloomreach ─┐         ┌─ Claude ─┐
  │ everything│ ──────► │ session │ ──────► │ tenant       │ ──────► │ tool     │
  │ the user  │  cookie │ scoped  │  bearer │ scoped       │ result  │ output   │
  │ types     │         │ in-mem  │         │ by token     │         │ as JSON  │
  └───────────┘         └─────────┘         └──────────────┘         └──────────┘
        ▲                    ▲                     ▲                      ▲
        │                    │                     │                      │
   untrusted            partial trust          provider trust         untrusted
   (input)              (per-session)          (the token vouches)    (output)
```

The boundary that flips trust hardest: the **first** one (browser →
route). Past it, the route runs Node with whatever permissions the
deployment grants, talking to a third-party API over a token the cookie
unlocks. Every other boundary's strength depends on that first one
holding.

## Zoom in — the one load-bearing control at each boundary

  → **Boundary 1.** The `bi_session` cookie scopes per-session state
    (`lib/state/insights.ts:14`, `lib/mcp/session.ts:11`). Two users on
    the same warm Vercel instance can't see each other's insights or
    investigations — but a logged-in user can still call any tool the
    union allowlist covers (see boundary-2 caveat).

  → **Boundary 2.** The `bi_auth` cookie holds the OAuth tokens
    AES-256-GCM-encrypted under `AUTH_SECRET`
    (`lib/mcp/auth.ts:51-67`). Tampering corrupts the GCM auth tag,
    `decryptStore` swallows the throw and returns `{}` —
    re-authentication, not impersonation
    (`lib/mcp/auth.ts:69-79`). The cookie is the only thing the SDK and
    the route share across requests on Vercel; without it, PKCE
    verifier and DCR client info would be lost between `/connect` and
    `/callback`.

  → **Boundary 3.** `parseAgentJson` + per-shape type guards
    (`lib/mcp/validate.ts:3-13`, `17-57`). The agent can return malformed
    JSON, an extra prose tail, a fence, or the wrong shape — every path
    falls back to a typed `FALLBACK` instead of crashing the route or
    flowing junk into the UI.

## The single finding that earns the headline

`POST /api/mcp/call` is the proxy seam: the browser names a tool, the
route calls it on the (token-bound) MCP server, the response comes back
as JSON. The original version of this route accepted any string for
`name`. The current version (`app/api/mcp/call/route.ts:14-27`) gates
against `ALL_KNOWN = monitoringTools ∪ diagnosticTools ∪
recommendationTools ∪ bootstrapTools`, returning 403 for anything else.

**That closes the worst leak** — an attacker can no longer name an
arbitrary write tool like `delete_customer`. What's still open: the
allowlist is the **union** across every agent, not scoped per-agent or
per-args. A session-auth'd caller (or a stolen `bi_session` + `bi_auth`
pair) can:

  → call `list_cloud_organizations` (bootstrap-only in the agent path)
    even though the user-facing UI never reaches it,
  → call `execute_analytics_eql` with arbitrary EQL (no shape
    validation on `args`), constrained only by the rate limit and the
    server's tenant scope on the OAuth token.

The fix is one of (a) drop `/api/mcp/call` (the agent path covers
production needs), (b) tighten the allowlist to the small set the UI
actually invokes outside the agent, or (c) require the caller to name
which agent role they're acting under and intersect. Pattern walk in
`05-open-tool-surface-gap.md`.

## Where to read next

  → `audit.md` — the 8-lens pass with `file:line` evidence.
  → Then the five pattern files in the README's reading order.
