# Security red-flags audit

**Industry name(s):** security checklist, red-team triage, vulnerability ledger, findings register
**Type:** Industry standard · Project-specific

> The capstone file. Every meaningful finding from files 01–07 distilled into a single triaged ledger: **fires** (real, exploitable today), **doesn't fire** (the structural reason it's safe), or **N/A** (the concept doesn't apply to this codebase). Each row carries severity, location, and a one-line fix. The three highest-severity findings the audit surfaces: (H1) `POST /api/mcp/call` accepts any tool name with no allowlist, (H2) four routes leak `e.stack` in error responses, (H3) `AUTH_SECRET` has no strength enforcement and no graceful rotation path. None are critical against the current threat model; all are real and one-line-fixable.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The previous seven files each walked one boundary or concern at full depth. This file collapses them into a single decision table: for every red flag in the standard security catechism, does it fire here, with what severity, and what's the one-line fix? The goal is "open this file at code-review time and read every row."

```
  Zoom out — how the previous files feed this one

  ┌─ file 01 trust boundaries ───┐
  │  surfaces · enforcement gaps  │
  └────────────────┬──────────────┘
                   │
  ┌─ file 02 authn/authz ────────┐
  │  cookie + CSRF + per-route    │
  └────────────────┬──────────────┘
                   │
  ┌─ file 03 input validation ───┐
  │  sinks + injection            │
  └────────────────┬──────────────┘
                   │       ▼
  ┌─ files 04–07 ────────────────┐    ┌─ this file ─────────────────┐
  │  secrets · data exposure ·    │ ──▶│  consolidated checklist     │
  │  deps · LLM/agent             │    │  fires / doesn't / N/A      │
  └───────────────────────────────┘    │  severity · location · fix  │
                                       └─────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is just "what do I do with this list?" Read it. For each row, decide if you're shipping with the gap (accept), patching now (fix), or patching later (queue). The audit doesn't decide; the team does. The audit's job is to make sure no row goes unread.

---

## Structure pass

**Layers.** The findings group naturally by boundary — entry-point, authn/authz, secrets, exposure, deps, LLM. The checklist below preserves that grouping so a fix campaign can attack one boundary at a time.

**Axis: severity.** Hold one question constant: *what's the realistic damage if this fires today, and how much does the damage scale with deployment size?* A finding that's low-severity for a single-user demo can be critical for a multi-tenant SaaS. The severity column accounts for that.

**Seams.** No new seams to map — the checklist consumes the seams from the previous files. The structure here is purely operational: row-by-row triage.

---

## How it works

### Move 1 — the severity rubric

Every row carries a severity. The rubric:

```
  severity   means                                          example here
  ─────      ─────                                          ─────
  critical   exploitable today, high damage, blocks ship    (none)
  high       exploitable today, moderate damage,             POST /api/mcp/call
             one-line fix exists                             open tool surface
  medium     exploitable today, low damage, OR               error stack traces
             not exploitable today but easily becomes        CSRF on /reset
             critical with one architectural change
  low        info disclosure / hardening gap                 no audit gate in CI
  accepted   known gap; explicitly accepted by the           dev .auth-cache.json
             current threat model                            (gitignored)
  N/A        the concept doesn't apply (no DB, no shell,     SQL injection
             etc.)                                           shell injection
```

### Move 2 — the checklist (the load-bearing part of the file)

#### Section A — Entry points & input validation

| # | Red flag | Status | Severity | Location | One-line fix |
|---|---|---|---|---|---|
| A1 | SQL injection | N/A | — | No database in codebase | — |
| A2 | Shell / command injection | N/A | — | No `child_process` / `exec` usage | — |
| A3 | Path traversal from user input | N/A | — | All file paths hardcoded; user-controllable `project_id` passed as MCP arg, not interpolated into path | — |
| A4 | SSRF (server-side request forgery) | N/A | — | MCP URL from `process.env.BLOOMREACH_MCP_URL`; no user-provided URL fetched | — |
| A5 | XSS via direct DOM injection | doesn't fire | — | React auto-escapes; no `dangerouslySetInnerHTML` confirmed in main paths | — |
| A6 | XSS via markdown rendering | doesn't fire (today) | — | No markdown renderer on `QueryAgent.answer` path | Future-risk: gate any markdown addition on adding link-domain allowlist |
| A7 | `POST /api/mcp/call` accepts any tool name | **fires** | **high** | `app/api/mcp/call/route.ts` L8–L13 | Add tool-name allowlist: `if (!ALL_KNOWN.has(name)) return 403` |
| A8 | No length cap on `?q=` query string | fires | low | `app/api/agent/route.ts` L115 | Add `if (q && q.length > 1000) return 400` |
| A9 | No length cap on `?insight=` query | fires | low | `app/api/agent/route.ts` L114 | Add length-check on `insightParam` before `JSON.parse` |
| A10 | Hand-rolled schema check on `?insight=` (4 fields) | accepted | — | `resolveAnomaly` falls through to lookup on validation failure (`app/api/agent/route.ts` L37–L46) | Could use zod for richer validation; current is sufficient |
| A11 | Prompt injection via `?q=` | accepted | — | `lib/agents/query.ts` L35 (`userPrompt: query`) | Bounded by read-only tool whitelist + Gate 3; structural defense is the right one |
| A12 | Indirect prompt injection via MCP tool results | accepted | — | `lib/agents/base.ts` L144–L156 (raw forward to model) | Bounded by same defenses; per-tool result shaping is the next-mile move |

#### Section B — Authentication & authorization

| # | Red flag | Status | Severity | Location | One-line fix |
|---|---|---|---|---|---|
| B1 | OAuth + PKCE + DCR flow | doesn't fire | — | `lib/mcp/auth.ts` + `lib/mcp/connect.ts`; canonical treatment in `study-system-design-dsa/01-system-design/02-oauth-boundary.md` | — |
| B2 | `bi_session` cookie hardening | doesn't fire | — | `lib/mcp/session.ts` L10–L14; httpOnly + sameSite + Secure in prod | — |
| B3 | `bi_auth` cookie encrypted at rest | doesn't fire | — | `lib/mcp/auth.ts` L51–L104; AES-256-GCM under `AUTH_SECRET` | — |
| B4 | CSRF on `POST /api/mcp/reset` | **fires** | medium | `app/api/mcp/reset/route.ts` L10–L15; no CSRF token, sameSite=None | Add Origin allowlist or CSRF token; or `sameSite=Lax` on POST routes |
| B5 | GETs with side effects: `/api/briefing`, `/api/agent` | fires | medium | Both spend Anthropic tokens; no Origin check | Add `Origin` header check or convert to POST + CSRF nonce |
| B6 | No CSRF on `POST /api/mcp/call` | fires | high (= A7 root cause) | Same as A7; CSRF + open tool surface compound | A7 fix subsumes (allowlist defangs the attack) |
| B7 | No second factor on long-lived session | accepted | — | 10-day cookie lifetime, no MFA | Out of scope for demo; would block production B2B SaaS |
| B8 | OAuth `state` CSRF re-check disabled in callback | accepted | — | `app/api/mcp/callback/route.ts` L22–L26 comment; SDK does its own state handling | Implement a multi-state tracker if SDK ever changes behavior |
| B9 | No per-route role gates | accepted | — | All routes share `connectMcp` check | Appropriate for single-tenant; would need accounts model to add |
| B10 | `bi_session` accepts existing values (no fixation guard) | doesn't fire | — | `getOrCreateSessionId` creates a UUID but reuses existing cookie — no pre-set vector because we always read, never accept a "promoted" anonymous session | — |

#### Section C — Secrets & configuration

| # | Red flag | Status | Severity | Location | One-line fix |
|---|---|---|---|---|---|
| C1 | Secrets in repo | doesn't fire | — | `.env*` gitignored; `.env.example` blank values; no secret found in committed files | Run `git log -p \| grep -iE 'sk-ant-\|AUTH_SECRET='` to verify history |
| C2 | Secrets in client bundle | doesn't fire | — | Only `NEXT_PUBLIC_*` is `NEXT_PUBLIC_APP_NAME` (display title) and `NEXT_PUBLIC_DEMO_ONLY` (boolean flag) | — |
| C3 | `AUTH_SECRET` strength enforcement | **fires** | medium | `lib/mcp/auth.ts` L51–L60; any non-empty string accepted | Add `if (secret.length < 32) throw …` to `aesKey` |
| C4 | `AUTH_SECRET` graceful rotation | **fires** | medium | `lib/mcp/auth.ts` L51–L79; rotation invalidates all sessions | Key-version byte prefix + `AUTH_SECRET_OLD` env var |
| C5 | Plaintext OAuth tokens in `.auth-cache.json` (dev) | accepted | — | `lib/mcp/auth.ts` L26–L33 (commented as accepted) | Out of scope (dev only; gitignored) |
| C6 | Error responses leak `e.stack` | **fires** | medium | `/api/mcp/call` L17–L20, `/api/mcp/tools` L18–L22, `/api/mcp/tools/check` L21–L25 | Remove `'\n' + (e.stack ?? '')` from those three (+ dev-only `/api/mcp/capture` L54–L57) |
| C7 | Vercel logs may echo OAuth tokens | fires (conditional) | medium | `app/api/agent/route.ts` L160, L256 + `lib/mcp/transport.ts` capturing fetch | Token-redaction regex in error path before `console.error` |
| C8 | No env-var presence check at startup | fires | low | `ANTHROPIC_API_KEY` checked per-request (`/api/agent` L149); `AUTH_SECRET` checked lazily | Startup script that validates all required env vars |
| C9 | `BLOOMREACH_MCP_URL` is unauthenticated env override | accepted | — | `lib/mcp/connect.ts` L25–L29; falls back to a hardcoded URL | Production deploys set the real URL; default is harmless |

#### Section D — Data exposure & privacy

| # | Red flag | Status | Severity | Location | One-line fix |
|---|---|---|---|---|---|
| D1 | No PII at rest | doesn't fire (✓) | — | No database; everything in-memory per request | — |
| D2 | NDJSON trace streams raw tool results | accepted (by design) | — | `app/api/briefing/route.ts` L70–L73 (4KB truncation); `app/api/agent/route.ts` L100–L103 | Per-tool result shaping is the next-mile move |
| D3 | `?insight=` lands in browser history + Vercel access logs | accepted | low | `app/api/agent/route.ts` L37–L46 (consumes the param); comment explains the choice | Add `Referrer-Policy: no-referrer` to `/investigate` |
| D4 | Error responses include stack | (= C6) | (= C6) | (= C6) | (= C6) |
| D5 | Full error logged with cause chain | fires | low–medium | `console.error('[agent] error:', e)` etc. | Structured logger with explicit field redaction |
| D6 | `list_customers` capability latent in agent | fires | medium | `lib/mcp/tools.ts` L15–L25 (`diagnosticTools`) | Either remove from whitelist or add per-tool PII-stripping middleware |
| D7 | Cache headers on streaming routes | doesn't fire | — | Both set `cache-control: no-store/no-cache, no-transform` | — |
| D8 | Trace data persisted in `.investigation-cache.json` | accepted | — | Dev-only; gitignored | Out of scope (dev only) |

#### Section E — Dependencies & supply chain

| # | Red flag | Status | Severity | Location | One-line fix |
|---|---|---|---|---|---|
| E1 | Lockfile committed | doesn't fire (✓) | — | `package-lock.json` 8415 lines | — |
| E2 | Integrity hashes in lockfile | doesn't fire (✓) | — | npm-default in `package-lock.json` | — |
| E3 | No postinstall scripts on direct deps | doesn't fire (✓) | — | Audit-confirmed grep across direct dep package.jsons | — |
| E4 | No CI audit gate | fires | medium | No `npm audit` step in CI (CI not enumerated; assume absent) | Add GH Actions step: `npm audit --audit-level=high` |
| E5 | No Dependabot/Renovate config | fires | low | No config files visible | Enable Dependabot via GitHub repo settings |
| E6 | No SBOM | fires | low | No CycloneDX/SPDX artifact | `npm sbom` in release workflow |
| E7 | Possibly-unused `lucide-react` | fires | low (hygiene) | `package.json` L15; no imports found in audit | Run `npx depcheck`; remove if confirmed unused |
| E8 | `^` ranges on 10 of 14 deps | accepted | — | `package.json` L13–L29 | `npm ci` in CI prevents drift; `npm install` cadence is operational |

#### Section F — LLM and agent security

| # | Red flag | Status | Severity | Location | One-line fix |
|---|---|---|---|---|---|
| F1 | Per-agent tool whitelists, all read-only | doesn't fire (✓) | — | `lib/mcp/tools.ts` L5–L40 | — |
| F2 | Structured outputs validated + FALLBACK | doesn't fire (✓) | — | `lib/mcp/validate.ts` L3–L57; FALLBACKS in agent files | — |
| F3 | Tool-call budgets enforced | doesn't fire (✓) | — | `runAgentLoop` `maxToolCalls`; 4–6 per agent | — |
| F4 | Tool results truncated before sending to model | doesn't fire (✓) | — | `lib/agents/base.ts` L29–L34 (16KB) | — |
| F5 | `QueryAgent.answer` text NOT validated | fires | medium | `lib/agents/query.ts` L46 (`finalText.trim()`) | Add a sanity guard: length cap, strip code blocks, flag suspicious patterns |
| F6 | `queryTools` is full union of agent toolsets | fires | medium | `lib/mcp/tools.ts` L37–L40 | Dispatch to specific agent based on `classifyIntent` result instead of using union |
| F7 | `diagnosticTools` includes `list_customers` (PII) | fires | medium | `lib/mcp/tools.ts` L15–L25 | Remove if unused; or add per-tool result-shaping middleware |
| F8 | No per-tool result shaping (PII stripping) | fires | medium | Throughout `lib/agents/*.ts` (tool results forwarded verbatim) | Middleware in `McpClient.callTool` that runs per-tool sanitizers |
| F9 | Recommendation output is latent write surface | accepted (today) | — | `lib/agents/recommendation.ts` (today renders cards) | Future-risk: if auto-execute lands, add HITL confirmation + audit log + rate limit |
| F10 | Synthesis fallback runs tool-less | doesn't fire (✓) | — | `diagnostic.ts` L87–L126, `recommendation.ts` L82–L132 | — |
| F11 | Prompt template uses `.replace()` with typed values | doesn't fire | — | `JSON.stringify(anomaly)` etc. escape; `{schema}` is upstream-trusted | Defensive: `schemaSummary` could strip newlines from event names |

### Move 3 — the principle

**A red-flags list isn't a checkbox exercise; it's an alignment artifact.** Every "fires" row is a conversation: do we patch now, queue, or accept? The audit's value isn't in flagging — it's in making the alignment explicit. Each row carries a fix at the right size (one line where possible; named scope where larger) so the team can sequence the work.

---

## Primary diagram

The findings consolidated by severity, with the three top-line ones called out.

```
  Findings summary — blooming insights

  ┌─ HIGH ─────────────────────────────────────────────────────────────┐
  │                                                                     │
  │  ★ A7 / B6  POST /api/mcp/call accepts any tool name               │
  │             (no allowlist; auth-gated only; CSRF-vulnerable)        │
  │             one-line fix: tool-name allowlist                       │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ MEDIUM ───────────────────────────────────────────────────────────┐
  │                                                                     │
  │  B4   CSRF on POST /api/mcp/reset                                  │
  │  B5   GETs with side effects (/briefing, /agent)                   │
  │  C3   AUTH_SECRET strength not enforced                            │
  │  C4   AUTH_SECRET no graceful rotation                             │
  │  ★ C6   Stack traces in 4 error responses                          │
  │  C7   Possible token echo in Vercel logs                           │
  │  D5   Full error logged with cause chain                           │
  │  D6   list_customers latent in diagnosticTools whitelist           │
  │  E4   No CI audit gate                                             │
  │  F5   QueryAgent.answer text not validated                         │
  │  F6   queryTools = full union of agent toolsets                    │
  │  F7   diagnosticTools includes PII tool                            │
  │  F8   No per-tool result shaping                                   │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ LOW ──────────────────────────────────────────────────────────────┐
  │                                                                     │
  │  A8 / A9   No length cap on ?q= / ?insight=                        │
  │  C8        No startup env-var validation                            │
  │  D3        ?insight= in browser history + Referrer                  │
  │  E5 / E6   No Dependabot / SBOM                                     │
  │  E7        Possibly-unused dep (lucide-react)                       │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ ACCEPTED ─────────────────────────────────────────────────────────┐
  │                                                                     │
  │  C5   Dev .auth-cache.json plaintext (gitignored; commented)       │
  │  B7   No MFA (10-day cookie)                                       │
  │  B8   OAuth state CSRF re-check (SDK handles it)                   │
  │  B9   No per-route role gates                                      │
  │  D2   NDJSON trace by design                                       │
  │  F9   Recommendation latent write surface (no auto-execute today)  │
  │  E8   ^ ranges on most deps                                        │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘

  Critical: NONE
  N/A: SQL, shell, path, SSRF (the codebase shape doesn't reach these sinks)
```

The diagram is the file's headline: no critical findings; one high-severity gap with a one-line fix; a meaningful list of medium-severity items that compound under deployment-shape changes (multi-tenant, write tools, account systems).

---

## Implementation in codebase

Cross-reference from every checklist row back to its source file:

| Row(s) | Source file in this study |
|---|---|
| A1–A12 | [03-input-validation-and-injection.md](./03-input-validation-and-injection.md) and [01-trust-boundaries-and-attack-surface.md](./01-trust-boundaries-and-attack-surface.md) |
| B1–B10 | [02-authentication-and-authorization.md](./02-authentication-and-authorization.md) |
| C1–C9 | [04-secrets-and-configuration.md](./04-secrets-and-configuration.md) |
| D1–D8 | [05-data-exposure-and-privacy.md](./05-data-exposure-and-privacy.md) |
| E1–E8 | [06-dependencies-and-supply-chain.md](./06-dependencies-and-supply-chain.md) |
| F1–F11 | [07-llm-and-agent-security.md](./07-llm-and-agent-security.md) |

**Use case 1 — pre-ship hardening sprint.** Engineer opens this file. Sorts by severity. Patches HIGH first (A7/B6 — one-line allowlist on `/api/mcp/call`). Then MEDIUM (the four C-row stack/rotation/log issues; the two F-row PII-related items). Files a ticket for LOW. Documents the ACCEPTED rows in the deployment runbook. Ships.

**Use case 2 — code review on a new feature.** Reviewer sees a new POST route in the diff. Opens this file's Section A and B. Asks: does the new route have schema validation? CSRF protection? Origin check? Is its error response message-only? The checklist becomes a review template.

**Use case 3 — vulnerability response.** A new CVE drops for a transitive. Reviewer opens E1 (lockfile present → reproducible) and E4 (no automation → manual `npm audit` needed). Runs `npm audit`, gets the advisory, decides whether to upgrade now or accept. The checklist tells them the structural posture so they can size the response.

---

## Elaborate

### Where this format comes from

**The OWASP Top 10** has been the prototype for this kind of triaged list since 2003. Each item is a category, each project either fires or doesn't, severity is graded. The discipline traveled into PCI DSS, SOC2 control evidence, and FedRAMP authorization packages. The format works because it's *operationally usable* — it converts "do a security audit" (vague) into "walk this list" (specific).

**The OWASP LLM Top 10** (2023+) added agent-era categories. Section F here maps to LLM01 (prompt injection), LLM02 (insecure output handling), LLM07 (insecure plugin design), LLM08 (excessive agency) without restating them.

### The deeper principle

**A red-flags list is read at three moments**: (1) at audit-write time, by the auditor (who fills it in); (2) at code-review time, by the reviewer (who checks every new diff against it); (3) at incident time, by the responder (who uses it to answer "could THIS have been the cause?"). The audit's quality is measured by how usable the list is at all three moments — not just by how many items it has.

### Where this audit could go deeper

The audit didn't include several activities that would graduate it from "structural audit" to "production security review":

- **Live exploit testing** (red-teaming): take each "fires" row and try the attack. Audit predicts the attack works; testing confirms.
- **Static analysis tools**: ESLint security plugins, semgrep rules, CodeQL queries. Would catch some classes of finding the audit might miss.
- **`npm audit` snapshot**: not run during this audit because the output drifts. A point-in-time snapshot would be a useful audit attachment.
- **`git log` secret scan**: not run; would verify C1 (no secret ever committed in history).
- **DAST (Dynamic Application Security Testing)**: run a scanner against a live instance. Would catch missing security headers (CSP, X-Frame-Options, Referrer-Policy) the audit didn't enumerate.
- **Threat modeling (STRIDE walkthrough)**: enumerate actors and abuse cases formally. The audit lays groundwork; STRIDE is the next-level activity.

### What to read alongside this file

The file index in [README.md](./README.md). The cross-references at the top of each concept file. The two non-security-study files that already cover slices: `study-system-design-dsa/01-system-design/02-oauth-boundary.md` and `study-ai-engineering/06-production-serving/03-prompt-injection.md`.

---

## Interview defense

**What they are really asking:** can you triage findings honestly — neither inflating low-severity ones to look thorough nor downplaying high-severity ones to look polished?

---

**[mid] — Walk me through the findings, top to bottom.**

One high-severity, one architectural decision compounding a few medium-severity, no critical. The high is `POST /api/mcp/call` — it accepts any tool name and forwards to the live MCP, gated only by session auth. Today it's bounded because every tool Bloomreach exposes is read-only, but the moment Bloomreach adds a write tool, this route exposes it without any in-app gate. One-line fix: a tool-name allowlist.

The mediums cluster in three groups. CSRF gaps — no CSRF token on `/api/mcp/reset`, GETs with side effects on `/briefing` and `/agent`. Secret-management hardening — no `AUTH_SECRET` strength enforcement, no graceful rotation, stack traces in four error responses. Agent-layer surface — `QueryAgent`'s unguarded natural-language output, `queryTools` being the full union, `list_customers` latent in the diagnostic whitelist.

The lows are hygiene — length caps on query params, Dependabot, SBOM. The accepteds are explicit choices: no MFA on the long-lived session (single-user demo), dev plaintext tokens (gitignored), recommendation as latent write surface (no auto-execute today).

```
  triage shape

  critical          0
  high              1  (POST /api/mcp/call allowlist)
  medium            10 (clusters: CSRF, secrets, agent surface)
  low               5  (hygiene)
  accepted          7  (explicit choices)
  N/A               4  (sinks that don't exist here)
```

---

**[senior] — What's the highest-leverage thing to fix?**

The `POST /api/mcp/call` allowlist. One line, defangs the whole "what if Bloomreach adds a write tool" scenario, no behavior change for legitimate use because `/debug` only calls whitelisted tools anyway. It's the rare finding where the fix is essentially free.

Second-highest is the cluster of stack-trace leaks in error responses (`C6`). Four routes, one-line fix per route (remove `e.stack` from the response, keep it in `console.error`). Pattern is already correct in the streaming routes; just propagate it. Info disclosure isn't catastrophic but it's a free win for attacker recon, and the inconsistency suggests "we know the right pattern, we just didn't do it everywhere."

Third is `AUTH_SECRET` strength enforcement — two lines (`if (secret.length < 32) throw …` in `aesKey`). Defends against the deployment that sets `AUTH_SECRET=password` and doesn't realize the whole cookie-encryption story collapses.

---

**[arch] — What's NOT in this audit that should be?**

Live exploit testing — the audit predicts the attacks; running them confirms. Static analysis (semgrep / ESLint security) — would catch classes of finding that line-by-line reading might miss. A formal STRIDE walkthrough — would enumerate actors and abuse cases more rigorously than my prose narrative. DAST headers check (CSP, X-Frame-Options, Referrer-Policy) — I didn't enumerate which security HTTP headers the routes set, and that's a meaningful gap.

For a real production hardening pass, the audit is the input to those activities, not a replacement for them. The audit's job is "make sure every boundary has a named owner and a graded finding"; the activities above are "verify and harden."

---

**The dodge — "is it ready to ship?"**

Depends on the deployment shape. As a demo / portfolio piece for a single user — yes, with the H1 finding patched (one line). As a multi-user B2B SaaS — no, the CSRF cluster and the MFA gap and the per-route role gates would all block; the audit explicitly grades these as accepted only because the current deployment is single-user. As an internal tool used by 5 people on the same team — yes, with the H1 + the four C6 routes patched.

The audit doesn't make the call; it gives you the inputs to make the call. Severity ratings encode "how would this scale with deployment size," so a re-grade for a different deployment is straightforward.

---

**One-line anchors:**
- No critical findings; one high-severity finding with a one-line fix.
- Three highest-impact fixes: A7 (tool allowlist), C6 (drop stack from 4 error responses), C3 (`AUTH_SECRET` length check).
- "Accepted" rows are explicit choices, not glossed-over gaps.
- Severity scales with deployment shape — re-grade if the shape changes.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, name the three highest-severity findings and where they live in code. Then check against the **Primary diagram**.

### Level 2 — Explain
Why are A7 and B6 the same finding tagged differently? What does each row contribute that the other doesn't? Check rows A7 and B6 in the checklist.

### Level 3 — Apply
Re-grade the audit for a hypothetical B2B SaaS deployment with 100 customers each having multiple users. Which "accepted" rows become "fires"? Which severities change? Reference at least four specific rows.

### Level 4 — Defend
A teammate proposes deferring all medium-severity findings and shipping only the high-severity fix. Defend or refute. (Hint: which medium-severity rows compound under specific deployment changes? When is "defer" correct vs negligent?)

### Quick check
- How many critical findings? → 0.
- How many high-severity findings? → 1 (A7/B6, the `POST /api/mcp/call` allowlist).
- Which categories are N/A entirely? → SQL injection, shell injection, path traversal from user input, SSRF.
- Where do you look for the canonical OAuth treatment? → `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md`.

---

## See also

→ [README.md](./README.md) · [00-overview.md](./00-overview.md) and every file 01–07.
