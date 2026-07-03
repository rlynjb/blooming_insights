# Guardrails and control

*Industry names: guardrails / control envelope / policy layer · Industry standard*

## Zoom out

```
  Zoom out — the control envelope around any autonomous loop

  ┌─ input from user ────────────────────────────┐
  │  what enters                                  │
  └─────────────┬────────────────────────────────┘
                ▼
  ┌─ ★ INPUT GUARDRAIL ★                          │
  ┌─ agent loop ─────────────────────────────────┐
  │  ★ ITERATION + BUDGET + HUMAN-IN-LOOP CAP ★  │ ← we are here
  └─────────────┬────────────────────────────────┘
                ▼
  ┌─ ★ OUTPUT GUARDRAIL ★                         │
  ┌─ side effects / storage / user ──────────────┐
  │  what leaves                                  │
  └──────────────────────────────────────────────┘
```

## Zoom in

The controls that bound an autonomous loop. Three positions: input (validate before), during (iteration caps, token/cost budgets, human-in-loop gates), output (schema, safety check, never let agent output trigger side effects directly). Cross-refs `.aipe/study-ai-engineering/`'s prompt-injection and error-recovery files for the per-call defenses; this file covers them as the *control envelope* around an autonomous loop.

## Structure pass

Layers: **input** — **loop control (iteration + budget + pause)** — **output**.

Axis to hold constant: **at each position, what threat does the control mitigate?**

```
  Three positions, three threats

  Input:  malformed / adversarial input (prompt injection,
          garbage data)
  Loop:   runaway (infinite loop, cost blowup, tool cascade)
  Output: unsafe side effects (hallucinated actions, unauthorized
          state changes, format violations)
```

## How it works

### Move 1 — the shape

You've wrapped a function with validate-run-serialize before. Same shape here, with the middle step being an autonomous loop that needs its own controls.

```
  The control envelope — three positions

  ┌───────────────────────────────────────────────┐
  │  Input guardrail   (validate / sanitize)      │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Agent loop                                   │
  │   • iteration cap (max steps)                 │
  │   • token / cost budget (halt at ceiling)     │
  │   • human-in-the-loop pause (gated actions)   │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Output guardrail  (schema, safety check,     │
  │  never let agent output trigger side effects  │
  │  directly — go through your code)             │
  └───────────────────────────────────────────────┘
```

### Move 2 — the specific controls in this repo

**Input guardrails.** Two layers.

1. **URL param validation.** The route handler parses `?step=…`, `?insight=…`, `?diagnosis=…`, `?q=…` and validates each shape before use. `parseDiagnosis()` in `app/api/agent/route.ts:85-97` validates the Diagnosis shape (`conclusion: string`, `evidence[]`, `hypothesesConsidered[]`) before the RecommendationAgent gets it.

2. **Free-form query is bounded.** The `?q=…` value is a string trimmed, capped implicitly by URL length, and passed to `classifyIntent(anthropic, q)` — which uses Haiku to classify into a bounded intent enum. The QueryAgent then shapes behavior by intent. There is no unfiltered pass-through from user text to tool calls.

Notably: **the current input guardrail does not run a prompt-injection scanner.** Adversarial input in the free-form query could try to override the system prompt. The current defense is (a) the classifier's intent enum bounds the downstream agent's behavior, (b) the MCP tools are read-only for the workspace — an injection can't trigger destructive actions because no destructive tools exist. If write-tools ever ship, an input guardrail scan (Anthropic's prompt-injection classifier, or a regex sanitizer) becomes mandatory.

**Loop controls — three, in order of importance.**

```
  1. ITERATION CAP (aptkit-owned, per agent)
     max ReAct turns before force-return
     mitigates: infinite loop on unreachable success exit

  2. TOKEN/COST BUDGET (BudgetTracker, shared across agents)
     see lib/agents/budget.ts
     check BEFORE dispatch, throws BudgetExceededError
     mitigates: cost blowup, silent long-tail

  3. CANCELLATION SIGNAL (req.signal, threaded end-to-end)
     from route → agent → adapter → Anthropic SDK
     from route → agent → adapter → DataSource → MCP transport
     mitigates: client navigation abandons work → still burns budget
```

The cancellation signal is the underappreciated one. Without it, a user closing the tab mid-investigation leaves an agent running for another 100s spending budget. With it, the route's `req.signal.throwIfAborted()` fires at every phase boundary, and the same signal is passed through every layer's `signal` parameter.

**Human-in-the-loop gate.** Coarse in this repo — the user navigates between pages (feed → step 2 → step 3). Each page issues a fresh request. There is no server-side "pause and resume" mechanism. If any node needed to pause for real human approval (days, not seconds), the escalation is graph orchestration with a checkpointer (see `03-multi-agent-orchestration/07-graph-orchestration.md`).

**Output guardrails.**

1. **Schema-validated final outputs.** aptkit's ReAct loop emits structured output — `Diagnosis` / `Recommendation[]` — validated by type at the aptkit and Blooming boundaries. A run that doesn't produce a validly-shaped output errors out; it doesn't emit a partial one to the UI.

2. **No agent-triggered side effects.** All MCP tools in the current tool set are **read-only** for the workspace — they query metrics, list scenarios, get segment definitions. There is no `create_campaign`, no `send_email`, no `modify_segment`. This is the strongest possible output guardrail: the agent literally cannot trigger side effects because no side-effecting tools exist.

The design implication: the Recommendations the agent proposes are *suggestions the user acts on*, not actions the agent takes. The user reads a Recommendation like "create a campaign for the payment-failure segment," decides to act, and does it in Bloomreach themselves. The agent output triggers no side effect directly. This is the correct pattern for an analyst product — proposal, not execution.

3. **What ships in a future action-taking version.** If the product ever added write-tools:

```
  Write-tool guardrails (hypothetical)

  Action gating:
    - some actions require human approval before execution
      (creating a campaign, modifying a segment)
    - some actions are auto-executable (dry-run, previewing)
    - gate stored in tool metadata, checked by route before dispatch

  Action auditing:
    - every write-tool call logged with agent + user + timestamp
    - reversibility flag: can this action be undone?
    - dead-man switch: if agent tries to execute 5+ write-tools
      in one investigation, force human approval

  These do not exist today because no write-tools exist today.
```

### Move 2.5 — the receipts

**BudgetTracker is checked BEFORE dispatch.** The load-bearing shape:

```ts
// lib/agents/aptkit-adapters.ts:60
if (this.budget?.exceeded()) {
  throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
}
```

Not after the call, before. Checking after would let one call slip past the ceiling; before makes it exact. The route catches the throw and emits a graceful NDJSON error event; the UI shows a proper "budget exceeded" state.

**AbortSignal composition — the cancellation seam.** `req.signal` flows into every async layer:

```
  Cancellation propagation

  route: req.signal.throwIfAborted() at each phase
    │
    ▼
  bootstrap(req.signal) → MCP calls carry signal
  listTools({ signal }) → MCP calls carry signal
  classifyIntent(anthropic, q, sid, req.signal)
    │
    ▼
  DiagnosticAgent.investigate(anomaly, { signal, ... })
    │
    ▼
  AptKit agent loop passes signal to each model call
    │
    ▼
  AnthropicModelProviderAdapter.complete()
    - Anthropic SDK abort
    - dataSource.callTool({ signal })
       - MCP transport 30s timeout composed with signal
```

If the browser aborts (user navigates away, StrictMode remount, etc.), the abort propagates all the way down. This is real distributed cancellation — one of the underweighted guardrails in agent codebases.

### Move 3 — the principle

An agent without caps loops silently and burns tokens. An agent whose output triggers side effects directly is a prompt-injection liability. The three positions — input, loop, output — each carry specific threats and specific controls. The load-bearing lesson: **checking BEFORE dispatch** on the budget, and **cancellation signal threaded end-to-end**, are the two guardrails most codebases underweight and this repo doesn't.

## Primary diagram

```
  The control envelope in this repo — three positions, real controls

  ┌─ INPUT ────────────────────────────────────────────────────┐
  │                                                            │
  │  URL params validated:                                     │
  │    parseDiagnosis()  → shape check                         │
  │    step ∈ {diagnose, recommend}                            │
  │    insight parsed as JSON before use                       │
  │                                                            │
  │  Free-form q:                                              │
  │    → classifyIntent (Haiku) bounds to intent enum          │
  │                                                            │
  │  Prompt-injection scan: NOT SHIPPED                        │
  │    (safe today because tools are read-only)                │
  └─────────────────────────┬──────────────────────────────────┘
                            ▼
  ┌─ LOOP ─────────────────────────────────────────────────────┐
  │                                                            │
  │  iteration cap:           aptkit per-agent                 │
  │  token/cost budget:       BudgetTracker.exceeded()         │
  │                           check BEFORE dispatch            │
  │  cancellation:            req.signal end-to-end            │
  │  human-in-loop pause:     coarse — page navigation         │
  │                                                            │
  └─────────────────────────┬──────────────────────────────────┘
                            ▼
  ┌─ OUTPUT ───────────────────────────────────────────────────┐
  │                                                            │
  │  schema-validated:        Diagnosis, Recommendation[]      │
  │                           typed shapes                     │
  │  side effects:            NONE — all tools read-only       │
  │                           agent outputs are proposals,     │
  │                           not actions                      │
  │  NDJSON stream:           encodeEvent() enforces shape     │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The three-position control envelope traces to safety engineering (defense in depth) applied to agents. Anthropic's Claude Sonnet 4 system card, OpenAI's function-calling guidelines, and Guardrails AI's schema-validation library all describe variations of the same shape. The name "guardrails" is now genre — Nvidia's NeMo Guardrails, Guardrails AI, LangKit's evaluators — but the underlying discipline is the same.

The frontier is **learned guardrails** — small classifiers or embedding-similarity checks that flag suspicious inputs/outputs at LLM speed. Anthropic's prompt-injection classifier and Meta's Llama Guard are the reference points. For read-only agent products like this repo, the discipline is coarse (no write actions to guard); for action-taking agents, guardrails are load-bearing.

## Interview defense

**Q: What guardrails do you have?**

Three positions.

Input — URL params validated with typed parsers (`parseDiagnosis()` and friends). Free-form queries pass through a bounded intent classifier before hitting the agent. No prompt-injection scanner today; safe because all tools are read-only.

Loop — three controls in order of importance. aptkit iteration caps per agent. `BudgetTracker.exceeded()` checked BEFORE every model dispatch (not after — the shape matters). `req.signal` threaded end-to-end so a client abort cascades through Anthropic + MCP.

Output — schema-validated final outputs (`Diagnosis`, `Recommendation[]`). No agent-triggered side effects — all tools are read-only. Agent outputs are proposals for the user to act on, not actions the agent takes.

*Anchor visual:* the three-positions diagram above.

**Q: What's the load-bearing part most codebases miss?**

Two things.

First, the budget check runs BEFORE the model dispatch, not after. Checking after lets one call slip past the ceiling; checking before makes it exact. It's a 3-line change with a real invariant behind it.

Second, cancellation composed end-to-end. Most agent codebases handle route-level cancellation but drop the signal at the SDK boundary. This repo threads it through: route → agent → adapter → Anthropic SDK, route → agent → adapter → DataSource → MCP transport → 30s timeout composed with the incoming signal. When a client navigates away mid-investigation, everything downstream aborts.

**Q: When would you add an input prompt-injection scanner?**

The moment a write-tool ships. Right now the tool set is read-only — the worst an adversarial query can do is waste some budget with weird EQL. If Bloomreach exposed `create_campaign` or `modify_segment` MCP tools and I wanted the agent to call them, that's the escalation point. Anthropic's prompt-injection classifier is the first thing I'd try; a regex sanitizer as a cheap fallback.

## See also

- **`01-reasoning-patterns/02-agent-loop-skeleton.md`** — the budget exit belongs to the skeleton, not to a hardening pass.
- **`03-multi-agent-orchestration/07-graph-orchestration.md`** — real human-in-the-loop needs graph's checkpointer.
- **`03-multi-agent-orchestration/09-coordination-failure-modes.md`** — the failures these guardrails specifically catch.
- **`.aipe/study-ai-engineering/`** prompt-injection and error-recovery files.
