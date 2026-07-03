# RFC book — blooming insights

Ten design decisions, each written the way it should have been written the first time. Not a tour of the codebase — a **defense** of the choices load-bearing enough that a skeptical reviewer will ask "why this way?"

The reviewer is a staff engineer who's seen more streaming stacks than you have. Your job is to lead with the decision, name the alternatives you actually considered, and own the tradeoffs without flinching. Every RFC in this book is about a decision already in the code — you're not proposing, you're documenting under scrutiny.

---

## Where these decisions sit

```
The whole system — where each RFC lives

  ┌─ UI layer (Next.js 16 App Router · React 19) ───────────────────┐
  │  feed page · investigate pages · StatusLog                       │
  │  fetch → readNdjson → onEvent (RFC-02) · framework (RFC-04)      │
  └───────────────────────────┬──────────────────────────────────────┘
                              │  HTTP · NDJSON stream
  ┌─ Route layer (app/api) ───▼──────────────────────────────────────┐
  │  /api/briefing · /api/agent — NDJSON producers                    │
  │  encoder ↔ readNdjson (RFC-02) · deterministic supervisor (RFC-03)│
  └───────────────────────────┬──────────────────────────────────────┘
                              │
  ┌─ Agent layer (lib/agents) ▼──────────────────────────────────────┐
  │  AptKit ReAct loop + Blooming adapters (RFC-06)                   │
  │  per-investigation budget ceiling (RFC-07)                        │
  │  prompt-cached system prompt (RFC-09)                             │
  │  regression gate over receipts (RFC-10)                           │
  └───────────────────────────┬──────────────────────────────────────┘
                              │
  ┌─ Data layer (lib/data-source) ▼──────────────────────────────────┐
  │  DataSource port (RFC-05)                                         │
  │   ├── McpDataSource (Bloomreach the default preset, not identity) │
  │   │    + AuthProvider strategy: oauth-bloomreach / bearer / anon  │
  │   ├── SyntheticDataSource (offline evals)                         │
  │   └── FaultInjectingDataSource (RFC-08, decorator)                │
  └───────────────────────────┬──────────────────────────────────────┘
                              │
  ┌─ Session state (in-process) ▼────────────────────────────────────┐
  │  lib/state/insights.ts · session-keyed maps · no DB (RFC-01)      │
  └──────────────────────────────────────────────────────────────────┘
```

Each RFC below points at one box (or one seam between two).

---

## The ten RFCs, ranked by reconsiderability

The order is deliberate: the first three are foundational and reasonably safe; the middle four are where a reviewer will push hardest; the last three are the recent hardening layer, so they're the freshest and the ones most likely to change again in the next quarter.

```
Reconsiderability — how likely you'd flip this call in the next quarter

  most stable                                                 most in-flux
  ─────────────────────────────────────────────────────────────►

  RFC-04  RFC-02  RFC-06  RFC-05  RFC-03  RFC-01  RFC-10  RFC-09  RFC-07  RFC-08
  (framework) (kernel)     (adapter)     (supervisor)      (gate) (cache) (budget) (faults)
```

| # | Decision | Load-bearing consequence |
|---|---|---|
| 01 | No database | encrypted-cookie session · in-memory session-keyed state · demo snapshot as reliability path |
| 02 | NDJSON over `fetch` stream, not SSE | one `readNdjson` kernel (64 LOC) at `lib/streaming/ndjson.ts` — 4 client surfaces consume it |
| 03 | Deterministic supervisor, not LLM router | pipeline + intent classifier as ROUTE code · no LLM chooses which agent runs |
| 04 | Next.js as runtime only, no data primitives | no Server Components, no `use(promise)`, no React Query — the stream **is** the state machine |
| 05 | DataSource seam + adapter pattern | port at `lib/data-source/types.ts` · **5 uses without a caller-surface change** (Olist add/remove · Synthetic · FaultInjecting · McpDataSource + AuthProvider strategy) |
| 06 | AptKit primitives + Blooming adapter boundary | `lib/agents/aptkit-adapters.ts` (263 LOC) · library owns the loop, Blooming owns the boundary |
| 07 | Per-investigation budget ceiling | `BudgetTracker` check-before-dispatch · shared across DiagnosticAgent + RecommendationAgent |
| 08 | Fault-injection DataSource decorator | 9 injected faults / 3 investigations / 0 failures — receipt for graceful degradation |
| 09 | Prompt caching on system prompt | validated live: `cache_creation_input_tokens 3168 → cache_read_input_tokens 3168` |
| 10 | Regression gate (baseline vs candidate) | `eval/gate.eval.ts` blocks any dimension regressed by >10pp — CI-ready |

The most reconsiderable one — the RFC a reviewer is most likely to push you to flip — is **RFC-08 (fault-injection decorator)**. See its Open Questions.

---

## The RFC shape

Every doc in this book follows the same spine — ADR-style, decision first, no suspense:

```
  1. Context / problem      what forced the decision
  2. Decision               the call, up front
  3. Alternatives           2–3 real options that lost, with why
  4. Consequences           what this costs + what it buys, owned
  5. Open questions         what's still undecided
```

Coach notes thread through each doc: where a reviewer will push, the framing that holds, the one sentence that gets the yes.

---

## How to use these

Read them when you're about to defend the decision to someone who has authority to override it — a staff review, an interview panel, a promo committee, or a new team member who wants to know why the code looks this way. Each RFC is self-contained; you can hand any one of them out on its own.

They are not a spec for future work. They are the written record of decisions the code already made.
