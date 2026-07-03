# RFC-03 — Deterministic supervisor, not LLM router

**Decision in one line:** The order agents run in — monitoring → diagnostic → recommendation — and the classifier that routes a chat message to `query` vs `investigate` are both plain TypeScript. No LLM decides which agent runs next.

---

## Context

Multi-agent products in 2025 tend to open with a "supervisor" LLM that decides which sub-agent to hand a task to. The pattern is seductive: give the model a menu of specialists, let it pick, and it feels like the system is thinking. The failure modes are also well-documented — the supervisor gets a fifth of the load-bearing decisions wrong, cascades context between agents unnecessarily, and turns latency + cost into a lottery.

blooming insights has a fixed workflow. The user does one of exactly two things:

1. Land on the feed → the app runs the monitoring pipeline → shows anomalies
2. Click an anomaly → the app runs diagnostic → offers "see recommendations →" → user clicks → runs recommendation

Or they type in the chat box, where the answer is either "this is a live workspace question" (route to query agent) or "this looks like an anomaly to investigate" (route to a diagnostic run).

The supervisor's actual job is small: two branch points, both with clear rules a human could write down.

---

## Decision

The supervisor is code. Two pieces:

1. **The pipeline** — sequential agent execution baked into the route handlers. `/api/briefing` runs monitoring. `/api/agent?step=diagnose` runs diagnostic. `/api/agent?step=recommend` takes the diagnosis and runs recommendation. The `step` query param is the ROUTE.
2. **The intent router** — for free-form chat, `lib/agents/intent.ts` uses the cheap Haiku classifier (`claude-haiku-4-5-20251001`) to label the message as `query` vs `investigate` — but the LLM only labels; the code branches. The classifier is scoped to text classification, not tool orchestration.

```
The supervisor is code, not an LLM

  ┌─ user action ────────────┬─ ROUTE decides ──────────┬─ agent runs ────┐
  │ land on feed             │ /api/briefing            │ monitoring       │
  │                          │ (no branch)              │                  │
  ├──────────────────────────┼──────────────────────────┼──────────────────┤
  │ click anomaly            │ /api/agent               │ diagnostic       │
  │                          │ ?step=diagnose           │                  │
  ├──────────────────────────┼──────────────────────────┼──────────────────┤
  │ click "see recs →"       │ /api/agent               │ recommendation   │
  │                          │ ?step=recommend          │                  │
  ├──────────────────────────┼──────────────────────────┼──────────────────┤
  │ type in QueryBox         │ intent.ts labels        │ query OR         │
  │                          │ (Haiku · classification) │ diagnostic       │
  │                          │  → switch(label)         │                  │
  └──────────────────────────┴──────────────────────────┴──────────────────┘

  where control flows:
  · pipeline order  → CODE decides (fixed by ?step)
  · intent routing  → CODE decides (a switch on the Haiku label)
  · within an agent → LLM decides (ReAct loop chooses tools freely)
```

The seam is deliberate: **outer control is code, inner control is LLM.** The route handler enforces order; the ReAct loop inside each agent picks tool calls freely.

---

## Alternatives considered

**(a) Supervisor LLM as an outer agent.** A "coordinator" agent that receives the anomaly and decides whether to call `diagnose` or `recommend` or skip. Loses because the ordering is knowable at ROUTE time — the user's click already carries the decision. Handing that to an LLM adds a model turn, one more class of failure (the supervisor picks the wrong sub-agent), and no capability that isn't already handled by the `step` param.

**(b) Full LLM router for chat (no classifier).** Give the query agent the diagnostic tools too and let it decide. Loses because the query and diagnostic agents have different system prompts, different tool subsets, and different cost profiles. A user asking "how many customers do we have?" should get one Haiku classification call + a cheap query answer — not a full diagnostic ReAct loop that eventually decides to just answer the question. The classifier is $0.0001; the wrong-agent penalty is $0.10.

**(c) Two chat endpoints (no classification at all).** Force the UI to expose "ask" and "investigate" as separate buttons. Loses on UX — the user often doesn't know which one they mean until they read the answer. The classifier turns that ambiguity into a routing decision the system can make correctly ~95% of the time (Haiku's classification accuracy on the calibration set), which is far better than making the user guess.

---

## Consequences

**What this buys:**
- **Predictable latency and cost.** The per-phase p50 numbers in the baseline (diagnose 50s · d-judge 38s · recommend 51s · r-judge 90s · total 225s) are reproducible because the pipeline is fixed. A supervisor LLM would add variance from a routing turn that isn't in the current budget.
- **The deterministic failure story is short.** When the pipeline breaks, you know exactly which of two branch points did it (the route or the intent classifier) — not "somewhere in the supervisor's reasoning trace." Debugging is grep-able.
- **The evals are meaningful.** The regression gate (RFC-10) evaluates diagnostic + recommendation output quality. Because the pipeline order is fixed, "diagnosis quality" is a stable target — no confounding variable from a supervisor rerouting the workload between runs.

**What it costs:**
- **New agents are code changes, not config.** Adding a fourth agent means adding a new route or a new `step` value. This is fine at 3 agents; it would get repetitive at 20. The pattern doesn't scale to a large agent zoo.
- **The intent classifier can misclassify.** A phrase like "why is checkout dropping in Germany" could route either way. The current code treats classification failures as "route to query" (safe fallback — cheap and answers most questions). If misclassification becomes a real UX complaint, the fix is not "add a supervisor LLM," it's "improve the classifier prompt with calibration data."
- **No dynamic re-planning mid-flight.** A supervisor LLM could notice mid-run that the diagnostic is going the wrong way and re-route. This one can't. In practice the ReAct loop inside the diagnostic agent handles this — the LLM within an agent picks tools freely, so re-planning happens one altitude down.

**What the reviewer will push on:**
> "You don't have real multi-agent orchestration. This is just three agents behind a switch statement."

Own the framing. The answer is: exactly. The supervisor pattern earns its complexity when the routing decision is genuinely hard (unknown workload, dynamic tool availability, agents whose costs vary by an order of magnitude at runtime). None of that applies here. A switch statement is the right primitive for a routing problem with three known branches. Reaching for an LLM supervisor when a switch works is architecture theater.

---

## Open questions

- **When would we add a supervisor LLM?** Concrete trigger: the day the app has ≥6 agents whose applicability depends on the workspace's data shape (e.g. "this workspace has recommender-service data, so run the recommender-quality agent"). At that point the routing decision becomes hard enough to earn a model turn.
- **Should the intent classifier see conversation history?** Today it labels the single incoming message. Multi-turn context would help ambiguous follow-ups ("and what about mobile?") — but adds prompt tokens on the hottest path (every chat message). Deferred until we have a real accuracy problem to solve.
