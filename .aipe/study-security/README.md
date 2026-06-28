# study-security · reading order

The single question this guide answers: **what can an attacker reach in
blooming insights, and what happens when they do?**

The repo runs a Next.js 16 app that brokers a browser into a third-party
OAuth-protected MCP server, runs Claude as the policy engine, and streams
the agent's thinking back to the UI. Three trust boundaries carry the
weight. Trace them in this order and the rest of the file list reads in
context.

```
  the trust axis — three boundaries, in order

  ┌─ untrusted ──────────────┐
  │ browser  (query params,  │
  │ POST bodies, cookies)    │
  └──────────┬───────────────┘
             │  HTTP  ← boundary 1: route validates input + session
  ┌─ Service ▼───────────────┐
  │ Next.js API route        │
  └──────────┬───────────────┘
             │  MCP   ← boundary 2: OAuth2.1 + PKCE + DCR + AES-256-GCM cookie
  ┌─ Provider ▼──────────────┐
  │ Bloomreach MCP server    │
  └──────────┬───────────────┘
             │ Claude reads result; route validates model output
             │        ← boundary 3: parseAgentJson + type guards + FALLBACK
             ▼
  ┌─ UI ─────────────────────┐
  │ React (auto-escape)      │
  └──────────────────────────┘
```

## Read in this order

  1. `00-overview.md` — the whole-system map, the three boundaries, the
     single load-bearing control at each, and the one finding worth
     keeping awake at night.
  2. `audit.md` — the 8-lens pass: what the codebase does (with
     `file:line`) or "not yet exercised" honestly. The capstone red-flag
     checklist sits at the bottom.
  3. Pattern files (Pass 2) — discovered controls and gaps that earned a
     deep walk:

     - `01-encrypted-cookie-oauth-state.md` — how OAuth/PKCE/token state
       survives Vercel's stateless functions without a shared store: an
       AES-256-GCM-encrypted `bi_auth` cookie keyed by `AUTH_SECRET`.
     - `02-als-scoped-request-store.md` — how the SDK's many `state()` /
       `saveTokens()` calls in a single request all see one decrypted
       view of the store, with a single flush. Read-after-write inside
       one request without the Next.js request-vs-response cookie split.
     - `03-type-guard-trust-boundary.md` — how model output crosses from
       hostile string to typed value: `parseAgentJson` + per-shape type
       guards + `FALLBACK` constants. The seam between "what Claude
       said" and "what the UI renders."
     - `04-read-only-tool-whitelist.md` — how the agents are kept
       read-only by construction. Per-agent allowlists in
       `lib/mcp/tools.ts` mean `monitoring` literally cannot reach a
       write tool, even if Claude asks.
     - `05-open-tool-surface-gap.md` — the proxy-shaped route
       (`POST /api/mcp/call`). Now allowlisted against `ALL_KNOWN`, but
       still doesn't scope the allowlist by *agent* or by *args*, so a
       session-auth'd user (or stolen cookie) can call any
       bootstrap/diagnostic tool the union covers.

## What this guide does not cover

  → Bloomreach's own server security (out of scope; trust-boundary 2
    treats it as a black-box provider).
  → Distributed-systems threat modeling (Vercel's edge platform is
    trusted as a single-tenant runtime).
  → The dev-only routes (`/api/mcp/capture`, `/api/mcp/capture-demo`)
    beyond noting they're gated by `NODE_ENV === 'production'` and
    return 403 in prod. They're called out in `audit.md` for
    completeness, no pattern file.

## Cross-links to other study guides

  → `study-system-design/` — the architecture-and-scale story. Same
    boundaries, different axis (control + state instead of trust).
  → `study-software-design/` — the interfaces-and-complexity story. The
    `DataSource` seam is design; *who's allowed to call which tool* is
    security.
