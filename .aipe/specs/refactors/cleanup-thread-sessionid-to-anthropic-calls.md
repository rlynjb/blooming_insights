# Refactor — thread `sessionId` to the 4 Anthropic call sites

> Source finding: `.aipe/audits/cleanup-2026-06-14T19-50-14.md` fix-now #2.
> Originating commit follow-up: `cc43e7d — feat(observability): log Anthropic res.usage at all 4 call sites (cleanup #6)`.

---

## What to refactor

Thread `sessionId` through to the `console.log({ site, usage: res.usage })` calls that commit cc43e7d added. The four call sites all have a `TODO: thread sessionId` comment authored by that commit, with the inline explanation of why each one was deferred:

- `lib/agents/base.ts:103` — `// TODO: thread sessionId once runAgentLoop opts carry it (would require touching all 4 callers).`
- `lib/agents/diagnostic.ts:117` — `// TODO: thread sessionId once DiagnosticAgent carries it (would require touching the route caller).`
- `lib/agents/recommendation.ts:123` — `// TODO: thread sessionId once RecommendationAgent carries it (would require touching the route caller).`
- `lib/agents/intent.ts:26` — `// TODO: thread sessionId once classifyIntent's signature carries it (spec marks this site as hardest to thread).`

Each TODO names the surface that has to change to thread it. The route handlers already have `sid` in scope (`await getOrCreateSessionId()`). The work is plumbing, not new mechanics.

---

## Why

Commit cc43e7d shipped the log line — that's the easy half. Without `sessionId`, the four log records can't be aggregated per session, which is the whole point of usage logging: you can't ask "how many tokens did session X burn across its briefing + investigation + recommendation chain?" without a join key. Today's logs are useful for sizing one call in isolation; they're not useful for sizing a *flow*. Threading `sessionId` is what makes the morning's #2 fix finish.

A second axis: the four TODOs in tree are commit-authored debt, not pre-existing. Leaving them more than one cleanup pass before resolving them is the start of the "TODO that becomes permanent" pattern. Close them while the commit is still fresh.

---

## Target structure

**Step 1 — `runAgentLoop` (lib/agents/base.ts).** Add `sessionId?: string` to `RunAgentLoopOpts`. Use it at the existing log site:

```
// at lib/agents/base.ts:104, change:
console.log(JSON.stringify({ site: 'agents/base:runAgentLoop', usage: res.usage }));
// to:
console.log(JSON.stringify({ site: 'agents/base:runAgentLoop', sessionId: opts.sessionId, usage: res.usage }));
```

Pass `sessionId` through from the four agent classes that wrap `runAgentLoop` (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`).

**Step 2 — `DiagnosticAgent.synthesize` + `RecommendationAgent.synthesize`.** Each agent class gains a `sessionId?: string` constructor argument (or a `sessionId` field set by the caller). The route caller threads `sid` in. Update the log calls at `lib/agents/diagnostic.ts:118` and `lib/agents/recommendation.ts:124` to include `sessionId: this.sessionId`.

**Step 3 — `classifyIntent` (lib/agents/intent.ts).** Change the signature:

```
// from:
export async function classifyIntent(anthropic: Anthropic, query: string): Promise<Intent>
// to:
export async function classifyIntent(anthropic: Anthropic, query: string, sessionId?: string): Promise<Intent>
```

Caller at `app/api/agent/route.ts` already holds `sid` in scope (line ~248, inside the intent phase) — pass it.

**Step 4 — delete all four TODO comments.** They are explicitly marking this work; they go when the work goes.

**End state:**
- Every `usage`-logging `console.log` carries `sessionId`.
- The route handlers that own the `sid` thread it down through one extra argument per agent.
- Zero `TODO: thread sessionId` comments remain in `lib/agents/`.

---

## Must not change

[BLANK — fill before execution]

---

## Must not introduce

[BLANK — fill before execution]
