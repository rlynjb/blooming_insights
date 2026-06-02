# Overview — security in blooming insights

**Industry name(s):** trust boundary diagram, attack surface map, data-flow trust model
**Type:** Industry standard · Project-specific

> Three trust boundaries that matter, five patterns worth a deep walk. The browser→route boundary rests on an httpOnly `bi_session` cookie plus an AES-256-GCM-encrypted `bi_auth` cookie that carries the entire OAuth state across requests on stateless Vercel serverless. The route→Bloomreach boundary is enforced upstream (we carry the user's Bearer token; Bloomreach owns authz). The model→typed-value boundary is the load-bearing prompt-injection defense — `parseAgentJson` + per-shape type guards + `FALLBACK` constants, paired with per-agent read-only tool whitelists that make the model structurally incapable of write actions. The single high-severity gap is `POST /api/mcp/call` accepting any tool name with no allowlist — every other surface has either an enforced shape, a structural blast-radius bound, or both.

---

## How to read this guide

Reading order is **audit first, then pattern files** in numbered order:

1. **`audit.md`** — the one-pass survey across all eight security lenses. Read this first to get the full picture; it cross-links into the pattern files where deeper walks live.

2. **`01-encrypted-cookie-oauth-state.md`** — the AES-256-GCM `bi_auth` cookie pattern. The only durable production state in the app.

3. **`02-als-scoped-request-store.md`** — the AsyncLocalStorage-scoped store that holds per-request auth state. The synchronization primitive that makes the cookie pattern survive Next's request/response split.

4. **`03-type-guard-trust-boundary.md`** — `parseAgentJson` + `isAnomalyArray` / `isDiagnosis` / `isRecommendationArray` + `FALLBACK` constants. The model-output trust boundary that bounds prompt-injection blast radius.

5. **`04-read-only-tool-whitelist.md`** — the per-agent capability minimization pattern in `lib/mcp/tools.ts`. The structural defense that means even successful prompt injection can't trigger write actions.

6. **`05-open-tool-surface-gap.md`** — the H1 finding: `POST /api/mcp/call` accepts any tool name with no allowlist. The one-line structural fix that closes it.

If you want the **shortest path to "is this safe to ship":** read `audit.md`. Top 3 ranked findings are at the bottom; the lens sections give you the full posture.

If you want the **per-pattern depth:** read the numbered pattern files. Each one stands alone — the audit is the index.

If you're **here to defend it in an interview or a security review:** every pattern file ends with an Interview defense block (the questions a senior reviewer will actually ask) and a Validate block (four levels: reconstruct → explain → apply → defend).

---

## The trust topology in one frame

The three trust gates and the file that owns each.

```
  blooming insights — trust topology

  ┌─ Browser ────────────────────────────────────────────────────────┐
  │  bi_session (httpOnly random uuid)                                │
  │  bi_auth    (httpOnly + AES-256-GCM-encrypted OAuth state/tokens)│
  │  user-controllable: ?q= , ?insightId= , ?insight= , POST body    │
  └───────────────────────────┬───────────────────────────────────────┘
                              │ HTTPS + cookies
                              │ GATE 1 — cookie crypto + httpOnly + sameSite
                              │ owners: lib/mcp/session.ts , lib/mcp/auth.ts
                              ▼
  ┌─ Route handler ──────────────────────────────────────────────────┐
  │  withAuthCookies(fn)         ←  decrypts bi_auth into ALS store  │
  │  getOrCreateSessionId()      ←  sets bi_session if missing       │
  │  connectMcp(sid)             ←  returns McpClient OR authUrl     │
  │  classifyIntent / parseIntent ← user prose → enum (4 outcomes)   │
  └───────────────────────────┬───────────────────────────────────────┘
                              │ Authorization: Bearer <token>
                              │ GATE 2 — per-user OAuth, BR enforces authz
                              │ owners: lib/mcp/auth.ts (provider) , lib/mcp/tools.ts
                              ▼
  ┌─ MCP transport + Bloomreach IdP ─────────────────────────────────┐
  │  StreamableHTTPClientTransport · OAuthClientProvider             │
  │  read-only tools only (by tool-set whitelist)                    │
  │  rate-limited (~1 req/s globally per user, server-stated)        │
  └───────────────────────────┬───────────────────────────────────────┘
                              │ tool result (JSON)
                              ▼
  ┌─ Agent loop (runAgentLoop) ──────────────────────────────────────┐
  │  Claude reads system + user + tool results                       │
  │  emits more tool_use OR final text                               │
  └───────────────────────────┬───────────────────────────────────────┘
                              │ raw text
                              │ GATE 3 — parseAgentJson + type guard + FALLBACK
                              │ owners: lib/mcp/validate.ts , per-agent FALLBACKs
                              ▼
  ┌─ Validated artifact ─────────────────────────────────────────────┐
  │  Anomaly[] | Diagnosis | Recommendation[]                        │
  │  fed to UI as NDJSON events; nothing else writes typed data      │
  └──────────────────────────────────────────────────────────────────┘
```

After Gate 3, the artifact flows into the NDJSON stream and into the React feed. The browser renders it. No further enforcement happens on the way out — which is why over-rendering concerns belong to the data-exposure lens in `audit.md` rather than to a pattern file.

---

## The pattern files at a glance

| # | File | What it covers | Why it earns a file |
|---|---|---|---|
| 01 | [encrypted-cookie-oauth-state](./01-encrypted-cookie-oauth-state.md) | AES-256-GCM `bi_auth` cookie + `withAuthCookies` wrapper | The only durable production state; strip it out → OAuth flow can't survive serverless |
| 02 | [als-scoped-request-store](./02-als-scoped-request-store.md) | `AsyncLocalStorage<RequestStore>` synchronization primitive | The reason `withAuthCookies` works under concurrent requests; can't be replaced without forking the MCP SDK |
| 03 | [type-guard-trust-boundary](./03-type-guard-trust-boundary.md) | `parseAgentJson` + `isXxx` + `FALLBACK` | The load-bearing prompt-injection defense; converts model output into a typed value or a safe default |
| 04 | [read-only-tool-whitelist](./04-read-only-tool-whitelist.md) | Per-agent capability minimization via `lib/mcp/tools.ts` + `filterToolSchemas` | Structural reason no prompt injection can trigger a write action — the model has no name to emit |
| 05 | [open-tool-surface-gap](./05-open-tool-surface-gap.md) | The H1 finding: `POST /api/mcp/call` accepts any tool name | The single highest-severity exposure; one-line structural fix closes it |

---

## Cross-references

Two existing files in this codebase already cover slices of the security surface from a different angle:

- `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md` — the canonical OAuth/PKCE/DCR + encrypted cookie treatment, from the architecture angle. `01-encrypted-cookie-oauth-state.md` references it instead of re-deriving the OAuth mechanics.
- `.aipe/study-ai-engineering/06-production-serving/03-prompt-injection.md` — the prompt-injection treatment from the LLM angle (what the attack shape is, why structural defenses work). Both `03-type-guard-trust-boundary.md` and `04-read-only-tool-whitelist.md` reference it instead of duplicating; the trust-boundary framing here is complementary.

---

## What this audit does NOT cover

- **Threat modeling at scale.** No DDoS analysis, no abuse cost modeling, no distributed-systems trust (this isn't a multi-tenant service).
- **Compliance.** No GDPR/CCPA/SOC2 paperwork. The audit is technical — if the code touches PII unsafely, it's flagged here, but the policy frame is not.
- **Penetration testing.** No exploit code. The spec is explicit: name the weakness, name the fix, never write the attack.
- **Bloomreach IdP internals.** The MCP server's auth, rate-limits, and data handling are out of scope — we audit the trust boundary *toward* it, not its insides.
