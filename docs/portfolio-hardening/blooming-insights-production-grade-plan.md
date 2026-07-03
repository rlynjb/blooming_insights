# blooming insights — production-grade hardening plan

> Target: **tier 2 (production-grade, no real users required)** — deployed,
> instrumented, cost-controlled, fault-tested, and eval-proven. NOT tier 3
> (live traffic / real users), scoped as an optional appendix.
>
> **Ship window: ~1 month, learning folded in.** Achievable because most of the
> eval + cost + fallback machinery already exists in aptkit — this plan is
> mostly *wiring reuse*, not new engine code.
>
> Grounded in `main` for both repos as of the current tree. Respects the
> frozen-core rule: the AptKit adapter bridge (3 classes in
> `lib/agents/aptkit-adapters.ts`), the 4 active agents (thin wrappers over
> `@aptkit/core` classes), the `AgentEvent` contract, the UI, and the demo
> replay path stay untouched except for eval-driven prompt fixes. The
> `*-legacy.ts` siblings (the hand-rolled `runAgentLoop` path) remain on
> disk as the rollback receipt — not the active runtime.

---

## 0. The load-bearing decision: engine up, data down

The single most important correction to the earlier draft: **the eval engine is
already built and already in blooming's dependency tree.** `@aptkit/evals` is
re-exported through `@rlynjb/aptkit-core`, which blooming already imports as
`@aptkit/core`. No new dependency, no rebuild, and **no aptkit code changes.**

> **⚠️ Prerequisite — bump the pin before Phase 1.** blooming is pinned to
> `@aptkit/core: ^0.3.0`, which resolves to the published **0.3.0** bundle.
> That bundle already contains `RubricJudge`, `scoreDetections`, the replay-runner,
> structural-diff, assertions, and the usage-ledger (`summarizeUsage` /
> `estimateCost`) — but **NOT** `scorePrecisionAtK` / `scoreRecallAtK` (added in
> 0.4.x). Before using recall@k, bump blooming's `package.json` to
> `@aptkit/core: npm:@rlynjb/aptkit-core@^0.4.1`, then
> `rm -rf node_modules package-lock.json && npm install && npm test`. This is a
> **blooming-side** version bump (0.3→0.4 is a backward-compatible minor per
> aptkit's semver); aptkit itself is untouched. Everything else in this plan
> runs on the current 0.3.0 pin as-is.

| Layer | Home | Status |
|---|---|---|
| Eval **engine** — `RubricJudge` (w/ calibration examples), `scorePrecisionAtK` / `scoreRecallAtK`, `scoreDetections`, `structural-diff`, replay-runner, assertions | **aptkit** `@aptkit/evals` | ✅ exists, bundled in core |
| Cost primitives — `summarizeUsage`, `estimateCost`, `pricingForModel`, `formatCost` | **aptkit** `@aptkit/runtime` (usage-ledger) | ✅ exists |
| Provider fallback — `FallbackModelProvider` | **aptkit** `@aptkit/provider-fallback` | ✅ exists |
| Golden **cases** — synthetic anomalies + known-correct diagnoses | **blooming** `eval/goldens/` | ⬜ write |
| **Rubric definitions** — diagnosis/recommendation criteria | **blooming** `eval/rubrics/` | ⬜ write |
| Calibration slice (hand-labeled, agreement measured) | **blooming** `eval/calibration/` | ⬜ write |
| `eval/run.ts` — runs agents over `live-synthetic`, scores via aptkit | **blooming** | ⬜ thin glue |

**Rule:** the reusable engine stays in aptkit; blooming holds only domain data +
glue. This is both the *less-work* path (reuse six primitives; copy an existing
template) and the *stronger-story* path (a reusable eval library consumed by a
domain harness = library/consumer separation, a senior signal).

**The trap:** never push blooming's goldens or domain rubrics up into aptkit —
it pollutes the reusable core with ecommerce data and undoes the
industry-agnostic direction. (aptkit already leaked once: `ECOMMERCE_ANOMALY_CATEGORIES`
sits in the monitoring agent package. Don't fix it now; just don't add to it.)

**Template to copy:** `aptkit/packages/agents/rag-query/scripts/eval.ts` already
imports `scorePrecisionAtK` / `scoreRecallAtK` from `@aptkit/evals` and runs a
labeled eval with a K value. That's the shape of blooming's `eval/run.ts`.

---

## 1. What is already tier-2 (do NOT redo)

The reliability layer largely exists in blooming. Name these in the interview; don't rebuild them.

| Concern | Where it lives | Status |
|---|---|---|
| Per-call timeout (30s) composed with client-cancel | `lib/mcp/transport.ts` `SdkTransport` + `composeSignals` | ✅ |
| Cancellation threaded to every async layer | `app/api/agent/route.ts` `req.signal.throwIfAborted()` → agents → `callTool` | ✅ |
| Rate-limit retry ladder (`retryCeilingMs`) | `lib/data-source/bloomreach-data-source.ts` | ✅ |
| Secret redaction + `cause`-chain walk before logging | `redactSecrets` / `formatError` | ✅ |
| Structured per-phase timing, shared shape across routes | `recordPhase` / the `finally` summary log | ✅ |
| Graceful degradation on error (NDJSON `error` event, not a 500) | route `catch` block | ✅ |
| Adapter seam — port + 2 adapters, survived 2 adapter swaps (Olist added, Olist removed, Synthetic added) with zero caller-surface change | `lib/data-source/` (`DataSource`, `BloomreachDataSource`, `SyntheticDataSource`) | ✅ |
| AptKit adapter boundary — 3 classes bridging `@aptkit/core@0.3.0` primitives (`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`) to Blooming's runtime; hand-rolled `runAgentLoop` preserved as `*-legacy.ts` rollback receipt | `lib/agents/aptkit-adapters.ts` (206 LOC) | ✅ |
| Test suite (unit + integration + allowlist) | `test/` (221 passing; delta from prior 269 reflects the eval/ retirement) | ✅ |

**Implication:** you can already defend *"production-grade reliability: timeouts,
cancellation, retries with backoff, graceful degradation, secret-safe logging."*
Everything below turns that from *architecture* into *evidence*.

---

## Phase 1 — Wire the eval harness (glue, not engine)

**Why first:** evals are the differentiator, and the `live-synthetic` adapter is
deterministic fake data over the *real* agent loop — so evals run with **no
Olist, no Bloomreach auth, no live spend beyond model calls.** The Phase 3 eval
pipeline that came off `main` took the Olist substrate with it, but you don't
need Olist back: the engine is in aptkit, the substrate is `live-synthetic`.

**Build (all in blooming `eval/`, kept OUT of `npm test` — cost + non-determinism):**
- `eval/goldens/` — **20–30 synthetic anomalies** captured from `live-synthetic`, each with a known-correct diagnosis + expected recommendation shape. (Domain data → stays in app.) N sized to match what the retired Phase 3 pipeline used against the Olist substrate.
- `eval/rubrics/` — a `RubricDefinition` for diagnosis quality and one for recommendation quality (import the type from `@aptkit/evals`).
- `eval/run.ts` — runs blooming's agents over `live-synthetic` at **K=10 replay per case**, feeds outputs to `RubricJudge`, scores detection recall with `scoreRecallAtK` / `scoreDetections`, emits a JSON receipt with per-criterion pass rates.
- `npm run eval` script.
- `eval/calibration/` — ~10 hand-labeled cases; measure judge-vs-human agreement. This is the line that survives interview scrutiny; `RubricJudge` already accepts `RubricCalibrationExample`s, so the API is ready for it. The retired Phase 3 pipeline established 8/8 + 3/3 manual agreement against Olist — the rebuild target is the same discipline against Synthetic.

**Deliverable / resume line:** *"Offline eval harness (rubric judge with a
calibration slice, K-replay, detection recall@k) scoring agent diagnoses and
recommendations; per-criterion pass rates gate prompt changes."*

**Cost:** ~1–1.5 days once the engine reuse is understood + ~$5–10 model spend.
**Touches:** new `eval/` only; zero frozen-core code.

---

## Phase 2 — Observability (reuse the usage-ledger)

**Why:** today it's `console.log` phase lines. The instrumentation points exist
(`recordPhase`, the shared summary), and aptkit's runtime already computes token
and cost from a `CapabilityEvent[]` trace — so this is aggregation, not new plumbing.

**Build:**
- Feed the run trace into `summarizeUsage` + `estimateCost` (aptkit) → per-call tokens, cost, model name, cache-hit.
- Aggregate to **p50 / p95 / p99** latency per phase and per investigation (a script over the existing JSON logs is enough; a hosted sink like Langfuse is optional polish).
- `npm run report` → prints latency percentiles + token/cost per investigation.

**Deliverable / resume line:** *"End-to-end tracing of every model + tool call
with token, cost, and p50/p95/p99 latency per phase."*

**Cost:** ~half a day. **Touches:** additive trace aggregation; no contract change.

---

## Phase 3 — Cost controls (reuse fallback + ledger)

**Why:** "how do you control spend" is a senior question with no current answer —
but two of the three levers already exist in aptkit.

**Build:**
- **Prompt caching** on the stable prefixes (system prompts + bootstrapped `WorkspaceSchema`) via Anthropic cache-control blocks. Biggest single lever — the schema rides every call.
- **Model routing** — make explicit what `classifyIntent` hints at: cheap model for intent/monitoring, escalate to `AGENT_MODEL` (`claude-sonnet-4-6`) only for diagnostic/recommendation.
- **Per-investigation budget ceiling** using the usage-ledger totals; on breach, emit a graceful `error` event (reuse the existing path).
- Optional: front the provider with aptkit's `FallbackModelProvider` for degraded-mode continuity. **Note:** this is the ONLY item in the plan that needs aptkit work — `FallbackModelProvider` is not re-exported through the core bundle, so pulling it in requires aptkit's 5-step "add a package to the bundle" process (`RELEASE.md`) + a publish + a version bump. Recommend skipping for the month; prompt caching + model routing above are pure blooming-side and capture most of the value.

**Deliverable / resume line:** *"Cost controls: prompt caching on schema/system
prefixes, cheap-model routing for classification, and a per-investigation token
ceiling with graceful cutoff."*

**Cost:** ~half to 1 day. **Touches:** agent construction + `intent.ts`; behavior-preserving.

---

## Phase 4 — Synthetic load + fault injection (the evidence move)

**Why:** real numbers and incident narratives **without a single real user.**
`live-synthetic` is the substrate.

**Build:**
- **Load harness** `eval/load.ts`: fire N investigations through `live-synthetic` with a *realistic* input distribution (varied metrics, scopes, severities, edge cases — not N happy-path copies, or p99 is meaningless). Capture the Phase-2 percentiles under sustained ~1 req/s.
- **Fault-injection decorator** wrapping `DataSource` (clean — the seam already exists): force per-call timeouts, malformed/❌-JSON tool results, rate-limits, and provider 500s at a configurable rate. Assert graceful degradation (the `error` event fires, the 30s timeout tags `HTTP 0:`, no hang burns the 300s budget).

**Deliverable / resume lines:**
- *"Load-tested with N synthetic investigations to characterize p50/p95/p99 and validate graceful degradation under fault injection."*
- *"Fault-injected provider timeouts, malformed JSON, and rate-limits; verified bounded failure within the request budget."*

**State the methodology out loud** — choosing synthetic load is the correct
pre-launch engineering decision, and saying so is itself the senior signal.
Never let synthetic numbers masquerade as organic traffic.

**Cost:** ~1 day. **Touches:** new `eval/load.ts` + a decorator over `DataSource`; core untouched.

---

## Phase 5 — Online eval / regression gate (close the loop)

**Why:** turns the harness from "ran once" into "catches regressions before they ship."

**Build:**
- A pre-deploy gate: run the Phase-1 eval on a candidate prompt/model change vs the current baseline; block on a per-criterion pass-rate drop beyond a threshold. aptkit's `evaluateReplayArtifactFiles` / replay-runner is the baseline-vs-candidate primitive to build on.
- Wire it into Phase-6 CI so a prompt PR shows the eval delta inline.

**Deliverable / resume line (strongest one you can write):** *"Online eval
catches quality regressions on prompt/model changes before deploy — flagged an
X% drop on criterion Y in a candidate change."*

**Cost:** ~half a day on top of Phase 1. **Touches:** CI + eval runner.

---

## Phase 6 — Ops hygiene (cheap, high credibility)

- **CI** (`.github/workflows/ci.yml`): typecheck + `npm test` + lint on every PR. Currently absent — a visible green check matters. (aptkit already has `.github/`; mirror it.)
- **Real README**: blooming's is still `create-next-app` boilerplate. Replace with architecture summary, the tier-2 claims, and one-command `eval` / `load` / `report` instructions.
- **One-command reproducibility**: `npm run eval`, `npm run load`, `npm run report` all runnable from a clean clone against `live-synthetic`.

**Cost:** ~half a day total.

---

## One-month sequencing (learning folded in)

The learning is not a tax on the timeline — reading aptkit's evals package *is*
how you defend it cold, and it's the same code you're wiring.

```
Week 1  Learn the seam, prove ONE case
        read: packages/evals/src/rubric-judge.ts,
              agents/rag-query/scripts/eval.ts (the template),
              .aipe/study-ai-engineering/05-evals-and-observability/
        ship: one golden case end-to-end — capture from live-synthetic,
              score with RubricJudge, print a receipt        ← proves the path

Week 2  Golden set + rubrics (Phase 1 complete)
        diagnosis rubric + recommendation rubric + detection recall@k
        over N cases; npm run eval → per-criterion pass rates
        hand-label ~10 → measure judge agreement (calibration number)

Week 3  Cost + load evidence (Phases 2, 3, 4)
        wire summarizeUsage/estimateCost over the trace (reuse)
        model routing + prompt caching + budget ceiling
        load.ts + fault-injection decorator → p50/p95/p99 + degradation

Week 4  Regression gate + ship (Phases 5, 6)
        baseline-vs-candidate gate (replay-runner pattern) + CI + README
        BUFFER for slippage; lock the interview narrative
```

**Definition of production-grade = you can answer, with evidence from a clean clone:**
1. What's your p99, and what drives it? → Phase 2 + 4
2. What happens when the model returns garbage / the provider times out? → Phase 4
3. How do you control spend? → Phase 3
4. How do you know a prompt change didn't make it worse? → Phase 1 + 5
5. Show me it runs. → Phase 6

---

## Optional appendix — tier 3 (full-live deploy, real users)

Not required for production-grade; the heaviest lift. Per `DEPLOY.md`: needs
**Vercel KV/Redis** to replace the in-memory/file OAuth + investigation store
(`lib/mcp/auth.ts`, `lib/state/*`) so state survives cold starts; **Vercel Pro**
for the ~115s live latency; and the Bloomreach OAuth redirect re-registered for
the deploy origin. Pursue only if a role specifically wants a live multi-tenant
deployment — otherwise tier-2 with synthetic evidence is the better ROI and the
cleaner honest claim.

---

## Hard rules (unchanged)

```
- Engine up, data down: eval primitives stay in @aptkit/evals; blooming holds
  only goldens, rubrics, calibration, and glue. Never push domain data to aptkit.
- Frozen core in blooming is eval-driven-prompt-fix-only: the AptKit adapter
  bridge (aptkit-adapters.ts), the 4 active agents (thin wrappers), the
  AgentEvent contract, UI, demo path. The *-legacy.ts siblings stay on disk
  as the rollback receipt but are NOT the active runtime.
- The npm test suite stays green (221 today). eval/ stays OUT of npm test
  (cost + non-determinism).
- One eval-surfaced fix per re-measure cycle — don't combine fixes or you lose
  attribution on which change moved which number.
- Synthetic data is labeled as synthetic everywhere it appears.
```
