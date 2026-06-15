# Refactor: Log Anthropic res.usage at every call site

## What to refactor

Four `anthropic.messages.create` call sites, all unobserved today:

- `lib/agents/base.ts:102` — the main `runAgentLoop` turn. The biggest by call volume; every monitoring/diagnostic/recommendation/query loop iteration goes through here.
- `lib/agents/diagnostic.ts:97` — `synthesize()` tool-less recovery turn (suspected cost concentration per `study-performance-engineering/04-synthesize-as-cost-concentration.md`).
- `lib/agents/recommendation.ts:96` — `synthesize()` tool-less recovery turn (same shape as diagnostic's).
- `lib/agents/intent.ts:18` — `classifyIntent` Haiku call (cheap, but uncounted).

## Why

This is the cheapest fix in the codebase for the most consequential blind spot. `res.usage` is already on the response object — every Anthropic SDK response carries `{ input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? }` — and the codebase throws it away. The consequences (cleanup-2026-06-02 fix-now #2 + `study-performance-engineering/audit.md` Top-3 #1):

- Every prompt edit ships blind — no signal whether the new prompt is 1.2x or 3x the old in input tokens.
- Every model swap ships blind — Sonnet → Haiku is a guess about cost reduction.
- The suspected cost concentration in `synthesize()` (the 2048-max-token tool-less recovery call) can't be confirmed or denied.

Severity: high. Effort: ~5 LOC total. No behaviour change, no API change, no test change.

## Target structure

After each `await anthropic.messages.create(…)` at the four sites, add ONE line:

```
const res = await anthropic.messages.create(params);
console.log(JSON.stringify({ site: 'agents/base:runAgentLoop', usage: res.usage, sessionId }));
```

The `site` string is the only per-call-site change; it must uniquely identify the source (so Vercel log queries can group by site). The `sessionId` plumbed in for #1 (Session-key the insights Map) makes the line per-session attributable; if #1 hasn't landed yet, omit sessionId and leave a TODO at one site (intent.ts) where the session is hardest to thread.

The shape of the log line is a deliberate JSON-string single-arg so Vercel's log parser indexes the fields as searchable keys.

Behaviour-preserving claim: every code path is identical except for one extra synchronous `console.log` before the existing read of `res.content`.

## Must not change

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->

## Must not introduce

<!-- LEAVE BLANK — the user fills via /aipe:refactor in a separate session -->
