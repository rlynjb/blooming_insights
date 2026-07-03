# Guardrails and control

_Industry standard._

## Zoom out, then zoom in

The control envelope around an autonomous loop. Blooming's version is code-driven and layered: input side (session isolation, workspace bootstrap), loop side (BudgetTracker check-before-dispatch, AptKit iteration caps, AbortSignal cancellation), output side (type guards on Diagnosis and Recommendation, fixed enums on `bloomreachFeature`). Every guardrail lives OUTSIDE the model's decision surface.

```
  Zoom out — the control envelope

  ┌─ Input side ────────────────────────────────────────────────┐
  │  session cookie (isolation) + workspace schema (bounded)     │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼
  ┌─ Agent loop (bounded) ───────────────────────────────────────┐
  │  · BudgetTracker check-before-dispatch (aptkit-adapters:64)  │
  │  · AptKit maxTurns=8, maxToolCalls=6                          │
  │  · AbortSignal threaded from req.signal                       │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼
  ┌─ Output side ────────────────────────────────────────────────┐
  │  · isDiagnosis, isRecommendationArray (mcp/validate.ts)      │
  │  · fixed enums: bloomreachFeature, confidence                 │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the load-bearing part is *where the controls live*. Prompt instructions ("don't exceed the budget") can be ignored by the model. Code checks (`if (budget.exceeded()) throw`) cannot. This file walks each control and names why it lives in code, not in a prompt.

## Structure pass

**Layers:** input validation · loop bounds · output validation.
**Axis:** *can the model bypass this control by choosing to?*
**Seam:** the boundary between "prompt-level" and "code-level" enforcement. Every load-bearing control in this repo is code-level.

```
  Control taxonomy — where does the enforcement live?

  Control                          Enforcement location
  ──────────────────────────────  ────────────────────────
  BudgetTracker ceiling           TypeScript code
  AptKit maxTurns/maxToolCalls    aptkit runtime
  AbortSignal cancellation        req.signal → Anthropic SDK
  isDiagnosis type guard          TypeScript code
  bloomreachFeature enum          TypeScript union type
  Session isolation               Map<sessionId, ...> in code
  Rate-limit retry ceiling        BloomreachDataSource code

  ★ Zero prompt-level "please don't exceed X" instructions. ★
```

## How it works

### Move 1 — the mental model

You've written an API endpoint with a rate limiter, a validator on the request, and a validator on the response. Guardrails around an agent are the same shape at a different granularity: rate-limit the *iteration count*, validate the *artifact structure*, cancel via *AbortSignal* just like an HTTP request. The difference is that the "handler" in the middle is autonomous — it decides what tools to call — so the bounds have to be tighter.

```
  Pattern: bounded loop

  ┌─ Enter loop ────────────────────┐
  │  budget = new BudgetTracker(...) │
  └─────────┬────────────────────────┘
            ▼
  ┌─ Every turn ────────────────────┐
  │  1. budget.exceeded()? → throw   │
  │  2. signal.aborted? → throw       │
  │  3. dispatch model call           │
  │  4. budget.add(usage)             │
  │  5. AptKit checks turn count      │
  │     against maxTurns             │
  └─────────────────────────────────┘
```

### Move 2 — the walkthrough

**The BudgetTracker — `lib/agents/budget.ts:41-77`.** The primary cost/token ceiling. Takes a `BudgetLimit` (either `maxTokens` or `maxCostUsd` or both), accumulates usage per turn, checks before the next dispatch.

```ts
// lib/agents/budget.ts:41-77 — the tracker
export class BudgetTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private turns = 0;

  constructor(
    public readonly limit: BudgetLimit,
    private readonly modelName: string = 'claude-sonnet-4-6',
  ) {}

  add(usage: { inputTokens: number; outputTokens: number }): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.turns += 1;
  }

  exceeded(): boolean {
    const s = this.snapshot();
    if (this.limit.maxTokens != null && s.totalTokens > this.limit.maxTokens) return true;
    if (this.limit.maxCostUsd != null && s.estimatedCostUsd > this.limit.maxCostUsd) return true;
    return false;
  }
}
```

Line-by-line:

- **Two ceilings, not one.** `maxTokens` bounds compute; `maxCostUsd` bounds dollar spend. The eval load harness uses `maxCostUsd: 2` — plenty of headroom over the p50 $0.07 typical case, but a hard stop against a runaway.
- **Cost uses `estimateAnthropicCost` from `lib/agents/pricing.ts`.** Blooming's pricing helper, not aptkit's (aptkit only knows OpenAI). Same numbers as the eval report — one source of truth for pricing.
- **The tracker is read-only from the adapter's perspective.** The adapter calls `add()` after each response and `exceeded()` before the next call. It never mutates limits.

**The check-before-dispatch — `lib/agents/aptkit-adapters.ts:60-66`.** The gate:

```ts
// aptkit-adapters.ts:60-66 — check BEFORE dispatching
async complete(request: ModelRequest): Promise<ModelResponse> {
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }
  // ... build params, call Anthropic ...
  this.budget?.add({ inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens });
```

Line-by-line:

- **Check BEFORE, not after.** The point is to *prevent* the next API call once the ceiling is hit. Checking after would burn one more call every time.
- **`BudgetExceededError` is a typed error.** Route handler catches it specifically (`app/api/agent/route.ts` outer try/catch) and emits a graceful NDJSON `error` event. UI renders "budget exceeded" instead of a crash.
- **Optional (`this.budget?`).** When no tracker is passed, behavior is exactly as before — no gate. Load harness always passes one; the production route passes one; test suites can omit.

**AptKit iteration caps.** Inside AptKit's `runAgentLoop`, `maxTurns=8` and `maxToolCalls=6` bound how deep any single agent can dig. These are set in AptKit's config, not blooming code — the load-bearing part is that blooming *doesn't override them to loosen*. Tight loops fail fast; loose loops burn budget silently.

**AbortSignal cancellation — from `req.signal` down to Anthropic.** Every agent constructor takes `signal?: AbortSignal` via the hooks object. It threads down to `AnthropicModelProviderAdapter.complete` and then into `this.anthropic.messages.create(params, { signal })`. When the user closes the tab, `req.signal.aborted` becomes true, in-flight calls cancel cleanly, no zombie work continues.

**Type guards on the output — `lib/mcp/validate.ts`.** Post-agent structural validation:

```ts
// lib/mcp/validate.ts:29-56 — the guards
export function isDiagnosis(v: unknown): v is Diagnosis {
  if (!v || typeof v !== 'object') return false;
  const d = v as any;
  return typeof d.conclusion === 'string'
    && Array.isArray(d.evidence)
    && Array.isArray(d.hypothesesConsidered);
}

// isRecommendationArray enforces:
//  - bloomreachFeature ∈ {scenario, segment, campaign, voucher, experiment}
//  - confidence ∈ {high, medium, low}
//  - estimatedImpact shape (string OR {range, ...})
```

Line-by-line: shape validation *plus* enum enforcement. The model cannot propose a novel `bloomreachFeature` — it must pick one of five. This is the safety-property version of "make invalid states unrepresentable" from Rust/Elm design.

**Not implemented: human-in-the-loop gate at the model layer.** Blooming has a *product-level* human gate — the user clicks from `/investigate/[id]` to `.../recommend` explicitly, so the recommendation stage doesn't run without confirmation. That's a good-enough human gate for the current product. A graph runtime would enable server-side pauses (see `03-multi-agent-orchestration/07-graph-orchestration.md`), but the URL-as-checkpoint pattern serves the current need.

```
  Layers-and-hops — every guardrail's site

  ┌─ Request (req.signal) ──────────────────────────────────────┐
  │  bi_session cookie → sessionId → scope key                   │
  └───────────────────────────┬─────────────────────────────────┘
                              │ (signal threaded from here down)
                              ▼
  ┌─ /api/agent handler ────────────────────────────────────────┐
  │  budget = new BudgetTracker({ maxCostUsd: 2 })              │
  │  passes budget + signal into each agent                     │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼
  ┌─ AnthropicModelProviderAdapter ─────────────────────────────┐
  │  every complete():                                          │
  │    if (budget.exceeded()) throw BudgetExceededError         │
  │    if (signal.aborted) → SDK throws                          │
  │    ... dispatch ...                                          │
  │    budget.add(usage)                                        │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼
  ┌─ Post-agent: mcp/validate.ts guards ────────────────────────┐
  │  isDiagnosis(result) → reject if shape wrong                 │
  │  isRecommendationArray(result) → reject if enum unknown      │
  └─────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Guardrails belong outside the model's decision surface. A prompt-level "don't exceed the budget" instruction is a suggestion the model can ignore or that adversarial input can override. A code-level `if (budget.exceeded()) throw` is enforced by the runtime and cannot be jailbroken. Same principle for output: asking the model to "please return valid JSON" is a suggestion; type-guarding the response is enforcement. Blooming's rule for every load-bearing control: if it protects the system, it lives in TypeScript, not in a prompt. That posture is what turns a demo into a production system.

## Primary diagram

```
  Recap — the control envelope in this repo

  Input side:
  ┌───────────────────────────────────────────────┐
  │  Session isolation: bi_session cookie scopes  │
  │  every state Map by sessionId                 │
  │  Bootstrap: workspace schema fetched once,    │
  │  bounded via schemaSummary                    │
  └───────────────────────────────────────────────┘

  Loop side:
  ┌───────────────────────────────────────────────┐
  │  BudgetTracker check-before-dispatch          │
  │    - maxTokens ceiling                        │
  │    - maxCostUsd ceiling                       │
  │  AptKit iteration caps: maxTurns=8, max=6     │
  │  AbortSignal from req.signal → Anthropic      │
  └───────────────────────────────────────────────┘

  Output side:
  ┌───────────────────────────────────────────────┐
  │  isDiagnosis: shape + array types             │
  │  isRecommendationArray: shape + fixed enums   │
  │    ─ bloomreachFeature ∈ 5 values             │
  │    ─ confidence ∈ 3 values                    │
  │  Type guards reject before UI renders          │
  └───────────────────────────────────────────────┘

  Human-in-the-loop:
  ┌───────────────────────────────────────────────┐
  │  Product-level: user clicks investigate →     │
  │  recommend (URL-as-checkpoint, not a runtime  │
  │  pause). Sufficient for current scope.        │
  └───────────────────────────────────────────────┘
```

## Elaborate

The design instinct here — controls outside the model — is the same one behind SQL parameter binding vs string concatenation. Prompt injection is roughly what SQL injection was in the early web: user-controlled input flowing into a decision surface. If the "control" against injection is a prompt instruction, it can be overridden. If it's a code-level type guard on the output, it can't.

Blooming's BudgetTracker specifically is Phase-3 defensive infrastructure. Before it, a runaway agent loop could burn budget silently — the AptKit `maxTurns=8` cap eventually stopped it, but not before spending the tokens. The tracker adds a hard USD ceiling that catches the runaway *before* the next API call, so the cost surface is bounded even if the iteration count would allow more.

The `isDiagnosis` + `isRecommendationArray` guards are also load-bearing at the eval seam. `eval/report.eval.ts` grades diagnoses and recommendations; if the shape is malformed, grading is nonsense. The guards ensure that only well-formed artifacts reach the grader, so eval quality is not contaminated by structural failures. This is the version of "test in production" that's actually safe — production artifacts must pass the same guards test fixtures do.

Where blooming's guardrail story is thinnest: prompt injection defense. There's no input sanitization on user queries in the query flow (the `q` param). A malicious user could try to hijack the agent via crafted query. The current mitigations are indirect: (a) queries go through `classifyIntent` first which maps to an enum, filtering out unrelated behavior; (b) the schemaSummary bounds what data the agent knows about; (c) tool calls are bounded by the fixed MCP tool set. But there's no explicit "reject prompt injection attempts" step, which would be the natural next hardening. `study-ai-engineering`'s prompt-injection file covers the per-call defenses.

## Interview defense

**Q: What guardrails does this system have, and where do they live?**
A: Three tiers, all code-level, none prompt-level. Input side: session cookie isolation via `Map<sessionId, ...>` so users don't collide; workspace schema fetched once and bounded via `schemaSummary`. Loop side: `BudgetTracker` in `lib/agents/budget.ts` with USD and token ceilings, checked BEFORE dispatch in `aptkit-adapters.ts:64` so a runaway can't burn additional cost after the ceiling; AptKit's built-in `maxTurns=8` and `maxToolCalls=6` bound depth; `AbortSignal` threaded from `req.signal` cancels cleanly when the user closes the tab. Output side: type guards `isDiagnosis` and `isRecommendationArray` in `lib/mcp/validate.ts` enforce shape and fixed enums (`bloomreachFeature` must be one of five values). Every load-bearing control is TypeScript, not a prompt instruction — prompts can be jailbroken, code cannot.

Diagram: the three-tier envelope with each control at its site.
Anchor: `lib/agents/budget.ts:41-77` + `lib/agents/aptkit-adapters.ts:60-66` + `lib/mcp/validate.ts:29-56`.

**Q: What's the thinnest part of your guardrail story, and how would you close it?**
A: Prompt injection defense on the query flow. There's no input sanitization on the free-form `q` param — a malicious user could craft a query to hijack the agent. Current indirect mitigations: `classifyIntent` maps queries to a fixed enum (filters unrelated behavior), the bounded `schemaSummary` limits what data the agent knows, and the MCP tool set is fixed. But there's no explicit rejection step. To close: add a Haiku-based sanitizer in front of `classifyIntent` that rejects prompts matching known jailbreak patterns, and consider a same-family-model output check on responses that look off-topic. Cost per query: another Haiku call, negligible against the Sonnet loop it protects.

Diagram: the current input flow beside the hardened version with sanitizer added.
Anchor: `lib/agents/intent.ts` (the current classifier); cross-reference `study-ai-engineering`'s prompt-injection file.

## See also

- `03-multi-agent-orchestration/09-coordination-failure-modes.md` — the failure-mode ⇄ mitigation pairs.
- `05-production-serving/04-cost-controls.md` — the BudgetTracker + prompt cache + pricing helper together.
- `01-context-engineering.md` — the input-side bounding via schemaSummary.
- `03-tool-calling-and-mcp.md` — the fixed tool set as a control surface.
