# Chapter 5 — The Failure Story

"What happens when things go wrong?" is the question that separates people who built a happy-path demo from people who shipped something. The good news for you is that this system has a genuinely interesting failure story, because the upstream it depends on — Bloomreach's alpha MCP server — fails *constantly* in development: it rate-limits, and it revokes your token after a few minutes mid-session. You did not have to imagine failure modes. You had to survive them to get the thing working at all. So when an interviewer asks this, you are not reaching for hypotheticals — you are describing scars. Lead with that framing: every guard in here exists because the alpha server forced it.

The trick is to answer this as a *map*, not a list. Each failure surface is a box, and the system has a specific, named response in each. Here is the map:

```
┌ BLOOMING INSIGHTS — FAILURE SURFACES & THE SYSTEM'S RESPONSE ────────────────┐
│                                                                              │
│  ┌────────────────────────┐   ┌────────────────────────────────────────┐    │
│  │ MCP rate limit (429)   │   │ Token revoked mid-session (alpha kills   │    │
│  │ ──────────────────────  │   │ tokens after minutes)                   │    │
│  │ ~1.1s spacing prevents │   │ ────────────────────────────────────────│    │
│  │ most. On a 429:        │   │ detect invalid_token / 401 in the error │    │
│  │ bounded backoff retry  │   │ → reset auth (/api/mcp/reset) + reload  │    │
│  │ (10s→20s, maxRetries 3)│   │ ONCE, guarded by sessionStorage         │    │
│  │ NEVER cache the error  │   │ 'bi:reconnecting' so it can't loop      │    │
│  └────────────────────────┘   └────────────────────────────────────────┘    │
│                                                                              │
│  ┌────────────────────────┐   ┌────────────────────────────────────────┐    │
│  │ Auth missing / expired │   │ Pre-stream setup throw (e.g. AUTH_SECRET│    │
│  │ ──────────────────────  │   │ unset → aesKey throws in prod)          │    │
│  │ 401 JSON {needsAuth,   │   │ ────────────────────────────────────────│    │
│  │ authUrl} BEFORE the    │   │ try/catch around getOrCreateSessionId + │    │
│  │ stream → client        │   │ connectMcp → returns the REAL error msg │    │
│  │ redirects to OAuth     │   │ as JSON, NOT a bare 500 (real bug fixed)│    │
│  └────────────────────────┘   └────────────────────────────────────────┘    │
│                                                                              │
│  ┌────────────────────────┐   ┌────────────────────────────────────────┐    │
│  │ Malformed LLM output   │   │ Empty / sparse data window               │    │
│  │ ──────────────────────  │   │ ────────────────────────────────────────│    │
│  │ parseAgentJson lenient │   │ prompt does a VOLUME CHECK first;       │    │
│  │ extract + type-guards  │   │ refuses to report on an empty window    │    │
│  │ → degrade to []/empty, │   │ (no bogus ±100% swings on the sparse    │    │
│  │ never crash, never UI  │   │ recent tail)                            │    │
│  │ garbage                │   │                                         │    │
│  └────────────────────────┘   └────────────────────────────────────────┘    │
│                                                                              │
│  ── DEMO PATH (?demo=cached): creds-free reliability fallback when the alpha │
│     server is down or revoking. Touches no auth, no MCP. ──────────────────  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Notice the shape of the whole story before we walk the boxes: there is **one upstream and no database.** That is not a gap to apologize for — it is the thing that *bounds* your failure surface. You will use it at the end to honestly defer the distributed-failure questions (partial writes, two-phase commit) because there is no multi-service write path here to fail that way. Hold that thought; the rest of the chapter earns the right to say it.

---

## Failure 1 — MCP rate limit (429)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ "What happens when the upstream API rate-limits you?"                          │
│ → Do you prevent it, recover from it, or just crash and retry blindly?          │
└──────────────────────────────────────────────────────────────────────────────┘
```

I handle a 429 in three layers, and I describe them in order: prevent, recover, contain. First, **prevent** — `BloomreachDataSource` spaces every call at `minIntervalMs: 1100` (`lib/mcp/connect.ts` line 92), just over Bloomreach's observed ~1 req/s per-user window, so most calls never hit the limit at all. The spacing is enforced in the live-call path (`lib/data-source/bloomreach-data-source.ts`, post Phase 2 PR A rename — the file used to be `lib/mcp/client.ts` and a 17-line backwards-compat shim still re-exports `McpClient` from the old path): it measures elapsed time since the last call and sleeps the remainder. None of this applies to the `live-synthetic` adapter — it's an in-process function call, no rate limit, no spacing, no retry needed.

Second, **recover** — when a 429 does come back, I do not blindly retry. Bloomreach states the penalty window in the error text, so `parseRetryAfterMs` pulls the real wait out of the message ("retry after ~12 seconds" or "1 per 10 second"), and the retry loop honors that hint, falling back to exponential backoff off `retryDelayMs: 10_000` capped at `retryCeilingMs: 20_000`, with `maxRetries: 3`. There is even a 500ms buffer (`RETRY_BUFFER_MS`) so the retry lands just *after* the window clears, not on its boundary. The retry budget is deliberately small because each ~10s wait eats into the run's time budget — three retries at 10s is 30s on a single call, and I will not blow the run for one stubborn query.

Third, and this is the one I am proudest of: **contain** — I never cache an error. In `callTool` (`lib/data-source/bloomreach-data-source.ts:144-148`), an `isError` result returns *before* the cache write, so a transient 429 can never poison the 60s TTL cache and serve a stale failure to the next caller. A successful retry overwrites nothing bad; a failure leaves the cache clean for the next attempt.

> ▸ I prevent most 429s with ~1.1s spacing, recover from the rest with the server's own stated retry window, and I never cache an error so one 429 can't poison the next caller.

Follow-up decision tree:

```
"rate limit" answered
        │
        ▼
   ├─► IF THEY ASK "why parse the retry window instead of fixed backoff?"
   │     Because a fixed sub-second retry just burns the attempt inside the same
   │     10s penalty window — I'd spend all 3 retries and still be rate-limited.
   │     Bloomreach tells me the window in the error text, so I wait exactly that
   │     long plus a 500ms buffer. The exponential backoff is only the fallback
   │     when nothing parseable is in the message.
   │
   ├─► IF THEY ASK "why only 3 retries?"
   │     Latency budget. Each wait is ~10s against a 300s function ceiling, and a
   │     live investigation already runs ~100-115s. Three retries at 10s is 30s
   │     on ONE call — raising the cap risks blowing the whole run for one query.
   │     I'd rather degrade gracefully than hold the function open retrying.
   │
   └─► IF THEY ASK "what if the retries are exhausted?"
         The tool call comes back as an error result; runAgentLoop feeds it to
         the model as a tool_result with is_error:true (base.ts lines 151-166),
         and the agent can synthesize from what it already gathered. The briefing
         degrades to whatever anomalies it found, not a crash.
```

---

## Failure 2 — Token revoked mid-session

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ "The auth token gets revoked while a user is mid-session. What happens?"        │
│ → Can you recover automatically without an infinite reconnect loop?             │
└──────────────────────────────────────────────────────────────────────────────┘
```

This is the failure I actually lived with, so I describe it from experience. The alpha MCP server revokes tokens after a few minutes — its own 401 even tells the client to clear tokens and re-register. So I do exactly that, **once, automatically.** The logic now lives in its own hook — `lib/hooks/useReconnectPolicy.ts` — extracted from `app/page.tsx` as part of the page-decomposition refactor. The hook tests an error message against a pattern (`/invalid_token|unauthor|forbidden|401|session expired|reconnect/i`); on a match it POSTs to `/api/mcp/reset` (which calls `clearAuth` and `deleteAuthCookie` to drop the stored tokens) and then reloads the page, which re-runs the OAuth flow with a fresh token.

The part that makes this safe rather than a foot-gun is the **loop guard.** Before reconnecting, the hook checks `sessionStorage.getItem('bi:reconnecting') === '1'`. If it already tried once this session, it does NOT reconnect again — it surfaces the error instead. It sets the flag before reconnecting and clears it on a successful `done` event. So if the fresh token is *also* immediately revoked, the system shows the error rather than spinning forever in a reload loop. One automatic recovery attempt, then it stops and tells the user. (None of this applies to the `live-synthetic` adapter, which has no auth surface at all — that path can't experience this failure.)

> ┃ "The alpha server revokes tokens after minutes, so I auto-reconnect exactly once — guarded by a sessionStorage flag so a token that's killed again can't loop the page."

**Strong vs. weak — when they ask about mid-session token failure:**

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│ WEAK                                 │ STRONG                               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│ "If the token expires I just retry   │ "The alpha server revokes tokens     │
│  the auth flow until it works."      │  after minutes. On an invalid_token  │
│                                      │  error I reset auth and reload ONCE,  │
│                                      │  guarded by a sessionStorage flag, so │
│                                      │  if the fresh token is also revoked   │
│                                      │  it surfaces the error instead of     │
│                                      │  looping. One attempt, then stop."    │
├─────────────────────────────────────┼─────────────────────────────────────┤
│ Why it's weak: "retry until it       │ Why it works: names the loop risk     │
│ works" is exactly how you build an   │ explicitly and the exact guard that   │
│ infinite reload loop that hammers    │ prevents it. Shows you thought about  │
│ the auth endpoint. No guard, no      │ the failure-of-the-recovery, which is │
│ ceiling, no thought to the recovery  │ the senior tell.                      │
│ itself failing.                      │                                       │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

---

## Failure 3 — Auth missing or expired (before the stream)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ "A request comes in with no valid auth. What does the client get back?"         │
│ → A clean redirect, or a broken half-stream?                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

The key decision is *when* I check auth: **before I commit to the stream, not during it.** In both routes, `connectMcp` runs before the `ReadableStream` is constructed. If there are no valid tokens, the MCP SDK's auth flow captures an authorize URL, and `connectMcp` returns `{ ok: false, authUrl }` (`lib/mcp/connect.ts` lines 102-104). The route then returns a plain `401 JSON` — `{ needsAuth: true, authUrl }` — *before* any streaming begins (`app/api/briefing/route.ts` lines 172-174, `app/api/agent/route.ts` line 166). The client checks `body.needsAuth && body.authUrl` and does a full-page redirect to the OAuth URL.

Why this ordering matters: if I checked auth *inside* the stream, the client would have already started reading an NDJSON body, and I would have to inject an error event into a half-open stream — messy to consume, and the client has already committed to the streaming code path instead of a clean redirect. By returning a 401 with a body *before* the stream opens, the failure looks like an ordinary HTTP response the client can branch on, and the redirect-to-OAuth is the natural next step rather than a recovery from a broken read.

> ▸ I return the 401 with the authorize URL BEFORE opening the stream, so a missing-auth case is a clean redirect, not an error injected into a half-open NDJSON body.

---

## Failure 4 — Pre-stream setup throw (the real bug I fixed)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ "What happens if setup itself throws — a missing env var, a crypto failure?"     │
│ → Does the user get a real error, or a useless bare 500?                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

This one I tell as a bug-and-fix story, because it actually was one. In production the auth cookie is AES-256-GCM encrypted under `AUTH_SECRET`, and `aesKey()` in `lib/mcp/auth.ts` (lines 51-59) *throws* if `AUTH_SECRET` is unset — deliberately, so I never silently run with no encryption. But that throw happens during `connectMcp` setup, which originally ran before the try/catch. The result was a bare 500 with no message: the user saw "something went wrong" and I had no idea it was a missing env var.

The fix was to wrap the pre-stream setup — `getOrCreateSessionId` plus `connectMcp` — in a try/catch in both routes (`app/api/briefing/route.ts` lines 161-171, `app/api/agent/route.ts` lines 155-165). Now a setup throw returns a real JSON error: `` `/api/briefing setup · ${e.message}` ``. The actual message ("AUTH_SECRET is required in production…") reaches the response, and the full stack lands in the Vercel logs via `console.error`. The difference between a bare 500 and "AUTH_SECRET is required" is the difference between an hour of guessing and a one-line fix — which is exactly what happened.

> ┃ "A setup throw used to surface as a bare 500; I wrapped the pre-stream connect in try/catch so the real message — like 'AUTH_SECRET is required' — reaches the response instead of a guess."

---

## Failure 5 — Malformed LLM output

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ "The model returns garbage instead of clean JSON. What reaches the UI?"          │
│ → Do you trust the model's output, or do you defend against it?                  │
└──────────────────────────────────────────────────────────────────────────────┘
```

I never trust the model's output shape, because a model wrapping JSON in prose or a fenced block is the *normal* case, not the failure case. So `parseAgentJson` in `lib/mcp/validate.ts` (lines 3-13) extracts leniently in three steps: try a ```` ```json ```` fence first, then a bare `JSON.parse`, then a substring scan from the first `[` or `{` to the last `]` or `}`. That survives the model saying "Here are the anomalies I found:" before the array.

But lenient parsing is only half — I also **structurally validate** what came out. `isAnomalyArray`, `isDiagnosis`, and `isRecommendationArray` (same file) are type-guards that check every required field and enum value before the data is trusted. If parsing throws or validation fails, the agent **degrades to `[]` or empty** rather than crashing — the monitoring agent catches the parse error and returns `[]` (`lib/agents/monitoring.ts` lines 112-118), treating "no parseable output" the same as "no anomalies found." The route's trace still records what the agent actually did, so the failure is observable without being fatal. Garbage never reaches the UI as garbage — it reaches it as an empty result, which the feed renders as "nothing notable," which is honest.

Follow-up decision tree:

```
"malformed output" answered
        │
        ▼
   ├─► IF THEY ASK "why not just force JSON mode / a strict schema?"
   │     Lenient extraction plus a type-guard is more robust to the model's
   │     actual behavior than trusting any single output mode. The fence scan
   │     handles the common 'here's my answer:' preamble; the structural guard
   │     catches a field that's the wrong type even when the JSON parses. Two
   │     independent defenses, neither of which assumes the model behaved.
   │
   └─► IF THEY ASK "isn't degrading to [] hiding a real failure?"
         The empty result is honest — 'no anomalies' is a valid outcome, and the
         dataset's sparse tail genuinely produces that. The trace records every
         tool call the agent made, so I can tell a real empty from a parse
         failure in the logs. I'd rather show 'nothing notable' than crash the
         whole briefing on one bad synthesis.
```

---

## Failure 6 — Empty or sparse data window

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ "Your data window is empty or nearly empty. What does the system report?"        │
│ → Will it report a confident-looking but meaningless number?                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

This is a data-failure mode I hit directly: the workspace's recent days are sparse — the dataset effectively ends a couple of weeks before today — so a naive 7-day or 30-day window lands on an empty tail and produces a meaningless ±100% swing. The fix lives in the monitoring prompt (`lib/agents/prompts/monitoring.md`). The agent's **first query is a volume check** (lines 33-37): `select count event purchase in last 90 days`. If the window is healthy, it proceeds with 90d-vs-prior-90d. If it is empty or tiny, it shifts the execution window back a few weeks or widens to 365 days. And the hard rule: **"Never report a change derived from an empty or zero window"** — if it cannot establish a populated window within its 6-call budget, it returns `[]`. There is also a small-baseline guard (line 29): ignore any change where the prior value is under ~500 events, because tiny baselines manufacture huge percentages.

So the system's response to sparse data is to *refuse to lie about it.* It would rather report nothing than report a ±100% swing that is really just an empty bucket. That is the difference between a tool an analyst trusts and one they learn to ignore.

> ▸ The monitoring agent's first query is a volume check, and it refuses to report any change off an empty window — it returns nothing rather than a bogus ±100%.

---

## The honest center: distributed-failure territory I have not built

This is where they will push you into partial writes, two-phase commit, idempotency keys at scale. The strong move is not to attempt those answers — it is to show *why this system doesn't have that failure surface*, and then defer cleanly on the general case.

```
╔══════════════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY — distributed writes / partial-failure across services ║
║                                                                                ║
║ THE PUSHBACK: "What happens on a partial write — a write succeeds in service A ║
║   but fails in service B? How do you handle two-phase commit and idempotency   ║
║   keys across services at scale?"                                              ║
║                                                                                ║
║ SAY: "This system doesn't have that failure surface, and that's by design, not ║
║   by accident. There's one upstream — Bloomreach's MCP — and no database. The  ║
║   MCP calls are reads (EQL queries return aggregates); there's no multi-service║
║   write path to leave half-committed. The only writes are the dev-mode cache   ║
║   files and the encrypted auth cookie, and those are single-writer, best-      ║
║   effort. So the partial-write and two-phase-commit questions don't apply to   ║
║   what I built. On the general case — coordinating writes across distributed   ║
║   services, idempotency keys, two-phase commit — I haven't built that, so I'm  ║
║   not going to walk you through a design I've only read about. I know the      ║
║   names of the problems and why they're hard; I haven't solved them in         ║
║   production."                                                                 ║
║                                                                                ║
║ WHAT THIS SIGNALS: you can tell the difference between 'my system avoids this  ║
║   by its shape' and 'I personally know how to solve this in general.' You own  ║
║   the first confidently and defer the second honestly. That's a much stronger  ║
║   signal than faking a two-phase-commit answer — it shows you understand WHY   ║
║   your architecture is bounded, which is itself a design decision worth credit.║
║                                                                                ║
║ DO NOT SAY: "I use idempotency keys and a saga pattern with compensating       ║
║   transactions." You have no service that does this. The follow-up ("show me   ║
║   the compensating transaction for a failed recommendation write") has no      ║
║   answer because there is no such write, and now you look like you described   ║
║   a system you didn't build.                                                    ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

> ┃ "One upstream, no database — so the partial-write and two-phase-commit failures don't exist here by design; I'll own that boundary and defer on the distributed-write case I haven't built."

---

## What you'd change

The failure-handling I would reconsider is the auth state, because it is the one place where a recovery path is half-built. The CSRF `state` validation in `lib/mcp/auth.ts` (`consumeState`, lines 230-235) is written and tested but **not wired into the callback** — the MCP SDK calls `state()` multiple times per flow, which broke naive re-validation, so I left it disconnected with an honest comment. That is a real gap: the OAuth callback is not validating the `state` parameter against an issued one, which is a CSRF protection I would want before this faced untrusted users. The fix is the same shared store from Chapter 4 — somewhere to track issued states across the ephemeral instances that handle `connect` and `callback` separately. I would also reconsider the reconnect heuristic: matching the error *message* against a regex (`/invalid_token|unauthor|.../`) is brittle — a copy change upstream could silently disable auto-reconnect. I would key the reconnect off a structured signal (an explicit `needsAuth` flag from the route, which I already return elsewhere) rather than string-matching prose.

---

## Summary — Chapter 5

**Core claim:** Every failure guard in this system exists because the alpha MCP server forced it — rate limits, token revocation, malformed output, sparse data — and each surface has a specific named response; the distributed-write failures simply don't exist here because there's one upstream and no database.

**Questions covered:**
- *Upstream rate-limits you (429)?* — Prevent with ~1.1s spacing, recover with the server's stated retry window (bounded backoff, 3 retries), and never cache an error.
- *Token revoked mid-session?* — Auto-reconnect exactly once via /api/mcp/reset, guarded by a sessionStorage flag so it can't loop.
- *Auth missing before the stream?* — Return 401 {needsAuth, authUrl} JSON before opening the stream → clean redirect, not a broken half-stream.
- *Setup itself throws (AUTH_SECRET unset)?* — try/catch around connect returns the real message, not a bare 500 (a real bug I fixed).
- *Model returns garbage?* — parseAgentJson lenient extraction + structural type-guards; degrade to []/empty, never crash, never UI garbage.
- *Empty/sparse window?* — Volume-check first; refuse to report off an empty window; return nothing rather than a bogus ±100%.
- *Partial writes / two-phase commit at scale?* — Doesn't apply: one upstream, no DB, no multi-service write path. Own the boundary, defer the general case.

**Pull quotes:**
- "I prevent most 429s with ~1.1s spacing, recover from the rest with the server's own stated retry window, and never cache an error."
- "The alpha server revokes tokens after minutes, so I auto-reconnect exactly once — guarded so a token killed again can't loop the page."
- "A setup throw used to surface as a bare 500; I wrapped the connect in try/catch so the real message reaches the response."
- "One upstream, no database — so the partial-write and two-phase-commit failures don't exist here by design."

**What you'd change:** Wire the written-but-disconnected CSRF `state` validation into the callback (needs a shared store), and key auto-reconnect off a structured `needsAuth` signal instead of regex-matching error prose.

---
Updated: 2026-05-29 — created
Updated: 2026-06-20 — File references updated post-Phase-2 PR A rename + page-decomposition refactor: McpClient → BloomreachDataSource (cache at lib/data-source/bloomreach-data-source.ts:122,144-148); reconnect logic extracted to lib/hooks/useReconnectPolicy.ts. Each failure surface now notes whether it applies to the Bloomreach side or the new in-process Synthetic adapter (Synthetic has no rate-limit, no auth, no network failure surface — that's part of why the seam matters).
