# Security overview — blooming insights

The audit at a glance. The trust map, the three highest-risk findings, and a one-line verdict per lens. Deep walks live in `audit.md` and the numbered pattern files.

---

## The trust map (three boundaries, not four)

```
  Where each side sees, and what it can tamper with

  ┌─ Browser ──────────────────┐
  │  React app + fetch/stream   │  ★ untrusted ★
  │  QueryBox (free-form Q&A)   │  attacker plane
  │  sessionStorage (insight)   │
  └──────┬──────────────────────┘
         │  bi_session (httpOnly, SameSite=None+Secure in prod)
         │  bi_auth    (AES-256-GCM under AUTH_SECRET)
         ▼
  ┌─ Next.js server ───────────┐
  │  app/api/*                  │  ★ trusted core ★
  │  ALS-scoped RequestStore    │  every trust decision lives here
  │  type-guarded model output  │
  └──────┬───────────────┬──────┘
         │               │
         │ Bearer +      │ x-api-key
         │ OAuth 2.1     │ (ANTHROPIC_API_KEY, server-only)
         ▼               ▼
  ┌─ Bloomreach MCP ──┐ ┌─ Anthropic ──────┐
  │  loomi connect     │ │  claude-sonnet-4-6│
  │  data provider     │ │  RESPONSE IS      │
  │                    │ │  UNTRUSTED INPUT  │
  └────────────────────┘ └───────────────────┘
```

Olist is not a hop. Any earlier note that mentioned "4 trust boundaries" is stale — the Olist adapter was retired; only Bloomreach and Anthropic sit across a network boundary today.

---

## Three highest-risk findings, ranked

### 1 — Per-agent tool capability gate regressed in the AptKit migration

**Severity: high · locus:** `lib/agents/{diagnostic,monitoring,recommendation,query}.ts` construct `BloomingToolRegistryAdapter(this.dataSource, this.allTools)` and hand it the **full** tool catalog, not the per-agent subset. `filterToolSchemas` in `lib/agents/tool-schemas.ts:9` is only called by the four `*-legacy.ts` classes; the live agent path bypasses it entirely.

The three per-agent subsets — `monitoringTools`, `diagnosticTools`, `recommendationTools` in `lib/mcp/tools.ts` — exist, they just aren't wired to the live agents anymore. What breaks: prompt-injection or a bad model turn during the recommendation phase can now call any of the ~25 tools the MCP server exposes, not just the seven the recommender was designed around. The model still needs to *choose* to call one, but the least-privilege intent is gone.

**Fix:** pass a filtered `allTools` per agent — either at the constructor (agents keep their own catalog) or inside `BloomingToolRegistryAdapter.listTools()` (registry filters by an injected allowlist). The tests in `test/agents/tool-schemas.test.ts` still cover the pure function; a companion test for the registry adapter locks the intent.

→ deep walk: `03-read-only-tool-allowlist.md`

### 2 — Investigation cache is not session-scoped

**Severity: medium · locus:** `lib/state/investigations.ts:22-28` — `getCachedInvestigation(insightId)` keys off the insight UUID globally. The agent route's replay path in `app/api/agent/route.ts:126-141` reads that cache before checking session ownership; a caller who knows the UUID can replay another user's investigation.

Insight IDs are `crypto.randomUUID()` (`lib/state/insights.ts:26`), so guessability is low, but the isolation is by-obscurity rather than by-check. If an insight ID leaks (logs, a shared URL, a debug page), the investigation stream — including the tool results the diagnostic agent gathered from that user's Bloomreach workspace — replays to anyone who has it.

**Fix:** key the cache by `(sessionId, insightId)`, or gate replay behind a `getInsight(sid, insightId)` lookup before the cache read. The insights map is already session-scoped (`lib/state/insights.ts:14`); this closes the last leaky surface.

→ lens finding: `audit.md` → 5. data-exposure-and-privacy

### 3 — Budget ceiling exists but is not wired into production routes

**Severity: medium (cost-abuse defense) · locus:** `lib/agents/budget.ts` defines `BudgetTracker` + `BudgetExceededError`; both are instantiated only in `eval/run.eval.ts:194-195` and `eval/load.eval.ts:265`. The route handlers (`app/api/agent/route.ts`, `app/api/briefing/route.ts`) never construct a tracker and never pass `budget` in `AgentHooks`.

What that means concretely: a prompt-injection loop that keeps the diagnostic agent tool-calling until the 300s Vercel budget expires will burn the full model spend that time supports — no ceiling throws before the next dispatch. The mechanism is built and tested; the last mile is wiring.

**Fix:** construct a `BudgetTracker({ maxCostUsd: Number(process.env.BUDGET_MAX_USD ?? '2.0') })` per request and thread it via `AgentHooks.budget` into each agent's `investigate` / `propose` / `answer`. The route's existing catch block already knows how to emit an NDJSON `error` event; `BudgetExceededError` rides that path.

→ deep walk: `05-budget-ceiling-defense.md`

---

## One-line verdict per lens

| Lens | Verdict |
|---|---|
| 1. Attack surface | Three input channels: query params (`insightId`, `insight`, `diagnosis`, `q`), MCP responses, model output. Query params validated at parse; model output type-guarded (`lib/mcp/validate.ts`). Free-form `q` flows to the classifier + query agent unrestricted. |
| 2. Authn & authz | Encrypted-cookie auth (bi_auth, AES-256-GCM); OAuth 2.1 + PKCE + DCR to Bloomreach; session cookie is httpOnly. Authz is one level (has-tokens); no per-tenant scoping beyond session. |
| 3. Input validation & injection | No SQL. EQL is emitted by the model, sent through the whitelisted `execute_analytics_eql` tool — the risk is prompt injection producing a hostile EQL string, mitigated by MCP being read-only. No shell/fs sinks reached by user input. |
| 4. Secrets & config | `ANTHROPIC_API_KEY` server-only; `AUTH_SECRET` gates cookie crypto with a hard throw if missing (`lib/mcp/auth.ts:52-58`); `.env*` gitignored; CI uses fake keys (`ci.yml:45,53`). |
| 5. Data exposure | Cross-session insight/anomaly lookup already scoped by sid. **Investigation cache is not** (see finding 2). Log lines carry `sessionId` but that's a synthetic UUID, not PII. |
| 6. Deps & supply chain | Lockfile present. `@aptkit/core` is a private-namespaced dependency (`npm:@rlynjb/aptkit-core@^0.3.0`) — trust boundary you own but manage as a separate publish. No postinstall risk found. |
| 7. LLM & agent | Model output IS untrusted input; type-guarded at the boundary. Per-agent tool scope regressed (finding 1). Budget ceiling built but not deployed (finding 3). No memory across investigations to poison. |
| 8. Red flags | See `audit.md` → 8 for the checklist. Two fire, four don't, two are honest N/A for this repo shape. |

Full walks: `audit.md`.
