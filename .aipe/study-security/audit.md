# Security — audit

> **Verdict-first.** blooming insights has three real trust boundaries (browser → route, route → Bloomreach, model output → typed value) and a single high-severity gap: `POST /api/mcp/call` accepts any tool name with no allowlist, gated only by session auth (`app/api/mcp/call/route.ts` L7–L13). The strongest pattern in the codebase is the **encrypted `bi_auth` cookie** — AES-256-GCM under `AUTH_SECRET` is the only durable production state, and the `withAuthCookies` ALS-scoped store is what makes Next's request/response cookie split survivable. The load-bearing structural defense against prompt injection is **not input validation** — it's the per-agent read-only tool whitelists in `lib/mcp/tools.ts` plus the `parseAgentJson` + type-guard + `FALLBACK` discipline in `lib/mcp/validate.ts`. No critical findings; ten medium-severity ones that compound under deployment-shape changes (multi-tenant, write tools, accounts).

## Trust boundaries and attack surface

Five untrusted-input surfaces enter this codebase. Three are classic web (`?q=` / `?insight=` / `?insightId=` query params, three POST bodies, `bi_session` + `bi_auth` cookies). Two are AI-era (MCP tool results from Bloomreach, Anthropic model output). One is dev-only filesystem (`.auth-cache.json`, `.investigation-cache.json`, committed `lib/state/demo-*.json`).

Cookies are crypto-validated (`bi_auth` AES-256-GCM) or random and httpOnly (`bi_session`). Query params have hand-rolled shape checks — `resolveAnomaly` (`app/api/agent/route.ts` L37–L46) does a 4-field check on `?insight=` JSON, falls through to in-memory lookup on failure. POST bodies vary: `/api/mcp/capture-demo` checks `Array.isArray(insights)`, `/api/mcp/reset` needs no body, **`/api/mcp/call` validates nothing** and forwards `{name, args}` straight to `conn.mcp.callTool` with `skipCache: true`. Model output has the strongest enforcement: `parseAgentJson` + per-shape type guards + `FALLBACK` constants.

The single load-bearing red flag is the `POST /api/mcp/call` surface. Indirect prompt injection via MCP tool results (Bloomreach data flowing into the model context as `tool_result` content, `lib/agents/base.ts` L144–L156) is bounded only by the read-only tool whitelist and the output gate — not by any input filter.

→ see `05-open-tool-surface-gap.md` for the deep walk on the unvalidated `POST /api/mcp/call` body and tool-name surface
→ see `01-encrypted-cookie-oauth-state.md` for the cookie crypto deep walk

## Authentication and authorization

Authentication is solid; app-layer authorization is **just "do you have a session."** OAuth 2.0 + PKCE + DCR against Bloomreach is wired correctly via `BloomreachAuthProvider` (`lib/mcp/auth.ts` L160–L218) — that mechanics deep walk lives in `.aipe/study-system-design/02-oauth-boundary.md`, not duplicated here. `bi_session` (`lib/mcp/session.ts` L16–L24) is a random UUID, httpOnly, `SameSite=None; Secure` in prod / `Lax` in dev. `bi_auth` (`lib/mcp/auth.ts` L86–L104) is AES-256-GCM-encrypted OAuth state, 10-day maxAge.

What's missing: no CSRF token on any POST route, no origin check on GET-with-side-effects routes (`/api/briefing` and `/api/agent` both spend Anthropic tokens). `POST /api/mcp/reset` is trivially CSRF-able — an attacker page with `<form action=… method=POST>` and the user's `bi_session` cookie (sent because `SameSite=None`) logs the user out. Severity: low (logout is recoverable). `GET /api/agent?insightId=…` is the worse case: cross-origin `<script src>` or hidden iframe triggers it, the route spends Anthropic tokens. The browser can't read the streaming response (CORS) but the cost was already incurred.

The OAuth callback at `app/api/mcp/callback/route.ts` L22–L26 deliberately skips a `state` re-check because the SDK calls `state()` multiple times per flow — naive store-last-compare-once rejects legitimate callbacks. `consumeState` in `lib/mcp/auth.ts` L230–L235 is implemented and tested but not wired. Accepted risk on the assumption the SDK handles it internally.

No second factor on the 10-day session. Cookie theft = full impersonation for the cookie's lifetime. Appropriate for a single-user demo; would block a B2B SaaS ship.

→ see `01-encrypted-cookie-oauth-state.md` for the bi_auth crypto deep walk
→ see `02-als-scoped-request-store.md` for the AsyncLocalStorage-scoped store that holds per-request auth state

## Input validation and injection

No SQL (no database), no shell (no `child_process`), no path joins from user input (dev-only `capture` route writes to hardcoded `test/fixtures/` paths), no SSRF (MCP URL from `process.env.BLOOMREACH_MCP_URL` only), no XSS via DOM (React auto-escapes; no `dangerouslySetInnerHTML` in the answer path; no markdown renderer). **The classical injection surfaces don't apply.**

The two LLM-era sinks do apply. **Prompt injection** via `?q=` (`lib/agents/query.ts` L35 — `userPrompt: query` is the only raw user-controlled string in any prompt) is bounded structurally, not by input filtering: the per-agent tool whitelist is read-only by construction, every structured output passes through a type guard, and React renders the natural-language answer as plain text. Indirect injection via `tool_result` content has the same bound. **MCP tool sink** at `POST /api/mcp/call` is the load-bearing weak spot — no body schema, no tool-name allowlist.

Prompt templates use `.replace('{schema}', schemaSummary(...))` etc. (`lib/agents/diagnostic.ts` L46–L49). The `{anomaly}` / `{diagnosis}` values are `JSON.stringify`'d so quotes and newlines escape. The `{schema}` value is upstream-trusted Bloomreach event names — safe today, would break if Bloomreach allowed adversarial event names with embedded newlines. Defensive `schemaSummary` newline-stripping is the future-state move; not present.

→ see `04-read-only-tool-whitelist.md` for the capability-minimization pattern
→ see `03-type-guard-trust-boundary.md` for the output validation pattern
→ see `05-open-tool-surface-gap.md` for the `POST /api/mcp/call` finding

## Secrets and configuration

Two real secrets: `ANTHROPIC_API_KEY` (inference cost firewall) and `AUTH_SECRET` (AES-256-GCM key for `bi_auth`). Both are env-only, both documented in `.env.example`, neither leaks to the client (no `NEXT_PUBLIC_*` prefix on either). Only `NEXT_PUBLIC_APP_NAME` and `NEXT_PUBLIC_DEMO_ONLY` are exposed — page title and a feature flag, neither sensitive.

Real weaknesses: (1) dev-only `.auth-cache.json` holds OAuth tokens **plaintext on disk** — gitignored with an explicit comment block at `lib/mcp/auth.ts` L21–L33, but recoverable from a stolen laptop; (2) `AUTH_SECRET` has no graceful rotation — rotating invalidates every live `bi_auth` cookie (`decryptStore` returns `{}` on tag mismatch, L76); (3) `aesKey` accepts any non-empty string and SHA-256s it (L51–L60) — `AUTH_SECRET=password` produces a deterministic 32-byte AES key with ~10 bits of underlying entropy; no length check; (4) four routes leak `e.stack` in error responses — `/api/mcp/call` L17–L20, `/api/mcp/tools` L18–L22, `/api/mcp/tools/check` L21–L25, dev-only `/api/mcp/capture` L54–L57. The streaming routes already use the safe `e.message`-only pattern; the inconsistency is the finding.

`console.error('[agent] error:', e)` logs the full error object including the `cause` chain. `lib/mcp/transport.ts` captures up to 2000 chars of non-OK HTTP response bodies into thrown errors. If Bloomreach's 401 body echoes a token snippet (unverified — would need a live failing call), that token lands in Vercel logs. No token-redaction filter in the log layer.

## Data exposure and privacy

The strongest privacy property in the codebase: **no database, no per-user data store, no PII at rest.** Every briefing is a fresh fetch from Bloomreach; every investigation is held in memory per session.

Where data leaves: (1) the NDJSON trace surface — `tool_call_end.result` ships the full Bloomreach tool result truncated to 4KB (`app/api/briefing/route.ts` L70–L73, L228–L236; `app/api/agent/route.ts` L100–L103). This is intentional — it powers the "how it was gathered" UI panel — but it means business data sits in the browser response body, visible to DevTools, network extensions, MITM proxies, and any screenshot. No per-tool field redaction. (2) the four stack-trace routes named above (info disclosure — leaks file paths, library entry points, function names). (3) the `?insight=` URL parameter serializes the full insight JSON into the address bar → browser history + Vercel access logs + HTTP referrer on external link clicks. The comment at `/api/agent` calls this out as a deliberate choice (serverless memory wipe forced the URL handoff). `Referrer-Policy: no-referrer` on `/investigate` would close the cross-origin referrer leak. (4) `console.error` may echo Bloomreach 401 bodies into Vercel logs as noted above.

The `diagnosticTools` whitelist includes `list_customers` and `list_customer_events` — PII-bearing tools. The prompt actively steers toward aggregate `execute_analytics_eql` instead, but the *capability* is there. A focused review would either drop `list_customers` from the whitelist or add per-tool result-shaping middleware that strips PII fields before the model or the trace ever see them.

## Dependencies and supply chain

Small and modern. 6 runtime + 8 dev = 14 direct deps. Current majors on everything (Next 16.2.6, React 19.2.4, MCP SDK 1.29.0, Anthropic SDK 0.99.0). `package-lock.json` is committed (8415 lines) — that's the load-bearing supply-chain defense. `npm ci` verifies integrity hashes per tarball; a registry compromise that swaps a tarball fails the hash check and aborts install. None of the direct deps declare a `postinstall` script.

`next`, `react`, `react-dom`, `eslint-config-next` are pinned exact; the other 10 deps float on `^` ranges. `lucide-react` appears in `dependencies` but the audit didn't find imports — `npx depcheck` would confirm; remove if unused.

Missing: no Dependabot/Renovate config, no `npm audit` gate in CI, no SBOM. For a single-developer demo, manual cadence is acceptable; the first add for production maturity would be a GH Actions step running `npm audit --audit-level=high` on every PR.

The residual risk every JS app shares: any of ~400 transitive packages can read `process.env.ANTHROPIC_API_KEY` and `process.env.AUTH_SECRET` because Node modules run in one V8 isolate with no per-module sandboxing. The defense is dep-count discipline (small list = small surface) plus the lockfile.

## LLM and agent security

Two structural decisions hold the agent layer's security: **read-only tool whitelists by name pattern** (`lib/mcp/tools.ts` L5–L40 — all `list_*` / `get_*` / `execute_analytics*`, no `create_*`/`update_*`/`delete_*`) and **type-guarded structured outputs with `FALLBACK` constants** (`lib/mcp/validate.ts` L3–L57 + per-agent fallbacks like `lib/agents/diagnostic.ts` L16–L20). Together they convert the prompt-injection blast radius from "agent writes to your CRM" into "agent emits a recommendation the user reads but doesn't auto-execute."

Four agents. `MonitoringAgent` — 13 read tools, output `Anomaly[]`, validator `isAnomalyArray`, fallback `[]`. `DiagnosticAgent` — 18 read tools (includes `list_customers`), output `Diagnosis`, validator `isDiagnosis`, fallback `FALLBACK` constant plus a tool-less `synthesize` second-chance call. `RecommendationAgent` — 10 read tools, output `Recommendation[]`, validator `isRecommendationArray`, same belt-and-suspenders synthesis. `QueryAgent` — `queryTools` is the **full union** of the other three, ~30 tools, output is natural-language text returned via `finalText.trim()` (`lib/agents/query.ts` L46) with **no output gate**.

Honest gaps: (a) the `QueryAgent.answer` natural-language path is the only model output that doesn't pass through a validator; (b) `queryTools` being the full union pairs the widest capability with the weakest output gate on the same agent — the most-injection-exposed surface; (c) tool results stream back to the model verbatim (truncated to 16KB at `lib/agents/base.ts` L29–L34, not field-shaped) — indirect prompt injection lives here; (d) `RecommendationAgent`'s output includes a `bloomreachFeature` string (`scenario | segment | campaign | voucher | experiment`) that is rendered as a card today, but if a future "click to create" feature lands, the entire output surface becomes a write path — the read-only-tools posture wouldn't matter because the UI would be the deputy.

The synthesis fallback's important security property: it runs `anthropic.messages.create` with no `tools` field, so even if the main loop was steered into an exploration spiral by an injection, the synthesis pass has no capability to call anything new. Capability degradation on the fallback path.

→ see `04-read-only-tool-whitelist.md` for the per-agent whitelist deep walk
→ see `03-type-guard-trust-boundary.md` for the output validation deep walk

## Security red flags audit

The consolidated triage, by severity and section. Each row was named with file:line in the lens above; this is the index.

**High (1):**
- A7 / B6 — `POST /api/mcp/call` accepts any tool name; no allowlist, no body schema, gated only by session auth. `app/api/mcp/call/route.ts` L7–L13. One-line fix: `if (!ALL_KNOWN.has(name)) return 403`. → see `05-open-tool-surface-gap.md`

**Medium (10):**
- B4 — CSRF on `POST /api/mcp/reset` (no token, `SameSite=None`). Fix: Origin allowlist.
- B5 — GETs with side effects on `/api/briefing`, `/api/agent` (spend Anthropic tokens). Fix: Origin check or convert to POST + CSRF nonce.
- C3 — `AUTH_SECRET` strength not enforced; any non-empty string accepted. `lib/mcp/auth.ts` L51–L60. Fix: `if (secret.length < 32) throw …`.
- C4 — `AUTH_SECRET` rotation invalidates all sessions. Fix: key-version byte prefix + `AUTH_SECRET_OLD` env var.
- C6 — Stack traces in 4 error responses. Fix: remove `'\n' + (e.stack ?? '')` per route.
- C7 — Possible token echo in Vercel logs via captured Bloomreach error bodies. Fix: token-redaction regex in error path.
- D6 — `list_customers` latent in `diagnosticTools` whitelist (PII tool present, not actively used). Fix: remove or add per-tool result-shaping middleware.
- E4 — No CI audit gate. Fix: GH Actions step `npm audit --audit-level=high`.
- F5 — `QueryAgent.answer` text not validated. `lib/agents/query.ts` L46. Fix: length cap + sanity guard.
- F6 / F7 / F8 — `queryTools = union`, `diagnosticTools` includes PII tool, no per-tool result shaping. Cluster fix: per-tool sanitizer middleware in `McpClient.callTool` + dispatch to specific agent via `classifyIntent` instead of using union.

**Low (5):**
- A8 / A9 — no length cap on `?q=` / `?insight=`.
- C8 — no startup env-var validation.
- D3 — `?insight=` in browser history + Referrer.
- D5 — full error logged with cause chain (medium when paired with C7).
- E5 / E6 / E7 — no Dependabot, no SBOM, possibly-unused `lucide-react`.

**Accepted (7):**
- C5 — dev `.auth-cache.json` plaintext (gitignored, commented).
- B7 — no MFA on 10-day cookie (demo shape).
- B8 — OAuth state CSRF re-check disabled in callback (SDK handles).
- B9 — no per-route role gates (single-tenant).
- D2 — NDJSON trace by design.
- F9 — recommendation latent write surface (no auto-execute today).
- E8 — `^` ranges on most deps (`npm ci` prevents drift).

**N/A (4):**
- SQL injection (no database), shell injection (no `child_process`), path traversal from user input (paths hardcoded), SSRF (no user-provided URL fetched).

## Top 3 ranked findings

1. **`POST /api/mcp/call` accepts any tool name with no allowlist** — `app/api/mcp/call/route.ts` L7–L13 — one-line fix: build `ALL_KNOWN = new Set([...monitoringTools, ...diagnosticTools, ...recommendationTools, ...bootstrapTools])` and reject names not in the set with 403. Today bounded by Bloomreach having no dangerous tools and by per-user authz; would become critical the moment Bloomreach adds a write tool, since the route has no `is in production` gate. See `05-open-tool-surface-gap.md`.

2. **Four routes leak `e.stack` in error responses** — `app/api/mcp/call/route.ts` L17–L20, `app/api/mcp/tools/route.ts` L18–L22, `app/api/mcp/tools/check/route.ts` L21–L25, `app/api/mcp/capture/route.ts` L54–L57 — fix: remove `'\n' + (e.stack ?? '')` from the JSON response, keep the full error in `console.error` for the operator. The streaming routes already use this safer pattern. The inconsistency is the finding; the fix is one line per route.

3. **`AUTH_SECRET` has no strength enforcement** — `lib/mcp/auth.ts` `aesKey` L51–L60 — fix: `if (secret.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters')`. Today `AUTH_SECRET=password` is silently SHA-256'd to a 32-byte AES key with ~10 bits of underlying entropy; an attacker who steals a `bi_auth` cookie plus guesses or knows the secret can decrypt OAuth tokens offline. The `.env.example` documents the `openssl rand -base64 32` requirement; the code doesn't enforce it.
