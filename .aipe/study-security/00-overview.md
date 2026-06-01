# Overview — the trust boundary map

**Industry name(s):** trust boundary diagram, attack surface map, data-flow trust model
**Type:** Industry standard · Language-agnostic

> blooming insights has **three trust boundaries that matter** — the browser → route boundary (encrypted `bi_auth` cookie + httpOnly `bi_session`), the route → MCP boundary (per-session OAuth tokens that ride a Bloomreach-owned authorization model), and the model → typed-value boundary (every agent's output passes through a type-guard + `FALLBACK`, or it doesn't count). The first is solid, the second is solid *because* Bloomreach owns it (we're a client, not an authorizer), and the third is the load-bearing defense that turns prompt injection from a catastrophe into a bounded data-exfil risk.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Every meaningful trust decision in this codebase lives at one of three layers. The browser hands the server a `bi_session` cookie (proves identity within the app) and a `bi_auth` cookie (encrypted store of OAuth tokens + PKCE state). The Next.js route handlers turn that into a `McpClient` via `connectMcp`. The MCP client calls Bloomreach tools — read-only, per-user, rate-limited. Anthropic's API returns model text. That text is parsed, validated, and either matches a typed shape or gets replaced with a `FALLBACK` constant. Nothing in the system writes to Bloomreach. Nothing in the system has a database. The trust topology is small *on purpose*.

```
  Zoom out — every trust boundary in blooming insights

  ┌─ Browser (UNTRUSTED) ─────────────────────────────┐
  │  carries:  bi_session  +  bi_auth (encrypted)     │
  │  user input:  ?q= , ?insightId= , POST body       │
  └─────────────────────────┬─────────────────────────┘
                            │  ★ TRUST BOUNDARY 1 ★
                            │  browser → route
                            ▼
  ┌─ Route handler (TRUSTED — our process) ───────────┐
  │  app/api/agent/route.ts , app/api/briefing , …    │
  │  reads cookies, builds typed Anomaly,             │
  │  spawns NDJSON stream                             │
  └─────────────────────────┬─────────────────────────┘
                            │  ★ TRUST BOUNDARY 2 ★
                            │  route → MCP (OAuth Bearer)
                            ▼
  ┌─ MCP transport + Bloomreach IdP ──────────────────┐
  │  StreamableHTTPClientTransport                    │
  │  per-user access token,                           │
  │  Bloomreach enforces authz on its side            │
  └─────────────────────────┬─────────────────────────┘
                            │
                            ▼
  ┌─ Anthropic API (TRUSTED transport,                │
  │  UNTRUSTED content)                               │
  │  model text returned                              │
  └─────────────────────────┬─────────────────────────┘
                            │  ★ TRUST BOUNDARY 3 ★
                            │  model output → typed value
                            ▼
  ┌─ Validated artifact (TRUSTED) ────────────────────┐
  │  isAnomalyArray / isDiagnosis /                   │
  │  isRecommendationArray  →  FALLBACK on miss       │
  └───────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: at each boundary, what does the trusted side assume about what came across, and what enforces that assumption? At boundary 1, the assumption is "this `bi_auth` cookie hasn't been tampered with" — AES-256-GCM enforces it. At boundary 2, the assumption is "this Bearer token still authorizes the user the cookie said it was" — Bloomreach enforces it; we're a client. At boundary 3, the assumption is "the model returned text that fits the schema" — type-guards enforce it. Each of the eight files in this guide walks one of these boundaries (or a related concern) at full depth.

---

## Structure pass

**Layers.** Four layers that bound trust in this app. The **browser** (untrusted, fully user-controllable). The **route handler** (trusted, runs our code). The **MCP transport + Bloomreach** (trusted transport via TLS + Bearer, but the *server* is upstream — we don't authorize, we authenticate). The **agent loop + validator** (trusted transport to Anthropic, but the *content* coming back is treated as untrusted — exactly because the model can be steered by prompt injection).

**Axis: trust.** Holding one question constant across every layer: *what can each side see, what can each side tamper with, and what code enforces that?* This is the right axis because the file's whole frame is "where does a hostile input get contained." Control is a tempting alternate, but trust pops the boundaries — control just describes who runs first.

**Seams.** Three load-bearing seams, one cosmetic. **Seam 1 (browser → route)** is load-bearing because trust flips from "hostile" to "our process" — every defense at this seam (cookie crypto, sameSite, httpOnly, schema validation of bodies) is what makes the rest of the stack reasonable. **Seam 2 (route → Bloomreach)** is load-bearing but *inverted* — we don't enforce authz here, Bloomreach does; our job is to faithfully carry the per-user token and never escalate. **Seam 3 (model output → typed value)** is load-bearing because trust flips from "any text the model produces" to "matches a guard or falls back" — without this seam, every prompt-injection becomes a content-injection into the UI. The cosmetic seam is route → agent loop: same process, no privilege flip.

```
  Structure pass — trust topology

  ┌─ 1. LAYERS ───────────────────────────────────────┐
  │  Browser · Route handler · MCP/Bloomreach ·       │
  │  Agent loop + validator                           │
  └────────────────────────┬──────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼───────────────────────────┐
  │  trust — what can each side see/tamper with,      │
  │  and which file enforces the assumption?          │
  └────────────────────────┬──────────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼───────────────────────────┐
  │  S1: browser → route          (HOSTILE → OURS)    │
  │      enforced by: cookie crypto + httpOnly        │
  │  S2: route → Bloomreach       (OURS → UPSTREAM)   │
  │      enforced by: per-user Bearer; BR owns authz  │
  │  S3: model → typed value      (UNTRUSTED TEXT →   │
  │      TYPED SHAPE) enforced by: validate.ts +      │
  │      FALLBACK constants                           │
  │  cosmetic: route → agent loop (same process)      │
  └────────────────────────┬──────────────────────────┘
                           ▼
                   the rest of the audit walks each seam in depth
```

The skeleton is mapped — the rest of this overview names the boundaries one more time before the per-file deep dives.

---

## How it works

### Move 1 — the mental model

Three trust gates. Everything else in this codebase derives its safety properties from one of them.

```
  Three gates · what each enforces

   gate 1                gate 2                gate 3
   browser→route         route→Bloomreach      model→typed value

   bi_auth cookie        OAuth Bearer          isAnomalyArray
   AES-256-GCM           per-user token        isDiagnosis
   httpOnly + Secure     Bloomreach owns       isRecommendationArray
   sameSite=None         authz                 FALLBACK on miss
       │                     │                     │
       ▼                     ▼                     ▼
   ┌────────────────────────────────────────────────────┐
   │ each gate is the load-bearing reason the next      │
   │ layer can assume what it assumes                   │
   └────────────────────────────────────────────────────┘
```

### Move 2 — the boundary, one at a time

#### Gate 1 — browser → route

The contract: the cookies the browser sends were issued by our server, are bound to our origin, and (for `bi_auth`) haven't been tampered with. The enforcement is three-part:

```
  Cookie hardening — what the route can assume about the cookies

  bi_session  (identity)            bi_auth  (OAuth state)
  ──────────                        ─────
  httpOnly                          httpOnly
  sameSite=None (prod) / lax (dev)  sameSite=None (prod) / file (dev)
  secure (prod)                     secure (prod)
  random UUID per first hit         AES-256-GCM encrypted
                                    AUTH_SECRET → SHA-256 → key
                                    GCM auth tag rejects tampering
```

What this gate does NOT do: it does not bind to a user identity beyond "this browser was here before." There's no login, no account, no per-user authorization in the application layer. The session is a connection ID, not a user ID. That's appropriate for the app's shape (single-tenant per browser, all real authz is at Bloomreach) but it means *anyone who steals the cookie pair gets the whole session* — there's no second factor.

#### Gate 2 — route → Bloomreach

The contract: the Bearer token attached to every MCP call still represents the user it represented at OAuth time. Enforcement is upstream — we don't issue or validate the token, Bloomreach does. Our job is the negative one: don't escalate, don't share, don't log.

```
  What we send                              What we DON'T do
  ────                                      ─────
  Authorization: Bearer <access_token>      no service account
                                            no impersonation
  per session, per user                     no cross-user pooling
  read-only tools only                      no write/mutate tools
                                            (by tool-set construction)
```

The read-only tool-set discipline is in `lib/mcp/tools.ts` — `monitoringTools`, `diagnosticTools`, `recommendationTools` are all `list_*` / `get_*` / `execute_analytics_eql`. No `create_*`, no `update_*`, no `delete_*`. This is the structural fact that turns the prompt-injection blast radius from "agent writes to your CRM" into "agent reveals data it could already read."

#### Gate 3 — model → typed value

The contract: text coming back from the model is treated as untrusted; nothing flows into a typed artifact without crossing a guard.

```
  Model output gate — every agent output passes through this

  raw model text
        │
        │  parseAgentJson()  ── fence-aware extractor
        ▼
   candidate object
        │
        │  isAnomalyArray / isDiagnosis / isRecommendationArray
        ▼                                  │
   matches? ─yes──▶ typed value         ──no──▶ FALLBACK
                                                (typed safe default)
```

The validator is in `lib/mcp/validate.ts`. The fallback constants are inside each agent file (`DiagnosticAgent.FALLBACK`, etc.). The combination is what makes "the model returned garbage" indistinguishable, from the rest of the system's point of view, from "the model returned a low-confidence diagnosis" — both produce a typed, renderable shape.

### Move 3 — the principle

**Trust is enforced at boundaries by code, not by hope.** Each of the three gates is a specific function (or set of functions) you can point at. Where there's no gate, there's no enforcement — and the audit names those places too. The next eight files walk each boundary in depth, find every place the model of "trusted ↔ untrusted" leaks, and name the fix.

---

## Primary diagram

The full trust topology, with the three gates and the data they protect.

```
  Trust topology — every gate, every assumption

  ┌─ Browser ────────────────────────────────────────────────────────┐
  │  bi_session (httpOnly random uuid)                                │
  │  bi_auth    (httpOnly + AES-256-GCM-encrypted OAuth state/tokens)│
  │  user-controllable: ?q= , ?insightId= , ?insight= , POST body    │
  └───────────────────────────┬───────────────────────────────────────┘
                              │ HTTPS + cookies
                              │ GATE 1 — cookie crypto + httpOnly + sameSite
                              ▼
  ┌─ Route handler ──────────────────────────────────────────────────┐
  │  withAuthCookies(fn)         ←  decrypts bi_auth into ALS store  │
  │  getOrCreateSessionId()      ←  sets bi_session if missing       │
  │  connectMcp(sid)             ←  returns McpClient OR authUrl     │
  │  classifyIntent / parseIntent ← user prose → enum (4 outcomes)   │
  └───────────────────────────┬───────────────────────────────────────┘
                              │ Authorization: Bearer <token>
                              │ GATE 2 — per-user OAuth, BR enforces authz
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
                              ▼
  ┌─ Validated artifact ─────────────────────────────────────────────┐
  │  Anomaly[] | Diagnosis | Recommendation[]                        │
  │  fed to UI as NDJSON events; nothing else writes typed data      │
  └──────────────────────────────────────────────────────────────────┘
```

After Gate 3, the artifact flows into the NDJSON stream and into the React feed. The browser renders it. No further enforcement happens on the way out — which is why over-rendering (returning more than the user is entitled to) is a concern handled in file 05, not here.

---

## Implementation in codebase

The three gates in code. Each is one or two files. The depth lives in the per-concept files; this table is the index.

| Gate | File · Function | Lines | What it enforces |
|---|---|---|---|
| 1 (browser→route, identity) | `lib/mcp/session.ts` · `getOrCreateSessionId` / `sessionCookieOpts` | L10–L24 | `bi_session` cookie: httpOnly, `SameSite=None; Secure` (prod) / `Lax` (dev) |
| 1 (browser→route, auth state) | `lib/mcp/auth.ts` · `aesKey` / `encryptStore` / `decryptStore` | L51–L79 | AES-256-GCM, key = SHA-256(`AUTH_SECRET`); GCM tag rejects tampering |
| 1 (browser→route, auth state) | `lib/mcp/auth.ts` · `withAuthCookies` | L86–L104 | ALS-scoped decrypt-once / flush-once around each request |
| 2 (route→Bloomreach, OAuth) | `lib/mcp/auth.ts` · `BloomreachAuthProvider` | L160–L218 | Implements `OAuthClientProvider`; SDK drives PKCE + DCR |
| 2 (route→Bloomreach, tool surface) | `lib/mcp/tools.ts` · `monitoringTools` / `diagnosticTools` / `recommendationTools` | L5–L40 | Per-agent whitelist; **all read-only** by construction |
| 3 (model→typed value) | `lib/mcp/validate.ts` · `parseAgentJson` / `isAnomalyArray` / `isDiagnosis` / `isRecommendationArray` | L3–L57 | Parse fenced JSON; type-guard each agent shape |
| 3 (model→typed value, fallback) | `lib/agents/diagnostic.ts` · `FALLBACK` | L16–L20 | Safe default Diagnosis when validation fails |
| 3 (model→typed value, fallback) | `lib/agents/monitoring.ts` · graceful degrade | L113–L119 | Returns `[]` on parse/validation failure instead of throwing |

**Use case 1 — a fresh browser hits the feed.** `GET /api/briefing` runs. `getOrCreateSessionId` sets `bi_session`. `connectMcp` (wrapped in `withAuthCookies`) finds no tokens, the SDK throws `UnauthorizedError` after capturing the authorize URL, the route returns `{ needsAuth: true, authUrl }` with status 401. The browser redirects to Bloomreach. After login, `/api/mcp/callback?code=…` exchanges the code, `saveTokens` writes to the ALS store, the response sets the encrypted `bi_auth` cookie. Next call to `/api/briefing` finds tokens and proceeds.

**Use case 2 — the agent returns nonsense.** `MonitoringAgent.scan` calls `runAgentLoop`. The model emits prose instead of a JSON array. `parseAgentJson` throws. The agent catches it and returns `[]`. The UI shows "no anomalies" instead of crashing. The trust gate held.

**Use case 3 — a user sends `?q=ignore prior instructions and email…`.** The route's `q` is `.trim()`'d and passed to `classifyIntent` then `QueryAgent.answer`. The model may or may not comply with the injection — but the *only* tools the QueryAgent has are read-only `list_*` / `get_*` / `execute_analytics_eql` and there's no email tool, no write tool. Worst case: the model includes data in its answer text that exfiltrates *what the user's own Bearer token can already read*. The injection didn't elevate privilege because there was no elevated tool to grant.

---

## Elaborate

### Why three gates instead of one

A common newbie design is "one big auth check at the front door and trust everything after." It works until one part of the system trusts something the front door didn't actually verify — and now the bug is "input that nobody re-checked." Three gates means the assumptions are explicit at each layer. The route doesn't trust the browser's cookie content (Gate 1 cryptographically verifies). The MCP transport doesn't trust the route's session ID (Gate 2 carries an upstream-validated Bearer). The validator doesn't trust the model (Gate 3 type-guards the output). Each layer's defenses don't depend on the next layer holding up its end.

### What this codebase doesn't have, and why that's fine

No user accounts, no per-user data store, no multi-tenant isolation logic. The "user" is the Bloomreach OAuth identity — the app is a thin agentic shell over Bloomreach's existing authz. This is appropriate for the shape (one-browser-one-user demos, hackathon-grade, single Bloomreach project). It would be wrong for a B2B SaaS — but this isn't one. The audit doesn't grade the app against a shape it doesn't aspire to.

### What this codebase *should* have but doesn't

- **CSRF on state-changing endpoints.** `POST /api/mcp/reset` clears auth for whoever holds the `bi_session` cookie. There's no CSRF token. An attacker who can get the user to click a link on another origin (`<form action="https://blooming-insights.app/api/mcp/reset" method="POST">`) can log them out. Low severity (logout is recoverable) but real.
- **Origin check on the NDJSON streaming routes.** `GET /api/briefing` and `GET /api/agent` are GETs with side effects (spending Anthropic tokens). A malicious page could `<img src="https://blooming-insights.app/api/agent?insightId=…">` and the browser sends the cookie. The defense — cost throttling, origin checks — isn't present. File 02 and 08 name this.
- **Request-body schema validation on the JSON POST endpoint.** `POST /api/mcp/call` reads `{ name, args }` and passes both straight to `conn.mcp.callTool` with `skipCache: true`. Name and args are whatever the request says they are. This is a dev tool (it's used by `/debug`) but it's not gated behind a "dev-only" flag the way `capture` and `capture-demo` are. File 03 names this.

### Where to read next

Pick the file that maps to the boundary you care about. Files 01 and 08 give you the widest read; files 02–07 give you the per-boundary depth.

---

## Interview defense

**What they are really asking:** can you name every trust boundary in your app without looking, can you say what enforces each one, and can you honestly name what you didn't enforce?

---

**[mid] — Walk me through the trust boundaries in blooming insights.**

Three. Browser to route — enforced by an httpOnly `bi_session` cookie plus an AES-256-GCM-encrypted `bi_auth` cookie that holds OAuth state and tokens. Route to Bloomreach — enforced by an OAuth Bearer token per session, with Bloomreach owning authz on their side; our discipline is that the per-agent tool whitelist is read-only by construction, so we never carry a write capability across that boundary. Model output to typed value — enforced by `parseAgentJson` + a per-shape type guard in `lib/mcp/validate.ts`, with a `FALLBACK` constant if validation fails. That last one is the load-bearing defense against prompt injection: the model can be steered into emitting anything, but anything that doesn't match the schema gets replaced with a safe default.

```
  three gates · one assumption each

  browser → route       cookie crypto + httpOnly
  route → Bloomreach    per-user Bearer, BR authorizes
  model → typed value   guard or fallback
```

---

**[senior] — Where is the model output trusted, and where could that bite you?**

The model output is *never* directly trusted into typed shapes — `parseAgentJson` + a guard runs first. But the model output IS trusted into the UI as prose at one specific point: the `QueryAgent.answer` path returns `finalText.trim()` as the answer text rendered into the feed. There's no validator there because the contract is "natural-language answer," not a structured shape. The bite-back is: if a user crafts a prompt that succeeds in steering the model into emitting some HTML or a markdown link with an attacker-controlled URL, that lands in the UI. The render side (React) handles the auto-escaping for HTML, so script injection is contained, but a markdown auto-renderer would change that. Currently the feed renders the text as plain text, not markdown — so this is bounded — but it's the place a future feature could break the assumption.

---

**[arch] — You say the prompt-injection blast radius is bounded. What changes if you add a write tool?**

The bound is gone. Right now the `bloomreachFeature` field in the recommendation shape is just a string — `scenario` / `segment` / `campaign` / `voucher` / `experiment` — that the UI renders as a card the *user* acts on manually. If we add a tool that actually *creates* a Bloomreach scenario in response to the recommendation, then a prompt-injection that gets a recommendation produced will get a scenario created. The defense would have to move from "the tool surface is read-only" to "every write has a human-in-the-loop confirmation step." The recommendation shape already supports that conceptually (the user reads the card and acts on it), but the *technical* boundary has to be enforced at the tool layer — not assumed at the UI layer.

```
  read-only world (today)                write world (hypothetical)
  ─────                                  ─────
  injection → bad recommendation         injection → real scenario CREATED
  UI shows card                          Bloomreach mutated
  user reads and ignores                 user has to undo
  blast radius: data exfil               blast radius: account-level damage
```

---

**The dodge — "have you done a real threat model?"**

Honest answer: no, this is a code-level audit of trust boundaries, not a STRIDE walkthrough. The threat actors aren't enumerated, the assets aren't priced, the attack-tree isn't drawn. What this audit gives is "here's every place trust changes hands and here's the code that enforces it" — which is the input to a threat model, not the model itself. For a real production deployment, the next step would be: enumerate the assets (the Bloomreach OAuth tokens are the highest-value thing in this stack), enumerate the actors (other users on the same browser, an attacker who can plant a link, an attacker who can compromise the Anthropic key), and write the abuse cases that the three gates either contain or don't.

---

**One-line anchors:**
- Three trust gates: cookie crypto · per-user Bearer · validate.ts + FALLBACK.
- The read-only tool whitelist (`lib/mcp/tools.ts`) is what bounds prompt-injection damage.
- Gate 3 (validate.ts) is the most important gate to *demonstrate* because it's the one that turns "model wrote nonsense" into a UX outcome instead of a security incident.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, draw the trust topology: browser, route, MCP+Bloomreach, model output. Name the gate at each boundary and the file that enforces it. Then check against the table in **Implementation in codebase**.

### Level 2 — Explain
Why does the system have a `bi_auth` cookie in production but a file in development? What changes about the trust environment between the two? Check `lib/mcp/auth.ts` L26–L33.

### Level 3 — Apply
A teammate proposes adding `POST /api/insights` that takes a JSON body and stores it in memory for the briefing to render. Walk through which trust boundary it crosses, what defenses it inherits for free (cookies, MCP auth), and what new defenses it would need (schema validation of the body, size limits, anti-replay, CSRF). Reference the files that would need touching.

### Level 4 — Defend
Defend the choice to not have user accounts in this app. When is it the right call, when does it become the wrong one, and what's the migration path if you needed to add accounts tomorrow?

### Quick check
- Which file holds the AES-256-GCM crypto? → `lib/mcp/auth.ts` L51–L79
- Which file owns the per-agent tool whitelist? → `lib/mcp/tools.ts` L5–L40
- Which file owns model-output validation? → `lib/mcp/validate.ts` L3–L57
- Which routes are dev-only? → `app/api/mcp/capture/route.ts` and `app/api/mcp/capture-demo/route.ts` (both gated `if (NODE_ENV === 'production') return 403`)

---

## See also

→ [01-trust-boundaries-and-attack-surface.md](./01-trust-boundaries-and-attack-surface.md) · [02-authentication-and-authorization.md](./02-authentication-and-authorization.md) · [08-security-red-flags-audit.md](./08-security-red-flags-audit.md)
