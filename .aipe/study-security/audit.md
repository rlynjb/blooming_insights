# Security audit — the 8 lenses walked

Eight lenses over blooming insights. Each names what the codebase actually does with `file:line` grounding, or emits `not yet exercised` honestly. When a finding earns a deep walk, the lens cross-links to a numbered pattern file rather than restating.

Everything below is defensive: name the weakness, name the fix, no attack recipes.

---

## 1. Trust boundaries and attack surface

The zoom-out. Three hops cross a boundary; every request into the trusted core enters through one of four channels.

```
  Boundaries + channels that carry untrusted input

  Browser ──HTTP──► Next.js server ──HTTP──► Bloomreach MCP
                        │
                        └──HTTPS──► Anthropic API
                             │        (response ⇐ untrusted)
                             ▼
                        model output back into the server
```

**Input channels the trusted core has to defend:**

- `app/api/agent/route.ts:109-115` — query params `insightId`, `insight` (JSON), `q`, `live`, `step`, `diagnosis` (JSON). The two JSON params are parsed with a shape check (`route.ts:32-43` for `insight`, `82-92` for `diagnosis`) and drop malformed input silently — good.
- `app/api/briefing/route.ts:77-98` — one param, `demo=cached`. Parsed as a boolean; the demo file is server-owned. Low surface.
- `app/api/mcp/call/route.ts:22-30` — POST body `{ name, args }` where `name` is checked against `ALL_KNOWN` (the union of every constant in `lib/mcp/tools.ts`) before dispatch. This is the strongest gate in the repo → see `03-read-only-tool-allowlist.md`.
- `app/api/mcp/callback/route.ts:15` — the OAuth `?code` return from Bloomreach. `state` is deliberately not re-validated at this layer (`callback/route.ts:22-27`); comment cites the SDK's own multi-call state handling.

**Model output as an input channel.** This is the load-bearing bit for an LLM app. The three agent outputs — anomalies, diagnosis, recommendations — are parsed via `parseAgentJson` (`lib/mcp/validate.ts:3`) and shape-checked before crossing back into the trusted state store or the UI. See `04-model-output-type-guards.md`.

**Red flag: an input treated as trusted because it "comes from our own frontend."** Doesn't fire. The `?insight=` JSON param is parsed defensively (`route.ts:32-43`) and only extracts the five fields `insightToAnomaly` needs (`lib/state/insights.ts:53-55`) — extra fields are dropped. The client-side sessionStorage handoff to `?insight=` in the investigate flow does not grant trust; every field is re-validated server-side.

---

## 2. Authentication and authorization

**Who-are-you** — encrypted-cookie session + Bloomreach OAuth. Two cookies, one purpose each:

- `bi_session` (`lib/mcp/session.ts:3`) — a UUID keying the app's session identity. `httpOnly`, `SameSite=None + Secure` in prod (`session.ts:11-12`) so it survives the cross-site OAuth return; `SameSite=Lax` in local dev where `Secure` would drop the cookie over http.
- `bi_auth` (`lib/mcp/auth.ts:48`) — AES-256-GCM ciphertext of the whole `Store` (client info + tokens + PKCE verifier), keyed off `AUTH_SECRET` via `createHash('sha256').update(secret).digest()` (`auth.ts:51-60`). GCM auth tag is stored inline. → deep walk: `01-encrypted-cookie-auth-store.md`.

The Bloomreach handshake is OAuth 2.1 + PKCE + Dynamic Client Registration (`clientMetadata` in `auth.ts:172-181` declares public client, `token_endpoint_auth_method: 'none'`). → deep walk: `02-oauth-pkce-with-dcr.md`.

**What-can-you-do** — one level of authorization: has-tokens. `hasTokens(sessionId)` at `auth.ts:220-222` gates whether the MCP transport is usable. There's no per-tenant or per-workspace scope beyond that; a session that has authenticated once can call any Bloomreach tool the app whitelist permits (`03-read-only-tool-allowlist.md`).

**Red flag: an endpoint that checks logged-in but not allowed.** Partial fire — the endpoints do gate on session + auth, but the *investigation replay cache* in `lib/state/investigations.ts:22-28` skips both checks. See `00-overview.md` finding 2. The insights cache does not have this problem (`lib/state/insights.ts:73-79` is session-scoped).

---

## 3. Input validation and injection

**No SQL.** No relational database exists in the request path. State lives in in-memory Maps and gitignored JSON caches (`lib/state/*.ts`, `.auth-cache.json`, `.investigation-cache.json`). No string-built query anywhere in `lib/` or `app/`.

**No shell.** No `child_process`, no `exec`, no `spawn`. No filesystem writes that take user-controlled paths (the dev-only capture route in `app/api/mcp/capture/route.ts:42` uses a fixed `test/fixtures/` prefix; the tool name is loop-bounded by the `BOOTSTRAP_TOOLS` constant).

**EQL as a sink.** `execute_analytics_eql` is a whitelisted tool the model calls. The EQL string itself is emitted *by the model*, not the user — the input path is:

```
  user question (q) → intent classifier → QueryAgent → model → EQL → MCP
                                                          ▲
                                                          │
                                                       untrusted
```

The mitigation is that the MCP server is read-only (all whitelisted tools are `list_*`, `get_*`, `execute_analytics_eql` reads — no writes or destructive ops in `lib/mcp/tools.ts:6-35`). A prompt-injected hostile EQL string can only exfiltrate data the authenticated session already has access to, not mutate it.

**Prompt injection via retrieved content.** The model receives:
- workspace schema (`lib/mcp/schema.ts` — server-side derived from bootstrap MCP calls)
- tool results (Bloomreach responses)
- the user's free-form question in the query flow

None of these are hard-partitioned from the system prompt. The system prompt lives in `lib/agents/prompts/*.md` (server-owned). Tool results from Bloomreach are semi-trusted — a workspace admin could theoretically inject prompt fragments into event names or customer property strings. The blast radius stays bounded by (a) the read-only tool set and (b) the type-guard at model output (`04-model-output-type-guards.md`).

**Red flag: string-built query or prompt with user input in it.** Half-fires. The system prompts are static files. But the free-form `q` in `app/api/agent/route.ts:112` flows into `classifyIntent` (`lib/agents/intent.ts:21-38`) and `QueryAgent.answer` (`lib/agents/query.ts:24-33`) as the user message — the model sees it verbatim. The intent classifier's job is precisely to route intent; the risk isn't the string reaching the model but the model treating a prompt-injection payload as a directive. See lens 7.

**No XSS surface reached.** No `dangerouslySetInnerHTML` in `components/` or `app/`. No `innerHTML`. No `document.write`. All model output that reaches the UI passes through React's default text-escaping.

---

## 4. Secrets and configuration

Two secrets exist:

- `ANTHROPIC_API_KEY` — server-only. Referenced at `app/api/agent/route.ts:154`, `app/api/briefing/route.ts:156`, and passed to `new Anthropic({ apiKey: ... })` in the same route files. Never crosses to a `NEXT_PUBLIC_*` var; never in a client bundle.
- `AUTH_SECRET` — server-only. Referenced only in `lib/mcp/auth.ts:52-58`. `aesKey()` throws if unset in production, which surfaces as a real 500 message via the route's setup catch (`route.ts:163-171`) rather than a silent crypto fail.

`BLOOMREACH_MCP_URL` (`lib/mcp/connect.ts:31`) and `APP_ORIGIN` (`connect.ts:56`) are config, not secrets.

**Env hygiene.** `.gitignore` covers `.env*` with a `!.env.example` exception (`.gitignore` head). `.env.example`, `.env.local`, `.env.prod` and the two cache files live locally only. Grep for `sk-`, `key`, `secret` across the codebase turns up only variable *references* (`process.env.X`), not literals.

**CI.** `.github/workflows/ci.yml:42-54` passes fake secrets at build time — `sk-fake-key-for-ci`, `ci-fake-auth-secret-32-chars-minimum-length`. Real secrets are Vercel deploy env, not CI. Correct posture.

**Red flag: a secret in source, in a client bundle, or in logs.** None fire. The log-side is defended by `redactSecrets` (`lib/mcp/transport.ts:66-76`) which strips Bearer, `access_token`, `refresh_token`, `id_token`, `code_verifier` before the surfaced error text hits `console.error`. → deep walk: `06-log-secret-redaction.md`.

---

## 5. Data exposure and privacy

**Session-scoped state — mostly.** `lib/state/insights.ts:14-23` keys everything by `sessionId`; `getInsight`, `getAnomaly`, `listInsights` all narrow to `state.get(sessionId)`. A briefing run's `putInsights` (`insights.ts:57-71`) only clears the caller's sub-map, never another session's.

**Investigation cache is NOT session-scoped.** `lib/state/investigations.ts:22-28`. See `00-overview.md` finding 2. This is the one leaky surface.

**Verbose errors.** The `.catch` blocks in the routes surface `e.message` to the client (`app/api/agent/route.ts:314-315`, `app/api/briefing/route.ts`). Message content flows through `redactSecrets` before it hits `console.error`, but the response-body variant does NOT get redacted:

- `app/api/agent/route.ts:313-316` — `send({ type: 'error', message: '/api/agent · ' + e.message })` — no redaction on the wire.
- `app/api/mcp/call/route.ts:37-40` — same pattern for the 500 JSON.

A rate-limit or 401 error from Bloomreach that carries a bearer echoback in the body would land in the client-visible error. The `SdkTransport.callTool` path already redacts the captured body (`transport.ts:107-118`) before storing it in the holder, so the specific "server bounced our bearer back" case *is* covered — but the `redactSecrets` call chain is not applied uniformly on the error-response side. Move the redaction into `formatError`'s output before it's substituted into the response body, and both paths are covered.

**PII in logs.** The per-turn usage log (`aptkit-adapters.ts:97-102`) emits `sessionId` — a synthetic UUID, not PII — and `response.usage` (token counts). The briefing route's log payload (`briefing/route.ts:200+`) matches. No email, no user ids, no customer data.

**Red flag: an error or API response that returns more than the caller is entitled to.** Fires for the investigation cache (finding 2). Doesn't fire for the insight endpoints.

---

## 6. Dependencies and supply chain

**Lockfile present.** `package-lock.json` in the repo (implied by `package.json` and `npm ci` in `ci.yml:29`).

**Direct dependencies from `package.json`:**

```
  @anthropic-ai/sdk         ^0.99.0
  @aptkit/core              npm:@rlynjb/aptkit-core@^0.3.0
  @modelcontextprotocol/sdk ^1.29.0
  lucide-react              ^1.17.0
  next                      16.2.6
  react                     19.2.4
  react-dom                 19.2.4
```

**Notable:** `@aptkit/core` aliases to `@rlynjb/aptkit-core`, a namespaced package the repo owner publishes. The trust boundary is real — the agent loops and tool registry contract come from that package — but the ownership is internal. Manage it as a separate publish; a compromised aptkit publish is a compromised blooming_insights.

**Next 16 + React 19.** Bleeding-edge versions. Not a security finding on its own, but a note the reviewer sees: security advisories for these are the recent kind you have to watch. `AGENTS.md` at repo root explicitly warns that Next 16 has breaking changes and points at `node_modules/next/dist/docs/` — the pattern is to read the shipped docs before writing route code.

**Postinstall / scripts.** None in `package.json`. Nothing runs on `npm ci` beyond the standard install.

**Red flag: no lockfile, or known CVEs unpatched.** Doesn't fire on lockfile. CVE posture requires an `npm audit` run outside this audit's scope — recommendation is to add `npm audit --production --audit-level=high` to CI's job (currently only `typecheck + test + build` per `ci.yml:31-48`).

---

## 7. LLM and agent security

**Model output is untrusted input.** The top-of-mind defense. → deep walk: `04-model-output-type-guards.md`.

`parseAgentJson` (`lib/mcp/validate.ts:3-13`) extracts JSON from a fenced code block OR the first `[`/`{` in the text, and `JSON.parse` will throw on bad shapes. Three type guards (`isAnomalyArray:17`, `isDiagnosis:29`, `isRecommendationArray:42`) narrow the parsed value before the caller trusts it. What breaks if a guard is missing: an agent returning a plausibly-shaped-but-wrong payload flows into `putInsights` and populates the feed with model-generated garbage. What each guard specifically stops: `isAnomalyArray` requires `severity ∈ SEVERITIES`, `change.direction ∈ up|down`, `metric: string`. A payload with `severity: "urgent"` fails the guard and the anomaly is dropped.

**Tool scope: per-agent gate regressed.** Live agents (`lib/agents/diagnostic.ts:56`, `monitoring.ts:83`, `recommendation.ts:40`, `query.ts:27`) hand `this.allTools` — the full catalog — to `BloomingToolRegistryAdapter`. The per-agent subsets in `lib/mcp/tools.ts` (`monitoringTools`, `diagnosticTools`, `recommendationTools`) exist but are only consumed by the four `*-legacy.ts` classes via `filterToolSchemas` (`tool-schemas.ts:9`). See `03-read-only-tool-allowlist.md` for the client-side gate and `00-overview.md` finding 1 for the fix.

**Tool set is read-only.** Even without per-agent scoping, none of the whitelisted tools mutate Bloomreach state — every entry in `monitoringToolsBloomreach`, `diagnosticToolsBloomreach`, `recommendationToolsBloomreach` (`lib/mcp/tools.ts:6-35`) is a `list_*` / `get_*` / `execute_analytics*` reader. The recommendation agent *proposes* actions (segment / campaign / voucher / experiment) but does not create them.

**Prompt injection via tool responses.** Bloomreach returns event names, customer property names, and analytics data — a workspace admin could theoretically inject instructions into a display name. The blast radius: (a) read-only tools cap what a hijacked model can do; (b) the type-guard at output cuts off structured injection; (c) unstructured "call this tool with these args" injection still costs a tool call before the model realizes it. This is where the budget ceiling matters most.

**Cost-abuse defense.** `BudgetTracker` + `BudgetExceededError` (`lib/agents/budget.ts`) → deep walk: `05-budget-ceiling-defense.md`. Built + tested; NOT wired into the routes yet. In eval (`eval/run.eval.ts:194-195`) the ceiling is enforced; in production a runaway loop burns whatever the 300s Vercel budget affords.

**Data exfil through tool calls.** The tool set is scoped to the authenticated session's Bloomreach data. Exfil would mean: a compromised model exfils *the current user's own data* to itself, then encodes it into a response the UI displays. The type guards limit what the UI accepts. What they don't do: prevent the model from packing exfil data into a valid-shaped `hypothesis.reasoning` string. If your threat model includes "attacker with prompt-inject access reads your Bloomreach data via the model's response," the current defense is: the attacker already has session auth, so they can already read that data directly.

**Red flag: an agent whose tool set exceeds its task.** Fires. See finding 1 in `00-overview.md`.

**Red flag: model output flowing into a sink without a gate.** Doesn't fire — the gate is `parseAgentJson` + type guards.

---

## 8. Security red flags — the audit capstone

The consolidated checklist, marked against this repo.

| # | Red flag | Fires? | Where | One-line fix |
|---|---|---|---|---|
| 1 | Input treated as trusted because it "came from our frontend" | No | `route.ts:32-43` (?insight= re-validated) | — |
| 2 | Endpoint checks logged-in but not allowed | Partial | `investigations.ts:22-28` (no session scope) | Key cache by `(sessionId, insightId)` |
| 3 | String-built query / prompt with user input | Half | `q` reaches the classifier as user turn | System prompts static; risk is prompt-inject, not string concat |
| 4 | Secret in source / client bundle / logs | No | `redactSecrets` covers logs; env-gated CI | — |
| 5 | Response returns more than caller is entitled to | Yes | `investigations.ts:22` cache leak | Session-scope the cache |
| 6 | No lockfile / unpatched known CVE | No lockfile-side; CVE side unknown | `package-lock.json` present | Add `npm audit --audit-level=high` to CI |
| 7 | Agent has more tools than its task needs | Yes | Live agents get `allTools` unfiltered | Wire `filterToolSchemas` into the registry adapter → `03-read-only-tool-allowlist.md` |
| 8 | Model output flows to a sink without a gate | No | `parseAgentJson` + type guards | — |
| 9 | Missing CSRF on state-changing POSTs | N/A | POST endpoints require session cookie + are behind SameSite=None (which weakens the classical CSRF defense); mitigation is that the two POSTs (`/api/mcp/{call,reset}`) do reads/idempotent state-clear only | Consider a same-origin check if a state-mutating POST is added |
| 10 | Verbose errors leak internals | Partial | Response bodies not passed through `redactSecrets`; captured HTTP bodies are | Route error-response substitution through `redactSecrets` too |

Two fire clearly (7, 5), two half-fire (2, 10), the rest don't.

---

## Deep walks

The load-bearing controls each get their own file:

- `01-encrypted-cookie-auth-store.md` — the AES-256-GCM `bi_auth` cookie and its ALS-scoped RequestStore.
- `02-oauth-pkce-with-dcr.md` — OAuth 2.1 + PKCE + Dynamic Client Registration to Bloomreach.
- `03-read-only-tool-allowlist.md` — the client-side POST-to-tool whitelist and the per-agent scope that regressed.
- `04-model-output-type-guards.md` — `parseAgentJson` + the three shape guards at the model output boundary.
- `05-budget-ceiling-defense.md` — `BudgetTracker` as a cost-abuse defense; built, not deployed.
- `06-log-secret-redaction.md` — `redactSecrets` + `formatError` walking the cause chain.
