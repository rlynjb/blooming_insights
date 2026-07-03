# audit.md — the 8-lens security sweep

One `##` section per lens. Real files, real line ranges. Where the repo doesn't
exercise a lens, it says so and names what would earn it.

## Verdict up front

**The one that would break you first.** Live agents run against every tool the
MCP server exposes, not just the per-agent subset. The per-agent tool whitelist
(`monitoringTools`, `diagnosticTools`, `recommendationTools` in
`lib/mcp/tools.ts`) is only consumed by the `-legacy` classes — the live
`MonitoringAgent` / `DiagnosticAgent` / `RecommendationAgent` / `QueryAgent`
pass `allTools` directly to AptKit's registry (see `lib/agents/monitoring.ts:86`,
`lib/agents/diagnostic.ts:56`, `lib/agents/recommendation.ts:40`,
`lib/agents/query.ts:27`). This is the LLM/agent-security lens (§7) below —
scope regression from the AptKit migration.

**Second-worst.** The visitor-controlled MCP URL. UI now lets anyone paste an
arbitrary URL (`components/settings/McpConfigModal.tsx:126`); that URL sees
every tool call the agent makes. Warned in the UI, validated server-side, but
it's a real new trust boundary — walked in
`03-user-chosen-mcp-url-boundary.md`.

**What's actually strong.** The auth-cookie discipline
(AES-256-GCM + ALS-scoped RequestStore + one seed + one flush) in
`lib/mcp/auth.ts:86-104`, and the type-guard-at-model-output seam in
`lib/mcp/validate.ts:17-57`. Both survive a hard look.

## 1. trust-boundaries-and-attack-surface

Three trust boundaries. Not four — the retired Olist synthetic subprocess is
gone; only the AptKit-in-process synthetic remains
(`lib/data-source/synthetic-data-source.ts`), which shares the route's trust
domain.

**Boundary 1 — browser ↔ Next routes.** Every request rides three surfaces:

  → `bi_session` cookie (`lib/mcp/session.ts:1-24`) — the identity anchor;
    `HttpOnly`, `SameSite=None` + `Secure` in prod, `Lax` in dev.
  → `bi_auth` cookie (`lib/mcp/auth.ts:48-104`) — AES-256-GCM ciphertext of
    the per-session OAuth store (DCR client info, PKCE verifier, tokens).
  → `x-bi-mcp-config` header (`lib/mcp/config.ts:37`) — base64-JSON of the
    UI-picked MCP config override, re-attached to every streaming fetch.

  Also relevant: query params on `/api/agent` (`insightId`, `q`, `insight`,
  `diagnosis` — all JSON-shaped) and `/api/mcp/callback` (`code`, `error`).

**Boundary 2 — routes ↔ Anthropic.** Server-side, HTTPS, `ANTHROPIC_API_KEY`
from env. No user-controlled path here — the key is server-owned.

**Boundary 3 — routes ↔ MCP server.** The one that changed in Session D. Was
"always Bloomreach loomi alpha," now: whatever URL the visitor's browser
supplies via the config header (`components/settings/McpConfigModal.tsx:126`),
falling through to `MCP_URL` env, `BLOOMREACH_MCP_URL` env, or the hardcoded
alpha default. Precedence chain lives in `lib/mcp/connect.ts:38-48`. The MCP
server sees every tool call. Deep walk in
`03-user-chosen-mcp-url-boundary.md`.

**Attack surface, in one picture.**

```
  Everything hostile until proven otherwise

  visitor's browser
    ├─ URL / query params ─────────┐
    ├─ cookies (bi_session, bi_auth) │  → app/api/agent/route.ts
    ├─ x-bi-mcp-config header ─────┤    app/api/briefing/route.ts
    ├─ ?insight= (JSON blob) ──────┤    app/api/mcp/*/route.ts
    └─ ?q= (free-form text) ───────┘

  Anthropic response (model output)
    └─ tool_use inputs ────────────► lib/mcp/validate.ts (type-guarded)

  MCP server response
    └─ JSON envelope ──────────────► lib/mcp/transport.ts (captured, redacted)

  Environment
    └─ MCP_URL / MCP_AUTH_TOKEN ───► trusted by shape; not by content
```

Red flag caught: the query-param `?insight=` JSON blob is parsed with a
loose `typeof/Array.isArray` shape check (`app/api/agent/route.ts:36-46`) and
then handed straight to the agent. It doesn't cross a persistence boundary,
but it does drive the diagnostic agent's prompt. A malformed blob is caught,
but a well-shaped adversarial blob would pass. Prompt-injection concern only.

## 2. authentication-and-authorization

**Authn: strong. Authz: single-user-per-cookie.**

  → OAuth 2.1 + PKCE + Dynamic Client Registration to Bloomreach — walked in
    `02-oauth-pkce-dcr-boundary.md`. The `BloomreachAuthProvider`
    (`lib/mcp/auth-providers/bloomreach.ts`, re-exported from `lib/mcp/auth.ts`
    for backward compat) drives the SDK's flow; PKCE verifier + client info
    persist across the redirect via the encrypted cookie.
  → New auth-provider abstraction (Session B) — `BloomreachAuthProvider`,
    `BearerAuthProvider`, `AnonymousAuthProvider`, all under
    `lib/mcp/auth-providers/`. Factory: `makeAuthProvider` at
    `lib/mcp/auth-providers/index.ts:56-76`.
  → Env parse with validation: `readAuthEnv()` at
    `lib/mcp/auth-providers/index.ts:44-53` throws if
    `MCP_AUTH_TYPE=bearer` but `MCP_AUTH_TOKEN` is unset. Server-side guard;
    fails fast at process start rather than at first tool call.

**Authz gap — real but small.** Session-scoped in-memory maps
(`getAnomaly(sid, id)` in `lib/state/insights.ts`) mean visitor A can't read
visitor B's anomalies on the same instance. Cross-instance (Vercel ephemeral
functions), state is instance-local; a request routed to a different instance
sees `null`. That's not an authz hole so much as no shared store — sessionStorage
handoff (`?insight=` param) is the real cross-instance channel.

  Red flag NOT firing: no endpoint that "checks logged-in but not allowed" —
  because there's only one user's data anyway. This lens fully lights up on a
  multi-tenant repo; this repo is too small to exercise it.

## 3. input-validation-and-injection

No SQL, no shell, no fs writes from user input, no server-rendered HTML.

**Where user input reaches a sink:**

  → LLM prompts — `?q=` (free-form) flows into the QueryAgent's system prompt.
    The intent classifier (`lib/agents/intent.ts`) runs first, but the raw
    string still lands in the model. Prompt injection is the exposed risk,
    not string escape. Called out under §7.
  → EQL queries — the agent (not the user) constructs EQL against the MCP
    server. No direct user→EQL path.
  → Header decode — `x-bi-mcp-config` decodes via base64 → JSON → type guard
    (`lib/mcp/config.ts:87-100`). Malformed input decodes to `null`; bad
    base64 caught inside the `try` block; unknown `authType` values rejected
    by `isMcpConfigOverride`. Fail-safe: falls through to env.
    Deep walk: `04-server-side-config-validation.md`.
  → `?insight=` param — JSON.parse'd, then a shape check
    (`typeof metric === 'string' && Array.isArray(scope) && …`)
    at `app/api/agent/route.ts:36-46`. Malformed blob throws inside the try,
    caught, falls through to server-side lookup. A well-shaped adversarial
    blob would pass — but the only sink is the diagnostic agent's prompt, so
    it collapses into prompt injection again.

**Red flag caught: no CSP, no strict `Content-Security-Policy` header.** The
UI renders agent-supplied strings (`InsightCard`, `RecommendationCard` titles
+ rationale) via React — safe against DOM XSS by default (React escapes) — but
without a CSP an `<img src=x onerror=…>` string that slipped through would
still be a defense-in-depth gap. Fix: add CSP in `next.config.ts` (headers()
function) with `default-src 'self'` and Anthropic + MCP hosts in `connect-src`.

## 4. secrets-and-configuration

**What lives where:**

  → `AUTH_SECRET` — env only. Derives the AES-256 key for the auth cookie via
    `sha256(AUTH_SECRET)` (`lib/mcp/auth.ts:51-60`). Missing in prod → throws
    a clear error at first cookie touch.
  → `ANTHROPIC_API_KEY` — env only. Checked at `app/api/agent/route.ts:154-156`;
    missing → 500 with a plain error.
  → `MCP_AUTH_TOKEN` — env only, read by `readAuthEnv()`. Never client-visible.
  → `MCP_URL` / `BLOOMREACH_MCP_URL` — env, non-secret.
  → OAuth `code_verifier`, `access_token`, `refresh_token`, client info — live
    inside the encrypted cookie in prod; a gitignored `.auth-cache.json` in
    dev. Both paths noted in `lib/mcp/auth.ts:22-35`.
  → **Bearer tokens NEVER land in the encrypted cookie.** The cookie is
    reserved for OAuth (session-persisted). Bearer stays in localStorage
    (client-only) or env (server-only). This is the design invariant that
    keeps the cookie's threat model clean.

**.gitignore audit.** `.env*` (with `!.env.example` allowlist),
`.auth-cache.json`, `.investigation-cache.json` — all excluded. No secrets
committed. Lockfile present (`package-lock.json`).

**Bundle-side secrets.** None. Every secret above is `process.env.*` reads
inside `app/api/**` or `lib/mcp/**` — server-only surfaces. Client code only
touches localStorage.

**Log hygiene.** `redactSecrets` (`lib/mcp/transport.ts:66-76`) strips
`Bearer …`, `access_token`, `refresh_token`, `id_token`, `code_verifier`
matches from any string headed to `console.error`. Called at every error path
in `/api/agent` and `/api/briefing` (`route.ts:174, 317`). Deep walk:
`06-secret-redaction-in-errors.md`.

**Red flag caught: dev auth cache holds tokens in plaintext.** Called out in
`lib/mcp/auth.ts:32-33` — local-only, gitignored, but a stolen laptop with a
dev checkout still exposes them. Live tokens rotate on the alpha server anyway
(minutes-long window), so the residual exposure is small. Called out honestly,
not fixed.

## 5. data-exposure-and-privacy

No PII storage. The workspace being analyzed is Bloomreach ecommerce data —
customer counts, event counts, aggregate revenue. Individual customer records
are fetched by the diagnostic agent via `list_customers` /
`list_customers_in_segment`, then land in the tool-call `result` field, then
into the ReasoningTrace UI, then into the demo snapshot if captured.

**The exposure surfaces:**

  → NDJSON stream — the agent's raw tool results ride the wire to the UI
    (truncated at 4KB via `trunc()` in
    `app/api/agent/route.ts:98-102`). If the MCP server returns a customer's
    email in an event property, it lands on-screen. Acceptable for the
    portfolio use case; would need scrubbing for real customer data.
  → Demo snapshot capture — `lib/state/demo-*.json`, committed to the repo.
    Real captures against the Bloomreach alpha workspace should be reviewed
    before commit; the current committed snapshot uses the "wobbly-ukulele"
    demo project.
  → Error responses — `route.ts:174-179, 316-321` return the real error
    message to the caller after redaction. Redaction covers OAuth secrets;
    it does NOT scrub customer data that might appear in a tool-result error
    envelope. Realistic gap.

**Response-verbosity red flag.** Errors return `e.message` directly. On the
bright side, `formatError()` walks `err.cause` (`transport.ts:82-97`) so
stacks are complete in logs; the wire message is just the top-level `.message`,
not the full chain. Cause chain stays server-side.

## 6. dependencies-and-supply-chain

`package.json` audit:

  → Locked with `package-lock.json`. Present at repo root.
  → Runtime deps (5): `@anthropic-ai/sdk ^0.99`, `@aptkit/core` (published
    as `@rlynjb/aptkit-core@^0.3.0`, your own package),
    `@modelcontextprotocol/sdk ^1.29`, `lucide-react ^1.17`, `next 16.2.6`,
    `react/react-dom 19.2.4`. Tight surface.
  → Dev deps: Tailwind v4, Vitest 4, ESLint 9, TypeScript 5. Standard.
  → No `postinstall` scripts in `package.json`.
  → Bloomreach MCP SDK is the largest transitive surface; the SDK is the
    trusted party at boundary 3.

Red flag NOT firing: no known-vuln alerts because no scan is committed. Not a
gap for the current shape (5 deps), but a `npm audit --production` at CI
would earn its place before customer data lands anywhere.

## 7. llm-and-agent-security

This is where the sharpest findings live.

**Finding 7.1 — per-agent tool scope regressed in the AptKit migration.**
The legacy classes (`monitoring-legacy.ts`, `diagnostic-legacy.ts`,
`recommendation-legacy.ts`, `query-legacy.ts`) each call
`filterToolSchemas(this.allTools, monitoringTools)` (etc.) so the model only
sees its allowed subset. The AptKit-based live classes
(`monitoring.ts:86`, `diagnostic.ts:56`, `recommendation.ts:40`,
`query.ts:27`) hand `allTools` to `BloomingToolRegistryAdapter` unfiltered —
`aptkit-adapters.ts:130-136` exposes `this.allTools.map(...)` with no
whitelist. The whitelists in `lib/mcp/tools.ts` are effectively dead code for
the live path.

  → What this defends when it's on: prompt-injection or model-drift attempts
    to reach for a tool the current agent shouldn't (e.g. recommendation
    calling `list_customer_events`, or monitoring calling `list_scenarios`).
    The whitelist collapses the attack surface per-agent.
  → What breaks it being off: monitoring can now propose recommendations,
    diagnostic can list catalog items. No cost gate has landed either
    (BudgetTracker exists in `lib/agents/budget.ts` but is optional at
    construction; nothing forces it on).
  → Fix: pass `filterToolSchemas(allTools, <agentName>Tools)` (or a
    registry-side allowlist) into each agent's constructor and hand THAT to
    `BloomingToolRegistryAdapter`. Keep the whitelists in `lib/mcp/tools.ts`;
    delete the legacy classes or promote them.

**Finding 7.2 — model output as trusted code, gated.** `parseAgentJson` +
`isAnomalyArray` / `isDiagnosis` / `isRecommendationArray`
(`lib/mcp/validate.ts:3-57`) sit at the model-output → app-state seam. Every
agent's output flows through them before it becomes an `Anomaly` / `Diagnosis`
/ `Recommendation` and reaches the UI. Deep walk:
`05-model-output-validation.md`.

  → The `severity`, `bloomreachFeature`, `confidence` enum checks are hard
    gates — an out-of-range value from the model gets rejected at parse time.
  → Fields the model might fabricate (like `evidence[].result`) aren't
    schema-validated deeply — the UI just renders them. Acceptable: they're
    displayed, not executed.

**Finding 7.3 — free-form `?q=` param → coordinator agent.** The QueryAgent
takes untrusted user text and runs it through Claude with the union of every
tool. Prompt-injection concern:

  → An attacker who controls the `?q=` param (e.g. via a malicious link
    someone clicks while logged in) can steer the agent toward any tool in
    `queryTools`. Combined with 7.1, this means every MCP tool.
  → Intent classifier (`intent.ts`) narrows the response format, not the tool
    scope.
  → Mitigation: budget ceiling. `BudgetTracker` (`lib/agents/budget.ts`) is
    the cost-abuse defense against runaway loops; passed through
    `AnthropicModelProviderAdapter` at `aptkit-adapters.ts:60-66`. But it's
    optional (`private readonly budget?: BudgetTracker`); the live agent
    constructors don't wire one in. So the defense exists in code, not on
    the live path.

**Finding 7.4 — visitor-chosen MCP URL as a trust boundary.** The MCP server
is the source of tool-call *responses* — data that flows back into the model
context. A malicious MCP server can prompt-inject the agent by returning
tool results shaped like instructions. The UI warns the user. Deep walk:
`03-user-chosen-mcp-url-boundary.md`.

## 8. security-red-flags-audit — the capstone checklist

One line per red flag. `fires` / `doesn't` / `n/a` · location · severity ·
one-line fix.

```
  ✓ = fires     · = doesn't      n/a = not exercised

  fires  input treated as trusted because it's "from our own frontend"
         severity: MEDIUM · sink: model prompt only, not sql/shell
         location: app/api/agent/route.ts:36-46 (?insight= JSON blob)
         fix: tighten the type guard; treat JSON.parse output as fully hostile

  fires  an agent whose tool set exceeds its task
         severity: HIGH · this is finding 7.1
         location: lib/agents/{monitoring,diagnostic,recommendation,query}.ts
         fix: reinstate filterToolSchemas at BloomingToolRegistryAdapter
              construction; the whitelists in lib/mcp/tools.ts are ready

  fires  model output flowing into a sink without a gate
         severity: LOW · gated at the app-state boundary
         location: lib/mcp/validate.ts:3-57 (parseAgentJson + type guards)
         fix: none — this fires as "well-defended," not "missing"

  ·      secret in source · secret in client bundle · secret in logs
         all three don't fire — redactSecrets + gitignore + env-only reads

  fires  no CSP / Content-Security-Policy header
         severity: LOW-MEDIUM · defense-in-depth
         location: next.config.ts (missing)
         fix: add headers() with default-src 'self'; anthropic.com + MCP host
              in connect-src

  ·      no lockfile
         doesn't fire — package-lock.json present

  ·      known CVEs unpatched
         not exercised — no npm audit committed at CI, honest gap

  ·      SQLi / command inj / path traversal / SSRF / XSS
         all n/a — no sql, no shell, no user-controlled fs paths, no
         server-rendered html; SSRF is worth a look because Session D adds
         a user-controlled URL (03-user-chosen-mcp-url-boundary.md)
         — the server DOES fetch the URL; the fix is a scheme/host allowlist

  fires  bearer token in localStorage
         severity: MEDIUM · user-warned in the UI
         location: components/settings/McpConfigModal.tsx:192-203
         fix: none for portfolio use; a real deploy would move bearer into a
              short-lived encrypted server cookie

  ·      endpoint checks logged-in but not allowed
         n/a — single-user-per-cookie, no per-resource authz to check

  fires  cost-abuse defense present but not wired on the live path
         severity: MEDIUM · finding 7.3 tail
         location: lib/agents/budget.ts + aptkit-adapters.ts:60-66
         fix: construct a BudgetTracker per investigation in the route
              handler and thread it through the agent factories
```

## Where to go next

Follow the pattern files for the controls that earned a deep walk:

- `01-encrypted-auth-cookie.md` — why the AES-256-GCM + ALS design works
- `02-oauth-pkce-dcr-boundary.md` — the OAuth 2.1 identity hop
- `03-user-chosen-mcp-url-boundary.md` — the new trust boundary Session D adds
- `04-server-side-config-validation.md` — the header decode + type guard
- `05-model-output-validation.md` — the model→state gate
- `06-secret-redaction-in-errors.md` — how tokens stay out of Vercel logs
