# Trust boundaries and attack surface

**Industry name(s):** trust boundary, attack surface, data-flow trust analysis, untrusted-input enumeration
**Type:** Industry standard · Language-agnostic

> Every untrusted input in blooming insights enters through one of **five surfaces** — request query/body, cookies, MCP tool responses (from Bloomreach), Anthropic model output, and three local files (`.auth-cache.json`, `.investigation-cache.json`, `lib/state/demo-*.json`). The first two are user-controllable; the third and fourth are *upstream-controlled* but not user-controlled; the fifth is dev-only. The biggest unenforced assumption is on `POST /api/mcp/call` — it accepts any `{name, args}` and forwards them to the live MCP tool surface with `skipCache: true`, gated only by an authenticated session, with no body schema and no tool-name allowlist.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Trust boundaries are the joints in your app where data crosses from "I didn't make this" to "I'm about to act on this." Five surfaces in this codebase. Three are the kind every web app has (request, cookies, upstream API). Two are AI-specific (model output, MCP tool responses). One is dev-only filesystem state. The audit is small because the app is small — but each surface needs a named enforcement, and where there isn't one, that's a finding.

```
  Zoom out — every untrusted-input surface in blooming insights

  ┌─ UI / Browser ────────────────────────────────────┐
  │  the user controls these directly                  │
  │  ★ ?q= , ?insightId= , ?insight= (URL-decoded JSON)│
  │  ★ POST body to /api/mcp/call, /api/mcp/capture-demo│
  │  ★ bi_session, bi_auth cookies                    │
  └─────────────────────────┬─────────────────────────┘
                            │  ★ TRUST BOUNDARY ★
  ┌─ Route handler ─────────▼─────────────────────────┐
  │  reads inputs, dispatches to agents/MCP            │  ← we are here
  └─────────────────────────┬─────────────────────────┘
                            │  ★ TRUST BOUNDARY (upstream) ★
  ┌─ MCP / Anthropic upstream ─────────────────────────┐
  │  ★ MCP tool result JSON                            │
  │  ★ Anthropic message content                       │
  └─────────────────────────┬─────────────────────────┘
                            │  ★ TRUST BOUNDARY (filesystem, dev) ★
  ┌─ Local files (DEV ONLY) ───────────────────────────┐
  │  ★ .auth-cache.json (gitignored)                   │
  │  ★ .investigation-cache.json (gitignored)          │
  │  ★ lib/state/demo-*.json (COMMITTED)               │
  └────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question at each surface: *what does the trusted side assume, and what code enforces the assumption?* Walking the five surfaces in order tells you the attack surface; the gap between assumed and enforced tells you the findings. The single load-bearing red flag here is `POST /api/mcp/call` accepting an arbitrary tool name with no allowlist — every other surface has at least one structural defense.

---

## Structure pass

**Layers.** Three altitudes of trust. The **edge** layer (cookies, query, body — what the browser sends). The **upstream** layer (MCP tool responses, Anthropic model text — what other services send). The **local** layer (files on the box — what previous runs of *this* process wrote down).

**Axis: trust.** Hold one question constant down the layers: *who controls the bytes, and what enforces the shape on the way in?* At the edge, the user controls them; cookie crypto + (sometimes) JSON parsing enforces shape. At upstream, Bloomreach/Anthropic control them; tool-result `unwrap` and `parseAgentJson + isXxx` guards enforce shape. At the local layer, prior runs of the app controlled them; the `JSON.parse` in `readJson` and the absence of validation is the gap.

**Seams.** The cosmetic seam is between the edge surfaces (cookies vs query vs body — they're all "browser-controlled"). The load-bearing seam is between the edge and the route handler — that's where a missing enforcement directly becomes an exploit. The second load-bearing seam is between the upstream layer and the agent loop / schema parser — that's where a malformed Bloomreach response would crash the bootstrap, and where model output would otherwise poison the typed shape.

```
  Structure pass — every untrusted surface, traced

  ┌─ 1. LAYERS ───────────────────────────────────────┐
  │  edge (cookies/query/body)                         │
  │  upstream (MCP results · model text)               │
  │  local (cache files, dev-only)                     │
  └────────────────────────┬──────────────────────────┘
                           │  hold the trust question
  ┌─ 2. AXIS ─────────────▼───────────────────────────┐
  │  trust: who controls the bytes, what enforces      │
  │  shape on the way in?                              │
  └────────────────────────┬──────────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼───────────────────────────┐
  │  edge → route       LOAD-BEARING                   │
  │     cookies enforced (crypto)                      │
  │     query partially enforced (small parse blocks)  │
  │     body NOT schema-validated on /api/mcp/call ⚠️  │
  │  upstream → typed value  LOAD-BEARING              │
  │     model text → validate.ts guards (good)         │
  │     MCP results → unwrap + parse (good for bootstrap)│
  │  local → in-memory  COSMETIC (dev-only, gitignored)│
  └────────────────────────┬──────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped. Next we walk each surface one at a time.

---

## How it works

### Move 1 — the mental model

Every surface is a *pipe*. The bytes come in; the question is "do we know what shape they have, and what happens if they have a different shape?" A surface with no enforcement is a surface where the shape can be anything — and the rest of the code has to handle anything, or it'll crash on the first unusual input.

```
  An untrusted-input surface — what enforcement looks like

  ┌─ bytes in ─┐
  │  (network, │
  │  cookie,   │
  │  file)     │
  └─────┬──────┘
        │
        ▼
  ┌─ enforcement gate ─┐  ← present?  passes only known-shaped data
  │  schema validation │     absent?  any byte sequence reaches the sink
  │  type guard        │
  │  size limit        │
  └─────┬──────────────┘
        │
        ▼
  ┌─ trusted sink ─────┐
  │  database write    │
  │  tool invocation   │
  │  prompt render     │
  └────────────────────┘
```

### Move 2 — walk each surface

#### Surface A — `?q=` (free-form query string)

The user types a question. The route reads `req.nextUrl.searchParams.get('q')?.trim()`. That's the only sanitization. Then `q` goes two places: into `classifyIntent(anthropic, q)` (sent to Claude Haiku as a user message), and into `QueryAgent.answer(q, intent, hooks)` (sent to Claude Sonnet as the userPrompt).

```
  ?q= surface — flow

  ┌─ browser ────────┐   ?q=anything the user types
  │  user enters text│ ──────────────────────────────────▶
  └──────────────────┘
                                   ┌─ route ───────────────────┐
                                   │  q = searchParams.get('q')│
                                   │      ?.trim() || null     │
                                   └──────────┬────────────────┘
                                              │  no schema, no length cap
                                              ▼
                                   ┌─ Anthropic ───────────────┐
                                   │  classifyIntent(q)        │
                                   │  QueryAgent.answer(q,…)   │
                                   └───────────────────────────┘
```

**What's enforced:** `.trim()`. That's it. No length limit on the URL, no character filter, no schema. The browser/proxy URL-length limit (~8KB common) is the effective cap.

**What's at risk:** prompt injection. This is the surface the file `.aipe/study-ai-engineering/06-production-serving/03-prompt-injection.md` covers in depth from the LLM angle. From the trust-boundary angle, the finding is: there's no input validation, but the blast radius is bounded by Gate 3 (validate.ts) and by the read-only tool whitelist. Honest: this is the gap the system *chose* to leave because there's no input validation that meaningfully prevents prompt injection — only output and tool-surface defenses do.

#### Surface B — `?insightId=` and `?insight=` (URL-encoded JSON)

The investigate page hands the agent route an insight, either by ID (server lookup) or by serializing the full insight as a JSON string into `?insight=`. The route does:

```
  ?insight= surface — flow

  ┌─ browser ──────────────────────────┐
  │  insight = JSON.stringify(insight) │
  │  url = `?insight=${insight}`       │
  └────────────┬───────────────────────┘
               │ URL-encoded JSON, ~few KB typical
               ▼
  ┌─ route (app/api/agent/route.ts L37–L46) ──────┐
  │  if (insightParam):                            │
  │    try:                                        │
  │      i = JSON.parse(insightParam) as Insight   │
  │      if (i.metric is string && i.change &&     │
  │          Array.isArray(i.scope) && i.severity):│
  │        return insightToAnomaly(i)              │
  │    catch: fall through                         │
  └────────────┬───────────────────────────────────┘
               │ if validation fails OR no param,
               │ falls back to in-memory lookup by id
               ▼
  ┌─ agent loop ─────────────────────────────────┐
  │  inv = anomaly; passed to DiagnosticAgent    │
  └──────────────────────────────────────────────┘
```

**What's enforced:** a hand-rolled four-field shape check (`metric` is string, `change` exists, `scope` is array, `severity` is truthy). On any failure, the route falls through to the in-memory lookup — *not* a hard 400. That fallback is the load-bearing forgiving behaviour; without it the URL-only flow wouldn't work after Vercel's per-instance memory wipe.

**What's at risk:** the user can craft any `Insight` shape they want and the diagnostic agent will investigate it. The "attack" here is benign — they're investigating their own session's view — *because* the only thing the diagnostic agent does is read Bloomreach data for the user's own OAuth token. If the agent had a write tool, this would be the route to feed it adversarial state. Today, it doesn't, so the surface is bounded.

#### Surface C — request bodies on `POST` routes

Three POST routes. Each is a separate surface.

```
  Three POST surfaces — what each accepts and validates

  POST /api/mcp/call           POST /api/mcp/reset           POST /api/mcp/capture-demo
  ─────                        ─────                         ─────
  body: { name, args }         body: ignored                 body: { insights, workspace, trace }
                                                              (gated: dev only, returns 403 in prod)
  schema validation: NONE      auth required: yes            schema validation:
  tool-name allowlist: NONE       (only clears the session)    Array.isArray(body?.insights)
  size cap: Next default          → low blast radius            && length > 0
  side effect: live MCP call,                                  → minimal but present
   skipCache: true
```

`/api/mcp/call` is the load-bearing finding. It reads `{name, args}` and passes both straight to `conn.mcp.callTool(name, args ?? {}, { skipCache: true })`. The constraints:

- Authenticated session is required (must hold `bi_session` + valid OAuth tokens).
- The MCP server itself enforces what tools exist and what they do.
- The tools are all read-only by tool-set construction.

But there's no app-layer check that `name` is in `monitoringTools ∪ diagnosticTools ∪ recommendationTools ∪ bootstrapTools`. Whatever the MCP server exposes is callable. **Honest assessment:** this is intentional for `/debug` — it's the introspection endpoint that lets you call arbitrary tools to test. It is NOT gated `if (NODE_ENV === 'production')` the way `capture` and `capture-demo` are. So in production, a logged-in user can call any tool the MCP server exposes, including ones not in any agent's whitelist. The blast radius is bounded by Bloomreach's own authz and by the read-only-tools assumption — but if Bloomreach ever adds a write tool to the server, this route would expose it.

#### Surface D — cookies (`bi_session`, `bi_auth`)

The two cookies arrive on every request. `bi_session` is a random UUID (httpOnly, sameSite=None+Secure in prod). `bi_auth` is the AES-256-GCM-encrypted OAuth state store. Both are httpOnly so they're out of reach of JavaScript.

```
  Cookie surface — what each is, what enforces it

  bi_session                   bi_auth
  ─────                        ─────
  random UUID                  AES-256-GCM ciphertext (base64url)
  httpOnly                     httpOnly
  Secure + SameSite=None       Secure + SameSite=None
  set on first request         set after OAuth completes
  if absent: route assigns one  if absent or undecryptable:
                                decryptStore returns {} (no auth)
```

**What's enforced:** for `bi_auth`, GCM authentication. Tampering invalidates the auth tag and `decryptStore` returns `{}`. For `bi_session`, nothing — it's just a UUID. If a user changes the UUID to one they guess belongs to someone else, the worst case is they hit `withAuthCookies` with their *own* `bi_auth` (which decrypted under their own session id wouldn't apply) and the OAuth state lookup misses. No cross-session bleed because `bi_auth` decrypts only with the secret AND its keys are session-id-scoped.

**What's at risk:** cookie theft. Both cookies together = full impersonation. No second factor, no IP binding, no token rotation. If an attacker gets both cookies (XSS-by-extension, malware, shared computer), they get the session for the full 10-day cookie lifetime. The httpOnly flag is the structural defense against XSS-based exfiltration.

#### Surface E — MCP tool results (upstream)

Every tool call returns a JSON envelope from Bloomreach. The route doesn't manufacture this — it forwards it to the model as `tool_result` content, and `bootstrapSchema` parses specific calls via `unwrap` / `parseWorkspaceSchema`.

```
  MCP result surface — what comes back

  Bloomreach tool result
   │
   ▼
   { isError?: boolean, content: [{ text: <JSON string> }],
     structuredContent?: <object> }
   │
   ├──▶ unwrap()  (lib/mcp/schema.ts L29–L36)
   │       prefers structuredContent, else JSON.parse(content[0].text)
   │
   ├──▶ parseWorkspaceSchema()  (lib/mcp/schema.ts L74–L125)
   │       safe defaults for missing fields
   │
   └──▶ forwarded to model as tool_result block
           model treats it as data, not instruction (in principle)
           in practice: indirect prompt injection via the result text
```

**What's enforced:** `unwrap` handles the envelope shape. `parseWorkspaceSchema` handles missing fields with `?? []` / `?? {}` everywhere. The forwarded-to-model path has no enforcement — by design, the model is supposed to read tool results.

**What's at risk:** indirect prompt injection. If Bloomreach data (event names, customer property values, catalog item descriptions) contained text that looked like "ignore prior instructions and X," the model would receive it inside a `tool_result` block and might act on it. The defense is the same as Surface A: the tool whitelist is read-only, the output is validated, and the blast radius is data exfiltration in the answer text — not catastrophic action. This is the indirect-injection variant covered conceptually in `.aipe/study-ai-engineering/06-production-serving/03-prompt-injection.md`.

#### Surface F — Anthropic model output

Already covered in detail under Gate 3 in `00-overview.md`. Surface summary:

```
  Model output surface

  model returns Anthropic.Messages.Message
   │
   ▼
   parseAgentJson(text)
   │  ├─ fence extract  (```json ... ```)
   │  ├─ try JSON.parse
   │  └─ substring scan from first [/{ to last ]/}
   │
   ▼
   isAnomalyArray / isDiagnosis / isRecommendationArray
   │
   ▼  match            no match
   typed value         FALLBACK or []
```

**What's enforced:** parse + type guard + safe default. This is the strongest enforcement of any surface in the audit.

**What's at risk:** the `QueryAgent.answer` path returns `finalText.trim()` as the answer text directly into the UI — no validator, because the shape is "natural language." This is the one place model output crosses into the UI without a guard. React's auto-escaping handles HTML-injection; the gap is "what if someone adds markdown rendering" or "what if the model emits a fake link the user clicks."

#### Surface G — local files (dev only)

`.auth-cache.json` (gitignored, contains plaintext OAuth tokens). `.investigation-cache.json` (gitignored, contains cached agent runs — no secrets). `lib/state/demo-insights.json` and `lib/state/demo-investigations.json` (COMMITTED, snapshot of a demo run).

```
  Local file surface — what's where

  filename                              gitignored?   contains              read by
  ─────                                 ─────────     ─────                 ─────
  .auth-cache.json                      yes           OAuth tokens (plain) lib/mcp/auth.ts (dev)
  .investigation-cache.json             yes           agent run events     lib/state/investigations.ts
  lib/state/demo-insights.json          NO (committed) demo insights        app/api/briefing/route.ts (?demo=cached)
  lib/state/demo-investigations.json    NO (committed) demo investigations   lib/state/investigations.ts
```

**What's enforced:** for `.auth-cache.json`, gitignore prevents accidental commit; the file is dev-only (production uses the encrypted cookie). For the demo files, they're hand-curated snapshots loaded with `JSON.parse(readFileSync(...))` — no validation, but they're trusted because we wrote them.

**What's at risk:** if `.auth-cache.json` is accidentally committed (the gitignore is what's enforcing it), real OAuth tokens leak into git history. The mitigation is the gitignore + the comment `// SECURITY: the dev cache holds OAuth tokens in plaintext; it is local-only and gitignored.` (auth.ts L26–L33). For the committed demo files, an attacker who could PR to the repo could plant a malicious payload — but at that point they have repo write access and the demo-file content is the least of the worries.

### Move 3 — the principle

**Untrusted input is everywhere; the audit's value is naming the surface, the enforcement, and the gap — all three.** A surface with no enforcement is fine if you can name the structural reason the blast radius is bounded; a surface with strong enforcement is wrong if it gives you confidence to lower defenses elsewhere. The goal isn't "no untrusted input" — that's impossible — it's "every untrusted input has a named owner."

---

## Primary diagram

The full attack surface in one frame, with every surface labelled and the enforcement (or its absence) named.

```
  blooming insights — attack surface map

  ┌─ Browser-controlled surfaces ─────────────────────────────────────┐
  │                                                                    │
  │  Surface A: ?q=             enforced: .trim() only                │
  │  Surface B: ?insight=       enforced: 4-field shape check         │
  │             ?insightId=     enforced: string read, looked up      │
  │  Surface C: POST /api/mcp/call   enforced: AUTH ONLY (no schema, │
  │                                   no tool allowlist)  ★FINDING    │
  │  Surface C: POST /api/mcp/reset  enforced: AUTH; no body needed  │
  │  Surface C: POST /api/mcp/capture-demo  enforced: dev-only 403,  │
  │                                          minimal shape check     │
  │  Surface D: bi_session      enforced: httpOnly + Secure + None    │
  │  Surface D: bi_auth         enforced: AES-256-GCM (auth tag)      │
  │                                                                    │
  └──────────────────────────────┬─────────────────────────────────────┘
                                 │
                                 ▼
  ┌─ Upstream-controlled surfaces ────────────────────────────────────┐
  │                                                                    │
  │  Surface E: MCP tool result JSON                                  │
  │    enforced: unwrap + parseWorkspaceSchema (bootstrap)             │
  │              raw forward to model (agent tool calls)               │
  │              risk: indirect prompt injection (bounded by gate 3)   │
  │                                                                    │
  │  Surface F: Anthropic model output                                │
  │    enforced: parseAgentJson + isXxx + FALLBACK (structured)        │
  │              QueryAgent.answer: trim() only (natural language)     │
  │                                                                    │
  └──────────────────────────────┬─────────────────────────────────────┘
                                 │
                                 ▼
  ┌─ Filesystem surfaces (dev only) ──────────────────────────────────┐
  │                                                                    │
  │  Surface G: .auth-cache.json (plaintext tokens, gitignored)       │
  │             .investigation-cache.json (run data, gitignored)      │
  │             lib/state/demo-*.json (committed snapshots)            │
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘
```

The single ★FINDING tag is the load-bearing audit takeaway from this file: every other surface has either an enforced shape, a structural blast-radius bound, or both. `POST /api/mcp/call` has neither beyond the session check and the upstream's own discipline.

---

## Implementation in codebase

| Surface | File · Location | Lines | Enforcement |
|---|---|---|---|
| A: `?q=` | `app/api/agent/route.ts` | L115 | `searchParams.get('q')?.trim() \|\| null` |
| B: `?insightId=` | `app/api/agent/route.ts` | L113 | string read, looked up via `resolveAnomaly` |
| B: `?insight=` | `app/api/agent/route.ts` `resolveAnomaly` | L37–L46 | `JSON.parse` + 4-field shape check |
| B: `?diagnosis=` | `app/api/agent/route.ts` `parseDiagnosis` | L86–L97 | `JSON.parse` + 3-field shape check |
| C: `POST /api/mcp/call` | `app/api/mcp/call/route.ts` | L5–L22 | session check only; no body schema, no tool allowlist |
| C: `POST /api/mcp/reset` | `app/api/mcp/reset/route.ts` | L10–L15 | session check; no body needed |
| C: `POST /api/mcp/capture` | `app/api/mcp/capture/route.ts` | L22–L24 | dev-only (returns 403 in prod); needs `project_id` query param |
| C: `POST /api/mcp/capture-demo` | `app/api/mcp/capture-demo/route.ts` | L11–L31 | dev-only 403; `Array.isArray(body.insights)` |
| D: `bi_session` | `lib/mcp/session.ts` `sessionCookieOpts` | L10–L14 | httpOnly + sameSite + Secure (prod) |
| D: `bi_auth` | `lib/mcp/auth.ts` `withAuthCookies` | L86–L104 | AES-256-GCM; httpOnly + Secure + SameSite=None |
| E: MCP result | `lib/mcp/schema.ts` `unwrap` / `parseWorkspaceSchema` | L29–L36, L74–L125 | safe defaults for missing fields |
| E: MCP result (forwarded) | `lib/agents/base.ts` `runAgentLoop` truncate | L29–L34 | 16KB truncation cap on each tool result |
| F: model output (structured) | `lib/mcp/validate.ts` | L3–L57 | `parseAgentJson` + per-shape type guard |
| F: model output (natural lang) | `lib/agents/query.ts` `answer` | L46 | `finalText.trim()` only |
| G: `.auth-cache.json` | `.gitignore` | L33 | gitignored; comment at `lib/mcp/auth.ts` L26–L33 |
| G: dev caches | `lib/state/investigations.ts` `readJson` | L13–L20 | `JSON.parse` in try/catch |

**Use case 1 — a normal user investigates a live insight.** Surface B fires: the feed serializes the insight, hands it to `/api/agent?insightId=…&insight={…}`, the route validates the 4-field shape and calls the diagnostic agent. If validation fails (impossible from the feed; possible from a hand-crafted URL), the route falls through to the lookup; if the lookup misses too, it returns `404 'insight not found'`.

**Use case 2 — `/debug` calls a tool by name.** Surface C fires: the user types a tool name in the debug UI, the page POSTs `{name, args}` to `/api/mcp/call`, the route forwards it to MCP. No allowlist. This is the route used for introspection during development; it remains active in production.

**Use case 3 — Bloomreach returns a tool error.** Surface E fires: the MCP result has `isError: true` and a content string. `client.ts` `isRateLimited` checks for rate-limit patterns and retries; otherwise `runAgentLoop` formats it as a `tool_result` block with `is_error: true` and feeds it back to the model. The model sees the error text and reasons about it — but the error text is upstream-controlled, so this is the indirect-injection surface.

---

## Elaborate

### Where this audit comes from

Trust-boundary analysis predates web security as a discipline — it traces back to the **Bell-LaPadula model** (1973) for military information flow ("no read up, no write down"). The web-specific framing — "trust boundaries are where you re-check, because the side you're crossing from might have lied" — comes from the OWASP threat-modeling tradition and is encoded in the **STRIDE** mnemonic (Spoofing / Tampering / Repudiation / Info disclosure / Denial of service / Elevation of privilege).

The shift in the LLM era is that **two new surfaces appear that didn't exist in classic web apps**: model output (the LLM is an untrusted upstream you happen to be calling) and tool results (when the tools fetch text that the model will read, that text is *also* an untrusted upstream). Both are upstream-controlled but not directly user-controlled — a subtle distinction that classic threat models don't capture cleanly.

### The deeper principle

A trust boundary is **not** a line on a network diagram. It's a place in the code where you write `JSON.parse(x)` or `as Insight` or `result as T` — every cast and every parse is a trust boundary, because you just told the type system "I assume this shape." The audit finds them by grepping for those exact patterns and asking "what enforces the assumption?"

```
  what a trust boundary looks like in code

   any of these is a trust boundary:
   ─────
   JSON.parse(untrustedString)
   x as SomeType
   result as T
   schema.parse(x)        ← enforced (zod)
   isFooArray(x)           ← enforced (type guard)
   x?.field ?? default     ← partial enforcement (default on missing)
```

### Where it breaks down in this codebase

1. **`POST /api/mcp/call`** — the biggest gap. No body schema. No tool-name allowlist. Mitigated by upstream authz and read-only tool surface; would be a critical finding if either of those changed.
2. **`?q=` and `?insight=`** — no size cap. A 100KB `?insight=` URL would be parsed and handed to the diagnostic agent. Mitigated by Vercel's request-size limits and browser URL-length limits; would be a DoS-amplification finding in a different deployment shape.
3. **MCP tool results forwarded to model** — no content scanning. Indirect prompt injection lives here. Mitigated by Gate 3 + read-only tools; would be a critical finding if any tool were write-capable.

### What to read next

- File [02-authentication-and-authorization.md](./02-authentication-and-authorization.md) — the authn side (who you are) and the authz gap (anyone with the session is authorized).
- File [03-input-validation-and-injection.md](./03-input-validation-and-injection.md) — what each input could become if a sink existed.
- File [07-llm-and-agent-security.md](./07-llm-and-agent-security.md) — the LLM-specific surfaces in depth.

---

## Interview defense

**What they are really asking:** can you enumerate every untrusted input without missing one, and can you say what enforces (or doesn't enforce) each?

---

**[mid] — Walk me through every place untrusted input enters this app.**

Five surfaces. Query string — `?q=`, `?insightId=`, `?insight=`, `?diagnosis=` on the agent route. Request body — three POST routes: `/api/mcp/call`, `/api/mcp/reset`, `/api/mcp/capture-demo`. Cookies — `bi_session` and `bi_auth`. Upstream — MCP tool results from Bloomreach, model output from Anthropic. Filesystem — `.auth-cache.json`, `.investigation-cache.json`, and the committed `lib/state/demo-*.json` files (these last are dev-only and gitignored except the committed snapshots).

For each: cookies are crypto-validated (`bi_auth` AES-256-GCM) or random and httpOnly (`bi_session`). Query params have hand-rolled shape checks. POST bodies vary — `/api/mcp/capture-demo` checks `Array.isArray(insights)`, the others don't. Model output has the strongest enforcement: `parseAgentJson` + per-shape type guards + a `FALLBACK` if validation fails.

```
  surfaces vs enforcement

  cookies       crypto + httpOnly         strong
  query         hand-rolled shape check   partial
  body          mostly NONE on /call      WEAK ★
  upstream      validate.ts + guards      strong
  files         gitignore + dev-only      ok (in dev)
```

---

**[senior] — Show me a surface where the input isn't validated and explain why it's tolerable — or why it isn't.**

`POST /api/mcp/call` reads `{ name, args }` from the body and passes both directly to `conn.mcp.callTool(name, args ?? {}, { skipCache: true })`. No body schema, no tool-name allowlist. It's authenticated — you need `bi_session` plus valid OAuth tokens to hit it — and the upstream MCP server itself controls what tools exist. Plus every tool the agents are permitted to call is read-only by construction (`lib/mcp/tools.ts`).

So it's tolerable today *because* of two upstream facts: Bloomreach enforces authz on their side (the OAuth token is scoped to the user), and the tools we know about are read-only. It would become untenable the moment either changed: if Bloomreach added a write tool, this route would let a logged-in user (or a CSRF victim, since there's no CSRF token) call it; if the route ever gained an unauthenticated entry, the whole MCP surface would be exposed.

The structural fix is a one-line allowlist:

```
  if (!ALL_KNOWN_TOOLS.has(name)) return 403
```

It's a one-line gap. The audit notes it; the team can decide if /debug's introspection needs it more than safety does.

---

**[arch] — How do you think about indirect prompt injection here? It's the surface no input validator catches.**

Indirect prompt injection lives at Surface E — MCP tool results forwarded to the model as `tool_result` content. If Bloomreach data contains adversarial text (an event name, a customer property, a catalog description), the model reads it as part of its context window and might act on it. No input validation in our code catches this because the bytes never passed through *our* request handler.

The defense isn't at the input — it's at the *output* and the *tool surface*. Gate 3 (validate.ts) means a model that got injected into emitting a fake recommendation can't reshape the typed artifact. The read-only tool whitelist (`lib/mcp/tools.ts`) means even if the model fully complies with an injection, it has no write tool to abuse. The blast radius is data exfiltration via the natural-language answer in `QueryAgent.answer` — the only model output that isn't passed through a validator.

```
  indirect injection — where it enters, where it's contained

  enters at: tool_result content (Bloomreach data)
  contained by: read-only tool whitelist (lib/mcp/tools.ts)
                + validate.ts on every structured output
                + (gap) no validator on QueryAgent.answer text
```

The honest weakness: a sophisticated indirect injection that successfully steers the QueryAgent could exfiltrate any data the user's Bearer token can read, by encoding it into the answer text. The user reads the answer and possibly leaks it (screenshot, copy-paste). That's the residual risk after the structural defenses.

---

**The dodge — "do you have rate limiting on the entry points?"**

Honest answer: not in our code. The Anthropic SDK has its own rate-limiting at the API level. McpClient implements per-call spacing toward Bloomreach (`minIntervalMs: 1100`). But there's no rate limiter on `/api/briefing`, `/api/agent`, or `/api/mcp/call` at our edge — a hostile script could open dozens of NDJSON streams. The mitigation today is Vercel's per-function timeout (`maxDuration = 300` on the streaming routes) and Anthropic/Bloomreach billing as the cost firewall. That's accepted-risk territory, not enforced-defense.

---

**One-line anchors:**
- Five untrusted-input surfaces: query, body, cookies, upstream (MCP + Anthropic), files.
- Cookies and model output are the best-enforced; `POST /api/mcp/call` is the weakest.
- Indirect prompt injection enters at Surface E and is contained by tool-surface discipline, not by input validation.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, list all five (or six, depending how you count) surfaces with one example each. Then check against the **Implementation in codebase** table.

### Level 2 — Explain
Why does `resolveAnomaly` validate the `?insight=` shape and then fall through to a lookup on validation failure, instead of returning 400? Check `app/api/agent/route.ts` L37–L62.

### Level 3 — Apply
Imagine a new endpoint `POST /api/feedback` that takes `{ insightId, text, rating }` and stores it in memory for the briefing to surface. Which surface does it cross? What defenses does it inherit (cookies, MCP auth), and what new enforcement does it need (schema, length cap, anti-replay)?

### Level 4 — Defend
Defend the choice not to put a tool-name allowlist on `POST /api/mcp/call`. When is that the right call? Under what condition does it become wrong? What's the one-line fix when the condition trips?

### Quick check
- Which surface has the strongest enforcement? → Surface F (model output → typed value) via `lib/mcp/validate.ts` + per-agent FALLBACK.
- Which surface has the weakest enforcement? → Surface C, `POST /api/mcp/call` — auth only.
- What's the only natural-language model output that isn't passed through a validator? → `QueryAgent.answer` return, `lib/agents/query.ts` L46.
- What protects the OAuth tokens at rest in production? → AES-256-GCM under `AUTH_SECRET`, `lib/mcp/auth.ts` L51–L79.

---

## See also

→ [00-overview.md](./00-overview.md) · [02-authentication-and-authorization.md](./02-authentication-and-authorization.md) · [03-input-validation-and-injection.md](./03-input-validation-and-injection.md) · [07-llm-and-agent-security.md](./07-llm-and-agent-security.md)
