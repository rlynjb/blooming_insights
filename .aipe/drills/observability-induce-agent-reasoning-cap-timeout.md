competency:   Evals & observability                                   raises: L2 → L3
curriculum:   n/a (no aieng-curriculum.md Bx.y maps cleanly; closest is
              study-ai-engineering/05-evals-and-observability/README.md's
              "SLOs and per-invocation ceilings" line)
study ref:    .aipe/study-runtime-systems/07-backpressure-bounded-work-and-cancellation.md
              (the "layered ceilings don't compose into a single wall-clock guard"
              finding — this drill IS that finding coming true)
              + .aipe/study-performance-engineering/audit.md §8 R1
              (the 300s route budget headroom warning)
              + .aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md
              (the drill whose eval run surfaced this in the wild)

---

> **Coach posture, verdict first.** You have four layered ceilings — 300s route, 30s per tool call, 3 retries × 20s backoff, and a USD budget. None of them is a **wall-clock cap on agent reasoning between tool calls**. When you ran the 10-case eval for the coordination-failure drill on 2026-07-03, four cases — 04, 05, 06, 07 — each burned **15–19 minutes of wall clock and API cost** before vitest's `testTimeout=300_000ms` fired. No receipts. No graceful shutdown. Just budget-per-case blown by ~5×, silently, in a subsystem you thought had layered guards. That's the ceiling this drill closes. **The failure to induce is "a single case chews unbounded wall clock and cost while producing no output."** You've already induced it once by accident; the drill is to name it, force it deterministically on demand, cap it, and prove the cap holds.

---

## 1. BUILD — the ceilings that exist today, and the gap between them

```
  what the four shipped ceilings actually cap

  ┌────────────────────────────────────────────────────────────────────────────┐
  │  route ceiling (300s)                                                      │
  │    app/api/agent/route.ts:23 · app/api/briefing/route.ts:20                │
  │    · caps the ROUTE handler's total wall clock                             │
  │    · fires as a Vercel serverless timeout                                  │
  │    · in eval (vitest), the vitest.eval.config.ts testTimeout=300_000       │
  │      plays the same role                                                   │
  │    · GAP: doesn't fire if a single agent-loop iteration chews the whole    │
  │      budget — the ceiling is the container, not the work inside            │
  ├────────────────────────────────────────────────────────────────────────────┤
  │  tool-call timeout (30s per call)                                          │
  │    lib/mcp/transport.ts:38 (TOOL_TIMEOUT_MS)                               │
  │    · caps ONE HTTP call to the MCP server                                  │
  │    · composed via AbortSignal.timeout(30_000) in transport.ts:131          │
  │    · GAP: agent can loop and dispatch N tool calls; the outer loop has     │
  │      no counter                                                            │
  ├────────────────────────────────────────────────────────────────────────────┤
  │  retry ladder (3 retries × 20s ceiling)                                    │
  │    lib/data-source/bloomreach-data-source.ts:163-188                       │
  │    · caps a rate-limited retry sequence at ~60s worst case per call        │
  │    · GAP: this fires WITHIN one tool call; agents that never rate-limit    │
  │      never touch this budget                                               │
  ├────────────────────────────────────────────────────────────────────────────┤
  │  USD budget (BudgetTracker check-before-dispatch)                          │
  │    lib/agents/budget.ts + AnthropicModelProviderAdapter integration        │
  │    · caps cost across the investigation                                    │
  │    · fires BEFORE the next model turn (not after)                          │
  │    · GAP: if you don't set `budget` on the hooks (route sets ~$2, eval    │
  │      sets ~$2 via BUDGET_MAX_USD), the ceiling is effectively infinite    │
  │    · GAP: a runaway agent CAN accumulate cost silently up to that budget  │
  │      before the check fires (each turn is checked, but between checks     │
  │      the model can burn substantial tokens if the loop is spinning)       │
  └────────────────────────────────────────────────────────────────────────────┘
```

**Missing ceiling: agent iteration budget** — no cap on how many turns of `runAgentLoop` the DiagnosticAgent or RecommendationAgent will execute. AptKit's internal `RecommendationAgent`/`DiagnosticAgent` almost certainly have SOME max-iterations default, but it's not surfaced or configured at the Blooming layer, and 15–19 min of wall clock says either the default is very high or something is looping in a way the default doesn't catch (parallel tool calls? retries at a higher layer?).

**The specific gap**: the four ceilings compose into a container guard, not a work-inside guard. A single case can burn ~$0.30-0.40 of tokens over ~19 min while every individual ceiling reads OK, because none of them tracks the *aggregate reasoning wall clock inside a single agent call*.

---

## 2. INDUCE — the failure to force on demand

**The failure:** ONE case (repeatable across runs) where a single call to `DiagnosticAgent.investigate()` or `RecommendationAgent.propose()` runs for ≥ 5 minutes and ≥ 15 tool calls with no receipt, no user-visible progress after a certain point, and no ceiling firing. Deterministic reproduction means: same golden case, same setup, same anomaly → same runaway pattern in ≥ 2 of 3 runs.

The 2026-07-03 accidental induction on cases 04, 05, 06, 07 is the receipt to reproduce.

### Step-by-step to induce it deterministically

1. **Read the accidental receipt.** The eval log at `.aipe/drills/fingerprints/step5-eval.log` names the four cases (04, 05, 06, 07) and their wall clocks (929–1,123 sec). Pick the reproducible one — probably case 05 (`no-signal-retention-subscribers`) or case 06 (`no-signal-price-sensitivity-luxury`), both `no-signal` cases where the agent likely spirals on "I can't find anything wrong" reasoning.

2. **Instrument the outer loop.** Wrap `DiagnosticAgent.investigate()` and `RecommendationAgent.propose()` with wall-clock + iteration counters. Log every 30s that the call is still open. Log every 10 tool calls the count.

3. **Rerun a single case in isolation.**
   ```bash
   npx vitest run --config vitest.eval.config.ts eval/run.eval.ts -t "case 05"
   ```
   Watch the log. Confirm the case runs > 5 min without terminating.

4. **Confirm the mechanism.** Read the case's tool_call trace from the receipt-in-progress or from the AgentHooks capture. Is the agent:
   - Looping the same tool call with slightly-different args? (Progress-free spin)
   - Making tool calls that succeed but produce no forward reasoning? (Model-reasoning loop)
   - Retrying at some higher layer that isn't the transport's retry ladder?

If step 3 doesn't reproduce, the drill is faked — pick a different case or induce with a harder input (e.g., a case with intentionally ambiguous data).

---

## 3. DIAGNOSE — symptom → hypotheses → isolated cause

*(You write this. Coach names the frame.)*

**Symptom** (fill from the isolated run): case _______ ran for ______ seconds, made ______ tool calls, burned ______ tokens, produced ______ (nothing / a stub / a partial result). No layered ceiling fired.

**Hypotheses to test:**

- **H1 — AptKit's internal agent-loop max-iterations is set very high (or unset).** *Test:* grep `@aptkit/core` node_modules for `maxIterations` / `iterations` / `steps` defaults. If the default is 50+ or missing, that's your answer.
- **H2 — Model-reasoning spin.** The model keeps outputting `tool_use` blocks that are minor variations of prior calls, "trying" its way through no-signal data. *Test:* dedupe the tool_call trace by `(toolName, JSON.stringify(args))`; if the deduped count is much smaller than the raw count, spin is real.
- **H3 — Retry ladder amplification.** Each tool call is fast, but some layer between the agent and transport is retrying transparently. *Test:* count `console.log` lines from `bloomreach-data-source.ts` retry logs. If retries are firing frequently, that's the amplifier.
- **H4 — Prompt caching miss cascade.** Cache invalidation between turns forces a full re-encode every turn. *Test:* look at `cache_read_input_tokens` vs `cache_creation_input_tokens` across the turns. If cache_creation dominates, no caching is happening and cost scales linearly with turn count.

**Isolated cause** (fill after Steps 3): ______. State in one sentence.

---

## 4. FIX + REJECT — the alternative you didn't take and why

Option matrix — pick ONE:

| Option | Where it lives | Cost | What it fixes | What it doesn't |
|---|---|---|---|---|
| **A — Wall-clock cap in `AgentHooks`** — add `maxWallClockMs: number` to `AgentHooks`, check `performance.now() - startTime > maxWallClockMs` in every hook that fires, throw `WallClockExceededError`. | `lib/agents/diagnostic.ts:AgentHooks` type + `lib/agents/aptkit-adapters.ts:BloomingTraceSinkAdapter` (already has hook-firing surface) | MEDIUM (~2 hr): threading the deadline through both agents; test in isolation with a slow-fake anthropic. | Symmetric with `budget` — one ceiling per work-inside dimension (cost + wall clock). Fires deterministically. | Doesn't stop a *specific* pathology (spin, cache miss, ladder amplification). Just caps them all. |
| **B — Iteration cap in `AgentHooks`** — add `maxIterations: number`, count model turns. | Same. | LOW (~1 hr): counter is trivial. | Direct cap on the "runaway agent" case. | Doesn't help when one turn takes 3 min (model is slow, not looping). |
| **C — Both A + B, with A as the safety net.** | Same. | HIGH-MEDIUM (~3 hr): two counters, two tests each. | Layered ceilings — wall clock catches slow turns, iterations catches spin. | Adds complexity to `AgentHooks`; risk of overlap with AptKit's internal defaults. |
| **D — Reject: bump `testTimeout` in `vitest.eval.config.ts`** | vitest.eval.config.ts | TRIVIAL | Doesn't fix the underlying gap; just gives runaway cases more room to burn cost. | You'd have to defend the choice to make things WORSE at interview. |
| **E — Reject: use AptKit's built-in max-iterations if it exists** | (unknown surface) | UNKNOWN | Would be the cleanest if AptKit supports it | Not your surface — you're outsourcing the cap to a dependency; if AptKit's default changes silently, you're back where you started. |

**Recommended (coach's read):** ship **A** as the safety net (wall clock is the load-bearing metric — it maps to Vercel timeout, user experience, and API cost simultaneously). Add **B** only if the initial receipt shows spin as the dominant mechanism.

Whatever you pick, name what you rejected and *why in one sentence each*. That's the L3 signal.

---

## 5. EVAL — the measurement

**Instrument.** The same `eval/run.eval.ts` harness works. Add a `maxWallClockMs: 300_000` (or whatever the target) to the eval's `hooksFor(...)` call. Run 10 cases.

**Success criterion.**
- Every case terminates in ≤ target wall clock, OR terminates cleanly with a `WallClockExceededError` recorded in the receipt.
- No case burns > `target * 1.1` wall clock (the safety margin).
- Total eval cost stays close to the ~$1.30 / 10 cases baseline (this fix shouldn't add cost; a well-fired ceiling REDUCES cost on runaway cases).
- Every other rec-quality dim stays within GATE_MAX_REGRESSION vs baseline. The cap must not change output quality — only bound it.

**Before-number** (baseline receipt, `2026-07-03T04-08-28-644Z`): all 10 cases completed. Per-case avg wall clock ~4 min. No case hit `testTimeout`. So the baseline itself is "good."

**The candidate receipt to compare against** is the accidental-induction receipt from `2026-07-03T18-11-06-952Z`: 6 cases completed, 4 timed out at 15–19 min. If the fix is right, the "candidate" for THIS drill is a fresh run with the cap in place where all 10 cases complete cleanly (either succeeding fast, or terminating with a `WallClockExceededError` short of the budget).

---

## 6. WAR STORY — the sentence you say out loud

*(Write this last, once Steps 1–5 have actually been lived.)*

Shape to fill:

> "During an earlier drill's eval run, 4 of 10 cases each burned ~19 minutes of wall clock and API cost before vitest's testTimeout fired. Our four layered ceilings — route budget, tool timeout, retry ladder, USD budget — didn't cap it. I traced it to `_______` and shipped `_______` — a wall-clock cap threaded through `AgentHooks` with symmetry to the existing budget hook. Same test discipline: fires before dispatch, throws a typed error, recorded in the receipt. Reran the eval; every case terminated in `_______`. The lesson: when your layered ceilings all measure the container, no ceiling measures the work inside — you need at least one work-inside cap per resource you care about, and wall clock is a resource because tokens are billed for time."

Anti-patterns to avoid:
- "We noticed cases were slow" — passive voice + vague. Say *what didn't fire and what should have*.
- "Vitest's timeout caught it" — vitest's timeout is a container, not a cap. It caught it by giving up on the test, not by bounding the work.
- "AptKit didn't have a limit" — even if true, that's a dependency-blame framing. Own the surface: you shipped the outer wrapper, you own the cap.

The interviewer's follow-up will be one of:
- "Why didn't the USD budget catch it?" — because the model was making low-cost calls in a loop; each turn passed the budget check individually.
- "How did you set the cap number?" — measured p95 across the baseline runs, added ~30% headroom.
- "What did you reject?" — Option D (bump testTimeout) explicitly, because it makes the problem WORSE at higher fidelity.
- "How does this interact with Vercel's 300s route timeout?" — the wall-clock cap must be TIGHTER than 300s (say 240s) so it fires cleanly before the container SIGKILLs the process.

---

## Cross-links

- `.aipe/study-runtime-systems/07-backpressure-bounded-work-and-cancellation.md` — the theory this drill puts a rep against (specifically the finding "layered ceilings don't compose into a single wall-clock guard")
- `.aipe/study-performance-engineering/audit.md` §8 R1 — the 75s headroom warning that predicts this
- `.aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md` — the drill whose eval run accidentally induced this
- `.aipe/drills/fingerprints/step5-eval.log` — the log showing the 4 cases at 929–1,123 sec
- `lib/agents/budget.ts` — the pattern to mirror for the wall-clock cap (check-before-dispatch)
- `lib/agents/diagnostic.ts` `AgentHooks` interface — the surface to extend
- `vitest.eval.config.ts` — the testTimeout that fired as the last-resort container
