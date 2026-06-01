# Data exposure and privacy

**Industry name(s):** sensitive data exposure, error verbosity, over-fetching, info disclosure, log hygiene
**Type:** Industry standard · Language-agnostic

> The app **doesn't store any user data** — no database, no per-user persistence, every briefing is a fresh fetch from Bloomreach and every investigation is held in memory per session. That's the strongest privacy property the codebase has. The real exposure surfaces are: (1) verbose error responses that leak file paths and library versions (`e.stack` in four routes), (2) tool-result trace data sent over the NDJSON stream — including the full Bloomreach response truncated to 4KB — which puts customer-level data on the wire to the browser, (3) `console.error` logging of the full error object including `cause`, which could echo upstream-returned token snippets to Vercel logs, and (4) the `?insight=` URL parameter serializes the full insight JSON into the URL bar, which means it lands in browser history and any HTTP referrer.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Data exposure is the question of "what does each response actually contain, and is any of it more than the caller is entitled to?" In an app with no database, the surfaces are: API responses (the NDJSON stream + JSON responses), error messages (visible to the caller and in logs), and URL parameters (visible in history, referrer headers, and any logging proxy). The audit checks each one.

```
  Zoom out — where data leaves the system

  ┌─ Inputs (data comes in) ───────────────────────┐
  │  MCP tool results (Bloomreach customer data)   │
  │  Anthropic model output                         │
  │  cookies (the user's own)                       │
  └────────────────────────┬───────────────────────┘
                           │
  ┌─ Routes / Agents ─────▼────────────────────────┐
  │  process, store in memory per session           │
  └────────────────────────┬───────────────────────┘
                           │
  ┌─ Outputs (data goes out) ──────────────────────┐  ← we are here
  │  NDJSON stream to browser                       │
  │  JSON error responses                           │
  │  URL parameters (?insight=, ?diagnosis=)        │
  │  console.error → Vercel logs                    │
  └────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question for each output: *who is supposed to see this, what does it actually contain, and what would a hostile party do with the difference?* The interesting findings here are at the output surfaces, not at the storage layer (which doesn't exist).

---

## Structure pass

**Layers.** Four output surfaces. **Streaming responses** (NDJSON to the browser). **Error responses** (JSON returned on failure). **URL parameters** (data the client encoded into the URL). **Logs** (`console.error` to Vercel).

**Axis: trust.** Hold one question constant: *what's the maximum trust level of the recipient, and is what we're sending appropriate for that level?* The browser is *the user's own browser* — sending it the user's own Bloomreach data is fine. But the same NDJSON event line gets stored in browser history (URL form), echoed in any proxy logs (TLS doesn't help if a corporate proxy MITMs), and may be screenshot/shared. So "the user is the recipient" doesn't end the question.

**Seams.** Two load-bearing seams. **Seam 1 (in-process → response)** is where every piece of data crosses out of trusted-by-construction memory into a byte stream a third party might see. **Seam 2 (in-process → logs)** is where data crosses into operator-readable storage that may be retained for months. Both are worth a per-surface walk.

```
  Structure pass — exposure surfaces

  ┌─ 1. LAYERS ───────────────────────────────────────┐
  │  streaming responses (NDJSON events)               │
  │  error responses (JSON)                            │
  │  URL parameters (?insight=, ?diagnosis=)           │
  │  logs (console.error → Vercel)                     │
  └────────────────────────┬──────────────────────────┘
                           │  hold the trust question
  ┌─ 2. AXIS ─────────────▼───────────────────────────┐
  │  trust: who sees this, and what's appropriate?     │
  └────────────────────────┬──────────────────────────┘
                           │  trace, find what's over-shared
  ┌─ 3. SEAMS ────────────▼───────────────────────────┐
  │  in-process → response   LOAD-BEARING              │
  │      tool result trace (4KB truncated)             │
  │      error stack (4 routes)                        │
  │  in-process → logs       LOAD-BEARING              │
  │      console.error with full err.cause             │
  │      no token redaction                            │
  └────────────────────────┬──────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped. Next we walk each surface.

---

## How it works

### Move 1 — the mental model

A response leaks if it contains more than the caller needs, or if it contains internal details the caller could weaponize. "More than needed" is the privacy axis (PII, business data). "Internal details" is the info-disclosure axis (stack traces, version strings, file paths, internal IDs).

```
  Two failure modes — one for each axis

  privacy leak                          info disclosure
  ─────                                 ─────
  caller sees customer X's data         caller sees /Users/rein/... in stack
  caller sees ALL recommendations       caller sees lib/agents/diagnostic.ts L93
  caller sees the prior diagnosis        caller sees Anthropic SDK version
   for an unrelated insight
```

Both are findings, but the severity profiles differ — privacy leaks are user-facing, info disclosure is attacker-facing.

### Move 2 — walk each surface

#### Surface A — NDJSON streaming responses

`/api/briefing` and `/api/agent` stream `BriefingEvent` / `AgentEvent` lines as the agents work. The event types include `tool_call_start`, `tool_call_end` (with `result` field), `reasoning_step`, `diagnosis`, `recommendation`, and `insight`.

```
  NDJSON event — what each carries

  reasoning_step       { agent, kind, content }
                       content is model-emitted text (per-step thought)

  tool_call_start      { toolName, agent }
                       safe — just the tool name

  tool_call_end        { toolName, agent, durationMs, result, error? }
                       result is the FULL tool result, truncated to 4KB
                       ↑ this is the data-on-the-wire surface

  diagnosis            { conclusion, evidence, hypothesesConsidered,
                         affectedCustomers?, timeSeries? }

  recommendation       { id, title, rationale, ..., estimatedImpact, ... }

  insight              { id, headline, summary, evidence, impact, ... }
```

The load-bearing question is what `result` in `tool_call_end` actually contains. Looking at the route code:

```
  briefing route.ts L228–L236:
    onToolResult: (tc) =>
      send({
        type: 'tool_call_end',
        toolName: tc.toolName,
        ...
        result: trunc(tc.result),   ← TRUNCATED but otherwise raw
        error: tc.error,
      })

  trunc() — L70–L73:
    const s = JSON.stringify(v)
    return s && s.length > 4000 ? s.slice(0, 4000) + '…' : v
```

So the raw Bloomreach tool result — which for `execute_analytics_eql` includes aggregate event counts, for `list_customers` would include customer details — is JSON-stringified, truncated at 4KB, and sent to the browser as part of the trace. This is intentional: it powers the "how it was gathered" UI panel showing the user what the agent did. But it means *every byte of the tool result up to 4KB is now in the browser's response body*, and will land in:

- The browser's network DevTools (visible to the user).
- Any HTTP recording extension (visible to whoever installed it).
- Browser cache (if the route weren't `no-store`; in this case `cache-control: no-store, no-transform` mitigates).
- Any TLS-MITM corporate proxy (visible to network admins).

**Risk:** the user IS authorized to see this data — they queried it from their own Bloomreach. So the "leak" is really "data the user is entitled to see appears in their own browser." That's not a privacy violation; it's the normal product flow. The risk that *is* present: if the user screenshots or shares the trace UI, embedded customer-level data might be over-shared inadvertently.

**No mitigation in place:** there's no field-level redaction in `trunc`. A `list_customers` call's result with names and emails would be sent verbatim (up to 4KB) to the browser. The current agent whitelists don't aggressively use `list_customers` (it's in `diagnosticTools` but the prompt steers toward `execute_analytics_eql`), but the surface is there.

#### Surface B — JSON error responses

Four routes return `e.stack` in their JSON error responses (named in file 04). The stack trace contains:
- Function names from our code (`runAgentLoop`, `connectMcp`, etc.).
- File paths absolute on the deploy machine (e.g. `/var/task/.next/server/app/api/agent/route.js`).
- Library entry points (Anthropic SDK, MCP SDK function names).
- Sometimes line numbers and column positions.

```
  Error response with stack trace — example shape

  HTTP 500
  Content-Type: application/json
  {
    "error": "no PKCE code_verifier stored for this session\n
      Error: no PKCE code_verifier stored for this session
        at BloomreachAuthProvider.codeVerifier (lib/mcp/auth.ts:215:36)
        at finishAuth (...)
        at /var/task/.next/server/app/api/mcp/callback/route.js:..."
  }
```

**Risk:** information disclosure. An attacker probing the API gets the framework's internal layout for free. Severity: low; in a multi-tenant system or one with known-vulnerable library versions, the leak might tell an attacker which exploit to try.

The streaming routes already use the safer pattern (`e.message` only, no `e.stack`). The four `/api/mcp/*` routes are inconsistent. Fix: strip `e.stack` from those responses.

#### Surface C — URL parameters

The investigate flow serializes the *full insight* into `?insight=...` so it survives Vercel's per-instance memory wipe. That URL is visible in:
- Browser history.
- Browser URL bar (visible to anyone who looks over the user's shoulder).
- HTTP referrer headers when the user clicks any external link from that page (mitigated by `Referrer-Policy` headers — audit didn't verify these are set).
- Vercel access logs (Vercel logs request URLs by default; query strings included).

```
  ?insight= flow — what it carries

  the page builds:
    const insight = { id, headline, evidence, change, scope, severity, … }
    const url = `?insightId=${id}&insight=${encodeURIComponent(JSON.stringify(insight))}`

  the URL becomes:
    /investigate?insightId=abc-123&insight=%7B%22headline%22%3A%22mobile%20…

  what lands in browser history:
    the entire insight JSON, URL-encoded, in the address bar
```

**Risk:** the insight content contains the user's *own* Bloomreach data (metric name, percentage change, evidence values). Same framing as Surface A — the user is authorized to see it; the concern is *secondary* exposure (history, referrer, server logs). Mitigation: a hash-based URL fragment (`#insight=…`) would keep the data out of server logs but stays in history. A POST + sessionStorage handoff (which the comment says is partially used) would keep it fully client-side.

#### Surface D — logs (`console.error` to Vercel)

Errors caught at the top level of each streaming route are logged with the full error object:

```
  /api/agent route.ts L160, L256:
    console.error('[agent] setup error:', e)   ← logs full error including cause
    console.error('[agent] error:', e)

  /api/briefing route.ts L166, L248:
    console.error('[briefing] setup error:', e)
    console.error('[briefing] error:', e)
```

Errors thrown by `McpClient.liveCall` are wrapped in `McpToolError` with `{ cause: err }`. The cause chain may include the captured HTTP error body (`lib/mcp/transport.ts` makes a capturing fetch that records up to 2000 chars of the non-OK response body):

```
  what an HTTP-error log entry looks like (worst case)

  McpToolError: list_customers → HTTP 401: { "error": "invalid_token",
    "error_description": "The access token provided is expired, revoked,
    malformed, or invalid for other reasons. Token: eyJhbGciOi..."
  }
   at SdkTransport.callTool (lib/mcp/transport.ts:53:13)
   ...
```

**Risk:** if Bloomreach's error response echoes a snippet of the token (some IdPs do, for debugging), that snippet lands in Vercel logs. Vercel logs are retained per their plan terms; access is via Vercel's dashboard (operator-only). Severity: medium if echoed tokens are full-length and reusable; low if echoed tokens are truncated or already invalidated.

**No mitigation in place:** there's no token-redacting filter in the log layer. The audit can't verify what Bloomreach's 401 body actually contains without testing live; if it includes the token, the codebase has no defense against logging it.

### Move 3 — the principle

**Data exposure is everywhere the data leaves the process — not just the API response.** Logs, URLs, error responses, and the "trace" panel of a streaming UI are all exposure surfaces. The audit's job is to enumerate each one and ask "does the recipient need *this much* data?" When the answer is "no, but the surface is the same one that legitimately sends data," the fix is field-level redaction at the boundary, not blanket suppression.

---

## Primary diagram

Every output surface, with the data each carries and the visibility profile.

```
  Output surfaces — what leaves the server

  ┌─ Surface A: NDJSON stream ───────────────────────────────────────┐
  │                                                                    │
  │  /api/briefing , /api/agent                                       │
  │  event types: tool_call_start, tool_call_end, reasoning_step,     │
  │               diagnosis, recommendation, insight, done, error     │
  │                                                                    │
  │  tool_call_end.result = trunc(toolResult, 4000)                   │
  │   ↑ full Bloomreach response up to 4KB, includes business data    │
  │                                                                    │
  │  visibility: browser DevTools, network extensions, MITM proxies    │
  │  authorization: user IS the recipient; secondary sharing is the    │
  │                 residual risk                                      │
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ Surface B: JSON error responses ────────────────────────────────┐
  │                                                                    │
  │  /api/mcp/call    L17–L20    e.message + e.stack  ★ leaks paths   │
  │  /api/mcp/tools   L18–L22    e.message + e.stack  ★ leaks paths   │
  │  /api/mcp/tools/check L21–L25 e.message + e.stack ★ leaks paths   │
  │  /api/mcp/capture L54–L57    e.message + e.stack  (dev-only)      │
  │  /api/agent       L161, L257 e.message ONLY        safe            │
  │  /api/briefing    L167, L249 e.message ONLY        safe            │
  │                                                                    │
  │  visibility: caller; severity: info disclosure, low                │
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ Surface C: URL parameters ──────────────────────────────────────┐
  │                                                                    │
  │  /investigate?insightId=…&insight={…full json…}                   │
  │  /investigate?diagnosis={…full json…}                             │
  │                                                                    │
  │  visibility: browser history, address bar, Vercel access logs,    │
  │              referrer headers on external link clicks              │
  │  authorization: user IS the recipient; persistence is the risk     │
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ Surface D: logs (Vercel) ───────────────────────────────────────┐
  │                                                                    │
  │  console.error('[agent] error:', e)    ← full error w/ cause      │
  │  console.error('[briefing] error:', e)                            │
  │                                                                    │
  │  worst case: Bloomreach 401 body echoes token snippet → in logs   │
  │  visibility: Vercel operators; severity: medium IF echo occurs    │
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘
```

The diagram makes one finding visible: every surface has a recipient who is *entitled* to the data, but the *secondary* exposure (history, logs, screenshots) is where the leak risk lives. Surface B (stack traces) is the only one where the data isn't entitled at all.

---

## Implementation in codebase

| Surface | File · Location | Lines | What's exposed |
|---|---|---|---|
| A: NDJSON stream | `app/api/briefing/route.ts` `trunc` + send | L70–L73, L228–L236 | Tool result JSON, truncated 4KB |
| A: NDJSON stream | `app/api/agent/route.ts` `trunc` + send | L100–L103, L185–L194 | Same; also reasoning text streams |
| A: tool-call truncation | `lib/agents/base.ts` `truncate` | L29–L34 | Inside the agent loop, 16KB cap on tool result before sending to model |
| B: stack-leak (live) | `app/api/mcp/call/route.ts` | L17–L20 | `e.message + e.stack` |
| B: stack-leak (live) | `app/api/mcp/tools/route.ts` | L18–L22 | `e.message + e.stack` |
| B: stack-leak (live) | `app/api/mcp/tools/check/route.ts` | L21–L25 | `e.message + e.stack` |
| B: stack-leak (dev-only) | `app/api/mcp/capture/route.ts` | L54–L57 | `e.message + e.stack` (gated dev-only) |
| B: safe pattern | `app/api/agent/route.ts` | L161–L164, L257–L259 | `e.message` only |
| B: safe pattern | `app/api/briefing/route.ts` | L167–L170, L249–L252 | `e.message` only |
| C: URL serialization | `app/api/agent/route.ts` `resolveAnomaly` (consumer) | L37–L46 | The `?insight=` param is parsed back into a full Insight |
| D: log full error | `app/api/agent/route.ts` | L160, L256 | `console.error('[agent] error:', e)` |
| D: log full error | `app/api/briefing/route.ts` | L166, L248 | `console.error('[briefing] error:', e)` |
| D: error body capture | `lib/mcp/transport.ts` `makeCapturingFetch` | L19, L24–L36 | Captures up to 2000 chars of non-OK HTTP body into thrown error |
| Cache headers | `app/api/briefing/route.ts` response headers | L146–L149, L260–L264 | `cache-control: no-store, no-transform` — prevents intermediate cache |
| Cache headers | `app/api/agent/route.ts` `NDJSON_HEADERS` | L107–L110 | `Cache-Control: no-cache, no-transform` |

**Use case 1 — user runs a briefing and shares a screenshot.** The user sees the briefing UI with the trace panel showing "Bloomreach returned 18,234 purchase events in last 90 days." They screenshot it for a colleague. Now the colleague (who may not have Bloomreach access for that workspace) sees the data. The codebase didn't leak — the user did. Mitigation: a per-deployment policy decision on whether to show the trace at all; the codebase exposes it because the audit-trail UX is intentional.

**Use case 2 — `/api/mcp/call` throws.** The user hits the debug page, triggers a tool call, the tool errors. The route returns 500 with `e.message + '\n' + e.stack`. The JSON response in the browser shows the full path `/var/task/...`. Info disclosure. Severity: low.

**Use case 3 — token-echoing 401.** The user's Bloomreach token expires. `McpClient.callTool` → `SdkTransport.callTool` throws an `HTTP 401: {echoed body}`. The catch in the route logs `console.error('[agent] error:', e)`. If Bloomreach's 401 body includes the token, the token lands in Vercel logs. The audit can't verify Bloomreach's actual 401 behavior without a live failing call.

---

## Elaborate

### Where this discipline comes from

**OWASP Top 10: Sensitive Data Exposure** has been a top-10 category since the first edition (2003). The discipline evolved from "encrypt sensitive data" (early) to "minimize what's stored AND minimize what's returned in any response" (current). The audit's framing — *every output is a potential leak surface* — is the current best practice.

**Verbose error responses** (CWE-209) is the canonical info-disclosure pattern. The fix is environment-aware error formatting: prod returns a generic message + an opaque error ID, dev returns the full stack. This codebase is partially there (the streaming routes do the right thing; the `/api/mcp/*` routes don't).

### The deeper principle

**Data minimization** as a discipline: ask "what's the smallest amount of data this caller needs?" not "what's available to send?" Every response is built from the latter; data minimization is the deliberate trim from "what we could send" to "what they need."

```
  Default vs minimization

  default:        construct response as { ...everything we have }
  minimized:      construct response as { fields the UI explicitly needs }

  default is fast; minimization is safe.
```

This codebase is *partially* minimized at the agent output (the validators reshape model output into typed shapes, dropping anything extra) and *not* minimized at the trace surface (raw tool results stream out). The fix at the trace surface would be a per-tool redaction list — `list_customers` results should drop email/PII fields before truncation.

### Where it breaks down in this codebase

1. **Stack traces in 4 error responses** — file 04 named this. Same finding here from the privacy angle. One-line fix per route.

2. **Tool-result trace streaming** — by design. The "how it was gathered" panel is the product. The honest acknowledgement: business data sits in the response body. If the deployment is single-user (the user reading their own data) this is fine; if multi-user, the trace surface needs per-field redaction.

3. **Full insight in URL** — the comment in `/api/agent` calls this out explicitly ("the only source that survives Vercel's per-instance memory") as a deliberate choice. The leak path (history, referrer, server logs) is real but mitigated by the data being the user's own. Worth a `Referrer-Policy: no-referrer` HTTP header on `/investigate` to close the cross-origin referrer leak.

4. **Token-echoing in logs** — depends on Bloomreach's 401 body. The fix is a regex-based redaction layer in the error path that strips JWT-shaped strings before `console.error`. Not present.

5. **No log retention awareness** — `console.error` writes to Vercel's log retention (default 30 days on Pro). Whatever's in there is in there. A future-state move would be a structured logger with explicit field redaction, sending only sanitized events.

### What to read next

- File [04-secrets-and-configuration.md](./04-secrets-and-configuration.md) — overlaps on the stack-trace finding from the secret-management angle.
- File [07-llm-and-agent-security.md](./07-llm-and-agent-security.md) — the model output's exfiltration path through the answer text.
- File [08-security-red-flags-audit.md](./08-security-red-flags-audit.md) — every exposure finding consolidated.

---

## Interview defense

**What they are really asking:** can you name everywhere data leaves the process — not just the API responses — and can you say which leaks matter?

---

**[mid] — Where does data leave this app, and what's in each surface?**

Four places. The NDJSON streaming response — every tool call's result is truncated to 4KB and sent to the browser as part of the trace; this contains the user's own Bloomreach data. The JSON error responses — four routes return `e.stack`, which leaks file paths and library internals. The URL parameters — `?insight=` carries the full insight JSON, which lands in browser history and any HTTP referrer. The Vercel logs — `console.error` with the full error object, which could include a Bloomreach 401 body that echoes the token.

The first surface is intentional (the trace UI). The second and fourth are accidental — one-line fixes per route to strip stack and add token redaction. The third is a tradeoff (serverless memory wipe forced the choice).

```
  four surfaces · which are findings

  NDJSON stream    intentional; risk = secondary sharing
  error stack      ★ FIX: remove e.stack from 4 routes
  ?insight= URL    accepted-risk by design; add Referrer-Policy
  console.error    ★ FIX: token redaction in error path
```

---

**[senior] — Why do you stream the raw tool results to the browser? Isn't that an exposure?**

It's the audit-trail UX. The user wants to see "what did the agent actually query?" so we surface every tool call name + its result. Without the trace, the briefing is "trust me, here are the insights" — with the trace, it's "the agent ran `select count event purchase in last 90 days`, got back `{ current: 18234, prior: 21500 }`, decided that's an 18% drop." The trace is the credibility argument.

The exposure framing: the user IS the recipient and IS authorized to see their own Bloomreach data. The risk is *secondary* — screenshot, share, paste somewhere. The codebase doesn't enforce against that because it can't (the user owns their own screen). What it CAN do, and doesn't, is per-tool redaction: `list_customers` results should drop PII fields before they hit the trace, because the trace UX doesn't need the names — it just needs the count and the sample. That's a future-state move; today the trace ships raw + truncated.

---

**[arch] — What about the stack traces in error responses?**

Four routes — `/api/mcp/call`, `/api/mcp/tools`, `/api/mcp/tools/check`, and the dev-only `/api/mcp/capture` — include `e.stack` in their JSON error response. That leaks file paths, internal function names, and library entry points. An attacker probing the API learns the framework layout for free.

The streaming routes (`/api/agent`, `/api/briefing`) already use the safer pattern: `e.message` only, with the full error logged via `console.error` for the operator. The inconsistency is the finding. Fix: change the four `/api/mcp/*` routes to `e.message` only.

Severity is low — info disclosure isn't itself an exploit — but it's a free win for an attacker doing recon. And the inconsistency suggests "we know how to do this right, we just didn't do it everywhere," which is the easiest kind of finding to close.

---

**The dodge — "do you have any PII in this app?"**

The app itself stores no PII. There's no user account, no profile, no `users` table. The PII that flows through is the *Bloomreach customer data* — names, emails, event histories — that flows through the agent's tool calls and gets aggregated into anomaly counts and diagnosis evidence. None of it is *stored* by us; it's read, aggregated, and forwarded into the typed agent output (which uses counts and percentages, not raw PII).

The exposure: the trace surface streams raw tool results, which for `list_customers`-shaped tools would include PII. Today the agents are steered toward `execute_analytics_eql` (aggregate queries, no PII) but the surface is there. The honest answer is "no PII at rest; PII in transit through the trace surface for certain tool types."

---

**One-line anchors:**
- No database, no PII at rest — the strongest privacy property of the codebase.
- The NDJSON trace surface is the intentional exposure; per-tool redaction would close it.
- Four routes leak stack traces — one-line fix per route.
- Token-echo in Vercel logs is the unknown; needs a redaction layer if Bloomreach actually echoes tokens.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, list the four output surfaces with one example each. Then check against the **Primary diagram**.

### Level 2 — Explain
Why does the agent loop have a 16KB truncation cap on tool results sent to the model (`lib/agents/base.ts` L29–L34) AND a 4KB truncation cap on tool results sent to the browser via the trace (`/api/briefing` `trunc`, L70–L73)? What are the two caps for, and why are they different sizes?

### Level 3 — Apply
A new requirement: render Bloomreach `list_customers` results in the briefing's "affected customers" panel. Walk through what data lands where: the agent loop, the typed Anomaly/Diagnosis shape, the NDJSON trace, the UI. Where would you add a PII-redaction step, and what would it strip?

### Level 4 — Defend
A teammate proposes adding a `?debug=1` query param that returns the full stack trace on every error in every route, "to make production issues easier to triage." Defend or refute. (Hint: consider what would unauthenticated-vs-authenticated `?debug=1` access do, and whether an attacker who finds the flag gets the same value the operator does.)

### Quick check
- Where does the NDJSON stream's `tool_call_end.result` come from? → `lib/agents/base.ts` `runAgentLoop` collects the result, the route's `onToolResult` hook truncates and sends.
- Which routes leak stack traces? → `/api/mcp/call`, `/api/mcp/tools`, `/api/mcp/tools/check`, `/api/mcp/capture`.
- Which env var controls page-title display? → `NEXT_PUBLIC_APP_NAME` (`app/layout.tsx` L10).
- What's stored about a user between sessions? → Nothing (no database, no per-user files).

---

## See also

→ [00-overview.md](./00-overview.md) · [01-trust-boundaries-and-attack-surface.md](./01-trust-boundaries-and-attack-surface.md) · [04-secrets-and-configuration.md](./04-secrets-and-configuration.md) · [07-llm-and-agent-security.md](./07-llm-and-agent-security.md) · [08-security-red-flags-audit.md](./08-security-red-flags-audit.md)
