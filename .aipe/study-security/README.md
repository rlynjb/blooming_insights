# Security study — blooming insights

A trust-axis audit of this repo. The single question: **what can an attacker reach, and what happens when they do?** Every finding traces back to a boundary, a trust assumption, and what breaks if it's wrong.

## Through-line — trace the trust axis

```
  Trust axis — what can each side see, reach, or tamper with?

  ┌─ untrusted ─────────────────┐    seam     ┌─ trusted ─────────────────┐
  │ browser, IdP redirect,      │ ═════╪═════► │ Next.js route handlers,    │
  │ MCP tool results, LLM text  │             │ Anthropic / Bloomreach     │
  └─────────────────────────────┘             └────────────────────────────┘
            ▲                                            ▲
            └────── 3 trust boundaries (see 00-overview.md) ──────┘
                    every boundary either enforces a trust
                    decision or leaks one
```

## Map

```
  .aipe/study-security/
    README.md                       ← you are here
    00-overview.md                  ← trust map + 3 highest-risk findings
    audit.md                        ← Pass 1: the 8-lens audit
    01-encrypted-auth-cookie.md     ← Pass 2: AES-256-GCM bi_auth + ALS store
    02-oauth-pkce-dcr-boundary.md   ← Pass 2: OAuth 2.1 + PKCE + DCR
    03-per-agent-tool-allowlist.md  ← Pass 2: capability gating (+ regression)
    04-model-output-type-guard.md   ← Pass 2: type guard at model-output boundary
    05-secret-redaction.md          ← Pass 2: token-shape redaction before logs
    06-session-isolation.md         ← Pass 2: per-session state on shared instances
```

## Reading order

1. **`00-overview.md`** — verdict per primitive + the three highest-risk findings.
2. **`audit.md`** — the 8 lenses, each with `file:line` grounding or `not yet exercised`.
3. **Pass 2 files** — open in the order they're cross-linked from `audit.md`.

## Cross-links

- Trust boundaries map → `study-system-design/audit.md`'s system map.
- The `parseAgentJson` validator → `study-software-design`'s interface chapter.
- The DataSource adapter (the Bloomreach client) is treated as a port + adapter in `study-software-design`; this guide treats it as a trust seam.
