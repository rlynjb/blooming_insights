# study-security — blooming insights

The trust axis, walked in one file per boundary the repo actually enforces.

## The through-line

```
  every input is hostile until proven otherwise.
  every boundary either enforces a trust decision or leaks one.

  trace the trust axis:
     ↓
     where does untrusted input enter?     (attack surface)
     who is allowed past this boundary?    (authn / authz)
     what's hidden, what's exposed?        (secrets / data)
     what does the model let in?           (LLM/agent trust)
```

Every finding below ties to one of those beats: which boundary, which trust
assumption, what breaks if it's wrong.

## The trust map — three boundaries this repo enforces

blooming insights sits between three parties that don't trust each other by
default. The audit walks each one.

```
  Three trust boundaries — who talks to whom, and what crosses

  ┌─ Browser (visitor's machine) ────────────────────────────┐
  │  React UI · localStorage (bi:mode, bi:mcp_config)         │
  │  ↑ NDJSON stream                    ↓ fetch()             │
  └────────────────────────┬─────────────────────────────────┘
                           │  boundary 1: browser ↔ routes
                           │  cookies (bi_session, bi_auth), header
                           │  (x-bi-mcp-config, base64-JSON)
  ┌─ Next routes (blooming insights) ─▼──────────────────────┐
  │  /api/agent · /api/briefing · /api/mcp/*                  │
  │  auth store (ALS-scoped, cookie-backed in prod)           │
  │  ↑ Anthropic response                ↓ tool calls         │
  └───────────┬──────────────────────────┬───────────────────┘
              │ boundary 2:              │ boundary 3:
              │ routes ↔ Anthropic API   │ routes ↔ MCP server
              │ HTTPS + API key          │ HTTPS + Bearer / OAuth
              ▼                          ▼
       ┌─ Anthropic ─┐         ┌─ MCP server (user-chosen URL) ─┐
       │  claude-*   │         │  Bloomreach loomi alpha OR any │
       └─────────────┘         │  URL the visitor pasted        │
                               └────────────────────────────────┘
```

## Reading order

Start with `audit.md` for the eight-lens sweep. Pattern files walk the controls
the audit finds worth a deep read.

```
  audit.md                                     the 8-lens sweep · start here
    ├─ 01-encrypted-auth-cookie.md             AES-256-GCM + ALS store · cookie
    ├─ 02-oauth-pkce-dcr-boundary.md           OAuth 2.1 + PKCE + DCR at MCP hop
    ├─ 03-user-chosen-mcp-url-boundary.md      new trust surface · UI-picked URL
    ├─ 04-server-side-config-validation.md     header decode + isMcpConfigOverride
    ├─ 05-model-output-validation.md           parseAgentJson + type guards
    └─ 06-secret-redaction-in-errors.md        redactSecrets before logs/UI
```

## Cross-links

- `study-system-design/README.md` — architecture and request flow (adjacent axis).
- `study-software-design/README.md` — interfaces + complexity (adjacent axis).
- `study-testing/README.md` — how the controls above are proven (adjacent axis).
- `rehearse-interview-defense/README.md` — the security answers you rehearse
  when someone asks "what's the auth story?"

## Honest scope

- **No database → no SQLi, no row-level auth.** Every "storage" finding is
  really about in-memory maps or cookie-scoped state. Called out per-lens.
- **No multi-tenant authz.** The app is single-user-per-cookie. Session
  isolation, not tenant isolation, is what the audit checks.
- **No CSP / no rate limit at the edge.** Both flagged in the audit.
