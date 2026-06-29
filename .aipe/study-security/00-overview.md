# Overview — security at a glance

## Verdict per primitive

- **Authentication.** OAuth 2.1 + PKCE + DCR against Bloomreach loomi connect. Tokens persist in an AES-256-GCM `bi_auth` cookie (production) or a gitignored file (dev). The IdP is the authority; the app stores no passwords.
- **Authorization.** No per-user role/permission model — the app inherits whatever the OAuth-bound Bloomreach user can do, scoped per session cookie. There's no app-side authz check; if you have the cookie, you have the access. Acceptable for a single-tenant analyst tool; load-bearing assumption.
- **Session.** httpOnly + Secure + SameSite=None `bi_session` cookie, per-session ALS-scoped store, per-session in-memory feed state.
- **Encryption.** AES-256-GCM (AEAD) for the production token cookie; key derived by SHA-256 of `AUTH_SECRET`. No TLS termination in app — relies on Vercel's edge.
- **Capability gating.** Two layers — a union allowlist on `POST /api/mcp/call` (`ALL_KNOWN`), and a per-agent tool-subset constant (`monitoringTools` / `diagnosticTools` / `recommendationTools`). The per-agent subset is **wired into the legacy code paths but not into the live AptKit-based agents** — see finding 1 below.
- **Input validation.** A defensive parser (`parseAgentJson`) + three type guards (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`) at the model-output boundary. Only the legacy agent files call them; the AptKit-based path returns typed objects from the SDK without re-validating at the seam.
- **Secret hygiene.** `redactSecrets` rewrites Bearer/access_token/refresh_token/id_token/code_verifier shapes before logging or stuffing into error envelopes; `.auth-cache.json` + `.investigation-cache.json` are gitignored; `AUTH_SECRET` only enforced in production.
- **LLM / agent security.** Model output flows into the UI through a type-guard at the legacy boundary and through the SDK's typed response at the AptKit boundary. Tool results from MCP feed straight into the model context (truncated at 4KB on the wire; no provenance check on the model's tool choice beyond the union allowlist).

## Trust map

```
  Trust boundaries — 3 hops, every cookie/header labelled

  ┌─ Browser (untrusted) ─────────────────────────────────┐
  │  React UI · bi_session cookie · bi_auth cookie         │
  └──────────────┬─────────────────────────────────────────┘
                 │   hop 1: HTTPS · GET/POST /api/...
                 │   (SameSite=None cookies survive IdP return)
  ┌─ Next.js routes (trusted boundary) ───────────────────▼┐
  │  /api/briefing  /api/agent  /api/mcp/{call,callback,...}│
  │  · per-session ALS store (RequestStore)                 │
  │  · ANTHROPIC_API_KEY · AUTH_SECRET in env               │
  └──────┬────────────────────────────────────┬─────────────┘
         │ hop 2: HTTPS Bearer                │ hop 3: HTTPS x-api-key
         │ (OAuth access token)               │ (Anthropic key)
         ▼                                    ▼
  ┌─ Bloomreach MCP server ──────┐    ┌─ Anthropic API ─────────┐
  │  loomi connect alpha          │    │  Claude sonnet + haiku  │
  │  (third-party, rate-limited)  │    │                         │
  └──────────────────────────────┘    └────────────────────────┘
```

**The most exposed boundary:** hop 1, the browser → Next routes seam. Cookie theft (XSS on a different deployment, malicious browser extension, exfiltrated `bi_auth`) hands an attacker the OAuth-bound Bloomreach session of whoever owned the cookie. SameSite=None is necessary for the OAuth round-trip but widens CSRF exposure on state-changing GETs (the streaming routes are GETs).

## The three highest-risk findings

### 1. Per-agent capability gate has regressed in the AptKit path

**File:** `lib/agents/diagnostic.ts:38`, `lib/agents/monitoring.ts:83`, `lib/agents/recommendation.ts:33`, `lib/agents/query.ts:27`
**Trust assumption broken:** *"each agent only sees the tools it needs."* The legacy classes built the Anthropic tool list with `filterToolSchemas(this.allTools, monitoringTools)` etc. (`lib/agents/monitoring-legacy.ts:108`, `lib/agents/diagnostic-legacy.ts:62`, `lib/agents/recommendation-legacy.ts:54`, `lib/agents/query-legacy.ts:37`). The new AptKit-based classes pass `this.allTools` straight into `BloomingToolRegistryAdapter`, and the adapter's `listTools()` returns every tool the Bloomreach server exposes (`lib/agents/aptkit-adapters.ts:81-87`). The per-agent constants in `lib/mcp/tools.ts` are now only consumed by the union allowlist on `/api/mcp/call` and by `tool-coverage.ts` — not by any live agent loop.
**What an attacker reaches:** the diagnostic agent (which should only read events) can now be steered by a crafted prompt to call any tool the server lists — including write/admin tools if the OAuth scope grants them. Prompt-injection blast radius widens from each agent's task surface to the union surface.
**Fix:** thread an `allowedTools: readonly string[]` argument into `BloomingToolRegistryAdapter`, call `filterToolSchemas` (or its equivalent) in each agent class, and pass `monitoringTools` / `diagnosticTools` / `recommendationTools` / `queryTools` respectively. See `03-per-agent-tool-allowlist.md` for the walk.

### 2. SameSite=None on the session cookie + state-changing GETs

**File:** `lib/mcp/session.ts:10-14`, `app/api/agent/route.ts:110`, `app/api/briefing/route.ts:77`
**Trust assumption broken:** *"a cross-site request can't drive a write."* `bi_session` and `bi_auth` are `SameSite=None` so the OAuth callback round-trip survives (`lib/mcp/auth.ts:96-98`). Both `/api/agent` and `/api/briefing` are **GET** endpoints that consume real budget (Anthropic tokens, Bloomreach rate-limit quota) per call. A cross-origin `<img src="https://your-app/api/briefing?demo=cached">` from any site the user has open in another tab will burn budget — and `/api/agent?insightId=...` will spend ~100s of investigation budget per hit while leaking the streaming response back-channel-style.
**What an attacker reaches:** budget exhaustion (cost-based DoS) and forced re-investigation of arbitrary insight IDs without user intent. The streaming response itself isn't exfiltrated cross-origin (the browser blocks the read), but the side effects fire.
**Fix:** add a `Sec-Fetch-Site` check (or a short-lived CSRF token in the cookie validated against a request header) on `/api/briefing` and `/api/agent`. The OAuth callback at `/api/mcp/callback` still needs SameSite=None for the cookie return, so the fix is application-layer, not cookie-layer.

### 3. OAuth `state` validation is intentionally disabled at the callback

**File:** `app/api/mcp/callback/route.ts:22-26`, `lib/mcp/auth.ts:225-235`
**Trust assumption broken:** *"the callback `code` belongs to the auth request this session started."* The MCP SDK calls `provider.state()` more than once per flow, which broke a naive "store-last, compare-on-callback" check, so the route comment notes the recheck was removed and a comment in `lib/mcp/auth.ts:227-228` says the SDK "performs its own state handling." The SDK does generate a `state` parameter and sends it on the authorize URL — but a re-verification at the callback layer would catch a forged callback that the SDK's own equality check might not surface to the application.
**What an attacker reaches:** a CSRF login attack — a victim clicks an attacker's pre-signed authorize URL, the callback lands on the victim's session, and the attacker's OAuth-bound Bloomreach identity gets persisted in the victim's `bi_auth` cookie. Now the victim's "live" briefings query the attacker's workspace, and any per-session in-memory state mingles. The attack surface is narrow (the victim has to click a malicious authorize link), but the consequence is full session takeover.
**Fix:** implement a state store that survives the SDK calling `state()` multiple times (return the same value within a flow, then consume-and-clear at the callback). The skeleton `consumeState` is already exported and tested but unwired.

## Where to next

- **`audit.md`** for the full 8-lens walk.
- **`01-encrypted-auth-cookie.md`** for why the cookie is the way it is.
- **`03-per-agent-tool-allowlist.md`** for the regression's full deep walk + fix sketch.
- **`04-model-output-type-guard.md`** for the model-output boundary.
