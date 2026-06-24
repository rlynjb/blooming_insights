# Units in column names — the `price_brl` failure

> **RETIRED 2026-06-18.** This file was authored against the Olist MCP
> server / Phase 3 eval pipeline, both removed from the codebase. The
> patterns it teaches are real, but the code anchors it cites no longer
> exist. Preserved as a historical record of what was studied.
>
> **What replaced this:** nothing. This was the 2026-06-16 audit's #1
> CRITICAL finding (a measured downstream cost in the recommendation
> judge's `impact_sized` score). It is **resolved-by-deletion**: the
> Olist schema is gone, the `_brl` columns are gone, the eval pipeline
> that measured the cost is gone. The current repo has no column whose
> name lies about its storage unit. The pattern itself — "column names
> the LLM reads as authoritative; in-name unit + in-storage unit drift
> causes 100× scale errors in narration" — is still a real anti-pattern
> worth knowing about; that's why the file is preserved. The audit
> (file 07) treats this as resolved-by-deletion and reranked accordingly.

**Industry name(s):** Unit-in-name anti-pattern · column-name lies · the cents-vs-Reais bug · LLM-readable schema · data-modeling-meets-AI-eval
**Type:** Industry standard · Language-agnostic · Project-specific (the Phase 3 eval-grounded finding)

> A textbook data-modeling anti-pattern with a **measured downstream cost** in the Phase 3 evals. The Olist schema declares `order_items.price_brl INTEGER NOT NULL`, `payments.value_brl INTEGER NOT NULL`, and similar `_brl`-suffixed columns. The integer is **cents** — values run from R$15 to R$2,500 stored as 1500..250000. The agent's training data and the column name both read `_brl` as "Brazilian Reais the currency," not "BRL stored in cents." The agent's prompt disclaimers ("All BRL monetary values are returned as integer cents — divide by 100 when narrating") work some of the time and fail other times. The cost is real: in the 2026-06-15 detection eval baseline, the agent narrated AOVs of R$131,965 (should be R$1,319.65), and the recommendation judge's `impact_sized` criterion collapsed to 0 across multiple anomalies. This file walks the bug, the eval evidence, and the three fix paths.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The bug lives at the **schema ↔ LLM interpretation seam**. The schema says one thing in its column name (`price_brl`); it stores another thing in the data (cents). The agent reads the column name + the column value and forms a mental model from both. When the prompt disclaimer reaches the agent, the model is correct; when the disclaimer drops out of context (long tool-call chains, prose synthesis, the recommendation phase that's two agents downstream from the prompt), the model reverts to the column-name reading and narrates cents as Reais.

```
  Zoom out — the bug's home, two layers down from the agent

  ┌─ AGENT REASONING (LLM) ─────────────────────────────────┐
  │  reads tool output: { current_value_brl: 131965000, ... }│
  │  prompt says: "divide by 100 when narrating"             │
  │  ★ sometimes follows; sometimes drops it                 │
  │  emits: "AOV is R$1,319,650"                              │
  │         or                                                │
  │         "AOV is R$131,965"  ← the bug                    │
  └────────────────────────────┬────────────────────────────┘
                               │ JSON in tool result
  ┌─ TOOL OUTPUT (mcp-server-olist) ─────────────────────────┐
  │  get_metric_timeseries returns SUM(price_brl) directly   │
  │  the integer IS cents; the field name suggests Reais     │
  └────────────────────────────┬────────────────────────────┘
                               │ SQL column
  ┌─ SCHEMA (mcp-server-olist/scripts/seed-olist.ts) ────────┐
  │  CREATE TABLE order_items (                               │
  │    price_brl INTEGER NOT NULL,  ← STORES CENTS            │
  │    freight_brl INTEGER NOT NULL,← STORES CENTS            │
  │    ...                                                     │
  │  );                                                        │
  │  CREATE TABLE payments (                                   │
  │    value_brl INTEGER NOT NULL,  ← STORES CENTS            │
  │    ...                                                     │
  │  );                                                        │
  │                                                            │
  │  ★ "the column name lies about the unit"                  │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this concept answers: when a column name implies a unit, what does the data have to do? Answer: store that unit. If you store a different unit, you've created a contract gap that downstream consumers (humans, LLMs, other code) will resolve in the wrong direction sometimes. The bug isn't in the agent ("the model should follow the disclaimer"); the bug is in the schema ("the column name has to match the storage").

---

## Structure pass

**Layers.** Same persistence stack. The bug originates in the **schema layer**, surfaces in the **tool-output layer**, manifests in the **agent reasoning layer**, and gets measured in the **eval-result layer**. Four layers, all involved.

**Axis: contract-honesty.** For each layer, does the artifact's name match what the artifact actually is? Pick this axis because the bug is *literally* a naming-vs-storage mismatch. Cost is wrong (storage is the same either way); failure is wrong (the SQL is correct, the data is internally consistent). Contract-honesty is the discriminator: which layer's naming is dishonest about what it carries?

**Seams.** Three matter. **S1: schema ↔ tool.** The tool reads `price_brl` and passes the integer through (no conversion). The dishonesty propagates unchanged. **S2: tool ↔ agent.** The JSON field is `current_value_brl` (in some prompts) or `current_value_brl_cents` (in others — inconsistent). The LLM reads both. **S3: agent ↔ eval judge.** The judge reads the agent's narrated numbers and scores `impact_sized` accordingly. The dishonesty's cost surfaces here.

```
  Structure pass — contract honesty across seams

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  Schema · Tool output · Agent reasoning · Eval judge      │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  contract honesty: does each layer's NAMING match what    │
  │  the artifact actually is?                                │
  └─────────────────────────────┬────────────────────────────┘
                                │  trace across seams
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  S1: schema ↔ tool       ★ DISHONEST (column lies)       │
  │  S2: tool ↔ agent        ★ INCONSISTENT (some fields say │
  │                            _brl_cents, some say _brl)     │
  │  S3: agent ↔ eval judge  ★ COSTLY (impact_sized = 0)     │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — How it works
```

---

## How it works

### Move 1 — the anti-pattern's shape

You know how a JavaScript timestamp can be Unix seconds or Unix milliseconds, and people pass them around as `const time = ...` and end up with off-by-1000-or-1000000-errors? Same shape here. The unit isn't on the value; the unit isn't on the type; the unit is in the name (`_brl`) — and the name says "Reais" while the storage uses cents. Every consumer has to know "BUT actually it's cents." Inevitably, some consumer doesn't.

```
  the unit-in-name anti-pattern — three variants

  variant 1: name says one thing, stores another      ★ this codebase
    column: price_brl     storage: integer cents
            ↑ "BRL" implies Reais                "but actually cents"
                                                  is a disclaimer, not a contract

  variant 2: name doesn't say anything
    column: price         storage: integer cents
                          consumer has to look it up — at least no false promise

  variant 3: name says the unit honestly
    column: price_brl_cents   OR   price_centavos
                                    OR
    column: price (DECIMAL(10,2)) + currency (TEXT)
                          consumer reads the name; consumer knows the unit

  why variant 1 is the worst: it gives the wrong answer to a hurried reader.
  variant 2 forces the reader to look; variant 1 LIES that they don't need to.
  the LLM, which can't look up the schema beyond what's in its context,
  treats the name as authoritative — and the disclaimer in the prompt as
  optional context that sometimes drops out of long conversations.
```

### Move 2 — the bug's path from schema to eval

#### Step 1 — the schema declares cents-storage with a Reais-name

```
  mcp-server-olist/scripts/seed-olist.ts (in SCHEMA_SQL)

  CREATE TABLE order_items (
    order_id    TEXT NOT NULL REFERENCES orders(id),
    product_id  TEXT NOT NULL REFERENCES products(id),
    price_brl   INTEGER NOT NULL,                   ← lies about its unit
    freight_brl INTEGER NOT NULL                    ← lies about its unit
  );

  CREATE TABLE payments (
    ...
    value_brl   INTEGER NOT NULL                    ← lies about its unit
  );

  the seeder generates values in cents:
    const price_brl = randInt(minP, maxP);  // 1500..250000 for electronics
                                            // (R$15 .. R$2500 expressed as cents)
```

#### Step 2 — the tool output preserves the lie

```
  mcp-server-olist/src/tools/get_metric_timeseries.ts

  metricExpr = 'SUM(oi.price_brl)';        ← sums cents; calls it "brl"

  output: {
    metric: 'revenue',
    points: [
      { ts: '2026-04-07', value: 131965000 },   ← 131,965 cents = R$1,319.65
      ...
    ]
  }

  the value is correct (it's a sum of cents); the FIELD NAME 'value'
  doesn't carry the unit anywhere. the caller has to remember.
```

#### Step 3 — the prompt tries to disclaim

```
  lib/agents/prompts/monitoring.md (excerpt)

  - All BRL monetary values are returned as **integer cents**
    (e.g. `12450000` is R$ 124 500,00). Divide by 100 when narrating
    in `impact`.

  ★ this works WHEN the model has the disclaimer in its active context.
    after 6 tool calls + a long reasoning chain + a synthesis turn,
    the disclaimer is many tokens back and the model sometimes uses
    the column name's implied semantics instead.
```

#### Step 4 — the agent's narration drifts

```
  observed in eval/results/2026-06-15/ (the K=10 baseline run)

  agent output (excerpt from an Anomaly's `impact` field):
    "Voucher payment value has collapsed from a R$ 1,553/week baseline
     to R$ 320/week in the most recent 4 weeks ..."
                  ↑                       ↑
                  numbers are CENTS divided by 100 to give Reais (correct)

    but in other runs from the same K=10 batch:
    "AOV for São Paulo customers is R$131,965, an unusual high ..."
                                    ↑
                                    raw cents read as Reais (off by 100x)

  the SAME schema, the SAME tool output, the SAME prompt — and the agent
  is sometimes right and sometimes wrong. that's the dishonest-name bug:
  the consumer's success depends on the disclaimer surviving the context.
```

#### Step 5 — the eval judge measures the cost

The recommendation judge in `eval/judges/recommendation-judge.md` scores three criteria (0-5 total): `plausible (0-2)`, `specific (0-2)`, `impact_sized (0-1)`. The `impact_sized` criterion gives 1 point when "at least one recommendation names magnitude — a dollar/Reais figure, a percent-of-revenue, an addressable-customer count." When the agent narrates R$131,965 AOV with no awareness that it's actually R$1,319.65, the recommendation's `estimatedImpact.rangeUsd` is computed as `~$26K/order` (an impossible AOV) — the judge sees it as either implausible (downgrades `plausible`) or as quantitatively wrong (zeros `impact_sized`).

```
  the measured cost — eval/results/2026-06-15/diagnosis-summary.md

  (paraphrased; exact numbers in the committed file)

  baseline run (K=10):
    Loose precision: 5.0%
    Loose recall:    6.7%
    Strict:          0.0% / 0.0%

  the post-fix run (eval/results/2026-06-15-after-fix/summary.md):
    Loose precision: 37.0%   (+32.0 points)
    Loose recall:    33.3%   (+26.6 points)
    Strict:          unchanged at 0.0%

  the gap between LOOSE and STRICT is largely the units-in-name bug:
  the agent surfaces the right anomaly semantically (loose: yes) but
  the numbers it narrates are off by 100x (strict: no, because the
  matcher checks magnitude). the fix path closed the loose gap but
  didn't close the strict gap — the strict criterion is the one
  that's most sensitive to the cents-vs-Reais misreading.
```

### Move 2 — three fix paths

```
  three ways out, ranked by smallest diff

  OPTION C (smallest diff) — convert in the tool layer
  ───────────────────────────────────────────────────
  storage: keep INTEGER cents (cheap, exact, no migration)
  tool output: divide by 100 on the way out

    metricExpr = 'CAST(SUM(oi.price_brl) AS REAL) / 100.0';
       or
    map every point in TypeScript: { ts, value: row.value / 100 }

    + the wire shape becomes "_brl means Reais" — matches the column
      name's implied semantics
    - need to update the prompt disclaimer (or remove it; the divide
      moves to the tool)
    - loses some precision (R$1,319.65 is exact; 1319.65 in float64 isn't —
      use string formatting on output if exactness matters)

  OPTION A — rename the column
  ─────────────────────────────────────────────────
  storage: integer cents (unchanged)
  column: price_brl_cents (or price_centavos)
  every tool query updates: SUM(oi.price_brl_cents)
  every test fixture updates
  the schema's column name now matches its storage

    + cleanest semantically — no LLM disclaimer needed
    + the schema STOPS LYING
    - touches every SQL file in mcp-server-olist/src/tools/
    - touches the seeder; touches the tests
    - requires re-running npm run seed (and re-capturing demo-* and
      regression-golden if they reference the old column name)

  OPTION B — promote to a richer type
  ─────────────────────────────────────────────────
  storage: NUMERIC(10,2) (decimal) + currency TEXT 'BRL' on every row
  every consumer reads two columns: amount + currency
  conventionally exact for money (no float roundoff)

    + most correct long-term — unit lives with the value, on every row
    - largest diff
    - SQLite NUMERIC is dynamic typing; the discipline is by convention
    - requires the deepest rewrite (every aggregation, every test)

  CURRENT TODAY: a hybrid of option C and option A is partly in place —
  some tool fields say _brl_cents in their JSON output (suggestive of
  option A), while the actual SQL columns are still _brl (option C
  not yet applied). the inconsistency is itself a smell.
```

### Move 3 — the principle

A column name is part of the schema. It's read by humans, by LLMs, by future contributors browsing tables — and what it implies has to match what the column stores. **"Store in canonical units; name with the unit"** is the discipline that prevents this entire class of bug: a column named `price_brl_cents` cannot lie about its unit; a column named `price` with no unit forces the consumer to look it up (still better than lying). The Olist schema's `_brl` columns are the canonical example of the anti-pattern — and the Phase 3 evals make the cost measurable in dollars (well, judge points). The lesson generalises: any time a unit is encoded in a name, the storage has to match, OR the wire format has to convert, OR you're shipping a bug that some consumer will hit.

---

## Primary diagram

The bug's full path, with the eval evidence.

```
  the cents-vs-Reais bug — schema → tool → agent → judge

  ┌─ 1. SCHEMA (the lie originates here) ───────────────────┐
  │   price_brl INTEGER NOT NULL  ← column name says BRL,    │
  │   storage:  131_965 cents       data is cents             │
  └────────────────────────────┬────────────────────────────┘
                               ▼
  ┌─ 2. TOOL OUTPUT (the lie propagates) ───────────────────┐
  │   { "value": 131965000, ...}  ← JSON field doesn't carry │
  │                                 the unit either           │
  └────────────────────────────┬────────────────────────────┘
                               ▼
  ┌─ 3. AGENT REASONING (the lie sometimes wins) ───────────┐
  │   prompt: "divide by 100 when narrating"                 │
  │   model:  sometimes follows, sometimes drops             │
  │   output: "AOV is R$131,965"  ← wrong, off by 100×       │
  └────────────────────────────┬────────────────────────────┘
                               ▼
  ┌─ 4. EVAL JUDGE (the lie costs points) ──────────────────┐
  │   recommendation-judge sees implausible AOV              │
  │   downgrades `plausible` and/or `impact_sized`           │
  │   pre-fix K=10 baseline: loose precision 5%, strict 0%   │
  │   post-fix K=10:        loose 37%,         strict 0%     │
  │   (the strict bar is the cents-vs-Reais sensitivity)     │
  └─────────────────────────────────────────────────────────┘

  THE FIX (option C, smallest diff):
    every tool divides by 100 before emitting JSON.
    the wire shape becomes "_brl means Reais" — honest at the
    boundary even if the storage stays in cents.
```

---

## Implementation in codebase

### The dishonest schema

```
mcp-server-olist/scripts/seed-olist.ts  (in SCHEMA_SQL, lines 205–217)

  CREATE TABLE order_items (
    order_id    TEXT NOT NULL REFERENCES orders(id),
    product_id  TEXT NOT NULL REFERENCES products(id),
    price_brl   INTEGER NOT NULL,        ← ★ lie: name says BRL, stores cents
    freight_brl INTEGER NOT NULL          ← ★ lie: name says BRL, stores cents
  );

  CREATE TABLE payments (
    order_id     TEXT NOT NULL REFERENCES orders(id),
    type         TEXT NOT NULL,
    installments INTEGER NOT NULL,
    value_brl    INTEGER NOT NULL         ← ★ lie: name says BRL, stores cents
  );
       │
       └─ three columns across two tables. all integer cents.
          all named _brl (which the model reads as "BRL the currency").
```

### The tool output that preserves the lie

```
mcp-server-olist/src/tools/get_metric_timeseries.ts (line 98)

  metricExpr = 'SUM(oi.price_brl)';
       │
       └─ sums cents. the SUM is correct integer arithmetic — but the
          field name in the output JSON ("value") loses even the _brl
          hint. the caller has nothing to remind it that this number
          is in cents.
```

### The prompt disclaimer that tries to recover

```
lib/agents/prompts/monitoring.md  (line ~22)

  - All BRL monetary values are returned as **integer cents**
    (e.g. `12450000` is R$ 124 500,00). Divide by 100 when narrating
    in `impact`.
       │
       └─ load-bearing disclaimer. when the model follows it,
          the impact text uses correct Reais. when the model drops it
          (long context, synthesis turn, downstream agent), the impact
          uses raw cents read as Reais. the fix would be: remove this
          line entirely + make the tool output Reais (option C) OR
          rename the column (option A).
```

### Where the cost is committed

```
eval/results/2026-06-15/diagnosis-summary.md
eval/results/2026-06-15-after-fix/summary.md

  the second file shows the partial fix's impact (+32 loose precision,
  +27 loose recall). the strict bar remains at 0% — the units-in-name
  bug is the dominant contributor to the gap between loose and strict.
```

---

## Elaborate

The deepest structural point about this bug is that **it's not the LLM's bug**. The LLM does what it always does — reads the schema, reads the prompt, weights them by context salience. The column name is in the SQL the agent sees on every tool call; the prompt disclaimer is in the system prompt at the top of the context. As the conversation grows, the column name stays consistently visible (every tool result has `price_brl: ...`) and the disclaimer recedes (it's 8000+ tokens back by the time the recommendation agent runs). The schema's name wins the priority fight, and the model narrates cents as Reais. **The schema is the load-bearing part of the prompt** — it's just that the schema lives in the data, not in the markdown.

This is a general lesson for AI-engineering data modeling: **column names are part of the prompt**. Any LLM that sees a tool's output sees the column names; any LLM that constructs SQL reads the column names; any LLM that narrates results uses the column names as semantic anchors. A name that lies about its unit, type, or role will sometimes win out over the prompt's correction. The discipline shifts: "design the schema as if the agent will read every column name literally" — because, sometimes, it will.

A subtle data-modeling point: **the bug isn't visible without the eval**. A code review would say "integer cents is the right storage for money; the schema is fine." A unit test would say "the SQL aggregates correctly; the schema is fine." It takes an end-to-end eval that scores the agent's narration — the K=10 detection eval with the recommendation judge — to see that the LIVE consumer (the LLM) misreads the column name in a way the unit test couldn't catch. This is a recurring pattern in AI-engineering: bugs hide at the LLM-schema seam, and only behavioral tests surface them. The Phase 3 work makes those bugs visible; the schema fix retires them.

The contrast with a non-AI consumer is instructive. A TypeScript caller would say `price_brl: number` and the type would carry the unit-in-name; a careful developer would check the schema and write `R$ (price_brl / 100).toFixed(2)`. The bug rate would be lower because there are fewer "long-context drift" failure modes — the developer either knows or doesn't. With an LLM, the failure is probabilistic across runs of the same prompt; you can't make it disappear by being more careful, you can only retire it by making the schema honest.

## Interview defense

**Q: Walk me through the worst data-modeling bug in this repo.**
A: The `price_brl` column in the Olist schema. It stores integer cents (e.g. 131,965 means R$1,319.65), but the column name reads as "BRL the currency." The agent's training data treats `_brl` columns as Reais, and the prompt disclaimer ("divide by 100 when narrating") works in some runs but drops out of context in others. The cost is committed in `eval/results/2026-06-15/`: the K=10 detection eval's strict precision/recall stayed at 0% even after a partial fix that brought loose precision to 37%. The strict bar is the cents-vs-Reais sensitivity — every recommendation that narrates R$131,965 as the AOV (instead of R$1,319.65) makes the judge's `impact_sized` criterion collapse. The fix is one of three options: divide in the tool output (smallest diff), rename the column to `price_brl_cents` (cleanest semantically), or promote to a decimal+currency pair (most correct long-term).

**Q: Why does this bug happen with an LLM but not with a TypeScript caller?**
A: Two reasons. First, TypeScript carries the unit-in-name as a type signal — `price_brl: number` triggers a careful reader to check the schema once; after that the unit is in the developer's head. The LLM doesn't have a persistent "I checked the schema once" memory across runs. Second, the LLM's context window has finite attention — the prompt disclaimer at the top of the conversation competes with the column name visible on every tool call. Over a 6-tool-call agent loop plus a synthesis turn, the column name wins. The TypeScript caller doesn't lose attention. So the same schema is fine for the TS caller and broken for the LLM. The fix is to make the SCHEMA's contract honest — then both consumers are safe.

```
  diagram while you talk

  SCHEMA          TOOL OUTPUT       AGENT          EVAL JUDGE
  ──────          ───────────       ─────          ──────────
  price_brl   →   "value":131965 →  "AOV is     →  impact_sized=0
  = cents          (cents, no       R$131,965"     (implausible
   ★ THE LIE        unit on field)   ★ 100× off     magnitude)
                                     sometimes

  fix: divide by 100 in the tool OR rename to price_brl_cents.
       either way the schema's contract becomes honest.
```

## See also

- `04-transactions-and-integrity.md` — the schema's NOT NULL and FK constraints are real; the unit dishonesty is a different kind of integrity gap (in the *contract*, not in the data).
- `07-data-modeling-red-flags-audit.md` — this finding is now #1 (CRITICAL).
- `08-the-olist-relational-schema.md` — the schema where the columns live; the table-by-table walk.
- `09-deterministic-synthetic-data.md` — the seeder generates the cents values; the eval that measures the cost.
- `lib/agents/prompts/monitoring.md` — the disclaimer that tries to recover from the schema's dishonesty.
- `eval/judges/recommendation-judge.md` — the `impact_sized` criterion that surfaces the cost.

---
Created: 2026-06-16 — new file covering the `price_brl` unit-in-name failure as a data-modeling-meets-AI-eval finding, with the committed eval evidence as the measured downstream cost.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
