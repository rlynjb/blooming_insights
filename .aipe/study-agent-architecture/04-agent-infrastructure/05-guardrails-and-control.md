# Guardrails and control

**Industry standard.** The controls that bound an autonomous loop. **Deeply exercised** in this repo — the control envelope is the strongest infrastructure piece.

## Zoom out, then zoom in

Sits around the agent loop as the control envelope — input guardrail at one end, output guardrail at the other, iteration / token / cost caps inside. The envelope is what keeps an autonomous loop from being a runaway loop.

```
  Zoom out — where this concept lives

  ┌─ Input ──────────────────────────────────────────┐
  │  ★ input guardrail (validate / sanitize) ★      │ ← we are here
  └───────────────────────┬──────────────────────────┘
                          ▼
  ┌─ Agent loop ─────────────────────────────────────┐
  │  ★ iteration cap, cost budget, tool allowlist ★  │ ← we are here
  └───────────────────────┬──────────────────────────┘
                          ▼
  ┌─ Output ─────────────────────────────────────────┐
  │  ★ output guardrail (schema, safety, no direct  │
  │    side effects) ★                              │ ← we are here
  └──────────────────────────────────────────────────┘
```

## Structure pass

Layers: input guardrails (gates before the loop) → loop guardrails (caps inside the loop) → output guardrails (gates after the loop).

**Axis traced — "what could go wrong here?":** at each layer, a specific failure mode is bounded. Input: prompt injection, out-of-scope requests. Loop: runaway cost, infinite loops, tool-allowlist violations. Output: unstructured outputs that crash downstream, side effects from model output.

**Seam:** the boundary between "the model emits something" and "your code acts on it." That seam IS the safety story — the model emits intent; your code decides what to do with it.

## How it works

### Move 1 — the mental model

You know the principle "never trust client input" in a web app. The frontend can ask the server for anything; the server validates, authorizes, and decides what to do. Agent guardrails are the same principle applied to the LLM: the model can emit anything; your runtime validates, bounds, and decides what's allowed to execute.

```
  The control envelope

  ┌─────────────────────────────────────────────────┐
  │  Input guardrail   (validate / sanitize)        │
  └────────────────────┬────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────┐
  │  Agent loop                                      │
  │   • iteration cap (max steps)                    │
  │   • token / cost budget (halt at ceiling)        │
  │   • per-agent tool allowlist                     │
  │   • human-in-the-loop pause (gated actions)     │
  └────────────────────┬────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────┐
  │  Output guardrail (schema, safety check,        │
  │  never let agent output trigger side effects     │
  │  directly — go through your code)               │
  └─────────────────────────────────────────────────┘
```

### Move 2 — step by step

#### Input guardrail — what's there and what's not

The repo's input guardrails are partial:

- **Schema coverage gate (monitoring only).** Before the monitoring agent's loop starts, `schemaCapabilities → coverageReport → runnableCategories` filters the 10 categories down to the ones the workspace schema can actually answer (`app/api/briefing/route.ts:234-246`). Categories without the required signals are skipped entirely — the model never sees them in its checklist. This isn't input sanitization in the prompt-injection sense; it's *capability gating* applied to the input.

- **Intent classifier (query agent only).** When the user types in the QueryBox, `classifyIntent` (Haiku, single-shot) routes the request to the right agent flavor. Today the dispatch is "always run QueryAgent," but the classifier IS the input router. If the dispatch grew to fork by intent, the classifier would be the gate that decides.

- **No prompt-injection sanitization.** The user's free-form question (`?q=` on the agent route) is passed unchecked into the agent's prompt. There's no allowlist of acceptable phrasings, no LLM-driven "is this prompt-injection?" check, no sanitization of common injection patterns. This is the gap the team would close if the QueryBox started receiving adversarial input — today the volume (one user during a demo) doesn't justify the cost.

The honest framing: this repo's input guardrails are scoped to what the use case demands. Production agent systems with user-facing free-form input (customer support, public chatbots) would need richer input sanitization — at minimum a prompt-injection detector and a content-safety pre-filter.

#### Loop guardrails — the strongest piece

Every agent runs inside a hard control envelope:

**Iteration cap.** `maxTurns = 8` is the default in `runAgentLoop` (`run-agent-loop.js:21`). When the `for` loop completes without break, the loop exits — the agent can't continue past 8 turns no matter what. The monitoring agent additionally enforces `maxToolCalls = 6` (`monitoring-agent.js:56`) so even within turns the tool budget is bounded.

**Token cap per turn.** `maxTokens = 4096` per `model.complete` call (`run-agent-loop.js:21`). The model can emit at most 4096 output tokens per turn; longer responses get truncated by the provider. With 8 turns × 4096 tokens × N input tokens per turn, the worst-case per-investigation token cost is bounded.

**Per-call AbortSignal.** Every agent constructor accepts a hooks object with an optional `signal: AbortSignal`. The signal flows through `runAgentLoop` (line 26: `signal?.throwIfAborted()`), through each `model.complete` call (line 34: `signal`), through each `tools.callTool` (line 76: `{ signal }`). The route handler threads `req.signal` down through the agent — when the client closes the tab, the abort propagates through the entire stack and cancels in-flight work.

**Per-call MCP transport timeout.** Beyond the agent's signal, `BloomreachDataSource` enforces a per-call 30-second hard timeout on the MCP transport via `AbortSignal.timeout(30_000)`. A hung MCP call can't burn the full 300s route budget.

**Per-route Vercel timeout.** `maxDuration = 300` at the route level (`app/api/briefing/route.ts:19`, `app/api/agent/route.ts:22`). The whole request is killed after 5 minutes if nothing else has fired. This is the absolute backstop.

**Per-agent tool allowlist.** `filterToolsForPolicy(allTools, *ToolPolicy)` narrows the model's tool surface to the minimum its task needs. The model can't emit `tool_use` for a tool outside the allowlist — those tools aren't in the schema list it receives. This is capability-based access control at the model boundary.

**No human-in-the-loop pause.** The repo doesn't have an "agent pauses, waits for human approval, resumes" pattern. The closest thing is the user clicking through screens (between the diagnose and recommend steps), but that's a deterministic pipeline boundary, not a model-gated approval. If the product added high-stakes actions (e.g. "auto-execute this recommendation"), human-in-the-loop would land here.

#### Output guardrails — the structured-output discipline

The repo's output guardrails are structural:

**Structured-output validators.** `tryParseAnomalies`, `tryParseDiagnosis`, recommendation validators run on the model's final text. Each is in the corresponding AptKit package (`@aptkit/agent-anomaly-monitoring/.../validate.js`, etc.). They parse the JSON fence out of the model's text, validate against the expected schema, and return null on failure.

**Recovery prompt** (monitoring only). When `tryParseAnomalies` returns null, `runAgentLoop` fires the `recoveryPrompt` — one extra model call with just the tool evidence and a "convert this to the structured form" instruction (lines 106-114 of `run-agent-loop.js`). It's bounded (one call, no tools) and gated (only fires when parse fails AND a recovery prompt is configured). Only the monitoring agent configures one; the others either accept whatever parses or fall back to an empty result.

**No model-driven side effects.** This is the load-bearing one. The recommendations the recommendation agent produces are **proposals** — they show up in the UI as cards the user reads. The agent's output never directly creates a Bloomreach scenario, never sends a campaign, never modifies any workspace state. The model emits structured `Recommendation[]` data; the user is the actor that decides whether to implement.

This separation is part of the prompt-injection defense even without explicit injection sanitization. The worst case from a poisoned prompt is the model emits a wrong-but-plausible recommendation; the user reads it and (if it's egregious) ignores it. The model never directly does anything to the workspace.

The "never let agent output trigger side effects directly" rule shows up in the route handlers too — the agents' outputs flow through the NDJSON stream to the UI; nothing in the server-side path takes an action based on the agent's output beyond emitting it on the wire.

### Move 3 — the principle

**Guardrails make autonomy safe at scale.** Without caps, an agent can loop forever burning tokens. Without allowlists, it can call any tool the runtime exposes. Without output gates, its emissions can trigger arbitrary side effects. Each guardrail bounds a specific failure mode; the envelope of guardrails is what turns "I have an agent loop" into "I have an agent loop I can deploy." The interview-grade move is to name every guardrail in your envelope and the failure mode it bounds — the absence of an answer for any layer is the signal to add one.

## Primary diagram

```
  The full control envelope in this repo

  USER REQUEST
       │
       ▼
  ┌─ Input guardrail (route handler) ────────────────────────────┐
  │   /api/briefing:                                              │
  │     schemaCapabilities → coverageReport → runnableCategories  │
  │     (categories without required signals skipped)             │
  │   /api/agent (q):                                             │
  │     classifyIntent (Haiku, deterministic)                     │
  │   /api/agent (insightId):                                     │
  │     resolveAnomaly (typed lookup, fail with 404 if absent)   │
  │   (no prompt-injection sanitization — gap)                    │
  └───────────────────────┬──────────────────────────────────────┘
                          ▼
  ┌─ Agent loop guardrails ──────────────────────────────────────┐
  │                                                                │
  │   maxTurns = 8           (run-agent-loop.js:21)               │
  │   maxToolCalls = 6       (monitoring only; monitoring-        │
  │                           agent.js:56)                         │
  │   maxTokens = 4096       per turn (run-agent-loop.js:21)      │
  │   tool allowlist         per-agent *ToolPolicy.allowedTools   │
  │     (4 / 11 / 14 / 33)   filterToolsForPolicy applied         │
  │   AbortSignal             threaded from req.signal to every    │
  │     cancellation          model.complete and tools.callTool   │
  │   MCP per-call timeout    30s hard cap in transport            │
  │   route timeout           300s Vercel maxDuration              │
  │   no human-in-the-loop    (deterministic pipeline boundaries  │
  │     pause                 instead)                             │
  │                                                                 │
  │   forced final turn:                                            │
  │     on last turn or maxToolCalls reached:                      │
  │       tools stripped from request                              │
  │       synthesisInstruction injected into system prompt         │
  │       model has no choice but to synthesize                    │
  └───────────────────────┬──────────────────────────────────────┘
                          ▼
  ┌─ Output guardrail (post-loop) ───────────────────────────────┐
  │                                                                │
  │   structured-output validators:                                │
  │     tryParseAnomalies / tryParseDiagnosis / rec-validators    │
  │   on parse fail (monitoring only):                            │
  │     runRecoveryTurn (single-shot, no tools, recoveryPrompt)   │
  │   on still-parse-fail: return [] or partial                   │
  │                                                                │
  │   no model-driven side effects:                                │
  │     Recommendation[] is a PROPOSAL; user decides to act        │
  │     no agent call ever creates a Bloomreach scenario,         │
  │     sends a campaign, or modifies workspace state             │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "model emits intent, code decides whether to execute" pattern is the foundational safety property of every shipped agent system. It maps to the long-standing security principle that any input crossing a trust boundary must be validated before action. The model's output IS such an input — the trust boundary is "this came from the LLM, treat it as untrusted." Code validates, gates, and decides.

The recommendations-as-proposals choice in this repo is the strongest expression of this. Many "agentic" demos let the model directly take actions (auto-send emails, auto-execute trades, auto-merge PRs). Those demos are exciting and dangerous. Production agent systems that have done the safety math correctly almost always insert a human-in-the-loop gate between agent output and side effects, especially when actions are irreversible. The team's choice here — agent proposes, human disposes — is the safety-correct default.

The "no input sanitization" gap is the honest weak spot of the current envelope. Prompt injection is a real and growing threat surface for agent systems with free-form user input; the OWASP LLM Top 10 lists it as the #1 risk. The mitigations are well-known (input sanitization, instruction-tuning the prompt to ignore embedded instructions, output validation) but none are in place here today. The volume and context (one user during a demo, no PII or financial data flowing through the agent) keep the risk acceptable; production scale would require closing the gap.

The Anthropic SDK's tool-use is structurally safer than custom action-emitting prompts because the typed `tool_use` block constrains what the model can ask for to the schema you defined. The model can't emit "send_email(any_address)" if your tool schema is "send_email(verified_address_from_user_session)" — the schema enforces the parameter. This is one of the reasons MCP + tool calling is the right substrate for agent systems: the structure carries safety properties the prompt alone can't.

## Interview defense

> **Q: What's the control envelope around this codebase's agents?**
>
> Input, loop, output, all three layers. Input: schema-coverage gate filters which monitoring categories run, intent classifier routes the QueryBox to the right agent flavor, anomaly resolution fails with 404 if the insightId is absent. Loop: `maxTurns=8`, `maxToolCalls=6` (monitoring), `maxTokens=4096` per turn, per-agent tool allowlist (4-33 tools), AbortSignal threaded from `req.signal` through every model call and tool call, per-call 30s MCP timeout, per-route 300s Vercel timeout. Output: structured-output validators (`tryParseAnomalies`, etc.) parse against schemas with a recovery prompt for monitoring, and — critically — the agent's output never triggers side effects directly. The recommendations are proposals the user reads, not actions the system takes.

> **Q: What's the most important guardrail and why?**
>
> "Agent output never triggers side effects directly." Every other guardrail bounds cost or quality; this one bounds *consequences*. The model could emit a wrong recommendation, a prompt-injected recommendation, or a hallucinated recommendation, and the worst case is the user reads it and decides not to implement. No Bloomreach scenario gets created, no campaign gets sent, no workspace state changes. The OWASP LLM Top 10 lists prompt injection as the #1 agent risk; the mitigation that scales best across all variations is "agent proposes, code or human disposes." This repo has that as the default for every agent output, not just risky ones.

> **Q: What's missing from the envelope?**
>
> Three things. Input sanitization for the QueryBox — the user's free-form question goes unchecked into the agent's prompt; a prompt-injection detector would close that gap if the QueryBox started receiving adversarial input. A live per-run dollar budget — today the hard caps bound the *theoretical* max cost to maybe $0.50 per investigation, but there's no gate that halts at a threshold; for higher-volume use that would be cheap insurance. And human-in-the-loop pauses for high-stakes actions — not needed today because there are no high-stakes actions (recommendations are proposals), but the moment any agent path could auto-execute, this becomes mandatory.

> **Q: Why is `maxTurns` part of the kernel and not a hardening pass you add later?**
>
> Because without it the agent can loop forever — burning tokens with no termination signal. The success exit (model emits no `tool_use`) requires the model to *choose* to stop; nothing guarantees it ever does. The budget exit (`for` loop completes) is the harness *forcing* it to stop. Both exits are required for an agent to be shippable. Treating `maxTurns` as bolt-on hardening means there's a window where the loop has no upper bound — and that's the window someone ships an agent in, gets a $500 bill the next morning, and learns the hard way. The kernel-as-skeleton framing (file `02-agent-loop-skeleton.md`) makes this explicit: termination is one of the four load-bearing parts, not an afterthought.

## See also

- → `01-reasoning-patterns/02-agent-loop-skeleton.md` — the budget exit is one of the four skeleton parts
- → `02-agentic-retrieval/03-retrieval-routing.md` — the per-agent allowlist as capability gating
- → `03-multi-agent-orchestration/09-coordination-failure-modes.md` — the failure modes the envelope bounds
- → `05-production-serving/03-per-tool-circuit-breaking.md` — the wire-level tool failure handling
- → cross-reference (when generated): `study-ai-engineering`'s prompt-injection and error-recovery files — the per-call defenses this envelope wraps
- → cross-reference (when generated): `study-security`'s LLM-risk file — the OWASP LLM Top 10 mapped to this envelope's gaps
